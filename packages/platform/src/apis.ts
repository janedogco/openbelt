import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as YAML from "yaml"
import { type Fix, type Json, Refused } from "./model.ts"
import { bearerChallenge } from "./oauth-wire.ts"
import {
  correlation,
  lookedUp,
  redact,
  resolvesPrivate,
  type Reach,
  type ToolResult,
  type UpstreamTool,
  urlProblem,
} from "./upstream.ts"
import { exchange, type Sending, textUpTo } from "./outbound.ts"

const MAX_UNPICKED = 300

/**
 * A spec bigger than this isn't read (GitHub's is 14 MB): it's read in the workspace's Durable Object,
 * whose isolate has 128 MB, and parsing one takes about three times its size.
 */
const MAX_SPEC_BYTES = 32_000_000

const MAX_ANSWER_BYTES = 10_000_000

const MAX_BODY_CHARS = 1_000_000

const MAX_INPUT_CHARS = 16_000

const SPEC_MS = 30_000

const CALL_MS = 60_000

const ApiAuth = Schema.Union([
  Schema.Struct({ in: Schema.Literal("header"), name: Schema.String, prefix: Schema.String }),
  Schema.Struct({ in: Schema.Literal("query"), name: Schema.String }),
])

export type ApiAuth = typeof ApiAuth.Type

const ApiSource = Schema.Struct({
  kind: Schema.Literals(["openapi", "graphql"]),
  spec: Schema.NullOr(Schema.String),
  auth: ApiAuth,
  tags: Schema.NullOr(Schema.Array(Schema.String)),
})

type ApiSource = typeof ApiSource.Type

export const decodeApiSource = Schema.decodeUnknownOption(Schema.fromJsonString(ApiSource))

const Param = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header"]),
})

const Binding = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("http"),
    method: Schema.String,
    path: Schema.String,
    params: Schema.Array(Param),
    body: Schema.NullOr(Schema.Literals(["json", "form", "text"])),
    required: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("graphql"),
    operation: Schema.Literals(["query", "mutation"]),
    field: Schema.String,
    args: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
    select: Schema.String,
  }),
])

export type Binding = typeof Binding.Type

export const decodeBinding = Schema.decodeUnknownOption(Schema.fromJsonString(Binding))

export type ApiTool = UpstreamTool & {
  readonly binding: Binding
  readonly tags: ReadonlyArray<string>
}

export type Read = {
  readonly tools: ReadonlyArray<ApiTool>
  readonly base: string | undefined
  readonly auth: ApiAuth | undefined
  readonly title: string
}

type Node = Schema.JsonObject

const EMPTY: Node = {}

const isNode = (v: Json | undefined): v is Node =>
  v !== undefined &&
  v !== null &&
  !Predicate.isString(v) &&
  !Predicate.isNumber(v) &&
  !Predicate.isBoolean(v) &&
  !Array.isArray(v)

const node = (v: Json | undefined): Node => (isNode(v) ? v : EMPTY)

const list = (v: Json | undefined): ReadonlyArray<Json> => (Array.isArray(v) ? v : [])

const text = (v: Json | undefined): string | undefined => (Predicate.isString(v) ? v : undefined)

const parse = (body: string) =>
  Effect.try({
    try: (): Json => (body.trimStart().startsWith("{") ? JSON.parse(body) : YAML.parse(body)),
    catch: (cause) =>
      new Refused({
        message: `the spec isn't JSON or YAML (${cause instanceof Error ? cause.message.slice(0, 200) : "unreadable"}): send an OpenAPI 3 or Swagger 2 document`,
      }),
  })

/** An API call's method and body, filled in by its kind (REST or GraphQL) before it is sent. */
type CallInit = { method?: string; body?: string }

const fetchText = Effect.fnUntraced(function* (
  url: string,
  reach: Reach,
  init: Sending,
  what: string,
) {
  const problem = urlProblem(url, reach, "connection")

  if (problem !== undefined) return yield* new Refused({ message: `${what}: ${problem}` })

  yield* resolvesPrivate(url)

  const headers = { "user-agent": "OpenBelt-Connections/1", ...(yield* correlation) }

  return yield* exchange(
    {
      kind: "api",
      url,
      ...init,
      headers: { ...headers, ...Object.fromEntries(new Headers(init.headers).entries()) },
      timeoutMs: SPEC_MS,
    },
    (answer) =>
      Effect.map(textUpTo(answer, MAX_SPEC_BYTES), (body) => ({
        status: answer.status,
        body,
        location: answer.headers.get("location"),
      })),
  ).pipe(
    Effect.catchTag("OutboundFailed", () =>
      Effect.fail(
        new Refused({
          message: `couldn't fetch ${what} from ${url.slice(0, 200)} (it didn't answer within ${SPEC_MS / 1000}s, or the connection broke): check the URL, or try again`,
        }),
      ),
    ),
    Effect.flatMap((got) =>
      got.status >= 300 && got.status < 400
        ? Effect.fail(
            new Refused({
              message: `${url.slice(0, 200)} redirects to ${got.location ?? "elsewhere"} (HTTP ${got.status}), which OpenBelt doesn't follow for ${what}: send that URL instead`,
            }),
          )
        : got.body === undefined
          ? Effect.fail(
              new Refused({
                message: `${what} at ${url.slice(0, 200)} is past the ${MAX_SPEC_BYTES / 1_000_000} MB OpenBelt reads: send a smaller one (a spec of just the operations the workspace needs)`,
              }),
            )
          : got.status >= 400
            ? Effect.fail(
                new Refused({
                  message: `${url.slice(0, 200)} answered HTTP ${got.status} for ${what}: ${got.body.replace(/\s+/g, " ").slice(0, 200)}`,
                }),
              )
            : Effect.succeed(got.body),
    ),
  )
})

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const

