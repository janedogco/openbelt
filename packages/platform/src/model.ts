import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { cronProblem } from "./cron.ts"
import { isWorkspaceLabel } from "./hosts.ts"
import { type JsonSchema, JsonSchemaCodec } from "./contracts.ts"
import { type RuleOp, ruleProblem, unstatedOps } from "./rules.ts"

export const Theme = Schema.Literals(["system", "light", "dark"])

export type Theme = typeof Theme.Type

/** The person's theme, as the gateway tells an app's page (THEME_HEADER): the page shows it before it paints (reporter.ts). */
export const THEME_HEADER = "x-openbelt-viewer-theme"

export const ThemeChange = Schema.Struct({
  theme: Theme,
  action: Schema.Literals(["choose", "import"]),
  form: Schema.String,
})

export type ThemeChange = typeof ThemeChange.Type

export const ConnectLink = Schema.Struct({
  url: Schema.String,
  why: Schema.Literals(["not_connected", "reconnect", "scope", "admin_setup"]),
})

export type ConnectLink = typeof ConnectLink.Type

export const ReconnectKind = Schema.Literals([
  "revoked",
  "expired",
  "cut_short",
  "rapt",
  "unsaved",
  "registration",
  "rejected_after_refresh",
])

export type ReconnectKind = typeof ReconnectKind.Type

export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  code: Schema.optionalKey(Schema.Literal("storage_full")),
  message: Schema.String,
  connect: Schema.optionalKey(ConnectLink),
}) {}

export class Missing extends Schema.TaggedError<Missing>()("Missing", { message: Schema.String }) {}

export class Denied extends Schema.TaggedError<Denied>()("Denied", {
  message: Schema.String,
  hint: Schema.String,
  rule: Schema.String,
}) {}

export type ErrorCode =
  | "invalid"
  | "denied"
  | "not_writable"
  | "cross_origin"
  | "live_from_preview"
  | "check_readonly"
  | "missing"
  | "method"
  | "conflict"
  | "unauthorized"
  | "not_member"
  | "not_admin"
  | "internal"
  | "not_bound"
  | "signed_out"
  | "test_person"
  | "not_allowed"
  | "needs_token"
  | "needs_consent"
  | "upstream_failed"
  | "function_failed"
  | "bad_input"
  | "not_callable"
  | "file_too_large"
  | "workspace_storage_full"
  | "disk_low"
  | "busy"
  | "storage"
  | "unavailable"
  | "uploads_off"
  | "storage_full"
  | "rate_limited"
  | "private"

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
  seq: Schema.Number,
}) {}

export const newTrace = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12)

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/**
 * Names no app may take. The workspace host serves an app's page at /<app>, so each of its own routes that isn't _-prefixed
 * or dotted is here (scripts/guard.ts checks it): /mcp, /install, /scim/v2, /a (old app links). New platform routes start with _.
 */
export const RESERVED_APP_NAMES: ReadonlySet<string> = new Set([
  "a",
  "install",
  "scim",
  "mcp",
  "api",
  "admin",
  "auth",
  "login",
  "logout",
  "docs",
  "static",
])

export const isSlug = (name: string) => SLUG.test(name)

/** Names that are the platform's own (its hosts, its people's), never a workspace's. */
const RESERVED_WORKSPACES: ReadonlySet<string> = new Set([
  "www",
  "staging",
  "api",
  "admin",
  "docs",
  "status",
  "mail",
  "dev",
  "pr",
  "preview",
  "grafana",
])

/** Whether `workspace` can be a workspace's name: a slug, with no "--" (an old app host, `<app>--<workspace>`), and not one of the platform's. */
export const isWorkspaceName = (workspace: string) =>
  isSlug(workspace) && isWorkspaceLabel(workspace) && !RESERVED_WORKSPACES.has(workspace)

/**
 * A workspace's name: the first label of its host (`<workspace>.<host>`), what people see and type. A workspace can be renamed; its old names
 * stay its own and still reach it (apex.ts, the directory).
 */
export const WorkspaceName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (name: string) =>
        isWorkspaceName(name) || "lowercase letters, digits and single dashes, like acme",
    ),
  ),
  Schema.brand("WorkspaceName"),
)

export type WorkspaceName = typeof WorkspaceName.Type

/**
 * A workspace's permanent id: the name it was made with, kept when it is renamed. Its objects are keyed by it (WorkspaceDO, McpDO's
 * `<workspace>/<person>`, AppDO's workspace), and so are the tokens it gave out on the base host (`<workspace>~...`). Never shown as a name.
 */
export const WorkspaceId = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((id: string) => (isSlug(id) && isWorkspaceLabel(id)) || "a workspace's id"),
  ),
  Schema.brand("WorkspaceId"),
)

export type WorkspaceId = typeof WorkspaceId.Type

/** A workspace as a request finds it: its id (what its objects are keyed by) and its current name (what its addresses say). */
export type Workspace = { readonly id: WorkspaceId; readonly name: WorkspaceName }

export const appPath = (app: string) => `/a/${app}/`

const nameRule = (pattern: RegExp, description: string, problem: (name: string) => string) => ({
  schema: Schema.String.pipe(Schema.check(Schema.isPattern(pattern, { description }))),
  problem: (name: string) => (pattern.test(name) ? undefined : problem(name)),
})

const appName = nameRule(
  SLUG,
  'lowercase letters, digits and dashes, e.g. "standup"',
  (name) =>
    `"${name}" isn't a valid app name: use 1-40 lowercase letters, digits and dashes, starting and ending with a letter or digit (e.g. "standup")`,
)

export const AppName = appName.schema

export const appNameProblem = (name: string) =>
  appName.problem(name) ??
  (RESERVED_APP_NAMES.has(name)
    ? `"${name}" is reserved by the platform; pick another app name`
    : undefined) ??
  (name.includes("--")
    ? `"${name}" can't be an app name: its skill is named after it, and a skill's name has no "--". Use single dashes, e.g. "${name.replaceAll(/-{2,}/g, "-")}"`
    : undefined)

const collection = nameRule(
  /^[a-z0-9][a-z0-9_-]{0,39}$/,
  '1-40 lowercase letters, digits, "_" and "-", e.g. "posts"',
  (name) =>
    `"${name.slice(0, 60)}" isn't a collection name: use 1-40 lowercase letters, digits, "_" and "-", starting with a letter or digit (e.g. "posts")`,
)

export const Collection = collection.schema

export const collectionProblem = collection.problem

const functionName = nameRule(
  /^[a-z][a-z0-9_-]{0,39}$/,
  '1-40 lowercase letters, digits, "_" and "-", starting with a letter, e.g. "vote"',
  (name) =>
    `"${name.slice(0, 60)}" isn't a function name: use 1-40 lowercase letters, digits, "_" and "-", starting with a letter (e.g. "vote", the file functions/vote.js)`,
)

export const FunctionName = functionName.schema

export const TRIGGERS = ["schedule", "webhook", "data", "later"] as const

type TriggerVia = (typeof TRIGGERS)[number]

const isTrigger = (via: string): via is TriggerVia => TRIGGERS.some((t) => t === via)

const PRESENT_VIA: ReadonlySet<string> = new Set(["page", "agent"])

export const RunAuthority = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    email: Schema.String,
    testFor: Schema.NullOr(Schema.String),
    present: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  }),
  Schema.Struct({ kind: Schema.Literal("signed_out") }),
  Schema.Struct({ kind: Schema.Literal("nobody") }),
  /**
   * Anyone on the public host: a call to `fn` (openbelt.json "public".functions), or a write to a public collection (`fn` null), and
   * every run it leads to (ctx.call, ctx.later, triggers). Only the secrets and connections listed for `fn` (none for a write).
   */
  Schema.Struct({
    kind: Schema.Literal("public"),
    fn: Schema.NullOr(Schema.String),
    secrets: Schema.Array(Schema.String),
    uses: Schema.Array(Schema.String),
  }),
])

export type RunAuthority = typeof RunAuthority.Type

const NOBODYS: ReadonlySet<string> = new Set(["schedule", "webhook"])

