// What an agent sees of OpenBelt over MCP: two tools. search finds operations (each with its input schema) and the
// workspace's apps and connections; call runs one operation. Every operation is still a tool of the MCP server (the
// openbelt CLI calls them by name), but tools/list shows only these two, and McpDO turns a call into the operation's own
// tools/call before the server sees it (unwrapCall), so its checks, permissions, tool_calls row and metric are the
// operation's own. The harness composes calls (its own code mode, if it has one): OpenBelt runs no second sandbox for it.
import type { McpSchema } from "effect/ai"
import { Base64 } from "effect/encoding"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { Json } from "./model.ts"
import { wordsIn } from "./words.ts"

/** The tools tools/list shows. */
const LISTED: ReadonlySet<string> = new Set(["search", "call"])

/** The client whose tools/list has every tool: the openbelt CLI makes a command of each (cli/src/mcp.rs, CLIENT). */
export const LISTS_EVERY_TOOL = "openbelt-cli"

/** How many operations search gives, best first, each with its input schema. */
const OPERATIONS_FOUND = 6

export const CALL_DESCRIPTION =
  'Run one OpenBelt operation: call({ tool: "<operation>", args: { ... } }). search({ query }) finds the operation for a task, with its input schema; search({ query: "" }) lists every operation. args must fit that schema; every call checks your permissions, and a refusal says what to change. For example call({ tool: "docs", args: { page: "apps" } }), call({ tool: "deploy_app", args: { app, files } }).'

export const CALL_INPUT = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: 'An operation\'s name from search, e.g. "deploy_app"',
    },
    args: {
      type: "object",
      description: "The operation's input, fitting its input schema from search",
      additionalProperties: true,
    },
  },
  required: ["tool"],
} as const

type Node = { readonly [key: string]: Json }

const isNode = (v: Json | undefined): v is Node =>
  v !== undefined &&
  v !== null &&
  !Predicate.isString(v) &&
  !Predicate.isNumber(v) &&
  !Predicate.isBoolean(v) &&
  !Array.isArray(v)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const CALL_KEYS: ReadonlySet<string> = new Set(["tool", "args"])

/**
 * What's wrong with call's arguments, or undefined when they name an operation and give it an object. Never guessed: args
 * that aren't an object (a JSON string, say) would otherwise run the operation with nothing, its defaults (token_create's
 * widest), and no word to the agent.
 */
export const callProblem = (asked: Json | undefined): string | undefined => {
  const example = 'call({ tool: "deploy_app", args: { app, files } })'

  if (!isNode(asked)) return `call takes { tool, args }: ${example}`

  const tool = asked["tool"]
  const args = asked["args"]
  const extra = Object.keys(asked).filter((k) => !CALL_KEYS.has(k))

  if (!Predicate.isString(tool) || tool === "" || tool === "call")
    return `call needs tool, an operation's name from search (not "call"), and args, its input: ${example}. search({ query: "<the task>" }) finds the operation.`

  if (extra.length > 0)
    return `call takes only tool and args, not ${extra.join(", ")}: put the operation's input in args, ${example}`

  if (args !== undefined && !isNode(args))
    return `call's args is the operation's input as a JSON object, not ${Array.isArray(args) ? "an array" : `a ${args === null ? "null" : Predicate.isString(args) ? "string" : "value"}`}: call({ tool: "${tool}", args: { ... } }). search gives its input schema.`

  return undefined
}

const unwrapOne = (message: Json): Json => {
  if (!isNode(message) || message["method"] !== "tools/call") return message

  const params = message["params"]

  if (!isNode(params) || params["name"] !== "call") return message

  const asked = params["arguments"]

  // Left as it is, call's own handler refuses it and says why (callProblem).
  if (!isNode(asked) || callProblem(asked) !== undefined) return message

  return Object.assign({}, message, {
    params: Object.assign({}, params, {
      name: asked["tool"],
      arguments: isNode(asked["args"]) ? asked["args"] : {},
    }),
  })
}

/** A JSON-RPC body with each call({ tool, args }) turned into that operation's own tools/call. */
export const unwrapCall = (body: string) => {
  if (!body.includes('"call"')) return body

  return Option.match(decodeJson(body), {
    onNone: () => body,
    onSome: (message) =>
      JSON.stringify(Array.isArray(message) ? message.map(unwrapOne) : unwrapOne(message)),
  })
}