const READ_METHODS = new Set(["get", "head", "options"])

const NOISE = new Set(["example", "examples", "xml", "externalDocs", "discriminator"])

const REF_DEPTHS = [5, 3, 2, 1]

const pointer = (root: Json, ref: string): Json | undefined => {
  let at: Json | undefined = root

  for (const raw of ref.slice(2).split("/")) {
    const part = decodeURIComponent(raw.replaceAll("~1", "/").replaceAll("~0", "~"))

    at = isNode(at) ? at[part] : Array.isArray(at) ? at[Number(part)] : undefined
  }

  return at
}

const resolve = (
  value: Json,
  root: Json,
  depth: number,
  seen: ReadonlyArray<string> = [],
): Json => {
  if (Array.isArray(value)) return value.map((v) => resolve(v, root, depth, seen))

  if (!isNode(value)) return value

  const ref = text(value["$ref"])

  if (ref !== undefined) {
    const name = ref.split("/").at(-1) ?? ref

    if (!ref.startsWith("#/")) return { description: `${name} (an outside $ref, not read)` }

    if (seen.includes(ref)) return { type: "object", description: `${name} (recursive: as above)` }

    if (seen.length >= depth) return { type: "object", description: `${name} (not expanded)` }

    return resolve(pointer(root, ref) ?? {}, root, depth, [...seen, ref])
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) =>
      NOISE.has(k) || k.startsWith("x-") ? [] : [[k, resolve(v, root, depth, seen)] as const],
    ),
  )
}

const toolName = (raw: string) =>
  raw
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 64) || "operation"

const short = (s: string, n: number) => {
  const line = s.trim().split("\n")[0] ?? ""

  return line.length > n ? `${line.slice(0, n - 3)}...` : line
}

const authOf = (spec: Node): ApiAuth | undefined => {
  const schemes = Object.values(
    node(node(spec["components"])["securitySchemes"] ?? spec["securityDefinitions"]),
  ).map(node)

  const ranked = [
    ...schemes.filter((s) => s["type"] === "apiKey"),
    ...schemes.filter((s) => s["type"] !== "apiKey"),
  ]

  for (const s of ranked) {
    const name = text(s["name"])

    if (
      s["type"] === "apiKey" &&
      name !== undefined &&
      (s["in"] === "header" || s["in"] === "query")
    )
      return s["in"] === "header" ? { in: "header", name, prefix: "" } : { in: "query", name }

    if (s["type"] === "http" && text(s["scheme"])?.toLowerCase() === "basic")
      return { in: "header", name: "authorization", prefix: "Basic " }

    if (s["type"] === "http" || s["type"] === "oauth2" || s["type"] === "openIdConnect")
      return { in: "header", name: "authorization", prefix: "Bearer " }
  }

  return undefined
}

const baseOf = (spec: Node, from: string | undefined): string | undefined => {
  const server = node(list(spec["servers"])[0])
  const url = text(server["url"])

  if (url !== undefined) {
    const vars = node(server["variables"])

    const filled = url.replace(
      /\{([^}]+)\}/g,
      (_, v: string) => text(node(vars[v])["default"]) ?? v,
    )

    if (URL.canParse(filled)) return filled

    return from !== undefined && URL.canParse(filled, from) ? new URL(filled, from).href : undefined
  }

  const host = text(spec["host"])

  if (host === undefined) return undefined

  const scheme = list(spec["schemes"]).includes("https")
    ? "https"
    : (text(list(spec["schemes"])[0]) ?? "https")

  return `${scheme}://${host}${text(spec["basePath"]) ?? ""}`
}

const paramSchema = (p: Node): Node => {
  const schema = p["schema"]

  const own = isNode(schema)
    ? schema
    : Object.fromEntries(
        Object.entries(p).filter(([k]) => !["name", "in", "required", "description"].includes(k)),
      )

  const about = text(p["description"])

  if (about === undefined) return own

  return Object.fromEntries([...Object.entries(own), ["description", short(about, 300)]])
}

const bodyOf = (op: Node, params: ReadonlyArray<Node>) => {
  const swagger = params.find((p) => p["in"] === "body")

  if (swagger !== undefined)
    return {
      type: "json" as const,
      schema: node(swagger["schema"]),
      required: swagger["required"] === true,
    }

  const form = params.filter((p) => p["in"] === "formData")

  if (form.length > 0)
    return {
      type: "form" as const,
      schema: {
        type: "object",
        properties: Object.fromEntries(form.map((p) => [text(p["name"]) ?? "", paramSchema(p)])),
      },
      required: form.some((p) => p["required"] === true),
    }

  const request = node(op["requestBody"])
  const content = node(request["content"])
  const types = Object.keys(content)
  const required = request["required"] === true
  const jsonType = types.find((t) => t.includes("json"))

  if (jsonType !== undefined)
    return { type: "json" as const, schema: node(node(content[jsonType])["schema"]), required }

  const formType = types.find((t) => t === "application/x-www-form-urlencoded")

  if (formType !== undefined)
    return { type: "form" as const, schema: node(node(content[formType])["schema"]), required }

  if (types.length > 0)
    return {
      type: "text" as const,
      schema: { type: "string", description: `the body, sent as ${types[0]}` },
      required,
    }

  return undefined
}

const OWN_HEADERS = new Set([
  "accept",
  "content-type",
  "authorization",
  "user-agent",
  "content-length",
])