export const authorityOf = (run: {
  readonly caller: { readonly email: string; readonly testFor?: string | undefined } | null
  readonly via: string
  readonly manual?: string | undefined
  readonly origin?: RunAuthority | undefined
}): RunAuthority => {
  if (run.caller !== null)
    return {
      kind: "person",
      email: run.caller.email,
      testFor: run.caller.testFor ?? null,
      present: PRESENT_VIA.has(run.via),
    }

  if (run.manual !== undefined)
    return NOBODYS.has(run.via)
      ? { kind: "nobody" }
      : bookedAuthority({ kind: "person", email: run.manual, testFor: null, present: true })

  return run.origin ?? (isTrigger(run.via) ? { kind: "nobody" } : { kind: "signed_out" })
}

export const bookedAuthority = (authority: RunAuthority): RunAuthority =>
  authority.kind === "person" ? { ...authority, present: false } : authority

const docId = nameRule(
  /^[A-Za-z0-9_.:@+-]{1,100}$/,
  '1-100 letters, digits and _ . : @ + -, e.g. "card-1" or "ada+qa@acme.com"',
  (id) =>
    `"${id.slice(0, 120)}" isn't a document id: use 1-100 letters, digits and _ . : @ + - (e.g. "card-1" or "ada+qa@acme.com")`,
)

export const DocId = docId.schema

export const docIdProblem = (id: string) =>
  docId.problem(id) ??
  // A URL path treats these as "this folder" and "the parent", so /_db/<collection>/.. can't name one.
  (id === "." || id === ".."
    ? `"${id}" can't be a document id: use something besides dots`
    : undefined)

export const AppFile = Schema.Struct({
  path: Schema.String.annotate({
    description: 'Path inside the app, e.g. "index.html" or "css/app.css"',
  }),
  content: Schema.optionalKey(Schema.String).annotate({
    description: "The file's text",
  }),
  base64: Schema.optionalKey(Schema.String).annotate({
    description:
      "The file's bytes in base64, instead of content: use it for binary files (images) or any text that must stay byte-exact",
  }),
})

export type AppFile = typeof AppFile.Type

export const AppEdit = Schema.Struct({
  path: Schema.String.annotate({ description: 'An existing text file, e.g. "app.js"' }),
  find: Schema.String.annotate({
    description:
      "Text copied exactly from the file (indentation and line breaks included) that occurs exactly once in it, as the earlier edits left it; a line or a few is usually enough",
  }),
  replace: Schema.String.annotate({ description: 'What find becomes ("" removes it)' }),
})

export type AppEdit = typeof AppEdit.Type

export const LineRange = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[1-9][0-9]*(-[1-9][0-9]*)?$/, {
      description: 'A 1-based line range like "40-80", or one line like "40"',
      message: 'lines is a 1-based line range like "40-80", or one line like "40"',
    }),
  ),
)

const Excerpt = Schema.Struct({
  from: Schema.Number.annotate({ description: "First line (1-based)" }),
  to: Schema.Number.annotate({ description: "Last line" }),
  text: Schema.String.annotate({
    description:
      "Lines from-to as in the file, except lines past 400 characters, cut around the match and marked ⟪… N chars⟫ (never copy that marker into a find)",
  }),
})

export type Excerpt = typeof Excerpt.Type

const ENV = /^[a-z0-9-]{1,40}$/

export const envNameProblem = (name: string) =>
  ENV.test(name)
    ? undefined
    : `"${name.slice(0, 60)}" isn't a preview environment name: use 1-40 lowercase letters, digits and dashes, named after the change (e.g. "triage" or "new-search")`

export const envProblem = (name: string) =>
  envNameProblem(name) ??
  (name === "live"
    ? `"live" is an app's live data and version, not a preview environment: name the preview after the change (e.g. "triage" or "new-search")`
    : undefined)

export const DatasetName = Schema.Union([
  Schema.Literal("live"),
  Schema.TemplateLiteral(["env_", Schema.String]),
])

export type DatasetName = typeof DatasetName.Type

export const envDataset = (env: string): DatasetName => `env_${env.replaceAll("-", "_")}`

export type Json = Schema.Json

export const Doc = Schema.Struct({
  id: Schema.String,
  collection: Schema.String,
  data: Schema.Json,
  author: Schema.String.annotate({
    description:
      "Who created it, set by the platform: the signed-in viewer's email for pages (\"anonymous\" when signed out), the token's user over MCP",
  }),
  authorName: Schema.String.annotate({
    description: "The author's display name (the same as author when there's none)",
  }),
  updatedBy: Schema.String.annotate({
    description:
      "Who last wrote it (created, updated or replaced it), set by the platform like author",
  }),
  created: Schema.String,
  updated: Schema.String,
  seq: Schema.Number,
})

export type Doc = typeof Doc.Type

const Change = Schema.Struct({
  op: Schema.Literals(["add", "update", "delete"]),
  doc: Doc,
})

export type Change = typeof Change.Type

export const DocPage = Schema.Struct({
  docs: Schema.Array(Doc),
  cursor: Schema.NullOr(Schema.String),
})

export const Deployed = Schema.Struct({
  app: Schema.String,
  url: Schema.String,
  version: Schema.String,
  live: Schema.Boolean.annotate({
    description: "false for a preview: the live app still serves its previous version",
  }),
  env: Schema.optionalKey(Schema.String).annotate({
    description: "The preview environment this version now runs in (preview deploys only)",
  }),
  previewUrl: Schema.optionalKey(Schema.String).annotate({
    description:
      "Where this version runs in the environment, over the environment's data (preview deploys only)",
  }),
  seeded: Schema.optionalKey(
    Schema.Struct({
      docs: Schema.Number.annotate({ description: "Live documents copied into the environment" }),
      capped: Schema.Boolean.annotate({
        description: "true: the app has more live documents than the cap; the newest were copied",
      }),
      skipped: Schema.optionalKey(Schema.String).annotate({
        description: "Why nothing was copied: the environment already had this app's data",
      }),
    }),
  ).annotate({ description: 'What seed: "live" copied' }),
  previous: Schema.NullOr(Schema.String).annotate({
    description:
      "The version this one replaced: the live one, or for a preview deploy the one the environment ran (null when it's new there)",
  }),
  changed: Schema.Array(Schema.String).annotate({
    description:
      "Paths this version adds, changes or removes compared to base_version (the live version without one)",
  }),
  diff: Schema.optionalKey(Schema.String).annotate({
    description:
      "With edits: a unified diff of the edited files against base_version. Past 4 KB it's cut, and its last line is the app_diff call that reads on",
  }),
  files: Schema.Number,
  uploaded: Schema.Number,
  bytes: Schema.Number,
  warnings: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "What deployed but may not do what you meant, e.g. a rule nobody can pass",
  }),
})

const VersionEntry = Schema.Struct({
  version: Schema.String,
  kind: Schema.Literals(["full", "patch"]).annotate({
    description:
      "full: deployed as the whole app; patch: edits or keep_others, on top of another version",
  }),
  by: Schema.String,
  deployedAt: Schema.String,
  promotedAt: Schema.NullOr(Schema.String).annotate({
    description: "When it last went live; null for a preview that never did",
  }),
  files: Schema.Number,
})

export type VersionEntry = typeof VersionEntry.Type

export type Writer = { readonly author: string; readonly name: string }

export const ANONYMOUS: Writer = { author: "anonymous", name: "anonymous" }

/**
 * Who writes, and how their write is judged: "apply" by the collection's rules, "bypass" by none (an agent over MCP), "public" by the
 * rules for nobody signed in and by what openbelt.json "public" lists (a page on the public host).
 */
export type Actor = {
  readonly writer: Writer
  readonly rules: "apply" | "bypass" | "public"
  readonly testFor: string | null
}

export const writeAuthority = (actor: Actor): RunAuthority =>
  actor.rules === "public"
    ? { kind: "public", fn: null, secrets: [], uses: [] }
    : authorityOf({
        caller:
          actor.writer.author === ANONYMOUS.author
            ? null
            : { email: actor.writer.author, testFor: actor.testFor ?? undefined },
        via: "write",
      })

export type BatchWrite = (
  | { readonly op: "add"; readonly data: Json }
  | {
      readonly op: "set"
      readonly id: string
      readonly data: Json
      readonly ifSeq?: number | undefined
    }
  | {
      readonly op: "update"
      readonly id: string
      readonly patch: Json
      readonly ifSeq?: number | undefined
    }
  | {
      readonly op: "delete"
      readonly id: string
      readonly ifSeq?: number | undefined
    }
) & {
  readonly author?: string | undefined
  readonly updatedBy?: string | undefined
}

