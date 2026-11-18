import type * as Runtime from "./runtime/index.ts"
import type { Audience } from "./public.ts"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Caller } from "./functions.ts"
import { type Change, type DatasetName, envDataset, type Json } from "./model.ts"
import { positive } from "./runtime/settings.ts"

export type ReadSet = {
  readonly docs: ReadonlyArray<{ readonly collection: string; readonly id: string }>
  readonly collections: ReadonlyArray<string>
  readonly everything: boolean
  readonly clock: boolean
}

const touches = (reads: ReadSet, change: Change) =>
  reads.everything ||
  reads.collections.includes(change.doc.collection) ||
  reads.docs.some((d) => d.collection === change.doc.collection && d.id === change.doc.id)

const ClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["watch", "watch_aggregate"]),
    sub: Schema.String,
    name: Schema.String,
    input: Schema.Json,
  }),
  Schema.Struct({ type: Schema.Literal("unwatch"), sub: Schema.String }),
])

const decodeClientMessage = Schema.decodeUnknownOption(Schema.fromJsonString(ClientMessage))

export const Watching = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["query", "aggregate"])),
  sub: Schema.String,
  name: Schema.String,
  input: Schema.Json,
})

export type Watching = typeof Watching.Type

export type SocketInfo = {
  readonly dataset: DatasetName
  readonly env: string | undefined
  readonly audience: Audience
  readonly viewer: Caller | null
  readonly via: string
  readonly watching: ReadonlyArray<Watching>
  readonly address: string | undefined
}

export type LiveRan =
  | { readonly ok: true; readonly result: Json; readonly reads: ReadSet }
  | {
      readonly ok: false
      readonly error: string
      readonly code: string
      readonly retryAfter?: number | undefined
    }

/**
 * Whom a run of a public watched query is charged to: nobody ("free": only writes from outside the public host made it due), or the app's
 * public budget and, when a page asked for it, that page's address.
 */
export type Charge = "free" | { readonly address: string | undefined }

const APP: Charge = { address: undefined }

export type Spec = {
  readonly kind: "query" | "aggregate"
  readonly dataset: DatasetName
  readonly env: string | undefined
  readonly name: string
  readonly input: Json
  readonly audience: Audience
  readonly viewer: Caller | null
  readonly via: string
}

type Entry = {
  readonly key: string
  readonly spec: Spec
  reads: ReadSet | null
  last: string | null
  shown: string | null
  charge: Charge
  readonly subs: Map<Runtime.Socket, { socket: Runtime.Socket; ids: Set<string> }>
  readonly waiting: Set<{ readonly socket: Runtime.Socket; readonly sub: string }>
  dirty: boolean
  running: boolean
  ticking: boolean
  retrying: boolean
}

const LIVE_LIMITS = {
  perSocket: 20,
  inputBytes: 512,
  debounceMs: 25,
  clockMs: positive("OPENBELT_LIVE_CLOCK_SECONDS", 60) * 1000,
} as const

type Hooks = {
  readonly run: (spec: Spec, charge: Charge) => Effect.Effect<LiveRan>
  readonly sockets: () => Effect.Effect<
    ReadonlyArray<{ readonly socket: Runtime.Socket; readonly info: SocketInfo | undefined }>
  >
  readonly remember: (socket: Runtime.Socket, info: SocketInfo) => Effect.Effect<boolean>
}

const keyOf = (spec: Spec) =>
  JSON.stringify([
    spec.dataset,
    spec.kind,
    spec.name,
    spec.input,
    spec.audience,
    spec.viewer?.email ?? null,
    spec.viewer?.groups.toSorted() ?? [],
    spec.viewer?.testFor ?? null,
    spec.via,
  ])