const operationTool = (
  spec: Node,
  auth: ApiAuth | undefined,
  path: string,
  method: (typeof METHODS)[number],
  raw: Node,
  shared: ReadonlyArray<Json>,
  name: string,
  tags: ReadonlyArray<string>,
  depth: number,
): ApiTool => {
  const op = node(resolve(raw, spec, depth))
  const params = [...list(resolve(shared, spec, depth)), ...list(op["parameters"])].map(node)

  const unique = params.filter(
    (p, i) => params.findLastIndex((q) => q["name"] === p["name"] && q["in"] === p["in"]) === i,
  )

  const sent = unique.flatMap((p) => {
    const named = text(p["name"])
    const where = p["in"]

    if (named === undefined) return []

    const header =
      where === "header" &&
      !OWN_HEADERS.has(named.toLowerCase()) &&
      !(auth?.in === "header" && auth.name.toLowerCase() === named.toLowerCase())

    const place: (typeof Param.Type)["in"] | undefined =
      where === "path" ? "path" : where === "query" ? "query" : header ? "header" : undefined

    return place === undefined ? [] : [{ p, name: named, in: place }]
  })

  const names = sent.map((p) => p.name)
  const properties: Record<string, Json> = {}
  const required: Array<string> = []
  const bound: Array<typeof Param.Type> = []

  for (const p of sent) {
    const key =
      names.filter((n) => n === p.name).length > 1 && p.in !== "path" ? `${p.in}_${p.name}` : p.name

    properties[key] = paramSchema(p.p)
    bound.push({ key, name: p.name, in: p.in })

    if (p.p["required"] === true || p.in === "path") required.push(key)
  }

  const body = bodyOf(op, unique)

  if (body !== undefined) {
    properties["body"] = body.schema

    if (body.required) required.push("body")
  }

  const summary = text(op["summary"]) ?? short(text(op["description"]) ?? "", 160)
  const readOnly = READ_METHODS.has(method)
  const verb = `${method.toUpperCase()} ${path}`
  const about = text(op["description"])

  return {
    name,
    description: `${summary === "" ? verb : `${summary} (${verb})`}${about === undefined || about === summary ? "" : `\n${about.slice(0, 1500)}`}`,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, title: summary, tags },
    readOnly,
    tags,
    binding: {
      kind: "http",
      method: method.toUpperCase(),
      path,
      params: bound,
      body: body?.type ?? null,
      required,
    },
  }
}

const operationsOf = (spec: Node) => {
  const found: Array<{
    readonly path: string
    readonly method: (typeof METHODS)[number]
    readonly raw: Node
    readonly shared: ReadonlyArray<Json>
    readonly name: string
    readonly tags: ReadonlyArray<string>
  }> = []

  const taken = new Set<string>()

  for (const [path, item] of Object.entries(node(spec["paths"]))) {
    const shared = list(node(item)["parameters"])

    for (const method of METHODS) {
      const raw = node(item)[method]

      if (!isNode(raw)) continue

      const base = toolName(text(raw["operationId"]) ?? `${method}_${path}`)
      let name = base

      for (let n = 2; taken.has(name); n++) name = `${base}_${n}`

      taken.add(name)

      const tags = list(raw["tags"]).flatMap((t) => Option.toArray(Option.fromUndefinedOr(text(t))))

      found.push({ path, method, raw, shared, name, tags })
    }
  }

  return found
}

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/"

/** A scope as a tag: Google's without its prefix (`gmail.send`), any other as it is. */
const scopeTag = (scope: string) =>
  scope.startsWith(GOOGLE_SCOPE) ? scope.slice(GOOGLE_SCOPE.length) : scope

/** Discovery's `$ref: "Event"` names a schema of its own: OpenAPI's is a pointer to it. */
const discoverySchema = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(discoverySchema)

  if (!isNode(value)) return value

  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) => {
      if (k === "$ref" && Predicate.isString(v)) return [[k, `#/components/schemas/${v}`] as const]

      // Draft 3's per-property `required: true` isn't OpenAPI's list; annotations say which
      // methods need a field, which the description says too.
      if (k === "id" || k === "annotations" || (k === "required" && !Array.isArray(v))) return []

      return [[k, discoverySchema(v)] as const]
    }),
  )
}

const discoveryParam = (name: string, p: Node): Node => {
  const own: Record<string, Json> = {}

  for (const k of ["type", "format", "enum", "default", "pattern", "minimum", "maximum"])
    if (p[k] !== undefined) own[k] = p[k] ?? null

  const about = text(p["description"])

  return Object.fromEntries([
    ["name", name],
    ["in", p["location"] === "path" ? "path" : "query"],
    ["required", p["required"] === true || p["location"] === "path"],
    ["schema", p["repeated"] === true ? { type: "array", items: own } : own],
    ...(about === undefined ? [] : [["description", about] as const]),
  ])
}

/**
 * A Google Discovery document (googleapis.com/discovery/v1/apis/<api>/<version>/rest) as the
 * OpenAPI document it describes: each method an operation named by its id
 * (`calendar.events.list`), tagged with the scopes that allow it (`calendar.readonly`), so an
 * entry's groups take what its sign-in can do. Google publishes no OpenAPI for its APIs.
 */
