// async (input, { db, caller, via, env, app }) => result, run in a sandbox (QuickJS in
// WASM, runtime/sandbox.ts) by the app's own AppDO, next to its data. openbelt.json "functions" lists them,
// The sandbox has no network of its own and no secrets: what it can do goes
// run (its caller, its grants) is in the sandbox's code or env, which the sandbox loader caches per id and
import * as Runtime from "./runtime/index.ts"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { OUTBOUND_LIMITS } from "./capabilities.ts"
import { type InputReads, InputReadsCodec, READS_WATCHED } from "./contracts.ts"
import { positive } from "./runtime/settings.ts"
import type { Conflict, Denied, ErrorCode, Json, Missing, Refused, Viewer } from "./model.ts"

export const functionPath = (name: string) => `functions/${name}.js`

export const FUNCTION_LIMITS = {
  ms: positive("OPENBELT_FUNCTION_SECONDS", 30) * 1000,
  calls: 200,
  requests: OUTBOUND_LIMITS.requests,
  inputBytes: 100_000,
  resultBytes: 256_000,
  logLines: 50,
  logChars: 1_000,
  tree: { runs: 100, calls: 2_000, requests: 200 },
} as const

const PAST_LIMIT = `it ran past ${FUNCTION_LIMITS.ms / 1000}s, the most a run may: OpenBelt stopped it, and refuses its db calls from then on`

export const HOLD_UNREADABLE = { holdMs: 60 * 60 * 1000, giveUpMs: 30 * 24 * 60 * 60 * 1000 }

export type Caller = Viewer & {
  readonly groups: ReadonlyArray<string>
  readonly testFor?: string
}

type RunContext = {
  readonly caller: Caller | null
  readonly via: string
  readonly env: string | null
  readonly app: string
  readonly run: {
    readonly id: string
    readonly attempt: number
    readonly key: string | null
  }
  readonly kind: "function" | "query"
  readonly schedule: {
    readonly scheduledFor: string
    readonly lastOkAt: string | null
    readonly manual: boolean
  } | null
}

export type Grants = {
  readonly secrets: Readonly<Record<string, { readonly problem?: string }>>
  readonly uses: ReadonlyArray<string>
  readonly app: string
  readonly nonce: string
}

const Op = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("list"),
    collection: Schema.String,
    limit: Schema.optionalKey(Schema.Number),
    cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ op: Schema.Literal("get"), collection: Schema.String, id: Schema.String }),
  Schema.Struct({ op: Schema.Literal("add"), collection: Schema.String, data: Schema.Json }),
  Schema.Struct({
    op: Schema.Literals(["set", "update"]),
    collection: Schema.String,
    id: Schema.String,
    data: Schema.Json,
    ifSeq: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    op: Schema.Literal("delete"),
    collection: Schema.String,
    id: Schema.String,
    ifSeq: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ op: Schema.Literal("collections") }),
  Schema.Struct({
    op: Schema.Literal("later"),
    fn: Schema.String,
    input: Schema.optionalKey(Schema.Json),
    at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    in: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    key: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("fetch"),
    url: Schema.String,
    method: Schema.String,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    body: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("tool"),
    connection: Schema.String,
    tool: Schema.String,
    input: Schema.Json,
    as: Schema.optionalKey(Schema.Literals(["workspace", "me"])),
  }),
  Schema.Struct({ op: Schema.Literal("hmac"), secret: Schema.String, text: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("notify"),
    to: Schema.Array(Schema.String),
    title: Schema.String,
    body: Schema.String,
    path: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("call"),
    fn: Schema.String,
    input: Schema.optionalKey(Schema.Json),
  }),
  Schema.Struct({ op: Schema.Literal("fileRead"), id: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("fileUrl"),
    id: Schema.String,
    expiresIn: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  }),
])

export type Op = typeof Op.Type

const decodeOp = Schema.decodeUnknownOption(Op)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

export type Answer = (op: Op) => Effect.Effect<Json, Refused | Denied | Missing | Conflict>

export type Thrown = {
  readonly ok: false
  readonly error: string
  readonly status: number
  readonly code: ErrorCode
  readonly seq?: number
}

export const thrown = (error: string, status = 400, code: ErrorCode = "invalid"): Thrown => ({
  ok: false,
  error,
  status,
  code,
})

