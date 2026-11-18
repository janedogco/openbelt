import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Group, Json, Person } from "./model.ts"

const SCHEMA = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  patch: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  config: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
} as const

/** A SCIM error body (RFC 7644 3.12): `scimType` names the kind when the RFC has one. */
export const scimError = (
  status: number,
  detail: string,
  scimType:
    | "invalidFilter"
    | "uniqueness"
    | "mutability"
    | "invalidValue"
    | "invalidSyntax"
    | null = null,
) => ({
  status,
  body: (scimType === null
    ? { schemas: [SCHEMA.error], status: String(status), detail }
    : { schemas: [SCHEMA.error], status: String(status), scimType, detail }) satisfies Readonly<
    Record<string, Json>
  >,
})

export const parseFilter = (text: string) => {
  const match = /^\s*([A-Za-z][A-Za-z.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(text)

  return match === null
    ? Option.none()
    : Option.some({
        attribute: (match[1] ?? "").toLowerCase(),
        value: (match[2] ?? "").replaceAll(/\\(.)/g, "$1"),
      })
}

export const slug = (displayName: string) =>
  displayName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replaceAll(/^-+|-+$/g, "")

const asObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

const List = Schema.decodeUnknownOption(Schema.Array(Schema.Json))

const Text = Schema.decodeUnknownOption(Schema.String)

export const PatchRequest = Schema.Struct({
  Operations: Schema.Array(
    Schema.Struct({
      op: Schema.String,
      path: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.Json),
    }),
  ),
})

type Operation = (typeof PatchRequest.Type)["Operations"][number]

const Truth = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Boolean,
    Schema.Literals(["true", "True", "TRUE", "false", "False", "FALSE"]),
  ]),
)

const truth = (value: Json | undefined) =>
  Option.map(Truth(value), (v) => v === true || v === "true" || v === "True" || v === "TRUE")

export type UserFields = {
  readonly active?: boolean
  readonly name?: string
  readonly userName?: string
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

type Problem = { readonly problem: string }

/** What the body of a POST or PUT /Users says (RFC 7643 4.1), whatever of it OpenBelt keeps. */
export const userFields = (body: Json): UserFields | Problem => {
  const object = Option.getOrUndefined(asObject(body))

  if (object === undefined) return { problem: "send a JSON object like the User resource" }

  const fields: Writable<UserFields> = {}
  const userName = Option.getOrUndefined(Text(object["userName"]))
  const active = truth(object["active"])

  if (userName !== undefined) fields.userName = userName

  if (Option.isSome(active)) fields.active = active.value

  const name = Option.getOrUndefined(asObject(object["name"]))
  const formatted = Option.getOrUndefined(Text(name?.["formatted"]))
  const given = Option.getOrUndefined(Text(name?.["givenName"]))
  const family = Option.getOrUndefined(Text(name?.["familyName"]))
  const display = Option.getOrUndefined(Text(object["displayName"]))
  const parts = [given, family].filter((p): p is string => p !== undefined && p !== "")
  const best = formatted ?? (parts.length > 0 ? parts.join(" ") : display)

  if (best !== undefined && best.trim() !== "") fields.name = best.trim().slice(0, 100)

  return fields
}

export const userPatch = (operations: ReadonlyArray<Operation>): UserFields | Problem => {
  const merged: Writable<UserFields> = {}

  for (const operation of operations) {
    const op = operation.op.toLowerCase()

    if (op !== "replace" && op !== "add")
      return {
        problem: `a user's ${op} isn't supported: send replace with active, name, or displayName (to remove someone, set active to false)`,
      }

    const key = (operation.path ?? "").toLowerCase()

    const value = operation.value ?? null

    const set: Json | undefined =
      key === ""
        ? value
        : key === "active"
          ? { active: value }
          : key === "username"
            ? { userName: value }
            : key === "displayname"
              ? { displayName: value }
              : key.startsWith("name.")
                ? { name: { [operation.path?.slice(5) ?? ""]: value } }
                : undefined

    if (set === undefined) continue

    const fields = userFields(set)

    if ("problem" in fields) return fields

    Object.assign(merged, fields)
  }

  return merged
}

export type GroupChange =
  | { readonly kind: "add"; readonly ids: ReadonlyArray<string> }
  | { readonly kind: "remove"; readonly ids: ReadonlyArray<string> | "all" }
  | { readonly kind: "set"; readonly ids: ReadonlyArray<string> }
  | { readonly kind: "name"; readonly displayName: string }

const memberIds = (value: Json | undefined): ReadonlyArray<string> | Problem => {
  if (value === undefined) return []

  const items = Option.getOrUndefined(List(value)) ?? [value]
  const ids: string[] = []

  for (const item of items) {
    const id = Option.getOrUndefined(Text(Option.getOrUndefined(asObject(item))?.["value"]))

    if (id === undefined)
      return { problem: 'members is a list of {"value": "<person id>"}: send each member that way' }

    ids.push(id)
  }

  return ids
}

export const groupBody = (body: Json): ReadonlyArray<GroupChange> | Problem => {
  const object = Option.getOrUndefined(asObject(body))

  if (object === undefined) return { problem: "send a JSON object like the Group resource" }

  const displayName = Option.getOrUndefined(Text(object["displayName"]))
  const ids = memberIds(object["members"])

  if ("problem" in ids) return ids

  return [
    ...(displayName === undefined ? [] : [{ kind: "name", displayName } as const]),
    { kind: "set", ids },
  ]
}

export const groupPatch = (
  operations: ReadonlyArray<Operation>,
): ReadonlyArray<GroupChange> | Problem => {
  const changes: GroupChange[] = []

  for (const operation of operations) {
    const op = operation.op.toLowerCase()
    const path = operation.path ?? ""
    const one = /^members\[value eq "([^"]+)"\]$/i.exec(path)

    if (one !== null && op === "remove") {
      changes.push({ kind: "remove", ids: [one[1] ?? ""] })
      continue
    }

    if (path.toLowerCase() === "members") {
      if (op !== "add" && op !== "remove" && op !== "replace")
        return { problem: `a group's ${op} of members isn't supported: add, remove or replace` }

      if (op === "remove" && operation.value === undefined) {
        changes.push({ kind: "remove", ids: "all" })
        continue
      }

      if (operation.value === undefined)
        return { problem: `a ${op} of members needs a value: [{"value": "<person id>"}]` }

      const ids = memberIds(operation.value)

      if ("problem" in ids) return ids

      changes.push({ kind: op === "replace" ? "set" : op, ids })
      continue
    }

    if (path.toLowerCase() === "displayname" && op === "replace") {
      const displayName = Option.getOrUndefined(Text(operation.value))

      if (displayName === undefined) return { problem: "displayName is a string" }

      changes.push({ kind: "name", displayName })
      continue
    }

    if (path === "" && (op === "replace" || op === "add")) {
      const object = Option.getOrUndefined(asObject(operation.value ?? null))
      const displayName = Option.getOrUndefined(Text(object?.["displayName"]))

      if (displayName !== undefined) changes.push({ kind: "name", displayName })

      if (object?.["members"] !== undefined) {
        const ids = memberIds(object["members"])

        if ("problem" in ids) return ids

        changes.push({ kind: op === "add" ? "add" : "set", ids })
      }

      continue
    }

    if (path !== "" && /^(externalid|id|meta)/i.test(path)) continue

    return {
      problem: `a group's ${op} of "${path}" isn't supported: OpenBelt keeps a group's displayName and members`,
    }
  }

  return changes
}

