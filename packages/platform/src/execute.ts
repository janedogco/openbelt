// The execute tool runs an agent's JavaScript in a sandbox (the kind functions run in, its own harness), with the workspace in reach as `workspace`: every app's functions, data and the
import type * as Runtime from "./runtime/index.ts"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { transform } from "sucrase"
import type { Thrown } from "./functions.ts"
import type { Json } from "./model.ts"
import { member } from "./contracts.ts"

const EXECUTE_LIMITS = {
  ms: 60_000,
  calls: 300,
  codeChars: 100_000,
  resultBytes: 24_000,
  logLines: 100,
  logChars: 1_000,
} as const

const WorkspaceOp = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("fn"),
    app: Schema.String,
    fn: Schema.String,
    input: Schema.Json,
  }),
  Schema.Struct({
    op: Schema.Literal("data"),
    app: Schema.String,
    call: Schema.Struct({
      op: Schema.Literals(["list", "get", "add", "set", "update", "delete", "collections"]),
      collection: Schema.optionalKey(Schema.String),
      id: Schema.optionalKey(Schema.String),
      data: Schema.optionalKey(Schema.Json),
      ifSeq: Schema.optionalKey(Schema.Number),
      limit: Schema.optionalKey(Schema.Number),
      cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    op: Schema.Literal("tool"),
    connection: Schema.String,
    tool: Schema.String,
    input: Schema.Json,
  }),
  Schema.Struct({ op: Schema.Literal("search"), query: Schema.String }),
  Schema.Struct({ op: Schema.Literal("describe"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("me") }),
  Schema.Struct({
    op: Schema.Literal("fetch"),
    url: Schema.String,
    method: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.NullOr(Schema.String),
  }),
])

export type WorkspaceOp = typeof WorkspaceOp.Type

const decodeOp = Schema.decodeUnknownOption(WorkspaceOp)

type Reply = { readonly ok: true; readonly value: Json } | Thrown

type WorkspaceAnswer = (op: WorkspaceOp) => Effect.Effect<Json, Thrown>

const fnv = (text: string) => {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)

  return (hash >>> 0).toString(36)
}

const FENCED = /```[^\n`]*\n([\s\S]*?)```/

const closing = (text: string, open: number) => {
  let depth = 0

  for (let i = open; i < text.length; i++) {
    const c = text[i]

    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++
      continue
    }

    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }

    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2)

      if (i === -1) return -1

      i++
      continue
    }

    if (c === "{") depth++

    if (c === "}" && --depth === 0) return i
  }

  return -1
}

const FUNCTION_START = /^(async\s+)?(function\b|\([^()]*\)\s*(:[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/

const isOneFunction = (text: string) => {
  if (!FUNCTION_START.test(text)) return false

  const open = text.indexOf("{")

  if (open === -1) return false

  const end = closing(text, open)

  return (
    end !== -1 &&
    text
      .slice(end + 1)
      .trim()
      .replace(/;$/, "") === ""
  )
}

const SyntaxAt = Schema.Struct({
  message: Schema.String,
  loc: Schema.Struct({ line: Schema.Number, column: Schema.Number }),
})

const decodeSyntaxAt = Schema.decodeUnknownOption(SyntaxAt)

type Prepared =
  | {
      readonly ok: true
      readonly module: string
      readonly offset: number
      readonly returns: boolean
    }
  | { readonly ok: false; readonly message: string; readonly line: number | null }

const prepare = (code: string): Prepared => {
  const source = (FENCED.exec(code)?.[1] ?? code).trim()

  if (source === "")
    return {
      ok: false,
      message: 'there\'s no code: send a body like return await workspace.search("")',
      line: null,
    }

  const iife = /^\(\s*async\b[\s\S]*\)\s*\(\s*\)\s*;?$/.test(source)

  const [wrapped, offset] = /^\s*export\s+default\b/m.test(source)
    ? [source, 0]
    : isOneFunction(source)
      ? [`export default (${source.replace(/;\s*$/, "")})`, 0]
      : [`export default async function () {\n${iife ? `return await ${source}` : source}\n}`, 1]

  try {
    const stripped = transform(wrapped, {
      transforms: ["typescript"],
      disableESTransforms: true,
      keepUnusedImports: true,
    }).code

    return {
      ok: true,
      module: stripped,
      offset,
      returns: /\breturn\b/.test(source) || offset === 0,
    }
  } catch (error) {
    const at = decodeSyntaxAt(error)

    if (Option.isNone(at))
      return { ok: false, message: `it doesn't parse: ${String(error)}`, line: null }

    const { line, column } = at.value.loc
    const shown = at.value.message.slice(0, -` (${line}:${column})`.length)
    const yours = Math.min(Math.max(line - offset, 1), source.split("\n").length)

    return { ok: false, message: `it doesn't parse: ${shown} at line ${yours}`, line: yours }
  }
}