const thrownOf = Match.type<Refused | Denied | Missing | Conflict>().pipe(
  Match.tagsExhaustive({
    Refused: (e): Thrown => thrown(e.message),
    Denied: (e): Thrown => thrown(e.message, 403, "denied"),
    Missing: (e): Thrown => thrown(e.message, 404, "missing"),
    Conflict: (e): Thrown => ({ ...thrown(e.message, 409, "conflict"), seq: e.seq }),
  }),
)

const HARNESS = `import { AsyncLocalStorage } from "node:async_hooks"

const load = async (name) => (await import("./fn/" + name + ".js")).default

const show = (v) => {
  if (typeof v === "string") return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

const runs = new AsyncLocalStorage()
const keep = (level) => (...a) => {
  const run = runs.getStore()
  if (run !== undefined && run.logs.length < ${FUNCTION_LIMITS.logLines}) run.logs.push({ level, text: a.map(show).join(" ").slice(0, ${FUNCTION_LIMITS.logChars}) })
}

const NO_BODY = new Set([101, 204, 205, 304])
// fetch and Date are the run's own: defined over the sandbox's.
const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
set("fetch", (input, init) => {
  const run = runs.getStore()
  if (run === undefined) return Promise.reject(new TypeError("fetch works only while a function runs, not at a module's top level"))
  return run.track((async () => {
    const request = new Request(input, init)
    const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer()).toBase64()
    const got = await run.call({ op: "fetch", url: request.url, method: request.method, headers: [...request.headers], body })
    return new Response(NO_BODY.has(got.status) || request.method === "HEAD" ? null : Uint8Array.fromBase64(got.body), { status: got.status, statusText: got.statusText, headers: got.headers })
  })())
})

const RealDate = Date
const sawClock = () => {
  const run = runs.getStore()
  if (run !== undefined) run.clock = true
}
function ClockDate(...a) {
  if (new.target === undefined) {
    sawClock()
    return RealDate()
  }
  if (a.length === 0) sawClock()
  return Reflect.construct(RealDate, a, new.target)
}
Object.setPrototypeOf(ClockDate, RealDate)
ClockDate.prototype = RealDate.prototype
ClockDate.now = () => {
  sawClock()
  return RealDate.now()
}
set("Date", ClockDate)

const declare = (grants, what, name) =>
  what === "secret"
    ? "ctx.secrets." + name + " isn't one of " + grants.app + "'s secrets: list it in openbelt.json 'secrets': {'" + name + "': 'what it's for'}, deploy, and set its value with set_secret"
    : "ctx.connections." + name + ": " + grants.app + "'s openbelt.json 'uses' doesn't list '" + name + "': add 'uses': {'" + name + "': 'why the app needs it'} and deploy (the connections tool lists the workspace's)"

const secretsOf = (grants, call) => new Proxy({}, {
  get(_, name) {
    if (name === "hmac") return (secret, text) => {
      if (!Object.hasOwn(grants.secrets, secret)) throw new Error(declare(grants, "secret", secret))
      return call({ op: "hmac", secret, text: typeof text === "string" ? text : JSON.stringify(text) })
    }
    if (typeof name !== "string" || name === "then" || name === "toJSON") return undefined
    if (!Object.hasOwn(grants.secrets, name)) throw new Error(declare(grants, "secret", name))
    const held = grants.secrets[name]
    if (held.problem !== undefined) throw new Error(held.problem)
    return "{{secret:" + name + ":" + grants.nonce + "}}"
  },
  has: (_, name) => Object.hasOwn(grants.secrets, name),
  ownKeys: () => Object.keys(grants.secrets),
  getOwnPropertyDescriptor: (_, name) => Object.hasOwn(grants.secrets, name) ? { enumerable: true, configurable: true } : undefined,
})

const answerOf = (got) => {
  if (got.structured !== null && got.structured !== undefined) return got.structured
  try { return JSON.parse(got.text) } catch { return got.text }
}

const connectionsOf = (grants, call) => new Proxy({}, {
  get(_, connection) {
    if (typeof connection !== "string" || connection === "then" || connection === "toJSON") return undefined
    if (!grants.uses.includes(connection)) throw new Error(declare(grants, "connection", connection))
    const callTool = async (tool, input, options = {}) => answerOf(await call({ op: "tool", connection, tool, input: input ?? {}, as: options.as }))
    return new Proxy({}, {
      get(_, tool) {
        if (tool === "call") return callTool
        if (typeof tool !== "string" || tool === "then" || tool === "toJSON") return undefined
        return (input, options) => callTool(tool, input, options)
      },
    })
  },
})
console.log = keep("info")
console.info = keep("info")
console.debug = keep("info")
console.warn = keep("warn")
console.error = keep("error")

// The input as the function sees it, recording what it reads (contracts.ts InputReads): each object's keys (ones it asked for that
// aren't there too, but not an object's own methods), whether it listed them, and what it read of an array's first items, all
// together. An object comes back as a proxy that records; an array as it is, its first items swapped for theirs, so walking it
// costs nothing. Past READS_WATCHED.objects objects, an object with more keys than READS_WATCHED.keys (a map, to an observed
// type) or a frozen one (a proxy's invariant: it must come back as it is) counts as all read.
const ITEMS = ${READS_WATCHED.items}
const NOT_FIELDS = new Set(["then", "toJSON"])
const reading = (input) => {
  const fresh = () => ({ keys: Object.create(null) })
  const root = fresh()
  const nodes = new WeakMap()
  const proxies = new WeakMap()
  const made = new WeakSet()
  const sampled = new WeakSet()
  let absent = 0
  let objects = 0
  const read = (t, key) => {
    const node = nodes.get(t)
    if (typeof key !== "string" || node.listed || Object.hasOwn(node.keys, key)) return
    if (!Object.hasOwn(t, key) && (key in t || NOT_FIELDS.has(key) || absent++ >= ${READS_WATCHED.absent})) return
    node.keys[key] = fresh()
  }
  const handler = {
    get(t, key, receiver) {
      const got = Reflect.get(t, key, receiver)
      if (got === null || typeof got !== "object") {
        read(t, key)
        return got
      }
      if (typeof key !== "string" || !Object.hasOwn(t, key)) return got
      const into = (nodes.get(t).keys[key] ??= fresh())
      const own = Reflect.getOwnPropertyDescriptor(t, key)
      if (!own.configurable && !own.writable && !Array.isArray(got)) {
        into.listed = true
        return got
      }
      return watch(got, into)
    },
    has(t, key) {
      read(t, key)
      return Reflect.has(t, key)
    },
    getOwnPropertyDescriptor(t, key) {
      read(t, key)
      return Reflect.getOwnPropertyDescriptor(t, key)
    },
    ownKeys(t) {
      nodes.get(t).listed = true
      return Reflect.ownKeys(t)
    },
    set: (t, key, v) => Reflect.set(t, key, v),
  }
  const watch = (value, node) => {
    if (value === null || typeof value !== "object" || made.has(value)) return value
    const known = proxies.get(value)
    if (known !== undefined) return known
    if (Array.isArray(value)) {
      if (sampled.has(value)) return value
      sampled.add(value)
      const items = (node.items ??= fresh())
      for (let i = 0; i < Math.min(value.length, ITEMS); i++)
        if (!Reflect.set(value, i, watch(value[i], items))) node.listed = true
      return value
    }
    if (objects >= ${READS_WATCHED.objects} || Object.keys(value).length > ${READS_WATCHED.keys}) {
      node.listed = true
      return value
    }
    objects += 1
    nodes.set(value, node)
    const proxy = new Proxy(value, handler)
    proxies.set(value, proxy)
    made.add(proxy)
    return proxy
  }
  return { input: watch(input, root), read: input !== null && typeof input === "object" ? root : undefined }
}

export default class Runner {
  async check(name) {
    const main = await load(name)
    if (main === undefined) return "it has no default export"
    return typeof main === "function" ? null : "its default export is a " + typeof main + ", not a function"
  }

  async run(name, host, input, context, grants, watch) {
    const main = await load(name)
    const started = new Set()
    const track = (promise) => {
      started.add(promise)
      const done = () => started.delete(promise)
      promise.then(done, done)
      return promise
    }
    const call = (op) => track((async () => {
      const reply = await host(JSON.parse(JSON.stringify(op)))
      if (!reply.ok) throw Object.assign(new Error(reply.error), { status: reply.status, code: reply.code }, reply.seq === undefined ? {} : { seq: reply.seq })
      return reply.value
    })())
    const run = { logs: [], call, clock: false, track, started }
    const watched = watch === true ? reading(input) : { input, read: undefined }
    return runs.run(run, () => this.#run(main, call, watched, context, grants, run))
  }

  async #run(main, call, watched, context, grants, run) {
    const logs = run.logs

    const collection = (name) => ({
      list: (options = {}) => call({ op: "list", collection: name, limit: options.limit, cursor: options.cursor }),
      get: (id) => call({ op: "get", collection: name, id }),
      add: (data) => call({ op: "add", collection: name, data }),
      set: (id, data, options = {}) => call({ op: "set", collection: name, id, data, ifSeq: options.ifSeq }),
      update: (id, patch, options = {}) => call({ op: "update", collection: name, id, data: patch, ifSeq: options.ifSeq }),
      delete: (id, options = {}) => call({ op: "delete", collection: name, id, ifSeq: options.ifSeq }),
    })

    const db = { collection, collections: () => call({ op: "collections" }) }

    const later = (fn, laterInput = null, options = {}) =>
      call({ op: "later", fn, input: laterInput, at: options.at instanceof Date ? options.at.toISOString() : options.at, in: options.in, key: options.key })

    const callFn = (fn, fnInput = null) => call({ op: "call", fn, input: fnInput })

    const notify = (to, notice = {}) =>
      call({ op: "notify", to: (Array.isArray(to) ? to : [to]).map(String), title: String(notice.title ?? ""), body: String(notice.body ?? ""), path: String(notice.path ?? "/") })

    const files = {
      read: async (id) => {
        const file = await call({ op: "fileRead", id: String(id?.id ?? id) })
        return { ...file, bytes: Uint8Array.fromBase64(file.bytes) }
      },
      url: (id, options = {}) => call({ op: "fileUrl", id: String(id?.id ?? id), expiresIn: options.expiresIn }),
    }

    const drain = async () => {
      while (run.started.size > 0) await Promise.allSettled([...run.started])
    }

    try {
      const result = await main(watched.input, { db, later, call: callFn, notify, files, secrets: secretsOf(grants, call), connections: connectionsOf(grants, call), ...context })
      await drain()
      return { ok: true, json: result === undefined ? "null" : JSON.stringify(result), logs, clock: run.clock, read: watched.read }
    } catch (error) {
      await drain()
      return { ok: false, error: error instanceof Error ? error.message : show(error), logs, clock: run.clock }
    }
  }
}
`

