// What the platform says about itself, for whoever debugs it (an agent first). Every line on stdout is one JSON object: when, level,
// message, the trace and span it happened in, and its context (workspace, app, actor). The newest lines and every finished span are also kept
// in memory (bounded), so a running instance answers "what happened in trace X" (/_admin/logs, /_admin/trace; bun run drive logs|trace)
// without anyone reading its files. Effects run in three places (the gateway, each HTTP request, each actor event), each with
// Effect's default context: `observed` gives every one of them this logger and tracer, and a call into another object carries the
// caller's span (`currentWire`, `underParent`), so one request reads back as one tree across objects, the sandbox and SQL.
//
// With OTEL_EXPORTER_OTLP_ENDPOINT set, the same spans and lines also go to an OpenTelemetry backend (Grafana, Honeycomb, any OTLP
// collector), where they outlive the process: Effect's own OTLP exporters.
import { hostname } from "node:os"
import { format } from "node:util"
import * as Context from "effect/Context"
import { dbTotals, type DbTiming } from "./db-observe.ts"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { FetchHttpClient } from "effect/http"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { Otlp } from "effect/observability"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import { oneOf, positive, text as setting } from "./settings.ts"

/** The header a request forwarded to an object carries its caller's span in (`traceId:spanId`). */
export const SPAN_HEADER = "x-openbelt-span"

export const LogLevel = Schema.Literals(["trace", "debug", "info", "warn", "error", "fatal"])

type Level = typeof LogLevel.Type

/** A log line, as it is printed and kept. */
export type LogRecord = {
  readonly at: string
  readonly level: Level
  readonly msg: string
  readonly trace?: string
  readonly span?: string
  /** The span it happened in, by name (Effect.fn's). */
  readonly in?: string
  readonly cause?: string
  readonly [field: string]: unknown
}

/** A finished span, as /_admin/trace gives it. */
type SpanRecord = {
  readonly trace: string
  readonly span: string
  readonly parent: string | null
  readonly name: string
  /** Start, in ms since the epoch (Effect's clock is the wall clock, in ns). */
  readonly at: number
  readonly ms: number
  readonly ok: boolean
  readonly error?: string
  /** Still running: begun and not ended (ms is how long so far). */
  readonly open?: true
  /** What the span is about, kept only when OpenBelt named it (openbelt.*): Effect's own may carry a call's parameters, secrets too. */
  readonly about?: Readonly<Record<string, string>>
}

/** A bounded ring: the newest `size` things, oldest first on read. */
const ring = <A>(size: number) => {
  const items: Array<A> = []
  let next = 0

  return {
    add: (item: A) => {
      if (items.length < size) items.push(item)
      else {
        items[next] = item
        next = (next + 1) % size
      }
    },
    all: (): ReadonlyArray<A> => [...items.slice(next), ...items.slice(0, next)],
  }
}

const spans = ring<SpanRecord>(positive("OPENBELT_KEEP_SPANS", 50_000))

const logs = ring<LogRecord>(positive("OPENBELT_KEEP_LOGS", 20_000))

/**
 * OpenBelt's own trace ids (x-openbelt-trace: one per request, and one per MCP tool call inside it) to the span trace they ran in: a log
 * line carries both, so either finds the trace. An agent once had to guess that a request's id and its tool call's were one request.
 */
const traceOf = new Map<string, string>()

/**
 * An OpenBelt trace id minted inside an Effect (a tool's answer) finds the span trace it ran in, whether or not anything logged
 * under it.
 */
export const tracedHere = (openbelt: string) => {
  const span = Fiber.getCurrent()?.cache.span

  if (span !== undefined) linkTrace(openbelt, span.traceId)

  return openbelt
}

/** OpenBelt's trace id `openbelt` ran in span trace `trace`: either finds it. */
export const linkTrace = (openbelt: string, trace: string) => {
  if (traceOf.size >= 100_000) traceOf.delete(traceOf.keys().next().value ?? "")

  traceOf.set(openbelt, trace)
}

const resolved = (id: string) => traceOf.get(id) ?? id

/** The span trace an OpenBelt trace id ran in, if this process saw it start (only the process a request entered knows). */
export const resolveTrace = (id: string): string | undefined => traceOf.get(id)

const LEVELS: ReadonlyArray<Level> = ["trace", "debug", "info", "warn", "error", "fatal"]

