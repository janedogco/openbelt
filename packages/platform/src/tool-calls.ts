// Every call an agent makes to OpenBelt's own MCP tools, as the workspace's admins and operators see it: one row per call in the workspace's
// tool_calls (who, which client, which tool, with what, the outcome, how long, the trace), a log line, a metric and the span's
// openbelt.* attributes. McpDO's answer() reads each tools/call off the wire and its result off the response, so a tool needs
// nothing of its own to be counted; the arguments are kept shortened, with secrets' values taken out.
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Json } from "./model.ts"
import type { DurableObjectStorage, SqlValue } from "./runtime/index.ts"

/**
 * What became of a call: ok; failed (the tool ran the agent's code, or a function, and that threw: execute's or call_function's
 * ok: false); refused (the tool said no, and why: a Refused); invalid (its arguments didn't fit the tool's schema, or there's no
 * such tool); defect (OpenBelt failed inside).
 */
const ToolOutcome = Schema.Literals(["ok", "failed", "refused", "invalid", "defect"])

type ToolOutcome = typeof ToolOutcome.Type

const ToolCall = Schema.Struct({
  at: Schema.String,
  trace: Schema.String,
  person: Schema.String,
  client: Schema.String,
  session: Schema.String,
  tool: Schema.String,
  app: Schema.String,
  args: Schema.String,
  outcome: ToolOutcome,
  ms: Schema.Number,
  error: Schema.String,
})

type ToolCall = typeof ToolCall.Type

/** The newest this many calls a workspace keeps (each row is at most about 2.5 KB). */
export const KEEP_TOOL_CALLS = 5000

const ARGS_MAX = 2000

const STRING_MAX = 200

const ITEMS_MAX = 20

const DEPTH_MAX = 5

/** Keys whose values are never kept, wherever they are in the arguments (a connection tool's input too). */
const SECRET_KEY =
  /secret|token|passw|api[-_]?key|private[-_]?key|authorization|cookie|credential|^(?:x-)?auth$/i

/** Arguments that are secrets by the tool: set_secret's value. */
const SEALED = new Map<string, ReadonlyArray<string>>([["set_secret", ["value"]]])

type Node = { readonly [key: string]: Json }

const isNode = (v: Json | undefined): v is Node =>
  v !== undefined &&
  v !== null &&
  !Predicate.isString(v) &&
  !Predicate.isNumber(v) &&
  !Predicate.isBoolean(v) &&
  !Array.isArray(v)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** JSON's value, or undefined when the text isn't JSON. */
const parsedJson = (text: string): Json | undefined => Option.getOrUndefined(decodeJson(text))

const shorten = (value: Json, depth: number): Json => {
  if (Predicate.isString(value))
    return value.length <= STRING_MAX
      ? value
      : `${value.slice(0, STRING_MAX)}… (${value.length} chars)`

  if (Array.isArray(value)) {
    if (depth >= DEPTH_MAX) return "…"

    const kept = value.slice(0, ITEMS_MAX).map((item) => shorten(item, depth + 1))

    return value.length > ITEMS_MAX ? [...kept, `… (${value.length - ITEMS_MAX} more)`] : kept
  }

  if (!isNode(value)) return value

  if (depth >= DEPTH_MAX) return "…"

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      SECRET_KEY.test(key) && inner !== null ? "[redacted]" : shorten(inner, depth + 1),
    ]),
  )
}

/** A call's arguments as kept: long strings and lists cut, secrets' values out, at most 2,000 characters of JSON. */
export const keptArgs = (tool: string, args: Json) => {
  const sealed = SEALED.get(tool) ?? []

  // A call McpDO couldn't turn into its operation's own (wrong keys, args not an object) keeps no arguments: they may
  // hold the operation's secrets (set_secret's value) under keys SEALED doesn't reach.
  const open =
    tool === "call"
      ? { tool: isNode(args) ? (args["tool"] ?? null) : null, args: "[not kept]" }
      : isNode(args)
        ? Object.fromEntries(
            Object.entries(args).map(([key, value]) => [
              key,
              sealed.includes(key) && value !== null ? "[sealed]" : value,
            ]),
          )
        : args

  const text = JSON.stringify(shorten(open, 0))

  return text.length <= ARGS_MAX ? text : `${text.slice(0, ARGS_MAX)}… (cut)`
}

/** The app a call is about, when its arguments name one. */
export const appOfArgs = (args: Json) => {
  const app = isNode(args) ? args["app"] : undefined

  return Predicate.isString(app) ? app : ""
}

const Id = Schema.Union([Schema.String, Schema.Number])

const Call = Schema.Struct({
  id: Id,
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.optionalKey(Schema.Json),
  }),
})