const fromDiscovery = (doc: Node): Node => {
  const paths: Record<string, Record<string, Json>> = {}

  const visit = (resource: Node) => {
    for (const method of Object.values(node(resource["methods"])).map(node)) {
      const path = text(method["path"])
      const verb = text(method["httpMethod"])?.toLowerCase()

      if (path === undefined || verb === undefined) continue

      const request = text(node(method["request"])["$ref"])
      const at = `/${path.replace(/\{\+([^}]+)\}/g, "{$1}")}`

      const about = text(method["description"])

      const body = {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${request}` } } },
      }

      const operation = Object.fromEntries([
        ["operationId", text(method["id"]) ?? `${verb} ${path}`],
        [
          "tags",
          list(method["scopes"]).flatMap((s) => (Predicate.isString(s) ? [scopeTag(s)] : [])),
        ],
        [
          "parameters",
          Object.entries(node(method["parameters"])).map(([name, p]) =>
            discoveryParam(name, node(p)),
          ),
        ],
        ["responses", {}],
        ...(about === undefined ? [] : [["description", about] as const]),
        ...(request === undefined ? [] : [["requestBody", body] as const]),
      ])

      paths[at] = { ...paths[at], [verb]: operation }
    }

    for (const child of Object.values(node(resource["resources"])).map(node)) visit(child)
  }

  visit(doc)

  return {
    openapi: "3.0.3",
    info: {
      title: text(doc["title"]) ?? text(doc["name"]) ?? "",
      version: text(doc["version"]) ?? "",
    },
    servers: [{ url: `${text(doc["rootUrl"]) ?? ""}${text(doc["servicePath"]) ?? ""}` }],
    components: {
      securitySchemes: { oauth2: { type: "oauth2" } },
      schemas: node(discoverySchema(doc["schemas"] ?? {})),
    },
    paths,
  }
}

const readOpenApi = Effect.fnUntraced(function* (
  body: string,
  from: string | undefined,
  connection: string,
  tags: ReadonlyArray<string> | null,
) {
  const parsed = yield* parse(body)

  const spec =
    isNode(parsed) && text(parsed["discoveryVersion"]) !== undefined
      ? fromDiscovery(parsed)
      : parsed

  if (!isNode(spec) || (text(spec["openapi"]) === undefined && text(spec["swagger"]) === undefined))
    return yield* new Refused({
      message:
        `that isn't an OpenAPI document or a Google Discovery document: it has no "openapi" (3.x), "swagger" (2.0) or "discoveryVersion" field. ${isNode(spec) && "data" in spec ? "A GraphQL endpoint is added with kind graphql." : ""}`.trim(),
    })

  if (!isNode(spec["paths"]) || Object.keys(spec["paths"]).length === 0)
    return yield* new Refused({ message: "the spec has no paths, so no operations to call" })

  const auth = authOf(spec)
  const found = yield* pick(connection, operationsOf(spec), tags)

  const tools = found.map((o) => {
    const at = (depth: number) =>
      operationTool(spec, auth, o.path, o.method, o.raw, o.shared, o.name, o.tags, depth)

    for (const depth of REF_DEPTHS) {
      const tool = at(depth)

      if (JSON.stringify(tool.inputSchema).length <= MAX_INPUT_CHARS) return tool
    }

    return at(0)
  })

  const read: Read = {
    tools,
    base: baseOf(spec, from),
    auth,
    title: text(node(spec["info"])["title"]) ?? "",
  }

  return read
})

// Two queries, each at most 7 deep (a CDN in front of Countries refuses 8): every type with its
// fields (whose arguments only say whether they're required), then the root types' fields with
// their arguments in full, through __type.
const TYPE_REF =
  "fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }"

const INTROSPECTION = `query OpenBelt {
  __schema {
    queryType { name } mutationType { name }
    types { kind name description
      fields(includeDeprecated: false) { name description args { name type { kind } } type { ...T } }
      inputFields { name description type { ...T } }
      enumValues(includeDeprecated: false) { name }
    }
  }
}
${TYPE_REF}`

const ROOT_ARGS = `query OpenBeltRoot($name: String!) {
  __type(name: $name) { fields(includeDeprecated: false) { name args { name description type { ...T } } } }
}
${TYPE_REF}`

type TypeRef = {
  readonly kind: string
  readonly name: string | null
  readonly ofType?: TypeRef | null
}

const TypeRef: Schema.Codec<TypeRef> = Schema.Struct({
  kind: Schema.String,
  name: Schema.NullOr(Schema.String),
  ofType: Schema.optionalKey(Schema.NullOr(Schema.suspend((): Schema.Codec<TypeRef> => TypeRef))),
})

const GqlArg = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  type: TypeRef,
})

type GqlArg = typeof GqlArg.Type

const GqlField = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  args: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ name: Schema.String, type: Schema.Struct({ kind: Schema.String }) }),
    ),
  ),
  type: TypeRef,
})

const RootArgs = Schema.Struct({
  data: Schema.Struct({
    __type: Schema.Struct({
      fields: Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.Array(GqlArg) })),
    }),
  }),
})

const decodeRootArgs = Schema.decodeUnknownOption(Schema.fromJsonString(RootArgs))

const GqlType = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  fields: Schema.NullOr(Schema.Array(GqlField)),
  inputFields: Schema.NullOr(Schema.Array(GqlField)),
  enumValues: Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String }))),
})

type GqlType = typeof GqlType.Type

const Introspected = Schema.Struct({
  data: Schema.Struct({
    __schema: Schema.Struct({
      queryType: Schema.NullOr(Schema.Struct({ name: Schema.String })),
      mutationType: Schema.NullOr(Schema.Struct({ name: Schema.String })),
      types: Schema.Array(GqlType),
    }),
  }),
})

const decodeIntrospected = Schema.decodeUnknownOption(Schema.fromJsonString(Introspected))

const written = (t: TypeRef): string =>
  t.kind === "NON_NULL" && t.ofType
    ? `${written(t.ofType)}!`
    : t.kind === "LIST" && t.ofType
      ? `[${written(t.ofType)}]`
      : (t.name ?? "?")

const named = (t: TypeRef): TypeRef => (t.ofType ? named(t.ofType) : t)

const SCALARS = {
  Int: "integer",
  Float: "number",
  Boolean: "boolean",
  String: "string",
  ID: "string",
} satisfies Readonly<Record<string, string>>

const described = (schema: Node, about: string | null, n: number): Node => {
  if (about === null || about === "") return schema

  return Object.fromEntries([...Object.entries(schema), ["description", short(about, n)]])
}

