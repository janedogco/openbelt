import type { SqlValue } from "./runtime/index.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"
import { KEEP_TOOL_CALLS, type ToolCalls } from "./tool-calls.ts"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  askAdmins,
  type Decision,
  type Facts,
  isRead,
  judgeCredential,
  judgeTool,
  levelOf,
  lower,
  NO_OWN,
  type Own,
  type Policy,
  RANK,
  setTokenHint,
  shownDecision,
  takesMine,
  takesWorkspace,
  decide,
  decideForApp,
  type Setting,
} from "./access.ts"
import {
  type AppTools,
  type ConnectLink,
  connectionNameProblem,
  type ConnectionView,
  CredentialOwner,
  type ErrorCode,
  type Group,
  type Json,
  Level,
  type Person,
  Refused,
  type Role,
  type RunsAs,
} from "./model.ts"
import { fromBase64, ICON_RULES, iconProblem } from "./marks.ts"
import {
  type ApiAuth,
  type ApiTool,
  BEARER,
  baseProblem,
  callApi,
  decodeApiSource,
  decodeBinding,
  inputProblem,
  readSource,
  type Read,
  tagCounts,
} from "./apis.ts"
import {
  apiFromCatalog,
  CatalogAdd,
  catalogFor,
  fixesOf,
  fromCatalog,
  providerAt,
  providerById,
  testOf,
} from "./providers.ts"
import { connectUrl } from "./signins/context.ts"
import { keyOf, openSignIns, scopesOf, type SignInReturn, TOKEN } from "./signins/index.ts"
import {
  redact,
  resolvesPrivate,
  sealing,
  textOf,
  type ToolResult,
  upstreamClient,
  type Upstream,
  type UpstreamCredential,
  type UpstreamTool,
  urlProblem,
  type Reach,
} from "./upstream.ts"
import { queryWords, rank, wordsIn } from "./words.ts"

const KEEP_CALLS = 500

const ASK_DAYS = 30

export const NOTE_MAX = 200

export type Directory = {
  readonly find: (who: string) => Effect.Effect<Person, Refused>
  readonly group: (name: string) => Effect.Effect<Group, Refused>
  readonly admins: () => Effect.Effect<ReadonlyArray<string>>
  readonly app: (name: string, env?: string) => Effect.Effect<CallingApp, Refused>
  readonly everyone: () => Effect.Effect<ReadonlyArray<Person>>
}

type Who = {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly groups: ReadonlyArray<string>
  readonly role: Role
  readonly status?: Person["status"]
}

export type PageWho =
  | { readonly kind: "person"; readonly person: Person }
  | { readonly kind: "signed_out"; readonly by?: Person }
  | { readonly kind: "test_person"; readonly email: string; readonly by: Person }

export type FunctionRunner =
  | { readonly kind: "person"; readonly person: Person; readonly present: boolean }
  | { readonly kind: "test"; readonly person: Person; readonly test: string }
  | { readonly kind: "nobody"; readonly owner: Person }
  | { readonly kind: "signed_out" }

export type CallingApp = {
  readonly id: string
  readonly name: string
  readonly tools: AppTools
  readonly env: string | undefined
}

const whoOf = (viewer: PageWho): Who =>
  Match.value(viewer).pipe(
    Match.discriminatorsExhaustive("kind")({
      person: (p): Who => p.person,
      test_person: (t): Who => t.by,
      signed_out: (s): Who =>
        s.by ?? {
          id: "anonymous",
          email: "a signed-out visitor",
          name: "",
          groups: [],
          role: "member",
        },
    }),
  )

type Caller = { readonly id: string; readonly email: string; readonly role: string }

type Answer = { readonly status: number; readonly body: Readonly<Record<string, Json>> }

export type Called =
  | {
      readonly kind: "ran"
      readonly outcome: "ok" | "tool_error"
      readonly result: ToolResult
      readonly runsAs: RunsAs
      readonly ms: number
    }
  | {
      readonly kind: "not_run"
      readonly outcome: "refused" | "failed"
      readonly message: string
      readonly connect: ConnectLink | undefined
      readonly ms: number
    }

type SendFailure = { readonly refusal: Refused; readonly own: boolean }

type Refusal = { readonly code: ErrorCode; readonly fix: string; readonly url: string | undefined }

type AppCalled =
  | Extract<Called, { readonly kind: "ran" }>
  | { readonly kind: "failed"; readonly message: string; readonly ms: number }
  | ({
      readonly kind: "refused"
      readonly setting: Setting
      readonly message: string
      readonly ms: number
    } & Refusal)

const settingsUrl = (origin: string, connection: string, app: CallingApp) => {
  const query = new URLSearchParams({ connect: connection, app: app.name })

  if (app.env !== undefined) query.set("env", app.env)

  return `${origin}/_connections?${query.toString()}`
}

const refusalFor = (
  setting: Setting,
  app: CallingApp,
  connection: string,
  origin: string,
  admins: ReadonlyArray<string>,
): Refusal => {
  const ask = admins.length === 0 ? "the workspace's admins" : admins.join(" or ")

  switch (setting) {
    case "binding":
      return {
        code: "not_bound",
        fix: `${app.name}'s author binds the tool in openbelt.json "tools" and deploys`,
        url: undefined,
      }
    case "signed_out":
      return { code: "signed_out", fix: "Open the page signed in", url: undefined }
    case "test_person":
      return {
        code: "test_person",
        fix: 'Expect this refusal in the check, or bind the tool to "workspace" to test it',
        url: undefined,
      }
    case "token":
      return {
        code: "needs_token",
        fix: `Connect your ${connection} on Connections`,
        url: settingsUrl(origin, connection, app),
      }
    case "consent":
      return {
        code: "needs_consent",
        fix: `Allow ${app.name} to use your ${connection} on Connections`,
        url: settingsUrl(origin, connection, app),
      }
    case "own":
      return {
        code: "not_allowed",
        fix: `You chose less for yourself on ${connection}: change it on its Connections page`,
        url: `${origin}/_connections/${connection}`,
      }
    default:
      return { code: "not_allowed", fix: `Ask ${ask} if you need it`, url: undefined }
  }
}

const shownRefusal = ({ code, fix, url }: Refusal) =>
  url === undefined ? { code, fix } : { code, fix, url }

const viewerTools = (tools: AppTools, connection: string) =>
  Object.entries(tools)
    .flatMap(([q, b]) =>
      b === "viewer" && q.startsWith(`${connection}.`) ? [q.slice(connection.length + 1)] : [],
    )
    .toSorted()

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

type ConnectionRow = {
  name: string
  url: string
  credential: string
  everyone: string
  created: string
  created_by: string
  refreshed: string | null
  problem: string | null
  provider: string | null
  sign_in: string | null
  api: string | null
}

const apiOf = (row: ConnectionRow) =>
  row.api === null ? undefined : Option.getOrUndefined(decodeApiSource(row.api))

type ToolRow = {
  name: string
  description: string
  input: string
  annotations: string
  read_only: number
}

type CallRow = {
  id: number
  at: string
  trace: string
  person: string
  runs_as: string
  connection: string
  tool: string
  outcome: string
  ms: number
  why: string
  app: string
}

const decodeCredential = Schema.decodeUnknownSync(CredentialOwner)

const decodeLevel = Schema.decodeUnknownSync(Level)

const Want = Schema.Literals(["read", "all"])

const decodeWant = Schema.decodeUnknownSync(Want)

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? ""

  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

const TokenBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
)

const tokenOf = (text: string) =>
  Option.match(TokenBody(text), { onNone: () => text.trim(), onSome: (b) => b.token.trim() })

const NewConnection = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  credential: CredentialOwner,
  everyone: Schema.optionalKey(Level),
  signIn: Schema.optionalKey(Schema.Literals(["oauth", "token"])),
  scopes: Schema.optionalKey(Schema.String),
  authorizeParams: Schema.optionalKey(Schema.String),
})

const NewApiConnection = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["openapi", "graphql"]),
  spec: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  credential: CredentialOwner,
  everyone: Schema.optionalKey(Level),
  auth: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
})

type ApiAdd = {
  readonly name: string
  readonly kind: "openapi" | "graphql"
  readonly spec: string | undefined
  readonly url: string | undefined
  readonly credential: CredentialOwner
  readonly everyone: Level | undefined
  readonly auth?: string | undefined
  readonly tags: ReadonlyArray<string> | undefined
  readonly provider: string | null
  /** From the catalog: people sign in (OAuth) at its issuer, asking for these scopes. */
  readonly signIn?: {
    readonly issuer: string
    readonly scopes: string
    readonly params: string | undefined
  }
}

const authFrom = (written: string): ApiAuth | undefined => {
  const [where = "", name = ""] = written.split(":")

  if (written === "bearer") return BEARER

  if (written === "basic") return { in: "header", name: "authorization", prefix: "Basic " }

  if (where === "header" && name !== "") return { in: "header", name, prefix: "" }

  if (where === "query" && name !== "") return { in: "query", name }

  return undefined
}

const authShown = (auth: ApiAuth) =>
  auth.in === "query"
    ? `query:${auth.name}`
    : auth.name === "authorization" && auth.prefix === "Bearer "
      ? "bearer"
      : auth.name === "authorization" && auth.prefix === "Basic "
        ? "basic"
        : `header:${auth.name}`

export type Listing = {
  readonly search: string | undefined
  readonly past: number
  readonly brief?: number
}

const EVERY_TOOL: Listing = { search: undefined, past: Number.POSITIVE_INFINITY }

const SEARCH_MAX = 10

const FILLER = new Set([
  "a",
  "an",
  "the",
  "for",
  "by",
  "of",
  "to",
  "and",
  "or",
  "in",
  "on",
  "with",
  "my",
  "all",
  "its",
])

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()

const wordsOf = (search: string) => {
  const words = plain(search)
    .split(/[^a-z0-9]+/)
    .flatMap((w) => (w.length > 1 ? [w.replace(/(ies|es|s)$/, "") || w] : []))

  const meant = words.filter((w) => !FILLER.has(w))

  return meant.length === 0 ? words : meant
}

const NO_TOOLS: ReadonlyArray<string> = []

const ConnectBody = Schema.Struct({ scope: Schema.optionalKey(Schema.String) })

const IconBody = Schema.Struct({ type: Schema.String, base64: Schema.String })

const ClientBody = Schema.Struct({
  clientId: Schema.String,
  secret: Schema.optionalKey(Schema.String),
})

const Named = Schema.Struct({ name: Schema.String })

const LevelChange = Schema.Struct({
  connection: Schema.String,
  who: Schema.String,
  level: Schema.Literals(["none", "read", "all", "unset"]),
})

const ToolChange = Schema.Struct({
  connection: Schema.String,
  tool: Schema.String,
  change: Schema.Literals(["disable", "enable", "read", "unread"]),
})

const ExplainRequest = Schema.Struct({
  person: Schema.String,
  tool: Schema.String,
  as: Schema.optionalKey(Schema.Literals(["workspace", "me"])),
  app: Schema.optionalKey(Schema.String),
})

const OwnLevel = Schema.Struct({ level: Schema.Literals(["all", "read", "none"]) })

const OwnTool = Schema.Struct({ tool: Schema.String, on: Schema.Boolean })

const AskMore = Schema.Struct({
  want: Schema.optionalKey(Want),
  note: Schema.optionalKey(Schema.String),
})

const bare = (connection: string, tool: string) =>
  tool.startsWith(`${connection}.`) ? tool.slice(connection.length + 1) : tool

