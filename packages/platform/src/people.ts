import type { SqlValue } from "./runtime/index.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  AgentApps,
  type ApiToken,
  decodeAgentApps,
  Email,
  emailOf,
  type ErrorCode,
  type Group,
  groupNameProblem,
  type Joining,
  Joining as JoiningSchema,
  type Json,
  LIMITED_CANT_MANAGE,
  narrowApps,
  type Person,
  PersonId,
  Refused,
  type Role,
  Role as RoleSchema,
  type WorkspaceName,
  type Viewer,
  type WhoAmI,
} from "./model.ts"

import {
  groupBody,
  type GroupChange,
  groupPatch,
  groupResource,
  loggable,
  listResponse,
  parseFilter,
  PatchRequest,
  resourceTypes,
  scimError,
  serviceProviderConfig,
  slug,
  userFields,
  userPatch,
  userResource,
  type UserFields,
} from "./scim.ts"

const hashToken = (token: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
    Effect.map((digest) => new Uint8Array(digest).toHex()),
  )

/** The /_workspace routes that let someone into the workspace. */
const LETS_IN = new Set([
  "POST workspace/people/invite",
  "POST workspace/joining",
  "POST workspace/scim/token",
])

const hex = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes)).toHex()

const decodePersonId = Schema.decodeUnknownSync(PersonId)

const decodeRole = Schema.decodeUnknownSync(RoleSchema)

const decodeJoining = Schema.decodeUnknownSync(JoiningSchema)

/** The apps a workspace lets frame its other apps (a builder showing what it builds): at most a few, by name. */
const EmbedSchema = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/)),
).check(Schema.isMaxLength(10))

const decodeEmbed = Schema.decodeUnknownOption(Schema.fromJsonString(EmbedSchema))

const newPersonId = () => decodePersonId(`p_${hex(8)}`)

export type Member = {
  readonly id: PersonId
  readonly email: string
  readonly name: string
  readonly role: Role
  readonly groups: ReadonlyArray<string>
}

export type Admission =
  | { readonly kind: "member"; readonly person: Member }
  | { readonly kind: "anonymous" }
  | { readonly kind: "not_invited"; readonly email: string; readonly admins: ReadonlyArray<string> }
  | {
      readonly kind: "removed"
      readonly email: string
      readonly removed: string
      readonly by: string
      readonly admins: ReadonlyArray<string>
    }
  | { readonly kind: "signed_out"; readonly admins: ReadonlyArray<string> }
  /** A trial nobody has claimed (trials.ts): no person gets in, only check_app's sealed sessions (the gateway lets those by). */
  | { readonly kind: "trial" }

export type TokenCheck =
  /**
   * client: the OAuth client the token was given to, by the name its metadata document or registration gave; null for an API token.
   * credential: the API token's or sign-in's id. apps: the apps it may use (null: every app).
   */
  | {
      readonly kind: "valid"
      readonly person: Member
      readonly client: string | null
      readonly credential: string
      readonly apps: AgentApps
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "expired"; readonly expired: string }
  | { readonly kind: "access_expired"; readonly expired: string }
  | { readonly kind: "revoked"; readonly revoked: string; readonly why: string }

const askAdmins = (admins: ReadonlyArray<string>, what: string) =>
  admins.length === 0
    ? `It has no admins yet: whoever runs this OpenBelt names one (POST /_admin/workspace-admins), who can ${what}.`
    : `Ask ${admins.join(" or ")} to ${what}.`

export const refusalOf = (workspace: string, admission: Admission) => {
  if (admission.kind === "member" || admission.kind === "anonymous") return undefined

  if (admission.kind === "trial")
    return `${workspace} is a trial until someone claims it: the agent that made it has the claim link, for the person it works for. Until then its apps open only in the agent's check_app.`

  if (admission.kind === "not_invited")
    return `${admission.email} isn't a member of ${workspace}, which is invite-only. ${askAdmins(admission.admins, "invite you")}`

  if (admission.kind === "removed")
    return `${admission.email} was removed from ${workspace} by ${admission.by} on ${admission.removed.slice(0, 10)}. ${askAdmins(admission.admins, "invite you again if that's a mistake")}`

  return `${workspace} is invite-only, and nobody signed you in here (the front door, Tailscale, didn't say who you are). Open it from a device signed in as a member. ${askAdmins(admission.admins, "invite you")}`
}

export const tokenRefusal = (workspace: string, check: TokenCheck) => {
  const another = `Ask whoever runs this OpenBelt for one (POST /_admin/tokens), or make another with a token of yours that works (bun run workspace tokens create).`

  if (check.kind === "valid") return undefined

  if (check.kind === "unknown")
    return `that isn't an API token of ${workspace}: tokens work only on the workspace that issued them. ${another}`

  if (check.kind === "expired")
    return `this token of ${workspace} expired on ${check.expired.slice(0, 10)}. ${another}`

  if (check.kind === "access_expired")
    return `this access token of ${workspace} expired at ${check.expired}: your MCP client gets a new one with its refresh token, or signs in again`

  return `this token of ${workspace} was revoked on ${check.revoked.slice(0, 10)}: ${check.why}.`
}

const legacyEmail = (user: string) =>
  emailOf(user) ??
  `${
    user
      .toLowerCase()
      .replaceAll(/[^a-z0-9._+-]/g, "-")
      .slice(0, 64) || "user"
  }@legacy.invalid`

const defaultName = (email: string) => email.split("@")[0] ?? email

type PersonRow = {
  id: string
  email: string
  name: string
  role: string
  created: string
  invited_by: string | null
  joined: string | null
  removed: string | null
  removed_by: string | null
  groups: string
}

const PEOPLE = `SELECT p.id, p.email, p.name, p.role, p.created, p.invited_by, p.joined, p.removed,
  p.removed_by, COALESCE((SELECT json_group_array(grp) FROM (SELECT grp FROM group_members
    WHERE person = p.id ORDER BY grp)), '[]') AS groups
  FROM people p`

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const toPerson = (row: PersonRow): Person => {
  const base = {
    id: decodePersonId(row.id),
    email: row.email,
    name: row.name,
    role: decodeRole(row.role),
    created: row.created,
    groups: decodeNames(row.groups),
  }

  if (row.removed !== null)
    return { ...base, status: "removed", removed: row.removed, removedBy: row.removed_by ?? "" }

  if (row.joined !== null) return { ...base, status: "active", joined: row.joined }

  return { ...base, status: "invited", invitedBy: row.invited_by ?? "" }
}

const toMember = (person: Person): Member => ({
  id: person.id,
  email: person.email,
  name: person.name,
  role: person.role,
  groups: person.groups,
})

type TokenRow = {
  id: string
  label: string
  created: string
  expires: string | null
  person: string
  email: string
  apps: string | null
}

const toToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  person: { id: decodePersonId(row.person), email: row.email },
  label: row.label,
  created: row.created,
  expires: row.expires,
  apps: decodeAgentApps(row.apps),
})

type ScimAnswer = {
  readonly status: number
  readonly body: Readonly<Record<string, Json>> | null
  readonly note: string
}

const answered = (
  answer: { readonly status: number; readonly body: Readonly<Record<string, Json>> | null },
  note: string,
): ScimAnswer => ({ ...answer, note })

const scimPage = (query: URLSearchParams) => {
  const start = Math.max(1, Number.parseInt(query.get("startIndex") ?? "1", 10) || 1)
  const count = Math.min(200, Math.max(0, Number.parseInt(query.get("count") ?? "100", 10) || 0))

  return { start, count }
}

type Answer = { readonly status: number; readonly body: Readonly<Record<string, Json>> }