export const openLive = (hooks: Hooks) => {
  const entries = new Map<string, Entry>()
  let rebuilt = false

  const send = (socket: Runtime.Socket, body: Readonly<Record<string, Json>>) =>
    socket
      .send(JSON.stringify({ type: "query", ...body }))
      .pipe(Effect.catchDefect(() => Effect.sync(() => drop(socket, undefined))))

  const current = (entry: Entry) => entries.get(entry.key) === entry

  const refresh: (entry: Entry) => Effect.Effect<void> = Effect.fnUntraced(function* (
    entry: Entry,
  ) {
    if (entry.running) {
      entry.dirty = true

      return
    }

    const charge = entry.charge

    entry.running = true
    entry.dirty = false
    entry.charge = "free"

    // Released however the run ends (a defect, an interruption too), or the query is stuck for
    // every watcher; a defect reaches them as a failed run.
    const ran = yield* hooks.run(entry.spec, charge).pipe(
      Effect.catchDefect(() =>
        Effect.succeed<LiveRan>({
          ok: false,
          error: `query ${entry.spec.name} failed inside the platform: watch it again, or see app_logs`,
          code: "function_failed",
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          entry.running = false
        }),
      ),
    )

    if (ran.ok) entry.reads = ran.reads

    const body = ran.ok ? { result: ran.result } : { error: ran.error, code: ran.code }
    const text = JSON.stringify(body)

    const waiting = [...entry.waiting]
    const fresh = text !== entry.shown

    entry.waiting.clear()
    entry.shown = text
    // Only a result is kept for the next watcher: after a refusal or a failure, whoever watches next runs it again.
    entry.last = ran.ok ? text : null

    if (fresh) {
      for (const { socket, ids } of entry.subs.values()) {
        for (const sub of ids) yield* send(socket, { sub, ...body })
      }
    } else {
      // The same as last time, but a watcher that joined since never had it.
      for (const { socket, sub } of waiting) {
        if (entry.subs.get(socket)?.ids.has(sub) === true) yield* send(socket, { sub, ...body })
      }
    }

    // A query that reads the clock changes with time alone: while watched, it runs every minute
    // (OPENBELT_LIVE_CLOCK_SECONDS).
    if (entry.reads?.clock === true && !entry.ticking) {
      entry.ticking = true
      yield* Effect.forkDetach(tick(entry))
    }

    // Refused for the budget: it runs again for its watchers once the budget allows, change or not, charged as this run was.
    if (!ran.ok && ran.retryAfter !== undefined && !entry.retrying) {
      entry.retrying = true
      yield* Effect.forkDetach(retry(entry, ran.retryAfter, charge))
    }

    // A change arrived while it ran: what it returned may already be stale.
    if (entry.dirty && current(entry)) yield* refresh(entry)
  })

  const tick = Effect.fnUntraced(function* (entry: Entry) {
    while (current(entry) && entry.reads?.clock === true) {
      yield* Effect.sleep(Duration.millis(LIVE_LIMITS.clockMs))

      if (current(entry)) {
        entry.charge = APP
        yield* refresh(entry)
      }
    }

    entry.ticking = false
  })

  const retry = Effect.fnUntraced(function* (entry: Entry, seconds: number, charge: Charge) {
    yield* Effect.sleep(Duration.seconds(seconds))

    entry.retrying = false

    if (!current(entry) || entry.last !== null || entry.running) return

    entry.charge = charge
    yield* refresh(entry)
  })

  const register = (spec: Spec, socket: Runtime.Socket, sub: string) => {
    const key = keyOf(spec)

    const entry: Entry = entries.get(key) ?? {
      key,
      spec,
      reads: null,
      last: null,
      shown: null,
      charge: "free",
      subs: new Map(),
      waiting: new Set(),
      dirty: false,
      running: false,
      ticking: false,
      retrying: false,
    }

    entries.set(key, entry)

    const watcher = entry.subs.get(socket) ?? { socket, ids: new Set<string>() }

    watcher.ids.add(sub)
    entry.subs.set(socket, watcher)

    return entry
  }

  /** After hibernation: what the sockets' attachments say they watch. */
  const rebuild = Effect.fnUntraced(function* () {
    if (rebuilt) return

    rebuilt = true

    for (const { socket, info } of yield* hooks.sockets()) {
      if (info === undefined) continue

      for (const w of info.watching) {
        register(
          {
            kind: w.kind ?? "query",
            dataset: info.dataset,
            env: info.env,
            name: w.name,
            input: w.input,
            audience: info.audience,
            viewer: info.viewer,
            via: info.via,
          },
          socket,
          w.sub,
        )
      }
    }
  })

  const drop = (socket: Runtime.Socket, sub: string | undefined) => {
    for (const entry of entries.values()) {
      const watcher = entry.subs.get(socket)

      if (watcher === undefined) continue

      if (sub === undefined) watcher.ids.clear()
      else watcher.ids.delete(sub)

      if (watcher.ids.size === 0) entry.subs.delete(socket)

      if (entry.subs.size === 0) entries.delete(entry.key)
    }
  }

  return {
    message: Effect.fnUntraced(function* (socket: Runtime.Socket, info: SocketInfo, text: string) {
      const message = decodeClientMessage(text)

      if (Option.isNone(message)) return

      yield* rebuild()

      const { sub } = message.value
      const rest = info.watching.filter((w) => w.sub !== sub)

      if (message.value.type === "unwatch") {
        drop(socket, sub)
        yield* hooks.remember(socket, { ...info, watching: rest })

        return
      }

      const { name, input } = message.value
      const kind = message.value.type === "watch_aggregate" ? "aggregate" : "query"
      const inputBytes = new TextEncoder().encode(JSON.stringify(input)).length

      const refusal =
        inputBytes > LIVE_LIMITS.inputBytes
          ? `a watched query's input is at most ${LIVE_LIMITS.inputBytes} bytes of JSON; this one is ${inputBytes}. Pass less (an id, a week), or await db.query(name, input) once instead of watching`
          : rest.length >= LIVE_LIMITS.perSocket
            ? `a page watches at most ${LIVE_LIMITS.perSocket} live queries at once; stop one (the function watch() returned) before watching another`
            : undefined

      const watching: Watching[] = [...rest, { sub, name, input, kind }]

      if (refusal !== undefined || !(yield* hooks.remember(socket, { ...info, watching }))) {
        yield* send(socket, {
          sub,
          error:
            refusal ??
            `this page watches too much to keep (its live queries' inputs, together): watch fewer, or with smaller inputs`,
          code: "invalid",
        })

        return
      }

      drop(socket, sub)

      const entry = register(
        {
          kind,
          dataset: info.dataset,
          env: info.env,
          name,
          input,
          audience: info.audience,
          viewer: info.viewer,
          via: info.via,
        },
        socket,
        sub,
      )

      if (entry.last !== null && !entry.dirty && !entry.running) {
        const known: Readonly<Record<string, Json>> = JSON.parse(entry.last)

        yield* send(socket, { sub, ...known })
      } else {
        entry.waiting.add({ socket, sub })

        if (!entry.running) {
          entry.charge = { address: info.address }
          yield* refresh(entry)
        }
      }
    }),

    aggregatesChanged: Effect.fnUntraced(function* (env: string | undefined) {
      yield* rebuild()

      for (const entry of entries.values()) {
        if (entry.spec.kind !== "aggregate" || entry.spec.env !== env) continue
        entry.dirty = true
        yield* refresh(entry)
      }
    }),

    closed: (socket: Runtime.Socket) => Effect.sync(() => drop(socket, undefined)),

    /** A write committed; `fromPublic`: it came from the public host (or a run that followed one), so the runs it makes due are charged. */
    changed: Effect.fnUntraced(function* (
      env: string | undefined,
      change: Change,
      fromPublic: boolean,
    ) {
      yield* rebuild()

      const dataset = env === undefined ? "live" : envDataset(env)
      const due: Array<Entry> = []

      for (const entry of entries.values()) {
        if (entry.spec.dataset !== dataset) continue

        if (entry.reads !== null && !touches(entry.reads, change)) continue

        if (fromPublic && entry.charge === "free") entry.charge = APP

        if (entry.dirty) continue

        entry.dirty = true
        due.push(entry)
      }

      if (due.length === 0) return

      yield* Effect.forkDetach(
        Effect.sleep(Duration.millis(LIVE_LIMITS.debounceMs)).pipe(
          Effect.andThen(
            Effect.forEach(due, (entry) => (current(entry) ? refresh(entry) : Effect.void)),
          ),
        ),
      )
    }),
  }
}