export const Viewer = Schema.Struct({ email: Schema.String, name: Schema.String })

export type Viewer = typeof Viewer.Type

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/

export const emailOf = (text: string) => {
  const email = text.trim().toLowerCase()

  return EMAIL.test(email) ? email : undefined
}

export const Email = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim()),
  Schema.decode(SchemaTransformation.toLowerCase()),
  Schema.check(
    Schema.isPattern(EMAIL, {
      description: 'an email, e.g. "ada@acme.com"',
      message: 'that isn\'t an email: send one like "ada@acme.com"',
    }),
  ),
)

export const PersonId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^p_[0-9a-f]{16}$/, { description: 'like "p_3f9c0a1b2c3d4e5f"' })),
  Schema.brand("PersonId"),
)

export type PersonId = typeof PersonId.Type

export const Role = Schema.Literals(["admin", "member"])

export type Role = typeof Role.Type

export const Joining = Schema.Literals(["open", "invite"])

export type Joining = typeof Joining.Type

const group = nameRule(
  SLUG,
  'lowercase letters, digits and dashes, e.g. "support"',
  (name) =>
    `"${name.slice(0, 60)}" isn't a group name: use 1-40 lowercase letters, digits and dashes, starting and ending with a letter or digit (e.g. "support")`,
)

export const groupNameProblem = group.problem

const PersonRef = Schema.Struct({ id: PersonId, email: Schema.String })

const PersonFields = {
  id: PersonId,
  email: Schema.String,
  name: Schema.String,
  role: Role,
  created: Schema.String,
  groups: Schema.Array(Schema.String),
}

export const Person = Schema.Union([
  Schema.Struct({
    ...PersonFields,
    status: Schema.Literal("invited"),
    invitedBy: Schema.String,
  }),
  Schema.Struct({ ...PersonFields, status: Schema.Literal("active"), joined: Schema.String }),
  Schema.Struct({
    ...PersonFields,
    status: Schema.Literal("removed"),
    removed: Schema.String,
    removedBy: Schema.String,
  }),
])

export type Person = typeof Person.Type

export const Group = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    source: Schema.Literal("openbelt"),
    members: Schema.Array(PersonRef),
  }),
  Schema.Struct({
    name: Schema.String,
    source: Schema.Literal("scim"),
    externalId: Schema.String,
    members: Schema.Array(PersonRef),
  }),
])

export type Group = typeof Group.Type

/**
 * The apps an agent's sign-in or API token may use: null is every app its person can use (what a new one gets); a list is those
 * apps alone, and the agent can't see, open, make or change any other.
 */
export const AgentApps = Schema.NullOr(Schema.Array(AppName)).annotate({
  description: "The apps it may use; null for every app",
})

export type AgentApps = typeof AgentApps.Type

export const mayUseApp = (apps: AgentApps, app: string) => apps === null || apps.includes(app)

/**
 * The apps a token made by an agent limited to `within` gets: what it asked for, when it has them all itself; asking for no list
 * (or every app) gets its own. An app it doesn't have is refused.
 */
export const narrowApps = (asked: AgentApps | undefined, within: AgentApps) =>
  within === null
    ? Effect.succeed(asked ?? null)
    : asked === undefined || asked === null
      ? Effect.succeed<AgentApps>(within)
      : Effect.gen(function* () {
          const outside = asked.find((app) => !within.includes(app))

          if (outside !== undefined)
            return yield* new Refused({ message: notInApps(within, outside) })

          return asked
        })

export const decodeAgentApps = (stored: string | null): AgentApps =>
  stored === null
    ? null
    : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(AppName)))(stored)

/** What a sign-in or token limited to some apps is told when it reaches for another. */
export const notInApps = (apps: ReadonlyArray<string>, app: string) =>
  `this agent ${apps.length === 0 ? "may use no apps" : `may use only ${apps.join(", ")}`}, so not "${app}": the person it acts for adds apps to it in Settings, Agents`

export const LIMITED_CANT_MANAGE =
  "an agent limited to some apps can't change any agent's or token's access: the person it acts for does that in Settings, Agents"

export const ApiToken = Schema.Struct({
  id: Schema.String.annotate({ description: 'The id to revoke it by, like "t_1a2b3c4d5e6f"' }),
  person: PersonRef,
  label: Schema.String,
  created: Schema.String,
  expires: Schema.NullOr(Schema.String),
  apps: AgentApps,
})

export type ApiToken = typeof ApiToken.Type

export const WhoAmI = Schema.Struct({
  workspace: Schema.String,
  person: Schema.Struct({
    id: PersonId,
    email: Schema.String,
    name: Schema.String,
    role: Role,
    status: Schema.Literals(["invited", "active", "removed"]),
  }),
  groups: Schema.Array(Schema.String),
  joining: Joining,
  admins: Schema.Array(Schema.String).annotate({ description: "The workspace's admins' emails" }),
})

export type WhoAmI = typeof WhoAmI.Type

export const ManagementAnswer = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  body: Schema.Record(Schema.String, Schema.Json),
})

export type ManagementAnswer = typeof ManagementAnswer.Type

const connection = nameRule(
  /^[a-z][a-z0-9-]{0,29}$/,
  'lowercase letters, digits and dashes, starting with a letter, e.g. "deepwiki"',
  (name) =>
    `"${name.slice(0, 60)}" isn't a connection name: use 1-30 lowercase letters, digits and dashes, starting with a letter (e.g. "deepwiki"); tools are called as <name>.<tool>, so no dots`,
)

export const connectionNameProblem = (name: string) =>
  connection.problem(name) ??
  (["add", "remove", "refresh"].includes(name)
    ? `"${name}" is taken by /_workspace/connections/${name}: pick another connection name`
    : undefined)

export const CredentialOwner = Schema.Literals(["none", "workspace", "person", "both"])

export type CredentialOwner = typeof CredentialOwner.Type

export const Level = Schema.Literals(["none", "read", "all"])

export type Level = typeof Level.Type

const RunsAs = Schema.Literals(["workspace", "me", "none"])

export type RunsAs = typeof RunsAs.Type

const ConnectionTool = Schema.Struct({
  tool: Schema.String.annotate({ description: "<connection>.<tool>: what connection_call takes" }),
  description: Schema.String.annotate({ description: "The first line of the server's own" }),
  readOnly: Schema.Boolean.annotate({
    description: "The server marks it read-only (readOnlyHint), or an admin marked it read",
  }),
  usable: Schema.Boolean,
  disabled: Schema.Boolean.annotate({
    description: "The workspace's admins turned it off for everyone",
  }),
  why: Schema.optionalKey(Schema.String).annotate({
    description: "Why you can't use it, and who can change that",
  }),
  input: Schema.optionalKey(Schema.Json).annotate({
    description: "Its input schema (only with connections({ connection }))",
  }),
})