const fnv = (text: string) => {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)

  return (hash >>> 0).toString(36)
}

const HARNESS_ID = fnv(HARNESS)

const LogEntry = Schema.Struct({
  level: Schema.Literals(["info", "warn", "error"]),
  text: Schema.String,
})

type LogEntry = typeof LogEntry.Type

const Returned = Schema.Struct({
  ok: Schema.Boolean,
  json: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  logs: Schema.optionalKey(Schema.Array(LogEntry)),
  clock: Schema.optionalKey(Schema.Boolean),
  read: Schema.optionalKey(InputReadsCodec),
})

const decodeReturned = Schema.decodeUnknownOption(Returned)

const Checked = Schema.NullOr(Schema.String)

const decodeChecked = Schema.decodeUnknownOption(Checked)

type Reply = { readonly ok: true; readonly value: Json } | Thrown

type Runner = {
  readonly check: (name: string) => Effect.Effect<unknown, Error>
  readonly run: (
    name: string,
    host: (op: Json) => Promise<Reply>,
    input: Json,
    context: RunContext,
    grants: Grants,
    watch: boolean,
    /** Read by the sandbox's turns (runtime/turns.ts), not by the harness. */
    nested: typeof Runtime.NESTED_RUN | null,
  ) => Effect.Effect<unknown, Error>
}

