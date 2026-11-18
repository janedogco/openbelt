import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

const SchemaType = Schema.Literals([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
])

type SchemaType = typeof SchemaType.Type

type Json = Schema.Json

export interface JsonSchema {
  readonly type?: SchemaType | ReadonlyArray<SchemaType>
  readonly description?: string
  readonly properties?: { readonly [field: string]: JsonSchema }
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: boolean | JsonSchema
  readonly items?: JsonSchema
  readonly enum?: ReadonlyArray<Json>
  readonly const?: Json
  readonly anyOf?: ReadonlyArray<JsonSchema>
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly title?: string
  readonly default?: Json
  readonly examples?: Json
  readonly $schema?: string
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const Nested = Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchemaCodec)

export const JsonSchemaCodec: Schema.Codec<JsonSchema> = Schema.Struct({
  type: Schema.optionalKey(Schema.Union([SchemaType, Schema.Array(SchemaType)])),
  description: Schema.optionalKey(Schema.String),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Nested)),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalProperties: Schema.optionalKey(Schema.Union([Schema.Boolean, Nested])),
  items: Schema.optionalKey(Nested),
  enum: Schema.optionalKey(Schema.Array(Schema.Json).check(Schema.isMinLength(1))),
  const: Schema.optionalKey(Schema.Json),
  anyOf: Schema.optionalKey(Schema.Array(Nested).check(Schema.isMinLength(1))),
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number),
  minLength: Schema.optionalKey(Count),
  maxLength: Schema.optionalKey(Count),
  minItems: Schema.optionalKey(Count),
  maxItems: Schema.optionalKey(Count),
  title: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.Json),
  examples: Schema.optionalKey(Schema.Json),
  $schema: Schema.optionalKey(Schema.String),
}).check(
  Schema.makeFilter((s: JsonSchema) => {
    const stray = (s.required ?? []).find((field) => !Object.hasOwn(s.properties ?? {}, field))

    return (
      stray === undefined ||
      `required names "${stray}", which isn't in its properties: add it to properties or take it out of required`
    )
  }),
)