const inputSchema = (t: TypeRef, types: ReadonlyMap<string, GqlType>, depth = 0): Node => {
  if (t.kind === "NON_NULL" && t.ofType) return inputSchema(t.ofType, types, depth)

  if (t.kind === "LIST" && t.ofType)
    return { type: "array", items: inputSchema(t.ofType, types, depth) }

  const type = t.name === null ? undefined : types.get(t.name)

  if (type?.kind === "ENUM")
    return { type: "string", enum: (type.enumValues ?? []).map((v) => v.name) }

  if (type?.kind === "INPUT_OBJECT" && depth < 3)
    return {
      type: "object",
      properties: Object.fromEntries(
        (type.inputFields ?? []).map((f) => [
          f.name,
          described(inputSchema(f.type, types, depth + 1), f.description, 200),
        ]),
      ),
    }

  const scalar = Object.entries(SCALARS).find(([name]) => name === t.name)?.[1]

  return { type: scalar ?? "string", description: t.name ?? "" }
}

const SELECT_MAX = 40

const selectionOf = (t: TypeRef, types: ReadonlyMap<string, GqlType>, depth = 0): string => {
  const type = named(t).name === null ? undefined : types.get(named(t).name ?? "")

  if (type === undefined || (type.kind !== "OBJECT" && type.kind !== "INTERFACE")) return ""

  const fields = (type.fields ?? []).filter(
    (f) => !(f.args ?? []).some((a) => a.type.kind === "NON_NULL"),
  )

  const parts: Array<string> = []

  for (const f of fields) {
    if (parts.length >= SELECT_MAX) break

    const inner = types.get(named(f.type).name ?? "")

    if (inner === undefined || inner.kind === "SCALAR" || inner.kind === "ENUM") parts.push(f.name)
    else if (depth < 1 && (inner.kind === "OBJECT" || inner.kind === "INTERFACE")) {
      const sub = selectionOf(f.type, types, depth + 1)

      if (sub !== "") parts.push(`${f.name} ${sub}`)
    }
  }

  return parts.length === 0 ? "{ __typename }" : `{ ${parts.join(" ")} }`
}

const readGraphql = Effect.fnUntraced(function* (
  answer: string,
  endpoint: string,
  rootArgs: (root: string) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<GqlArg>>, Refused>,
) {
  const got = decodeIntrospected(answer)

  if (Option.isNone(got))
    return yield* new Refused({
      message: `${endpoint} didn't answer GraphQL introspection with a schema (${answer.replace(/\s+/g, " ").slice(0, 200)}): is it a GraphQL endpoint, with introspection on?`,
    })

  // oxlint-disable-next-line no-underscore-dangle -- GraphQL's own name for it
  const schema = got.value.data.__schema
  const types = new Map(schema.types.map((t) => [t.name, t]))
  const tools: Array<ApiTool> = []
  const taken = new Set<string>()

  for (const [operation, root] of [
    ["query", schema.queryType?.name],
    ["mutation", schema.mutationType?.name],
  ] as const) {
    if (root === undefined) continue

    const full = yield* rootArgs(root)

    for (const field of types.get(root)?.fields ?? []) {
      const name = taken.has(field.name) ? `${operation}_${field.name}` : field.name

      taken.add(name)

      const args = full.get(field.name) ?? []
      const select = selectionOf(field.type, types)

      const properties: Record<string, Json> = {}

      for (const a of args)
        properties[a.name] = described(inputSchema(a.type, types), a.description, 300)

      if (select !== "")
        properties["select"] = {
          type: "string",
          description: `The fields to return, as a GraphQL selection set; left out: ${select.slice(0, 600)}`,
        }

      const readOnly = operation === "query"

      tools.push({
        name,
        description: `${field.description ? short(field.description, 200) : `The ${operation} field ${field.name}`} (GraphQL ${operation} ${field.name}: ${written(field.type)})${field.description && field.description.length > 200 ? `\n${field.description.slice(0, 1500)}` : ""}`,
        inputSchema: {
          type: "object",
          properties,
          required: args.filter((a) => a.type.kind === "NON_NULL").map((a) => a.name),
          additionalProperties: false,
        },
        annotations: { readOnlyHint: readOnly, tags: [operation] },
        readOnly,
        tags: [operation],
        binding: {
          kind: "graphql",
          operation,
          field: field.name,
          args: args.map((a) => ({ name: a.name, type: written(a.type) })),
          select,
        },
      })
    }
  }

  const read: Read = { tools, base: endpoint, auth: undefined, title: endpoint }

  return read
})

const withKey = (at: Node, k: string, v: Json): Json =>
  Object.fromEntries([...Object.entries(at).filter(([kk]) => kk !== k), [k, v]])

const requiring = (schema: Json, path: ReadonlyArray<string>): Json => {
  const [key, ...rest] = path

  if (key === undefined || !isNode(schema)) return schema

  const properties = node(schema["properties"])
  const required = list(schema["required"]).flatMap((r) => (Predicate.isString(r) ? [r] : []))

  return rest.length === 0
    ? withKey(schema, "required", required.includes(key) ? required : [...required, key])
    : withKey(
        schema,
        "properties",
        withKey(properties, key, requiring(properties[key] ?? {}, rest)),
      )
}

const fixed = (tool: ApiTool, fix: Fix): ApiTool | undefined => {
  if ("hide" in fix) return undefined

  if ("rename" in fix) return { ...tool, name: fix.rename }

  if ("readOnly" in fix)
    return {
      ...tool,
      readOnly: fix.readOnly,
      annotations: Object.fromEntries([
        ...Object.entries(node(tool.annotations)).filter(([k]) => k !== "readOnlyHint"),
        ["readOnlyHint", fix.readOnly],
      ]),
    }

  const top = fix.require.filter((r) => !r.includes("."))

  return {
    ...tool,
    inputSchema: fix.require.reduce(
      (schema, r) => requiring(schema, r.split(".")),
      tool.inputSchema,
    ),
    binding:
      tool.binding.kind === "http"
        ? {
            ...tool.binding,
            required: [...new Set([...tool.binding.required, ...top])],
          }
        : tool.binding,
  }
}