const serverOf = (url: string) => {
  const parsed = new URL(url)

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`
}

const AsksOf = Schema.Struct({
  connection: Schema.String,
  want: Want,
  person: Schema.optionalKey(Schema.String),
  people: Schema.optionalKey(Schema.String),
})

type Subject = string

const withChange = (
  policy: Policy,
  change: { readonly who: Subject; readonly level: "read" | "all" },
  people: ReadonlyMap<string, string>,
): Policy => {
  if (change.who === "everyone") return { ...policy, everyone: change.level }

  if (change.who.startsWith("group:"))
    return {
      ...policy,
      groups: new Map(policy.groups).set(change.who.slice("group:".length), change.level),
    }

  const id = people.get(change.who.slice("person:".length)) ?? change.who

  return { ...policy, people: new Map(policy.people).set(id, change.level) }
}

const movedBy = (before: Policy, after: Policy, everyone: ReadonlyArray<Person>) =>
  everyone.filter((p) => levelOf(before, p).level !== levelOf(after, p).level)

const ActivityRequest = Schema.Struct({
  connection: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  person: Schema.optionalKey(Schema.String),
  app: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: KEEP_TOOL_CALLS })),
  ),
})

const splitTool = (qualified: string) => {
  const dot = qualified.indexOf(".")

  return dot <= 0 ? undefined : ([qualified.slice(0, dot), qualified.slice(dot + 1)] as const)
}

const RUNS_AS: Readonly<Record<RunsAs, string>> = {
  none: "no token: the server takes none",
  workspace: "the workspace's token",
  me: "your own token",
}

const shortWhy = (decision: Decision, level: { level: string; from: string }) => {
  if (decision.allowed) return undefined

  if (decision.setting === "disabled") return "disabled for everyone by the workspace's admins"

  if (decision.setting === "level" && level.level === "none")
    return `your level is none (from ${level.from})`

  if (decision.setting === "level")
    return `not a read tool, and your level is read (from ${level.from})`

  if (decision.setting === "own") return "you chose less for yourself"

  return decision.message
}

export const openConnections = Effect.fn("Connections.open")(function* (
  storage: DurableObjectStorage,
  key: string,
  reach: Reach,
  outside: boolean,
  toolCalls: ToolCalls,
) {
  const { sql } = storage
  const sealer = yield* sealing(key)
  const upstream = upstreamClient()

  const rows = <T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: Array<string | number | null>
  ) => Effect.flatMap(sql.exec<T>(query, ...bindings), (cursor) => cursor.toArray())

  const takes = Effect.fnUntraced(function* (connection: string, owner: string) {
    const [row] = yield* rows<{ credential: string }>(
      "SELECT credential FROM connections WHERE name = ?",
      connection,
    )

    if (row === undefined) return false

    const credential = decodeCredential(row.credential)

    return owner === "workspace" ? takesWorkspace(credential) : takesMine(credential)
  })

  const signins = yield* openSignIns(storage, sealer, reach, upstream.forget, outside, takes)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connections (
    name TEXT PRIMARY KEY, url TEXT NOT NULL,
    credential TEXT NOT NULL CHECK (credential IN ('none', 'workspace', 'person', 'both')),
    everyone TEXT NOT NULL CHECK (everyone IN ('none', 'read', 'all')),
    created TEXT NOT NULL, created_by TEXT NOT NULL, refreshed TEXT, problem TEXT)`)

  for (const column of ["provider", "sign_in"]) {
    const [has] = yield* rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pragma_table_info('connections') WHERE name = ?",
      column,
    )

    if (has?.n === 0) yield* sql.exec(`ALTER TABLE connections ADD COLUMN ${column} TEXT`)
  }

  const [apiColumn] = yield* rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pragma_table_info('connections') WHERE name = 'api'",
  )

  if (apiColumn?.n === 0) yield* sql.exec("ALTER TABLE connections ADD COLUMN api TEXT")

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_icons (
    connection TEXT PRIMARY KEY, type TEXT NOT NULL, body BLOB NOT NULL, hash TEXT NOT NULL,
    set_by TEXT NOT NULL, set_at TEXT NOT NULL)`)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_tools (
    connection TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, input TEXT NOT NULL,
    annotations TEXT NOT NULL, read_only INTEGER NOT NULL, PRIMARY KEY (connection, name))`)

  const [bindingColumn] = yield* rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pragma_table_info('connection_tools') WHERE name = 'binding'",
  )

  if (bindingColumn?.n === 0)
    yield* sql.exec("ALTER TABLE connection_tools ADD COLUMN binding TEXT")

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_levels (
    connection TEXT NOT NULL, subject TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('none', 'read', 'all')), PRIMARY KEY (connection, subject))`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_tool_marks (
    connection TEXT NOT NULL, tool TEXT NOT NULL,
    mark TEXT NOT NULL CHECK (mark IN ('disabled', 'read')), PRIMARY KEY (connection, tool, mark))`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, trace TEXT NOT NULL,
    person TEXT NOT NULL, runs_as TEXT NOT NULL, connection TEXT NOT NULL, tool TEXT NOT NULL,
    outcome TEXT NOT NULL, ms INTEGER NOT NULL, why TEXT NOT NULL)`)

  const [appColumn] = yield* rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pragma_table_info('connection_calls') WHERE name = 'app'",
  )

  if (appColumn?.n === 0)
    yield* sql.exec("ALTER TABLE connection_calls ADD COLUMN app TEXT NOT NULL DEFAULT ''")

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS app_consents (
    person TEXT NOT NULL, app TEXT NOT NULL, connection TEXT NOT NULL, tools TEXT NOT NULL,
    granted TEXT NOT NULL, PRIMARY KEY (person, app, connection))`)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS app_asks (
    person TEXT NOT NULL, app TEXT NOT NULL, connection TEXT NOT NULL, asked TEXT NOT NULL,
    PRIMARY KEY (person, app, connection))`)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_own (
    person TEXT NOT NULL, connection TEXT NOT NULL, level TEXT CHECK (level IN ('read', 'none')),
    off TEXT NOT NULL, changed TEXT NOT NULL, PRIMARY KEY (person, connection))`)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS level_asks (
    person TEXT NOT NULL, connection TEXT NOT NULL, want TEXT NOT NULL CHECK (want IN ('read', 'all')),
    note TEXT NOT NULL, asked TEXT NOT NULL, PRIMARY KEY (person, connection))`)

  // Access's saved checks, gone with the page: Events lists the calls themselves (storage.json "dropped").
  yield* sql.exec("DROP TABLE IF EXISTS access_checks")

  const commit = <A, E>(effect: Effect.Effect<A, E>) => storage.transaction(effect)

  const connectionRow = Effect.fnUntraced(function* (name: string, role: Role) {
    const [row] = yield* rows<ConnectionRow>("SELECT * FROM connections WHERE name = ?", name)

    if (row === undefined) {
      const names = (yield* rows<{ name: string }>(
        "SELECT name FROM connections ORDER BY name",
      )).map((r) => r.name)

      return yield* new Refused({
        message: `there's no connection "${name}" in this workspace${names.length === 0 ? (role === "admin" ? " (it has none yet: add one with bun run workspace connections add)" : " (it has none yet: the workspace's admins add them)") : `: it has ${names.join(", ")}`}`,
      })
    }

    return row
  })

  const toolsOf = Effect.fnUntraced(function* (connection: string) {
    return yield* rows<ToolRow>(
      "SELECT name, description, input, annotations, read_only FROM connection_tools WHERE connection = ? ORDER BY name",
      connection,
    )
  })

  const policyOf = Effect.fnUntraced(function* (row: ConnectionRow) {
    const levels = yield* rows<{ subject: string; level: string }>(
      "SELECT subject, level FROM connection_levels WHERE connection = ?",
      row.name,
    )

    const marks = yield* rows<{ tool: string; mark: string }>(
      "SELECT tool, mark FROM connection_tool_marks WHERE connection = ?",
      row.name,
    )

    const subjects = (prefix: string) =>
      new Map(
        levels.flatMap((l) =>
          l.subject.startsWith(prefix)
            ? [[l.subject.slice(prefix.length), decodeLevel(l.level)] as const]
            : [],
        ),
      )

    const marked = (mark: string) =>
      new Set(marks.flatMap((m) => (m.mark === mark ? [m.tool] : [])))

    const policy: Policy = {
      everyone: decodeLevel(row.everyone),
      groups: subjects("group:"),
      people: subjects("person:"),
      disabled: marked("disabled"),
      read: marked("read"),
    }

    return policy
  })

  const { hasCredential, brokenOf } = signins

  const ownOf = Effect.fnUntraced(function* (person: string, connection: string) {
    const [row] = yield* rows<{ level: string | null; off: string }>(
      "SELECT level, off FROM connection_own WHERE person = ? AND connection = ?",
      person,
      connection,
    )

    if (row === undefined) return NO_OWN

    const own: Own = {
      level: row.level === "read" || row.level === "none" ? row.level : undefined,
      off: new Set(decodeNames(row.off)),
    }

    return own
  })

  const factsOf = Effect.fnUntraced(function* (
    row: ConnectionRow,
    person: Who,
    directory: Directory,
    origin: string,
    policy?: Policy,
  ) {
    const tools = yield* toolsOf(row.name)

    const facts: Facts = {
      connection: row.name,
      credential: decodeCredential(row.credential),
      policy: policy ?? (yield* policyOf(row)),
      tools: new Map(tools.map((t) => [t.name, t.read_only === 1])),
      workspaceToken: yield* hasCredential(row.name, "workspace"),
      signIn: {
        kind: yield* signins.kindOf(row.name),
        workspaceBroken: (yield* brokenOf(row.name, "workspace"))?.why,
        ownBroken: (yield* brokenOf(row.name, person.id))?.why,
      },
      person: {
        id: person.id,
        email: person.email,
        name: person.name,
        groups: person.groups,
        removed: person.status === "removed",
        ownToken: yield* hasCredential(row.name, person.id),
        admin: person.role === "admin",
        own: yield* ownOf(person.id, row.name),
      },
      admins: yield* directory.admins(),
      origin,
    }

    return { facts, tools }
  })

  const refresh = Effect.fn("Connections.refresh")(function* (
    row: ConnectionRow,
    owner: string | undefined,
    origin: string,
    read?: Read,
    picked: ReadonlyArray<string> = [],
  ) {
    const api = apiOf(row)

    const listed = yield* Effect.result(
      Effect.gen(function* () {
        yield* resolvesPrivate(row.url)

        const to = yield* upstreamFor(row, owner, owner ?? "lister", origin, undefined).upstream

        if (api === undefined) return yield* upstream.listTools(to)

        const source =
          read ??
          (yield* readSource(
            row.name,
            api.kind,
            api.spec,
            row.url,
            api.auth,
            to.credential.token,
            reach,
            api.tags,
            fixesOf(row.provider),
          ))

        const tools: ReadonlyArray<UpstreamTool | ApiTool> = source.tools

        return tools
      }),
    )

    const now = new Date().toISOString()

    if (Result.isFailure(listed)) {
      yield* sql.exec(
        "UPDATE connections SET problem = ? WHERE name = ?",
        `${now.slice(0, 16)}: ${listed.failure.message}`,
        row.name,
      )
      yield* Effect.logWarning(`connection ${row.name}: refresh failed: ${listed.failure.message}`)

      return { refreshed: false as const, problem: listed.failure.message }
    }

    const tools = listed.success
    const before = new Set((yield* toolsOf(row.name)).map((t) => t.name))

    const listedBefore = new Map(
      (yield* rows<{ name: string; binding: string | null; read_only: number }>(
        "SELECT name, binding, read_only FROM connection_tools WHERE connection = ?",
        row.name,
      )).map((t) => [t.name, t]),
    )

    const known = (tool: UpstreamTool | ApiTool) => {
      const was = listedBefore.get(tool.name)

      return (
        was !== undefined &&
        (!tool.readOnly || was.read_only === 1) &&
        (!("binding" in tool) || was.binding === JSON.stringify(tool.binding))
      )
    }

    const reviewed = (tool: UpstreamTool | ApiTool) =>
      "tags" in tool && tool.tags.some((tag) => picked.includes(tag))

    const held =
      before.size === 0 ? [] : tools.flatMap((t) => (known(t) || reviewed(t) ? [] : [t.name]))

    yield* commit(
      Effect.gen(function* () {
        yield* sql.exec("DELETE FROM connection_tools WHERE connection = ?", row.name)

        for (const tool of held) {
          yield* sql.exec(
            "INSERT OR IGNORE INTO connection_tool_marks (connection, tool, mark) VALUES (?, ?, 'disabled')",
            row.name,
            tool,
          )
        }

        for (const tool of tools) {
          yield* sql.exec(
            `INSERT OR REPLACE INTO connection_tools (connection, name, description, input, annotations, read_only, binding)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            row.name,
            tool.name,
            tool.description,
            JSON.stringify(tool.inputSchema),
            JSON.stringify(tool.annotations),
            tool.readOnly ? 1 : 0,
            "binding" in tool ? JSON.stringify(tool.binding) : null,
          )
        }

        yield* sql.exec(
          "UPDATE connections SET refreshed = ?, problem = NULL WHERE name = ?",
          now,
          row.name,
        )
      }),
    )
    yield* Effect.logInfo(
      `connection ${row.name}: listed ${tools.length} tools${held.length === 0 ? "" : `; new (or sent another way) since the last list, held off until an admin turns them on: ${held.join(", ")}`}`,
    )

    return { refreshed: true as const, tools: tools.length, held }
  })

  const upstreamFor = (
    row: ConnectionRow,
    owner: string | undefined,
    session: string,
    origin: string,
    tool: string | undefined,
  ) => {
    let own: Refused | undefined

    const mine = <A, R>(effect: Effect.Effect<A, Refused, R>) =>
      Effect.tapError(effect, (refused) =>
        Effect.sync(() => {
          own = refused
        }),
      )

    const missingScope = (scope: string) => {
      // The challenge's scope is what would do: one scope, or (Google) several that each would,
      // the narrowest first. The first is what Connect again asks for.
      const would = scopesOf(scope)
      const first = would[0] ?? scope
      const url = connectUrl(origin, row.name, owner === "workspace" ? "workspace" : "mine", first)

      return new Refused({
        message: `${row.name} needs ${would.length > 1 ? `one of the scopes ${would.slice(0, 4).join(", ")}${would.length > 4 ? ", ..." : ""}` : `the scope ${first}`} for ${tool ?? "this"}, and the sign-in this ran with didn't grant it: ${owner === "workspace" ? "a workspace admin connects it again asking for it: send one this link" : "connect again asking for it: open (or send the person) this link"}, ${url}`,
        connect: { url, why: "scope" },
      })
    }

    const mode = row.sign_in === "oauth" || row.sign_in === "token" ? row.sign_in : undefined

    const reaching = Effect.gen(function* () {
      const call =
        owner === undefined ? undefined : yield* mine(signins.tokenFor(row.name, owner, origin))

      const credential: UpstreamCredential =
        call?.kind === "signed_in"
          ? {
              kind: "signed_in",
              token: call.token,
              renew: mine(call.renew),
              turnedDown: call.turnedDown,
              missingScope,
            }
          : {
              kind: "unsigned",
              token: call?.token,
              challenged: (challenge: string) =>
                mine(
                  signins.challenged(
                    row.name,
                    row.url,
                    row.credential === "none",
                    mode,
                    owner,
                    challenge,
                    origin,
                  ),
                ),
            }

      const to: Upstream = {
        connection: row.name,
        url: row.url,
        key: keyOf(row.name, session),
        credential,
      }

      return to
    })

    return { upstream: reaching, own: () => own }
  }

  const listerOf = Effect.fnUntraced(function* (row: ConnectionRow, asker: string | undefined) {
    if (row.credential === "none") return undefined

    if (yield* hasCredential(row.name, "workspace")) return "workspace"

    if (asker !== undefined && (yield* hasCredential(row.name, asker))) return asker

    return undefined
  })

  const testCall = Effect.fnUntraced(function* (
    row: ConnectionRow,
    auth: ApiAuth,
    test: { readonly tool: string; readonly input: Json; readonly expect: string },
  ) {
    const [bound] = yield* rows<{ binding: string | null }>(
      "SELECT binding FROM connection_tools WHERE connection = ? AND name = ?",
      row.name,
      test.tool,
    )

    const binding =
      bound?.binding === null || bound === undefined
        ? undefined
        : Option.getOrUndefined(decodeBinding(bound.binding))

    if (binding === undefined)
      return { tool: test.tool, ok: false, said: `${row.name} has no tool ${test.tool}` }

    const called = yield* Effect.result(
      callApi(row.name, test.tool, row.url, auth, binding, test.input, undefined, reach),
    )

    if (Result.isFailure(called))
      return { tool: test.tool, ok: false, said: called.failure.message.slice(0, 300) }

    const said = textOf(called.success)

    return {
      tool: test.tool,
      ok: called.success.isError !== true && said.includes(test.expect),
      said: said.replace(/\s+/g, " ").slice(0, 200),
    }
  })

  const viewOf = Effect.fnUntraced(function* (
    row: ConnectionRow,
    person: Person,
    directory: Directory,
    origin: string,
    withInput: boolean,
    listing: Listing,
  ) {
    const { facts, tools: all } = yield* factsOf(row, person, directory, origin)
    const words = listing.search === undefined ? [] : wordsOf(listing.search)

    const tools =
      words.length > 0
        ? all
            .map((t) => {
              const name = plain(t.name)
              const about = plain(firstLine(t.description))

              const score = words.reduce(
                (n, w) => n + (name.includes(w) ? 2 : about.includes(w) ? 1 : 0),
                0,
              )

              return { t, score }
            })
            .filter((m) => m.score > 0)
            .toSorted(
              (a, b) =>
                b.score - a.score ||
                a.t.name.length - b.t.name.length ||
                a.t.name.localeCompare(b.t.name),
            )
            .filter((m, _, ranked) => m.score * 2 >= (ranked[0]?.score ?? 0))
            .slice(0, listing.brief ?? SEARCH_MAX)
            .map((m) => m.t)
        : all.length > listing.past
          ? []
          : all

    const more =
      tools.length === all.length
        ? undefined
        : words.length > 0
          ? `the ${tools.length} of its ${all.length} tools that match "${listing.search ?? ""}" best: search other words for others`
          : `${all.length} tools, too many to list here (tools is empty only for that, not because you can't use them): connections({ connection: "${row.name}", search: "<what you need, like list repos>" }) finds them, with their input schemas`

    const level = levelOf(facts.policy, facts.person)
    const own = facts.person.own
    const credential = judgeCredential(facts, undefined)

    const [asked] = yield* rows<{ want: string }>(
      "SELECT want FROM level_asks WHERE person = ? AND connection = ?",
      person.id,
      row.name,
    )

    const runsAs =
      level.level === "none"
        ? `nothing: your level is none (from ${level.from}), so no call runs, whatever token is set. ${askAdmins(facts, `give you more on ${row.name}`, `bun run workspace access ${row.name} person:${facts.person.email} read`)}`
        : credential.allowed
          ? RUNS_AS[credential.runsAs]
          : credential.message

    const connectFirst =
      !credential.allowed && level.level !== "none" ? credential.connect : undefined

    const view: ConnectionView = {
      connection: row.name,
      url: row.url,
      credential: facts.credential,
      workspaceToken: takesWorkspace(facts.credential)
        ? facts.workspaceToken
          ? "set"
          : "missing"
        : "not used",
      yourToken: takesMine(facts.credential)
        ? facts.person.ownToken
          ? "set"
          : "missing"
        : "not used",
      runsAs,
      level: level.level,
      levelFrom: level.from,
      ownLevel: own.level ?? "all",
      ownOff: [...own.off].toSorted(),
      gets: lower(level.level, own.level ?? "all"),
      toolCount: all.length,
      tools: tools.map((t) => {
        const judged = judgeTool(facts, t.name)

        const why =
          shortWhy(judged, level) ??
          (connectFirst === undefined
            ? undefined
            : `${connectFirst.why === "reconnect" ? "the sign-in stopped working" : "not connected"}: ${connectFirst.url}`)

        const shown = {
          tool: `${row.name}.${t.name}`,
          description: firstLine(t.description),
          readOnly: isRead(facts, t.name),
          usable: judged.allowed && connectFirst === undefined,
          disabled: facts.policy.disabled.has(t.name),
        }

        const explained = why === undefined ? shown : { ...shown, why }

        return (withInput || words.length > 0) && listing.brief === undefined
          ? { ...explained, input: decodeJson(t.input) }
          : explained
      }),
    }

    const listed = more === undefined ? view : { ...view, moreTools: more }
    const kind = apiOf(row)?.kind
    const kinded = kind === undefined ? listed : { ...listed, kind }

    const want = asked === undefined ? undefined : decodeLevel(asked.want)

    const asking =
      want === undefined || RANK[want] <= RANK[level.level] ? kinded : { ...kinded, asked: want }

    const missing =
      takesMine(facts.credential) && !facts.person.ownToken && level.level !== "none"
        ? { ...asking, setYourToken: setTokenHint(row.name, origin, facts.signIn.kind) }
        : asking

    const { workspaceBroken, ownBroken } = facts.signIn

    const reconnect =
      ownBroken !== undefined && takesMine(facts.credential)
        ? `your sign-in stopped working (${ownBroken}): connect it again with ${connectUrl(origin, row.name, "mine")}`
        : workspaceBroken !== undefined && takesWorkspace(facts.credential)
          ? `the workspace's sign-in stopped working (${workspaceBroken}): a workspace admin connects it again with ${connectUrl(origin, row.name, "workspace")}`
          : undefined

    const ownReason =
      ownBroken !== undefined && takesMine(facts.credential)
        ? yield* signins.brokenOf(row.name, person.id)
        : undefined

    const workspaceReason =
      ownReason === undefined && workspaceBroken !== undefined && takesWorkspace(facts.credential)
        ? yield* signins.brokenOf(row.name, "workspace")
        : undefined

    const reason = ownReason ?? workspaceReason

    const reconnectReason =
      reason === undefined
        ? undefined
        : {
            whose: ownReason === undefined ? ("workspace" as const) : ("yours" as const),
            kind: reason.kind,
            at: new Date(reason.at).toISOString(),
          }

    const scopes =
      facts.signIn.kind === "token" ? undefined : yield* signins.scopesShown(row.name, person.id)

    const signed =
      scopes === undefined
        ? missing
        : reconnect === undefined || reconnectReason === undefined
          ? { ...missing, signIn: "oauth" as const, scopes }
          : { ...missing, signIn: "oauth" as const, reconnect, reconnectReason, scopes }

    const linked = connectFirst === undefined ? signed : { ...signed, connect: connectFirst }

    const waiting =
      facts.signIn.kind === "oauth" && (yield* signins.needsApp(row.name, origin))
        ? { ...linked, needsApp: true as const }
        : linked

    const provided = row.provider === null ? waiting : { ...waiting, provider: row.provider }

    return row.problem === null ? provided : { ...provided, problem: row.problem }
  })

  const recordCall = Effect.fnUntraced(function* (call: Omit<CallRow, "id">) {
    yield* sql.exec(
      `INSERT INTO connection_calls (at, trace, person, runs_as, connection, tool, outcome, ms, why, app)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      call.at,
      call.trace,
      call.person,
      call.runs_as,
      call.connection,
      call.tool,
      call.outcome,
      call.ms,
      call.why.slice(0, 300),
      call.app,
    )
    yield* sql.exec(
      "DELETE FROM connection_calls WHERE id <= (SELECT MAX(id) FROM connection_calls) - ?",
      KEEP_CALLS,
    )
  })

  const activity = Effect.fnUntraced(function* (
    connection: string | undefined,
    person: string | undefined,
    app: string | undefined,
    limit: number,
  ) {
    return yield* rows<CallRow>(
      `SELECT id, at, trace, person, runs_as, connection, tool, outcome, ms, why, app FROM connection_calls
       WHERE (? IS NULL OR connection = ?) AND (? IS NULL OR person = ?) AND (? IS NULL OR app = ?)
       ORDER BY id DESC LIMIT ?`,
      connection ?? null,
      connection ?? null,
      person ?? null,
      person ?? null,
      app ?? null,
      app ?? null,
      limit,
    )
  })

  const startSignIn = Effect.fnUntraced(function* (
    person: Person,
    name: string,
    whose: "me" | "workspace",
    origin: string,
    back: string,
    more: ReadonlyArray<string> = [],
  ) {
    const row = yield* connectionRow(name, person.role)
    const credential = decodeCredential(row.credential)
    const signIn = yield* signins.signInOf(name)

    if (signIn === undefined)
      return yield* new Refused({
        message: `${name} doesn't sign in with OAuth: its token is pasted, ${whose === "workspace" ? "the workspace's by a workspace admin" : "yours by you"}, on ${origin}/_connections/${name} (never in a chat with an agent)`,
      })

    if (whose === "workspace" && !takesWorkspace(credential))
      return yield* new Refused({
        message: `${name} takes each person's own sign-in, not the workspace's: each connects their own with ${connectUrl(origin, name, "mine")}`,
      })

    if (whose === "workspace" && person.role !== "admin")
      return yield* new Refused({
        message: `only a workspace admin connects ${name} for the workspace; you can connect your own${takesMine(credential) ? "" : `, but ${name} takes only the workspace's`}`,
      })

    if (whose === "me" && !takesMine(credential))
      return yield* new Refused({
        message: `${name} takes only the workspace's sign-in, which a workspace admin connects: nobody connects their own`,
      })

    const started = yield* signins.start(
      name,
      signIn,
      whose === "workspace" ? "workspace" : person.id,
      person,
      origin,
      back,
      more,
    )

    return {
      connection: name,
      for: whose === "workspace" ? "the workspace" : person.email,
      url: started.url,
      expires: started.expires,
      note: `Open the url in a browser signed in to OpenBelt as ${person.email} within 10 minutes, sign in to ${name} there and allow OpenBelt; it comes back to ${origin}/_connections/${name}.`,
    }
  })

  const finishSignIn = Effect.fnUntraced(function* (
    person: Person,
    answer: SignInReturn,
    origin: string,
    arrived: string,
  ) {
    const done = yield* signins.finish(person, answer, origin, arrived)
    const row = yield* connectionRow(done.connection, person.role)

    const listed =
      row.refreshed === null || row.problem !== null
        ? yield* refresh(row, done.owner, origin)
        : undefined

    return {
      connection: done.connection,
      back: done.back,
      whose: done.whose,
      message: `${done.connection} is connected for ${done.owner === "workspace" ? "everyone in the workspace" : "you"}: calls run as the account you signed in with.${listed !== undefined && !listed.refreshed ? ` Listing its tools failed: ${listed.problem}` : ""}`,
    }
  })

  const setToken = Effect.fnUntraced(function* (
    row: ConnectionRow,
    owner: string,
    text: string | undefined,
    by: string,
    origin: string,
  ) {
    if (text === undefined) return { cleared: yield* signins.clear(row.name, owner) }

    const token = tokenOf(text)

    if (!TOKEN.test(token)) {
      return yield* new Refused({
        message:
          token === ""
            ? 'send the token as the request body (raw, or JSON {"token": "..."}): bun run workspace connections token reads it from stdin or --from-env'
            : "that isn't a token: one line of printable characters without spaces, up to 8 KB",
      })
    }

    yield* signins.setPasted(row.name, owner, token, by, origin)

    return { set: true }
  })

  const setOwnToken = Effect.fnUntraced(function* (
    me: Person,
    name: string,
    text: string | undefined,
    log: (line: string) => Effect.Effect<void>,
    origin: string,
  ) {
    const row = yield* connectionRow(name, me.role)

    if (!takesMine(decodeCredential(row.credential))) {
      return yield* new Refused({
        message: `${name} ${row.credential === "none" ? "takes no token" : "takes only the workspace's token, which an admin sets"}: people don't set their own`,
      })
    }

    const changed = yield* setToken(row, me.id, text, me.email, origin)

    yield* log(`${text === undefined ? "cleared" : "set"} their own token for ${name}`)

    const listed =
      text !== undefined && row.refreshed === null && !(yield* hasCredential(name, "workspace"))
        ? yield* refresh(row, me.id, origin)
        : undefined

    const answer = {
      connection: name,
      yourToken: text === undefined ? "cleared" : "set",
      ...changed,
    }

    return listed === undefined ? answer : { ...answer, listed }
  })

  const disconnect = Effect.fnUntraced(function* (
    person: Person,
    name: string,
    whose: "me" | "workspace",
    log: (line: string) => Effect.Effect<void>,
    origin: string,
  ) {
    if (whose === "me") return yield* setOwnToken(person, name, undefined, log, origin)

    const row = yield* connectionRow(name, person.role)

    if (person.role !== "admin")
      return yield* new Refused({
        message: `only a workspace admin disconnects ${name} for the workspace`,
      })

    const changed = yield* setToken(row, "workspace", undefined, person.email, origin)

    yield* log(`disconnected the workspace's sign-in to ${name}`)

    return { connection: name, workspaceToken: "cleared", ...changed }
  })

  const setOwn = Effect.fnUntraced(function* (
    me: Person,
    name: string,
    asked:
      | { readonly level: "all" | "read" | "none" }
      | { readonly tool: string; readonly on: boolean },
    log: (line: string) => Effect.Effect<void>,
  ) {
    const row = yield* connectionRow(name, me.role)
    const was = yield* ownOf(me.id, row.name)
    const off = new Set(was.off)
    let level = was.level

    const change = "tool" in asked ? { ...asked, tool: bare(row.name, asked.tool) } : asked

    if ("level" in change) level = change.level === "all" ? undefined : change.level
    else {
      if (!(yield* toolsOf(row.name)).some((t) => t.name === change.tool))
        return yield* new Refused({
          message: `${row.name} has no tool "${change.tool}" (the connections tool lists its tools)`,
        })

      if (change.on) off.delete(change.tool)
      else off.add(change.tool)
    }

    yield* level === undefined && off.size === 0
      ? sql.exec("DELETE FROM connection_own WHERE person = ? AND connection = ?", me.id, row.name)
      : sql.exec(
          `INSERT INTO connection_own (person, connection, level, off, changed) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (person, connection) DO UPDATE SET level = excluded.level, off = excluded.off, changed = excluded.changed`,
          me.id,
          row.name,
          level ?? null,
          JSON.stringify([...off].toSorted()),
          new Date().toISOString(),
        )

    yield* log(
      "level" in change
        ? `chose ${change.level} for themselves on ${row.name}`
        : `turned ${row.name}.${change.tool} ${change.on ? "on" : "off"} for themselves`,
    )

    return { connection: row.name, own: { level: level ?? "all", off: [...off].toSorted() } }
  })

  const unask = Effect.fnUntraced(function* (
    me: Person,
    name: string,
    log: (line: string) => Effect.Effect<void>,
  ) {
    yield* connectionRow(name, me.role)
    yield* sql.exec("DELETE FROM level_asks WHERE person = ? AND connection = ?", me.id, name)
    yield* log(`took back their ask for more on ${name}`)
  })

  const askMore = Effect.fnUntraced(function* (
    me: Person,
    name: string,
    want: "read" | "all" | undefined,
    note: string,
    directory: Directory,
    origin: string,
    log: (line: string) => Effect.Effect<void>,
  ) {
    const row = yield* connectionRow(name, me.role)
    const { facts } = yield* factsOf(row, me, directory, origin)
    const has = levelOf(facts.policy, facts.person).level

    if (has === "all")
      return yield* new Refused({
        message: `${me.email} already has every tool the workspace gives on ${row.name} (level all): there's nothing more to ask for`,
      })

    const wanted = want ?? (has === "none" ? "read" : "all")

    const why = note.replaceAll(/\s+/g, " ").trim()

    if (why.length > NOTE_MAX)
      return yield* new Refused({
        message: `say why in ${NOTE_MAX} characters or fewer (this is ${why.length})`,
      })

    if (RANK[wanted] <= RANK[has])
      return yield* new Refused({
        message: `${me.email}'s level on ${row.name} is already ${has}: ask for all`,
      })

    yield* sql.exec(
      `INSERT INTO level_asks (person, connection, want, note, asked) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (person, connection) DO UPDATE SET want = excluded.want, note = excluded.note, asked = excluded.asked`,
      me.id,
      row.name,
      wanted,
      why,
      new Date().toISOString(),
    )
    yield* log(`asked the admins for ${wanted} on ${row.name}${why === "" ? "" : `: ${why}`}`)

    return { connection: row.name, asked: wanted }
  })

  const openAsks = Effect.fnUntraced(function* (everyone: ReadonlyArray<Person>) {
    const cutoff = new Date(Date.now() - ASK_DAYS * 86_400_000).toISOString()

    yield* sql.exec("DELETE FROM level_asks WHERE asked < ?", cutoff)

    const all = yield* rows<{
      person: string
      connection: string
      want: string
      note: string
      asked: string
    }>("SELECT person, connection, want, note, asked FROM level_asks ORDER BY asked DESC")

    const byId = new Map<string, Person>(everyone.map((p) => [p.id, p]))
    const policies = new Map<string, Policy | undefined>()

    const open = []

    for (const a of all) {
      if (!policies.has(a.connection)) {
        const [row] = yield* rows<ConnectionRow>(
          "SELECT * FROM connections WHERE name = ?",
          a.connection,
        )

        policies.set(a.connection, row === undefined ? undefined : yield* policyOf(row))
      }

      const policy = policies.get(a.connection)
      const person = byId.get(a.person)
      const want = decodeWant(a.want)
      const now = person === undefined || policy === undefined ? undefined : levelOf(policy, person)

      if (person === undefined || now === undefined || RANK[now.level] >= RANK[want]) {
        yield* sql.exec(
          "DELETE FROM level_asks WHERE person = ? AND connection = ?",
          a.person,
          a.connection,
        )
        continue
      }

      open.push({ person, connection: a.connection, want, note: a.note, asked: a.asked, now })
    }

    return open
  })

  const askGroups = Effect.fnUntraced(function* (everyone: ReadonlyArray<Person>) {
    const open = yield* openAsks(everyone)
    const keyed = new Map<string, typeof open>()

    for (const a of open) {
      const group = `${a.connection}|${a.want}`

      keyed.set(group, [...(keyed.get(group) ?? []), a])
    }

    const emails = new Map(everyone.map((p) => [p.email, p.id]))

    const groups = yield* Effect.forEach([...keyed.values()], (asks) =>
      Effect.gen(function* () {
        const first = asks[0] ?? (yield* Effect.die("a group has an ask"))
        const row = yield* connectionRow(first.connection, "admin")
        const policy = yield* policyOf(row)
        const asked = new Set(asks.map((a) => a.person.id))
        const sources = new Map<string, number>()

        for (const a of asks) sources.set(a.now.from, (sources.get(a.now.from) ?? 0) + 1)

        const candidates: ReadonlyArray<Subject> = [
          "everyone",
          ...new Set(asks.flatMap((a) => a.person.groups.map((g) => `group:${g}`))),
        ]

        const scored = candidates.flatMap((who) => {
          const after = withChange(policy, { who, level: first.want }, emails)
          const moved = movedBy(policy, after, everyone)

          const answered = asks.filter(
            (a) => RANK[levelOf(after, a.person).level] >= RANK[first.want],
          )

          const others = moved.filter((p) => !asked.has(p.id))

          return answered.length === 0 || others.length !== 0
            ? []
            : [{ who, answered: answered.length, moved, others }]
        })

        const best = scored.toSorted(
          (x, y) =>
            y.answered - y.others.length - (x.answered - x.others.length) ||
            x.others.length - y.others.length,
        )[0]

        return {
          connection: first.connection,
          want: first.want,
          asks: asks.map((a) => ({
            email: a.person.email,
            name: a.person.name,
            groups: a.person.groups,
            note: a.note,
            asked: a.asked,
            level: a.now.level,
            from: a.now.from,
          })),
          sources: [...sources].toSorted((x, y) => y[1] - x[1]),
          nextActions: asks.map((a) => ({
            tool: "connection_access_request_grant",
            input: { connection: a.connection, want: a.want, person: a.person.email },
            affects: [a.person.email],
          })),
          suggestion:
            best === undefined
              ? null
              : {
                  who: best.who,
                  answered: best.answered,
                  moved: best.moved.map((p) => p.email),
                  others: best.others.map((p) => p.email),
                },
        }
      }),
    )

    return groups.toSorted(
      (x, y) => y.asks.length - x.asks.length || x.connection.localeCompare(y.connection),
    )
  })

  const act = Effect.fnUntraced(function* (
    workspace: string,
    origin: string,
    caller: Caller,
    route: string,
    method: string,
    text: string,
    trace: string,
    directory: Directory,
  ) {
    const fail = (status: number, code: ErrorCode, error: string): Answer => ({
      status,
      body: { error: redact(error, tokenOf(text)), code, trace },
    })

    const done = (answer: Readonly<Record<string, Json>>): Answer => ({
      status: 200,
      body: { ...answer, trace },
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
              new Refused({ message: `send JSON like ${usage} (${issue.message.split("\n")[0]})` }),
            ),
          onSuccess: (value: S["Type"]) => Effect.succeed(value),
        },
      )

    const log = (line: string) =>
      Effect.logInfo(`${workspace}: ${caller.email} ${line}`).pipe(
        Effect.annotateLogs({ trace, workspace }),
      )

    const member = Effect.fnUntraced(function* (who: string) {
      const person = yield* directory.find(who)

      if (person.status === "removed")
        return yield* new Refused({
          message: `${person.email} was removed from the workspace, so nothing set for them counts: invite them again first (bun run workspace people invite ${person.email})`,
        })

      return person
    })

    const parts = route.split("/")
    const [scope = "", noun = ""] = parts

    const run = Effect.gen(function* () {
      if (scope === "me") {
        const me = yield* directory.find(caller.id)

        if (method === "GET" && parts.length === 2) {
          const all = yield* rows<ConnectionRow>("SELECT * FROM connections ORDER BY name")

          return done({
            connections: yield* Effect.forEach(all, (row) =>
              viewOf(row, me, directory, origin, false, EVERY_TOOL),
            ),
          })
        }

        const [, , name = "", what = "", clear] = parts

        if (method === "POST" && what === "token" && (clear === undefined || clear === "clear"))
          return done(
            yield* setOwnToken(me, name, clear === undefined ? text : undefined, log, origin),
          )

        if (method === "POST" && what === "connect" && clear === undefined) {
          const asked = yield* body(ConnectBody, '{"scope": "a scope a tool needed"}')

          return done(yield* startSignIn(me, name, "me", origin, "", scopesOf(asked.scope ?? "")))
        }

        if (method === "POST" && what === "signin" && clear === "refresh")
          return done(yield* signins.refreshNow(name, me.id, origin))

        if (method === "POST" && what === "own" && clear === undefined) {
          const asked = yield* body(OwnLevel, '{"level": "all" | "read" | "none"}')

          return done(yield* setOwn(me, name, asked, log))
        }

        if (method === "POST" && what === "own" && clear === "tool") {
          const asked = yield* body(OwnTool, '{"tool": "create_issue", "on": false}')

          return done(yield* setOwn(me, name, asked, log))
        }

        if (method === "POST" && what === "ask" && clear === undefined) {
          const asked = yield* body(AskMore, '{"want": "read" | "all", "note": "why you need it"}')

          return done(
            yield* askMore(me, name, asked.want, asked.note ?? "", directory, origin, log),
          )
        }

        if (method === "POST" && what === "ask" && clear === "cancel") {
          yield* unask(me, name, log)

          return done({ connection: name, asked: null })
        }

        return fail(
          404,
          "missing",
          `there's no ${method} /_${route}. /_me/connections lists the workspace's connections as you see them; POST /_me/connections/<name>/token sets your own token (the body is the token), and /_me/connections/<name>/token/clear clears it (or disconnects a sign-in); /connect gives the link that signs you in to a server that takes OAuth; /own {"level"} and /own/tool {"tool", "on"} choose less for yourself; /ask {"want", "note"} asks the admins for more, /ask/cancel takes it back.`,
        )
      }

      if (caller.role !== "admin") {
        const admins = yield* directory.admins()

        return fail(
          403,
          "not_admin",
          `/_${route} is for ${workspace}'s admins, and ${caller.email} is a member. ${admins.length === 0 ? "The workspace has no admins yet." : `Ask ${admins.join(" or ")}.`} The connections tool (MCP) or GET /_me/connections shows what you can use, and why.`,
        )
      }

      if (noun === "connections") {
        const [, , name = "", what = "", clear] = parts

        if (method === "GET" && parts.length === 2) {
          const all = yield* rows<ConnectionRow>("SELECT * FROM connections ORDER BY name")

          return done({
            connections: yield* Effect.forEach(all, (row) => describe(row, directory, origin)),
          })
        }

        if (method === "GET" && parts.length === 3)
          return done({
            connection: yield* describe(yield* connectionRow(name, "admin"), directory, origin),
          })

        if (method === "POST" && name === "add") {
          const sent = yield* body(
            Schema.Union([CatalogAdd, NewApiConnection, NewConnection]),
            '{"provider": "linear"} (OpenBelt\'s catalog), {"name": "deepwiki", "url": "https://mcp.deepwiki.com/mcp", "credential": "none" | "workspace" | "person" | "both", "everyone": "read"}, or an API: {"name": "petstore", "kind": "openapi" | "graphql", "spec": "<the OpenAPI spec\'s URL>", "credential": "none"}',
          )

          const addApi = Effect.fnUntraced(function* (adding: ApiAdd) {
            const nameProblem = connectionNameProblem(adding.name)

            if (nameProblem !== undefined) return yield* new Refused({ message: nameProblem })

            const auth = adding.auth === undefined ? undefined : authFrom(adding.auth)

            if (adding.auth !== undefined && auth === undefined)
              return yield* new Refused({
                message: `auth "${adding.auth.slice(0, 60)}" isn't one OpenBelt knows: bearer, basic (the token is user:password), header:<name> (an API key header) or query:<name>`,
              })

            if (adding.kind === "openapi" && adding.spec === undefined)
              return yield* new Refused({
                message:
                  "an OpenAPI connection needs spec: the spec's URL (JSON or YAML), read again on every refresh",
              })

            if (adding.kind === "graphql" && adding.url === undefined)
              return yield* new Refused({
                message:
                  "a GraphQL connection needs url: its endpoint, like https://countries.trevorblades.com",
              })

            const read =
              adding.kind === "openapi"
                ? yield* readSource(
                    adding.name,
                    "openapi",
                    adding.spec ?? null,
                    "",
                    BEARER,
                    undefined,
                    reach,
                    adding.tags ?? null,
                    fixesOf(adding.provider),
                  )
                : undefined

            const base = adding.url ?? read?.base
            const problem = baseProblem(base, reach)

            if (problem !== undefined || base === undefined)
              return yield* new Refused({
                message: `${problem ?? "no base URL"}${read?.base !== undefined && adding.url === undefined ? ` (the spec's server is ${read.base}): send the API's base URL as url` : ""}`,
              })

            yield* resolvesPrivate(base)

            const [existing] = yield* rows<ConnectionRow>(
              "SELECT * FROM connections WHERE name = ?",
              adding.name,
            )

            const before = existing === undefined ? undefined : apiOf(existing)

            const source = {
              kind: adding.kind,
              spec: adding.spec ?? null,
              auth: auth ?? read?.auth ?? BEARER,
              tags: adding.tags ?? null,
            }

            yield* commit(
              Effect.gen(function* () {
                yield* sql.exec(
                  `INSERT INTO connections (name, url, credential, everyone, created, created_by, provider, sign_in, api)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (name) DO UPDATE SET url = excluded.url, credential = excluded.credential,
                     everyone = COALESCE(?, everyone), provider = excluded.provider, sign_in = excluded.sign_in, api = excluded.api`,
                  adding.name,
                  base,
                  adding.credential,
                  adding.everyone ?? "read",
                  new Date().toISOString(),
                  caller.email,
                  adding.provider,
                  adding.credential === "none"
                    ? null
                    : adding.signIn === undefined
                      ? "token"
                      : "oauth",
                  JSON.stringify(source),
                  adding.everyone ?? null,
                )
              }),
            )

            const moved = existing !== undefined && serverOf(existing.url) !== serverOf(base)

            if (moved) {
              yield* signins.moved(adding.name)
              yield* sql.exec("DELETE FROM app_consents WHERE connection = ?", adding.name)
            }

            const row = yield* connectionRow(adding.name, "admin")

            const signIn =
              adding.signIn === undefined || adding.credential === "none"
                ? yield* signins.discover(
                    row.name,
                    row.url,
                    true,
                    "token",
                    origin,
                    undefined,
                    undefined,
                  )
                : yield* signins.discoverApi(
                    row.name,
                    row.url,
                    adding.signIn.issuer,
                    origin,
                    adding.signIn.scopes,
                    adding.signIn.params,
                  )

            const picked = (adding.tags ?? ["*"]).filter(
              (t) => before?.tags === undefined || before.tags === null || !before.tags.includes(t),
            )

            const listed = yield* refresh(
              row,
              yield* listerOf(row, caller.id),
              origin,
              read,
              before === undefined
                ? []
                : picked.includes("*")
                  ? (read?.tools ?? []).flatMap((t) => t.tags)
                  : picked,
            )

            yield* log(
              `${existing === undefined ? "added" : "changed"} the connection ${adding.name} (${adding.provider === null ? "" : `the catalog's ${adding.provider}, `}${adding.kind} at ${base}${adding.spec === undefined ? "" : `, spec ${adding.spec}`}, credential ${adding.credential}, ${signIn === undefined ? `token as ${authShown(source.auth)}` : `signs in with OAuth at ${signIn.server.issuer}`}${adding.tags === undefined ? "" : `, tags ${adding.tags.join(", ")}`})${moved ? "; it moved to a new host, so its tokens and apps' consents were cleared" : ""}`,
            )

            const added = {
              connection: yield* describe(
                yield* connectionRow(adding.name, "admin"),
                directory,
                origin,
              ),
              added: existing === undefined,
              tokensCleared: moved,
              listed,
            }

            const test = testOf(adding.provider)

            if (test === undefined) return done(added)

            const tested = yield* testCall(row, source.auth, test)

            yield* log(
              `tested ${adding.name}.${test.tool}: ${tested.ok ? "ok" : "failed"}: ${tested.said}`,
            )

            return done({ ...added, tested })
          })

          if ("kind" in sent)
            return yield* addApi({
              name: sent.name,
              kind: sent.kind,
              spec: sent.spec,
              url: sent.url,
              credential: sent.credential,
              everyone: sent.everyone,
              auth: sent.auth,
              tags: sent.tags,
              provider: null,
            })

          const catalogApi = "provider" in sent ? apiFromCatalog(sent) : undefined

          if (catalogApi !== undefined) return yield* addApi(catalogApi)

          const asked =
            "provider" in sent
              ? yield* fromCatalog(sent)
              : { ...sent, provider: providerAt({ url: sent.url }), readOnlyTools: NO_TOOLS }

          const problem =
            connectionNameProblem(asked.name) ?? urlProblem(asked.url, reach, "connection")

          if (problem !== undefined) return yield* new Refused({ message: problem })

          yield* resolvesPrivate(asked.url)

          const [existing] = yield* rows<ConnectionRow>(
            "SELECT * FROM connections WHERE name = ?",
            asked.name,
          )

          yield* sql.exec(
            `INSERT INTO connections (name, url, credential, everyone, created, created_by, provider, sign_in)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET url = excluded.url, credential = excluded.credential,
               everyone = COALESCE(?, everyone), provider = excluded.provider, sign_in = excluded.sign_in`,
            asked.name,
            asked.url,
            asked.credential,
            asked.everyone ?? "read",
            new Date().toISOString(),
            caller.email,
            asked.provider ?? null,
            asked.signIn ?? null,
            asked.everyone ?? null,
          )

          for (const tool of asked.readOnlyTools) {
            yield* sql.exec(
              "INSERT OR IGNORE INTO connection_tool_marks (connection, tool, mark) VALUES (?, ?, 'read')",
              asked.name,
              tool,
            )
          }

          const moved = existing !== undefined && serverOf(existing.url) !== serverOf(asked.url)

          if (moved) {
            yield* signins.moved(asked.name)
            yield* sql.exec("DELETE FROM app_consents WHERE connection = ?", asked.name)
          }

          if (existing !== undefined) upstream.forget((k) => k.startsWith(keyOf(asked.name, "")))

          const row = yield* connectionRow(asked.name, "admin")

          const signIn = yield* signins.discover(
            row.name,
            row.url,
            row.credential === "none",
            asked.signIn,
            origin,
            asked.scopes,
            asked.authorizeParams,
          )

          const lister = yield* listerOf(row, caller.id)

          const listed =
            signIn !== undefined && lister === undefined
              ? {
                  refreshed: false as const,
                  waiting: `${asked.name} signs in with OAuth (${signIn.server.issuer}), so its tools are listed once someone connects: ${takesWorkspace(asked.credential) ? `connect it for the workspace with ${connectUrl(origin, asked.name, "workspace")}` : `connect yours with ${connectUrl(origin, asked.name, "mine")}`}`,
                }
              : yield* refresh(row, lister, origin)

          yield* log(
            `${existing === undefined ? "added" : "changed"} the connection ${asked.name} (${asked.url}, credential ${asked.credential}${signIn === undefined ? "" : `, signs in with OAuth at ${signIn.server.issuer}`})${moved ? "; it moved to a new host, so its tokens and apps' consents were cleared" : ""}`,
          )

          return done({
            connection: yield* describe(
              yield* connectionRow(asked.name, "admin"),
              directory,
              origin,
            ),
            added: existing === undefined,
            tokensCleared: moved,
            listed,
          })
        }

        if (method === "POST" && name === "remove") {
          const asked = yield* body(Named, '{"name": "deepwiki"}')

          yield* connectionRow(asked.name, "admin")
          yield* commit(
            Effect.gen(function* () {
              for (const table of [
                "connection_tools",
                "connection_levels",
                "connection_tool_marks",
                "app_consents",
                "app_asks",
                "connection_own",
                "level_asks",
                "connection_icons",
              ]) {
                yield* sql.exec(`DELETE FROM ${table} WHERE connection = ?`, asked.name)
              }

              yield* sql.exec("DELETE FROM connections WHERE name = ?", asked.name)
              yield* signins.removed(asked.name)
            }),
          )
          upstream.forget((k) => k.startsWith(keyOf(asked.name, "")))
          yield* log(`removed the connection ${asked.name}, its tokens and settings`)

          return done({ removed: asked.name })
        }

        if (method === "POST" && name === "refresh") {
          const asked = yield* body(Named, '{"name": "deepwiki"}')
          const row = yield* connectionRow(asked.name, "admin")
          const listed = yield* refresh(row, yield* listerOf(row, caller.id), origin)

          return done({
            connection: yield* describe(
              yield* connectionRow(asked.name, "admin"),
              directory,
              origin,
            ),
            listed,
          })
        }

        if (method === "POST" && what === "connect" && clear === undefined) {
          const asked = yield* body(ConnectBody, '{"scope": "a scope a tool needed"}')

          return done(
            yield* startSignIn(
              yield* directory.find(caller.id),
              name,
              "workspace",
              origin,
              "",
              scopesOf(asked.scope ?? ""),
            ),
          )
        }

        if (method === "POST" && what === "signin" && clear === "refresh")
          return done(yield* signins.refreshNow(name, "workspace", origin))

        if (method === "POST" && what === "icon" && clear === "clear") {
          const row = yield* connectionRow(name, "admin")

          yield* sql.exec("DELETE FROM connection_icons WHERE connection = ?", row.name)
          yield* log(`removed ${row.name}'s icon`)

          return done({ connection: row.name, icon: null })
        }

        if (method === "POST" && what === "icon" && clear === undefined) {
          const row = yield* connectionRow(name, "admin")
          const asked = yield* body(IconBody, '{"type": "image/png", "base64": "iVBORw0..."}')
          const bytes = fromBase64(asked.base64)

          const problem =
            bytes === undefined ? "base64 isn't base64" : iconProblem(asked.type, bytes)

          if (problem !== undefined || bytes === undefined)
            return yield* new Refused({ message: `${problem ?? ""}: ${ICON_RULES}` })

          const hash = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
            Effect.map((digest) => new Uint8Array(digest).toHex().slice(0, 16)),
          )

          yield* sql.exec(
            `INSERT INTO connection_icons (connection, type, body, hash, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (connection) DO UPDATE SET type = excluded.type, body = excluded.body,
               hash = excluded.hash, set_by = excluded.set_by, set_at = excluded.set_at`,
            row.name,
            asked.type,
            bytes,
            hash,
            caller.email,
            new Date().toISOString(),
          )
          yield* log(`set ${row.name}'s icon (${asked.type}, ${bytes.length} bytes, ${hash})`)

          return done({
            connection: row.name,
            icon: `${origin}/_connections/${row.name}/icon?v=${hash}`,
            type: asked.type,
            bytes: bytes.length,
          })
        }

        if (method === "POST" && what === "client" && clear === undefined) {
          const row = yield* connectionRow(name, "admin")
          const asked = yield* body(ClientBody, '{"clientId": "...", "secret": "..."}')
          const clientId = asked.clientId.trim()
          const secret = asked.secret?.trim()
          const signIn = yield* signins.signInOf(name)

          if (signIn === undefined)
            return yield* new Refused({
              message: `${name} doesn't sign in with OAuth (its token is pasted), so there's no app to register for it`,
            })

          if (!TOKEN.test(clientId) || (secret !== undefined && !TOKEN.test(secret)))
            return yield* new Refused({
              message:
                "the client id and secret are each one line of printable characters without spaces, as the provider shows them",
            })

          const redirect = yield* signins.setClient(signIn, origin, clientId, secret)

          yield* log(
            `set OpenBelt's OAuth app for ${name} at ${signIn.server.issuer} (${clientId})`,
          )

          return done({
            connection: row.name,
            clientId,
            secret: secret === undefined ? "none" : "set",
            redirect,
            connect: `${origin}/_connections/${name}`,
          })
        }

        if (method === "POST" && what === "token" && (clear === undefined || clear === "clear")) {
          const row = yield* connectionRow(name, "admin")

          if (!takesWorkspace(decodeCredential(row.credential))) {
            return yield* new Refused({
              message: `${name} ${row.credential === "none" ? "takes no token" : "takes each person's own token, not the workspace's: each sets theirs (bun run workspace connections token " + name + " --mine)"}`,
            })
          }

          const changed = yield* setToken(
            row,
            "workspace",
            clear === undefined ? text : undefined,
            caller.email,
            origin,
          )

          yield* log(`${clear === undefined ? "set" : "cleared"} the workspace's token for ${name}`)

          const listed = clear === undefined ? yield* refresh(row, "workspace", origin) : undefined

          const answer = {
            connection: name,
            workspaceToken: clear === undefined ? "set" : "cleared",
            ...changed,
          }

          return done(listed === undefined ? answer : { ...answer, listed })
        }
      }

      if (noun === "access" && method === "POST" && parts.length === 2) {
        const asked = yield* body(
          LevelChange,
          '{"connection": "deepwiki", "who": "everyone" | "group:<name>" | "person:<email>", "level": "none" | "read" | "all" | "unset"}',
        )

        const row = yield* connectionRow(asked.connection, "admin")

        if (asked.who === "everyone") {
          if (asked.level === "unset") {
            return yield* new Refused({
              message: "everyone always has a level: none, read or all",
            })
          }

          yield* sql.exec(
            "UPDATE connections SET everyone = ? WHERE name = ?",
            asked.level,
            row.name,
          )
        } else {
          const subject = asked.who.startsWith("group:")
            ? `group:${(yield* directory.group(asked.who.slice(6))).name}`
            : asked.who.startsWith("person:")
              ? `person:${(yield* member(asked.who.slice(7))).id}`
              : undefined

          if (subject === undefined) {
            return yield* new Refused({
              message: `who is "everyone", "group:<name>" or "person:<email>", not "${asked.who}"`,
            })
          }

          yield* asked.level === "unset"
            ? sql.exec(
                "DELETE FROM connection_levels WHERE connection = ? AND subject = ?",
                row.name,
                subject,
              )
            : sql.exec(
                `INSERT INTO connection_levels (connection, subject, level) VALUES (?, ?, ?)
                 ON CONFLICT (connection, subject) DO UPDATE SET level = excluded.level`,
                row.name,
                subject,
                asked.level,
              )
        }

        yield* log(`set ${asked.who}'s level on ${row.name} to ${asked.level}`)

        return done({
          connection: yield* describe(yield* connectionRow(row.name, "admin"), directory, origin),
        })
      }

      if (noun === "access" && method === "POST" && parts[2] === "tool") {
        const asked = yield* body(
          ToolChange,
          '{"connection": "deepwiki", "tool": "ask_wiki_question", "change": "disable" | "enable" | "read" | "unread"}',
        )

        const row = yield* connectionRow(asked.connection, "admin")
        const tool = bare(row.name, asked.tool)
        const known = (yield* toolsOf(row.name)).some((t) => t.name === tool)

        if (!known && (asked.change === "disable" || asked.change === "read")) {
          return yield* new Refused({
            message: `${row.name} has no tool "${tool}" in its list (bun run workspace access ${row.name} shows them; refresh it if the server added one)`,
          })
        }

        const mark = asked.change === "disable" || asked.change === "enable" ? "disabled" : "read"

        yield* asked.change === "disable" || asked.change === "read"
          ? sql.exec(
              "INSERT OR IGNORE INTO connection_tool_marks (connection, tool, mark) VALUES (?, ?, ?)",
              row.name,
              tool,
              mark,
            )
          : sql.exec(
              "DELETE FROM connection_tool_marks WHERE connection = ? AND tool = ? AND mark = ?",
              row.name,
              tool,
              mark,
            )
        yield* log(`${asked.change} ${row.name}.${tool}`)

        return done({ connection: yield* describe(row, directory, origin) })
      }

      if (noun === "access" && parts[2] === "asks") {
        const everyone = yield* directory.everyone()

        if (method === "GET" && parts.length === 3)
          return done({ asks: yield* askGroups(everyone) })

        if (method === "POST" && (parts[3] === "close" || parts[3] === "grant")) {
          const asked = yield* body(
            AsksOf,
            '{"connection": "linear", "want": "all", "person": "bob@acme.com"}',
          )

          yield* connectionRow(asked.connection, "admin")

          const named = [
            ...(asked.person === undefined ? [] : [asked.person]),
            ...(asked.people ?? "").split(","),
          ].flatMap((e) => (e.trim() === "" ? [] : [e.trim().toLowerCase()]))

          const theirs = (yield* openAsks(everyone)).filter(
            (a) =>
              a.connection === asked.connection &&
              a.want === asked.want &&
              (named.length === 0 || named.includes(a.person.email) || named.includes(a.person.id)),
          )

          if (theirs.length === 0)
            return yield* new Refused({
              message: `there's no open ask for ${asked.want} on ${asked.connection}${named.length === 0 ? "" : ` from ${named.join(", ")}`}: GET /_workspace/asks lists the open ones`,
            })

          for (const a of theirs) {
            if (parts[3] === "grant")
              yield* sql.exec(
                `INSERT INTO connection_levels (connection, subject, level) VALUES (?, ?, ?)
                 ON CONFLICT (connection, subject) DO UPDATE SET level = excluded.level`,
                a.connection,
                `person:${a.person.id}`,
                a.want,
              )

            yield* sql.exec(
              "DELETE FROM level_asks WHERE person = ? AND connection = ?",
              a.person.id,
              a.connection,
            )
          }

          yield* log(
            `${parts[3] === "grant" ? "gave" : "closed the asks of"} ${theirs.map((a) => a.person.email).join(", ")} ${parts[3] === "grant" ? `${asked.want} on ${asked.connection} (exceptions, as they asked)` : `for ${asked.want} on ${asked.connection}`}`,
          )

          return done({
            connection: asked.connection,
            want: asked.want,
            people: theirs.map((a) => a.person.email),
          })
        }
      }

      if (noun === "explain" && method === "POST") {
        const asked = yield* body(
          ExplainRequest,
          '{"person": "bob@acme.com", "tool": "deepwiki.ask_wiki_question", "as": "workspace" | "me"}',
        )

        const person = yield* directory.find(asked.person)

        if (asked.app !== undefined) {
          if (asked.as !== undefined) {
            return yield* new Refused({
              message: `as goes with an agent's call; a page's call runs as its app's openbelt.json binds the tool, so leave as out with app`,
            })
          }

          const app = yield* directory.app(asked.app)

          const { decision } = yield* judgeApp(
            asked.tool,
            { kind: "person", person },
            app,
            directory,
            origin,
          )

          return done({
            person: person.email,
            tool: asked.tool,
            app: app.name,
            binding: app.tools[asked.tool] ?? null,
            ...shownDecision(decision),
          })
        }

        const judged = yield* judge(asked.tool, person, asked.as, directory, origin)

        return done({
          person: person.email,
          tool: asked.tool,
          as: asked.as ?? null,
          ...judged.shown,
        })
      }

      if (noun === "activity" && method === "POST") {
        const asked = yield* body(
          ActivityRequest,
          '{"connection": "deepwiki", "tool": "deploy_app", "person": "bob@acme.com", "outcome": "refused", "limit": 50}',
        )

        const person =
          asked.person === undefined ? undefined : (yield* directory.find(asked.person)).email

        const limit = asked.limit ?? 50

        const calls =
          asked.tool === undefined
            ? yield* activity(asked.connection, person, asked.app, Math.min(limit, KEEP_CALLS))
            : []

        return done({
          calls: calls.filter((c) => asked.outcome === undefined || c.outcome === asked.outcome),
          tools:
            asked.connection === undefined
              ? yield* toolCalls.list({
                  person,
                  app: asked.app,
                  tool: asked.tool,
                  outcome: asked.outcome,
                  limit,
                })
              : [],
        })
      }

      return fail(
        404,
        "missing",
        `there's no ${method} /_${route}. Connections take GET /_workspace/connections and /_workspace/connections/<name>; POST /_workspace/connections/add, /remove, /refresh, /_workspace/connections/<name>/token (and /token/clear), /_workspace/connections/<name>/icon {"type", "base64"} (and /icon/clear), /_workspace/access, /_workspace/access/tool, /_workspace/explain, /_workspace/activity; GET /_workspace/access/asks (people's asks for more, grouped), POST /_workspace/access/asks/grant and /close. bun run workspace connections, access, explain and activity do each.`,
      )
    })

    return yield* run.pipe(
      Effect.catchTag("Refused", (e) => Effect.succeed(fail(400, "invalid", e.message))),
    )
  })

  const statusOf = Effect.fnUntraced(function* (row: ConnectionRow, origin: string) {
    const credential = decodeCredential(row.credential)
    const owners = yield* signins.owners(row.name)

    return {
      needsApp: yield* signins.needsApp(row.name, origin),
      workspaceSignIn: !takesWorkspace(credential)
        ? ("not used" as const)
        : owners.includes("workspace")
          ? ("set" as const)
          : (yield* brokenOf(row.name, "workspace")) === undefined
            ? ("missing" as const)
            : ("stopped" as const),
      connected: takesMine(credential) ? owners.filter((o) => o !== "workspace").length : 0,
      problem: row.problem,
    }
  })

  const describe = Effect.fnUntraced(function* (
    row: ConnectionRow,
    directory: Directory,
    origin: string,
  ) {
    const policy = yield* policyOf(row)
    const tools = yield* toolsOf(row.name)

    const owners = yield* signins.owners(row.name)

    const people = yield* Effect.forEach([...policy.people], ([id, level]) =>
      directory.find(id).pipe(
        Effect.map((p) => [p.email, level] as const),
        Effect.orElseSucceed(() => [id, level] as const),
      ),
    )

    const described = {
      name: row.name,
      url: row.url,
      credential: decodeCredential(row.credential),
      workspaceToken: takesWorkspace(decodeCredential(row.credential))
        ? owners.includes("workspace")
          ? "set"
          : "missing"
        : "not used",
      peopleWithTokens: owners.filter((o) => o !== "workspace").length,
      signIn: yield* signins.shown(row.name, origin),
      status: yield* statusOf(row, origin),
      everyone: policy.everyone,
      groups: Object.fromEntries(policy.groups),
      people: Object.fromEntries(people),
      disabled: [...policy.disabled].toSorted(),
      markedRead: [...policy.read].toSorted(),
      tools: tools.map((t) => ({
        name: t.name,
        description: firstLine(t.description),
        readOnly: t.read_only === 1,
        annotations: decodeJson(t.annotations),
      })),
      refreshed: row.refreshed,
      problem: row.problem,
      created: row.created,
      createdBy: row.created_by,
    }

    const api = apiOf(row)

    const shown =
      api === undefined
        ? described
        : {
            ...described,
            api: {
              kind: api.kind,
              spec: api.spec ?? "(introspection)",
              auth: authShown(api.auth),
              tags: api.tags ?? ["(all)"],
              toolTags: Object.fromEntries(
                tagCounts(
                  tools.map((t) => ({
                    tags: Option.getOrElse(
                      Schema.decodeUnknownOption(
                        Schema.Struct({ tags: Schema.Array(Schema.String) }),
                      )(decodeJson(t.annotations)).pipe(Option.map((a) => a.tags)),
                      () => [],
                    ),
                  })),
                ),
              ),
            },
          }

    return row.provider === null ? shown : { ...shown, provider: row.provider }
  })

  const judge = Effect.fnUntraced(function* (
    qualified: string,
    person: Person,
    as: "workspace" | "me" | undefined,
    directory: Directory,
    origin: string,
    policy?: Policy,
  ) {
    const split = splitTool(qualified)

    if (split === undefined) {
      return yield* new Refused({
        message: `name a tool as <connection>.<tool>, like "deepwiki.ask_wiki_question": "${qualified.slice(0, 100)}" has no dot. The connections tool lists them.`,
      })
    }

    const [name, tool] = split
    const row = yield* connectionRow(name, person.role)
    const { facts } = yield* factsOf(row, person, directory, origin, policy)
    const decision = decide(facts, tool, as)

    return { row, tool, decision, shown: shownDecision(decision) }
  })

  const send = Effect.fnUntraced(function* (
    row: ConnectionRow,
    runsAs: RunsAs,
    who: string,
    tool: string,
    input: Json,
    origin: string,
  ) {
    const owners: Readonly<Record<RunsAs, string | undefined>> = {
      workspace: "workspace",
      me: who,
      none: undefined,
    }

    const owner = owners[runsAs]

    const reached = upstreamFor(row, owner, owner ?? `none:${who}`, origin, tool)

    const api = apiOf(row)

    const [bound] =
      api === undefined
        ? []
        : yield* rows<{ binding: string | null }>(
            "SELECT binding FROM connection_tools WHERE connection = ? AND name = ?",
            row.name,
            tool,
          )

    const binding =
      bound === undefined || bound.binding === null
        ? undefined
        : Option.getOrUndefined(decodeBinding(bound.binding))

    const misfit =
      api === undefined
        ? undefined
        : binding === undefined
          ? `${row.name} has no request kept for ${tool}: an admin refreshes it (bun run workspace connections refresh ${row.name})`
          : inputProblem(row.name, tool, binding, input)

    if (misfit !== undefined) {
      const failure: SendFailure = { refusal: new Refused({ message: misfit }), own: true }

      return yield* Effect.fail(failure)
    }

    const sent = yield* Effect.result(
      Effect.flatMap(reached.upstream, (to) =>
        api === undefined || binding === undefined
          ? upstream.callTool(to, tool, input)
          : Effect.gen(function* () {
              return yield* callApi(
                row.name,
                tool,
                row.url,
                api.auth,
                binding,
                input,
                to.credential,
                reach,
              )
            }),
      ),
    )

    if (Result.isSuccess(sent)) return sent.success

    const failure: SendFailure = { refusal: sent.failure, own: reached.own() === sent.failure }

    return yield* Effect.fail(failure)
  })

  const consentOf = Effect.fnUntraced(function* (person: string, app: string, connection: string) {
    const [row] = yield* rows<{ tools: string }>(
      "SELECT tools FROM app_consents WHERE person = ? AND app = ? AND connection = ?",
      person,
      app,
      connection,
    )

    return row === undefined ? undefined : decodeNames(row.tools)
  })

  const consentedFor = Effect.fnUntraced(function* (
    viewer: PageWho,
    app: CallingApp,
    connection: string,
  ) {
    if (viewer.kind !== "person") return false

    const granted = yield* consentOf(viewer.person.id, app.id, connection)

    return (
      granted !== undefined &&
      viewerTools(app.tools, connection).every((tool) => granted.includes(tool))
    )
  })

  const judgeApp = Effect.fnUntraced(function* (
    qualified: string,
    viewer: PageWho,
    app: CallingApp,
    directory: Directory,
    origin: string,
    policy?: Policy,
  ) {
    const split = splitTool(qualified)

    if (split === undefined) {
      return yield* new Refused({
        message: `name a tool as <connection>.<tool>, like "deepwiki.ask_wiki_question": "${qualified.slice(0, 100)}" has no dot. tools.list() lists the ones this app binds.`,
      })
    }

    const [name, tool] = split
    const binding = app.tools[qualified]

    if (binding === undefined) {
      const facts: Facts = {
        connection: name,
        credential: "none",
        policy: {
          everyone: "none",
          groups: new Map(),
          people: new Map(),
          disabled: new Set(),
          read: new Set(),
        },
        tools: new Map(),
        workspaceToken: false,
        signIn: { kind: "token", workspaceBroken: undefined, ownBroken: undefined },
        person: {
          ...whoOf(viewer),
          removed: false,
          ownToken: false,
          admin: false,
          own: NO_OWN,
        },
        admins: [],
        origin,
      }

      const decision = decideForApp(facts, tool, {
        app: app.name,
        binding,
        viewer: viewer.kind,
        consented: false,
      })

      return { row: undefined, tool, decision }
    }

    const row = yield* connectionRow(name, whoOf(viewer).role)
    const { facts } = yield* factsOf(row, whoOf(viewer), directory, origin, policy)
    const consented = yield* consentedFor(viewer, app, name)

    const decision = decideForApp(facts, tool, {
      app: app.name,
      binding,
      viewer: viewer.kind,
      consented,
    })

    return { row, tool, decision }
  })

  return {
    act,

    icons: Effect.fnUntraced(function* () {
      const all = yield* rows<{ connection: string; hash: string }>(
        "SELECT connection, hash FROM connection_icons",
      )

      return Object.fromEntries(all.map((row) => [row.connection, row.hash]))
    }),

    icon: Effect.fnUntraced(function* (connection: string) {
      const [row] = yield* rows<{ type: string; body: ArrayBuffer; hash: string }>(
        "SELECT type, body, hash FROM connection_icons WHERE connection = ?",
        connection,
      )

      return row === undefined
        ? undefined
        : { type: row.type, body: new Uint8Array(row.body), hash: row.hash }
    }),

    statuses: Effect.fnUntraced(function* (origin: string) {
      const all = yield* rows<ConnectionRow>("SELECT * FROM connections ORDER BY name")

      return new Map(
        yield* Effect.forEach(all, (row) =>
          Effect.map(statusOf(row, origin), (status) => [row.name, status] as const),
        ),
      )
    }),

    appsAt: signins.appsAt,

    documents: signins.documents,

    setOwnToken,
    disconnect,
    startSignIn,
    finishSignIn,

    setOwn,

    askMore,

    unask,

    askGroups,

    askCount: Effect.fnUntraced(function* (everyone: ReadonlyArray<Person>) {
      const open = yield* openAsks(everyone)

      return {
        asks: open.length,
        people: new Set(open.map((a) => a.person.id)).size,
        connections: new Set(open.map((a) => a.connection)).size,
      }
    }),

    activity,

    find: Effect.fnUntraced(function* (
      person: Person,
      directory: Directory,
      origin: string,
      query: string,
      limit: number,
    ) {
      const words = queryWords(query)

      if (words.length === 0) return []

      const all = yield* rows<ConnectionRow>("SELECT * FROM connections")

      const tools = yield* rows<{ connection: string; name: string; description: string }>(
        "SELECT connection, name, description FROM connection_tools",
      )

      const docs = new Map<
        string,
        { item: ConnectionRow; said: Set<string>; names: Set<string>; lines: Set<string> }
      >()

      for (const row of all) {
        const entry = row.provider === null ? undefined : providerById(row.provider)

        docs.set(row.name, {
          item: row,
          said: new Set(wordsIn(`${row.name} ${entry?.name ?? ""} ${entry?.about ?? ""}`)),
          names: new Set(),
          lines: new Set(),
        })
      }

      for (const t of tools) {
        const doc = docs.get(t.connection)

        if (doc === undefined) continue

        for (const w of wordsIn(t.name)) doc.names.add(w)

        for (const w of wordsIn(firstLine(t.description))) doc.lines.add(w)
      }

      const ranked = rank([...docs.values()], words, limit).map((m) => ({
        row: m.item,
        score: m.score,
      }))

      return yield* Effect.forEach(ranked, ({ row, score }) =>
        Effect.map(
          viewOf(row, person, directory, origin, false, { search: query, past: 0, brief: 3 }),
          (view) => ({ view, score }),
        ),
      )
    }),

    notAdded: Effect.fnUntraced(function* (query: string, limit: number) {
      const all = yield* rows<{ name: string; provider: string | null }>(
        "SELECT name, provider FROM connections",
      )

      const have = new Set(
        all.flatMap((r) => (r.provider === null ? [r.name] : [r.name, r.provider])),
      )

      return catalogFor(query, have, limit)
    }),

    count: Effect.fnUntraced(function* () {
      const [row] = yield* rows<{ n: number }>("SELECT COUNT(*) AS n FROM connections")

      return row?.n ?? 0
    }),

    view: Effect.fnUntraced(function* (
      person: Person,
      directory: Directory,
      origin: string,
      only: string | undefined,
      listing: Listing = EVERY_TOOL,
    ) {
      const all =
        only === undefined
          ? yield* rows<ConnectionRow>("SELECT * FROM connections ORDER BY name")
          : [yield* connectionRow(only, person.role)]

      return yield* Effect.forEach(all, (row) =>
        viewOf(row, person, directory, origin, only !== undefined, listing),
      )
    }),

    call: Effect.fnUntraced(function* (
      person: Person,
      qualified: string,
      input: Json,
      as: "workspace" | "me" | undefined,
      trace: string,
      directory: Directory,
      origin: string,
    ) {
      const at = new Date().toISOString()
      const started = Date.now()
      const judged = yield* Effect.result(judge(qualified, person, as, directory, origin))
      const [name, tool] = splitTool(qualified) ?? [qualified, ""]

      const finish = Effect.fnUntraced(function* (called: Called, runsAs: string) {
        const why = called.kind === "not_run" ? called.message : ""

        yield* recordCall({
          at,
          trace,
          person: person.email,
          runs_as: runsAs,
          connection: name,
          tool,
          outcome: called.outcome,
          ms: called.ms,
          why,
          app: "",
        })
        yield* Effect.logInfo(
          `connection ${qualified} ${called.outcome} in ${called.ms}ms: ${person.email} as ${runsAs}${why === "" ? "" : `: ${why.slice(0, 200)}`}`,
        ).pipe(Effect.annotateLogs({ trace }))

        return called
      })

      if (Result.isFailure(judged))
        return yield* finish(
          {
            kind: "not_run",
            outcome: "refused",
            message: judged.failure.message,
            connect: judged.failure.connect,
            ms: Date.now() - started,
          },
          "-",
        )

      const { row, decision } = judged.success

      if (!decision.allowed)
        return yield* finish(
          {
            kind: "not_run",
            outcome: "refused",
            message: decision.message,
            connect: decision.connect,
            ms: Date.now() - started,
          },
          "-",
        )

      const sent = yield* Effect.result(send(row, decision.runsAs, person.id, tool, input, origin))
      const ms = Date.now() - started

      if (Result.isFailure(sent))
        return yield* finish(
          {
            kind: "not_run",
            outcome: sent.failure.own ? "refused" : "failed",
            message: sent.failure.refusal.message,
            connect: sent.failure.refusal.connect,
            ms,
          },
          decision.runsAs,
        )

      const result = sent.success

      return yield* finish(
        {
          kind: "ran",
          outcome: result.isError === true ? "tool_error" : "ok",
          result,
          runsAs: decision.runsAs,
          ms,
        },
        decision.runsAs,
      )
    }),

    callForFunction: Effect.fnUntraced(function* (
      runner: FunctionRunner,
      via: string,
      app: CallingApp,
      connection: string,
      tool: string,
      input: Json,
      as: "workspace" | "me" | undefined,
      trace: string,
      directory: Directory,
      origin: string,
      options: {
        readonly preview: { readonly env: string; readonly live: boolean } | null
      },
    ) {
      const at = new Date().toISOString()
      const started = Date.now()
      const qualified = `${connection}.${tool}`

      const nobody = (email: string): Who => ({
        id: `nobody:${via}`,
        email,
        name: "",
        groups: [],
        role: "member",
      })

      const { who, shown, running } = Match.value(runner).pipe(
        Match.discriminatorsExhaustive("kind")({
          person: ({ person, present }) => ({
            who: person,
            shown: person.email,
            running: present
              ? `as ${person.email} (via ${via})`
              : `for ${person.email} (via ${via}), with the workspace's token only`,
          }),
          test: ({ person, test }) => ({
            who: person,
            shown: person.email,
            running: `for test person ${test}, judged as ${person.email} who ran the check, with the workspace's token only`,
          }),
          nobody: ({ owner }) => ({
            who: owner,
            shown: `a ${via} run (no person)`,
            running: `with no person (via ${via}), held to everyone's level and its owner ${owner.email}'s, with the workspace's token only`,
          }),
          signed_out: () => ({
            who: nobody("nobody signed in"),
            shown: "nobody signed in",
            running: `with nobody signed in (via ${via})`,
          }),
        }),
      )

      const what = `${app.name}'s function${app.env === undefined ? "" : ` in preview ${app.env}`}, ${running}`

      type FnCalled =
        | (Extract<Called, { readonly kind: "ran" }> & { readonly readOnly: boolean })
        | {
            readonly kind: "previewed"
            readonly tool: string
            readonly input: Json
            readonly message: string
            readonly ms: number
          }
        | { readonly kind: "refused"; readonly message: string; readonly ms: number }
        | {
            readonly kind: "failed"
            readonly message: string
            readonly ms: number
            readonly readOnly: boolean
          }

      const finish = Effect.fnUntraced(function* (called: FnCalled, runsAs: string) {
        const { outcome, why } = Match.value(called).pipe(
          Match.discriminatorsExhaustive("kind")({
            ran: (ran) => ({ outcome: ran.outcome, why: "" }),
            previewed: () => ({ outcome: "ok" as const, why: "previewed" }),
            refused: (refused) => ({ outcome: refused.kind, why: refused.message }),
            failed: (failed) => ({ outcome: failed.kind, why: failed.message }),
          }),
        )

        yield* recordCall({
          at,
          trace,
          person: shown,
          runs_as: runsAs,
          connection,
          tool,
          outcome,
          ms: called.ms,
          why,
          app: app.name,
        })

        return called
      })

      const refuse = (message: string) =>
        finish(
          {
            kind: "refused",
            message: `${qualified} from ${what}: ${message}`,
            ms: Date.now() - started,
          },
          "-",
        )

      const found = yield* Effect.result(connectionRow(connection, who.role))

      if (Result.isFailure(found)) return yield* refuse(found.failure.message)

      const row = found.success
      const { facts } = yield* factsOf(row, who, directory, origin)

      if (runner.kind === "signed_out" && facts.credential !== "none") {
        return yield* refuse(
          `nobody is signed in on the page that ran it (or that started the run that booked it), and ${connection} runs with ${facts.credential === "person" ? "each person's own token" : `${connection}'s token`}, which only the workspace's people get. Open the page signed in (through the workspace's front door: Tailscale)`,
        )
      }

      const ownToken = runner.kind === "person" && runner.present

      const admins =
        facts.admins.length === 0 ? "the workspace's admins" : facts.admins.join(" or ")

      const workspaceTokenToo = `ask ${admins} to set ${connection} up with a workspace token too`

      const noOwnToken = Match.value(runner).pipe(
        Match.discriminatorsExhaustive("kind")({
          person: ({ person }) =>
            via.startsWith("app:")
              ? `this run was called from ${via.slice(4)}'s page, not ${app.name}'s own, and only ${app.name}'s own page (or ${person.email}'s agent) runs with ${person.email}'s own token: another app's code chose this call. Have ${person.email} make it from ${app.name}'s page, or ${workspaceTokenToo}`
              : `this ${via} run was started by ${person.email}, who needn't be there when it runs, so it never runs with their own token. Make the call while they're there (from ${app.name}'s page, or their agent's call_function), or ${workspaceTokenToo}`,
          test: () =>
            "a check_app test person has none. Test this call live as yourself (call_function), or expect this refusal in the check",
          nobody: () =>
            `this run has no person, so it can't run as anyone. Make the call from a run a person makes while they're there (${app.name}'s page, or their agent's call_function), or ${workspaceTokenToo}`,
          signed_out: () => "nobody is signed in",
        }),
      )

      if (!ownToken && facts.credential === "person")
        return yield* refuse(`${connection} takes each person's own token, and ${noOwnToken}`)

      if (!ownToken && as === "me")
        return yield* refuse(
          `as: "me" runs with the run's person's own token, and ${noOwnToken}. Leave as out (the workspace's token)`,
        )

      const readOnly = isRead(facts, tool)

      const chosen = !ownToken
        ? facts.credential === "none"
          ? undefined
          : "workspace"
        : (as ??
          (facts.credential === "both" && facts.workspaceToken && facts.person.ownToken
            ? "workspace"
            : undefined))

      const decision = decide(facts, tool, chosen)

      if (!decision.allowed) return yield* refuse(decision.message)

      if (runner.kind === "nobody") {
        const everyone = yield* factsOf(row, nobody("everyone"), directory, origin)
        const atEveryone = decide(everyone.facts, tool, chosen)

        if (!atEveryone.allowed) return yield* refuse(atEveryone.message)
      }

      if (decision.runsAs === "me") {
        if (runner.kind !== "person")
          return yield* Effect.die("only a person's own run is decided as them")

        const asking = yield* Effect.result(directory.app(app.name, app.env))

        if (Result.isFailure(asking)) return yield* refuse(asking.failure.message)

        const consented = yield* consentedFor(
          { kind: "person", person: runner.person },
          asking.success,
          connection,
        )

        if (!consented) {
          const granted = yield* consentOf(who.id, app.id, connection)
          const wanted = viewerTools(asking.success.tools, connection)

          return yield* refuse(
            `it would run with ${who.email}'s own ${connection} token, and they haven't allowed ${app.name} what it asks for there (${wanted.join(", ")}: "*" is every tool, which openbelt.json "uses" asks for)${granted === undefined ? "" : `, only ${granted.join(", ")}`}. ${who.email} allows it on Connections: ${settingsUrl(origin, connection, app)}`,
          )
        }
      }

      if (options.preview !== null && !options.preview.live && !readOnly) {
        return yield* finish(
          {
            kind: "previewed",
            tool: qualified,
            input,
            message: `not sent: this run is in preview environment ${options.preview.env}, and ${tool} isn't a read-only tool (the server doesn't mark it readOnlyHint), so it would change the real ${connection}. Live, it's sent (it would run as ${decision.runsAs}). To test the real call, test it live, or a person lets this environment's functions send for real (preview_side_effects).`,
            ms: Date.now() - started,
          },
          decision.runsAs,
        )
      }

      const session = runner.kind === "person" || runner.kind === "test" ? who.id : `nobody:${via}`
      const sent = yield* Effect.result(send(row, decision.runsAs, session, tool, input, origin))
      const ms = Date.now() - started

      if (Result.isFailure(sent))
        return yield* finish(
          {
            kind: "failed",
            message: `${qualified}'s server didn't answer: ${sent.failure.refusal.message}`,
            ms,
            readOnly,
          },
          decision.runsAs,
        )

      const result = sent.success

      return yield* finish(
        {
          kind: "ran",
          outcome: result.isError === true ? "tool_error" : "ok",
          result,
          runsAs: decision.runsAs,
          ms,
          readOnly,
        },
        decision.runsAs,
      )
    }),

    callForApp: Effect.fnUntraced(function* (
      viewer: PageWho,
      app: CallingApp,
      qualified: string,
      input: Json,
      trace: string,
      directory: Directory,
      origin: string,
    ) {
      const at = new Date().toISOString()
      const started = Date.now()
      const who = whoOf(viewer)
      const judged = yield* Effect.result(judgeApp(qualified, viewer, app, directory, origin))
      const [name, tool] = splitTool(qualified) ?? [qualified, ""]

      const finish = Effect.fnUntraced(function* (called: AppCalled, runsAs: string) {
        const outcome = called.kind === "ran" ? called.outcome : called.kind
        const why = called.kind === "ran" ? "" : called.message

        yield* recordCall({
          at,
          trace,
          person: who.email,
          runs_as: runsAs,
          connection: name,
          tool,
          outcome,
          ms: called.ms,
          why,
          app: app.name,
        })
        yield* Effect.logInfo(
          `connection ${qualified} from ${app.name}'s page ${outcome} in ${called.ms}ms: ${who.email} as ${runsAs}${why === "" ? "" : `: ${why.slice(0, 200)}`}`,
        ).pipe(Effect.annotateLogs({ trace, app: app.name }))

        return called
      })

      if (Result.isFailure(judged)) {
        return yield* finish(
          {
            kind: "refused",
            setting: "tool",
            ...refusalFor("tool", app, name, origin, yield* directory.admins()),
            message: judged.failure.message,
            ms: Date.now() - started,
          },
          "-",
        )
      }

      const { row, decision } = judged.success

      if (!decision.allowed) {
        if (
          viewer.kind === "person" &&
          (decision.setting === "token" || decision.setting === "consent")
        )
          yield* sql.exec(
            `INSERT INTO app_asks (person, app, connection, asked) VALUES (?, ?, ?, ?)
             ON CONFLICT (person, app, connection) DO UPDATE SET asked = excluded.asked`,
            who.id,
            app.id,
            name,
            at,
          )

        return yield* finish(
          {
            kind: "refused",
            setting: decision.setting,
            ...refusalFor(decision.setting, app, name, origin, yield* directory.admins()),
            message: decision.message,
            ms: Date.now() - started,
          },
          "-",
        )
      }

      if (row === undefined) return yield* Effect.die("an allowed call has its connection")

      const sent = yield* Effect.result(send(row, decision.runsAs, who.id, tool, input, origin))
      const ms = Date.now() - started
      const runsAs = decision.runsAs

      if (Result.isFailure(sent))
        return yield* finish({ kind: "failed", message: sent.failure.refusal.message, ms }, runsAs)

      const result = sent.success

      return yield* finish(
        {
          kind: "ran",
          outcome: result.isError === true ? "tool_error" : "ok",
          result,
          runsAs: decision.runsAs,
          ms,
        },
        runsAs,
      )
    }),

    onlyReads: Effect.fnUntraced(function* (qualified: string) {
      const [name = "", tool = ""] = splitTool(qualified) ?? []
      const [row] = yield* rows<ConnectionRow>("SELECT * FROM connections WHERE name = ?", name)

      if (row === undefined) return true

      const [listed] = yield* rows<{ read_only: number }>(
        "SELECT read_only FROM connection_tools WHERE connection = ? AND name = ?",
        name,
        tool,
      )

      return listed === undefined || listed.read_only === 1 || (yield* policyOf(row)).read.has(tool)
    }),

    listForApp: Effect.fnUntraced(function* (
      viewer: PageWho,
      app: CallingApp,
      directory: Directory,
      origin: string,
    ) {
      const admins = yield* directory.admins()

      const bound = Object.entries(app.tools).toSorted(([a], [b]) => a.localeCompare(b))

      return yield* Effect.forEach(bound, ([qualified, binding]) =>
        Effect.gen(function* () {
          const judged = yield* Effect.result(judgeApp(qualified, viewer, app, directory, origin))
          const shown = { tool: qualified, binding }

          if (Result.isFailure(judged)) {
            const why = refusalFor("tool", app, qualified.split(".")[0] ?? "", origin, admins)

            return {
              ...shown,
              usable: false,
              ...shownRefusal(why),
              message: judged.failure.message,
            }
          }

          const { row, tool, decision } = judged.success
          const connection = qualified.split(".")[0] ?? ""

          const about =
            row === undefined ? undefined : (yield* toolsOf(row.name)).find((t) => t.name === tool)

          const described = {
            ...shown,
            description: about === undefined ? "" : firstLine(about.description),
            input: about === undefined ? null : decodeJson(about.input),
          }

          if (decision.allowed) return { ...described, usable: true, runsAs: decision.runsAs }

          const why = refusalFor(decision.setting, app, connection, origin, admins)

          return { ...described, usable: false, ...shownRefusal(why), message: decision.message }
        }),
      )
    }),

    warnings: Effect.fnUntraced(function* (tools: AppTools) {
      const said: Array<string> = []

      for (const [qualified, binding] of Object.entries(tools).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const [name = "", tool = ""] = splitTool(qualified) ?? []
        const setting = `openbelt.json "tools" "${qualified}": "${binding}"`
        const [row] = yield* rows<ConnectionRow>("SELECT * FROM connections WHERE name = ?", name)

        if (row === undefined) {
          const names = (yield* rows<{ name: string }>(
            "SELECT name FROM connections ORDER BY name",
          )).map((r) => r.name)

          said.push(
            `${setting}: the workspace has no connection "${name}" (${names.length === 0 ? "it has none yet" : `it has ${names.join(", ")}`}), so every call of it is refused until an admin adds one`,
          )
          continue
        }

        const listed = yield* toolsOf(name)
        const policy = yield* policyOf(row)
        const credential = decodeCredential(row.credential)

        if (binding === "workspace" && credential === "person") {
          said.push(
            `${setting}: ${name} takes each person's own token, not the workspace's, so this is refused for everyone: bind it to "viewer"`,
          )
          continue
        }

        if (binding === "viewer" && credential === "workspace") {
          said.push(
            `${setting}: ${name} takes only the workspace's token, so this is refused for everyone: bind it to "workspace"`,
          )
          continue
        }

        if (listed.length === 0) {
          said.push(
            `${setting}: ${name}'s tools aren't listed yet (nobody's token has listed them), so whether it has "${tool}" isn't known: calls are refused until it's listed`,
          )
          continue
        }

        if (!listed.some((t) => t.name === tool)) {
          said.push(
            `${setting}: ${name} has no tool "${tool}" (it has ${listed
              .map((t) => t.name)
              .slice(0, 20)
              .join(", ")}${listed.length > 20 ? ", ..." : ""}): the connections tool lists them`,
          )
          continue
        }

        if (policy.disabled.has(tool)) {
          said.push(`${setting}: the workspace's admins disabled ${qualified} for everyone`)
          continue
        }

        const read = isRead(
          { tools: new Map(listed.map((t) => [t.name, t.read_only === 1])), policy },
          tool,
        )

        const levels = [policy.everyone, ...policy.groups.values(), ...policy.people.values()]

        if (!levels.some((l) => l === "all" || (l === "read" && read))) {
          said.push(
            `${setting}: nobody's level on ${name} covers it (everyone ${policy.everyone}${read ? "" : "; it isn't a read tool"}), so every call is refused until an admin changes that`,
          )
          continue
        }

        if (
          binding === "workspace" &&
          credential !== "none" &&
          !(yield* hasCredential(name, "workspace"))
        ) {
          said.push(
            `${setting}: ${name} has no workspace token yet, so calls are refused until an admin sets it`,
          )
        }
      }

      return said
    }),

    consentOf,

    consents: Effect.fnUntraced(function* (person: string) {
      return (yield* rows<{ app: string; connection: string; tools: string; granted: string }>(
        "SELECT app, connection, tools, granted FROM app_consents WHERE person = ? ORDER BY granted DESC",
        person,
      )).map((c) => ({ ...c, tools: decodeNames(c.tools) }))
    }),

    grant: Effect.fnUntraced(function* (
      person: Person,
      app: CallingApp,
      connection: string,
      seen: ReadonlyArray<string>,
    ) {
      yield* connectionRow(connection, person.role)

      const wanted = viewerTools(app.tools, connection)

      if (wanted.length === 0) {
        return yield* new Refused({
          message: `${app.name} doesn't ask to use your ${connection}: its openbelt.json binds none of ${connection}'s tools to "viewer"`,
        })
      }

      if (wanted.join(",") !== [...seen].toSorted().join(",")) {
        return yield* new Refused({
          message: `${app.name} asks for other ${connection} tools than the page showed (it was deployed since): look at the list again, then allow it`,
        })
      }

      yield* sql.exec(
        `INSERT INTO app_consents (person, app, connection, tools, granted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (person, app, connection) DO UPDATE SET tools = excluded.tools, granted = excluded.granted`,
        person.id,
        app.id,
        connection,
        JSON.stringify(wanted),
        new Date().toISOString(),
      )
      yield* sql.exec(
        "DELETE FROM app_asks WHERE person = ? AND app = ? AND connection = ?",
        person.id,
        app.id,
        connection,
      )

      return wanted
    }),

    revokeConsent: Effect.fnUntraced(function* (person: Person, app: string, connection: string) {
      const gone = yield* (yield* sql.exec(
        "DELETE FROM app_consents WHERE person = ? AND app = ? AND connection = ?",
        person.id,
        app,
        connection,
      )).rowsWritten

      return gone > 0
    }),

    asks: Effect.fnUntraced(function* (person: string) {
      return yield* rows<{ app: string; connection: string; asked: string }>(
        "SELECT app, connection, asked FROM app_asks WHERE person = ? ORDER BY asked DESC",
        person,
      )
    }),

    dismissAsk: Effect.fnUntraced(function* (person: Person, app: string, connection: string) {
      yield* sql.exec(
        "DELETE FROM app_asks WHERE person = ? AND app = ? AND connection = ?",
        person.id,
        app,
        connection,
      )
    }),

    viewerTools,

    levels: Effect.fnUntraced(function* (people: ReadonlyArray<Person>) {
      const all = yield* rows<ConnectionRow>("SELECT * FROM connections ORDER BY name")

      return yield* Effect.forEach(all, (row) =>
        Effect.map(policyOf(row), (policy) => ({
          connection: row.name,
          credential: decodeCredential(row.credential),
          everyone: policy.everyone,
          groups: Object.fromEntries(policy.groups),
          people: Object.fromEntries(policy.people),
          result: Object.fromEntries(people.map((p) => [p.id, levelOf(policy, p)])),
        })),
      )
    }),

    forgetGroup: Effect.fnUntraced(function* (group: string) {
      yield* sql.exec("DELETE FROM connection_levels WHERE subject = ?", `group:${group}`)
    }),

    forgetPerson: Effect.fnUntraced(function* (person: string) {
      upstream.forget((k) => k.endsWith(`\u0000${person}`) || k.endsWith(`\u0000none:${person}`))

      yield* sql.exec("DELETE FROM app_consents WHERE person = ?", person)
      yield* sql.exec("DELETE FROM app_asks WHERE person = ?", person)
      yield* sql.exec("DELETE FROM connection_own WHERE person = ?", person)
      yield* sql.exec("DELETE FROM level_asks WHERE person = ?", person)
      yield* sql.exec("DELETE FROM connection_levels WHERE subject = ?", `person:${person}`)

      return yield* signins.personRemoved(person)
    }),
  }
})