export type CallOnWire = { readonly id: string; readonly tool: string; readonly args: Json }

const decodeCall = Schema.decodeUnknownOption(Call)

/** A message's JSON-RPC id, as text ("" when it has none). */
export const idOf = (message: Json) => {
  const id = isNode(message) ? message["id"] : undefined

  return Predicate.isString(id) || Predicate.isNumber(id) ? String(id) : ""
}

/** The tools/call requests in a JSON-RPC body (one message, or a batch). */
export const callsIn = (body: string): ReadonlyArray<CallOnWire> => {
  if (!body.includes('"tools/call"')) return []

  const message = parsedJson(body)

  if (message === undefined) return []

  const messages = Array.isArray(message) ? message : [message]

  return messages.flatMap((m) =>
    Option.match(decodeCall(m), {
      onNone: () => [],
      onSome: (call) => [
        { id: String(call.id), tool: call.params.name, args: call.params.arguments ?? {} },
      ],
    }),
  )
}

const Initialize = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      params: Schema.Struct({
        clientInfo: Schema.Struct({
          name: Schema.String,
          version: Schema.optionalKey(Schema.String),
        }),
      }),
    }),
  ),
)

/** The name alone an initialize request gives its client ("claude-code"), or "". */
export const clientNameIn = (initialize: string) =>
  Option.match(Initialize(initialize), {
    onNone: () => "",
    onSome: ({ params: { clientInfo } }) => clientInfo.name.trim().slice(0, 60),
  })

/**
 * Which agent made a call, to count people per agent: the OAuth client its token was given to (named by its metadata document, which
 * its own domain serves, or by its registration; a trailing "(…)" a script adds is dropped), else the name the client gave at
 * initialize, else "unknown". An API token's client names itself, so that name is only as good as the client's word.
 */
export const agentOf = (oauthClient: string, clientName: string) => {
  const named = oauthClient
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .slice(0, 60)

  return named !== "" ? named : clientName !== "" ? clientName : "unknown"
}

/** The client an initialize request names ("claude-code 2.1.3"), or "". */
export const clientIn = (initialize: string) =>
  Option.match(Initialize(initialize), {
    onNone: () => "",
    onSome: ({ params: { clientInfo } }) =>
      [clientInfo.name, clientInfo.version ?? ""].join(" ").trim().slice(0, 100),
  })

/** A function's run kinds that mean it never ran: the call was wrong, not the code. */
export const DIDNT_RUN: ReadonlySet<string> = new Set([
  "bad_input",
  "kind",
  "input",
  "not_callable",
])

/**
 * How call_function's error starts when the function's run didn't succeed (mcp.ts builds it here so judge reads it back): a run
 * that ran and threw, timed out or was stopped is failed, like execute's ok: false; one that never ran stays refused.
 */
export const runFailed = (fn: string, app: string, ms: number, tries: string, kind: string) =>
  `function ${fn} of ${app} failed after ${ms}ms${tries} (${kind})`

const RUN_FAILED = /^function \S+ of \S+ failed after \d+ms(?: \(\d+ attempts\))? \((\w+)\)/

const ranAndFailed = (text: string) => {
  const kind = RUN_FAILED.exec(text)?.[1]

  return kind !== undefined && !DIDNT_RUN.has(kind)
}

/** The text Effect's MCP server answers a tool's defect with (McpServer.ts): OpenBelt failed, not the call. */
const INTERNAL = "Tool execution failed due to an internal server error."

/** How Effect's server answers arguments that don't fit a tool's schema (AiError.ts), as a result in newer protocols. */
const INVALID_INPUT = "Invalid parameters for tool '"

/** A trace an error already names (connection_call's does), which then is its trace. */
const NAMED_TRACE = /\btrace ([0-9a-f]{12})\b/i

const namedTrace = (text: string) => NAMED_TRACE.exec(text)?.[1] ?? ""

const errorOutcome = (text: string): ToolOutcome => {
  if (text.startsWith(INTERNAL)) return "defect"

  if (text.startsWith(INVALID_INPUT)) return "invalid"

  return ranAndFailed(text) ? "failed" : "refused"
}

const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const decodeText = Schema.decodeUnknownOption(TextContent)

const Reply = Schema.decodeUnknownOption(
  Schema.Struct({
    result: Schema.optionalKey(
      Schema.Struct({
        isError: Schema.optionalKey(Schema.Boolean),
        content: Schema.optionalKey(Schema.Array(Schema.Json)),
        structuredContent: Schema.optionalKey(Schema.Json),
      }),
    ),
    error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  }),
)

/** A run that didn't succeed, as execute and call_function answer it. */
const FailedRun = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.optionalKey(Schema.Json) }),
)