/** `record`'s own field `key` (never one it inherits: "constructor", "__proto__", "toString"). */
const own = <T>(record: { readonly [key: string]: T } | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

const typesOf = (s: JsonSchema): ReadonlyArray<SchemaType> =>
  s.type === undefined ? [] : Predicate.isString(s.type) ? [s.type] : s.type

const isFields = (v: Json): v is Schema.JsonObject =>
  v !== null &&
  !Predicate.isString(v) &&
  !Predicate.isNumber(v) &&
  !Predicate.isBoolean(v) &&
  !Array.isArray(v)

const objectOf = (v: Json) => (isFields(v) ? v : undefined)

const shown = (v: Json) => {
  if (v === null) return "null"

  if (Predicate.isString(v))
    return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`

  if (Predicate.isNumber(v)) return `number ${v}`

  if (Predicate.isBoolean(v)) return `boolean ${v}`

  return Array.isArray(v) ? "an array" : "an object"
}

const FITS = {
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => objectOf(v) !== undefined,
  integer: (v) => Predicate.isNumber(v) && Number.isInteger(v),
  number: (v) => Predicate.isNumber(v) && Number.isFinite(v),
  string: (v) => Predicate.isString(v),
  boolean: (v) => Predicate.isBoolean(v),
} satisfies { readonly [t in SchemaType]: (v: Json) => boolean }

const article = (t: string) => (/^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`)

const MAX_MISMATCHES = 8

export const misfit = (schema: JsonSchema, value: Json, at: string) => {
  const found: Array<string> = []

  const miss = (field: string, expected: string, got: string) => {
    found.push(`${field}: expected ${expected}, got ${got}`)
  }

  const check = (s: JsonSchema, v: Json, path: string) => {
    if (found.length >= MAX_MISMATCHES) return

    const types = typesOf(s)

    if (s.anyOf !== undefined && !s.anyOf.some((branch) => misfit(branch, v, path) === undefined)) {
      miss(path, `one of: ${s.anyOf.map((b) => typeOf(b)).join(" | ")}`, shown(v))
    } else if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) {
      miss(path, `exactly ${JSON.stringify(s.const)}`, shown(v))
    } else if (
      s.enum !== undefined &&
      !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))
    ) {
      miss(path, `one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`, shown(v))
    } else if (types.length > 0 && !types.some((t) => FITS[t](v))) {
      miss(path, types.map((t) => (t === "null" ? "null" : article(t))).join(" or "), shown(v))
    } else {
      within(s, v, path)
    }
  }

  const within = (s: JsonSchema, v: Json, path: string) => {
    if (Predicate.isNumber(v)) {
      if (s.minimum !== undefined && v < s.minimum) miss(path, `a number ≥ ${s.minimum}`, shown(v))
      else if (s.maximum !== undefined && v > s.maximum)
        miss(path, `a number ≤ ${s.maximum}`, shown(v))
    } else if (Predicate.isString(v)) {
      if (s.minLength !== undefined && v.length < s.minLength)
        miss(path, `a string of at least ${s.minLength} characters`, shown(v))
      else if (s.maxLength !== undefined && v.length > s.maxLength)
        miss(path, `a string of at most ${s.maxLength} characters`, shown(v))
    } else if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems)
        miss(path, `at least ${s.minItems} items`, shown(v))
      else if (s.maxItems !== undefined && v.length > s.maxItems)
        miss(path, `at most ${s.maxItems} items`, shown(v))
      else if (s.items !== undefined)
        for (const [i, item] of v.entries()) check(s.items, item, `${path}[${i}]`)
    } else {
      const fields = objectOf(v)

      if (
        fields !== undefined &&
        (s.properties !== undefined || s.additionalProperties !== undefined)
      )
        fieldsOf(s, fields, path)
    }
  }

  const fieldsOf = (s: JsonSchema, fields: { readonly [field: string]: Json }, path: string) => {
    const props = s.properties ?? {}

    for (const name of s.required ?? [])
      if (!Object.hasOwn(fields, name))
        miss(`${path}.${name}`, `${typeOf(own(props, name) ?? {})} (required)`, "nothing")

    for (const [name, field] of Object.entries(fields)) {
      const known = own(props, name)

      if (known !== undefined) check(known, field, `${path}.${name}`)
      else if (s.additionalProperties === undefined || s.additionalProperties === false)
        miss(
          `${path}.${name}`,
          `no such field (${path} takes ${Object.keys(props).join(", ") || "no fields"})`,
          shown(field),
        )
      else if (s.additionalProperties !== true)
        check(s.additionalProperties, field, `${path}.${name}`)
    }
  }

  check(schema, value, at)

  return found.length === 0 ? undefined : found.join("; ")
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * `name` as JavaScript reaches it on an object: `.notes`, or `["hourly-joke"]` for a name that isn't an identifier (a dash, a
 * leading digit), which `.hourly-joke` would read as a subtraction. Every path OpenBelt prints for code is made of these.
 */
export const member = (name: string) =>
  IDENT.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`

const constraints = (s: JsonSchema) => {
  const notes: Array<string> = []

  if (typesOf(s).includes("integer")) notes.push("integer")

  if (s.minimum !== undefined && s.maximum !== undefined) notes.push(`${s.minimum}..${s.maximum}`)
  else if (s.minimum !== undefined) notes.push(`≥ ${s.minimum}`)
  else if (s.maximum !== undefined) notes.push(`≤ ${s.maximum}`)

  if (s.minLength !== undefined || s.maxLength !== undefined)
    notes.push(`${s.minLength ?? 0}..${s.maxLength ?? "∞"} chars`)

  if (s.minItems !== undefined || s.maxItems !== undefined)
    notes.push(`${s.minItems ?? 0}..${s.maxItems ?? "∞"} items`)

  if (s.description !== undefined) notes.push(s.description.slice(0, 80))

  return notes.length === 0 ? "" : ` /* ${notes.join("; ").replaceAll("*/", "* /")} */`
}