const HARNESS = `import { AsyncLocalStorage } from "node:async_hooks"
import main from "./fn.js"

const show = (v) => {
  if (typeof v === "string") return v
  if (v instanceof Error) return v.stack ?? v.message
  try { return JSON.stringify(v) } catch { return String(v) }
}

const runs = new AsyncLocalStorage()
const keep = (level) => (...a) => {
  const logs = runs.getStore()?.logs
  if (logs !== undefined && logs.length < ${EXECUTE_LIMITS.logLines}) logs.push({ level, text: a.map(show).join(" ").slice(0, ${EXECUTE_LIMITS.logChars}) })
}
console.log = keep("info")
console.info = keep("info")
console.debug = keep("info")
console.warn = keep("warn")
console.error = keep("error")
Object.defineProperty(globalThis, "workspace", { configurable: true, get: () => runs.getStore()?.workspace })
Object.defineProperty(globalThis, "input", { configurable: true, get: () => runs.getStore()?.input })

const NO_BODY = new Set([101, 204, 205, 304])
// fetch and Date are the run's own: defined over the sandbox's.
const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
set("fetch", async (input, init) => {
  const store = runs.getStore()
  if (store === undefined) throw new Error("fetch works inside the run, not at the module's top level")
  const request = new Request(input, init)
  const headers = {}
  request.headers.forEach((value, key) => { headers[key] = value })
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text()
  const reply = await store.call({ op: "fetch", url: request.url, method: request.method, headers, body })
  return new Response(NO_BODY.has(reply.status) ? null : reply.body, { status: reply.status, statusText: reply.statusText, headers: reply.headers })
})

const SEARCH = 'await workspace.search("what you need") finds apps\\' functions and collections and the workspace\\'s connection tools; await workspace.describe("<path>") says how to call one'
const SKIP = new Set(["then", "toJSON", "constructor", "valueOf", "toString", "inspect", "asymmetricMatch", "nodeType", "$$typeof", "prototype"])

const named = (path, make) => new Proxy({}, {
  get(_, key) {
    if (typeof key !== "string" || SKIP.has(key)) return undefined
    return make(key)
  },
  ownKeys() { throw new Error(path + " can't be listed: " + SEARCH) },
  getOwnPropertyDescriptor() { throw new Error(path + " can't be listed: " + SEARCH) },
})

// A name as code reaches it: .notes, or ["hourly-joke"] for one that isn't an identifier (contracts.ts member).
const at = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? "." + name : "[" + JSON.stringify(name) + "]"

const makeWorkspace = (call) => {
  const appOf = (app) => {
    app = String(app)
    const data = (op) => call({ op: "data", app, call: op })
    const shown = "workspace.apps" + at(app)
    const known = {
      fn: named(shown + ".fn", (fn) => (input) => call({ op: "fn", app, fn, input: input === undefined ? null : input })),
      collection: (collection) => ({
        list: (options = {}) => data({ op: "list", collection, limit: options.limit, cursor: options.cursor }),
        get: (id) => data({ op: "get", collection, id: String(id) }),
        add: (doc) => data({ op: "add", collection, data: doc }),
        set: (id, doc, options = {}) => data({ op: "set", collection, id: String(id), data: doc, ifSeq: options.ifSeq }),
        update: (id, patch, options = {}) => data({ op: "update", collection, id: String(id), data: patch, ifSeq: options.ifSeq }),
        delete: (id, options = {}) => data({ op: "delete", collection, id: String(id), ifSeq: options.ifSeq }),
      }),
      collections: () => data({ op: "collections" }),
    }
    return new Proxy(known, {
      get(target, key) {
        if (typeof key !== "string" || SKIP.has(key)) return undefined
        if (key in target) return target[key]
        return () => Promise.reject(new Error(shown + at(key) + " isn't anything: a function is " + shown + ".fn" + at(key) + "(input), a collection is " + shown + '.collection("' + key + '").list(); ' + SEARCH))
      },
    })
  }
  const connectionOf = (connection) => named("workspace.connections" + at(String(connection)), (tool) => (input) =>
    call({ op: "tool", connection: String(connection), tool, input: input === undefined ? {} : input }))
  return {
    apps: named("workspace.apps", appOf),
    connections: named("workspace.connections", connectionOf),
    search: (query = "") => call({ op: "search", query: String(query) }),
    describe: (path = "") => call({ op: "describe", path: String(path) }),
    me: () => call({ op: "me" }),
  }
}

export default class Runner {
  run(host, input) {
    const logs = []
    const call = async (op) => {
      const reply = await host(JSON.parse(JSON.stringify(op)))
      if (!reply.ok) throw Object.assign(new Error(reply.error), { status: reply.status, code: reply.code }, reply.seq === undefined ? {} : { seq: reply.seq })
      return reply.value
    }
    const workspace = makeWorkspace(call)
    return runs.run({ logs, workspace, input, call }, async () => {
      try {
        const result = await main(input, { workspace })
        return { ok: true, json: result === undefined ? null : JSON.stringify(result), logs }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : show(error), stack: error instanceof Error ? String(error.stack ?? "") : "", logs }
      }
    })
  }
}
`