const textOf = (content: ReadonlyArray<Json>) =>
  content
    .flatMap((c) => Option.match(decodeText(c), { onNone: () => [], onSome: (t) => [t.text] }))
    .join("\n")

const runError = (error: Json | undefined) => {
  if (Predicate.isString(error)) return error

  const message = isNode(error) ? error["message"] : undefined

  return Predicate.isString(message) ? message : "it returned ok: false"
}

/** The trace a result names itself (most of OpenBelt's tools answer with one), the one its caller sees. */
const OwnTrace = Schema.decodeUnknownOption(Schema.Struct({ trace: Schema.String }))

/** What became of a call, why when it wasn't ok, and the trace its result names ("" when it names none). */
export type Judged = {
  readonly outcome: ToolOutcome
  readonly error: string
  readonly trace: string
}

/** connection_call's answer when the server ran the tool and said it failed, or didn't answer: failed, not refused by OpenBelt. */
const UpstreamFailed = Schema.decodeUnknownOption(
  Schema.Struct({ outcome: Schema.Literals(["tool_error", "failed"]) }),
)

const SessionLost = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ code: Schema.Literal(-32001) }) }),
)

/**
 * A call answered with "this session can't be resumed" (mcp.ts lostSession): no tool ran, and the gateway or the client sends it
 * again on a new session, where it's kept. It already names its trace.
 */
export const sessionLost = (reply: Json) => Option.isSome(SessionLost(reply))

/** What a reply to one tools/call says became of it. */
export const judge = (reply: Json): Judged =>
  Option.match(Reply(reply), {
    onNone: (): Judged => ({ outcome: "defect", error: "the reply wasn't JSON-RPC", trace: "" }),
    onSome: ({ result, error }): Judged => {
      if (error !== undefined)
        return {
          outcome: error.code === -32602 || error.code === -32601 ? "invalid" : "defect",
          error: error.message,
          trace: namedTrace(error.message),
        }

      if (result?.isError === true) {
        const text = textOf(result.content ?? [])

        const upstream = Option.isSome(UpstreamFailed(result.structuredContent))

        return {
          outcome: upstream ? "failed" : errorOutcome(text),
          error: text,
          trace: Option.match(OwnTrace(result.structuredContent), {
            onNone: () => namedTrace(text),
            onSome: (own) => own.trace,
          }),
        }
      }

      const trace = Option.match(OwnTrace(result?.structuredContent), {
        onNone: () => "",
        onSome: (own) => own.trace,
      })

      return Option.match(FailedRun(result?.structuredContent), {
        onNone: (): Judged => ({ outcome: "ok", error: "", trace }),
        onSome: (run): Judged => ({ outcome: "failed", error: runError(run.error), trace }),
      })
    },
  })

const traced = (text: string, trace: string) =>
  trace === "" || NAMED_TRACE.test(text) ? text : `${text} (trace ${trace})`

const tracedContent = (content: ReadonlyArray<Json>, trace: string): ReadonlyArray<Json> => {
  const first = content.findIndex((c) => Option.isSome(decodeText(c)))

  if (first < 0) return [...content, { type: "text", text: `(trace ${trace})` }]

  return content.map((c, i) =>
    i === first && isNode(c) && Predicate.isString(c["text"])
      ? Object.assign({}, c, { text: traced(c["text"], trace) })
      : c,
  )
}

/**
 * A reply to a tools/call with the trace in its error, so whoever reads the error can hand it on: an error result's first text, a
 * JSON-RPC error's message. Anything else comes back as it was.
 */
export const withTrace = (reply: Json, trace: string): Json => {
  if (!isNode(reply)) return reply

  const error = reply["error"]
  const result = reply["result"]

  if (isNode(error) && Predicate.isString(error["message"]))
    return Object.assign({}, reply, {
      error: Object.assign({}, error, { message: traced(error["message"], trace) }),
    })

  if (!isNode(result) || result["isError"] !== true) return reply

  const content = result["content"]

  if (Array.isArray(content) && NAMED_TRACE.test(textOf(content))) return reply

  return Array.isArray(content)
    ? Object.assign({}, reply, {
        result: Object.assign({}, result, { content: tracedContent(content, trace) }),
      })
    : reply
}

const encoder = new TextEncoder()

/** Each JSON-RPC message in an SSE text (data: lines) settled, the rest of it as it was. */
const settleEvents = (text: string, settle: (message: Json) => Effect.Effect<Json>) =>
  Effect.forEach(text.split("\n"), (line) => {
    const message = line.startsWith("data: ") ? parsedJson(line.slice(6)) : undefined

    return message === undefined
      ? Effect.succeed(line)
      : Effect.map(settle(message), (reply) => `data: ${JSON.stringify(reply)}`)
  }).pipe(Effect.map((lines) => lines.join("\n")))