export const typeOf = (s: JsonSchema, depth = 0): string => {
  if (depth > 8) return "unknown"

  if (s.const !== undefined) return JSON.stringify(s.const)

  if (s.enum !== undefined) return s.enum.map((e) => JSON.stringify(e)).join(" | ")

  if (s.anyOf !== undefined) return s.anyOf.map((b) => typeOf(b, depth + 1)).join(" | ")

  const types = typesOf(s)

  if (types.length === 0 && s.properties === undefined) return "unknown"

  if (types.length > 1) return types.map((t) => typeOf({ ...s, type: t }, depth + 1)).join(" | ")

  const t = types[0] ?? "object"

  if (t === "string" || t === "boolean" || t === "null") return t

  if (t === "number" || t === "integer") return "number"

  if (t === "array")
    return s.items === undefined ? "unknown[]" : `Array<${typeOf(s.items, depth + 1)}>`

  const props = Object.entries(s.properties ?? {})
  const required = new Set(s.required ?? [])

  const extra =
    s.additionalProperties === undefined || s.additionalProperties === false
      ? []
      : [
          `[key: string]: ${s.additionalProperties === true ? "unknown" : typeOf(s.additionalProperties, depth + 1)}`,
        ]

  if (props.length === 0 && extra.length === 0)
    return s.properties === undefined ? "Record<string, unknown>" : "{}"

  const fields = props.map(([name, field]) => {
    const key = IDENT.test(name) ? name : JSON.stringify(name)

    return `${key}${required.has(name) ? "" : "?"}: ${typeOf(field, depth + 1)}${constraints(field)}`
  })

  return `{ ${[...fields, ...extra].join("; ")} }`
}

export const Observed = Schema.Struct({ schema: JsonSchemaCodec, calls: Schema.Number })

export type Observed = typeof Observed.Type

const UNKNOWN: JsonSchema = {}

const MAX_DEPTH = 6

const MAX_ARRAY_SAMPLE = 5

const MAX_OBJECT_KEYS = 24

const isDataKey = (key: string) => !IDENT.test(key) || /\d{3}/.test(key) || key.length > 40

const isMap = (keys: ReadonlyArray<string>) => keys.length > MAX_OBJECT_KEYS || keys.some(isDataKey)

const MAX_ANYOF = 4

const MAX_OBSERVED_CHARS = 8_000

const isUnknown = (s: JsonSchema) => s.type === undefined && s.anyOf === undefined

const one = (s: JsonSchema) => (Predicate.isString(s.type) ? s.type : undefined)

const asNested = (s: boolean | JsonSchema | undefined) =>
  s === undefined || Predicate.isBoolean(s) ? undefined : s

const seen = (value: Json, depth = 0): JsonSchema => {
  if (value === null) return { type: "null" }

  if (Predicate.isBoolean(value)) return { type: "boolean" }

  if (Predicate.isNumber(value)) return { type: "number" }

  if (Predicate.isString(value)) return { type: "string" }

  if (depth >= MAX_DEPTH) return UNKNOWN

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array" }

    return {
      type: "array",
      items: value
        .slice(0, MAX_ARRAY_SAMPLE)
        .map((item) => seen(item, depth + 1))
        .reduce((a, b) => widen(a, b)),
    }
  }

  const entries = Object.entries(objectOf(value) ?? {})

  if (isMap(entries.map(([k]) => k))) {
    return {
      type: "object",
      additionalProperties: entries
        .slice(0, MAX_ARRAY_SAMPLE)
        .map(([, item]) => seen(item, depth + 1))
        .reduce((a, b) => widen(a, b)),
    }
  }

  return {
    type: "object",
    properties: Object.fromEntries(entries.map(([k, v]) => [k, seen(v, depth + 1)])),
    required: entries.map(([k]) => k).toSorted(),
  }
}

const widenObjects = (a: JsonSchema, b: JsonSchema): JsonSchema => {
  const aMap = asNested(a.additionalProperties)
  const bMap = asNested(b.additionalProperties)

  if (aMap !== undefined || bMap !== undefined) {
    const values = [
      ...(aMap === undefined ? [] : [aMap]),
      ...(bMap === undefined ? [] : [bMap]),
      ...Object.values(a.properties ?? {}),
      ...Object.values(b.properties ?? {}),
    ]

    return { type: "object", additionalProperties: values.reduce((x, y) => widen(x, y)) }
  }

  const ap = a.properties ?? {}
  const bp = b.properties ?? {}
  const keys = [...new Set([...Object.keys(ap), ...Object.keys(bp)])].toSorted()

  if (isMap(keys)) {
    const values = keys.slice(0, MAX_ARRAY_SAMPLE).flatMap((k) => {
      const field = own(ap, k) ?? own(bp, k)

      return field === undefined ? [] : [field]
    })

    return { type: "object", additionalProperties: values.reduce((x, y) => widen(x, y)) }
  }

  const required = new Set(a.required ?? [])

  return {
    type: "object",
    properties: Object.fromEntries(
      keys.map((k) => {
        const x = own(ap, k)
        const y = own(bp, k)

        return [k, x !== undefined && y !== undefined ? widen(x, y) : (x ?? y ?? UNKNOWN)]
      }),
    ),
    required: (b.required ?? []).filter((k) => required.has(k)).toSorted(),
  }
}