const HARNESS_ID = fnv(HARNESS)

const LogEntry = Schema.Struct({
  level: Schema.Literals(["info", "warn", "error"]),
  text: Schema.String,
})

const Returned = Schema.Struct({
  ok: Schema.Boolean,
  json: Schema.optionalKey(Schema.NullOr(Schema.String)),
  error: Schema.optionalKey(Schema.String),
  stack: Schema.optionalKey(Schema.String),
  logs: Schema.optionalKey(Schema.Array(LogEntry)),
})

const decodeReturned = Schema.decodeUnknownOption(Returned)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

type Runner = {
  readonly run: (host: (op: Json) => Promise<Reply>, input: Json) => Effect.Effect<unknown, Error>
}

type Failure = {
  readonly kind: "syntax" | "runtime" | "timeout" | "limit" | "sandbox"
  readonly message: string
  readonly line: number | null
}

const lineOf = (text: string, offset: number) => {
  const at = /fn\.js:(\d+):(\d+)/.exec(text)

  if (at === null) return null

  const line = Number(at[1]) - offset

  return line >= 1 ? line : null
}

const label = (op: WorkspaceOp) => {
  switch (op.op) {
    case "fn":
      return `workspace.apps${member(op.app)}.fn${member(op.fn)}`
    case "data":
      return `workspace.apps${member(op.app)}.collection(${op.call.collection ?? ""}).${op.call.op}`
    case "tool":
      return `workspace.connections${member(op.connection)}${member(op.tool)}`
    case "fetch":
      return `fetch ${op.method} ${op.url.split("?")[0] ?? ""}`
    default:
      return `workspace.${op.op}`
  }
}

const capped = (result: Json, max: number) => {
  const json = JSON.stringify(result)

  if (json.length <= max) return { result, cut: null }

  return {
    result: `${json.slice(0, max)}…`,
    cut: `the result was ${json.length} characters of JSON; only the first ${max} came back. Return less: pick the fields, slice the list, or count instead of listing.`,
  }
}