const asLevel = (value: unknown, otherwise: Level): Level =>
  Schema.decodeUnknownOption(LogLevel)(
    typeof value === "string" ? value.toLowerCase() : value,
  ).pipe(Option.getOrElse(() => otherwise))

const minimum = oneOf("OPENBELT_LOG_LEVEL", LEVELS, "info")

const write = (record: LogRecord) => {
  if (LEVELS.indexOf(record.level) < LEVELS.indexOf(minimum)) return

  logs.add(record)
  // stderr: a script that imports the runtime (scripts/data.ts, verify's launch) keeps stdout for its own answer.
  process.stderr.write(`${JSON.stringify(record)}\n`)
}

/** Set by `startExport`: the OTLP tracer OpenBelt's spans are made by, and the OTLP loggers its lines also go to. */
let exporting:
  | {
      readonly tracer: Tracer.Tracer
      readonly loggers: ReadonlySet<Logger.Logger<unknown, unknown>>
    }
  | undefined

const SEVERITY = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
  fatal: "Fatal",
} as const satisfies Record<Level, string>

/** A line from code that isn't an Effect (the runtime's own: actors, sandboxes, the engine). `fields` become its keys. */
export const say = (level: Level, msg: string, fields: Readonly<Record<string, unknown>> = {}) => {
  write({ at: new Date().toISOString(), level, msg, ...fields })

  if (exporting === undefined || LEVELS.indexOf(level) < LEVELS.indexOf(minimum)) return

  // Effect lines reach the exporter through `loggers`; these, made outside any Effect, through a one-line Effect of their own.
  Effect.runSync(
    Effect.logWithLevel(SEVERITY[level])(msg).pipe(
      Effect.annotateLogs(fields),
      Effect.provideService(References.CurrentLoggers, exporting.loggers),
      Effect.provideService(References.MinimumLogLevel, "Trace"),
    ),
  )
}

const printed =
  (level: Level) =>
  (...parts: ReadonlyArray<unknown>) =>
    say(level, format(...parts), { from: "console" })

/**
 * What the libraries in this process print becomes JSON lines too, from: "console", so the log stays
 * one line per JSON object an agent can filter. server.ts calls it first.
 */
export const captureConsole = () => {
  console.log = printed("info")
  console.info = printed("info")
  console.debug = printed("debug")
  console.warn = printed("warn")
  console.error = printed("error")
}

const text = (part: unknown) => (typeof part === "string" ? part : JSON.stringify(part))

const logger = Logger.make<unknown, void>(({ cause, date, fiber, logLevel, message }) => {
  const span = fiber.cache.span
  const annotations = fiber.getRef(References.CurrentLogAnnotations)
  const parts = Array.isArray(message) ? message : [message]
  const openbelt = annotations["trace"]

  if (span !== undefined && typeof openbelt === "string" && openbelt !== span.traceId)
    linkTrace(openbelt, span.traceId)

  write({
    at: date.toISOString(),
    level: asLevel(logLevel, "info"),
    msg: parts.map(text).join(" "),
    ...annotations,
    ...(span === undefined
      ? {}
      : {
          trace: typeof openbelt === "string" ? openbelt : span.traceId,
          span: span.spanId,
          ...(Predicate.isTagged(span, "Span") ? { in: span.name } : {}),
        }),
    ...(cause.reasons.length > 0 ? { cause: Cause.pretty(cause) } : {}),
  })
})

const about = (attributes: ReadonlyMap<string, unknown>) => {
  const kept = [...attributes].flatMap(([key, value]) =>
    key.startsWith("openbelt.") && typeof value === "string"
      ? [[key.slice("openbelt.".length), value] as const]
      : [],
  )

  return kept.length === 0 ? {} : { about: Object.fromEntries(kept) }
}

/**
 * Spans begun and not yet ended, oldest first: what a stuck request is waiting in. A request that hung for minutes showed every span
 * but the one it was stuck in, since a span was kept only when it ended. Bounded like the rest: past 20,000, the oldest is forgotten.
 */
const open = new Set<Tracer.Span>()

const parentOf = (span: Tracer.Span) => Option.getOrUndefined(span.parent)?.spanId ?? null

const startOf = (span: Tracer.Span) => span.status.startTime