const BASE64_HEADER = "=?base64?"

/** Printable ASCII, not starting or ending in a space: an Mcp-Name header carries it as it is. */
const PLAIN_HEADER = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/**
 * The Mcp-Name header a single tools/call body needs (MCP 2026-07-28): the tool's name, base64 between =?base64? and ?=
 * when it isn't plain ASCII. A client without a session sends it, and the server refuses a request whose Mcp-Name isn't
 * the body's tool, so a call({ tool, args }) turned into the operation's own tools/call (unwrapCall) must name the operation.
 */
export const mcpNameOf = (body: string): string | undefined =>
  Option.match(decodeJson(body), {
    onNone: () => undefined,
    onSome: (message) => {
      if (!isNode(message) || message["method"] !== "tools/call") return undefined

      const params = message["params"]
      const name = isNode(params) ? params["name"] : undefined

      if (!Predicate.isString(name)) return undefined

      return PLAIN_HEADER.test(name) && !name.startsWith(BASE64_HEADER)
        ? name
        : `${BASE64_HEADER}${Base64.encode(name)}?=`
    },
  })

/** Whether a JSON-RPC body is a tools/list request. */
export const isToolsList = (body: string) =>
  body.includes('"tools/list"') &&
  Option.match(decodeJson(body), {
    onNone: () => false,
    onSome: (m) => isNode(m) && m["method"] === "tools/list",
  })

const NOT_FOUND = /^Tool '([^']*)' not found/

/** A reply to a call of an operation that doesn't exist, told how to find the one it meant. */
export const unknownOperation = (reply: Json): Json => {
  if (!isNode(reply)) return reply

  const error = reply["error"]
  const message = isNode(error) ? error["message"] : undefined
  // wording: effect/ai's McpServer answers a tool it doesn't have with InvalidParams (-32602, as a bad argument) and "Tool '<name>' not found", with no field that tells the two apart.
  const name = Predicate.isString(message) ? NOT_FOUND.exec(message)?.[1] : undefined

  if (name === undefined || !isNode(error)) return reply

  return Object.assign({}, reply, {
    error: Object.assign({}, error, {
      message: `There's no operation "${name}". search({ query: "<the task>" }) finds the operation for it, with its input schema; search({ query: "" }) lists every operation. Run it with call({ tool, args }).`,
    }),
  })
}

/** A tools/list reply with only the listed tools in it. */
export const listedOnly = (reply: Json): Json => {
  if (!isNode(reply)) return reply

  const result = reply["result"]

  if (!isNode(result) || !Array.isArray(result["tools"])) return reply

  return Object.assign({}, reply, {
    result: Object.assign({}, result, {
      tools: result["tools"].filter(
        (t) => isNode(t) && Predicate.isString(t["name"]) && LISTED.has(t["name"]),
      ),
    }),
  })
}

const STOP = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "in",
  "on",
  "my",
  "is",
  "it",
  "and",
  "or",
  "how",
  "do",
  "i",
])

const firstSentence = (text: string) => (text.split(/(?<=\.)\s/)[0] ?? "").slice(0, 200)

/**
 * The operations for a query, best first: a word in the name counts 8, in the description 1. "list apps" finds app_list
 * (plurals are singular, and "app" counts here, unlike in the workspace search). An empty query lists every operation.
 */
export const operationsFor = (tools: ReadonlyArray<McpSchema.Tool>, query: string) => {
  const offered = tools.filter((t) => !LISTED.has(t.name))
  const words = [...new Set(wordsIn(query))].filter((w) => !STOP.has(w))

  if (words.length === 0)
    return offered
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ tool: t.name, about: firstSentence(t.description ?? "") }))

  return offered
    .flatMap((t) => {
      const name = new Set(wordsIn(t.name.replaceAll("_", " ")))
      const text = new Set(wordsIn(t.description ?? ""))
      const score = words.reduce((n, w) => n + (name.has(w) ? 8 : 0) + (text.has(w) ? 1 : 0), 0)

      return score > 0 ? [{ t, score }] : []
    })
    .toSorted((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, OPERATIONS_FOUND)
    .map(({ t }) => ({
      tool: t.name,
      description: t.description ?? "",
      // SAFETY: an MCP tool's inputSchema is a JSON Schema object (McpSchema.ToolJson), so it is JSON.
      input: t.inputSchema as Json,
    }))
}