const addBranch = (union: JsonSchema, branch: JsonSchema): JsonSchema => {
  if (isUnknown(union) || isUnknown(branch)) return UNKNOWN

  const branches = [...(union.anyOf ?? [union])]
  const i = branches.findIndex((existing) => one(existing) === one(branch))

  const next =
    i === -1 ? [...branches, branch] : branches.map((e, j) => (j === i ? widen(e, branch) : e))

  if (next.length > MAX_ANYOF) return UNKNOWN

  return next.length === 1 ? (next[0] ?? UNKNOWN) : { anyOf: next }
}

const widen = (a: JsonSchema, b: JsonSchema): JsonSchema => {
  if (isUnknown(a) || isUnknown(b)) return UNKNOWN

  if (a.anyOf !== undefined || b.anyOf !== undefined) {
    return [...(a.anyOf ?? [a]), ...(b.anyOf ?? [b])].reduce<JsonSchema>(
      (merged, branch) => addBranch(merged, branch),
      { anyOf: [] },
    )
  }

  if (one(a) !== one(b)) return addBranch({ anyOf: [a] }, b)

  if (one(a) === "object") return widenObjects(a, b)

  if (one(a) === "array") {
    if (a.items === undefined) return b

    if (b.items === undefined) return a

    return { type: "array", items: widen(a.items, b.items) }
  }

  return a
}

const shrink = (s: JsonSchema, depth: number): JsonSchema => {
  if (depth <= 0) return UNKNOWN

  if (s.anyOf !== undefined) return { anyOf: s.anyOf.map((b) => shrink(b, depth - 1)) }

  if (s.items !== undefined) return { type: "array", items: shrink(s.items, depth - 1) }

  const map = asNested(s.additionalProperties)

  if (map !== undefined) return { type: "object", additionalProperties: shrink(map, depth - 1) }

  if (s.properties !== undefined) {
    return {
      ...s,
      properties: Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [k, shrink(v, depth - 1)]),
      ),
    }
  }

  return s
}

export const observe = (previous: Observed | undefined, value: Json): Observed => {
  const now = seen(value)
  let schema = previous === undefined ? now : widen(previous.schema, now)

  for (let d = MAX_DEPTH; d > 0 && JSON.stringify(schema).length > MAX_OBSERVED_CHARS; d--)
    schema = shrink(schema, d)

  return { schema, calls: (previous?.calls ?? 0) + 1 }
}

/**
 * What a run read of its input (functions.ts's harness records it): the keys it read of each object (some it asked for that
 * weren't there), whether it listed an object's keys (Object.keys, a spread, JSON.stringify), and what it read of an array's
 * items, all of them together.
 */
export interface InputReads {
  readonly keys: { readonly [key: string]: InputReads }
  readonly listed?: boolean
  readonly items?: InputReads
}

const NestedReads = Schema.suspend((): Schema.Codec<InputReads> => InputReadsCodec)

export const InputReadsCodec: Schema.Codec<InputReads> = Schema.Struct({
  keys: Schema.Record(Schema.String, NestedReads),
  listed: Schema.optionalKey(Schema.Boolean),
  items: Schema.optionalKey(NestedReads),
})

/**
 * How much of a run's input the harness watches (functions.ts), so watching costs little whatever the input: an array's first
 * items (what an observed type samples), objects with up to so many keys (one with more is a map to an observed type), so many
 * objects (past them a value counts as all read), and so many keys asked for that aren't there.
 */
export const READS_WATCHED = {
  items: MAX_ARRAY_SAMPLE,
  keys: MAX_OBJECT_KEYS,
  objects: 200,
  absent: 100,
} as const

/** `value` cut to what a run read of it, so a key a function never reads never joins its observed input. */
export const readPart = (value: Json, read: InputReads): Json => {
  if (Array.isArray(value)) {
    const items = read.items

    // Only the first items are watched: a longer array's later reads (find, at(-1)) are unknown, so all of it counts as read.
    if (read.listed === true || value.length > READS_WATCHED.items) return value

    return items === undefined
      ? []
      : value.slice(0, READS_WATCHED.items).map((item) => readPart(item, items))
  }

  const fields = objectOf(value)

  if (fields === undefined) return value

  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, field]) => {
      const child = own(read.keys, key)

      if (child !== undefined) return [[key, readPart(field, child)]]

      return read.listed === true ? [[key, field]] : []
    }),
  )
}