export const applyFixes = (tools: ReadonlyArray<ApiTool>, fixes: ReadonlyArray<Fix>) => {
  let out = [...tools]
  const unused: Array<Fix> = []

  for (const fix of fixes) {
    if (!out.some((t) => t.name === fix.tool)) {
      unused.push(fix)
      continue
    }

    out = out.flatMap((t) => {
      if (t.name !== fix.tool) return [t]

      const after = fixed(t, fix)

      return after === undefined ? [] : [after]
    })
  }

  return { tools: out, unused }
}

const withToken = (url: URL, headers: Headers, auth: ApiAuth, token: string | undefined) => {
  if (token === undefined) return

  if (auth.in === "query") url.searchParams.set(auth.name, token)
  else
    headers.set(
      auth.name,
      `${auth.prefix}${auth.prefix === "Basic " && token.includes(":") ? btoa(token) : token}`,
    )
}

export const BEARER: ApiAuth = { in: "header", name: "authorization", prefix: "Bearer " }

export const readSource = Effect.fn("apis.read")(function* (
  connection: string,
  kind: "openapi" | "graphql",
  spec: string | null,
  endpoint: string,
  auth: ApiAuth,
  token: string | undefined,
  reach: Reach,
  tags: ReadonlyArray<string> | null,
  fixes: ReadonlyArray<Fix> = [],
) {
  const read = yield* readPicked(connection, kind, spec, endpoint, auth, token, reach, tags)
  const done: Read = { ...read, tools: applyFixes(read.tools, fixes).tools }

  return done
})

const readPicked = Effect.fnUntraced(function* (
  connection: string,
  kind: "openapi" | "graphql",
  spec: string | null,
  endpoint: string,
  auth: ApiAuth,
  token: string | undefined,
  reach: Reach,
  tags: ReadonlyArray<string> | null,
) {
  if (kind === "graphql") {
    const url = new URL(endpoint)
    const headers = new Headers({ "content-type": "application/json", accept: "application/json" })

    withToken(url, headers, auth, token)

    const ask = (body: Json) =>
      fetchText(
        url.href,
        reach,
        { method: "POST", headers, body: JSON.stringify(body) },
        "the GraphQL schema",
      ).pipe(Effect.map((t) => redact(t, token)))

    const answer = yield* ask({ query: INTROSPECTION })

    const read = yield* readGraphql(answer, endpoint, (root) =>
      Effect.flatMap(ask({ query: ROOT_ARGS, variables: { name: root } }), (said) =>
        Option.match(decodeRootArgs(said), {
          onNone: () =>
            Effect.fail(
              new Refused({
                message: `${endpoint} didn't answer for ${root}'s fields' arguments (${said.replace(/\s+/g, " ").slice(0, 200)})`,
              }),
            ),
          onSome: (r) =>
            // oxlint-disable-next-line no-underscore-dangle -- GraphQL's own name for it
            Effect.succeed(new Map(r.data.__type.fields.map((f) => [f.name, f.args]))),
        }),
      ),
    )

    const picked: Read = { ...read, tools: yield* pick(connection, read.tools, tags) }

    return picked
  }

  if (spec === null)
    return yield* new Refused({
      message: `${connection} has no spec URL: add it again with spec, the OpenAPI spec's URL`,
    })

  return yield* readOpenApi(
    yield* fetchText(
      spec,
      reach,
      { method: "GET", headers: { accept: "application/json, application/yaml, */*" } },
      "the spec",
    ),
    spec,
    connection,
    tags,
  )
})

export const tagCounts = (tools: ReadonlyArray<{ readonly tags: ReadonlyArray<string> }>) => {
  const counts = new Map<string, number>()

  for (const t of tools)
    for (const tag of t.tags.length === 0 ? ["(untagged)"] : t.tags)
      counts.set(tag, (counts.get(tag) ?? 0) + 1)

  return [...counts].toSorted((a, b) => b[1] - a[1])
}

const pick = <T extends { readonly tags: ReadonlyArray<string> }>(
  connection: string,
  tools: ReadonlyArray<T>,
  tags: ReadonlyArray<string> | null,
): Effect.Effect<ReadonlyArray<T>, Refused> => {
  const counts = tagCounts(tools)

  const shown = counts
    .slice(0, 40)
    .map(([tag, n]) => `${tag} (${n})`)
    .join(", ")

  if (tags === null) {
    if (tools.length <= MAX_UNPICKED) return Effect.succeed(tools)

    return Effect.fail(
      new Refused({
        message: `${connection}'s spec has ${tools.length} operations, past the ${MAX_UNPICKED} a workspace takes without picking: pick the tags it needs with tags (bun run workspace connections add ... --tags repos,users), or tags ["*"] for every one. Its tags: ${shown}${counts.length > 40 ? ", ..." : ""}`,
      }),
    )
  }

  if (tags.includes("*")) return Effect.succeed(tools)

  const unknown = tags.filter((t) => !counts.some(([tag]) => tag === t))

  if (unknown.length > 0)
    return Effect.fail(
      new Refused({
        message: `${connection}'s spec has no tag ${unknown.map((t) => `"${t}"`).join(", ")}: its tags are ${shown}`,
      }),
    )

  return Effect.succeed(
    tools.filter(
      (t) =>
        t.tags.some((tag) => tags.includes(tag)) ||
        (t.tags.length === 0 && tags.includes("(untagged)")),
    ),
  )
}

export const baseProblem = (base: string | undefined, reach: Reach) =>
  base === undefined
    ? "the spec names no server (servers, or host and basePath): send the API's base URL as url"
    : urlProblem(base, reach, "connection")

const queryValues = (value: Json): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap(queryValues)
    : isNode(value)
      ? [JSON.stringify(value)]
      : [Predicate.isString(value) ? value : JSON.stringify(value)]