export const openExecute = (loader: Runtime.SandboxLoader) =>
  Effect.fn("Execute.run")(function* (options: {
    readonly code: string
    readonly input: Json
    readonly answer: WorkspaceAnswer
    readonly owner: { readonly workspace: string; readonly person: string }
  }) {
    const started = Date.now()
    const made: Array<{ call: string; ms: number; ok: boolean }> = []
    let calls = 0
    let finished = false

    const done = (
      result: Json,
      error: Failure | null,
      logs: ReadonlyArray<string>,
      note: string | null,
    ) => ({ ok: error === null, result, error, logs, calls: made, note, ms: Date.now() - started })

    if (options.code.length > EXECUTE_LIMITS.codeChars)
      return done(
        null,
        {
          kind: "limit",
          message: `the code is over ${EXECUTE_LIMITS.codeChars} characters`,
          line: null,
        },
        [],
        null,
      )

    const prepared = prepare(options.code)

    if (!prepared.ok)
      return done(
        null,
        { kind: "syntax", message: prepared.message, line: prepared.line },
        [],
        null,
      )

    const promise = Effect.runPromiseWith(yield* Effect.context())

    const host = async (sent: Json): Promise<Reply> => {
      const op = decodeOp(sent)

      if (Option.isNone(op))
        return {
          ok: false,
          error: "the sandbox sent a call the host doesn't know",
          status: 400,
          code: "invalid",
        }

      if (finished)
        return {
          ok: false,
          error: `this run has ended (it ran past ${EXECUTE_LIMITS.ms / 1000}s), so its calls are refused`,
          status: 400,
          code: "invalid",
        }

      calls += 1

      if (calls > EXECUTE_LIMITS.calls)
        return {
          ok: false,
          error: `this run made ${EXECUTE_LIMITS.calls} workspace calls, the most one may: do fewer`,
          status: 400,
          code: "invalid",
        }

      const at = Date.now()

      return promise(
        options.answer(op.value).pipe(
          Effect.map((value): Reply => ({ ok: true, value })),
          Effect.catch((failed) => Effect.succeed<Reply>(failed)),
          Effect.tap((reply) =>
            Effect.sync(() => {
              if (made.length < 100)
                made.push({ call: label(op.value), ms: Date.now() - at, ok: reply.ok })
            }),
          ),
        ),
      )
    }

    const { workspace, person } = options.owner

    const worker = yield* loader.get(
      `execute:${workspace}:${person}:${fnv(prepared.module)}:${HARNESS_ID}`,
      () => ({
        mainModule: "harness.js",
        modules: { "harness.js": HARNESS, "fn.js": prepared.module },
        wallMs: EXECUTE_LIMITS.ms + 5_000,
        tenant: workspace,
      }),
    )

    const outcome = yield* worker
      .getEntrypoint<Runner>()
      .run(host, options.input)
      .pipe(
        Effect.map((returned) => ({ returned: decodeReturned(returned), problem: "" })),
        Effect.catchCause((cause) =>
          Effect.succeed({ returned: Option.none(), problem: String(Cause.squash(cause)) }),
        ),
        Effect.timeoutOption(Duration.millis(EXECUTE_LIMITS.ms)),
        Effect.ensuring(
          Effect.sync(() => {
            finished = true
          }),
        ),
      )

    if (Option.isNone(outcome))
      return done(
        null,
        {
          kind: "timeout",
          message: `it ran past ${EXECUTE_LIMITS.ms / 1000}s, the most an execute may`,
          line: null,
        },
        [],
        null,
      )

    const { returned, problem } = outcome.value

    if (Option.isNone(returned)) {
      // wording: the sandbox's engine reports a module that doesn't load as text, with no field for a syntax error.
      const syntax = /SyntaxError: [^\n]*/.exec(problem)?.[0]

      return done(
        null,
        syntax === undefined
          ? { kind: "sandbox", message: `the sandbox failed: ${problem.slice(0, 500)}`, line: null }
          : {
              kind: "syntax",
              message: `it doesn't parse: ${syntax}`,
              line: lineOf(problem, prepared.offset),
            },
        [],
        null,
      )
    }

    const logs = (returned.value.logs ?? []).map((l) =>
      l.level === "info" ? l.text : `${l.level}: ${l.text}`,
    )

    if (!returned.value.ok)
      return done(
        null,
        {
          kind: "runtime",
          message: returned.value.error ?? "it threw",
          line: lineOf(returned.value.stack ?? "", prepared.offset),
        },
        logs,
        null,
      )

    const json = returned.value.json ?? null
    const value = json === null ? null : Option.getOrElse(decodeJson(json), () => null)
    const { result, cut } = capped(value, EXECUTE_LIMITS.resultBytes)

    return done(
      result,
      null,
      logs,
      cut ??
        (prepared.returns || value !== null
          ? null
          : "it returned nothing: a body's last value isn't returned, so end with return <what you want back>"),
    )
  })