export const ConnectionView = Schema.Struct({
  connection: Schema.String,
  url: Schema.String,
  credential: CredentialOwner,
  workspaceToken: Schema.Literals(["set", "missing", "not used"]),
  yourToken: Schema.Literals(["set", "missing", "not used"]),
  runsAs: Schema.String.annotate({
    description: "Whose credential your calls run with, or what's missing for them to run",
  }),
  level: Level,
  levelFrom: Schema.String.annotate({ description: "Which setting gives you that level" }),
  ownLevel: Schema.Literals(["all", "read", "none"]).annotate({
    description:
      "What you chose for yourself: all is everything your level gives; read or none is less (the workspace's level still caps it)",
  }),
  ownOff: Schema.Array(Schema.String).annotate({
    description: "Tools you turned off for yourself",
  }),
  gets: Level.annotate({
    description: "What you get: the stricter of your level and your own choice",
  }),
  asked: Schema.optionalKey(Level).annotate({
    description: "The level you asked the workspace's admins for, while they haven't answered",
  }),
  kind: Schema.optionalKey(Schema.Literals(["openapi", "graphql"])).annotate({
    description:
      "An HTTP API (openapi: each tool is one of its operations) or a GraphQL endpoint (each Query and Mutation field), not an MCP server",
  }),
  toolCount: Schema.Number.annotate({
    description: "How many tools it has, whether or not tools lists them",
  }),
  moreTools: Schema.optionalKey(Schema.String).annotate({
    description:
      "When tools lists only some of them (a search), or none of them (too many to list): how to find the rest",
  }),
  tools: Schema.Array(ConnectionTool),
  setYourToken: Schema.optionalKey(Schema.String).annotate({
    description:
      "How you set your own token, or connect it (signIn oauth: the link that does it); never paste a token into a chat with an agent",
  }),
  provider: Schema.optionalKey(Schema.String).annotate({
    description: "The catalog provider it is (its id), when it is one",
  }),
  needsApp: Schema.optionalKey(Schema.Literal(true)).annotate({
    description:
      "Nobody can connect it yet: a workspace admin first registers an OAuth app at its sign-in server, on its page",
  }),
  signIn: Schema.optionalKey(Schema.Literals(["oauth"])).annotate({
    description:
      "oauth: its credentials are set by signing in to the server (Connect on Connections), and OpenBelt refreshes them",
  }),
  scopes: Schema.optionalKey(
    Schema.Struct({
      asked: Schema.Array(Schema.String),
      granted: Schema.optionalKey(Schema.Array(Schema.String)),
      missing: Schema.Array(Schema.String),
    }),
  ).annotate({
    description:
      "A sign-in's scopes: what it asks for, what yours was granted (a server with granular consent lets you untick some), and what's missing, which a tool that needs it is refused for",
  }),
  reconnect: Schema.optionalKey(Schema.String).annotate({
    description:
      "A sign-in that stopped working (yours or the workspace's): why, and who connects it again where",
  }),
  reconnectReason: Schema.optionalKey(
    Schema.Struct({
      whose: Schema.Literals(["yours", "workspace"]),
      kind: ReconnectKind,
      at: Schema.String,
    }),
  ).annotate({
    description:
      "Why the sign-in stopped working, as a kind (revoked, expired, cut_short, rapt, unsaved, registration, rejected_after_refresh), whose, and when",
  }),
  connect: Schema.optionalKey(ConnectLink).annotate({
    description:
      "While you (or the workspace) aren't connected, or a sign-in stopped working: the link that connects it straight away (send it to the person whose account it is), and why",
  }),
  problem: Schema.optionalKey(Schema.String).annotate({
    description: "Why the last refresh of its tool list failed (the list is the one before)",
  }),
})

export type ConnectionView = typeof ConnectionView.Type

const CollectionKey = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$|^[a-z0-9][a-z0-9_-]{0,38}\*$/, {
      description: 'a collection name, or a prefix ending in * (e.g. "posts" or "v_*")',
    }),
  ),
)

const RuleExpression = (op: RuleOp) =>
  Schema.String.check(Schema.makeFilter((source: string) => ruleProblem(op, source) ?? true))

const RuleSet = Schema.Struct({
  read: Schema.String,
  create: Schema.String,
  update: Schema.String,
  delete: Schema.String,
})

const Rules = Schema.Record(
  CollectionKey,
  Schema.Struct({
    read: Schema.optionalKey(RuleExpression("read")),
    create: Schema.optionalKey(RuleExpression("create")),
    update: Schema.optionalKey(RuleExpression("update")),
    delete: Schema.optionalKey(RuleExpression("delete")),
  }),
).pipe(
  Schema.check(Schema.makeFilter((rules) => unstatedOps(rules) ?? true)),
  Schema.decodeTo(
    Schema.Record(CollectionKey, RuleSet),
    SchemaTransformation.passthroughSupertype(),
  ),
)

const CollectionSummary = Schema.Struct({
  name: Schema.String,
  about: Schema.NullOr(Schema.String).annotate({
    description: "What a document in it holds, from the app's openbelt.json (null: not described)",
  }),
  docs: Schema.Number,
  lastWrite: Schema.NullOr(Schema.String).annotate({
    description: "When a document in it was last added or changed",
  }),
  writable: Schema.Boolean.annotate({
    description: "Whether other apps' pages may write to it (openbelt.json writable)",
  }),
  rules: Schema.NullOr(
    Schema.Struct({
      key: Schema.String.annotate({
        description: 'The openbelt.json rules key: its name, or "v_*"',
      }),
      ...RuleSet.fields,
    }),
  ).annotate({
    description:
      "Who may read, create, update and delete its documents (openbelt.json rules). null: no rules, anyone may (unless app_info's unreadable says its openbelt.json can't be read: then nobody may).",
  }),
})

export type CollectionSummary = typeof CollectionSummary.Type

const Environment = Schema.Struct({
  env: Schema.String,
  note: Schema.String.annotate({ description: "What it's for, from deploy_app's note" }),
  apps: Schema.Array(Schema.String).annotate({ description: "The apps deployed into it" }),
  lastWrite: Schema.String.annotate({
    description: "Its last deploy or data write; 7 days after it, the environment is deleted",
  }),
  by: Schema.String.annotate({ description: "Who made that deploy or write" }),
})

export type Environment = typeof Environment.Type

export const Inventory = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      version: Schema.NullOr(Schema.String),
      docs: Schema.Number,
      /** Its live version's files read back (index.html's): a platform that can't read what it stored says false. */
      serves: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  environments: Schema.Array(Schema.String),
  tokens: Schema.Number,
})

export type Inventory = typeof Inventory.Type

const CollectionDetail = Schema.Struct({
  ...CollectionSummary.fields,
  sample: Schema.NullOr(Schema.Json).annotate({
    description:
      "The newest document's data, as an example (cut short past 1500 characters). A sample isn't a contract: about is.",
  }),
})

export type CollectionDetail = typeof CollectionDetail.Type

export const CONFIG_LIMITS = {
  description: 300,
  collection: 500,
  tools: 100,
  functions: 50,
  function: 500,
  schedules: 10,
  webhooks: 20,
  triggers: 20,
  secrets: 20,
  network: 20,
  uses: 10,
} as const

export const NetworkHost = Schema.String.check(
  Schema.makeFilter(
    (host: string) =>
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/.test(
        host,
      ) ||
      `network: "${host.slice(0, 80)}" isn't a host: write just the host, like "api.example.com", or with a port, like "localhost:4599" (no https://, no path)`,
  ),
)

const ConnectionKey = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z][a-z0-9-]{0,29}$/, {
      description: 'a connection\'s name, like "deepwiki" (the connections tool lists them)',
    }),
  ),
)

export const secretNameProblem = (name: string) =>
  /^[A-Z][A-Z0-9_]{0,63}$/.test(name)
    ? undefined
    : `"${name.slice(0, 70)}" isn't a secret's name: use 1-64 capital letters, digits and "_", starting with a letter, like MAPS_API_KEY`

export const SecretName = Schema.String.check(
  Schema.makeFilter((name: string) => secretNameProblem(name) ?? true),
)

const QUALIFIED_TOOL = /^[a-z][a-z0-9-]{0,29}\.[A-Za-z0-9_.-]{1,128}$/

const ToolBinding = Schema.Literals(["workspace", "viewer"])

export type ToolBinding = typeof ToolBinding.Type

export type AppTools = Readonly<Record<string, ToolBinding>>

const atMost = (max: number, what: string) =>
  Schema.String.check(
    Schema.makeFilter(
      (text: string) =>
        text.length <= max ||
        `${what} is ${text.length} characters, over the limit of ${max}; shorten it to one line`,
    ),
  )

const Schedule = Schema.Struct({
  cron: Schema.String,
  timezone: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Json),
}).check(
  Schema.makeFilter(
    (schedule: { readonly cron: string; readonly timezone?: string }) =>
      cronProblem(schedule.cron, schedule.timezone) ?? true,
  ),
)

const Webhook = Schema.Struct({
  verify: Schema.Literals(["hmac-sha256", "github", "stripe", "token", "none"]),
  header: Schema.optionalKey(Schema.String),
  prefix: Schema.optionalKey(Schema.String),
  encoding: Schema.optionalKey(Schema.Literals(["hex", "base64"])),
  key: Schema.optionalKey(Schema.String),
})

export type Webhook = typeof Webhook.Type

const TriggerOn = Schema.String.check(
  Schema.makeFilter(
    (on: string) =>
      /^(add|update|delete|set|write):[a-z0-9][a-z0-9_-]{0,39}$/.test(on) ||
      `"${on.slice(0, 60)}" isn't a data change: name one as "<op>:<collection>", op one of add, update, delete, set (add or update) or write (any of them), e.g. "add:members"`,
  ),
)