const result = (said: string, isError: boolean): ToolResult => ({
  content: [{ type: "text", text: said }],
  isError,
})

const cut = (body: string) =>
  body.length <= MAX_BODY_CHARS
    ? body
    : `${body.slice(0, MAX_BODY_CHARS)}\n... (OpenBelt cut this: the answer was ${body.length} characters; ask for less, a page at a time)`

const REDIRECTS = 3

const closes = (c: string) => ({ "}": "{", ")": "(", "]": "[" })[c]

const selectProblem = (select: string) => {
  const open: Array<string> = []
  let i = 0

  while (i < select.length) {
    const c = select[i] ?? ""

    if (c === "#") {
      while (i < select.length && select[i] !== "\n") i++
    } else if (select.startsWith('"""', i)) {
      const end = select.indexOf('"""', i + 3)

      if (end === -1) return "a block string that never ends"

      i = end + 3
      continue
    } else if (c === '"') {
      i++

      while (i < select.length && select[i] !== '"') {
        if (select[i] === "\n") return "a string that never ends"

        i += select[i] === "\\" ? 2 : 1
      }

      if (i >= select.length) return "a string that never ends"
    } else if (c === "{" || c === "(" || c === "[") open.push(c)
    else if (c === "}" || c === ")" || c === "]") {
      if (open.pop() !== closes(c)) return `a "${c}" that closes nothing it opened`
    }

    i++
  }

  return open.length === 0 ? undefined : `a "${open.at(-1) ?? ""}" it never closes`
}

const selectionOfAsked = (select: string) => {
  const trimmed = select.trim()

  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1).trim() : trimmed
}

export const inputProblem = (connection: string, tool: string, binding: Binding, input: Json) => {
  const given = isNode(input) ? input : {}

  const known =
    binding.kind === "http"
      ? [...binding.params.map((p) => p.key), ...(binding.body === null ? [] : ["body"])]
      : [...binding.args.map((a) => a.name), ...(binding.select === "" ? [] : ["select"])]

  const extra = Object.keys(given).filter((k) => !known.includes(k))
  const schema = `connections({ connection: "${connection}", search: "${tool}" }) has its input schema`

  if (extra.length > 0)
    return `${connection}.${tool} takes ${known.length === 0 ? "no input" : known.join(", ")}, not ${extra.join(", ")}${binding.kind === "http" && binding.body !== null ? " (the request body goes in body)" : ""}: ${schema}`

  const needed =
    binding.kind === "http"
      ? binding.required
      : binding.args.filter((a) => a.type.endsWith("!")).map((a) => a.name)

  const missing = needed.filter((k) => given[k] === undefined || given[k] === null)

  if (missing.length > 0) return `${connection}.${tool} needs ${missing.join(", ")}: ${schema}`

  const select = text(given["select"])
  const problem = select === undefined ? undefined : selectProblem(selectionOfAsked(select))

  if (problem !== undefined)
    return `${connection}.${tool}'s select has ${problem}: send the fields to select, like "name capital languages { name }"`

  return undefined
}

/** The token a call sends; a sign-in's can be refreshed, and says which scope is missing. */
type ApiCredential<R> =
  | { readonly kind: "unsigned"; readonly token: string | undefined }
  | {
      readonly kind: "signed_in"
      readonly token: string
      readonly renew: Effect.Effect<string, Refused, R>
      readonly turnedDown: Effect.Effect<void, never, R>
      readonly missingScope: (scope: string) => Refused
    }