/**
 * A reply's body with each JSON-RPC message in it settled (`settle`: kept, and given back changed or not), then `done`. The reply is
 * JSON (one message, or a batch), SSE in one piece (notifications went out ahead of the result), or an SSE stream, read event by
 * event as it goes out, so nothing waits for its end. Any other body is given back as it was.
 */
export const settleBody = Effect.fnUntraced(function* (
  body: HttpBody.HttpBody,
  settle: (message: Json) => Effect.Effect<Json>,
  done: Effect.Effect<void>,
) {
  if (Predicate.isTagged(body, "Uint8Array")) {
    const text = new TextDecoder().decode(body.body)

    if (body.contentType.includes("event-stream")) {
      const settled = yield* settleEvents(text, settle)

      yield* done

      return HttpBody.text(settled, body.contentType)
    }

    const message = parsedJson(text)

    const settled = Array.isArray(message)
      ? yield* Effect.forEach(message, settle)
      : message === undefined
        ? undefined
        : yield* settle(message)

    yield* done

    return settled === undefined ? body : HttpBody.text(JSON.stringify(settled), body.contentType)
  }

  if (!Predicate.isTagged(body, "Stream")) {
    yield* done

    return body
  }

  const decoder = new TextDecoder()
  let buffer = ""

  const stream = body.stream.pipe(
    Stream.mapEffect((chunk) => {
      buffer += decoder.decode(chunk, { stream: true })

      const end = buffer.lastIndexOf("\n\n")

      if (end < 0) return Effect.succeed("")

      const whole = buffer.slice(0, end + 2)

      buffer = buffer.slice(end + 2)

      return settleEvents(whole, settle)
    }),
    Stream.concat(
      Stream.suspend(() =>
        buffer === "" ? Stream.empty : Stream.fromEffect(settleEvents(buffer, settle)),
      ),
    ),
    Stream.filter((text) => text.length > 0),
    Stream.map((text) => encoder.encode(text)),
    Stream.ensuring(done),
  )

  return HttpBody.stream(stream, body.contentType, undefined)
})

type Row = {
  at: string
  trace: string
  person: string
  client: string
  session: string
  tool: string
  app: string
  args: string
  outcome: string
  ms: number
  error: string
}

type ActivityFilter = {
  readonly person: string | undefined
  readonly app: string | undefined
  readonly tool: string | undefined
  readonly outcome: string | undefined
  readonly limit: number
}

/** The workspace's tool_calls: kept in WorkspaceDO beside connection_calls, the newest KEEP_TOOL_CALLS. */
export const openToolCalls = Effect.fn("ToolCalls.open")(function* (storage: DurableObjectStorage) {
  const { sql } = storage

  const rows = <T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: Array<string | number | null>
  ) => Effect.flatMap(sql.exec<T>(query, ...bindings), (cursor) => cursor.toArray())

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, trace TEXT NOT NULL, person TEXT NOT NULL,
    client TEXT NOT NULL, session TEXT NOT NULL, tool TEXT NOT NULL, app TEXT NOT NULL, args TEXT NOT NULL,
    outcome TEXT NOT NULL, ms INTEGER NOT NULL, error TEXT NOT NULL)`)

  const record = Effect.fn("ToolCalls.record")(function* (call: ToolCall) {
    yield* sql.exec(
      `INSERT INTO tool_calls (at, trace, person, client, session, tool, app, args, outcome, ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      call.at,
      call.trace,
      call.person,
      call.client.slice(0, 100),
      call.session,
      call.tool.slice(0, 100),
      call.app,
      call.args.slice(0, ARGS_MAX + 20),
      call.outcome,
      Math.round(call.ms),
      call.error.slice(0, 300),
    )
    yield* sql.exec(
      "DELETE FROM tool_calls WHERE id <= (SELECT MAX(id) FROM tool_calls) - ?",
      KEEP_TOOL_CALLS,
    )
  })

  const list = (filter: ActivityFilter) =>
    rows<Row>(
      `SELECT at, trace, person, client, session, tool, app, args, outcome, ms, error FROM tool_calls
       WHERE (? IS NULL OR person = ?) AND (? IS NULL OR app = ?) AND (? IS NULL OR tool = ?)
         AND (? IS NULL OR outcome = ?)
       ORDER BY id DESC LIMIT ?`,
      filter.person ?? null,
      filter.person ?? null,
      filter.app ?? null,
      filter.app ?? null,
      filter.tool ?? null,
      filter.tool ?? null,
      filter.outcome ?? null,
      filter.outcome ?? null,
      filter.limit,
    )

  return { record, list }
})

export type ToolCalls = Effect.Success<ReturnType<typeof openToolCalls>>