/** Drop what OpenBelt didn't name: Effect's NativeSpan and its OTLP span both keep their attributes in a Map. */
const keepOnlyOpenBelt = (span: Tracer.Span) => {
  const attributes = span.attributes

  if (!(attributes instanceof Map)) return

  for (const key of attributes.keys()) if (!key.startsWith("openbelt.")) attributes.delete(key)
}

/**
 * Each span is kept here when it ends; while exporting, it is the OTLP tracer's span, so it has the same ids here and in the
 * backend. Only what OpenBelt named (openbelt.*) leaves the process: Effect's own attributes may carry a call's parameters, secrets too.
 */
const tracer = Tracer.make({
  span: (options) => {
    const span = exporting?.tracer.span(options) ?? new Tracer.NativeSpan(options)
    const end = span.end.bind(span)

    span.end = (endTime, exit) => {
      const totals = dbTotals.get(span)

      if (totals !== undefined) {
        for (const [key, value] of Object.entries(totals))
          span.attribute(`openbelt.db.${key}`, String(value))
        dbTotals.delete(span)
      }

      open.delete(span)

      const failed = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)

      spans.add({
        trace: span.traceId,
        span: span.spanId,
        parent: parentOf(span),
        name: span.name,
        at: Math.round(Number(startOf(span)) / 1e6),
        ms: Math.round(Number(endTime - startOf(span)) / 1e5) / 10,
        ok: !failed,
        ...about(span.attributes),
        ...(failed ? { error: (Cause.pretty(exit.cause).split("\n")[0] ?? "").slice(0, 300) } : {}),
      })

      keepOnlyOpenBelt(span)
      end(endTime, exit)
    }

    if (open.size >= 20_000) open.delete(open.values().next().value ?? span)

    open.add(span)

    return span
  },
})

let dbOrdinal = 0

/** Only timings and routing metadata: never SQL text, bindings, results or SQLite's error message. */
export const recordDb = (
  parent: Tracer.Span,
  operation: string,
  worker: number,
  sent: number,
  received: number,
  timing: DbTiming,
  ok: boolean,
) => {
  if (Predicate.isTagged(parent.status, "Started")) {
    const previous = dbTotals.get(parent)
    dbTotals.set(parent, {
      count: (previous?.count ?? 0) + 1,
      errors: (previous?.errors ?? 0) + (ok ? 0 : 1),
      queueMs: (previous?.queueMs ?? 0) + timing.queueMs,
      executionMs: (previous?.executionMs ?? 0) + timing.executionMs,
      transportMs: (previous?.transportMs ?? 0) + timing.transportMs,
      sqlQueueMs: (previous?.sqlQueueMs ?? 0) + timing.sqlQueueMs,
    })
  }

  if (
    ok &&
    timing.queueMs < 10 &&
    timing.executionMs < 10 &&
    timing.sqlQueueMs < 10 &&
    ++dbOrdinal % 64 !== 0
  )
    return

  const span = tracer.span({
    name: `SQLite.${operation}`,
    parent: Option.some(parent),
    annotations: Context.empty(),
    links: [],
    startTime: BigInt(Math.round(sent * 1e6)),
    kind: "client",
    root: false,
    sampled: parent.sampled,
  })

  for (const [key, value] of Object.entries({ ...timing, worker, operation }))
    span.attribute(`openbelt.db.${key}`, String(value))
  span.end(BigInt(Math.round(received * 1e6)), ok ? Exit.void : Exit.die("SQLite operation failed"))
}

/**
 * The Server-Timing a response carries its request's span in, as a traceparent: the page that fetched it reads it back for each
 * file (PerformanceResourceTiming.serverTiming) and reports it with its load (timing.ts).
 */
export const serverTiming = (span: { readonly traceId: string; readonly spanId: string }) =>
  `traceparent;desc="00-${span.traceId}-${span.spanId}-01"`

/**
 * A span that already happened somewhere else (a browser's page load), from its own start and end in ms since the epoch: kept and
 * exported like any other. No parent starts a trace of its own. Only openbelt.* attributes leave the process.
 */