export const callApi = Effect.fn("apis.call")(function* <R = never>(
  connection: string,
  tool: string,
  base: string,
  auth: ApiAuth,
  binding: Binding,
  input: Json,
  credential: ApiCredential<R> | undefined,
  reach: Reach,
) {
  const given = isNode(input) ? input : {}

  const headers = new Headers({
    accept: "application/json",
    "user-agent": "OpenBelt-Connections/1",
    ...(yield* correlation),
  })

  let url: URL
  let init: CallInit

  if (binding.kind === "http") {
    const path = binding.path.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const p = binding.params.find((q) => q.in === "path" && q.name === name)
      const v = p === undefined ? undefined : given[p.key]

      return v === undefined ? whole : encodeURIComponent(queryValues(v).join(","))
    })

    url = new URL(`${base.replace(/\/+$/, "")}${path}`)

    for (const p of binding.params) {
      const v = given[p.key]

      if (v === undefined || v === null || p.in === "path") continue

      if (p.in === "query") for (const each of queryValues(v)) url.searchParams.append(p.name, each)
      else headers.set(p.name, queryValues(v).join(","))
    }

    const body = given["body"]

    init = { method: binding.method }

    if (body !== undefined && binding.body !== null) {
      if (binding.body === "json") {
        headers.set("content-type", "application/json")
        init.body = JSON.stringify(body)
      } else if (binding.body === "form") {
        const form = new URLSearchParams()

        for (const [k, v] of Object.entries(node(body)))
          for (const each of queryValues(v)) form.append(k, each)

        headers.set("content-type", "application/x-www-form-urlencoded")
        init.body = form.toString()
      } else init.body = Predicate.isString(body) ? body : JSON.stringify(body)
    }
  } else {
    const used = binding.args.filter((a) => given[a.name] !== undefined)
    const vars = used.map((a) => `$${a.name}: ${a.type}`).join(", ")
    const passed = used.map((a) => `${a.name}: $${a.name}`).join(", ")
    const asked = selectionOfAsked(text(given["select"]) ?? "")
    const select = asked === "" ? selectionOfAsked(binding.select) : asked
    const braced = select === "" ? "" : `{\n${select}\n}`

    url = new URL(base)
    headers.set("content-type", "application/json")
    init = {
      method: "POST",
      body: JSON.stringify({
        query: `${binding.operation} OpenBelt${vars === "" ? "" : `(${vars})`} {\n${binding.field}${passed === "" ? "" : `(${passed})`} ${braced}\n}`,
        operationName: "OpenBelt",
        variables: Object.fromEntries(used.map((a) => [a.name, given[a.name]])),
      }),
    }
  }

  const first = url

  const send = Effect.fnUntraced(function* (token: string | undefined) {
    let at = new URL(first)
    const sent = new Headers(headers)

    withToken(at, sent, auth, token)

    for (let hop = 0; ; hop++) {
      const problem = urlProblem(at.href, reach, "connection") ?? (yield* lookedUp(at.href))

      if (problem !== undefined) return yield* new Refused({ message: `${connection}: ${problem}` })

      const target = at

      const answer = yield* exchange(
        { kind: "api", url: target.href, ...init, headers: sent, timeoutMs: CALL_MS },
        (got) =>
          Effect.map(textUpTo(got, MAX_ANSWER_BYTES), (body) => ({
            status: got.status,
            body,
            location: got.headers.get("location"),
            retryAfter: got.headers.get("retry-after"),
            challenge: got.headers.get("www-authenticate"),
          })),
      ).pipe(
        Effect.catchTag("OutboundFailed", (failed) =>
          Effect.fail(
            new Refused({
              message:
                failed.reason === "timeout"
                  ? `${connection} didn't answer ${tool} within ${CALL_MS / 1000}s: it may be busy or down; try again later`
                  : `couldn't reach ${connection} at ${target.origin}: it couldn't connect, or the connection broke. If it's down, try again later.`,
            }),
          ),
        ),
      )

      const moved =
        answer.location === null
          ? undefined
          : URL.canParse(answer.location, at.href)
            ? new URL(answer.location, at)
            : undefined

      if (answer.status < 300 || answer.status >= 400 || hop >= REDIRECTS) {
        yield* Effect.logInfo(
          `${connection}.${tool}: ${init.method ?? "GET"} ${at.origin}${at.pathname}${[...at.searchParams.keys()].length === 0 ? "" : `?${[...new Set(at.searchParams.keys())].join("&")}`} answered ${answer.status} (${answer.body === undefined ? `past ${MAX_ANSWER_BYTES} bytes, not read` : `${answer.body.length} bytes`})`,
        )

        return { ...answer, path: at.pathname }
      }

      if (moved === undefined || moved.origin !== at.origin)
        return yield* new Refused({
          message: `${connection} answered ${tool} with a redirect to ${answer.location ?? "nowhere"} (HTTP ${answer.status}), another host, which OpenBelt doesn't follow: an admin sets the API's base URL to it`,
        })

      at = moved
    }
  })

  let token = credential?.token
  let answer = yield* send(token)

  // A sign-in's token can end before OpenBelt knows (revoked, or the clock): it's refreshed once,
  // and a second 401 means the person connects again.
  if (answer.status === 401 && credential?.kind === "signed_in") {
    yield* Effect.logInfo(`${connection}: it answered 401, so the sign-in is refreshed`)
    token = yield* credential.renew
    answer = yield* send(token)

    if (answer.status === 401) yield* credential.turnedDown
  }

  if (answer.body === undefined)
    return yield* new Refused({
      message: `${connection} answered ${tool} with more than ${MAX_ANSWER_BYTES / 1_000_000} MB, which OpenBelt doesn't read: ask for less (a page size, a narrower query)`,
    })

  const said = redact(redact(answer.body, credential?.token), token)
  const challenge = bearerChallenge(answer.challenge)

  if (
    answer.status === 403 &&
    challenge.error === "insufficient_scope" &&
    challenge.scope !== undefined &&
    credential?.kind === "signed_in"
  )
    return yield* credential.missingScope(challenge.scope)

  if (answer.status === 401)
    return yield* new Refused({
      message: `${connection} refused OpenBelt (HTTP 401) on ${tool}: ${token === undefined ? "it wants a token, and this call had none: set the connection's token (bun run workspace connections token, or Settings, Connections)" : credential?.kind === "signed_in" ? "it didn't accept the sign-in, even refreshed: connect again (the connection's page, or bun run workspace connections connect)" : "it didn't accept the token (it may be wrong or expired): set it again"}. It said: ${said.replace(/\s+/g, " ").slice(0, 300)}`,
    })

  if (answer.status === 429)
    return yield* new Refused({
      message: `${connection} is limiting how often it's called (HTTP 429): nothing changed; try again ${answer.retryAfter === null ? "in a minute" : `after ${answer.retryAfter.slice(0, 40)}`}`,
    })

  if (binding.kind === "graphql") {
    // GraphQL answers 200 with errors: the field's data, or the errors as the tool's failure.
    const parsed = Option.getOrUndefined(
      Schema.decodeUnknownOption(
        Schema.fromJsonString(
          Schema.Struct({
            data: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
            errors: Schema.optionalKey(Schema.Array(Schema.Json)),
          }),
        ),
      )(said),
    )

    if (parsed === undefined)
      return result(`HTTP ${answer.status} from ${connection}, not GraphQL: ${cut(said)}`, true)

    const data = parsed.data?.[binding.field]

    if (parsed.errors !== undefined && parsed.errors.length > 0)
      return result(
        `${connection} answered with errors: ${cut(JSON.stringify(parsed.errors))}${data === undefined || data === null ? "" : `\ndata: ${cut(JSON.stringify(data))}`}`,
        true,
      )

    return result(cut(JSON.stringify(data ?? null)), answer.status >= 400)
  }

  if (answer.status >= 200 && answer.status < 300)
    return result(said === "" ? `(HTTP ${answer.status}, no body)` : cut(said), false)

  return result(
    `HTTP ${answer.status} from ${binding.method} ${answer.path}: ${cut(said).slice(0, 4000)}`,
    true,
  )
})