export type Ran =
  | {
      readonly ok: true
      readonly result: Json
      readonly logs: ReadonlyArray<LogEntry>
      readonly calls: number
      readonly requests: number
      readonly ms: number
      readonly clock: boolean
      /** What it read of its input, when it was watched (an object or array, with no input schema). */
      readonly read: InputReads | undefined
    }
  | {
      readonly ok: false
      readonly error: string
      readonly kind: "threw" | "timeout" | "load" | "limit" | "busy"
      readonly logs: ReadonlyArray<LogEntry>
      readonly calls: number
      readonly requests: number
      readonly ms: number
      readonly clock: boolean
    }

const idOf = (bundle: Bundle) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(bundle.hashes.map(([name, hash]) => `${name}:${hash}`).join(",")),
    ),
  ).pipe(Effect.map((digest) => new Uint8Array(digest).toHex()))

const loadProblem = (text: string) => {
  const syntax = /SyntaxError: [^\n]*/.exec(text)?.[0]
  const at = /fn\/[\w-]+\.js:(\d+):(\d+)/.exec(text)
  const where = at === null ? "" : ` at line ${at[1]}, column ${at[2] ?? ""}`

  if (/does not provide an export named 'default'/.test(text)) return "it has no default export"

  if (syntax !== undefined)
    return `it doesn't parse: ${syntax}${where}. It runs as JavaScript (no TypeScript types)`

  return `the sandbox failed: ${text.replaceAll(/\s*\n\s*/g, " ").slice(0, 500)}`
}

