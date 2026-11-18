import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { Json } from "./model.ts"
import type { ToolResult } from "./upstream.ts"

/** An agent reads at most this much of one answer: its client sees it twice (content and structured), and Claude Code refuses past 25,000 tokens. */
export const AGENT_CHARS = 24_000

export const Fields = Schema.Array(Schema.String).annotate({
  description:
    'Keep only these parts of the answer, by dot path, through arrays: ["name", "types.type.name", "sprites.front_default"]. OpenBelt\'s, not the tool\'s',
})

type Node = { readonly [key: string]: Json }

const isNode = (v: Json | undefined): v is Node =>
  v !== undefined &&
  v !== null &&
  !Predicate.isString(v) &&
  !Predicate.isNumber(v) &&
  !Predicate.isBoolean(v) &&
  !Array.isArray(v)

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const keep = (value: Json, paths: ReadonlyArray<ReadonlyArray<string>>): Json => {
  if (Array.isArray(value)) return value.map((v) => keep(v, paths))

  if (!isNode(value)) return value

  const byKey = new Map<string, Array<ReadonlyArray<string>>>()

  for (const [first = "", ...rest] of paths) byKey.set(first, [...(byKey.get(first) ?? []), rest])

  return Object.fromEntries(
    [...byKey].flatMap(([key, rests]) => {
      const v = value[key]

      if (v === undefined) return []

      return [[key, rests.some((r) => r.length === 0) ? v : keep(v, rests)] as const]
    }),
  )
}

export const keepFields = (
  result: ToolResult,
  fields: ReadonlyArray<string> | undefined,
): ToolResult => {
  if (fields === undefined || fields.length === 0 || result.isError === true) return result

  const paths = fields.map((f) => f.split("."))

  const kept: ToolResult = {
    ...result,
    content: result.content.map((block) => {
      const text = Schema.decodeUnknownOption(
        Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      )(block)

      return Option.match(
        Option.flatMap(text, (t) => decodeJson(t.text)),
        {
          onNone: () => block,
          onSome: (json) => ({ type: "text", text: JSON.stringify(keep(json, paths)) }),
        },
      )
    }),
  }

  if (result.structuredContent === undefined) return kept

  return { ...kept, structuredContent: keep(result.structuredContent, paths) }
}

const firstItems = (items: ReadonlyArray<Json>, budget: number) => {
  let used = 2
  const kept: Array<Json> = []

  for (const item of items) {
    const n = JSON.stringify(item).length + 1

    if (used + n > budget) break

    used += n
    kept.push(item)
  }

  return kept
}

type Fitted = { readonly body: Json; readonly cut: string }

const fitJson = (body: Json, size: number): Fitted | undefined => {
  if (Array.isArray(body)) {
    const kept = firstItems(body, AGENT_CHARS)

    return { body: kept, cut: `kept the first ${kept.length} of ${body.length} items` }
  }

  if (!isNode(body)) return undefined

  const sizes = Object.entries(body)
    .map(([k, v]) => [k, JSON.stringify(v).length] as const)
    .toSorted((a, b) => b[1] - a[1])

  const out = new Map(Object.entries(body))
  const said: Array<string> = []
  let total = size

  for (const [key, n] of sizes) {
    if (total <= AGENT_CHARS) break

    const value = body[key]
    const room = AGENT_CHARS - (total - n)

    if (Array.isArray(value) && room > 100) {
      const kept = firstItems(value, room)

      out.set(key, kept)
      total += JSON.stringify(kept).length - n
      said.push(`${key} keeps ${kept.length} of ${value.length} items`)
    } else {
      out.delete(key)
      total -= n + key.length + 4
      said.push(`left out ${key} (${n} characters)`)
    }
  }

  return { body: Object.fromEntries(out), cut: said.join(", ") }
}

export const forAgent = (text: string) => {
  if (text.length <= AGENT_CHARS) return text

  const hint = `it was ${text.length} characters, past the ${AGENT_CHARS} you're shown: keep only the parts you need with fields (connection_call({ tool, input, fields: ["name", "items.id"] })), ask for fewer (a page size), or read it in code, where execute's workspace.connections and a page's tools.call get it whole`

  const fitted = Option.flatMapNullishOr(decodeJson(text), (json) => fitJson(json, text.length))

  return Option.match(fitted, {
    onNone: () => `${text.slice(0, AGENT_CHARS)}\n... (OpenBelt cut this: ${hint})`,
    onSome: (f) => `${JSON.stringify(f.body)}\n(OpenBelt ${f.cut}: ${hint})`,
  })
}