const Trigger = Schema.Struct({
  on: Schema.Union([TriggerOn, Schema.Array(TriggerOn)]),
})

type Trigger = typeof Trigger.Type

export const RunView = Schema.Struct({
  id: Schema.String,
  function: Schema.String,
  trigger: Schema.String.annotate({
    description:
      "What started it: page, app:<name> (another app's page), agent (call_function), schedule, webhook, data (a trigger) or later (ctx.later)",
  }),
  caller: Schema.NullOr(Schema.String).annotate({
    description: "Who it ran for; null for schedule, webhook, data and later runs",
  }),
  manual: Schema.NullOr(Schema.String).annotate({
    description: "Run by hand with call_function's `as`: who ran it",
  }),
  version: Schema.NullOr(Schema.String).annotate({
    description: "The version whose code ran",
  }),
  enqueuedBy: Schema.NullOr(Schema.String).annotate({
    description: "For data and later runs: the version that booked it",
  }),
  env: Schema.NullOr(Schema.String),
  started: Schema.String,
  ms: Schema.Number,
  attempts: Schema.Number.annotate({
    description:
      "How many times it ran: more than 1 when what it read changed before it could commit, so it ran again on the new data",
  }),
  reads: Schema.Number,
  writes: Schema.Number.annotate({
    description: "Documents it committed (0 when it failed)",
  }),
  outcome: Schema.Literals(["ok", "error"]),
  error: Schema.NullOr(
    Schema.Struct({
      kind: Schema.String.annotate({
        description:
          "threw, timeout, load, busy (it didn't start: the workspace's runs were busy past their line, or the server was restarting; send it again), conflict (what it read changed: it ran again until it didn't, or it had done something outside that a re-run would repeat), signature (a webhook that wasn't signed right), bad_input (its input doesn't fit its schema; it didn't run), output (its result doesn't fit its schema; nothing kept), input (a key reused with another input), kind (db.query of a function that isn't a query), check_readonly",
      }),
      message: Schema.String,
    }),
  ),
  key: Schema.NullOr(Schema.String).annotate({
    description: "Its idempotency key",
  }),
  replayed: Schema.Boolean.annotate({
    description: "Answered from an earlier run with the same key, without running",
  }),
  input: Schema.Struct({
    bytes: Schema.Number,
    hash: Schema.String,
    preview: Schema.String,
  }),
  result: Schema.NullOr(Schema.String).annotate({
    description: "What it returned, cut short",
  }),
  logs: Schema.Array(Schema.String).annotate({
    description: "The last console lines",
  }),
  trace: Schema.String.annotate({
    description: "app_logs with this trace shows the run",
  }),
})

export type RunView = typeof RunView.Type

const ScheduleView = Schema.Struct({
  function: Schema.String,
  cron: Schema.String,
  timezone: Schema.String,
  next: Schema.NullOr(Schema.String).annotate({
    description: "When it runs next (ISO, UTC)",
  }),
  last: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      ok: Schema.Boolean,
      ms: Schema.Number,
      error: Schema.NullOr(Schema.String),
      trace: Schema.String.annotate({ description: "app_logs with this trace shows the run" }),
    }),
  ).annotate({ description: "Its last run; null before the first" }),
})

export type ScheduleView = typeof ScheduleView.Type

const functionLine = atMost(
  CONFIG_LIMITS.function,
  "this function's line (what it does, its input and result)",
)

const FunctionEntry = Schema.Union([
  functionLine,
  Schema.Struct({
    description: functionLine,
    kind: Schema.optionalKey(Schema.Literal("query")),
    internal: Schema.optionalKey(Schema.Boolean),
    input: Schema.optionalKey(JsonSchemaCodec),
    output: Schema.optionalKey(JsonSchemaCodec),
  }).check(
    Schema.makeFilter(
      (entry: { readonly input?: JsonSchema }) =>
        !Object.hasOwn(entry.input?.properties ?? {}, "_key") ||
        'input.properties has "_key", which OpenBelt keeps for the idempotency key of the function\'s tool (it never reaches the function): rename the field, e.g. "key" or "ref"',
    ),
  ),
])

type FunctionEntry = typeof FunctionEntry.Type

export type FunctionKind = "function" | "query"

export type FunctionContract = {
  readonly about: string
  readonly kind: FunctionKind
  readonly internal: boolean
  readonly input: JsonSchema | undefined
  readonly output: JsonSchema | undefined
}

const isLine = Schema.is(Schema.String)

export const contractOf = (config: AppConfig, fn: string): FunctionContract | undefined => {
  const entry = Object.hasOwn(config.functions ?? {}, fn) ? config.functions?.[fn] : undefined

  if (entry === undefined) return undefined

  if (isLine(entry))
    return { about: entry, kind: "function", internal: false, input: undefined, output: undefined }

  return {
    about: entry.description,
    kind: entry.kind ?? "function",
    internal: entry.internal ?? false,
    input: entry.input,
    output: entry.output,
  }
}

const SecretEntry = Schema.Union([
  atMost(300, "this secret's line (what it's for)"),
  Schema.Struct({
    for: atMost(300, "this secret's for (what it's for)"),
    hosts: Schema.optionalKey(Schema.Array(NetworkHost)),
  }),
])

type SecretEntry = typeof SecretEntry.Type

export type SecretDeclared = {
  readonly for: string
  readonly hosts: ReadonlyArray<string> | undefined
}

export const secretsOf = (config: AppConfig): ReadonlyMap<string, SecretDeclared> =>
  new Map(
    Object.entries(config.secrets ?? {}).map(([name, entry]) => [
      name,
      isLine(entry) ? { for: entry, hosts: undefined } : { for: entry.for, hosts: entry.hosts },
    ]),
  )

const AggregateDefinition = Schema.Union([
  Schema.Struct({ collection: Collection, op: Schema.Literal("count") }),
  Schema.Struct({
    collection: Collection,
    op: Schema.Literal("sumInteger"),
    field: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)),
  }),
])

export type AggregateDefinition = typeof AggregateDefinition.Type

export const AggregateResult = Schema.Struct({
  count: Schema.Number,
  value: Schema.Number,
  approximate: Schema.Boolean,
})

export type AggregateResult = typeof AggregateResult.Type

/** What anyone on the internet may do with a published app's collections (openbelt.json "public".collections). */
const PUBLIC_OPS = ["read", "create", "update", "delete"] as const

export type PublicOp = (typeof PUBLIC_OPS)[number]

const PublicOps = Schema.Array(Schema.Literals(PUBLIC_OPS)).check(
  Schema.makeFilter(
    (ops: ReadonlyArray<PublicOp>) =>
      (ops.length > 0 && new Set(ops).size === ops.length) ||
      'list each of "read", "create", "update" and "delete" at most once, and at least one (leave a collection out to keep it private)',
  ),
)

/**
 * openbelt.json "public": the app's page on the public host (OPENBELT_PUBLIC_HOST), for anyone, signed in or not. Its files are
 * public; of its data and functions, only what this names, and nothing else whatever the rules say. `bar: false` takes the
 * OpenBelt bar (logo, app name, Sign in) off its pages there.
 */
export const PublicBlock = Schema.Struct({
  bar: Schema.optionalKey(Schema.Boolean),
  collections: Schema.optionalKey(Schema.Record(Collection, PublicOps)),
  functions: Schema.optionalKey(
    Schema.Record(
      FunctionName,
      Schema.Struct({
        secrets: Schema.Array(SecretName),
        uses: Schema.Array(ConnectionKey),
      }),
    ),
  ),
})

export type PublicBlock = typeof PublicBlock.Type