type Bundle = {
  readonly hashes: ReadonlyArray<readonly [name: string, hash: string]>
  readonly code: Effect.Effect<ReadonlyArray<readonly [name: string, code: string]>>
}

const bundleOf = (
  functions: ReadonlyArray<{ readonly name: string; readonly hash: string; readonly code: string }>,
): Bundle => {
  const sorted = functions.toSorted((a, b) => (a.name < b.name ? -1 : 1))

  return {
    hashes: sorted.map((f) => [f.name, f.hash] as const),
    code: Effect.succeed(sorted.map((f) => [f.name, f.code] as const)),
  }
}

export const openFunctions = (
  loader: Runtime.SandboxLoader,
  owner: string,
  tenant: () => string,
) => {
  /**
   * The sandbox for a version's functions, kept warm while it's used: one per app and set of
   * function files, every function a module in it, so two apps with the same code never share
   * module state, a deploy that changes a function gets a new one, and however many of the app's
   * functions run at once they're runs in one sandbox (a VM, which is costly to start: one per file
   * was that many VMs).
   */
  const sandbox = (bundle: Bundle, env: string | null) =>
    Effect.flatMap(idOf(bundle), (id) =>
      loader.get(`${owner}:${JSON.stringify(env)}:${id}:${HARNESS_ID}`, () =>
        Effect.map(bundle.code, (code) => ({
          mainModule: "harness.js",
          modules: Object.fromEntries([
            ["harness.js", HARNESS],
            ...code.map(([name, text]) => [`fn/${name}.js`, text] as const),
          ]),
          // No network of its own: the harness's fetch goes through the host (capabilities.ts). A run that
          // outlasts its wall time, counted from its turn, is stopped: that is a run's limit.
          wallMs: FUNCTION_LIMITS.ms,
          // The workspace's own host process: its code never shares one with another workspace's (runtime/sandbox.ts).
          tenant: tenant(),
        })),
      ),
    )

  const check = (bundle: Bundle, name: string) =>
    Effect.flatMap(bundle.code, (files) => {
      const text = files.find(([file]) => file === name)?.[1]
      const unparsed = text === undefined ? undefined : Runtime.syntaxProblem(text, `fn/${name}.js`)

      // The sandbox's engine doesn't say where in a file it stopped; the host's parser does.
      return unparsed === undefined
        ? Effect.flatMap(sandbox(bundle, null), (worker) =>
            worker.getEntrypoint<Runner>().check(name),
          )
        : Effect.fail(new Error(unparsed))
    }).pipe(
      Effect.map((said) =>
        Option.getOrElse(
          Option.flatMap(decodeChecked(said), Option.fromNullishOr),
          () => undefined,
        ),
      ),
      Effect.catchCause((cause) => Effect.succeed(loadProblem(String(Cause.squash(cause))))),
      Effect.timeoutOption(Duration.seconds(10)),
      Effect.map((checked) =>
        Option.getOrElse(checked, () => "it took over 10s to load (a loop at its top level?)"),
      ),
    )

  const vet = Effect.fn("Functions.vet")(function* (
    functions: ReadonlyArray<{
      readonly name: string
      readonly hash: string
      readonly code: string
    }>,
  ) {
    const bundle = bundleOf(functions)

    const together = yield* Effect.forEach(functions, (f) =>
      Effect.map(check(bundle, f.name), (problem) => [f.name, problem] as const),
    )

    const first = together[0]?.[1]

    const whole =
      functions.length > 1 &&
      first !== undefined &&
      !first.startsWith("OpenBelt couldn't start it") &&
      together.every(([, problem]) => problem === first)

    const alone = whole
      ? yield* Effect.forEach(functions, (f) =>
          Effect.map(check(bundleOf([f]), f.name), (problem) => [f.name, problem] as const),
        )
      : []

    const found = alone.some(([, problem]) => problem !== undefined) ? alone : together

    return new Map(
      found.flatMap(([name, problem]) => (problem === undefined ? [] : [[name, problem] as const])),
    )
  })

  const run = Effect.fn("Functions.run")(function* (options: {
    readonly fn: string
    readonly bundle: Bundle
    readonly input: Json
    readonly context: RunContext
    readonly grants: Grants
    readonly answer: Answer
    /** Record which of the input's keys it reads: a function with no input schema learns its input from them (contracts.ts). */
    readonly watch: boolean
    /** A run another run ctx.call'd: it goes ahead of new runs for a turn (runtime/turns.ts). */
    readonly nested: boolean
  }) {
    const started = Date.now()
    let calls = 0
    let requests = 0
    let finished = false
    const promise = Effect.runPromiseWith(yield* Effect.context())

    const host = async (sent: Json): Promise<Reply> => {
      const op = decodeOp(sent)

      if (Option.isNone(op)) return thrown("the sandbox sent a call the host doesn't know")

      if (finished) {
        return thrown(
          `this run has ended (it ran past ${FUNCTION_LIMITS.ms / 1000}s, or its caller went away), so its db calls are refused`,
        )
      }

      if (
        op.value.op === "fetch" ||
        op.value.op === "tool" ||
        op.value.op === "call" ||
        op.value.op === "notify"
      ) {
        requests += 1

        if (requests > FUNCTION_LIMITS.requests) {
          return thrown(
            `this run made ${FUNCTION_LIMITS.requests} fetches, connection calls and ctx.calls, the most one may: do fewer`,
          )
        }
      } else if (op.value.op !== "hmac") calls += 1

      if (calls > FUNCTION_LIMITS.calls) {
        return thrown(
          `this run made ${FUNCTION_LIMITS.calls} db calls, the most one may: do fewer (list takes a limit up to 1000)`,
        )
      }

      return promise(
        options.answer(op.value).pipe(
          Effect.map((value): Reply => ({ ok: true, value })),
          Effect.catch((error) => Effect.succeed<Reply>(thrownOf(error))),
        ),
      )
    }

    const failed = (
      kind: "threw" | "timeout" | "load" | "limit" | "busy",
      error: string,
      logs: ReadonlyArray<LogEntry>,
    ): Ran => ({
      ok: false,
      error,
      kind,
      logs,
      calls,
      requests,
      ms: Date.now() - started,
      clock: false,
    })

    const worker = yield* sandbox(options.bundle, options.context.env)

    const outcome = yield* worker
      .getEntrypoint<Runner>()
      .run(
        options.fn,
        host,
        options.input,
        options.context,
        options.grants,
        options.watch,
        options.nested ? Runtime.NESTED_RUN : null,
      )
      .pipe(
        Effect.map((returned) => ({
          returned: decodeReturned(returned),
          kind: "load" as const,
          problem: "",
        })),
        Effect.catchCause((cause) => {
          const text = String(Cause.squash(cause)).replace(/^Error: /, "")

          return Effect.succeed(
            Runtime.refusedTurn(text)
              ? { returned: Option.none(), kind: "busy" as const, problem: text }
              : Runtime.ranPastWall(text)
                ? { returned: Option.none(), kind: "timeout" as const, problem: PAST_LIMIT }
                : { returned: Option.none(), kind: "load" as const, problem: loadProblem(text) },
          )
        }),
        // The sandbox stops a run at its limit, counted from its turn (runtime/turns.ts: the wait in line isn't the run's); this
        // is the backstop over the wait, the run and a margin, should the sandbox not answer.
        Effect.timeoutOption(Duration.millis(Runtime.LINE_MS + FUNCTION_LIMITS.ms + 10_000)),
        Effect.ensuring(
          Effect.sync(() => {
            finished = true
          }),
        ),
      )

    if (Option.isNone(outcome)) return failed("timeout", PAST_LIMIT, [])

    const { returned, kind, problem } = outcome.value

    if (Option.isNone(returned)) return failed(kind, problem, [])

    const logs = returned.value.logs ?? []

    if (!returned.value.ok)
      return {
        ...failed("threw", returned.value.error ?? "it threw", logs),
        clock: returned.value.clock ?? false,
      }

    const json = returned.value.json ?? "null"

    if (json.length > FUNCTION_LIMITS.resultBytes) {
      return failed(
        "limit",
        `its result is ${json.length} characters of JSON, over the limit of ${FUNCTION_LIMITS.resultBytes}: return less`,
        logs,
      )
    }

    const ran: Ran = {
      ok: true,
      result: Option.getOrElse(decodeJson(json), () => null),
      logs,
      calls,
      requests,
      ms: Date.now() - started,
      clock: returned.value.clock ?? false,
      read: returned.value.read,
    }

    return ran
  })

  return { vet, run }
}