export const recordSpan = (options: {
  readonly name: string
  readonly parent?: Tracer.Span
  readonly start: number
  readonly end: number
  /** An undefined value is left out. */
  readonly attributes?: Readonly<Record<string, string | undefined>>
  readonly links?: ReadonlyArray<Tracer.SpanLink>
  readonly events?: ReadonlyArray<readonly [name: string, at: number]>
}) => {
  const span = tracer.span({
    name: options.name,
    parent: Option.fromUndefinedOr(options.parent),
    annotations: Context.empty(),
    links: [...(options.links ?? [])],
    startTime: BigInt(Math.round(options.start * 1e6)),
    kind: options.parent === undefined ? "client" : "internal",
    root: options.parent === undefined,
    sampled: true,
  })

  for (const [key, value] of Object.entries(options.attributes ?? {}))
    if (value !== undefined) span.attribute(key, value)

  for (const [name, at] of options.events ?? []) span.event(name, BigInt(Math.round(at * 1e6)))
  span.end(BigInt(Math.round(options.end * 1e6)), Exit.void)

  return span
}

/** A span still running, as /_admin/trace lists it: `ms` is how long it has run so far. */
const stillOpen = (span: Tracer.Span): SpanRecord => {
  const at = Math.round(Number(startOf(span)) / 1e6)

  return {
    trace: span.traceId,
    span: span.spanId,
    parent: parentOf(span),
    name: span.name,
    at,
    ms: Date.now() - at,
    ok: true,
    open: true,
    ...about(span.attributes),
  }
}

const loggers = new Set<Logger.Logger<unknown, unknown>>([logger])

/** OTEL_EXPORTER_OTLP_HEADERS: `name=value` pairs, comma separated, values URL-encoded (the OpenTelemetry convention). */
const headersOf = (given: string | undefined) =>
  Object.fromEntries(
    (given ?? "").split(",").flatMap((pair) => {
      const at = pair.indexOf("=")

      return at <= 0
        ? []
        : [[pair.slice(0, at).trim(), decodeURIComponent(pair.slice(at + 1).trim())] as const]
    }),
  )

/**
 * With OTEL_EXPORTER_OTLP_ENDPOINT set (the OpenTelemetry variables: OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_PROTOCOL
 * http/protobuf or http/json, OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES; OPENBELT_COMMIT is the service's version), spans and log
 * lines also go there, batched in the background. Without it,
 * nothing changes. server.ts calls it before serving.
 */
/** Send what the OTLP export still holds; nothing when there is no export. */
let flushExport: () => Promise<void> = async () => undefined

export const stopExport = async () => await flushExport()

export const startExport = async () => {
  const endpoint = setting("OTEL_EXPORTER_OTLP_ENDPOINT", "")

  if (endpoint === "") return

  const options = {
    baseUrl: endpoint,
    headers: headersOf(setting("OTEL_EXPORTER_OTLP_HEADERS", "")),
    // OTEL_RESOURCE_ATTRIBUTES (deployment.environment.name=prod, ...) Effect's exporters read themselves.
    resource: {
      serviceName: setting("OTEL_SERVICE_NAME", "openbelt"),
      serviceVersion: setting("OPENBELT_COMMIT", "") || undefined,
      // One per platform process, and the supervisor's (no OPENBELT_PROCESS): each sends its own counters, which would overwrite
      // each other's series in Prometheus under one name. Prometheus files it as the instance label.
      attributes: {
        "service.instance.id": `${hostname()}/${setting("OPENBELT_PROCESS", "supervisor")}`,
      },
    },
  }

  const layer =
    oneOf("OTEL_EXPORTER_OTLP_PROTOCOL", ["http/protobuf", "http/json"], "http/protobuf") ===
    "http/json"
      ? Otlp.layerJson(options)
      : Otlp.layerProtobuf(options)

  const runtime = ManagedRuntime.make(layer.pipe(Layer.provide(FetchHttpClient.layer)))

  // the exporter's loggers: what its layer adds to the default set
  const defaults = Effect.runSync(References.CurrentLoggers)

  const [traced, logging] = await runtime.runPromise(
    Effect.all([Effect.service(Tracer.Tracer), References.CurrentLoggers]),
  )

  exporting = {
    tracer: traced,
    loggers: new Set([...logging].filter((each) => !defaults.has(each))),
  }

  for (const each of exporting.loggers) loggers.add(each)

  // What is still batched goes out before the process does (shutdown.ts).
  flushExport = async () => await runtime.dispose()

  say("info", `telemetry: spans and log lines also go to ${endpoint}`)
}