const TokenRequest = Schema.Struct({
  days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
  apps: Schema.optionalKey(AgentApps),
})

const AppsRequest = Schema.Struct({ id: Schema.String, apps: AgentApps })

const Who = Schema.String.check(Schema.isMinLength(1))

export const openPeople = Effect.fn("People.open")(function* (
  storage: DurableObjectStorage,
  disconnect: (
    email: string,
    apps: ReadonlyArray<string>,
    why: string,
    kind: "removed" | "regrouped" | "signed_out",
  ) => Effect.Effect<number>,
  forget: (person: PersonId, by: string) => Effect.Effect<number>,
  forgetGroup: (group: string) => Effect.Effect<void>,
  /** Someone is in this workspace's people now (any status): the base host's index of who is in which workspace hears of it (workspace.ts). */
  listed: (email: string) => Effect.Effect<void>,
  /** Why nobody may be let in yet (an unclaimed trial, trials.ts), or undefined. */
  shut: () => string | undefined,
) {
  const { sql, kv } = storage

  const rows = <T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: Array<string | number | null>
  ) => Effect.flatMap(sql.exec<T>(query, ...bindings), (cursor) => cursor.toArray())

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')), created TEXT NOT NULL,
    invited_by TEXT, joined TEXT, removed TEXT, removed_by TEXT)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS groups (
    name TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('openbelt', 'scim')),
    external_id TEXT, created TEXT NOT NULL,
    CHECK ((source = 'openbelt') = (external_id IS NULL)))`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS group_members (
    grp TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY (grp, person))`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS scim_tokens (
    hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created TEXT NOT NULL,
    made_by TEXT NOT NULL, last_used TEXT, revoked TEXT)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS scim_log (
    n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
    status INTEGER NOT NULL, note TEXT NOT NULL, body TEXT NOT NULL, trace TEXT NOT NULL)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
    hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, person TEXT NOT NULL, label TEXT NOT NULL,
    created TEXT NOT NULL, expires TEXT, revoked TEXT, revoked_why TEXT)`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS api_tokens_person ON api_tokens (person)")

  if (
    !(yield* rows<{ name: string }>("PRAGMA table_info(api_tokens)")).some((c) => c.name === "apps")
  )
    yield* sql.exec("ALTER TABLE api_tokens ADD COLUMN apps TEXT")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS visits (
    person TEXT NOT NULL, app TEXT NOT NULL, PRIMARY KEY (person, app))`)
  yield* sql.exec("DROP TABLE IF EXISTS views")

  const seen = new Set<string>()

  const commit = <A, E>(effect: Effect.Effect<A, E>) => storage.transaction(effect)

  const byEmail = Effect.fnUntraced(function* (email: string) {
    const [row] = yield* rows<PersonRow>(`${PEOPLE} WHERE p.email = ?`, email)

    return row === undefined ? null : toPerson(row)
  })

  const byId = Effect.fnUntraced(function* (id: string) {
    const [row] = yield* rows<PersonRow>(`${PEOPLE} WHERE p.id = ?`, id)

    return row === undefined ? null : toPerson(row)
  })

  const add = Effect.fnUntraced(function* (
    email: string,
    fields: { name: string; role: Role; invitedBy: string | null; joined: string | null },
  ) {
    yield* sql.exec(
      `INSERT INTO people (id, email, name, role, created, invited_by, joined)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING`,
      newPersonId(),
      email,
      fields.name,
      fields.role,
      new Date().toISOString(),
      fields.invitedBy,
      fields.joined,
    )

    const person = yield* byEmail(email)

    if (person === null) return yield* Effect.die(`people: ${email} wasn't saved`)

    yield* listed(email)

    return person
  })

  const [legacy] = yield* rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tokens'",
  )

  if (legacy !== undefined && legacy.n > 0) {
    yield* commit(
      Effect.gen(function* () {
        const old = yield* rows<{
          hash: string
          user: string
          created: string
          expires: string | null
        }>("SELECT hash, user, created, expires FROM tokens")

        for (const token of old) {
          const email = legacyEmail(token.user)

          const person = yield* add(email, {
            name: defaultName(email),
            role: "member",
            invitedBy: null,
            joined: token.created,
          })

          yield* sql.exec(
            `INSERT INTO api_tokens (hash, id, person, label, created, expires)
             VALUES (?, ?, ?, 'made before people', ?, ?) ON CONFLICT (hash) DO NOTHING`,
            token.hash,
            `t_${hex(6)}`,
            person.id,
            token.created,
            token.expires,
          )
          yield* sql.exec(
            "UPDATE apps SET owner = ?, owner_person = ? WHERE owner = ?",
            person.email,
            person.id,
            token.user,
          )
        }

        yield* sql.exec("DROP TABLE tokens")
        yield* Effect.logInfo(`people: moved ${old.length} tokens from before people`)
      }),
    )
  }

  const joining = (): Joining => decodeJoining(kv.get<string>("joining") ?? "open")

  /** Apps this workspace lets frame its other apps (Settings has none by default: no app frames another). */
  const embedding = (): ReadonlyArray<string> =>
    Option.getOrElse(decodeEmbed(kv.get<string>("embed") ?? "[]"), () => [])

  const admins = Effect.fnUntraced(function* () {
    return (yield* rows<{ email: string }>(
      "SELECT email FROM people WHERE role = 'admin' AND removed IS NULL ORDER BY email LIMIT 5",
    )).map((r) => r.email)
  })

  const find = Effect.fnUntraced(function* (who: string) {
    const person = Schema.is(PersonId)(who) ? yield* byId(who) : yield* byEmail(emailOf(who) ?? who)

    if (person === null) {
      return yield* new Refused({
        message: `there's nobody "${who}" in this workspace: GET /_workspace/people (bun run workspace people list) shows who there is, and people/invite adds someone`,
      })
    }

    return person
  })

  const keepAnAdmin = Effect.fnUntraced(function* (person: Person, doing: string) {
    const [row] = yield* rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM people WHERE role = 'admin' AND removed IS NULL",
    )

    if (person.role === "admin" && person.status !== "removed" && (row?.n ?? 0) <= 1) {
      yield* new Refused({
        message: `${person.email} is the workspace's only admin, so they can't be ${doing}: make someone else an admin first (people/role with role "admin")`,
      })
    }
  })

  const groupMembers = Effect.fnUntraced(function* (name: string) {
    return yield* rows<{ id: string; email: string }>(
      `SELECT p.id, p.email FROM group_members m JOIN people p ON p.id = m.person
       WHERE m.grp = ? ORDER BY p.email`,
      name,
    )
  })

  const groupOf = Effect.fnUntraced(function* (name: string) {
    const [row] = yield* rows<{ name: string; source: string; external_id: string | null }>(
      "SELECT name, source, external_id FROM groups WHERE name = ?",
      name,
    )

    if (row === undefined) {
      const names = (yield* rows<{ name: string }>("SELECT name FROM groups ORDER BY name")).map(
        (r) => r.name,
      )

      return yield* new Refused({
        message: `there's no group "${name}"${names.length === 0 ? " (the workspace has none yet; groups/create makes one)" : `: the workspace has ${names.join(", ")}`}`,
      })
    }

    const members = (yield* groupMembers(row.name)).map((m) => ({
      id: decodePersonId(m.id),
      email: m.email,
    }))

    const group: Group =
      row.source === "scim" && row.external_id !== null
        ? { name: row.name, source: "scim", externalId: row.external_id, members }
        : { name: row.name, source: "openbelt", members }

    return group
  })

  const regrouped = Effect.fnUntraced(function* (ids: ReadonlyArray<PersonId>, why: string) {
    for (const id of ids) {
      const person = yield* find(id)

      const apps = (yield* rows<{ app: string }>(
        "SELECT app FROM visits WHERE person = ?",
        id,
      )).map((v) => v.app)

      yield* disconnect(person.email, apps, why, "regrouped")
    }
  })

  const openbelt = Effect.fnUntraced(function* (name: string) {
    const group = yield* groupOf(name)

    if (group.source !== "openbelt") {
      return yield* new Refused({
        message: `the group "${name}" is synced from your directory (SCIM), so change it there`,
      })
    }

    return group
  })

  const tokens = Effect.fnUntraced(function* (person: PersonId | undefined) {
    const query = `SELECT t.id, t.label, t.created, t.expires, t.person, p.email, t.apps FROM api_tokens t
      JOIN people p ON p.id = t.person WHERE t.revoked IS NULL`

    const found = yield* person === undefined
      ? rows<TokenRow>(`${query} ORDER BY p.email, t.created`)
      : rows<TokenRow>(`${query} AND t.person = ? ORDER BY t.created`, person)

    return found.map(toToken)
  })

  const mint = Effect.fnUntraced(function* (
    person: Person,
    days: number | undefined,
    label: string | undefined,
    apps: AgentApps,
  ) {
    if (person.status === "removed") {
      return yield* new Refused({
        message: `${person.email} was removed from the workspace on ${person.removed.slice(0, 10)}, so they can't have a token: invite them again first (people/invite)`,
      })
    }

    const token = `pr_${hex(24)}`
    const id = `t_${hex(6)}`
    const now = new Date()

    const expires =
      days === undefined ? null : new Date(now.getTime() + days * 86_400_000).toISOString()

    yield* sql.exec(
      "INSERT INTO api_tokens (hash, id, person, label, created, expires, apps) VALUES (?, ?, ?, ?, ?, ?, ?)",
      yield* hashToken(token),
      id,
      person.id,
      label ?? "",
      now.toISOString(),
      expires,
      apps === null ? null : JSON.stringify(apps),
    )

    return { token, id, expires, apps }
  })

  const setTokenApps = Effect.fnUntraced(function* (of: PersonId, id: string, apps: AgentApps) {
    const [row] = yield* rows<{ id: string }>(
      "SELECT id FROM api_tokens WHERE id = ? AND person = ? AND revoked IS NULL",
      id,
      of,
    )

    if (row === undefined)
      return yield* new Refused({
        message: `there's no token "${id}" of yours: token_list lists them`,
      })

    yield* sql.exec(
      "UPDATE api_tokens SET apps = ? WHERE id = ?",
      apps === null ? null : JSON.stringify(apps),
      id,
    )

    return apps
  })

  const revoke = Effect.fnUntraced(function* (id: string, why: string, of: PersonId | undefined) {
    const [row] = yield* rows<{ person: string }>(
      "SELECT person FROM api_tokens WHERE id = ? AND revoked IS NULL",
      id,
    )

    if (row === undefined || (of !== undefined && row.person !== of)) {
      yield* new Refused({
        message: `there's no token "${id}"${of === undefined ? " in the workspace" : " of yours"} to revoke: the tokens list shows their ids`,
      })
    }

    yield* sql.exec(
      "UPDATE api_tokens SET revoked = ?, revoked_why = ? WHERE id = ?",
      new Date().toISOString(),
      why,
      id,
    )
  })

  const remove = Effect.fnUntraced(function* (person: Person, by: string) {
    yield* keepAnAdmin(person, "removed")

    const why = `${person.email} was removed from the workspace by ${by}`

    const revoked = yield* commit(
      Effect.gen(function* () {
        const now = new Date().toISOString()

        if (person.status !== "removed") {
          yield* sql.exec(
            "UPDATE people SET removed = ?, removed_by = ? WHERE id = ?",
            now,
            by,
            person.id,
          )
        }

        const cursor = yield* sql.exec(
          "UPDATE api_tokens SET revoked = ?, revoked_why = ? WHERE person = ? AND revoked IS NULL",
          now,
          why,
          person.id,
        )

        yield* sql.exec("DELETE FROM group_members WHERE person = ?", person.id)

        return { tokens: yield* cursor.rowsWritten, credentials: yield* forget(person.id, by) }
      }),
    )

    const apps = (yield* rows<{ app: string }>(
      "SELECT app FROM visits WHERE person = ?",
      person.id,
    )).map((v) => v.app)

    const closed = yield* disconnect(person.email, apps, why, "removed")

    return {
      person: yield* find(person.id),
      revoked: revoked.tokens,
      credentials: revoked.credentials,
      closed,
    }
  })

  const whoami = Effect.fnUntraced(function* (workspace: WorkspaceName, id: string) {
    const person = yield* find(id)

    const shown: WhoAmI = {
      workspace,
      person: {
        id: person.id,
        email: person.email,
        name: person.name,
        role: person.role,
        status: person.status,
      },
      groups: person.groups,
      joining: joining(),
      admins: yield* admins(),
    }

    return shown
  })

  const act = Effect.fnUntraced(function* (
    workspace: WorkspaceName,
    origin: string,
    caller: Member,
    route: string,
    method: string,
    text: string,
    trace: string,
    within: AgentApps,
  ) {
    const fail = (status: number, code: ErrorCode, error: string): Answer => ({
      status,
      body: { error, code, trace },
    })

    const body = <S extends Schema.Top & { readonly DecodingServices: never }>(
      schema: S,
      usage: string,
    ) =>
      Result.match(
        Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text === "" ? "{}" : text),
        {
          onFailure: (issue) =>
            Effect.fail(
              new Refused({
                message: `send JSON like ${usage} (${issue.message.split("\n")[0]})`,
              }),
            ),
          onSuccess: (value: S["Type"]) => Effect.succeed(value),
        },
      )

    const log = (line: string) =>
      Effect.logInfo(`${workspace}: ${caller.email} ${line}`).pipe(
        Effect.annotateLogs({ trace, workspace }),
      )

    const done = (answer: Readonly<Record<string, Json>>): Answer => ({
      status: 200,
      body: { ...answer, trace },
    })

    const run = Effect.gen(function* () {
      const why = shut()

      // Letting anyone in (an invite, open joining, a directory's token) waits for a person to own the workspace.
      if (why !== undefined && LETS_IN.has(`${method} ${route}`))
        return yield* new Refused({ message: why })

      switch (`${method} ${route}`) {
        case "GET me/whoami":
          return done(yield* whoami(workspace, caller.id))
        case "GET me/tokens":
          return done({ tokens: yield* tokens(caller.id) })
        case "POST me/tokens/create": {
          const { days, label, apps } = yield* body(
            TokenRequest,
            '{"label": "laptop", "days": 30, "apps": ["standup"]}',
          )

          const made = yield* mint(
            yield* find(caller.id),
            days,
            label,
            yield* narrowApps(apps, within),
          )

          yield* log(`made a token (${made.id})`)

          // The token works only at this workspace's own host, never at the base host's one MCP address: say where.
          return done({
            ...made,
            expires: made.expires ?? "never",
            workspace_url: origin,
            mcp_url: `${origin}/mcp`,
            next: `Send it as "Authorization: Bearer <token>" to mcp_url (${origin}/mcp), the only address that accepts it.${made.apps === null ? "" : ` It may use only ${made.apps.join(", ") || "no apps"} (making them, if they don't exist yet), and no other app; token_apps_set changes that.`}`,
          })
        }

        case "POST me/tokens/apps": {
          if (within !== null) return yield* new Refused({ message: LIMITED_CANT_MANAGE })

          const { id, apps } = yield* body(AppsRequest, '{"id": "t_...", "apps": ["standup"]}')

          yield* setTokenApps(caller.id, id, apps)
          yield* log(
            `set token ${id}'s apps to ${apps === null ? "every app" : apps.join(", ") || "none"}`,
          )

          return done({ id, apps })
        }

        case "POST me/tokens/revoke": {
          if (within !== null) return yield* new Refused({ message: LIMITED_CANT_MANAGE })

          const { id } = yield* body(Schema.Struct({ id: Schema.String }), '{"id": "t_..."}')

          yield* revoke(id, `${caller.email} revoked it`, caller.id)
          yield* log(`revoked their token ${id}`)

          return done({ revoked: id })
        }
      }

      if (caller.role !== "admin") {
        return fail(
          403,
          "not_admin",
          `/_workspace is for ${workspace}'s admins, and ${caller.email} is a member. ${askAdmins(yield* admins(), `do it, or make you an admin`)}`,
        )
      }

      switch (`${method} ${route}`) {
        case "GET workspace/people":
          return done({
            joining: joining(),
            people: (yield* rows<PersonRow>(`${PEOPLE} ORDER BY p.email`)).map(toPerson),
          })
        case "POST workspace/people/invite": {
          const asked = yield* body(
            Schema.Struct({
              email: Email,
              name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
              role: Schema.optionalKey(RoleSchema),
            }),
            '{"email": "dave@acme.com", "name": "Dave", "role": "member"}',
          )

          const existing = yield* byEmail(asked.email)
          const role = asked.role ?? "member"

          if (existing === null) {
            const person = yield* add(asked.email, {
              name: asked.name ?? defaultName(asked.email),
              role,
              invitedBy: caller.email,
              joined: null,
            })

            yield* log(`invited ${person.email} as ${role}`)

            return done({ person, invited: true })
          }

          if (existing.status === "removed") {
            yield* sql.exec(
              "UPDATE people SET removed = NULL, removed_by = NULL, joined = NULL, invited_by = ?, role = ? WHERE id = ?",
              caller.email,
              role,
              existing.id,
            )
            yield* log(`invited ${existing.email} again, as ${role}`)

            return done({ person: yield* find(existing.id), invited: true })
          }

          if (asked.role !== undefined && asked.role !== existing.role) {
            yield* keepAnAdmin(existing, "made a member")
            yield* sql.exec("UPDATE people SET role = ? WHERE id = ?", asked.role, existing.id)
            yield* log(`made ${existing.email} ${asked.role}`)
          }

          return done({ person: yield* find(existing.id), invited: false })
        }

        case "POST workspace/people/remove": {
          const { person: who } = yield* body(
            Schema.Struct({ person: Who }),
            '{"person": "dave@acme.com"}',
          )

          const removed = yield* remove(yield* find(who), caller.email)

          yield* log(
            `removed ${removed.person.email}: ${removed.revoked} tokens revoked, ${removed.credentials} connection tokens deleted, ${removed.closed} open pages closed`,
          )

          return done(removed)
        }

        case "POST workspace/people/role": {
          const asked = yield* body(
            Schema.Struct({ person: Who, role: RoleSchema }),
            '{"person": "dave@acme.com", "role": "admin"}',
          )

          const person = yield* find(asked.person)

          if (person.status === "removed") {
            return yield* new Refused({
              message: `${person.email} was removed from the workspace: invite them again (people/invite with a role) instead`,
            })
          }

          if (asked.role === "member") yield* keepAnAdmin(person, "made a member")

          yield* sql.exec("UPDATE people SET role = ? WHERE id = ?", asked.role, person.id)
          yield* log(`made ${person.email} ${asked.role}`)

          return done({ person: yield* find(person.id) })
        }

        case "GET workspace/embed":
          return done({ apps: embedding() })
        case "POST workspace/embed": {
          const asked = yield* body(
            Schema.Struct({ apps: EmbedSchema }),
            '{"apps": ["builder"]} (app names, at most 10; [] for none)',
          )

          const unique = [...new Set(asked.apps)]

          kv.put("embed", JSON.stringify(unique))
          yield* log(
            unique.length === 0
              ? "let no app embed another"
              : `let ${unique.join(", ")} embed the workspace's other apps`,
          )

          return done({ apps: unique })
        }

        case "GET workspace/joining":
          return done({ joining: joining() })
        case "POST workspace/joining": {
          const asked = yield* body(
            Schema.Struct({ joining: JoiningSchema }),
            '{"joining": "invite"} (or "open")',
          )

          kv.put("joining", asked.joining)
          yield* log(`set joining to ${asked.joining}`)

          return done({ joining: asked.joining })
        }

        case "GET workspace/groups": {
          const names = yield* rows<{ name: string }>("SELECT name FROM groups ORDER BY name")

          return done({ groups: yield* Effect.forEach(names, (g) => groupOf(g.name)) })
        }

        case "POST workspace/groups/create": {
          const { name } = yield* body(
            Schema.Struct({ name: Schema.String }),
            '{"name": "support"}',
          )

          const problem = groupNameProblem(name)

          if (problem !== undefined) return yield* new Refused({ message: problem })

          const made =
            (yield* (yield* sql.exec(
              "INSERT INTO groups (name, source, external_id, created) VALUES (?, 'openbelt', NULL, ?) ON CONFLICT (name) DO NOTHING",
              name,
              new Date().toISOString(),
            )).rowsWritten) > 0

          if (made) yield* log(`made the group ${name}`)

          return done({ group: yield* groupOf(name), created: made })
        }

        case "POST workspace/groups/delete": {
          const { name } = yield* body(
            Schema.Struct({ name: Schema.String }),
            '{"name": "support"}',
          )

          yield* openbelt(name)

          const members = (yield* rows<{ person: string }>(
            "SELECT person FROM group_members WHERE grp = ?",
            name,
          )).map((m) => decodePersonId(m.person))

          yield* commit(
            Effect.gen(function* () {
              yield* sql.exec("DELETE FROM group_members WHERE grp = ?", name)
              yield* sql.exec("DELETE FROM groups WHERE name = ?", name)
              yield* forgetGroup(name)
            }),
          )
          yield* log(`deleted the group ${name}`)
          yield* regrouped(members, `the group ${name} was deleted`)

          return done({ deleted: name })
        }

        case "POST workspace/groups/add":
        case "POST workspace/groups/remove": {
          const asked = yield* body(
            Schema.Struct({ group: Schema.String, person: Who }),
            '{"group": "support", "person": "dave@acme.com"}',
          )

          yield* openbelt(asked.group)

          const person = yield* find(asked.person)

          if (route === "workspace/groups/add") {
            if (person.status === "removed") {
              return yield* new Refused({
                message: `${person.email} was removed from the workspace, so they can't join a group: invite them again first`,
              })
            }

            yield* sql.exec(
              "INSERT INTO group_members (grp, person) VALUES (?, ?) ON CONFLICT DO NOTHING",
              asked.group,
              person.id,
            )
            yield* log(`added ${person.email} to ${asked.group}`)
          } else {
            yield* sql.exec(
              "DELETE FROM group_members WHERE grp = ? AND person = ?",
              asked.group,
              person.id,
            )
            yield* log(`took ${person.email} out of ${asked.group}`)
          }

          yield* regrouped(
            [person.id],
            `${route === "workspace/groups/add" ? "added to" : "taken out of"} ${asked.group}`,
          )

          return done({ group: yield* groupOf(asked.group) })
        }

        case "GET workspace/scim":
          return done(yield* scimStatus(30))
        case "POST workspace/scim/token": {
          const { label } = yield* body(
            Schema.Struct({
              label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
            }),
            '{"label": "okta"}',
          )

          const token = `prs_${hex(24)}`
          const id = `s_${hex(6)}`

          yield* sql.exec(
            "INSERT INTO scim_tokens (hash, id, label, created, made_by) VALUES (?, ?, ?, ?, ?)",
            yield* hashToken(token),
            id,
            label ?? "",
            new Date().toISOString(),
            caller.email,
          )
          yield* log(`made a SCIM token (${id})`)

          return done({ token, id })
        }

        case "POST workspace/scim/revoke": {
          const { id } = yield* body(Schema.Struct({ id: Schema.String }), '{"id": "s_..."}')

          const revoked = yield* sql.exec(
            "UPDATE scim_tokens SET revoked = ? WHERE id = ? AND revoked IS NULL",
            new Date().toISOString(),
            id,
          )

          if ((yield* revoked.rowsWritten) === 0)
            return yield* new Refused({
              message: `there's no SCIM token ${id} that works: workspace scim lists them`,
            })

          yield* log(`revoked the SCIM token ${id}`)

          return done({ revoked: id })
        }

        case "GET workspace/tokens":
          return done({ tokens: yield* tokens(undefined) })
        case "POST workspace/tokens/revoke": {
          const { id } = yield* body(Schema.Struct({ id: Schema.String }), '{"id": "t_..."}')

          yield* revoke(id, `revoked by ${caller.email}, an admin`, undefined)
          yield* log(`revoked the token ${id}`)

          return done({ revoked: id })
        }
      }

      return fail(
        404,
        "missing",
        `there's no ${method} /_${route}. /_workspace takes GET people, groups, tokens, joining, embed; POST people/invite, people/remove, people/role, groups/create, groups/delete, groups/add, groups/remove, tokens/revoke, joining, embed. /_me takes GET whoami, tokens; POST tokens/create, tokens/revoke. Connections: /_workspace/connections, /_workspace/access, /_workspace/explain, /_workspace/activity and /_me/connections (docs/connections.md). bun run workspace does each.`,
      )
    })

    return yield* run.pipe(
      Effect.catchTag("Refused", (e) => Effect.succeed(fail(400, "invalid", e.message))),
    )
  })

  const scimStatus = Effect.fnUntraced(function* (recent: number) {
    const made = (yield* rows<{
      id: string
      label: string
      created: string
      made_by: string
      last_used: string | null
      revoked: string | null
    }>(
      "SELECT id, label, created, made_by, last_used, revoked FROM scim_tokens ORDER BY created",
    )).map((t) => ({
      id: t.id,
      label: t.label,
      created: t.created,
      madeBy: t.made_by,
      lastUsed: t.last_used,
      revoked: t.revoked,
    }))

    const log = yield* rows<{
      n: number
      at: string
      method: string
      path: string
      status: number
      note: string
      body: string
      trace: string
    }>(
      "SELECT n, at, method, path, status, note, body, trace FROM scim_log ORDER BY n DESC LIMIT ?",
      recent,
    )

    return { tokens: made, recent: log }
  })

  const SCIM_KEPT = 200

  const DIRECTORY = "your directory (SCIM)"

  const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

  const decodeExternalId = Schema.decodeUnknownOption(
    Schema.Struct({ externalId: Schema.optionalKey(Schema.String) }),
  )

  const scimGroup = Effect.fnUntraced(function* (name: string) {
    const [row] = yield* rows<{ created: string }>(
      "SELECT created FROM groups WHERE name = ? AND source = 'scim'",
      name,
    )

    return row === undefined ? null : { group: yield* groupOf(name), created: row.created }
  })

  const memberPeople = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
    const found: Person[] = []

    for (const id of ids) {
      const person = yield* byId(id)

      if (person === null)
        return {
          problem: `there's no user "${id}" in this workspace: provision the user first`,
          found: [],
        }

      found.push(person)
    }

    return { problem: null, found }
  })

  const applyGroup = Effect.fnUntraced(function* (
    group: Group,
    changes: ReadonlyArray<GroupChange>,
  ) {
    const current = new Set((yield* groupMembers(group.name)).map((m) => m.id))
    let next = new Set(current)

    for (const change of changes) {
      if (change.kind === "name") {
        if (slug(change.displayName) !== group.name && change.displayName !== group.name)
          return {
            changed: [],
            problem: `a group's name can't change here: it is ${group.name} (from "${change.displayName}"), and access levels and rules name it. Make a new group and move the people`,
          }
      } else if (change.kind === "remove") {
        if (change.ids === "all") next.clear()
        else for (const id of change.ids) next.delete(id)
      } else {
        const people = yield* memberPeople(change.ids)

        if (people.problem !== null) return { problem: people.problem, changed: [] }

        const wanted = people.found.filter((p) => p.status !== "removed").map((p) => p.id)

        next = change.kind === "set" ? new Set(wanted) : new Set([...next, ...wanted])
      }
    }

    const added = [...next].filter((id) => !current.has(id))
    const removed = [...current].filter((id) => !next.has(id))

    yield* commit(
      Effect.gen(function* () {
        for (const id of added)
          yield* sql.exec(
            "INSERT INTO group_members (grp, person) VALUES (?, ?) ON CONFLICT DO NOTHING",
            group.name,
            id,
          )

        for (const id of removed)
          yield* sql.exec("DELETE FROM group_members WHERE grp = ? AND person = ?", group.name, id)
      }),
    )

    return { problem: null, changed: [...added, ...removed].map((id) => decodePersonId(id)) }
  })

  const applyUser = Effect.fnUntraced(function* (person: Person, fields: UserFields) {
    if (fields.userName !== undefined && emailOf(fields.userName) !== person.email)
      return {
        problem: `a user's userName can't change: OpenBelt knows ${person.email} by that email, and everything they wrote is signed with it. Provision the new email as a new user`,
      }

    const did: string[] = []

    if (fields.active === false && person.status !== "removed") {
      const removed = yield* remove(person, DIRECTORY)

      did.push(
        `deactivated ${person.email}: ${removed.revoked} tokens revoked, ${removed.credentials} connection tokens deleted, ${removed.closed} open pages closed`,
      )
    }

    // A directory brings back whom it deactivated, not whom an admin removed here: its profile
    // updates say active true all the time, and they must not undo that.
    if (fields.active === true && person.status === "removed" && person.removedBy !== DIRECTORY)
      return {
        conflict: `${person.email} was removed from the workspace by ${person.removedBy}, not by your directory, so it won't bring them back: an admin invites them again (Settings > People) if that's a mistake`,
      }

    if (fields.active === true && person.status === "removed") {
      yield* sql.exec(
        "UPDATE people SET removed = NULL, removed_by = NULL, joined = NULL, invited_by = ?, role = 'member' WHERE id = ?",
        "SCIM",
        person.id,
      )
      did.push(`reactivated ${person.email} as a member`)
    }

    if (fields.name !== undefined && fields.name !== person.name) {
      yield* sql.exec("UPDATE people SET name = ? WHERE id = ?", fields.name, person.id)
      did.push(`renamed ${person.email}`)
    }

    return { did: did.length === 0 ? `${person.email}: nothing to change` : did.join("; ") }
  })

  const scim = Effect.fnUntraced(function* (
    workspace: string,
    token: string,
    method: string,
    path: string,
    query: URLSearchParams,
    text: string,
    trace: string,
    origin: string,
  ) {
    const base = `${origin}/scim/v2`

    const [known] = yield* rows<{ id: string; revoked: string | null }>(
      "SELECT id, revoked FROM scim_tokens WHERE hash = ?",
      yield* hashToken(token),
    )

    if (known === undefined || known.revoked !== null) {
      yield* Effect.logInfo(
        `${workspace}: scim ${method} ${path} refused: ${known === undefined ? "not a SCIM token of this workspace" : "revoked"}`,
      ).pipe(Effect.annotateLogs({ trace, workspace }))

      return scimError(
        401,
        known === undefined
          ? `that isn't a SCIM token of ${workspace}: make one in Settings (People, Directory sync) or with bun run workspace scim token`
          : `this SCIM token of ${workspace} was revoked on ${known.revoked?.slice(0, 10)}: make another in Settings (People, Directory sync)`,
      )
    }

    const json = text === "" ? Option.some(null) : decodeJson(text)

    const run: Effect.Effect<ScimAnswer> = Effect.gen(function* () {
      const bad = (detail: string, type?: Parameters<typeof scimError>[2]) =>
        answered(scimError(400, detail, type), `refused: ${detail}`)

      const missing = (what: string) => answered(scimError(404, `there's no ${what}`), `no ${what}`)

      const sent = Option.getOrUndefined(json)

      const users = /^\/Users(?:\/([^/]+))?$/.exec(path)
      const groups = /^\/Groups(?:\/([^/]+))?$/.exec(path)

      if (method === "GET" && path === "/ServiceProviderConfig")
        return answered(
          { status: 200, body: serviceProviderConfig(base) },
          "service provider config",
        )

      if (method === "GET" && path === "/ResourceTypes")
        return answered(
          { status: 200, body: listResponse(resourceTypes(base), 2, 1) },
          "resource types",
        )

      if (method === "GET" && path === "/Schemas")
        return answered({ status: 200, body: listResponse([], 0, 1) }, "schemas")

      if (users !== null) {
        const [, id] = users

        if (id === undefined) {
          if (method === "GET") {
            const { start, count } = scimPage(query)
            const filter = query.get("filter")

            if (filter !== null) {
              const parsed = parseFilter(filter)

              if (Option.isNone(parsed))
                return bad(
                  `the filter ${filter} isn't supported: send userName eq "ada@acme.com" (or id eq "...")`,
                  "invalidFilter",
                )

              const { attribute, value } = parsed.value

              const found =
                attribute === "username" || attribute === "emails.value"
                  ? yield* byEmail(value.trim().toLowerCase())
                  : attribute === "id"
                    ? yield* byId(value)
                    : attribute === "externalid"
                      ? null
                      : undefined

              if (found === undefined)
                return bad(
                  `the filter on ${attribute} isn't supported: send userName eq "..." or id eq "..."`,
                  "invalidFilter",
                )

              const all = found === null ? [] : [userResource(found, base)]

              return answered(
                {
                  status: 200,
                  body: listResponse(all.slice(start - 1, start - 1 + count), all.length, start),
                },
                `${all.length} users for ${filter}`,
              )
            }

            const everyone = (yield* rows<PersonRow>(`${PEOPLE} ORDER BY p.email`)).map(toPerson)

            return answered(
              {
                status: 200,
                body: listResponse(
                  everyone.slice(start - 1, start - 1 + count).map((p) => userResource(p, base)),
                  everyone.length,
                  start,
                ),
              },
              `listed ${everyone.length} users`,
            )
          }

          if (method === "POST") {
            const body = sent

            if (body === undefined) return bad("the body isn't JSON", "invalidSyntax")

            const fields = userFields(body)

            if ("problem" in fields) return bad(fields.problem, "invalidValue")

            const email = emailOf(fields.userName ?? "")

            if (email === undefined)
              return bad(
                `userName must be the person's email, like "ada@acme.com" (got "${(fields.userName ?? "").slice(0, 80)}"): in Okta, set the application username to the email`,
                "invalidValue",
              )

            const existing = yield* byEmail(email)

            if (existing !== null)
              return answered(
                scimError(
                  409,
                  `${email} already exists here (id ${existing.id}${existing.status === "removed" ? ", deactivated: PATCH active to true to bring them back" : ""})`,
                  "uniqueness",
                ),
                `409: ${email} exists`,
              )

            const made = yield* add(email, {
              name: fields.name ?? defaultName(email),
              role: "member",
              invitedBy: "SCIM",
              joined: null,
            })

            const result = fields.active === false ? yield* remove(made, DIRECTORY) : null

            return answered(
              {
                status: 201,
                body: userResource(result === null ? made : result.person, base),
              },
              `provisioned ${email}${result === null ? "" : " (inactive)"}`,
            )
          }
        } else {
          const person = yield* byId(id)

          if (person === null) return missing(`user ${id}`)

          if (method === "GET")
            return answered(
              { status: 200, body: userResource(person, base) },
              `read ${person.email}`,
            )

          if (method === "DELETE") {
            const done = yield* applyUser(person, { active: false })

            return answered(
              { status: 204, body: null },
              "problem" in done ? done.problem : "conflict" in done ? done.conflict : done.did,
            )
          }

          if (method === "PUT" || method === "PATCH") {
            const body = sent

            if (body === undefined) return bad("the body isn't JSON", "invalidSyntax")

            const patch = method === "PATCH" ? Schema.decodeUnknownOption(PatchRequest)(body) : null

            if (patch !== null && Option.isNone(patch))
              return bad(
                'send {"schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], "Operations": [{"op": "replace", "value": {"active": false}}]}',
                "invalidSyntax",
              )

            const fields = patch === null ? userFields(body) : userPatch(patch.value.Operations)

            if ("problem" in fields) return bad(fields.problem, "invalidValue")

            const done = yield* applyUser(person, fields)

            if ("problem" in done) return bad(done.problem, "mutability")

            if ("conflict" in done)
              return answered(scimError(409, done.conflict), `409: ${done.conflict}`)

            return answered(
              { status: 200, body: userResource(yield* find(person.id), base) },
              done.did,
            )
          }
        }
      }

      if (groups !== null) {
        const [, id] = groups

        if (id === undefined) {
          if (method === "GET") {
            const { start, count } = scimPage(query)
            const filter = query.get("filter")

            const names = (yield* rows<{ name: string; external_id: string | null }>(
              "SELECT name, external_id FROM groups WHERE source = 'scim' ORDER BY name",
            )).filter((g) => {
              if (filter === null) return true

              const parsed = parseFilter(filter)

              if (Option.isNone(parsed)) return false

              const { attribute, value } = parsed.value

              if (attribute === "displayname") return g.name === slug(value) || g.name === value

              if (attribute === "id") return g.name === value

              return attribute === "externalid" && g.external_id === value
            })

            if (filter !== null && Option.isNone(parseFilter(filter)))
              return bad(
                `the filter ${filter} isn't supported: send displayName eq "Engineering" (or id eq "...")`,
                "invalidFilter",
              )

            const found = yield* Effect.forEach(names.slice(start - 1, start - 1 + count), (g) =>
              scimGroup(g.name),
            )

            return answered(
              {
                status: 200,
                body: listResponse(
                  found.flatMap((g) =>
                    g === null ? [] : [groupResource(g.group, g.created, base)],
                  ),
                  names.length,
                  start,
                ),
              },
              `${names.length} groups${filter === null ? "" : ` for ${filter}`}`,
            )
          }

          if (method === "POST") {
            const body = sent

            if (body === undefined) return bad("the body isn't JSON", "invalidSyntax")

            const changes = groupBody(body)

            if ("problem" in changes) return bad(changes.problem, "invalidValue")

            const display = changes.find((c) => c.kind === "name")

            if (display === undefined || display.kind !== "name")
              return bad("a group needs a displayName", "invalidValue")

            const name = slug(display.displayName)
            const problem = groupNameProblem(name)

            if (problem !== undefined)
              return bad(
                `the group "${display.displayName}" can't be an OpenBelt group (${problem}): rename it in your directory`,
                "invalidValue",
              )

            const [taken] = yield* rows<{ source: string }>(
              "SELECT source FROM groups WHERE name = ?",
              name,
            )

            if (taken !== undefined)
              return answered(
                scimError(
                  409,
                  taken.source === "scim"
                    ? `the group ${name} already exists (id ${name})`
                    : `a group named ${name} already exists here, made in OpenBelt: delete it, or rename the group in your directory`,
                  "uniqueness",
                ),
                `409: ${name} exists`,
              )

            const external = Option.getOrUndefined(decodeExternalId(body))?.externalId

            yield* sql.exec(
              "INSERT INTO groups (name, source, external_id, created) VALUES (?, 'scim', ?, ?)",
              name,
              external ?? name,
              new Date().toISOString(),
            )

            const applied = yield* applyGroup(yield* groupOf(name), changes)

            if (applied.problem !== null) {
              yield* sql.exec("DELETE FROM groups WHERE name = ?", name)

              return bad(applied.problem, "invalidValue")
            }

            yield* regrouped(applied.changed, `synced ${name} from your directory`)

            const made = yield* scimGroup(name)

            return answered(
              {
                status: 201,
                body: made === null ? {} : groupResource(made.group, made.created, base),
              },
              `made the group ${name} with ${applied.changed.length} people`,
            )
          }
        } else {
          const found = yield* scimGroup(id)

          if (found === null) return missing(`group ${id}`)

          if (method === "GET")
            return answered(
              { status: 200, body: groupResource(found.group, found.created, base) },
              `read ${id}`,
            )

          if (method === "DELETE") {
            const members = found.group.members.map((m) => m.id)

            yield* commit(
              Effect.gen(function* () {
                yield* sql.exec("DELETE FROM group_members WHERE grp = ?", id)
                yield* sql.exec("DELETE FROM groups WHERE name = ?", id)
                yield* forgetGroup(id)
              }),
            )
            yield* regrouped(members, `the group ${id} was deleted by your directory`)

            return answered({ status: 204, body: null }, `deleted the group ${id}`)
          }

          if (method === "PUT" || method === "PATCH") {
            const body = sent

            if (body === undefined) return bad("the body isn't JSON", "invalidSyntax")

            const patch = method === "PATCH" ? Schema.decodeUnknownOption(PatchRequest)(body) : null

            if (patch !== null && Option.isNone(patch))
              return bad(
                'send {"schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], "Operations": [{"op": "add", "path": "members", "value": [{"value": "p_..."}]}]}',
                "invalidSyntax",
              )

            const changes = patch === null ? groupBody(body) : groupPatch(patch.value.Operations)

            if ("problem" in changes) return bad(changes.problem, "invalidValue")

            const applied = yield* applyGroup(found.group, changes)

            if (applied.problem !== null) return bad(applied.problem, "invalidValue")

            yield* regrouped(applied.changed, `synced ${id} from your directory`)

            const now = yield* scimGroup(id)

            return answered(
              {
                status: 200,
                body: now === null ? {} : groupResource(now.group, now.created, base),
              },
              `${id}: ${applied.changed.length} people changed`,
            )
          }
        }
      }

      return answered(
        scimError(
          method === "GET" || method === "POST" ? 404 : 405,
          `there's no ${method} /scim/v2${path}. OpenBelt serves /Users and /Groups (GET with filter, POST, PUT, PATCH, DELETE), /ServiceProviderConfig and /ResourceTypes`,
        ),
        `no route ${method} ${path}`,
      )
    }).pipe(
      Effect.catchTag("Refused", (e) =>
        Effect.succeed(answered(scimError(409, e.message), `refused: ${e.message}`)),
      ),
    )

    const answer = yield* run
    const now = new Date().toISOString()

    const shown = loggable(text)

    yield* sql.exec(
      "INSERT INTO scim_log (at, method, path, status, note, body, trace) VALUES (?, ?, ?, ?, ?, ?, ?)",
      now,
      method,
      query.size === 0 ? path : `${path}?${query.toString()}`,
      answer.status,
      answer.note,
      shown,
      trace,
    )
    yield* sql.exec(`DELETE FROM scim_log WHERE n <= (SELECT MAX(n) FROM scim_log) - ${SCIM_KEPT}`)
    yield* sql.exec("UPDATE scim_tokens SET last_used = ? WHERE id = ?", now, known.id)
    yield* Effect.logInfo(
      `${workspace}: scim ${method} ${path}${query.size === 0 ? "" : `?${query.toString()}`} → ${answer.status}: ${answer.note}`,
    ).pipe(Effect.annotateLogs({ trace, workspace }))

    return { status: answer.status, body: answer.body }
  })

  return {
    joining,
    embedding,

    /** Whether `email` may sign in here: anyone not removed in an open workspace; in an invite-only one, someone invited or a member. */
    mayJoin: Effect.fnUntraced(function* (email: string) {
      const found = yield* byEmail(email)

      if (found === null) return joining() === "open"

      return found.status !== "removed"
    }),

    /** Where `email` stands here, for the base host's consent page: in, invited (by whom), removed or never; and who the admins are. */
    standing: Effect.fnUntraced(function* (email: string) {
      const found = yield* byEmail(email)

      return {
        status: found === null ? ("none" as const) : found.status,
        invitedBy: found !== null && found.status === "invited" ? found.invitedBy : null,
        admin: found !== null && found.status !== "removed" && found.role === "admin",
        admins: yield* admins(),
      }
    }),

    /**
     * `viewer` makes this workspace (from the base host): its first person, an admin, and invite-only from the start. Again for the
     * same person changes nothing; false when anyone else is already in it.
     */
    found: Effect.fnUntraced(function* (viewer: Viewer) {
      const [other] = yield* rows<{ email: string }>(
        "SELECT email FROM people WHERE email != ? LIMIT 1",
        viewer.email,
      )

      if (other !== undefined) return false

      yield* commit(
        Effect.gen(function* () {
          const person = yield* add(viewer.email, {
            name: viewer.name,
            role: "admin",
            invitedBy: null,
            joined: new Date().toISOString(),
          })

          yield* sql.exec(
            "UPDATE people SET role = 'admin', removed = NULL, removed_by = NULL, joined = COALESCE(joined, ?) WHERE id = ?",
            new Date().toISOString(),
            person.id,
          )
          kv.put("joining", "invite")
        }),
      )

      return true
    }),

    /**
     * A placeholder admin for a workspace nobody has signed in to yet (a trial, trials.ts): in from the start, the workspace invite-only, and
     * a token for it good for `days`.
     */
    placeholder: Effect.fnUntraced(function* (email: string, name: string, days: number) {
      return yield* commit(
        Effect.gen(function* () {
          const person = yield* add(email, {
            name,
            role: "admin",
            invitedBy: null,
            joined: new Date().toISOString(),
          })

          kv.put("joining", "invite")

          return { person, token: (yield* mint(person, days, "trial agent", null)).token }
        }),
      )
    }),

    /**
     * `viewer` becomes the placeholder (a trial claimed, trials.ts): the same person, so what it made is theirs and its tokens are
     * theirs, with no end. Someone already in the workspace as that email (the agent invited them) is folded into it.
     */
    takeOver: Effect.fnUntraced(function* (placeholder: PersonId, viewer: Viewer) {
      yield* commit(
        Effect.gen(function* () {
          const already = yield* byEmail(viewer.email)
          const now = new Date().toISOString()

          if (already !== null && already.id !== placeholder) {
            yield* sql.exec(
              "UPDATE api_tokens SET revoked = ?, revoked_why = ? WHERE person = ? AND revoked IS NULL",
              now,
              `${viewer.email} claimed the workspace: their placeholder's tokens are theirs`,
              already.id,
            )
            yield* sql.exec("DELETE FROM group_members WHERE person = ?", already.id)
            yield* sql.exec("DELETE FROM visits WHERE person = ?", already.id)
            yield* sql.exec("DELETE FROM people WHERE id = ?", already.id)
          }

          yield* sql.exec(
            "UPDATE people SET email = ?, name = ?, role = 'admin', removed = NULL, removed_by = NULL, joined = COALESCE(joined, ?) WHERE id = ?",
            viewer.email,
            viewer.name,
            now,
            placeholder,
          )
          yield* sql.exec(
            "UPDATE api_tokens SET expires = NULL WHERE person = ? AND revoked IS NULL",
            placeholder,
          )
          yield* sql.exec(
            "UPDATE apps SET owner = ? WHERE owner_person = ?",
            viewer.email,
            placeholder,
          )
          yield* listed(viewer.email)
        }),
      )
    }),

    /** Someone signed out: their open pages close (the SDK reloads them, which signs in again where they still are). */
    closePages: Effect.fnUntraced(function* (email: string, why: string) {
      const found = yield* byEmail(email)

      if (found === null) return 0

      const apps = (yield* rows<{ app: string }>(
        "SELECT app FROM visits WHERE person = ?",
        found.id,
      )).map((v) => v.app)

      return yield* disconnect(email, apps, why, "signed_out")
    }),

    nameOf: Effect.fnUntraced(function* (email: string) {
      return (yield* byEmail(email))?.name ?? null
    }),

    admit: Effect.fnUntraced(function* (viewer: Viewer | null) {
      if (shut() !== undefined) return { kind: "trial" } satisfies Admission

      const policy = joining()

      if (viewer === null) {
        return policy === "open"
          ? ({ kind: "anonymous" } satisfies Admission)
          : ({ kind: "signed_out", admins: yield* admins() } satisfies Admission)
      }

      const found = yield* byEmail(viewer.email)

      if (found === null) {
        if (policy === "invite") {
          return {
            kind: "not_invited",
            email: viewer.email,
            admins: yield* admins(),
          } satisfies Admission
        }

        const person = yield* add(viewer.email, {
          name: viewer.name,
          role: "member",
          invitedBy: null,
          joined: new Date().toISOString(),
        })

        yield* Effect.logInfo(`people: ${viewer.email} joined on their first visit`)

        return { kind: "member", person: toMember(person) } satisfies Admission
      }

      if (found.status === "removed") {
        return {
          kind: "removed",
          email: found.email,
          removed: found.removed,
          by: found.removedBy,
          admins: yield* admins(),
        } satisfies Admission
      }

      if (found.status === "invited" || found.name !== viewer.name) {
        yield* sql.exec(
          "UPDATE people SET joined = COALESCE(joined, ?), name = ? WHERE id = ?",
          new Date().toISOString(),
          viewer.name,
          found.id,
        )
      }

      return {
        kind: "member",
        person: { ...toMember(found), name: viewer.name },
      } satisfies Admission
    }),

    checkToken: Effect.fnUntraced(function* (token: string) {
      const [row] = yield* rows<{
        id: string
        person: string
        expires: string | null
        revoked: string | null
        revoked_why: string | null
        apps: string | null
      }>(
        "SELECT id, person, expires, revoked, revoked_why, apps FROM api_tokens WHERE hash = ?",
        yield* hashToken(token),
      )

      if (row === undefined) return { kind: "unknown" } satisfies TokenCheck

      if (row.revoked !== null) {
        return {
          kind: "revoked",
          revoked: row.revoked,
          why: row.revoked_why ?? "",
        } satisfies TokenCheck
      }

      if (row.expires !== null && row.expires <= new Date().toISOString()) {
        return { kind: "expired", expired: row.expires } satisfies TokenCheck
      }

      const person = yield* find(row.person)

      if (person.status === "invited") {
        yield* sql.exec(
          "UPDATE people SET joined = ? WHERE id = ?",
          new Date().toISOString(),
          person.id,
        )
      }

      return {
        kind: "valid",
        person: toMember(person),
        client: null,
        credential: row.id,
        apps: decodeAgentApps(row.apps),
      } satisfies TokenCheck
    }),

    signedIn: Effect.fnUntraced(function* (
      id: PersonId,
      client: string,
      credential: string,
      apps: AgentApps,
    ) {
      const person = yield* byId(id)

      if (person === null) return { kind: "unknown" } satisfies TokenCheck

      if (person.status === "removed")
        return {
          kind: "revoked",
          revoked: person.removed,
          why: `${person.email} was removed from the workspace by ${person.removedBy}`,
        } satisfies TokenCheck

      return {
        kind: "valid",
        person: toMember(person),
        client,
        credential,
        apps,
      } satisfies TokenCheck
    }),

    isActive: Effect.fnUntraced(function* (id: PersonId) {
      const person = yield* byId(id)

      return person !== null && person.status !== "removed"
    }),

    tokenFor: Effect.fnUntraced(function* (email: string, days: number | undefined) {
      const person =
        (yield* byEmail(email)) ??
        (yield* add(email, {
          name: defaultName(email),
          role: "member",
          invitedBy: "the platform admin",
          joined: new Date().toISOString(),
        }))

      return { person, ...(yield* mint(person, days, "made by the platform admin", null)) }
    }),

    makeAdmin: Effect.fnUntraced(function* (email: string) {
      const existing = yield* byEmail(email)

      if (existing === null) {
        return yield* add(email, {
          name: defaultName(email),
          role: "admin",
          invitedBy: "the platform admin",
          joined: null,
        })
      }

      yield* sql.exec(
        "UPDATE people SET role = 'admin', removed = NULL, removed_by = NULL WHERE id = ?",
        existing.id,
      )

      return yield* find(existing.id)
    }),

    visited: Effect.fnUntraced(function* (person: PersonId, app: string) {
      const key = `${person}/${app}`

      if (seen.has(key)) return

      yield* sql.exec(
        "INSERT INTO visits (person, app) VALUES (?, ?) ON CONFLICT DO NOTHING",
        person,
        app,
      )
      seen.add(key)
    }),

    whoami,
    act,
    scim,
    scimStatus,
    find,
    admins,
    group: groupOf,

    groups: Effect.fnUntraced(function* () {
      const names = yield* rows<{ name: string }>("SELECT name FROM groups ORDER BY name")

      return yield* Effect.forEach(names, (g) => groupOf(g.name).pipe(Effect.orDie))
    }),

    tokensOf: (person: PersonId) => tokens(person),

    makeToken: (person: Person, days: number | undefined, label: string) =>
      mint(person, days, label, null),
    setTokenApps,

    revokeToken: (person: Person, id: string) =>
      revoke(id, `${person.email} revoked it`, person.id),

    active: Effect.fnUntraced(function* (limit: number) {
      return (yield* rows<PersonRow>(
        `${PEOPLE} WHERE p.removed IS NULL ORDER BY p.email LIMIT ?`,
        limit,
      )).map(toPerson)
    }),
  }
})