/** The paths of `value`'s keys a run never read (`subjekt`, `address.zipp`, `items[].qtty`). */
const unreadPaths = (value: Json, read: InputReads, at = ""): ReadonlyArray<string> => {
  if (Array.isArray(value)) {
    const items = read.items

    return items === undefined || read.listed === true || value.length > READS_WATCHED.items
      ? []
      : [
          ...new Set(
            value
              .slice(0, READS_WATCHED.items)
              .flatMap((item) => unreadPaths(item, items, `${at}[]`)),
          ),
        ]
  }

  return Object.entries(objectOf(value) ?? {}).flatMap(([key, field]) => {
    const child = own(read.keys, key)
    const path = at === "" ? key : `${at}.${key}`

    if (child !== undefined) return unreadPaths(field, child, path)

    return read.listed === true ? [] : [path]
  })
}

const readPaths = (read: InputReads, at: string): ReadonlyArray<string> => {
  const inner = [
    ...Object.entries(read.keys).flatMap(([key, child]) =>
      readPaths(child, at === "" ? key : `${at}.${key}`),
    ),
    ...(read.items === undefined ? [] : readPaths(read.items, `${at}[]`)),
  ]

  return inner.length === 0 && at !== "" ? [at] : inner
}

const schemaPaths = (s: JsonSchema, at: string, depth = 0): ReadonlyArray<string> => {
  const inner =
    depth > MAX_DEPTH
      ? []
      : [
          ...Object.entries(s.properties ?? {}).flatMap(([key, field]) =>
            schemaPaths(field, at === "" ? key : `${at}.${key}`, depth + 1),
          ),
          ...(s.items === undefined ? [] : schemaPaths(s.items, `${at}[]`, depth + 1)),
          ...(s.anyOf ?? []).flatMap((branch) => schemaPaths(branch, at, depth + 1)),
        ]

  return inner.length === 0 && at !== "" ? [at] : inner
}

/** What an agent's call is told when its input had keys the function never read: a misspelt key changes nothing. */
export type Unread = {
  /** The paths it sent that the run never read. */
  readonly paths: ReadonlyArray<string>
  /** The paths it reads: this run's (some not sent) and what its observed input has. */
  readonly reads: ReadonlyArray<string>
}

export const unreadOf = (
  value: Json,
  read: InputReads,
  learned: Observed | undefined,
): Unread | undefined => {
  const paths = unreadPaths(value, read)

  if (paths.length === 0) return undefined

  const reads = new Set([
    ...readPaths(read, ""),
    ...(learned === undefined ? [] : schemaPaths(learned.schema, "")),
  ])

  return { paths, reads: [...reads].toSorted() }
}

const UNREAD_SHOWN = 10

const pathList = (paths: ReadonlyArray<string>) =>
  paths
    .slice(0, UNREAD_SHOWN)
    .map((p) => `input.${p}`)
    .join(", ") + (paths.length > UNREAD_SHOWN ? ` and ${paths.length - UNREAD_SHOWN} more` : "")

/** `receive never read input.subjekt, so it changed nothing. It reads input.subject.` */
export const unreadNote = (called: string, unread: Unread) =>
  `${called} never read ${pathList(unread.paths)}, so ${unread.paths.length === 1 ? "it" : "they"} changed nothing. ${unread.reads.length === 0 ? "It reads no input keys." : `It reads ${pathList(unread.reads)}.`}`

const side = (declared: JsonSchema | undefined, observed: Observed | undefined) =>
  declared !== undefined
    ? typeOf(declared)
    : observed === undefined
      ? "unknown /* not called yet */"
      : `/* observed */ ${typeOf(observed.schema)}`

export const signature = (
  name: string,
  declared: { readonly input?: JsonSchema | undefined; readonly output?: JsonSchema | undefined },
  observed: { readonly input?: Observed | undefined; readonly output?: Observed | undefined },
) =>
  `${name}(input: ${side(declared.input, observed.input)}): Promise<${side(declared.output, observed.output)}>`