/** `effect` with the platform's logger and tracer: what each place that runs an Effect wraps it in. */
export const observed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(References.CurrentLoggers, loggers),
    Effect.provideService(Tracer.Tracer, tracer),
  )

/** The current span as `traceId:spanId`, if there is one: what a call into another object carries. */
export const currentWire = Effect.map(Effect.option(Effect.currentSpan), (span) =>
  Option.match(span, { onNone: () => undefined, onSome: (s) => `${s.traceId}:${s.spanId}` }),
)

/** Run `effect` under the caller's span (`traceId:spanId`), when there is one. */
export const underParent = <A, E, R>(effect: Effect.Effect<A, E, R>, wire: string | undefined) => {
  const [traceId = "", spanId = ""] = (wire ?? "").split(":")

  return traceId === "" || spanId === ""
    ? effect
    : Effect.withParentSpan(effect, Tracer.externalSpan({ traceId, spanId }))
}

/** What /_admin/logs filters on: each field narrows; `since` is ms since the epoch. */
export type LogQuery = {
  readonly trace?: string | undefined
  readonly workspace?: string | undefined
  readonly app?: string | undefined
  readonly level?: Level | undefined
  readonly since?: number | undefined
  readonly text?: string | undefined
  readonly limit: number
}

/** The kept log lines that match, newest last. An OpenBelt trace id also matches the lines of the span trace it ran in. */
export const logsOf = (query: LogQuery): ReadonlyArray<LogRecord> => {
  const trace = query.trace === undefined ? undefined : resolved(query.trace)
  const floor = query.level === undefined ? 0 : LEVELS.indexOf(query.level)

  return logs
    .all()
    .filter(
      (line) =>
        (query.trace === undefined ||
          line.trace === query.trace ||
          (line.trace !== undefined && resolved(line.trace) === trace)) &&
        (query.workspace === undefined || line["workspace"] === query.workspace) &&
        (query.app === undefined || line["app"] === query.app) &&
        LEVELS.indexOf(line.level) >= floor &&
        (query.since === undefined || Date.parse(line.at) >= query.since) &&
        (query.text === undefined || JSON.stringify(line).includes(query.text)),
    )
    .slice(-query.limit)
}

/**
 * One trace as it ran in this process: its spans (oldest first) and its log lines, found by a span trace id or an OpenBelt trace id
 * logged in it. `spanTrace`: the span trace the process the request entered resolved `id` to; another process of the platform may
 * not know that mapping, and is asked by it (actor.ts machineTrace).
 */
export const traceView = (id: string, spanTrace?: string) => {
  const trace = spanTrace ?? resolved(id)

  const lines = logsOf({ trace: id, limit: 1000 })

  return {
    trace,
    spans: [
      ...spans.all().filter((span) => span.trace === trace),
      ...[...open].flatMap((span) => (span.traceId === trace ? [stillOpen(span)] : [])),
    ].toSorted((a, b) => a.at - b.at),
    logs:
      spanTrace === undefined || spanTrace === id
        ? lines
        : mergeLogs([lines, logsOf({ trace: spanTrace, limit: 1000 })], 1000),
  }
}

export type TraceView = ReturnType<typeof traceView>

/** Log lines from several processes as one list: in time order, each once, the newest `limit`. */
export const mergeLogs = (
  lists: ReadonlyArray<ReadonlyArray<LogRecord>>,
  limit: number,
): ReadonlyArray<LogRecord> => {
  const seen = new Set<string>()

  return lists
    .flat()
    .filter((line) => {
      const key = `${line.at}|${line.span ?? ""}|${line.msg}`

      if (seen.has(key)) return false

      seen.add(key)

      return true
    })
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-limit)
}

/** One trace's views from several processes as one: spans in start order, each once; lines merged. */
export const mergeTraces = (views: ReadonlyArray<TraceView>): TraceView => {
  const seen = new Set<string>()

  return {
    trace: views[0]?.trace ?? "",
    spans: views
      .flatMap((view) => view.spans)
      .filter((span) => {
        if (seen.has(span.span)) return false

        seen.add(span.span)

        return true
      })
      .toSorted((a, b) => a.at - b.at),
    logs: mergeLogs(
      views.map((view) => view.logs),
      1000,
    ),
  }
}