export const AppConfig = Schema.Struct({
  public: Schema.optionalKey(PublicBlock),
  description: Schema.optionalKey(atMost(CONFIG_LIMITS.description, "description")),
  collections: Schema.optionalKey(
    Schema.Record(
      CollectionKey,
      atMost(CONFIG_LIMITS.collection, "this collection's line (what a document holds)"),
    ),
  ),
  writable: Schema.optionalKey(Schema.Array(Collection)),
  rules: Schema.optionalKey(Rules),
  aggregates: Schema.optionalKey(
    Schema.Record(Collection, AggregateDefinition).check(
      Schema.makeFilter(
        (entries) => Object.keys(entries).length <= 16 || "an app declares at most 16 aggregates",
      ),
    ),
  ),
  functions: Schema.optionalKey(
    Schema.Record(FunctionName, FunctionEntry).check(
      Schema.makeFilter(
        (functions: Readonly<Record<string, FunctionEntry>>) =>
          Object.keys(functions).length <= CONFIG_LIMITS.functions ||
          `functions lists ${Object.keys(functions).length}; an app has at most ${CONFIG_LIMITS.functions}`,
      ),
    ),
  ),
  schedules: Schema.optionalKey(
    Schema.Record(FunctionName, Schedule).check(
      Schema.makeFilter(
        (schedules: Readonly<Record<string, typeof Schedule.Type>>) =>
          Object.keys(schedules).length <= CONFIG_LIMITS.schedules ||
          `schedules lists ${Object.keys(schedules).length}; an app has at most ${CONFIG_LIMITS.schedules}`,
      ),
    ),
  ),
  webhooks: Schema.optionalKey(
    Schema.Record(FunctionName, Webhook).check(
      Schema.makeFilter(
        (hooks: Readonly<Record<string, Webhook>>) =>
          Object.keys(hooks).length <= CONFIG_LIMITS.webhooks ||
          `webhooks lists ${Object.keys(hooks).length}; an app has at most ${CONFIG_LIMITS.webhooks}`,
      ),
    ),
  ),
  secrets: Schema.optionalKey(
    Schema.Record(SecretName, SecretEntry).check(
      Schema.makeFilter(
        (secrets: Readonly<Record<string, SecretEntry>>) =>
          Object.keys(secrets).length <= CONFIG_LIMITS.secrets ||
          `secrets lists ${Object.keys(secrets).length}; an app has at most ${CONFIG_LIMITS.secrets}`,
      ),
    ),
  ),
  network: Schema.optionalKey(
    Schema.Array(NetworkHost).check(
      Schema.makeFilter(
        (hosts: ReadonlyArray<string>) =>
          hosts.length <= CONFIG_LIMITS.network ||
          `network lists ${hosts.length} hosts; an app's functions may reach at most ${CONFIG_LIMITS.network}`,
      ),
    ),
  ),
  uses: Schema.optionalKey(
    Schema.Record(
      ConnectionKey,
      atMost(CONFIG_LIMITS.function, "this connection's line (why the app needs it)"),
    ).check(
      Schema.makeFilter(
        (uses: Readonly<Record<string, string>>) =>
          Object.keys(uses).length <= CONFIG_LIMITS.uses ||
          `uses lists ${Object.keys(uses).length}; an app's functions use at most ${CONFIG_LIMITS.uses} connections`,
      ),
    ),
  ),
  triggers: Schema.optionalKey(
    Schema.Record(FunctionName, Trigger).check(
      Schema.makeFilter(
        (triggers: Readonly<Record<string, Trigger>>) =>
          Object.keys(triggers).length <= CONFIG_LIMITS.triggers ||
          `triggers lists ${Object.keys(triggers).length}; an app has at most ${CONFIG_LIMITS.triggers}`,
      ),
    ),
  ),
  tools: Schema.optionalKey(
    // Keys are checked here, not as the record's key schema: a key that fails that is "unknown".
    Schema.Record(Schema.String, ToolBinding).check(
      Schema.makeFilter((tools: Readonly<Record<string, string>>) => {
        const names = Object.keys(tools)
        const bad = names.find((name) => !QUALIFIED_TOOL.test(name))

        if (bad !== undefined)
          return `tools: "${bad.slice(0, 80)}" isn't a tool: name each as "<connection>.<tool>", like "deepwiki.ask_wiki_question" (the connections tool lists them)`

        return (
          names.length <= CONFIG_LIMITS.tools ||
          `tools lists ${names.length}; an app binds at most ${CONFIG_LIMITS.tools}`
        )
      }),
    ),
  ),
  card: Schema.optionalKey(
    Schema.Literals(["private", "public"]).annotate({
      description:
        'What a link preview (Slack, iMessage, X) shows of the app to someone not signed in: "private" (the default) names the workspace only; "public" shows its name, description and a picture of it',
    }),
  ),
  color: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(
        Schema.isPattern(/^#[0-9a-fA-F]{6}$/, {
          description: 'a hex colour, e.g. "#2563eb"',
          message: 'color is a hex colour like "#2563eb"',
        }),
      ),
    ),
  ),
})

export type AppConfig = typeof AppConfig.Type

const FunctionSummary = Schema.Struct({
  name: Schema.String,
  about: Schema.String.annotate({
    description: "What it does, its input and its result, from the app's openbelt.json",
  }),
  kind: Schema.Literals(["function", "query"]).annotate({
    description:
      "function: reads and writes, all or nothing; query: reads only, and pages can watch it live (db.query(name).watch)",
  }),
  signature: Schema.String.annotate({
    description:
      "Its TypeScript signature: from its openbelt.json input/output schemas (checked on every call), or /* observed */ from its real calls when it declares none",
  }),
  call: Schema.NullOr(Schema.String).annotate({
    description:
      "How an agent runs it as you: call_function({ app, function, input }); null when only its own app runs it (a webhook's, a trigger's or an internal function)",
  }),
})

export type FunctionSummary = typeof FunctionSummary.Type

const FunctionDetail = Schema.Struct({
  ...FunctionSummary.fields,
  typed: Schema.Boolean.annotate({
    description:
      "true when openbelt.json declares its input schema: OpenBelt refuses input that doesn't fit before it runs",
  }),
  input: Schema.NullOr(Schema.Json).annotate({
    description:
      "Its input's JSON Schema: declared, or observed from real calls (null: no calls yet)",
  }),
  output: Schema.NullOr(Schema.Json).annotate({
    description: "Its result's JSON Schema: declared, or observed (null: no calls yet)",
  }),
  triggers: Schema.Array(Schema.String).annotate({
    description:
      'What runs it besides calls: "schedule", "webhook", "data:<op>:<collection>"; call_function with `as` runs it as any of them',
  }),
  last: Schema.NullOr(RunView).annotate({
    description: "Its last run; function_runs has more",
  }),
})

export type FunctionDetail = typeof FunctionDetail.Type

const WebhookView = Schema.Struct({
  function: Schema.String,
  url: Schema.String.annotate({
    description:
      "Where outside systems POST it (verify token: webhook_secret shows the URL with its token)",
  }),
  verify: Schema.String,
  header: Schema.NullOr(Schema.String).annotate({
    description: "Where the signature goes",
  }),
  secret: Schema.String.annotate({
    description: "Whether it has one yet: webhook_secret makes it and shows it once",
  }),
})

/** A published app on the public host, as deploy_app and app_info say it: where, and exactly what anyone there reaches. */
export const PublicView = Schema.NullOr(
  Schema.Struct({
    url: Schema.String.annotate({
      description: "The app's page for anyone, signed in or not: <app>--<workspace>.<public host>",
    }),
    reaches: Schema.Array(Schema.String).annotate({
      description:
        'What anyone there reaches: the files, then each collection with its ops and each function with the secrets and connections it may use (openbelt.json "public")',
    }),
  }),
).annotate({
  description:
    'null: not public (no openbelt.json "public" in the live version, or this OpenBelt has no public host). Otherwise the public URL and what anyone there reaches',
})

const UsageWindow = Schema.Struct({
  people: Schema.Number.annotate({ description: "People who opened its page, each once" }),
  opens: Schema.Number.annotate({ description: "Pages opened, by people and on the public host" }),
  visitors: Schema.Number.annotate({
    description: "Visitors on the public host, each counted once a day",
  }),
  runs: Schema.Number.annotate({ description: "Its functions' runs on live data" }),
  failed: Schema.Number.annotate({ description: "Of those runs, how many failed" }),
})