const meta = (type: "User" | "Group", base: string, id: string, created: string) => ({
  resourceType: type,
  created,
  lastModified: created,
  location: `${base}/${type}s/${id}`,
})

export const userResource = (person: Person, base: string) =>
  ({
    schemas: [SCHEMA.user],
    id: person.id,
    userName: person.email,
    name: { formatted: person.name },
    displayName: person.name,
    emails: [{ value: person.email, type: "work", primary: true }],
    active: person.status !== "removed",
    meta: meta("User", base, person.id, person.created),
  }) satisfies Readonly<Record<string, Json>>

export const groupResource = (group: Group, created: string, base: string) =>
  ({
    schemas: [SCHEMA.group],
    id: group.name,
    displayName: group.name,
    externalId: group.source === "scim" ? group.externalId : null,
    members: group.members.map((m) => ({
      value: m.id,
      display: m.email,
      $ref: `${base}/Users/${m.id}`,
    })),
    meta: meta("Group", base, group.name, created),
  }) satisfies Readonly<Record<string, Json>>

export const listResponse = (
  resources: ReadonlyArray<Json>,
  total: number,
  startIndex: number,
) => ({
  schemas: [SCHEMA.list],
  totalResults: total,
  startIndex,
  itemsPerPage: resources.length,
  Resources: [...resources],
})

/** What this server supports (RFC 7643 5), so a client that asks (Okta's test, Entra's) is told. */
export const serviceProviderConfig = (base: string) => ({
  schemas: [SCHEMA.config],
  documentationUri: "https://github.com/janedogco/openbelt/blob/main/docs/people.md",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "Bearer token",
      description: "A SCIM token from OpenBelt's Settings (People), sent as Authorization: Bearer",
      primary: true,
    },
  ],
  meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
})

export const resourceTypes = (base: string) => [
  {
    schemas: [SCHEMA.resourceType],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: SCHEMA.user,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
  },
  {
    schemas: [SCHEMA.resourceType],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: SCHEMA.group,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` },
  },
]

const parseWithoutPasswords = Option.liftThrowable((text: string) =>
  JSON.stringify(
    JSON.parse(text, (key, value: Json) => (key.toLowerCase() === "password" ? "…" : value)),
  ),
)

export const loggable = (text: string) =>
  Option.getOrElse(
    parseWithoutPasswords(text),
    () => `(not JSON, ${text.length} characters)`,
  ).slice(0, 1000)