export const AppInfo = Schema.Struct({
  app: Schema.String,
  url: Schema.String,
  public: PublicView,
  owner: Schema.String,
  usage: Schema.Struct({
    last7: UsageWindow,
    last30: UsageWindow,
    lastOpened: Schema.NullOr(Schema.String).annotate({
      description: "The UTC day it was last opened, or null: never",
    }),
  }).annotate({
    description:
      "How much it's used, in UTC days with today: the last 7 and 30. Page opens in a browser count (not agents' calls or check_app); preview environments don't",
  }),
  version: Schema.NullOr(Schema.String).annotate({ description: "The live version" }),
  deployedAt: Schema.NullOr(Schema.String),
  promotedAt: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.String),
  uploads: Schema.optionalKey(
    Schema.Struct({
      count: Schema.Number,
      bytes: Schema.Number,
      workspaceBytes: Schema.Number,
      workspaceLimit: Schema.NullOr(Schema.Number),
      fileLimit: Schema.Number,
      recent: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          url: Schema.String,
          name: Schema.NullOr(Schema.String),
          type: Schema.String,
          size: Schema.Number,
          author: Schema.String,
          env: Schema.NullOr(Schema.String),
          created: Schema.String,
        }),
      ),
    }).annotate({
      description:
        "Files people uploaded with files.put (not the app's source files): how many and their bytes, the workspace's bytes against its limit (null: none), the largest one file may be, and the newest 20",
    }),
  ),
  description: Schema.String,
  unreadable: Schema.NullOr(Schema.String).annotate({
    description:
      "null, unless this OpenBelt can't read the live version's openbelt.json (a later OpenBelt's, after a rollback): then why. Until the app is deployed again, every page read and write is refused, whatever collections' rules say",
  }),
  collections: Schema.Array(CollectionDetail).annotate({
    description: "The live data: what people see",
  }),
  functions: Schema.Array(FunctionDetail).annotate({
    description:
      "The live version's functions (openbelt.json functions), each with what triggers it and its last run: call_function runs one",
  }),
  webhooks: Schema.Array(WebhookView).annotate({
    description: "The live version's webhooks (openbelt.json webhooks)",
  }),
  secrets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      about: Schema.NullOr(Schema.String),
      hosts: Schema.NullOr(Schema.Array(Schema.String)).annotate({
        description: 'The hosts it may be sent to; null: any host in openbelt.json "network"',
      }),
      set: Schema.Boolean,
      at: Schema.NullOr(Schema.String),
    }),
  ).annotate({
    description:
      "The live openbelt.json's secrets and any set with set_secret: whether each is set (values are never shown)",
  }),
  network: Schema.Array(Schema.String).annotate({
    description: "The hosts the live version's functions may fetch (openbelt.json network)",
  }),
  skills: Schema.Array(
    Schema.Struct({
      uri: Schema.String,
      name: Schema.String,
      description: Schema.String,
      files: Schema.Number,
    }),
  ).annotate({
    description:
      "Its skills (Agent Skills): first the one OpenBelt writes on how to use it (skill://<app>/SKILL.md), then those in its skills/<name>/ folders. The skills tool reads one; MCP clients with skills support load them themselves",
  }),
  uses: Schema.Array(Schema.Struct({ connection: Schema.String, why: Schema.String })).annotate({
    description:
      "The connections the live version's functions call with ctx.connections (openbelt.json uses)",
  }),
  later: Schema.Array(
    Schema.Struct({
      function: Schema.String,
      at: Schema.String,
      key: Schema.String,
      env: Schema.NullOr(Schema.String).annotate({
        description: "The preview environment it runs in (null: live)",
      }),
    }),
  ).annotate({
    description: "Runs booked with ctx.later that haven't run yet (the next 20)",
  }),
  schedules: Schema.Array(ScheduleView).annotate({
    description:
      "The live version's schedules (openbelt.json schedules): when each runs next, and its last run",
  }),
  environments: Schema.Array(
    Schema.Struct({
      ...Environment.fields,
      version: Schema.String.annotate({ description: "The version this app runs there" }),
      previewUrl: Schema.String,
      collections: Schema.Array(CollectionSummary).annotate({
        description: "This app's data in the environment",
      }),
    }),
  ).annotate({ description: "The preview environments this app is deployed into" }),
  versions: Schema.Array(VersionEntry).annotate({
    description: "The last 20 versions, newest first; promote_app makes any of them live",
  }),
})

export const FileContent = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  content: Schema.optionalKey(Schema.String),
  base64: Schema.optionalKey(Schema.String),
  omitted: Schema.optionalKey(
    Schema.String.annotate({ description: "Why content isn't here, and how to get it" }),
  ),
  lineCount: Schema.optionalKey(
    Schema.Number.annotate({ description: "With around or lines: the file's line count" }),
  ),
  excerpts: Schema.optionalKey(
    Schema.Array(Excerpt).annotate({
      description: "With around or lines: just those parts of the file, instead of content",
    }),
  ),
})

export type FileContent = typeof FileContent.Type

export const LogLine = Schema.Struct({
  at: Schema.String,
  level: Schema.Literals(["info", "warn", "error"]),
  trace: Schema.String,
  app: Schema.String,
  message: Schema.String,
})

export type LogLine = typeof LogLine.Type

const AppRecord = Schema.Struct({
  name: Schema.String,
  id: Schema.String,
  owner: Schema.String,
  created: Schema.String,
  description: Schema.String,
})

export type AppRecord = typeof AppRecord.Type

/**
 * Who can view an app: only its owner and the workspace's admins ("private"), every member ("workspace"), or anyone on the public
 * host too ("public"). The workspace keeps private or workspace; public is the live openbelt.json's "public" block, whatever that is.
 */
export const AppView = Schema.Literals(["private", "workspace", "public"])

export type AppView = typeof AppView.Type

/** Why a member may not open a private app: only its owner and the workspace's admins may. */
export const privateApp = (app: string, workspace: string) =>
  `"${app}" is private: only its owner and admins of ${workspace} can open it. Ask its owner to share it with the workspace.`

/** What the workspace keeps of an app's view: public comes from its openbelt.json. */
export type StoredView = Exclude<AppView, "public">

/** What the person viewing an app's frame may do with its panel: every page and who can view it (the owner, an admin), the link and who can view it (a member who may open it), or nothing. */
export type PanelAccess = "manage" | "view" | "none"

export const KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const

export const MODIFIERS = ["Shift", "Control", "Alt", "Meta"] as const

const CHECK_ACTIONS = [
  "click",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "hover",
  "drag",
  "scroll",
  "press",
  "wait",
  "expect",
  "eval",
  "goto",
  "upload",
] as const

const PERSON = /^[a-z0-9-]{1,30}$/

export const PersonName = Schema.String.check(
  Schema.isPattern(PERSON, {
    description: 'A test person: 1-30 lowercase letters, digits and dashes, e.g. "alice"',
  }),
)

export const testEmail = (name: string, app: string) => `${name}@${app}.test`

export const testName = (name: string) =>
  name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")

export const TEST_PEOPLE_LIVE = 'test people work in previews: deploy with preview: "<env>"'

const SAVED = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/

export const CheckStep = Schema.Struct({
  as: Schema.optionalKey(PersonName).annotate({
    description:
      "Which test person's browser the step runs in (one of people). Default: the first person.",
  }),
  save: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(SAVED, { description: 'a name like "pollId": letters, digits and _' }),
    ),
  ).annotate({
    description:
      "eval, expect, wait: keep the step's result (eval's return value, else the element's text) as this name; later steps use it as {{name}} in any of their strings",
  }),
  action: Schema.Literals(CHECK_ACTIONS).annotate({
    description:
      'click, hover: the element at selector. fill: set the field at selector (input, textarea, contenteditable; date, time, color and range inputs too) to value as a script does, firing input and change but pressing no keys, then check it holds value (FAILED with what it holds if not). type: click into the field and type value key by key after what it holds, for when keystrokes matter (key handlers, autocomplete; "\\n" presses Enter). select: choose the option of the <select> at selector whose value, or else label, is value (fires input and change). check / uncheck: tick or untick the checkbox or radio at selector (or its label) with a click. drag: drag selector onto the element at to, with the mouse (HTML5 drag events for a draggable element), grabbing it where no control inside it is; it warns when nothing in the page moved, so follow it with expect. scroll: selector into view, or the page to value "top" or "bottom". press: a key to whatever has focus (value: Enter, Tab, Escape, an arrow key, or one character, after modifiers if any: "Shift+Enter", "Control+a"). wait: until selector is in state (default visible), for ms, or until assert is true. expect: assert about selector (text, textIncludes, value, count, visible, checked, attr), retrying for up to ms; or, with status and no selector, about the page\'s last data request (status: 403 for a rule denial). eval: run script in the page; its JSON result is in the step\'s line, and in assert as result (a thrown error is result, with its status and rule, when the step has an assert). goto: open value, a path inside the app (e.g. "admin.html"), or another app\'s page in a preview environment ("/a/<app>/_preview/<env>/"). upload: choose files for the file input at selector (hidden or not) as a person picking them, then fire input and change; value names them, comma-separated ("photo.png", "receipt.pdf,scan.jpg"), and OpenBelt makes each to fit: a real image for .png, .jpg, .webp and .gif, a one-page PDF for .pdf, text for .txt, .csv and .md, else random bytes; "deck.pdf:20MB" makes it that size (up to 200MB). To act as someone, use people and as, not a sign-in page.',
  }),
  selector: Schema.optionalKey(Schema.String).annotate({
    description:
      'Which element: CSS as document.querySelectorAll takes it (e.g. "#list li:nth-child(2) button", ".card:has(.badge)"), or text=Label for the innermost element whose text contains Label (e.g. "text=Save"). Nothing else: Playwright and jQuery extensions (:has-text(), :text-is(), :visible, :contains(), >>, role=) are refused. Actions and expect use the first visible match.',
  }),
  value: Schema.optionalKey(Schema.String).annotate({
    description:
      'fill: what the field should hold ("" empties it; a date "2026-10-26", a time "09:30", a color "#ff8800"). type: the text to type. select: the option\'s value or label. press: the key or chord. scroll: "top" or "bottom". goto: the path. upload: the file names, comma-separated, each with :<size> if it matters ("photo.png", "big.pdf:20MB"). expect: the field\'s current value.',
  }),
  to: Schema.optionalKey(Schema.String).annotate({
    description: "drag: where to drop it, a selector",
  }),
  state: Schema.optionalKey(
    Schema.Literals(["visible", "hidden", "attached", "detached"]),
  ).annotate({
    description:
      "wait: visible (default; some match is shown), hidden (none shown, or none at all), attached (some match, shown or not), detached (no match at all)",
  }),
  text: Schema.optionalKey(Schema.String).annotate({
    description: "expect: the element's exact visible text (trimmed, whitespace collapsed)",
  }),
  textIncludes: Schema.optionalKey(Schema.String).annotate({
    description: "expect: text the element's visible text contains",
  }),
  count: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "expect: how many elements match selector, shown or not (0: none)",
  }),
  visible: Schema.optionalKey(Schema.Boolean).annotate({
    description: "expect: whether the element is shown (false also holds when nothing matches)",
  }),
  checked: Schema.optionalKey(Schema.Boolean).annotate({
    description: "expect: whether the element, a checkbox or radio, is ticked",
  }),
  attr: Schema.optionalKey(Schema.Struct({ name: Schema.String, value: Schema.String })).annotate({
    description: 'expect: an attribute\'s value, e.g. { name: "aria-expanded", value: "true" }',
  }),
  script: Schema.optionalKey(Schema.String).annotate({
    description:
      "eval: the body of an async function run in the page; await works, return a JSON value to see it, a throw fails the step. E.g. \"return getComputedStyle(document.querySelector('.badge')).color\"",
  }),
  assert: Schema.optionalKey(Schema.String).annotate({
    description:
      "Any step: a JS expression that must become truthy after the step, checked in the page until ms (default 3000), e.g. \"localStorage.getItem('hideDone') === 'true'\". On an eval, result is what the script returned, or the error it threw ({ message, status, rule }): \"result.status == 403\". Prefer expect for what's on the page.",
  }),
  status: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ).annotate({
    description:
      "expect, without selector: the HTTP status the page's last data request (/_db) since this person's previous step answered (its last write, if it made one), e.g. 403 for a write the rules refuse",
  }),
  path: Schema.optionalKey(Schema.String).annotate({
    description:
      'expect with status: only requests to this path or under it, e.g. "/_db/polls/{{pollId}}" (the app\'s name before it is optional)',
  }),
  ms: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 })).annotate({
      description:
        "wait: how long (with nothing else). Otherwise how long to wait for selector, or keep retrying expect and assert (default 3000; up to 30000, for a page waiting on a connection tool, which can take 10-30 seconds)",
    }),
  ),
})

export type CheckStep = typeof CheckStep.Type

const Denial = Schema.Struct({
  person: Schema.NullOr(Schema.String).annotate({
    description: "The test person whose page sent it; null for the signed-out page",
  }),
  method: Schema.String,
  path: Schema.String.annotate({
    description:
      'Inside the app, e.g. "/_db/polls/p1"; another app\'s from the workspace\'s root, e.g. "/a/lunch/_db/votes"',
  }),
  rule: Schema.String.annotate({ description: 'Which rule refused it, e.g. "rules.polls.update"' }),
})

export const CheckReport = Schema.Struct({
  url: Schema.String.annotate({ description: "The page the browser ended on" }),
  status: Schema.NullOr(Schema.Number).annotate({ description: "The page's HTTP status" }),
  title: Schema.String,
  errors: Schema.Array(Schema.String).annotate({
    description: "Uncaught errors and unhandled rejections, each with its stack",
  }),
  console: Schema.Array(Schema.String).annotate({
    description: "console.error and console.warn calls (an Error argument with its stack)",
  }),
  dialogs: Schema.Array(Schema.String).annotate({
    description: "alert, confirm and prompt dialogs the page opened; each was accepted (OK)",
  }),
  failedRequests: Schema.Array(Schema.String).annotate({
    description:
      "Requests that failed or got a 4xx or 5xx no step expected; rule denials are in denied instead",
  }),
  denied: Schema.Array(Denial).annotate({
    description:
      "Writes openbelt.json's rules refused (403) that no expect status step asked for: an answer, not an error, but check it was meant",
  }),
  expectedDenials: Schema.Array(Denial).annotate({
    description:
      "Writes the rules refused that an expect status step, or an eval's assert on the error it threw, asked for",
  }),
  steps: Schema.Array(Schema.String).annotate({
    description:
      '"ok: <step>" (an eval\'s ends "→ <its JSON result>"), "FAILED: <step>: <why>" (the check stops there), or "not run: <step>"; with people, each starts with whose it was, "[bob] "',
  }),
  blocked: Schema.Array(Schema.String).annotate({
    description:
      'With readonly: true, the writes the browser didn\'t send, e.g. "POST /a/kanban/_db/cards"; the page got a 423 for each',
  }),
  refusedTools: Schema.Array(Schema.String).annotate({
    description:
      'The page\'s tools.call refusals (403), each the tool and its code, e.g. "[alice] linear.list_issues: test_person": an answer the page got, not a failed request',
  }),
  text: Schema.String.annotate({
    description: "The page's visible text (first 3000 characters); empty with people (see people)",
  }),
  controls: Schema.Array(Schema.String).annotate({
    description:
      "Visible buttons, links and fields: tag#id, label, current value, and a <select>'s options",
  }),
  incomplete: Schema.NullOr(Schema.String).annotate({
    description:
      "Why the check stopped early (its time limit), or null; what's here is what it saw until then",
  }),
  people: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        email: Schema.String,
        url: Schema.String,
        title: Schema.String,
        text: Schema.String,
        controls: Schema.Array(Schema.String),
      }),
    ),
  ).annotate({
    description:
      "With people: each person's page at the end (their last page): text and controls are here, shared out of the same caps, and the top-level text and controls are empty",
  }),
  ms: Schema.Number,
})

export type CheckReport = typeof CheckReport.Type

export const BrowserReport = Schema.Struct({
  kind: Schema.Literals(["error", "unhandledrejection", "console.error", "sdk", "load"]),
  message: Schema.String,
  page: Schema.String,
  at: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  trace: Schema.optionalKey(Schema.String),
})

export const Fix = Schema.Union([
  Schema.Struct({ tool: Schema.String, rename: Schema.String }),
  Schema.Struct({ tool: Schema.String, readOnly: Schema.Boolean }),
  Schema.Struct({ tool: Schema.String, require: Schema.Array(Schema.String) }),
  Schema.Struct({ tool: Schema.String, hide: Schema.Literal(true) }),
])

export type Fix = typeof Fix.Type
