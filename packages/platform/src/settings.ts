import type { EventsData } from "./events.ts"
import { PWA_HEAD } from "./pwa.ts"
import logoCss from "../../../brand/css/logo.css" with { type: "text" }
import { THEME_SCRIPT } from "./theme.ts"
import baseCss from "../../../brand/css/base.css" with { type: "text" }
import componentsCss from "../../../brand/css/components.css" with { type: "text" }
import tokensCss from "../../../brand/css/tokens.css" with { type: "text" }
import slotSvg from "../../../brand/logo/slot.svg" with { type: "text" }
import wordmarkSvg from "../../../brand/logo/openbelt.svg" with { type: "text" }
import { colorOfName } from "./colors.ts"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { connectLink, RANK } from "./access.ts"
import { NOTE_MAX } from "./connections.ts"
import {
  connectionLabel,
  escape,
  icon,
  MAIN_CSS,
  MAIN_SCRIPT,
  mainSide,
  NAV_PREFETCH,
  switcherPreconnect,
  tiles,
  toolSaid,
  topBar,
  headingHtml,
  sub,
} from "./home.ts"
import { type Inbox, inboxLink } from "./inbox.ts"
import {
  type AgentApps,
  type ApiToken,
  type ConnectionView,
  type CredentialOwner,
  type Group,
  type Joining,
  type Json,
  type Workspace,
  type WorkspaceId,
  Level,
  type Person as Member,
} from "./model.ts"
import { DEVICE_HOST, DEVICE_PATH, type SignedIn } from "./oauth.ts"
import { callbackOf, registrationOf } from "./oauth-client.ts"
import { CATALOG, type Provider, providerById } from "./providers.ts"
import { MARK_CSS, markOf } from "./marks.ts"
import { DRAWER_SCRIPT, RAIL_HEAD, SCRIM } from "./sidebar.ts"

const OwnAction = Schema.Literals([
  "token",
  "token/clear",
  "connect",
  "disconnect",
  "allow",
  "revoke",
  "asks/dismiss",
  "mine/level",
  "mine/tool",
  "mine/ask",
  "mine/unask",
  "tokens/create",
  "tokens/revoke",
  "tokens/apps",
  "signins/revoke",
  "signins/apps",
])

const AdminAction = Schema.Literals([
  "people/invite",
  "people/remove",
  "people/role",
  "joining",
  "rename",
  "scim/token",
  "scim/revoke",
  "groups/create",
  "groups/delete",
  "groups/add",
  "groups/remove",
  "access",
  "access/tool",
  "access/asks/grant",
  "access/asks/close",
  "connections/add",
  "connections/client",
  "connections/icon",
  "connections/icon/clear",
])

export type AdminAction = typeof AdminAction.Type

export const isAdminAction = Schema.is(AdminAction)

export const SettingsAction = Schema.Union([OwnAction, AdminAction])

export type SettingsAction = typeof SettingsAction.Type

export const Section = Schema.Literals(["agents", "people", "groups", "events"])

type Section = typeof Section.Type

export type WorkspacePage =
  | { readonly kind: "people" }
  | { readonly kind: "groups" }
  | { readonly kind: "group"; readonly name: string }
  | { readonly kind: "events" }
  | { readonly kind: "requests" }
  | { readonly kind: "connections" }
  | { readonly kind: "catalog" }
  | { readonly kind: "provider"; readonly id: string }
  | { readonly kind: "address" }

export const isConnectionsPage = (page: WorkspacePage) =>
  page.kind === "connections" ||
  page.kind === "catalog" ||
  page.kind === "provider" ||
  page.kind === "address"

export const workspacePageAt = (below: string): WorkspacePage | undefined => {
  const group = /^groups\/([a-z0-9-]{1,40})$/.exec(below)?.[1]

  if (group !== undefined) return { kind: "group", name: group }

  const provider = /^connections\/add\/([a-z][a-z0-9-]{0,29})$/.exec(below)?.[1]

  if (provider !== undefined) return { kind: "provider", id: provider }

  return Match.value(below).pipe(
    Match.when("connections", () => ({ kind: "connections" as const })),
    Match.when("connections/add", () => ({ kind: "catalog" as const })),
    Match.when("connections/address", () => ({ kind: "address" as const })),
    Match.orElse(() => undefined),
  )
}

export const pageAfter = (
  action: SettingsAction,
  fields: Readonly<Record<string, string>>,
  ok: boolean,
): "connections" | "agents" | WorkspacePage =>
  Match.value(action).pipe(
    Match.when(
      Match.is("tokens/create", "tokens/revoke", "tokens/apps", "signins/revoke", "signins/apps"),
      () => "agents" as const,
    ),
    Match.when(
      Match.is(
        "token",
        "token/clear",
        "connect",
        "disconnect",
        "allow",
        "revoke",
        "asks/dismiss",
        "mine/level",
        "mine/tool",
        "mine/ask",
        "mine/unask",
      ),
      () => "connections" as const,
    ),
    Match.when(
      Match.is(
        "people/invite",
        "people/remove",
        "people/role",
        "joining",
        "rename",
        "scim/token",
        "scim/revoke",
      ),
      () => ({
        kind: "people" as const,
      }),
    ),
    Match.when("groups/create", () =>
      ok ? { kind: "group" as const, name: fields["name"] ?? "" } : { kind: "groups" as const },
    ),
    Match.when("groups/delete", () =>
      ok ? { kind: "groups" as const } : { kind: "group" as const, name: fields["name"] ?? "" },
    ),
    Match.when(Match.is("groups/add", "groups/remove"), () => ({
      kind: "group" as const,
      name: fields["group"] ?? "",
    })),
    Match.when("access", () => {
      const who = fields["who"] ?? ""

      if (fields["back"] === "events") return { kind: "events" as const }

      if (fields["back"] === "requests") return { kind: "requests" as const }

      if (fields["back"] === "connection") return "connections" as const

      return who.startsWith("group:")
        ? { kind: "group" as const, name: who.slice("group:".length) }
        : { kind: "people" as const }
    }),
    Match.when(Match.is("access/tool", "access/asks/grant", "access/asks/close"), () =>
      fields["back"] === "requests" ? { kind: "requests" as const } : { kind: "events" as const },
    ),
    Match.when(
      Match.is("connections/client", "connections/icon", "connections/icon/clear"),
      () => "connections" as const,
    ),
    Match.when("connections/add", () => {
      const provider = fields["provider"] ?? ""

      if (ok) return { kind: "connections" as const }

      return provider === ""
        ? { kind: "address" as const }
        : { kind: "provider" as const, id: provider }
    }),
    Match.exhaustive,
  )

export type Ask = {
  readonly connection: string
  readonly app: string
  readonly env: string | undefined
}

export type Asked = Ask & {
  readonly problem: string | null
  readonly tools: ReadonlyArray<{ readonly tool: string; readonly description: string }>
  readonly consented: boolean
}

export type AccountData = {
  readonly person: { readonly email: string; readonly name: string; readonly role: string }
  readonly connections: ReadonlyArray<ConnectionView>
  readonly consents: ReadonlyArray<{
    readonly app: string
    readonly connection: string
    readonly tools: ReadonlyArray<string>
    readonly granted: string
  }>
  readonly tokens: ReadonlyArray<ApiToken>
  readonly signedIn: ReadonlyArray<SignedIn>
  /** The workspace's apps by name, for limiting an agent to some of them; owner is the maker's email. */
  readonly apps: ReadonlyArray<{ readonly name: string; readonly owner: string }>
  readonly asks: ReadonlyArray<{
    readonly app: string
    readonly connection: string
    readonly asked: string
  }>
  readonly ask: Asked | null
  /** With an ask, every account its app binds to "viewer" (its openbelt.json order): one review page asks for them all. */
  readonly accounts: ReadonlyArray<Asked>
  readonly admins: ReadonlyArray<string>
  readonly icons: Readonly<Record<string, string>>
  /** Each connection's Who has access, for admins (empty for everyone else). */
  readonly whoHas: Readonly<Record<string, WhoHas>>
}

export type Notice = {
  readonly ok: boolean
  readonly message: string
  readonly made: {
    readonly kind: "api" | "scim"
    readonly token: string
    readonly id: string
    readonly expires: string | null
  } | null
  readonly go?: string
}

export const doneNotice = (message: string): Notice => ({ ok: true, message, made: null })

const LEVEL_WORDS: Readonly<Record<Level, string>> = {
  none: "can't use it",
  read: "read tools only",
  all: "all tools",
}

const Removed = Schema.Struct({ revoked: Schema.Number, closed: Schema.Number })

export const adminSaid = (
  action: AdminAction,
  asked: Readonly<Record<string, string>>,
  answer: Readonly<Record<string, Json>>,
  workspace: string,
) =>
  Match.value(action).pipe(
    Match.when("people/invite", () =>
      answer["invited"] === true
        ? `Invited ${asked["email"]} as ${asked["role"] === "admin" ? "an admin" : "a member"}. They're in once they open ${workspace}.`
        : `${asked["email"]} is already in ${workspace}.`,
    ),
    Match.when("people/remove", () => {
      const counts = Schema.decodeUnknownOption(Removed)(answer)

      return `Removed ${asked["person"]}${Option.isSome(counts) ? `: ${counts.value.revoked} API ${counts.value.revoked === 1 ? "token" : "tokens"} revoked, ${counts.value.closed} open ${counts.value.closed === 1 ? "page" : "pages"} closed` : ""}.`
    }),
    Match.when(
      "people/role",
      () => `${asked["person"]} is now ${asked["role"] === "admin" ? "an admin" : "a member"}.`,
    ),
    Match.when(Match.is("joining", "rename"), (a) =>
      a === "rename"
        ? `The workspace is called ${workspace} now. Its old names still reach it, and pages opened there come here. Signed in with an email? Sign in again here.`
        : asked["joining"] === "invite"
          ? `Only people invited here can join ${workspace} now.`
          : `Anyone the front door lets in joins ${workspace} on their first visit now.`,
    ),
    Match.when("scim/token", () => "Made a SCIM token."),
    Match.when(
      "scim/revoke",
      () => "Revoked the SCIM token: your directory can't use it any more.",
    ),
    Match.when("groups/create", () =>
      answer["created"] === true
        ? `Made the group ${asked["name"]}. Add people to it below.`
        : `There's already a group ${asked["name"]}.`,
    ),
    Match.when("groups/delete", () => `Deleted the group ${asked["name"]}.`),
    Match.when("groups/add", () => `Added ${asked["person"]} to ${asked["group"]}.`),
    Match.when("groups/remove", () => `Took ${asked["person"]} out of ${asked["group"]}.`),
    Match.when("access", () => {
      const who = asked["who"] ?? ""
      const level = Schema.decodeUnknownOption(Level)(asked["level"])
      const group = who.startsWith("group:")
      const name = group ? who.slice("group:".length) : who.slice("person:".length)

      const words = Option.isSome(level)
        ? LEVEL_WORDS[level.value]
        : group
          ? "the same as everyone"
          : "no exception"

      return `${connectionLabel(asked["connection"] ?? "")} for ${name === "everyone" ? "everyone" : name}: ${words}.`
    }),
    Match.when(
      "access/tool",
      () =>
        `${asked["connection"]}.${asked["tool"]} is ${asked["change"] === "disable" ? "off" : "back on"} for everyone.`,
    ),
    Match.when("access/asks/grant", () => {
      const n = Array.isArray(answer["people"]) ? answer["people"].length : 0

      return `Gave ${n === 1 ? "them" : `${n} people`} ${asked["want"]} on ${connectionLabel(asked["connection"] ?? "")}, as an exception each, as they asked.`
    }),
    Match.when("access/asks/close", () => {
      const n = Array.isArray(answer["people"]) ? answer["people"].length : 0

      return `Not now: closed ${n === 1 ? "the ask" : `${n} asks`} for ${asked["want"]} on ${connectionLabel(asked["connection"] ?? "")}. They can ask again.`
    }),
    Match.when(
      "connections/client",
      () =>
        `Saved ${connectionLabel(asked["connection"] ?? "")}'s OAuth app. People can connect it now.`,
    ),
    Match.when(Match.is("connections/icon", "connections/icon/clear"), (done) =>
      done === "connections/icon"
        ? `${connectionLabel(asked["connection"] ?? "")} has your icon now, for everyone.`
        : `Removed ${connectionLabel(asked["connection"] ?? "")}'s icon: it's back to its own.`,
    ),
    Match.when("connections/add", () => {
      const added = Schema.decodeUnknownOption(Added)(answer)

      if (Option.isNone(added)) return "Added it."

      const { connection, listed } = added.value
      const label = connectionLabel(connection.name)

      if (listed.tools !== undefined)
        return `Added ${label}, with ${listed.tools} ${listed.tools === 1 ? "tool" : "tools"}: ${LEVEL_WORDS_ADDED[connection.everyone]}.`

      if (listed.problem !== undefined)
        return `Added ${label}, but OpenBelt couldn't list its tools (${listed.problem}). It shows as not working until it can.`

      return connection.credential === "person"
        ? `Added ${label}. People connect their own the first time an agent or app needs it.`
        : `Added ${label}. Open it to connect the workspace's account, once, for everyone.`
    }),
    Match.exhaustive,
  )

const Added = Schema.Struct({
  connection: Schema.Struct({ name: Schema.String, credential: Schema.String, everyone: Level }),
  listed: Schema.Struct({
    tools: Schema.optional(Schema.Number),
    problem: Schema.optional(Schema.String),
  }),
})

const LEVEL_WORDS_ADDED: Readonly<Record<Level, string>> = {
  none: "nobody can use it yet",
  read: "everyone can use the ones that only read",
  all: "everyone can use them all",
}

export const refusedNotice = (message: string): Notice => ({ ok: false, message, made: null })

/** Who gets a connection, for its page (admins): everyone's level, then each group and exception that sets one. */
export type WhoHas = {
  readonly everyone: Level
  readonly groups: ReadonlyArray<{
    readonly name: string
    readonly members: number
    readonly level: Level
  }>
  readonly people: ReadonlyArray<{
    readonly email: string
    readonly name: string
    readonly level: Level
  }>
  /** Groups and people without a level of their own here, to add one. */
  readonly unset: {
    readonly groups: ReadonlyArray<string>
    readonly people: ReadonlyArray<{ readonly email: string; readonly name: string }>
  }
}

export type Result = { readonly level: Level; readonly from: string }

export type WorkspaceData = {
  readonly me: string
  readonly joining: Joining
  /** Who asked to join (from the base host's workspace picker) and isn't invited yet. */
  readonly asks: ReadonlyArray<string>
  readonly scim: {
    readonly tokens: ReadonlyArray<{
      readonly id: string
      readonly label: string
      readonly created: string
      readonly madeBy: string
      readonly lastUsed: string | null
      readonly revoked: string | null
    }>
    readonly recent: ReadonlyArray<{
      readonly at: string
      readonly method: string
      readonly path: string
      readonly status: number
      readonly note: string
      readonly trace: string
    }>
  }
  readonly people: ReadonlyArray<Member>
  readonly groups: ReadonlyArray<Group>
  readonly connections: ReadonlyArray<{
    readonly connection: string
    readonly credential: CredentialOwner
    readonly everyone: Level
    readonly groups: Readonly<Record<string, Level>>
    readonly people: Readonly<Record<string, Level>>
    readonly result: Readonly<Record<string, Result>>
    readonly status: ConnectionStatus
  }>
  readonly registered: ReadonlyArray<string>
  readonly icons: Readonly<Record<string, string>>
}

export type ConnectionStatus = {
  readonly needsApp: boolean
  readonly workspaceSignIn: "set" | "missing" | "stopped" | "not used"
  readonly connected: number
  /** Why OpenBelt couldn't list its tools the last time it tried; null while it can. */
  readonly problem: string | null
}

export type AsksData = {
  readonly groups: ReadonlyArray<{
    readonly connection: string
    readonly want: "read" | "all"
    readonly asks: ReadonlyArray<{
      readonly email: string
      readonly name: string
      readonly groups: ReadonlyArray<string>
      readonly note: string
      readonly asked: string
      readonly level: Level
      readonly from: string
    }>
    readonly sources: ReadonlyArray<readonly [string, number]>
    readonly suggestion: {
      readonly who: string
      readonly answered: number
      readonly moved: ReadonlyArray<string>
      readonly others: ReadonlyArray<string>
    } | null
  }>
}

const SETTINGS_SIDE_CSS = `
.side > .nav:first-child { padding-top: var(--openbelt-space-sm); }
.side h2 { font: var(--openbelt-type-label); color: var(--openbelt-color-muted); margin: var(--openbelt-space-lg) var(--openbelt-space-md) var(--openbelt-space-2xs); }
.side .nav a.back { color: var(--openbelt-color-primary); }
`

const BACK = `<a class="back" href="/">${icon("arrowLeft")}<span class="label">Back</span></a>`

const STYLE = `
[hidden] { display: none !important; }
main { min-width: 0; width: 100%; max-width: 864px; padding: var(--openbelt-space-lg) var(--openbelt-space-xl) var(--openbelt-space-3xl); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-xl); align-content: start; }
.top { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-lg); }
.head h1 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
.head p { margin-top: var(--openbelt-space-2xs); color: var(--openbelt-color-muted); }
.head-act { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--openbelt-space-md); }
.head-act > div { flex: 1 1 auto; min-width: 0; }
.head-act > .btn { flex: none; }
.head-act > .actions { flex: none; display: flex; gap: var(--openbelt-space-xs); }
.addform { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-lg); }
.addform fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
.addform legend { padding: 0; margin-bottom: var(--openbelt-space-2xs); }
.addform .field .small { font-weight: 400; }
.setup { display: grid; gap: var(--openbelt-space-md); padding: var(--openbelt-space-md); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); justify-items: start; }
.setup > .field { width: 100%; }
#catalog .rows { margin-top: var(--openbelt-space-xs); }
#catalog .crow .name small { white-space: normal; }
.cgroup { display: grid; border-bottom: 1px solid var(--openbelt-color-border); }
.cgroup h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--openbelt-space-2xs) var(--openbelt-space-xs); padding: var(--openbelt-space-sm) var(--openbelt-space-2xs) var(--openbelt-space-2xs); font: var(--openbelt-type-label); }
.cgroup h3 .small { font-weight: 400; }

.cgroup .crow:last-child { border-bottom: 0; }
.head .said .state { display: inline-flex; margin-right: var(--openbelt-space-xs); color: var(--openbelt-color-primary); font-weight: 550; }
.head .act { flex: none; display: flex; align-items: center; }
.head .act form { margin: 0; }
.lack { display: flex; gap: var(--openbelt-space-sm); align-items: flex-start; padding: var(--openbelt-space-md); }
.lack > .icon { flex: none; margin-top: 2px; color: var(--openbelt-color-warning); }
#problem > .icon { color: var(--openbelt-color-error); }
.lack > div { flex: 1; min-width: 0; display: grid; gap: var(--openbelt-space-sm); justify-items: start; }
.lack p { color: var(--openbelt-color-muted); }
.lack p b { color: var(--openbelt-color-primary); font-weight: 550; }
.lack code, .steps code { font: var(--openbelt-type-mono-sm); overflow-wrap: anywhere; }
.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; display: grid; gap: var(--openbelt-space-sm); width: 100%; }
.steps li { position: relative; counter-increment: step; padding-left: 32px; display: grid; gap: var(--openbelt-space-xs); justify-items: start; }
.steps li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 22px; height: 22px; display: grid; place-items: center; border: 1px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-full); font: var(--openbelt-type-label); font-size: 11px; color: var(--openbelt-color-muted); }
.steps li .copy-field { width: 100%; }
.clientform { display: grid; gap: var(--openbelt-space-sm); width: 100%; max-width: 520px; }
details.setup > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px var(--openbelt-space-sm); align-items: center; font-weight: 550; }
details.setup > summary::-webkit-details-marker { display: none; }
details.setup > summary .small { grid-row: 2; font-weight: 400; }
details.setup > summary .icon { grid-row: 1 / span 2; grid-column: 2; color: var(--openbelt-color-muted); transition: transform var(--openbelt-duration) var(--openbelt-ease); }
details.setup[open] > summary .icon { transform: rotate(180deg); }
details.setup[open] { display: grid; gap: var(--openbelt-space-md); }
.recipes { border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); }
.recipe + .recipe { border-top: 1px solid var(--openbelt-color-border); }
.recipe > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: var(--openbelt-space-sm); min-height: 44px; padding: var(--openbelt-space-xs) var(--openbelt-space-md); }
.recipe > summary::-webkit-details-marker { display: none; }
.recipe > summary > span { flex: 1; min-width: 0; }
.recipe > summary b { margin-right: var(--openbelt-space-xs); font: var(--openbelt-type-label); }
.recipe > summary .icon { flex: none; color: var(--openbelt-color-muted); transition: transform var(--openbelt-duration) var(--openbelt-ease); }
.recipe[open] > summary .icon { transform: rotate(180deg); }
.recipe > div { display: grid; gap: var(--openbelt-space-xs); padding: 0 var(--openbelt-space-md) var(--openbelt-space-md); }
#token .row + .row { padding-top: var(--openbelt-space-md); border-top: 1px solid var(--openbelt-color-border); }
section { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-md); align-content: start; }
section > header h2 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); }
section > header p { margin-top: var(--openbelt-space-2xs); color: var(--openbelt-color-muted); }
section > header code, .head code { font: var(--openbelt-type-mono-sm); overflow-wrap: anywhere; }
.small { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.row { display: flex; align-items: center; gap: var(--openbelt-space-md); }
.row .about { flex: 1; min-width: 0; display: grid; gap: 2px; }
.row .about b { font-weight: 550; overflow-wrap: anywhere; }
.row .about code { font: var(--openbelt-type-mono-sm); }
.row form { flex: none; }
.mark { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-surface); color: var(--openbelt-color-muted); font: var(--openbelt-type-label); }
.needs { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: var(--openbelt-space-sm); }
.need { padding: var(--openbelt-space-md); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-md); align-content: start; }
.need .pair { max-width: none; }
.need .ntile { flex: none; width: 32px; height: 32px; border-radius: var(--openbelt-radius-sm); display: grid; place-items: center; font: 600 15px/1 var(--openbelt-font-body); }
.need .for { font-weight: 600; overflow-wrap: anywhere; }
.need .actions { display: flex; align-items: center; gap: var(--openbelt-space-xs); }
.named { display: flex; align-items: center; gap: var(--openbelt-space-sm); min-width: 0; }
.named > div { flex: 1; min-width: 0; display: grid; gap: 2px; }
.named > .acts { flex: none; display: flex; gap: var(--openbelt-space-xs); }
details.names > .opt { margin-top: var(--openbelt-space-xs); padding-top: var(--openbelt-space-xs); border-top: 1px solid var(--openbelt-color-border); }
@media (max-width: 640px) { .agrp > .named { flex-wrap: wrap; } .agrp > .named > .acts { width: 100%; margin-left: 44px; } }
.named a { font-weight: 550; color: inherit; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.named a:hover, .crow:hover .name { text-decoration: underline; text-decoration-color: var(--openbelt-color-border-strong); text-underline-offset: 3px; }
.rows { display: grid; grid-template-columns: minmax(0, 1fr); border-top: 1px solid var(--openbelt-color-border); }
.crow { display: flex; align-items: center; gap: var(--openbelt-space-sm); min-width: 0; padding: var(--openbelt-space-xs) var(--openbelt-space-2xs); border-bottom: 1px solid var(--openbelt-color-border); color: inherit; text-decoration: none; transition: background-color var(--openbelt-duration) var(--openbelt-ease); }
.crow:hover { background: var(--openbelt-color-surface); }
.crow .mark { width: 28px; height: 28px; }
${MARK_CSS}.crow .name { flex: 1; min-width: 0; display: grid; gap: 1px; }
.crow .name b { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crow .name small { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crow > .icon { color: var(--openbelt-color-muted); }
#connections .rows { border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); overflow: hidden; }
#connections .crow { padding: var(--openbelt-space-xs) var(--openbelt-space-md); min-height: 52px; }
#connections .crow:last-child { border-bottom: 0; }
#connections .c-cols { display: flex; justify-content: space-between; padding: 0 calc(var(--openbelt-space-md) + 16px + var(--openbelt-space-sm)) 0 var(--openbelt-space-md); height: 36px; align-items: center; background: var(--openbelt-color-surface); border-bottom: 1px solid var(--openbelt-color-border); font: var(--openbelt-type-body-sm); font-weight: 500; color: var(--openbelt-color-muted); }
.c-lvl { flex: none; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); white-space: nowrap; }
.c-lvl.is-all { color: var(--openbelt-color-primary); }
.c-lvl.is-none { color: var(--openbelt-color-muted); }
#withheld .rows { margin-top: var(--openbelt-space-xs); }
.list-of { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-sm); }
.list-of > header { display: flex; align-items: baseline; justify-content: space-between; gap: var(--openbelt-space-md); flex-wrap: wrap; }
.list-of h2, details > summary h2 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); display: flex; align-items: baseline; gap: var(--openbelt-space-xs); }
.n { font: var(--openbelt-type-mono-sm); color: var(--openbelt-color-muted); font-weight: 400; }
details.list-of > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--openbelt-space-2xs) var(--openbelt-space-sm); }
details.list-of > summary::-webkit-details-marker, details.names > summary::-webkit-details-marker { display: none; }
@media (max-width: 640px) { details.list-of > summary { grid-template-columns: minmax(0, 1fr) auto; } details.list-of > summary > .small { grid-area: 2 / 1 / 3 / -1; } }
details.list-of > summary > .icon { color: var(--openbelt-color-muted); transition: transform var(--openbelt-duration) var(--openbelt-ease); }
details[open].list-of > summary > .icon { transform: rotate(180deg); }
#connections { gap: var(--openbelt-space-xl); }
section.empty, #connections.empty { gap: var(--openbelt-space-2xs); }
section.empty form { width: min(440px, 100%); margin-top: var(--openbelt-space-md); text-align: left; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: var(--openbelt-space-2xs); font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.crumbs a { color: var(--openbelt-color-muted); text-decoration: none; }
.crumbs a:hover { color: var(--openbelt-color-primary); text-decoration: underline; text-underline-offset: 3px; }
.crumbs .icon { width: 14px; height: 14px; color: var(--openbelt-color-border-strong); }
.crumbs [aria-current] { color: var(--openbelt-color-primary); font-weight: 550; }
.lvpick { display: inline-flex; gap: 2px; width: fit-content; padding: 2px; border: 1px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-sm); }
.lvpick .btn { height: calc(var(--openbelt-control-height) - 6px); padding: 0 var(--openbelt-space-sm); color: var(--openbelt-color-muted); }
.lvpick .btn[aria-pressed="true"] { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); font-weight: 550; }
.lvpick .btn:disabled { opacity: 0.6; cursor: not-allowed; }
.lvpick .btn .icon { width: 14px; height: 14px; }
.askform { display: grid; gap: var(--openbelt-space-sm); }
.askform details.why > summary { width: fit-content; cursor: pointer; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); text-decoration: underline; text-underline-offset: 3px; list-style: none; }
.askform details.why > summary::-webkit-details-marker { display: none; }
.askform details.why[open] > summary { display: none; }
.askform details.why .input { width: 100%; }
.askform .list, .askform .trows > .trow { border: 0; padding: 0; background: none; }
.askform .trows { gap: var(--openbelt-space-2xs); }
.askform .trow .tname { font-weight: 400; }
.askform .field { color: var(--openbelt-color-primary); gap: 2px; }
.askform .field .small { font-weight: 400; }
.askform .field .input { margin-top: var(--openbelt-space-xs); }
.count { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); letter-spacing: normal; }
.asked { display: grid; gap: var(--openbelt-space-xs); justify-items: start; }
.trows > .trow { display: flex; align-items: center; gap: var(--openbelt-space-md); padding: var(--openbelt-space-sm) var(--openbelt-space-md); }
.trow .about { flex: 1; min-width: 0; display: grid; gap: 2px; }
.trow .tname { font-weight: 550; overflow-wrap: anywhere; }
.trow code { font: var(--openbelt-type-mono-sm); color: var(--openbelt-color-muted); }
.trow .small { display: flex; align-items: flex-start; gap: 4px; overflow-wrap: anywhere; }
.trow .small .icon { width: 12px; height: 12px; flex: none; margin-top: 3px; }
.trow.locked code { color: var(--openbelt-color-muted); }
.switch { position: relative; flex: none; width: 34px; height: 20px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-border-strong); border: 0; cursor: pointer; transition: background-color var(--openbelt-duration) var(--openbelt-ease); }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-neutral); transition: transform var(--openbelt-duration) var(--openbelt-ease); }
.switch[aria-checked="true"] { background: var(--openbelt-color-success); }
.switch[aria-checked="true"]::after { transform: translateX(14px); }
.switch:disabled { opacity: 0.4; cursor: not-allowed; }
.qlabel { font: var(--openbelt-type-label); color: var(--openbelt-color-primary); letter-spacing: normal; }
.mark.xs { width: 24px; height: 24px; border-radius: var(--openbelt-radius-full); }
.mark.xs .icon { width: 13px; height: 13px; }
.tail { color: var(--openbelt-color-primary); }
.verdict { display: grid; gap: var(--openbelt-space-md); padding: var(--openbelt-space-lg); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-lg); }
.verdict .line { display: flex; gap: var(--openbelt-space-sm); align-items: flex-start; }
.verdict .big { flex: none; width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--openbelt-radius-full); }
.verdict.is-yes .big { color: var(--openbelt-color-success); background: color-mix(in srgb, var(--openbelt-color-success) 14%, transparent); }
.verdict.is-no .big { color: var(--openbelt-color-error); background: color-mix(in srgb, var(--openbelt-color-error) 14%, transparent); }
.verdict .line p { color: var(--openbelt-color-muted); }
.verdict > :not(.line) { margin-left: 48px; }
.trail { list-style: none; margin: 0; padding: 0; display: grid; }
.trail li { position: relative; display: grid; grid-template-columns: 20px 52px minmax(0, 1fr); gap: var(--openbelt-space-sm); padding: 6px 0; line-height: 20px; }
.trail li::before { content: ""; position: absolute; left: 9.5px; top: 28px; bottom: -6px; width: 1px; background: var(--openbelt-color-border); }
.trail li:last-child::before { display: none; }
.trail li > :last-child { min-width: 0; overflow-wrap: anywhere; }
.trail .st { width: 20px; height: 20px; display: grid; place-items: center; border-radius: var(--openbelt-radius-full); border: 1px solid color-mix(in srgb, var(--openbelt-color-success) 45%, transparent); color: var(--openbelt-color-success); }
.trail .st .icon { width: 12px; height: 12px; }
.layer { font: var(--openbelt-type-body-sm); line-height: 20px; color: var(--openbelt-color-muted); }
.verdict .line p.why { color: var(--openbelt-color-primary); margin-top: var(--openbelt-space-2xs); }
.verdict .tech ol { list-style: none; margin: var(--openbelt-space-xs) 0 0; padding: 0; display: grid; gap: var(--openbelt-space-2xs); }
.verdict .tech li { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: var(--openbelt-space-sm); font: var(--openbelt-type-mono-sm); color: var(--openbelt-color-muted); }
.verdict .tech li > :last-child { min-width: 0; overflow-wrap: anywhere; }
.verdict .tech .layer { font: var(--openbelt-type-body-sm); line-height: inherit; }
#directory-requests .tech ol { list-style: none; margin: var(--openbelt-space-xs) 0 0; padding: 0; display: grid; gap: var(--openbelt-space-2xs); }
#directory-requests .tech li { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); overflow-wrap: anywhere; }
#directory-requests .tech code { font: var(--openbelt-type-mono-sm); }
details.names > .trail { margin-top: var(--openbelt-space-xs); }
.grants { display: grid; margin-top: var(--openbelt-space-sm); border-top: 1px solid var(--openbelt-color-border); }
.grant { display: flex; align-items: flex-start; gap: var(--openbelt-space-md); padding: var(--openbelt-space-sm) 0; border-bottom: 1px solid var(--openbelt-color-border); }
.grant .about { flex: 1; min-width: 0; display: grid; gap: 2px; }
.grant b { font-weight: 550; }
details.names > summary { list-style: none; cursor: pointer; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); text-decoration: underline; text-underline-offset: 3px; width: fit-content; }
details.names > .faces, details.names > .list { margin-top: var(--openbelt-space-xs); }
.faces { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.face { display: inline-flex; align-items: center; height: 24px; padding: 0 var(--openbelt-space-xs); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-full); font: var(--openbelt-type-body-sm); color: inherit; text-decoration: none; }
a.face:hover { border-color: var(--openbelt-color-border-strong); }
.nope { color: var(--openbelt-color-error); }
.kept .row > span:first-child { flex: none; display: inline-flex; align-self: flex-start; margin-top: 2px; }
.kept a { color: inherit; text-decoration: none; }
.kept a:hover b { text-decoration: underline; text-underline-offset: 3px; }
.kept code { font: var(--openbelt-type-mono-sm); }
.agrps { display: grid; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); }
.agrp { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--openbelt-space-sm); align-items: start; padding: var(--openbelt-space-sm) var(--openbelt-space-md); }
.agrp .lines { display: grid; gap: 2px; min-width: 0; }
.agrp { align-items: start; }
.agrp .lines { grid-template-columns: 9rem minmax(0, 1fr); align-items: center; column-gap: var(--openbelt-space-sm); row-gap: var(--openbelt-space-xs); }
.agrp .lines > b { grid-row: 1; align-self: center; }
.agrp .lines > .level-ask { grid-column: 2; }
.agrp .lines > details { grid-column: 1 / -1; }
.agrp > .mark { align-self: start; }
@media (max-width: 640px) { .agrp .lines { grid-template-columns: minmax(0, 1fr); } .agrp .lines > .level-ask { grid-column: 1; } }
.agrp .level-ask { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--openbelt-space-xs); }
.agrp .level-ask .acts { display: flex; gap: var(--openbelt-space-xs); }
.agrp .level-ask a { color: inherit; text-decoration: underline; text-decoration-color: var(--openbelt-color-border-strong); text-underline-offset: 3px; }
.agrp + .agrp { border-top: 1px solid var(--openbelt-color-border); }
.quotes { display: grid; gap: 2px; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.agrp > .actions { gap: var(--openbelt-space-xs) var(--openbelt-space-sm); }
.opts { display: grid; border-top: 1px solid var(--openbelt-color-border); }
.opt { display: flex; align-items: center; gap: var(--openbelt-space-md); padding: var(--openbelt-space-sm) 0; }
.opt + .opt { border-top: 1px solid var(--openbelt-color-border); }
.agrp > .actions { justify-content: flex-end; }
.opt .about { flex: 1; min-width: 0; display: grid; gap: 2px; }
.opt b { font-weight: 550; }
.opt form { flex: none; }
.agrp details.names:not([open]):has(> summary[hidden]) { display: none; }
.tabs { display: flex; gap: var(--openbelt-space-lg); border-bottom: 1px solid var(--openbelt-color-border); }
.tabs a { padding: 0 0 var(--openbelt-space-xs); margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--openbelt-color-muted); font: var(--openbelt-type-label); text-decoration: none; }
.tabs a:hover { color: var(--openbelt-color-primary); }
.tabs a[aria-current="page"] { color: var(--openbelt-color-primary); border-bottom-color: var(--openbelt-color-primary); }
main:has(.reqs) { max-width: 1160px; }
.reqs { --req-cols: minmax(0, 1.1fr) 136px minmax(0, 1.6fr) 96px 112px; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); overflow: hidden; }
.req-cols, .req-row { display: grid; grid-template-columns: var(--req-cols); align-items: center; gap: var(--openbelt-space-md); padding: 0 var(--openbelt-space-md); }
.req-cols { height: 36px; background: var(--openbelt-color-surface); border-bottom: 1px solid var(--openbelt-color-border); font: var(--openbelt-type-body-sm); font-weight: 500; color: var(--openbelt-color-muted); }
.req + .req { border-top: 1px solid var(--openbelt-color-border); }
.req-row { min-height: 52px; padding-top: var(--openbelt-space-xs); padding-bottom: var(--openbelt-space-xs); }
.req-conn, .req-who { display: flex; align-items: center; gap: var(--openbelt-space-sm); min-width: 0; }
.req-conn .mark { width: 24px; height: 24px; }
.req-conn b { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.req-level { justify-self: start; padding: 2px var(--openbelt-space-xs); border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); font: var(--openbelt-type-body-sm); white-space: nowrap; }
.req-level.is-all { color: var(--openbelt-color-warning); background: color-mix(in srgb, var(--openbelt-color-warning) 12%, transparent); }
.req-faces { display: flex; flex: none; }
.req-face { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-subtle); border: 2px solid var(--openbelt-color-neutral); color: var(--openbelt-color-muted); font-size: 9px; font-weight: 600; }
.req-face + .req-face { margin-left: -6px; }
.req-who a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-decoration: underline; text-decoration-color: var(--openbelt-color-border-strong); text-underline-offset: 3px; }
.req-when { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.req .acts { display: flex; align-items: center; justify-content: end; gap: var(--openbelt-space-2xs); }
.req .acts .btn-secondary { height: 30px; }
.req > details.names { padding: 0 var(--openbelt-space-md) var(--openbelt-space-md) calc(var(--openbelt-space-md) + 24px + var(--openbelt-space-sm)); }
.req > details.names[open] { background: var(--openbelt-color-surface); padding-top: var(--openbelt-space-xs); }
.req > details.names:not([open]):has(> summary[hidden]) { display: none; }
.req > details.names > .list { margin-top: 0; }
.req-foot { padding: var(--openbelt-space-xs) var(--openbelt-space-md); border-top: 1px solid var(--openbelt-color-border); background: var(--openbelt-color-surface); color: var(--openbelt-color-muted); }
@media (max-width: 760px) {
  .req-cols { display: none; }
  .req-row { grid-template-columns: minmax(0, 1fr) auto; gap: var(--openbelt-space-2xs) var(--openbelt-space-sm); padding-top: var(--openbelt-space-sm); padding-bottom: var(--openbelt-space-sm); }
  .req-conn { grid-column: 1; grid-row: 1; }
  .req .acts { grid-column: 2; grid-row: 1 / 3; }
  .req-level { grid-column: 1; grid-row: 2; margin-left: calc(24px + var(--openbelt-space-sm)); }
  .req-who { grid-column: 1 / -1; grid-row: 3; padding-left: calc(24px + var(--openbelt-space-sm)); font: var(--openbelt-type-body-sm); }
  .req-when { display: none; }
  .req > details.names { padding-left: var(--openbelt-space-md); }
}
main:has(> #requests) { gap: var(--openbelt-space-lg); }
.suggest a { white-space: nowrap; }
.never { display: inline-flex; align-items: center; gap: var(--openbelt-space-2xs); color: var(--openbelt-color-warning); }
.never .icon { width: 12px; height: 12px; }
.state { flex: none; display: inline-flex; align-items: center; gap: 6px; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); white-space: nowrap; }
.state::before { content: ""; width: 7px; height: 7px; border-radius: var(--openbelt-radius-full); background: var(--tone); }
.is-success { --tone: var(--openbelt-color-success); }
.is-error { --tone: var(--openbelt-color-error); }
.is-muted { --tone: var(--openbelt-color-muted); }
.is-warning { --tone: var(--openbelt-color-warning); }

main:has(> .event-feed) { max-width: 1160px; }
.event-controls { display: grid; gap: var(--openbelt-space-sm); }
.event-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--openbelt-space-xs); }
.event-search { position: relative; display: flex; align-items: center; flex: 1 1 280px; max-width: 420px; }
.event-search > .icon { position: absolute; left: 10px; width: 16px; height: 16px; color: var(--openbelt-color-muted); pointer-events: none; }
.event-search .input { width: 100%; padding-left: 34px; }
.event-count { margin-left: auto; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.event-shortcuts, .event-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.event-shortcuts .btn { font: var(--openbelt-type-label); font-weight: 500; padding: 0 10px; gap: 6px; color: var(--openbelt-color-muted); }
.event-shortcuts .btn:hover, .event-filter[open] > summary { color: var(--openbelt-color-primary); background: var(--openbelt-color-surface); }
.event-shortcuts .icon { width: 14px; height: 14px; flex: 0 0 14px; }
.event-filter { position: relative; }
.event-filter > summary { list-style: none; cursor: pointer; }
.event-filter > summary::-webkit-details-marker { display: none; }
.event-picker { position: absolute; z-index: 5; top: calc(100% + 6px); left: 0; width: min(320px, calc(100vw - 32px)); padding: var(--openbelt-space-xs); background: var(--openbelt-color-neutral); border: 1px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-md); box-shadow: 0 16px 48px rgb(0 0 0 / 0.18); }
.event-picker.is-end { left: auto; right: 0; }
.event-picker .input { width: 100%; margin-bottom: var(--openbelt-space-2xs); }
.event-values { max-height: 280px; overflow: auto; display: grid; }
.event-values a { display: flex; align-items: center; gap: var(--openbelt-space-xs); padding: 6px var(--openbelt-space-xs); min-height: 34px; border-radius: var(--openbelt-radius-sm); text-decoration: none; overflow-wrap: anywhere; }
.event-values a:hover, .event-values a:focus-visible { background: var(--openbelt-color-subtle); }
.event-values a[aria-current="true"] { font-weight: 550; }
.event-values a[aria-current="true"]::after { content: "✓"; margin-left: auto; }
.event-picker .small { display: block; color: var(--openbelt-color-muted); padding: var(--openbelt-space-2xs) var(--openbelt-space-xs) 0; }
.event-chip { height: 28px; padding: 0 6px 0 10px; gap: 6px; background: var(--openbelt-color-subtle); border-color: transparent; font: var(--openbelt-type-body-sm); max-width: 100%; overflow-wrap: anywhere; }
.event-chip .muted { color: var(--openbelt-color-muted); }
.event-chip .icon { width: 12px; height: 12px; color: var(--openbelt-color-muted); }
.event-chips .btn-ghost { height: 28px; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.event-values [hidden], .event-chips:empty { display: none; }
.event-feed { --event-cols: minmax(0, 1.5fr) minmax(0, 1.15fr) minmax(0, .85fr) 92px 64px 72px 16px; display: grid; gap: 0; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); overflow: hidden; background: var(--openbelt-color-neutral); }
.event-cols, .event summary { display: grid; grid-template-columns: var(--event-cols); align-items: center; gap: var(--openbelt-space-md); padding: 0 var(--openbelt-space-md); }
.event-cols { height: 36px; background: var(--openbelt-color-surface); border-bottom: 1px solid var(--openbelt-color-border); font: var(--openbelt-type-body-sm); font-weight: 500; color: var(--openbelt-color-muted); }
.event-cols .num, .event .num { text-align: right; justify-self: end; }
.event-list { list-style: none; padding: 0; margin: 0; }
.event + .event { border-top: 1px solid var(--openbelt-color-border); }
.event summary { min-height: 44px; padding-top: 6px; padding-bottom: 6px; cursor: pointer; list-style: none; font: var(--openbelt-type-body-md); }
.event summary::-webkit-details-marker { display: none; }
.event summary:hover, .event details[open] > summary { background: var(--openbelt-color-surface); }
.event summary:focus-visible { outline: 2px solid var(--openbelt-color-primary); outline-offset: -2px; }
.event-action, .event-person, .event-client { display: flex; align-items: center; gap: var(--openbelt-space-xs); min-width: 0; }
.event-action > .icon { width: 15px; height: 15px; flex: 0 0 15px; color: var(--openbelt-color-muted); }
.event-action code { font: var(--openbelt-type-mono-sm); font-weight: 500; color: var(--openbelt-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.event-app { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.event-person span:last-child, .event-client { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-client { display: block; color: var(--openbelt-color-muted); }
.event-avatar { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: 0 0 22px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-subtle); color: var(--openbelt-color-muted); font-size: 10px; font-weight: 600; letter-spacing: .02em; }
.event .state { font: var(--openbelt-type-body-md); color: var(--openbelt-color-muted); }
.event .state.is-error, .event .state.is-warning { color: var(--tone); }
.event-duration, .event-when { font: var(--openbelt-type-body-sm); font-variant-numeric: tabular-nums; color: var(--openbelt-color-muted); white-space: nowrap; }
.event-duration.is-slow { color: var(--openbelt-color-warning); }
.event summary > .icon { width: 16px; height: 16px; color: var(--openbelt-color-muted); transition: transform .15s; }
.event details[open] > summary > .icon { transform: rotate(180deg); }
.event-detail { display: grid; gap: var(--openbelt-space-md); padding: var(--openbelt-space-sm) var(--openbelt-space-md) var(--openbelt-space-lg) calc(var(--openbelt-space-md) + 23px); background: var(--openbelt-color-surface); border-top: 1px dashed var(--openbelt-color-border); }
.event-detail dl { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--openbelt-space-sm) var(--openbelt-space-lg); margin: 0; }
.event-detail dt, .event-detail h3 { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); margin: 0 0 2px; }
.event-detail dd { margin: 0; overflow-wrap: anywhere; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-primary); }
.event-detail dd code { font: var(--openbelt-type-mono-sm); }
.event-detail pre { margin: 0; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--openbelt-type-mono-sm); padding: var(--openbelt-space-sm); background: var(--openbelt-color-neutral); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-sm); }
.event-detail .is-error pre { color: var(--openbelt-color-error); }
.event-empty { padding: var(--openbelt-space-2xl) var(--openbelt-space-xl); text-align: center; }
.event-empty h2 { font: var(--openbelt-type-h5); }
.event-footer { display: flex; justify-content: space-between; align-items: center; gap: var(--openbelt-space-sm); padding: var(--openbelt-space-xs) var(--openbelt-space-md); border-top: 1px solid var(--openbelt-color-border); background: var(--openbelt-color-surface); color: var(--openbelt-color-muted); font-variant-numeric: tabular-nums; }
.event-footer .btn { height: 28px; }
@media (max-width: 1100px) {
  .event-feed { --event-cols: minmax(0, 1.5fr) minmax(0, 1.1fr) 88px 60px 64px 16px; }
  .event-client { display: none; }
}
@media (max-width: 700px) {
  .event-search { max-width: none; flex-basis: 100%; }
  .event-shortcuts { position: relative; }
  .event-filter { position: static; }
  .event-cols { display: none; }
  .event summary { grid-template-columns: minmax(0, 1fr) auto auto 16px; gap: 2px var(--openbelt-space-xs); padding: 10px var(--openbelt-space-md); }
  .event-action { grid-column: 1; grid-row: 1; }
  .event .state { grid-column: 2; grid-row: 1; font-size: 12px; }
  .event-when { grid-column: 3; grid-row: 1; }
  .event summary > .icon { grid-column: 4; grid-row: 1; }
  .event-person { grid-column: 1 / -1; grid-row: 2; padding-left: 23px; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
  .event-person .event-avatar { display: none; }
  .event-person { gap: 6px; }
  .event-person::after { content: "· " attr(data-ms); flex: none; font-variant-numeric: tabular-nums; }
  .event .state.is-success { font-size: 0; gap: 0; }
  .event-shortcuts { gap: 4px; }
  .event-shortcuts .btn { padding: 0 8px; gap: 4px; }
  .event-shortcuts .icon { display: none; }
  .event-duration { display: none; }
  .event-detail { padding-left: var(--openbelt-space-md); }
}

.verdict .line b { font-weight: 600; }
.verdict .why b { font-weight: 600; }
.verdict.answer { gap: var(--openbelt-space-sm); padding: 0; border: 0; border-radius: 0; }
.verdict.answer > * { margin-left: 0; }
.answer .reason { font-weight: 550; }
.answer .fixrow { display: flex; flex-wrap: wrap; align-items: center; gap: var(--openbelt-space-xs) var(--openbelt-space-md); }
.answer .fixrow > details[open] { flex-basis: 100%; }
details.names.more { display: grid; gap: var(--openbelt-space-xs); }
details.names.more[open] > summary { margin-bottom: var(--openbelt-space-2xs); }
.answer .grants { margin: 0; border: 0; gap: var(--openbelt-space-xs); }
.answer .grant { align-items: center; gap: var(--openbelt-space-sm); padding: 0; border: 0; flex-wrap: wrap; }
.answer .grant .small { color: var(--openbelt-color-muted); }
#who tr:not(.add) td:last-child { width: 200px; }
#who .subj { display: flex; align-items: center; gap: var(--openbelt-space-sm); }
#who .subj > span:last-child { display: grid; gap: 1px; }
#who .subj b { font: var(--openbelt-type-body-md); font-weight: 550; }
#who .subj-icon { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-subtle); color: var(--openbelt-color-muted); }
#who .subj-icon .icon { width: 14px; height: 14px; }
#who tr:not(.add) td { padding-block: var(--openbelt-space-xs); }
.offpanel { padding: var(--openbelt-space-lg); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); gap: var(--openbelt-space-sm); }
.offpanel h2 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); display: flex; align-items: center; gap: var(--openbelt-space-xs); }
.offpanel h2 .icon { width: 18px; height: 18px; color: var(--openbelt-color-muted); }
.offpanel .askform { max-width: 520px; }
#mine[open] > section + section { margin-top: var(--openbelt-space-lg); }
@media (max-width: 820px) {
  #who tr:not(.add) { grid-template-columns: minmax(0, 1fr) 168px; align-items: center; }
  #who tr:not(.add) > td { min-width: 0; }
  #who tr:not(.add) > td:last-child { width: auto; padding-left: 0; }
  #who td form, #who td .select { min-width: 0; }
}
#who .select, #who .select .input { width: 100%; }
#who td form { display: flex; gap: var(--openbelt-space-xs); }
#who tr.add .add-who { flex-wrap: wrap; }
#who tr.add .select { width: auto; }
#who tr.add span.select:nth-of-type(1) { flex: 1; min-width: 12rem; }
#who tr.add span.select:nth-of-type(2) { flex: none; width: 200px; }
details.names.inline { display: inline; }
details.names.inline > summary { display: inline; }
details.names.inline[open] > .faces { margin-top: var(--openbelt-space-xs); }
#who td a { color: inherit; }
@media (max-width: 640px) {
  #who tr:not(.add) { display: grid; padding: var(--openbelt-space-xs) 0; border-bottom: 1px solid var(--openbelt-color-border); }
  #who tr:not(.add) > td { border: 0; width: auto; padding: 2px var(--openbelt-space-sm); }
  #who table, #who tbody { display: block; }
}
.find { position: relative; display: block; max-width: 360px; }
.find .icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--openbelt-color-muted); pointer-events: none; }
.find .input { width: 100%; padding-left: 32px; }
.pair { display: flex; gap: var(--openbelt-space-xs); width: 100%; max-width: 520px; }
.pair .input { flex: 1 1 auto; min-width: 0; }
.pair .btn { flex: none; }
details.newtoken > summary { list-style: none; width: fit-content; }
details.newtoken > summary::-webkit-details-marker { display: none; }
details.newtoken[open] > summary { display: none; }
#tokens:has(details.newtoken[open]) .newtoken-form { display: block !important; }
.make { display: flex; flex-wrap: wrap; gap: var(--openbelt-space-sm); align-items: end; }
.make .grow { flex: 1 1 220px; }
.make .input { width: 100%; }
.make .select { width: 148px; }
.ask { padding: var(--openbelt-space-lg); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-md); border-color: var(--openbelt-color-border-strong); }
.ask h2 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
.ask.bare { padding: 0; }
.ask h2.qlabel { display: block; font: var(--openbelt-type-label); letter-spacing: normal; }
.ask header p { margin-top: var(--openbelt-space-2xs); color: var(--openbelt-color-muted); }
.ask .list { border: 0; }
.ask .asked-tools { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; color: var(--openbelt-color-muted); overflow-wrap: anywhere; }
.ask .list > *, .ask .list > :not([hidden]) ~ :not([hidden]), .askform .list > :not([hidden]) ~ :not([hidden]) { padding: var(--openbelt-space-2xs) 0; display: grid; gap: 2px; border: 0; }
main:has(.ppl) { max-width: 1160px; }
.ppl { --ppl-cols: minmax(0, 1.5fr) 96px minmax(0, 1fr) 112px 16px; overflow: hidden; }
.ppl > .ppl-cols, .ppl details.person > summary { display: grid; grid-template-columns: var(--ppl-cols); align-items: center; gap: var(--openbelt-space-md); }
.ppl > .ppl-cols { padding: 0 var(--openbelt-space-md); height: 36px; background: var(--openbelt-color-surface); font: var(--openbelt-type-body-sm); font-weight: 500; color: var(--openbelt-color-muted); }
#people .ppl > details.person { padding: 0; }
.ppl details.person > summary { min-height: 52px; padding: var(--openbelt-space-xs) var(--openbelt-space-md); }
.ppl details.person > summary:hover, .ppl details.person[open] > summary { background: var(--openbelt-color-surface); }
.ppl details.person > summary:hover b { text-decoration: none; }
.ppl details.person[open] { background: var(--openbelt-color-surface); }
.ppl .who .av { width: 28px; height: 28px; }
.p-role { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.p-role.is-admin { justify-self: start; padding: 2px var(--openbelt-space-xs); border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); font-weight: 500; }
.p-groups { display: flex; flex-wrap: wrap; gap: var(--openbelt-space-2xs); min-width: 0; }
.p-groups a.gl { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 var(--openbelt-space-xs); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-full); color: var(--openbelt-color-primary); }
.p-groups a.gl .icon { width: 11px; height: 11px; color: var(--openbelt-color-muted); }
.p-none, .p-exc { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.p-exc { color: var(--openbelt-color-warning); }
.ppl details.person > .more-of { margin: 0; padding: var(--openbelt-space-md) var(--openbelt-space-md) var(--openbelt-space-lg) calc(var(--openbelt-space-md) + 28px + var(--openbelt-space-sm)); border-top: 1px dashed var(--openbelt-color-border); }
.ppl details.person > .more-of .setting { max-width: 720px; }
@media (max-width: 820px) {
  .ppl > .ppl-cols { display: none; }
  .ppl details.person > summary { grid-template-columns: minmax(0, 1fr) auto 16px; row-gap: var(--openbelt-space-2xs); }
  .ppl .who { grid-column: 1; grid-row: 1; }
  .ppl .p-role { grid-column: 2; grid-row: 1; }
  .ppl details.person > summary > .icon { grid-column: 3; grid-row: 1; }
  .ppl .p-groups { grid-column: 1 / -1; grid-row: 2; padding-left: calc(28px + var(--openbelt-space-sm)); }
  .ppl .p-exc { grid-column: 1 / -1; grid-row: 3; padding-left: calc(28px + var(--openbelt-space-sm)); }
  .ppl .p-exc:empty, .ppl .p-groups:has(.p-none) { display: none; }
  .ppl details.person > .more-of { padding-left: var(--openbelt-space-md); }
}
.ask .list b { font-weight: 550; }
.ask .list code { font: var(--openbelt-type-mono-sm); color: var(--openbelt-color-muted); overflow-wrap: anywhere; }
.ask .list span { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.ask .when { color: var(--openbelt-color-muted); }
.appname { white-space: nowrap; }
.head h1.says { display: block; }
.askform h2 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); }
.askform .actions { gap: var(--openbelt-space-xs) var(--openbelt-space-sm); }
.askform .actions .small { color: var(--openbelt-color-muted); }
#technical > div { display: grid; gap: var(--openbelt-space-2xs); margin-top: var(--openbelt-space-xs); color: var(--openbelt-color-muted); }
.actions { display: flex; gap: var(--openbelt-space-xs); flex-wrap: wrap; align-items: center; }
.made { width: min(560px, calc(100vw - 2 * var(--openbelt-space-md))); max-height: calc(100vh - 2 * var(--openbelt-space-md)); overflow-y: auto; margin: auto; padding: var(--openbelt-space-lg); color: inherit; border-radius: var(--openbelt-radius-md); }
.made[open] { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-md); }
.made { background: var(--openbelt-color-surface); border: 1px solid var(--openbelt-color-border-strong); }
.made::backdrop { background: rgb(0 0 0 / 0.6); }
.made .actions { justify-content: flex-end; }
.make-group { display: grid; gap: var(--openbelt-space-md); }
.make-group .input { width: 100%; }
.made h2 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); }
.made header p { margin-top: var(--openbelt-space-2xs); color: var(--openbelt-color-muted); }
.scroll { position: relative; overflow-x: auto; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); }
table { width: 100%; border-collapse: collapse; font: var(--openbelt-type-body-sm); }
th, td { text-align: left; padding: var(--openbelt-space-xs) var(--openbelt-space-sm); border-bottom: 1px solid var(--openbelt-color-border); vertical-align: middle; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
th { font: var(--openbelt-type-label); color: var(--openbelt-color-muted); background: var(--openbelt-color-surface); vertical-align: bottom; }
td code { font: var(--openbelt-type-mono-sm); }
td.why { white-space: normal; min-width: 240px; color: var(--openbelt-color-muted); }
.yes { color: var(--openbelt-color-success); }
.held { color: var(--openbelt-color-muted); }
.denied p + p { margin-top: var(--openbelt-space-xs); }
.denied p { overflow-wrap: anywhere; }
.denied .trace { margin-top: var(--openbelt-space-xl); font: var(--openbelt-type-mono-sm); color: var(--openbelt-color-muted); }
.denied .trace summary { width: max-content; cursor: pointer; }
.denied .trace p { margin-top: var(--openbelt-space-2xs); }
.crumb { display: inline-flex; align-items: center; gap: var(--openbelt-space-2xs); width: fit-content; color: var(--openbelt-color-muted); font: var(--openbelt-type-label); text-decoration: none; }
.crumb:hover { color: var(--openbelt-color-primary); }
.head h1 { display: flex; align-items: center; gap: var(--openbelt-space-sm); flex-wrap: wrap; }
main .who { display: flex; align-items: center; gap: var(--openbelt-space-sm); min-width: 0; }
main .who > span:last-child { min-width: 0; display: grid; }
main .who b { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
main .who small { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.av { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-subtle); border: 1px solid var(--openbelt-color-border); font: 600 11px/1 var(--openbelt-font-body); color: var(--openbelt-color-muted); text-transform: uppercase; }
.av.sm { width: 22px; height: 22px; font-size: 9.5px; }
.chips { display: flex; flex-wrap: wrap; gap: var(--openbelt-space-2xs); align-items: center; }
.chip { display: inline-flex; align-items: center; gap: var(--openbelt-space-2xs); height: 24px; padding: 0 var(--openbelt-space-xs); border: 1px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-full); font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); text-decoration: none; white-space: nowrap; }
a.chip:hover { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.chip .icon { width: 12px; height: 12px; }
.role { margin-left: 6px; font-weight: 400; font-size: 12px; color: var(--openbelt-color-muted); }
header.sect { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--openbelt-space-xs) var(--openbelt-space-md); margin-bottom: var(--openbelt-space-sm); }
header.sect h2 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); display: flex; align-items: baseline; gap: var(--openbelt-space-xs); }
.lvls { display: flex; flex-wrap: wrap; gap: var(--openbelt-space-2xs); }
.lvl { padding: 2px var(--openbelt-space-xs); border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); white-space: nowrap; }
.lvl.is-all { color: var(--openbelt-color-warning); background: color-mix(in srgb, var(--openbelt-color-warning) 12%, transparent); }
.lvl.is-read { color: var(--openbelt-color-primary); }
#levels .setting[data-level="none"] b { color: var(--openbelt-color-muted); font-weight: 500; }
#levels details.others { margin-top: var(--openbelt-space-sm); }
#levels .list > .setting { padding-block: var(--openbelt-space-xs); }
#levels .setting > .conn { display: flex; align-items: center; gap: var(--openbelt-space-sm); min-width: 0; }
#levels .setting > .conn > div { display: grid; gap: 2px; min-width: 0; }
#levels .setting .mark { width: 24px; height: 24px; }
#levels .setting { grid-template-columns: minmax(0, 1fr) 240px; }
@media (max-width: 820px) { #levels .setting { grid-template-columns: minmax(0, 1fr) 132px; } }
#members .member .who .av { width: 28px; height: 28px; }
#levels details.others > summary { display: flex; align-items: center; gap: var(--openbelt-space-sm); width: auto; padding: var(--openbelt-space-sm) var(--openbelt-space-md); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); color: var(--openbelt-color-primary); font: var(--openbelt-type-body-md); text-decoration: none; }
#levels details.others > summary b { flex: 1; font-weight: 550; }
#levels details.others > summary .icon { color: var(--openbelt-color-muted); transition: transform var(--openbelt-duration) var(--openbelt-ease); }
#levels details.others[open] > summary .icon { transform: rotate(90deg); }
.head-act > #delete { flex: none; }
.head-act > #delete .btn-danger { height: 28px; }
a.gl { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); text-decoration: none; }
a.gl:hover { color: var(--openbelt-color-primary); text-decoration: underline; text-underline-offset: 3px; }
details.person .groups { gap: 2px var(--openbelt-space-xs); }
details.person .groups > :not(:last-child)::after { content: ","; color: var(--openbelt-color-muted); }
.fieldhead { display: flex; align-items: center; justify-content: space-between; gap: var(--openbelt-space-sm); }
.fieldhead .copy-cmd { height: 24px; padding: 0 var(--openbelt-space-xs); font: var(--openbelt-type-body-sm); }
#tokens > header.head-act { align-items: center; }
.row .apps-of { color: var(--openbelt-color-primary); }
.row .acts { flex: none; display: flex; align-items: center; gap: var(--openbelt-space-xs); }
.row .acts form { display: contents; }
dialog.appsd { width: min(560px, calc(100vw - 2 * var(--openbelt-space-md))); max-height: calc(100dvh - 2 * var(--openbelt-space-md)); margin: max(var(--openbelt-space-md), 8dvh) auto auto; padding: 0; overflow: hidden; }
dialog.appsd:has(.pick:not([hidden])) { height: min(720px, calc(100dvh - 2 * var(--openbelt-space-md))); }
dialog.appsd[open] { display: block; }
.appsd form { height: 100%; display: flex; flex-direction: column; }
.appsd header { padding: var(--openbelt-space-lg) var(--openbelt-space-lg) var(--openbelt-space-md); }
.appsd header h2 { display: block; }
.appsd header .who { color: var(--openbelt-color-muted); overflow-wrap: anywhere; }
.appsd header .who:not(:empty)::before { content: " · "; }
.appsd .choices { margin: 0 var(--openbelt-space-lg); }
.appsd .pick { flex: 1; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: var(--openbelt-space-sm); min-height: 0; padding: var(--openbelt-space-md) var(--openbelt-space-lg) 0; }
.appsd .pick[hidden] { display: none; }
.appsd .every-note { padding: var(--openbelt-space-md) var(--openbelt-space-lg); color: var(--openbelt-color-muted); }
.appsd .filters { display: flex; gap: var(--openbelt-space-2xs); overflow-x: auto; scrollbar-width: none; }
.appsd .filters button { flex: none; height: 30px; padding: 0 var(--openbelt-space-sm); border: 0; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); font: var(--openbelt-type-body-sm); cursor: pointer; }
.appsd .filters button:hover { background: var(--openbelt-color-border); }
.appsd .filters button:active { transform: scale(0.97); }
.appsd .filters button span { color: var(--openbelt-color-muted); margin-left: 4px; }
.appsd .filters button[aria-pressed="true"] { background: var(--openbelt-color-primary); color: var(--openbelt-color-neutral); }
.appsd .filters button[aria-pressed="true"] span { color: inherit; opacity: 0.7; }
.appsd .found { overflow-y: auto; margin: 0 calc(-1 * var(--openbelt-space-xs)); padding-bottom: var(--openbelt-space-sm); }
.appsd .found label { display: flex; align-items: center; gap: var(--openbelt-space-sm); padding: var(--openbelt-space-xs); border-radius: var(--openbelt-radius-sm); cursor: pointer; }
.appsd .found label:hover { background: var(--openbelt-color-subtle); }
.appsd .found label span { flex: 1; min-width: 0; display: grid; }
.appsd .found label b { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appsd .found label small { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appsd .found input { appearance: none; flex: none; order: 2; display: grid; place-items: center; width: 18px; height: 18px; margin: 0; border: 1px solid var(--openbelt-color-border-strong); border-radius: 5px; background: transparent; }
.appsd .found input:checked { background: var(--openbelt-color-primary); border-color: var(--openbelt-color-primary); }
.appsd .found input:checked::before { content: ""; width: 9px; height: 5px; margin-top: -2px; border: solid var(--openbelt-color-neutral); border-width: 0 0 2px 2px; transform: rotate(-45deg); }
.appsd .found .more { padding: var(--openbelt-space-xs); color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.appsd footer { display: flex; align-items: center; gap: var(--openbelt-space-xs); margin-top: var(--openbelt-space-md); padding: var(--openbelt-space-sm) var(--openbelt-space-lg); border-top: 1px solid var(--openbelt-color-border); }
.appsd footer .count { flex: 1; font-weight: 550; }
.appsd footer .count span { color: var(--openbelt-color-muted); font-weight: 400; }
@media (max-width: 640px) {
  dialog.appsd, dialog.appsd:has(.pick:not([hidden])) { width: 100vw; max-width: 100vw; height: 92dvh; margin: auto 0 0; border-radius: var(--openbelt-radius-md) var(--openbelt-radius-md) 0 0; }
  .appsd header, .appsd .pick, .appsd footer { padding-inline: var(--openbelt-space-md); }
  .appsd .choices { margin-inline: var(--openbelt-space-md); }
  .row .acts { width: 100%; justify-content: flex-end; }
}
.nowrap { white-space: nowrap; }
main .btn-ghost:not(.btn-square) { color: var(--openbelt-color-primary); }
details.person > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-md); align-items: center; }
details.person > summary::-webkit-details-marker { display: none; }
details.person { scroll-margin: 72px 0 var(--openbelt-space-md); }
details.person > summary > .chips:not(.groups) { justify-content: flex-end; }
details.person > summary > .icon { color: var(--openbelt-color-muted); transition: transform var(--openbelt-duration) var(--openbelt-ease); }
details.person[open] > summary > .icon { transform: rotate(180deg); }
details.person > summary:hover b { text-decoration: underline; text-decoration-color: var(--openbelt-color-border-strong); text-underline-offset: 3px; }
.more-of { display: grid; gap: var(--openbelt-space-md); margin-top: var(--openbelt-space-md); padding-top: var(--openbelt-space-md); border-top: 1px solid var(--openbelt-color-border); }
.more-of h3 { font: var(--openbelt-type-label); }
.more-of > div > p { margin-top: 2px; }
.setting { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: var(--openbelt-space-xs) var(--openbelt-space-md); align-items: center; }
.setting > div:first-child { display: grid; gap: 2px; min-width: 0; }
.setting b { font-weight: 550; }
.setting form { display: flex; gap: var(--openbelt-space-xs); }
.setting .select { flex: 1; min-width: 0; }
a.group { display: grid; grid-template-columns: minmax(0, 1fr) auto auto 16px; gap: var(--openbelt-space-md); align-items: center; color: inherit; text-decoration: none; }
a.group:hover { background: var(--openbelt-color-surface); }
a.group:first-child { border-radius: var(--openbelt-radius-md) var(--openbelt-radius-md) 0 0; }
a.group:last-child { border-radius: 0 0 var(--openbelt-radius-md) var(--openbelt-radius-md); }
a.group:only-child { border-radius: var(--openbelt-radius-md); }
a.group > div { display: grid; gap: 2px; min-width: 0; }
a.group b { display: flex; align-items: center; gap: var(--openbelt-space-xs); font-weight: 600; }
a.group > .icon { color: var(--openbelt-color-muted); }
.stack { display: flex; gap: 2px; }
.done { display: grid; justify-items: center; align-content: center; gap: var(--openbelt-space-xs); min-height: 60vh; text-align: center; }
.done .ok { width: 40px; height: 40px; margin-bottom: var(--openbelt-space-xs); display: grid; place-items: center; border-radius: var(--openbelt-radius-full); color: var(--openbelt-color-success); background: color-mix(in srgb, var(--openbelt-color-success) 14%, transparent); }
.done h1 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
.done p { color: var(--openbelt-color-muted); }
.done a { margin-top: var(--openbelt-space-sm); color: var(--openbelt-color-primary); font: var(--openbelt-type-body-sm); text-underline-offset: 3px; }
.crew { display: flex; align-items: center; gap: var(--openbelt-space-sm); }
details.others > .list { margin-top: var(--openbelt-space-sm); }
.member { display: flex; align-items: center; justify-content: space-between; gap: var(--openbelt-space-md); }
#members .list > .member { padding-block: var(--openbelt-space-sm); }
.add { display: flex; gap: var(--openbelt-space-xs); flex-wrap: wrap; }
.add .select { flex: 1 1 240px; min-width: 0; }
details.danger { display: grid; gap: var(--openbelt-space-sm); justify-items: start; }
details.danger > summary { list-style: none; }
details.danger > summary::-webkit-details-marker { display: none; }
details.danger:not([open]) .opened, details.danger[open] .closed { display: none; }
details.danger form { display: grid; gap: var(--openbelt-space-sm); justify-items: start; }
.btn-danger { color: var(--openbelt-color-error); }
@media (max-width: 820px) {
  details.person > summary { grid-template-columns: minmax(0, 1fr); row-gap: var(--openbelt-space-2xs); }
  details.person > summary > .groups { grid-column: 1 / -1; grid-row: 2; padding-left: 40px; }
  .setting { grid-template-columns: minmax(0, 1fr); }
  a.group { grid-template-columns: minmax(0, 1fr) auto 16px; }
  a.group .stack { display: none; }
}
@media (max-width: 820px) {
  main { padding: var(--openbelt-space-lg) var(--openbelt-space-md) var(--openbelt-space-3xl); gap: var(--openbelt-space-xl); }
  .ask, .made { padding: var(--openbelt-space-md); }
  .ask-q, .verdict { padding: var(--openbelt-space-md); }
  .verdict > :not(.line) { margin-left: 0; }
  .sentence { display: grid; gap: var(--openbelt-space-sm); }
  .sentence .w, .sentence .tail { display: none; }
  .qf, .from.qf { display: grid; gap: var(--openbelt-space-2xs); }
  .sentence .qlabel, .from .qlabel { display: block; font: var(--openbelt-type-label); color: var(--openbelt-color-primary); }
  .slot-of, .qslot, .slot-of .input { width: 100%; }
  .qslot { justify-content: space-between; }
  main:has(> #ask) { gap: var(--openbelt-space-lg); }
  .from .seg { display: none; }
  .from .select { display: flex; width: 100%; }
  .grant { flex-wrap: wrap; }
  .agrp > :not(.named) { margin-left: 0; }
  .row { flex-wrap: wrap; }
  .crow .name small { white-space: normal; }
  .crow:has(> .state) { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 16px; column-gap: var(--openbelt-space-sm); row-gap: 2px; }
  .crow:has(> .state) > .c-lvl { grid-column: 3; grid-row: 1 / span 2; align-self: center; }
  .crow:has(> .state) > .mark { grid-row: 1 / span 2; align-self: start; }
  .crow:has(> .state) > .state { grid-column: 2; grid-row: 2; }
  .crow:has(> .state) > .icon { grid-column: 4; grid-row: 1 / span 2; align-self: center; }
}
`

const PAGE_SCRIPT = `
for (const f of document.querySelectorAll("input[type=file][data-save]")) {
  f.addEventListener("change", () => f.files.length > 0 && f.form.requestSubmit())
}
for (const s of document.querySelectorAll("select[data-save]")) {
  s.form.querySelector(".save")?.setAttribute("hidden", "")
  s.addEventListener("change", () => s.form.requestSubmit())
}
for (const d of document.querySelectorAll("details.person")) {
  d.addEventListener("toggle", () => { if (d.open) d.scrollIntoView({ block: matchMedia("(max-width: 820px)").matches ? "start" : "nearest" }) })
}
const made = document.getElementById("made")
if (made?.showModal) {
  made.close()
  made.showModal()
  made.addEventListener("cancel", (e) => e.preventDefault())
}
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]")
  if (open) document.getElementById(open.dataset.open)?.showModal()
  const b = e.target.closest("[data-copy]")
  if (!b) return
  navigator.clipboard?.writeText(b.dataset.copy).catch(() => {})
  const label = b.getAttribute("aria-label")
  b.innerHTML = ${JSON.stringify(icon("check"))}
  b.setAttribute("aria-label", "Copied")
  clearTimeout(b.t)
  b.t = setTimeout(() => { b.innerHTML = ${JSON.stringify(icon("copy"))}; b.setAttribute("aria-label", label) }, 1400)
})`

const FIND_SCRIPT = `
const find = document.getElementById("find")
if (find) {
  const items = [...document.querySelectorAll("main [data-find]")]
  const none = document.getElementById("none")
  const folded = [...document.querySelectorAll("main details.list-of")]
  const apply = () => {
    const q = find.value.trim().toLowerCase()
    let matched = 0
    for (const r of items) {
      const hit = q === "" || r.dataset.find.includes(q)
      if (hit) matched++
      r.hidden = !hit
    }
    for (const d of folded) {
      const any = [...d.querySelectorAll("[data-find]")].some((r) => !r.hidden)
      d.hidden = q !== "" && !any
      if (q !== "" && any) d.open = true
    }
    for (const g of document.querySelectorAll("main .cgroup"))
      g.hidden = ![...g.querySelectorAll("[data-find]")].some((r) => !r.hidden)
    if (none) none.hidden = matched > 0
  }
  find.addEventListener("input", apply)
  addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.target.closest("input, textarea, select")) return
    e.preventDefault()
    find.focus()
  })
}`

const ASKS_SCRIPT = `
for (const a of document.querySelectorAll("a[data-opens]")) {
  const fold = document.getElementById(a.dataset.opens)
  if (!fold) continue
  fold.querySelector("summary").hidden = true
  fold.addEventListener("toggle", () => a.setAttribute("aria-expanded", String(fold.open)))
  a.addEventListener("click", (e) => { e.preventDefault(); fold.open = !fold.open })
}`

type Nav = "none" | "member" | "admin"

type NavPage = Section | "connections"

type Person = { readonly email: string; readonly name: string } | null

const frame = (page: {
  readonly title: string
  readonly head: string
  readonly css: string
  readonly side: string
  readonly workspace: string
  readonly body: string
  readonly address: string
  readonly script: string
}) => `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
${page.head}
${NAV_PREFETCH}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escape(page.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">${PWA_HEAD}
<style>${MAIN_CSS}${STYLE}${page.css}</style>
</head>
<body>
<div class="shell">
${page.side}
<div class="inset">
${topBar()}
<main>${page.body}</main>
</div>
</div>
${SCRIM}
<script>${page.address}
${PAGE_SCRIPT}
${page.script}</script>
</body>
</html>`

const shell = (
  workspace: string,
  nav: Nav,
  here: NavPage | "",
  body: string,
  path = here === "" ? null : `/_settings/${here}`,
  script = "",
) => {
  const link = (page: NavPage, name: string, lead: string) =>
    `<a href="/_settings/${page}"${here === page ? ' aria-current="page"' : ""}>${lead}<span class="label">${escape(name)}</span></a>`

  const pages: ReadonlyArray<readonly [NavPage, string, string]> = [
    ...(nav === "none" ? [] : ([["agents", "Agents", icon("bot")]] as const)),
    ...(nav === "admin"
      ? ([
          ["people", "People", icon("users")],
          ["groups", "Groups", icon("grid")],
          ["connections", "Connections", icon("plug")],
          ["events", "Events", icon("activity")],
        ] as const)
      : []),
  ]

  const group = (heading: string, links: typeof pages) =>
    links.length === 0
      ? ""
      : `<h2>${heading}</h2><div class="nav">${links.map(([page, name, lead]) => link(page, name, lead)).join("")}</div>`

  return frame({
    title: "Settings · OpenBelt",
    head: "",
    css: SETTINGS_SIDE_CSS,
    side: `<nav class="side" id="side" aria-label="Settings">
<div class="nav">${BACK}</div>
${group(
  "You",
  pages.filter(([page]) => page === "agents"),
)}
${group(
  "Workspace",
  pages.filter(([page]) => page !== "agents"),
)}
</nav>`,
    workspace,
    body,
    address:
      path === null
        ? ""
        : `if (${path.includes("?") ? "location.pathname + location.search" : "location.pathname"} !== ${JSON.stringify(path)}) history.replaceState(null, "", ${JSON.stringify(path)} + location.hash)`,
    script: `${DRAWER_SCRIPT}\n${script}`,
  })
}

const mainShell = (
  title: string,
  workspace: string,
  switcher: string,
  person: { readonly email: string; readonly name: string },
  body: string,
  path: string,
) =>
  frame({
    title: `${title} · ${workspace} · OpenBelt`,
    head: `<script>${RAIL_HEAD}</script>${switcherPreconnect(switcher)}`,
    css: "",
    side: mainSide(workspace, switcher, person, "connections"),
    workspace,
    body,
    address: `if (location.pathname !== ${JSON.stringify(path.split("?")[0])}) history.replaceState(null, "", ${JSON.stringify(path)} + location.hash)`,
    script: `${MAIN_SCRIPT}\n${FIND_SCRIPT}`,
  })

const form = (
  action: SettingsAction,
  formToken: string,
  hidden: Readonly<Record<string, string>>,
  inner: string,
  className = "pair",
) =>
  `<form class="${className}" method="post" action="/_settings/${action}"><input type="hidden" name="form" value="${escape(formToken)}">${Object.entries(
    hidden,
  )
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join("")}${inner}</form>`

const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

const MOMENT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
})

const day = (iso: string) => {
  const at = new Date(iso)

  return Number.isNaN(at.getTime()) ? iso : DAY.format(at)
}

const moment = (iso: string) => {
  const at = new Date(iso)

  return Number.isNaN(at.getTime()) ? iso : MOMENT.format(at)
}

const sentence = (text: string) =>
  /^[a-z][a-z']*\s/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text

const SHORT_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`

const ago = (iso: string, now = Date.now()) => {
  const at = new Date(iso).getTime()

  if (Number.isNaN(at)) return ""

  const minutes = Math.round((now - at) / 60_000)

  if (minutes < 1) return "just now"

  if (minutes < 60) return plural(minutes, "minute")

  const hours = Math.round(minutes / 60)

  if (hours < 24) return plural(hours, "hour")

  const days = Math.round(hours / 24)

  if (days === 1) return "yesterday"

  return days < 7 ? plural(days, "day") : `on ${SHORT_DAY.format(at)}`
}

const since = (iso: string, now = Date.now()) => {
  const at = new Date(iso).getTime()

  if (Number.isNaN(at)) return ""

  const seconds = Math.max(0, Math.round((now - at) / 1000))

  if (seconds < 45) return "now"

  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`

  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`

  return seconds < 7 * 86_400 ? `${Math.round(seconds / 86_400)}d ago` : SHORT_DAY.format(at)
}

const either = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`

const and = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

const askAdmins = (admins: ReadonlyArray<string>) =>
  admins.length === 0 ? "an admin" : either(admins)

type Known = { readonly connection: string; readonly provider?: string }

const providerOf = (view: Known) =>
  view.provider === undefined ? undefined : providerById(view.provider)

const makerOf = (view: Known) => {
  const p = providerOf(view)

  return p?.maker ?? p?.name ?? connectionLabel(view.connection)
}

type Stopped = {
  readonly kind: "refused" | "forgotten" | "stopped"
  readonly at: string | null
  readonly whose: "me" | "workspace"
}

const stoppedOf = (view: ConnectionView): Stopped | undefined => {
  const reason = view.reconnectReason

  if (reason === undefined) return undefined

  const kind = Match.value(reason.kind).pipe(
    Match.whenOr("revoked", "expired", "rejected_after_refresh", () => "refused" as const),
    Match.when("registration", () => "forgotten" as const),
    Match.whenOr("cut_short", "rapt", "unsaved", () => "stopped" as const),
    Match.exhaustive,
  )

  return { kind, at: reason.at, whose: reason.whose === "yours" ? "me" : "workspace" }
}

const stoppedSaid = (stopped: Stopped, label: string) => {
  const when = stopped.at === null ? "" : ` ${ago(stopped.at)}`
  const whose = stopped.whose === "workspace" ? "the workspace's" : "your"

  return Match.value(stopped.kind).pipe(
    Match.when("refused", () => `${label} stopped accepting ${whose} sign-in${when}.`),
    Match.when(
      "forgotten",
      () => `${label} no longer recognizes OpenBelt${when}, so ${whose} sign-in stopped working.`,
    ),
    Match.when("stopped", () =>
      stopped.whose === "workspace"
        ? `The workspace's ${label} sign-in stopped working${when}.`
        : `Your ${label} sign-in stopped working${when}.`,
    ),
    Match.exhaustive,
  )
}

const needsAppOf = (view: ConnectionView, admin: boolean) => admin && view.needsApp === true

const scopeWords = (scope: string) =>
  /write|modify|manage|admin|delete|send|compose/i.test(scope)
    ? "write access"
    : /read/i.test(scope)
      ? "read access"
      : "more access"

const PASTE = (label: string) =>
  `<input class="input" type="password" name="token" autocomplete="off" placeholder="Personal access token" aria-label="Your ${escape(label)} token" required><button class="btn btn-primary" type="submit">Save</button>`

const signInForm = (
  action: "connect" | "disconnect",
  label: string,
  formToken: string,
  hidden: Readonly<Record<string, string>>,
  here: string,
  whose: "me" | "workspace",
  again = false,
  says?: string,
) =>
  form(
    action,
    formToken,
    { ...hidden, whose, here },
    action === "connect"
      ? `<button class="btn btn-primary" type="submit" data-connect="${whose}">${icon("plug")}${escape(says ?? (again ? "Connect again" : whose === "workspace" ? `Connect ${label} for the workspace` : `Connect ${label}`))}</button>`
      : `<button class="btn btn-secondary" type="submit" data-disconnect="${whose}">${whose === "workspace" ? "Disconnect for the workspace" : "Disconnect"}</button>`,
    "actions",
  )

const connectButton = (connection: string, words: string) =>
  `<a class="btn btn-primary" href="${escape(connectLink("", connection))}" data-connect="me">${icon("plug")}${escape(words)}</a>`

const offFor = (from: string, label: string) =>
  from.startsWith("group:")
    ? `Off for the ${from.slice("group:".length)} group.`
    : from.startsWith("person:")
      ? `An admin turned ${label} off for you.`
      : `Off for everyone not in a group that has it.`

const connectionState = (
  view: ConnectionView,
  label: string,
  admins: ReadonlyArray<string>,
  admin: boolean,
) => {
  const ask = escape(askAdmins(admins))

  if (view.level === "none")
    return {
      word: "Not given to you",
      tone: "muted" as const,
      about: admin
        ? `Your level on ${escape(label)} is none: see <a href="#who">Who has access</a>.`
        : escape(offFor(view.levelFrom, label)),
    }

  if (view.ownLevel === "none")
    return {
      word: "Off (your choice)",
      tone: "muted" as const,
      about: `You turned it off for yourself: your agents and apps can't use it for you. Your workspace gives you ${GIVES[view.level]}; turn it back on below.`,
    }

  if (view.problem !== undefined)
    return {
      word: "Not working",
      tone: "error" as const,
      about: admin
        ? ""
        : `OpenBelt couldn't reach ${escape(label)} the last time it checked${view.tools.length === 0 ? ", so it has no tools yet" : ", so calls may fail"}. Ask ${ask} to look at it.`,
    }

  const stopped = stoppedOf(view)

  if (stopped !== undefined)
    return {
      word: stopped.whose === "me" || admin ? "Needs you" : "Stopped working",
      tone: "error" as const,
      about: `${escape(stoppedSaid(stopped, label))} ${
        stopped.whose === "me"
          ? `Agents and apps can't use ${escape(label)} as you until you connect it again.`
          : admin
            ? `Agents and apps can't use the workspace's ${escape(label)} until you connect it again.`
            : `Agents and apps can't use the workspace's ${escape(label)} until ${ask} connects it again.`
      }`,
    }

  if (needsAppOf(view, admin))
    return {
      word: "Needs setup",
      tone: "muted" as const,
      about: `${escape(makerOf(view))} needs an OAuth app before anyone can connect. Set it up below; it takes a few minutes, once.`,
    }

  const set =
    view.credential === "none" || view.yourToken === "set" || view.workspaceToken === "set"

  if (set && view.tools.length > 0 && view.tools.every((t) => !t.usable))
    return {
      word: "No tools for you",
      tone: "muted" as const,
      about:
        view.level === "read"
          ? `You can use the tools that only read, and none of its ${view.tools.length} do.${admin ? "" : ` Ask ${ask} if you need one.`}`
          : `An admin turned off the tools you could use.${admin ? "" : ` Ask ${ask} if you need one.`}`,
    }

  if (view.credential === "none")
    return {
      word: "Ready",
      tone: "success" as const,
      about: "It takes no sign-in: nothing to set up.",
    }

  if (view.yourToken === "set")
    return {
      word: "Connected",
      tone: "success" as const,
      about:
        view.signIn === "oauth"
          ? `Agents and apps use ${escape(label)} as you. OpenBelt keeps your sign-in fresh.`
          : `Agents and apps use ${escape(label)} as you, with your own token.`,
    }

  if (view.workspaceToken === "set")
    return {
      word: "Ready",
      tone: "success" as const,
      about:
        view.yourToken === "missing"
          ? `Calls use the workspace's account. To use ${escape(label)} as yourself instead, ${view.signIn === "oauth" ? "connect your own" : "paste your own token"}.`
          : "Calls use the workspace's account. Nothing to set up.",
    }

  if (view.yourToken === "missing")
    return {
      word: "Not connected",
      tone: "muted" as const,
      about:
        view.signIn === "oauth"
          ? `Connect to use ${escape(label)} as you: you sign in to ${escape(makerOf(view))} and allow OpenBelt.`
          : `Paste a personal access token to use ${escape(label)} as you.`,
    }

  return {
    word: "Not set up",
    tone: "muted" as const,
    about: admin
      ? `Not connected for the workspace yet. ${view.signIn === "oauth" ? "Connect it once, for everyone." : "Add the workspace's token once, for everyone."}`
      : `Not set up yet. Ask ${ask} to ${view.signIn === "oauth" ? "connect it for the workspace" : "add the workspace's token"}.`,
  }
}

const askFields = (ask: Ask, back: string | null) => {
  const fields = new Map([
    ["connect", ask.connection],
    ["for", ask.app],
  ])

  if (ask.env !== undefined) fields.set("env", ask.env)

  if (back !== null) fields.set("return", back)

  return Object.fromEntries(fields)
}

const askQuery = (ask: Ask, back: string | null) => {
  const query = new URLSearchParams({ connect: ask.connection, app: ask.app })

  if (ask.env !== undefined) query.set("env", ask.env)

  if (back !== null) query.set("return", back)

  return query.toString()
}

const askNeedsToken = (data: AccountData, ask: Asked) => {
  const view = data.connections.find((c) => c.connection === ask.connection)

  return (
    ask.problem === null &&
    !ask.consented &&
    view !== undefined &&
    view.yourToken === "missing" &&
    view.level !== "none"
  )
}

const askedTools = (ask: Asked) =>
  ask.tools.map((t) => t.tool.slice(ask.connection.length + 1)).join(",")

/** One Allow for every account on an app's review page that's connected and not yet allowed: "tools:<connection>" each. */
const allowForm = (
  ask: Asked,
  open: ReadonlyArray<Asked>,
  formToken: string,
  back: string | null,
  cancel: string,
  ready: boolean,
) =>
  form(
    "allow",
    formToken,
    {
      ...askFields(ask, back),
      app: ask.app,
      connection: open.map((a) => a.connection).join(","),
      ...Object.fromEntries(open.map((a) => [`tools:${a.connection}`, askedTools(a)])),
    },
    `${cancel}<button class="btn btn-primary" type="submit"${ready ? "" : " disabled"}>Allow</button>`,
    "actions",
  )

const appName = (app: string) => `<span class="appname">${escape(app)}</span>`

const allowedSaid = (data: AccountData, connection: string, tools: ReadonlyArray<string>) => {
  const listed = data.connections.find((v) => v.connection === connection)?.tools ?? []

  return tools
    .map((t) =>
      t === "*"
        ? "every tool"
        : toolSaid(
            `${connection}.${t}`,
            listed.find((l) => l.tool === `${connection}.${t}`)?.description ?? "",
          ).name,
    )
    .map((said, i) => (i === 0 ? said : said.charAt(0).toLowerCase() + said.slice(1)))
    .join(", ")
}

/** What an app asks to do with one account, a line each. */
const toolLines = (ask: Asked) =>
  `<ul class="asked-tools">${ask.tools
    .map(
      (t) =>
        `<li data-tool="${escape(t.tool)}">${escape(
          t.tool === `${ask.connection}.*`
            ? `Every ${connectionLabel(ask.connection)} tool, including ones added later`
            : toolSaid(t.tool, t.description).name,
        )}</li>`,
    )
    .join("")}</ul>`

/** An app's ask outside its review page: why it can't be asked, that it's allowed, or a link to review it. */
const askCard = (data: AccountData, ask: Asked, back: string | null) => {
  const label = connectionLabel(ask.connection)
  const view = data.connections.find((c) => c.connection === ask.connection)
  const app = appName(ask.app)

  if (ask.problem !== null) {
    return `<section class="card ask" id="ask"><header>${headingHtml("h2", `${app} asked for your ${escape(label)}`, sub(escape(sentence(ask.problem))))}</header>${back === null ? "" : `<div class="actions"><a class="btn btn-secondary" href="${escape(back)}">${icon("arrowLeft")}Back to ${app}</a></div>`}</section>`
  }

  const action =
    view !== undefined && view.level === "none"
      ? `<p class="muted">Your access to ${escape(label)} is off, so ${app} can't use it for you. Ask ${escape(askAdmins(data.admins))} to turn it on.</p>`
      : ask.consented
        ? `<div class="actions"><span class="badge badge-success">${icon("check")}Allowed</span>${back === null ? "" : `<a class="btn btn-primary" href="${escape(back)}">Back to ${app}</a>`}</div>`
        : `<div class="actions"><a class="btn btn-primary" href="${escape(`/_connections?${askQuery(ask, back)}`)}">Review</a></div>`

  return `<section class="card ask" id="ask">
<header><h2>${app} wants to use your ${escape(label)}</h2></header>
${toolLines(ask)}
${action}
</section>`
}

/**
 * An app's review page: a row for each account it uses (Connect, Connected, Allowed, or off for you; its tools under it), then one
 * Allow for every connected one. Allow waits until each account it needs is connected. Connect signs in, or opens the token step.
 */
const reviewBody = (
  data: AccountData,
  ask: Asked,
  accounts: ReadonlyArray<Asked>,
  formToken: string,
  back: string | null,
) => {
  const here = `/_connections?${askQuery(ask, back)}`
  const viewOf = (name: string) => data.connections.find((v) => v.connection === name)
  const usable = (a: Asked) => (viewOf(a.connection)?.level ?? "none") !== "none"

  const row = (a: Asked) => {
    const view = viewOf(a.connection)
    const label = connectionLabel(a.connection)
    const count = a.tools.length === 1 ? "1 tool" : `${a.tools.length} tools`

    const state =
      view === undefined || view.level === "none"
        ? `<span class="state">Off for you</span>`
        : a.consented
          ? `<span class="state">${icon("check")}Allowed</span>`
          : !askNeedsToken(data, a)
            ? `<span class="state">${icon("check")}Connected</span>`
            : view.signIn === "oauth"
              ? form(
                  "connect",
                  formToken,
                  { ...askFields(a, back), connection: a.connection, whose: "me", here },
                  `<button class="btn btn-secondary" type="submit" data-connect="me">Connect</button>`,
                  "",
                )
              : `<a class="btn btn-secondary" href="${escape(`/_connections?${askQuery(a, back)}&step=token`)}" data-connect="token">Connect</a>`

    return `<div class="acct" data-account="${escape(a.connection)}">${markOf(view ?? { connection: a.connection }, label, data.icons[a.connection])}<div class="who"><b>${escape(label)}</b><details><summary>${count}${icon("chevronDown")}</summary>${toolLines(a)}</details></div>${state}</div>`
  }

  const open = accounts.filter((a) => usable(a) && !a.consented)
  const cancel = `<a class="btn btn-secondary" href="${escape(back ?? "/_connections")}">Cancel</a>`

  return `<section class="ask bare" id="ask"><div class="accounts">${accounts.map(row).join("")}</div>
${allowForm(
  ask,
  open,
  formToken,
  back,
  cancel,
  open.every((a) => !askNeedsToken(data, a)),
)}</section>`
}

/** Connect's token step for an account that takes only a token: the field alone, then back to the review page. */
const tokenStep = (ask: Asked, formToken: string, back: string | null) =>
  `<section class="ask bare" id="ask">${form(
    "token",
    formToken,
    { ...askFields(ask, back), connection: ask.connection },
    `${PASTE(connectionLabel(ask.connection))}<a class="btn btn-secondary" href="${escape(`/_connections?${askQuery(ask, back)}`)}">Cancel</a>`,
  )}</section>`

const copyField = (text: string, what: string, id = "") =>
  `<div class="copy-field"><code${id === "" ? "" : ` id="${id}"`}>${escape(text)}</code><button class="btn btn-ghost btn-square" type="button" data-copy="${escape(text)}" aria-label="Copy ${what}" title="Copy ${what}">${icon("copy")}</button></div>`

const madePanel = (made: NonNullable<Notice["made"]>, mcp: string) => {
  if (made.kind === "scim") {
    const base = mcp.replace(/\/mcp$/, "/scim/v2")

    return `<dialog class="card made overlay" id="made" data-made="${escape(made.id)}" aria-labelledby="made-title" closedby="none" open>
<header><div>${headingHtml("h2", "Your SCIM token is ready", sub("Paste both into your directory's provisioning settings. OpenBelt shows the token once."), { id: "made-title", cls: "small" })}</div></header>
<div class="field">Base URL${copyField(base, "base URL", "scim-base")}</div>
<div class="field">Token${copyField(made.token, "token", "new-token")}</div>
<form method="dialog" class="actions"><button class="btn btn-primary" type="submit" autofocus>Done</button></form>
</dialog>`
  }

  const claude = `claude mcp add --transport http openbelt ${mcp} --header "Authorization: Bearer ${made.token}"`

  return `<dialog class="card made overlay" id="made" data-made="${escape(made.id)}" aria-labelledby="made-title" closedby="none" open>
<header><div><h2 id="made-title">Your new token is ready</h2></div></header>
<div class="field">Token${copyField(made.token, "token", "new-token")}</div>
<div class="field">MCP address${copyField(mcp, "MCP address", "mcp-url")}</div>
<div class="field">Add OpenBelt to Claude Code${copyField(claude, "command")}</div>
<form method="dialog" class="actions"><button class="btn btn-primary" type="submit" autofocus>Done</button></form>
</dialog>`
}

const noticeHtml = (ok: boolean, inner: string, id = "") =>
  `<div class="notice ${ok ? "notice-success" : "notice-error"}"${id === "" ? "" : ` id="${id}"`} role="status">${icon(ok ? "check" : "alert")}<div>${inner}</div></div>`

const saidHtml = (notice: Notice | null, mcp: string) =>
  notice === null
    ? ""
    : notice.made === null
      ? noticeHtml(notice.ok, `<p>${escape(sentence(notice.message))}</p>`)
      : madePanel(notice.made, mcp)

const navOf = (data: AccountData): Nav => (data.person.role === "admin" ? "admin" : "member")

const connectionHref = (connection: string, keep: Readonly<Record<string, string>>) => {
  const query = new URLSearchParams(keep).toString()

  return `/_connections/${encodeURIComponent(connection)}${query === "" ? "" : `?${query}`}`
}

const fromYou = (from: string) =>
  from.startsWith("group:")
    ? `the ${from.slice("group:".length)} group`
    : from.startsWith("person:")
      ? "an exception an admin set for you"
      : "everyone's level"

const GIVES: Readonly<Record<Level, string>> = {
  all: "every tool",
  read: "the tools that only read",
  none: "nothing",
}

const LEVEL_BUTTON: Readonly<Record<Level, string>> = {
  all: "Read and change",
  read: "Read only",
  none: "Off",
}

const LEVEL_SAID: Readonly<Record<Level, string>> = {
  all: "Read and change",
  read: "Read only",
  none: "Off",
}

const rowLine = (view: ConnectionView) => {
  const chose = view.ownLevel !== "all" && RANK[view.ownLevel] < RANK[view.level]

  return [
    ...(chose ? [`${LEVEL_SAID[view.gets]}, your choice`] : []),
    ...(view.ownOff.length === 0 || view.gets === "none"
      ? []
      : [`${view.ownOff.length} ${view.ownOff.length === 1 ? "tool" : "tools"} off by you`]),
    ...(view.asked === undefined
      ? []
      : [`you asked for ${LEVEL_BUTTON[view.asked].toLowerCase()}`]),
  ].join(" · ")
}

const connectionLink = (
  view: ConnectionView,
  admins: ReadonlyArray<string>,
  admin: boolean,
  keep: Readonly<Record<string, string>>,
  icons: AccountData["icons"],
) => {
  const label = connectionLabel(view.connection)
  const said = connectionState(view, label, admins, admin)
  const { tone } = said
  const word = said.word === "Connected" ? "Ready" : said.word

  return `<a class="crow" href="${escape(connectionHref(view.connection, keep))}" data-connection="${escape(view.connection)}" data-find="${escape(`${label} ${view.connection}`.toLowerCase())}">${markOf(view, label, icons[view.connection])}<span class="name"><b>${escape(label)}</b>${rowLine(view) === "" ? "" : `<small>${escape(rowLine(view))}</small>`}</span>${tone === "success" || word === "Not connected" ? "" : `<span class="state is-${tone}">${escape(word)}</span>`}${view.level === "none" ? "" : `<span class="c-lvl is-${view.gets}">${LEVEL_SAID[view.gets]}</span>`}${icon("chevronRight")}</a>`
}

/** An app that asked for accounts while you used it: who asks (its tile and name), what for, then Review and Not now. */
const needCard = (
  app: string,
  asked: ReadonlyArray<AccountData["asks"][number]>,
  formToken: string,
) => {
  const named = asked.map((a) => a.connection)
  const review = `/_connections?${new URLSearchParams({ connect: named[0] ?? "", app }).toString()}`

  const notNow = form(
    "asks/dismiss",
    formToken,
    { connection: named.join(","), app },
    `<button class="btn btn-ghost" type="submit">Not now</button>`,
    "",
  )

  return `<div class="card need" data-ask="${escape(app)}">
<div class="named">${nameTile(app)}<div><b class="for">${escape(app)}</b><span class="small">Wants to use your ${escape(and(named.map((n) => connectionLabel(n))))}</span></div></div>
<div class="actions"><a class="btn btn-primary" href="${escape(review)}">Review</a>${notNow}</div>
</div>`
}

export const connectionsPage = (
  workspace: string,
  origin: string,
  switcher: string,
  data: AccountData,
  formToken: string,
  back: string | null,
  notice: Notice | null,
  connected: string | null = null,
  step: "token" | null = null,
) => {
  if (connected !== null && data.ask === null)
    return mainShell(
      "Connections",
      workspace,
      switcher,
      data.person,
      `<div class="done"><span class="ok">${icon("check")}</span>${headingHtml("h1", `${escape(connectionLabel(connected))} is connected`, sub("Go back to your agent; you can close this tab."))}<a href="/_connections/${encodeURIComponent(connected)}">See its tools</a></div>`,
      "/_connections",
    )

  const ask = data.ask
  const asking: Readonly<Record<string, string>> = ask === null ? {} : askFields(ask, back)
  const said = saidHtml(notice, `${origin}/mcp`)
  const viewOf = (name: string) => data.connections.find((v) => v.connection === name)

  // One card per app that asked, unless its review page is the one open.
  const asked = Map.groupBy(
    data.asks.filter((a) => viewOf(a.connection) !== undefined && a.app !== ask?.app),
    (a) => a.app,
  )

  const needs = [...asked].map(([app, its]) => needCard(app, its, formToken))

  const admin = data.person.role === "admin"

  const reconnects = data.connections.flatMap((v) => {
    const stopped = stoppedOf(v)

    if (stopped === undefined || v.level === "none") return []

    const label = connectionLabel(v.connection)

    const action =
      stopped.whose === "me"
        ? `<div class="actions">${connectButton(v.connection, "Connect again")}</div>`
        : admin
          ? signInForm(
              "connect",
              label,
              formToken,
              { connection: v.connection, c: v.connection },
              "/_connections",
              "workspace",
              true,
            )
          : `<p class="small">Ask ${escape(askAdmins(data.admins))} to connect it again.</p>`

    const then =
      stopped.whose === "me"
        ? `Agents and apps can't use ${label} as you until you connect it again.`
        : `Agents and apps can't use the workspace's ${label} until it's connected again.`

    return [
      `<div class="card need" data-reconnect="${escape(v.connection)}">
<div class="named">${markOf(v, label, data.icons[v.connection])}<div><a href="${escape(connectionHref(v.connection, {}))}">${escape(label)}</a><span class="small">${escape(stoppedSaid(stopped, label))} ${escape(then)}</span></div></div>
${action}
</div>`,
    ]
  })

  const sorted = data.connections.toSorted(
    (a, b) =>
      Number(b.problem !== undefined) - Number(a.problem !== undefined) ||
      connectionLabel(a.connection).localeCompare(connectionLabel(b.connection)),
  )

  const given = sorted.filter((v) => v.level !== "none")
  const withheld = sorted.filter((v) => v.level === "none")

  const needsSection =
    needs.length === 0 && reconnects.length === 0
      ? ""
      : `<section id="needs"><header><h2>Needs you</h2></header><div class="needs">${[...reconnects, ...needs].join("")}</div></section>`

  const rows = (views: ReadonlyArray<ConnectionView>) =>
    views.map((v) => connectionLink(v, data.admins, admin, asking, data.icons)).join("")

  const lists =
    data.connections.length === 0
      ? `<section id="connections" class="empty page">${tiles(icon("plug"))}<b>No connections yet</b><p>${admin ? "Add GitHub, Linear or another tool, and your apps and agents can use it." : `Ask ${escape(askAdmins(data.admins))} to add one, like GitHub or Linear.`}</p>${admin ? `<a class="btn btn-secondary" href="/_settings/connections/add">Add a connection</a>` : ""}</section>`
      : `<section id="connections">
${data.connections.length > 8 ? `<label class="find">${icon("search")}<input class="input" id="find" type="search" placeholder="Search ${data.connections.length} connections" autocomplete="off" aria-label="Search connections"></label>` : ""}
${given.length === 0 ? "" : `<div class="list-of" id="usable"><div class="rows"><div class="c-cols" aria-hidden="true"><span>Connection</span><span>Your access</span></div>${rows(given)}</div></div>`}
${withheld.length === 0 ? "" : `<details class="list-of" id="withheld"><summary><h2>Your workspace hasn't given you <span class="n">${withheld.length}</span></h2><span class="small">Open one to ask ${escape(askAdmins(data.admins))} for it</span>${icon("chevronDown")}</summary><div class="rows">${rows(withheld)}</div></details>`}
<p class="small" id="none" hidden>No connection matches.</p>
</section>`

  const consents =
    data.consents.length === 0
      ? `<p class="muted">None yet. When an app asks to use one of your connections, you allow it here.</p>`
      : `<div class="list">${data.consents
          .map(
            (c) =>
              `<div class="row" data-consent="${escape(c.app)}/${escape(c.connection)}"><div class="about"><b>${escape(c.app)}</b><span class="small">${escape(connectionLabel(c.connection))}: ${escape(allowedSaid(data, c.connection, c.tools))}, since ${escape(day(c.granted))}</span></div>${form("revoke", formToken, { ...asking, app: c.app, connection: c.connection }, `<button class="btn btn-secondary" type="submit">Revoke</button>`, "")}</div>`,
          )
          .join("")}</div>`

  const accounts = data.accounts
  const usable = (a: Asked) => (viewOf(a.connection)?.level ?? "none") !== "none"

  const deciding =
    ask !== null && ask.problem === null && accounts.some((a) => usable(a) && !a.consented)

  const tokening =
    step === "token" && ask !== null && ask.problem === null && askNeedsToken(data, ask)

  const markFor = (name: string) =>
    markOf(viewOf(name) ?? { connection: name }, connectionLabel(name), data.icons[name])

  const head =
    ask !== null && tokening
      ? headingHtml(
          "h1",
          `Connect your ${escape(connectionLabel(ask.connection))}`,
          sub(escape(ask.app)),
          { cls: "for" },
        )
      : ask !== null && deciding
        ? headingHtml(
            "h1",
            `Allow this app to use your ${escape(accounts.length === 1 ? connectionLabel(accounts[0]?.connection ?? "") : "accounts")}`,
            sub(escape(ask.env === undefined ? ask.app : `${ask.app}, live and every preview`)),
            { cls: "for" },
          )
        : `<h1>Connections</h1>`

  const body =
    ask !== null && (tokening || deciding)
      ? `<div class="top"><div class="head">${head}</div>${said}
${tokening ? tokenStep(ask, formToken, back) : reviewBody(data, ask, accounts, formToken, back)}</div>`
      : `<div class="top"><div class="head">${head}</div>${said}
${ask === null ? "" : askCard(data, ask, back)}
</div>
${needsSection}
${lists}
${data.connections.length === 0 && data.consents.length === 0 ? "" : `<section id="consents"><header>${headingHtml("h2", "Apps you allowed", sub("Only while you use it."))}</header>${consents}</section>`}`

  const address =
    ask === null
      ? "/_connections"
      : `/_connections?${askQuery(ask, back)}${tokening ? "&step=token" : ""}`

  // Up to three accounts' marks by the app's tile, then how many more.
  const marks = (named: ReadonlyArray<string>) =>
    named.length === 1
      ? markFor(named[0] ?? "")
      : `<span class="stack">${named.slice(0, 3).map(markFor).join("")}${named.length > 3 ? `<span class="more">+${named.length - 3}</span>` : ""}</span>`

  return ask !== null && (tokening || deciding)
    ? decisionPage(
        tokening ? `Connect ${connectionLabel(ask.connection)}` : `Allow ${ask.app}`,
        body,
        address,
        pairHtml(
          nameTile(ask.app),
          marks(tokening ? [ask.connection] : accounts.map((a) => a.connection)),
        ),
      )
    : mainShell("Connections", workspace, switcher, data.person, body, address)
}

/** What tools let you do, as one phrase: "see your profile and your pull requests" (a shared verb said once). */
const doing = (
  tools: ReadonlyArray<{ readonly tool: string; readonly description: string }>,
  wrap = (t: string, html: string) => html,
) => {
  const names = tools.map((t) =>
    toolSaid(t.tool, t.description).name.replace(/^./, (c) => c.toLowerCase()),
  )

  const verb = names[0]?.split(" ")[0] ?? ""
  const shared = names.length > 1 && names.every((n) => n.split(" ")[0] === verb)

  return `${shared ? `${verb} ` : ""}${and(names.map((n, i) => wrap(tools[i]?.tool ?? "", escape(shared ? n.slice(verb.length + 1) : n))))}`
}

const toolTitle = (t: ConnectionView["tools"][number]) =>
  `<span class="tname" title="${escape(t.tool)}">${escape(toolSaid(t.tool, t.description).name)}</span>`

const aboutAfter = (t: ConnectionView["tools"][number]) => {
  const { about } = toolSaid(t.tool, t.description)

  return about === "" ? "" : ` · ${escape(about)}`
}

/** A row to give a group or a person a level of their own on a connection. */
const addWhoRow = (who: WhoHas, keep: Readonly<Record<string, string>>, formToken: string) =>
  who.unset.groups.length === 0 && who.unset.people.length === 0
    ? ""
    : `<tr class="add"><td colspan="2">${form(
        "access",
        formToken,
        keep,
        `<input type="hidden" name="level" value="read"><span class="select"><select class="input" name="who" aria-label="Add a group or person" required data-save><option value="">Add a group or person</option>${
          who.unset.groups.length === 0
            ? ""
            : `<optgroup label="Groups">${who.unset.groups.map((g) => `<option value="group:${escape(g)}">${escape(g)}</option>`).join("")}</optgroup>`
        }<optgroup label="People">${who.unset.people.map((p) => `<option value="person:${escape(p.email)}">${escape(p.name.trim() === "" ? p.email : p.name)}</option>`).join("")}</optgroup></select>${icon("chevronDown")}</span><button class="btn btn-secondary save" type="submit">Add</button>`,
        "add-who",
      )}</td></tr>`

const whoGlyph = (key: string) => {
  if (key === "everyone") return icon("globe")

  return key.startsWith("group:") ? icon("users") : icon("user")
}

/** Who has access, for admins on a connection's page: each row's level changes right there. */
const whoHasHtml = (who: WhoHas | undefined, connection: string, formToken: string) => {
  if (who === undefined) return ""

  const label = connectionLabel(connection)
  const keep = { back: "connection", c: connection, connection }

  const row = (key: string, name: string, through: string, select: string) =>
    `<tr data-who="${escape(key)}"><td><span class="subj"><span class="subj-icon" aria-hidden="true">${whoGlyph(key)}</span><span><b>${name}</b><span class="small">${through}</span></span></span></td><td>${form("access", formToken, { ...keep, who: key }, select, "")}</td></tr>`

  return `<section id="who"><header><h2>Who has access</h2></header><div class="scroll"><table><tbody>${row("everyone", "Everyone", "workspace default", levelSelect(`Everyone on ${label}`, who.everyone, null))}${who.groups
    .map((g) =>
      row(
        `group:${g.name}`,
        `<a href="/_settings/groups/${escape(g.name)}">${escape(g.name)}</a>`,
        `group of ${g.members}`,
        levelSelect(`${g.name} on ${label}`, g.level, "Workspace default"),
      ),
    )
    .join("")}${who.people
    .map((p) =>
      row(
        `person:${p.email}`,
        escape(p.name.trim() === "" ? p.email : p.name),
        "exception",
        levelSelect(`${p.email} on ${label}`, p.level, "No exception"),
      ),
    )
    .join("")}${addWhoRow(who, keep, formToken)}</tbody></table></div></section>`
}

export const connectionPage = (
  workspace: string,
  origin: string,
  switcher: string,
  data: AccountData,
  view: ConnectionView,
  formToken: string,
  back: string | null,
  notice: Notice | null,
  scope: string | null = null,
) => {
  const ask = data.ask
  const keep: Readonly<Record<string, string>> = ask === null ? {} : askFields(ask, back)
  const label = connectionLabel(view.connection)
  const admin = data.person.role === "admin"
  const { word, tone, about } = connectionState(view, label, data.admins, admin)
  const hidden = { ...keep, c: view.connection, connection: view.connection }

  const picked: Level =
    view.ownLevel === "all"
      ? view.level
      : RANK[view.ownLevel] < RANK[view.level]
        ? view.ownLevel
        : view.level

  const option = (level: Level) => {
    const above = RANK[level] > RANK[view.level]

    return `<button class="btn btn-ghost" type="submit" name="level" value="${level}" aria-pressed="${picked === level}"${above ? ` disabled title="Above your workspace's limit, which its admins set"` : ""}>${above ? icon("lock") : ""}${LEVEL_BUTTON[level]}</button>`
  }

  const from = fromYou(view.levelFrom)
  const chose = view.ownLevel !== "all" && RANK[view.ownLevel] < RANK[view.level]

  const sayLevel =
    view.level === "none"
      ? `Your workspace gives you nothing on ${escape(label)}, from ${escape(from)}.${view.ownLevel === "all" ? "" : ` Your own choice (${LEVEL_BUTTON[view.ownLevel].toLowerCase()}) is kept for when it does.`}`
      : chose
        ? `You chose ${LEVEL_BUTTON[view.ownLevel].toLowerCase()}. Your workspace gives you ${GIVES[view.level]}, from ${escape(from)}.`
        : view.levelFrom.startsWith("group:")
          ? `The ${escape(view.levelFrom.slice("group:".length))} group gives you ${LEVEL_SAID[view.level].toLowerCase()}.`
          : view.levelFrom.startsWith("person:")
            ? `An exception gives you ${LEVEL_SAID[view.level].toLowerCase()}.`
            : ""

  const more: Level = view.level === "none" ? "read" : "all"

  const asking =
    view.level === "all"
      ? ""
      : admin
        ? ""
        : view.asked !== undefined
          ? `<div class="asked">${noticeHtml(true, `<p>You asked for ${LEVEL_BUTTON[view.asked].toLowerCase()}. ${escape(askAdmins(data.admins))} see it with everyone's requests.</p>`)}${form("mine/unask", formToken, hidden, `<button class="btn btn-ghost" type="submit">Take back the ask</button>`, "")}</div>`
          : form(
              "mine/ask",
              formToken,
              { ...hidden, want: more },
              `<input class="input" name="note" maxlength="${NOTE_MAX}" autocomplete="off" placeholder="Reason (optional)" aria-label="Reason (optional)"><div class="actions"><button class="btn ${view.level === "none" ? "btn-primary" : "btn-secondary"}" type="submit">Ask for ${LEVEL_BUTTON[more].toLowerCase()}</button></div>`,
              "askform",
            )

  const use =
    view.level === "none"
      ? `<section id="use">${asking}</section>`
      : `<section id="use"><header>${headingHtml("h2", "Your access")}</header>
${form("mine/level", formToken, hidden, `${option("all")}${option("read")}${option("none")}`, "lvpick")}
<p class="small" id="level-said"${sayLevel === "" ? " hidden" : ""}>${sayLevel}</p>
${asking}</section>`

  const toolName = (t: ConnectionView["tools"][number]) => t.tool.slice(view.connection.length + 1)

  const toolRow = (t: ConnectionView["tools"][number]) => {
    const name = toolName(t)
    const mine = view.ownOff.includes(name)
    const gets = view.gets

    const locked = t.disabled
      ? "Off for everyone: an admin turned it off"
      : view.level === "none"
        ? "Your workspace hasn't given you this"
        : gets === "none"
          ? "Off: you turned this connection off"
          : gets === "read" && !t.readOnly
            ? view.level === "read"
              ? "Changes things: needs All, above your workspace's limit"
              : "Changes things: you chose read only"
            : undefined

    const on = locked === undefined && !mine

    const what =
      locked ?? (mine ? "You turned it off" : t.readOnly ? "Only reads" : "Changes things")

    const toggle = form(
      "mine/tool",
      formToken,
      { ...hidden, tool: name, on: on ? "false" : "true" },
      `<button class="switch" type="submit" role="switch" aria-checked="${on}" aria-label="${escape(toolSaid(t.tool, t.description).name)} for you"${locked === undefined ? "" : " disabled"}></button>`,
      "",
    )

    return `<div class="trow${locked === undefined ? "" : " locked"}" data-tool="${escape(name)}"><div class="about">${toolTitle(t)}<span class="small">${locked === undefined ? "" : icon("lock")}${escape(what)}${aboutAfter(t)}</span></div>${toggle}</div>`
  }

  const usable = view.tools.filter((t) => t.usable).length

  const reads = view.tools.filter((t) => t.readOnly && !t.disabled)

  const gives =
    reads.length === 0
      ? `<p class="muted">None of its tools only read yet.</p>`
      : `<p>Read only lets you ${doing(reads)}.</p>`

  const tools =
    view.tools.length === 0
      ? `<section id="tools"><header><h2>Tools</h2></header><p class="muted">${view.problem !== undefined ? `Its tools show here once ${escape(label)} answers again.` : view.signIn === "oauth" ? "Its tools show here once someone connects it." : "No tools listed yet."}</p></section>`
      : view.level === "none"
        ? ""
        : `<section id="tools"><header><h2>Tools <span class="count">${usable} of ${view.tools.length} on for you</span></h2></header><div class="list trows">${view.tools.map(toolRow).join("")}</div></section>`

  const here = connectionHref(view.connection, keep)
  const p = providerOf(view)
  const maker = makerOf(view)
  const stopped = stoppedOf(view)
  const asked = ask !== null && ask.connection === view.connection

  const lacking = scope ?? (view.scopes?.missing.length ? view.scopes.missing.join(" ") : null)

  const lackingCard =
    lacking === null || view.signIn !== "oauth" || view.yourToken !== "set"
      ? ""
      : `<div class="card lack" data-lacking="${escape(lacking)}">${icon("alert")}<div><p><b>${escape(
          scope === null
            ? maker === label
              ? `${maker} didn't grant everything OpenBelt asked for.`
              : `You didn't allow ${label} on ${maker}'s screen.`
            : `${maker} didn't grant ${scopeWords(scope)}, which a tool needs.`,
        )}</b> Tools that need it are refused until you connect again and allow it.</p>${signInForm(
          "connect",
          label,
          formToken,
          { ...hidden, scope: lacking },
          here,
          "me",
          true,
          `Connect again and allow ${scope === null && maker !== label ? label : "it"}`,
        )}${
          admin
            ? `<details class="names"><summary>Details for admins</summary><p class="small">Missing: ${lacking
                .split(" ")
                .map((x) => `<code>${escape(x)}</code>`)
                .join(
                  ", ",
                )}${view.scopes?.granted === undefined ? "" : `. Granted: ${view.scopes.granted.map((x) => `<code>${escape(x)}</code>`).join(", ")}`}</p></details>`
            : ""
        }</div></div>`

  const refusedSignIn = view.problem !== undefined && /HTTP 40[13]/.test(view.problem)

  const problemCard =
    view.problem === undefined || !admin
      ? ""
      : `<div class="card lack" id="problem">${icon("alert")}<div><p><b>${refusedSignIn ? (view.signIn === "oauth" ? `Reconnect ${escape(label)}` : `${escape(label)} needs a new token`) : `${escape(label)} isn't answering`}</b></p><p>${
          refusedSignIn
            ? view.signIn === "oauth"
              ? `Its sign-in expired or was revoked. Connect it again under Runs with.`
              : `${escape(label)} refused the token OpenBelt has. Ask your agent to update the ${escape(label)} connection with a new one.</p><p><button class="btn btn-secondary" type="button" data-copy="Update the ${escape(label)} connection in OpenBelt with a new token: ${escape(label)} refuses the one it has.">${icon("copy")}Copy request for your agent</button>`
            : `Check that the server is up and its address is right, or ask whoever runs it.`
        }</p><details class="names"><summary>Technical details</summary><p class="small">${escape(sentence(view.problem.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z?:\s*/, "")))}</p></details></div></div>`

  const needsApp = needsAppOf(view, admin)

  const action =
    view.level === "none" || asked || lacking !== null
      ? ""
      : needsApp
        ? `<a class="btn btn-primary" href="#setup">Finish setup</a>`
        : view.signIn === "oauth" &&
            view.yourToken !== "not used" &&
            (view.yourToken === "missing" || stopped?.whose === "me")
          ? connectButton(view.connection, stopped === undefined ? "Connect" : "Connect again")
          : view.signIn === "oauth" &&
              admin &&
              view.workspaceToken !== "not used" &&
              (view.workspaceToken === "missing" || stopped?.whose === "workspace")
            ? signInForm(
                "connect",
                label,
                formToken,
                hidden,
                here,
                "workspace",
                stopped !== undefined,
                stopped === undefined
                  ? "Connect for the workspace"
                  : "Connect again for the workspace",
              )
            : view.signIn !== "oauth" && view.yourToken === "missing"
              ? `<a class="btn btn-primary" href="#token">Paste your token</a>`
              : ""

  const token =
    view.yourToken === "not used" || view.level === "none"
      ? ""
      : view.signIn === "oauth"
        ? view.yourToken === "set"
          ? `<div class="row"><div class="about"><b>Your ${escape(maker)} account</b><span class="small">Disconnect to stop agents and apps using it at once.</span></div>${signInForm("disconnect", label, formToken, hidden, here, "me")}</div>`
          : ""
        : view.yourToken === "set"
          ? `<div class="row"><div class="about"><b>Your token</b></div>${form(
              "token/clear",
              formToken,
              hidden,
              `<button class="btn btn-secondary" type="submit">Remove your token</button>`,
              "actions",
            )}</div>`
          : `<div class="field">Your token${form("token", formToken, hidden, PASTE(label))}<span class="small">Paste it here, never into a chat with an agent.</span></div>`

  const workspaceSignIn =
    view.signIn !== "oauth" || view.workspaceToken === "not used" || !admin
      ? ""
      : `<div class="row"><div class="about"><b>The workspace's ${escape(maker)} account</b><span class="small">${view.workspaceToken === "set" ? "Calls that run as the workspace use it." : "Not connected yet. Connect it once, for everyone."}</span></div>${signInForm(view.workspaceToken === "set" ? "disconnect" : "connect", label, formToken, hidden, here, "workspace", false, view.workspaceToken === "set" ? undefined : "Connect for the workspace")}</div>`

  const account =
    token === "" && workspaceSignIn === ""
      ? ""
      : `<section id="token"><header>${headingHtml("h2", "Runs with", view.credential === "both" ? sub("Your own account, or the workspace's while you have none.") : null)}</header>${token}${workspaceSignIn}</section>`

  const app =
    !admin || p?.signIn !== "oauth" || p.registration.kind !== "admin"
      ? ""
      : needsApp
        ? `<section id="setup" class="setup"><header>${headingHtml("h2", `Finish setting up ${escape(label)}`, sub(`Nobody can connect ${escape(label)} until an admin registers an OAuth app at ${escape(maker)}.`))}</header>${appSteps(origin, p)}${clientForm(formToken, view.connection, "Save and finish setup")}</section>`
        : `<details class="setup" id="setup"><summary>${escape(maker)} OAuth app<span class="small">Replace its client ID and secret, after rotating them at ${escape(maker)}</span>${icon("chevronDown")}</summary>${appSteps(origin, p)}${clientForm(formToken, view.connection, "Save")}</details>`

  const uploaded = data.icons[view.connection]
  const tile = markOf(view, label, uploaded)
  const iconFields = `<input type="hidden" name="form" value="${escape(formToken)}"><input type="hidden" name="connection" value="${escape(view.connection)}"><input type="hidden" name="c" value="${escape(view.connection)}">`

  const reset =
    uploaded === undefined
      ? ""
      : `<button class="reset" type="submit" form="icon-reset" title="Reset icon" aria-label="Reset ${escape(label)}'s icon">${icon("x")}</button><form id="icon-reset" method="post" action="/_settings/connections/icon/clear" hidden>${iconFields}</form>`

  const heading = !admin
    ? tile
    : `<span class="mark-wrap"><form class="iconform" method="post" action="/_settings/connections/icon" enctype="multipart/form-data">${iconFields}<label class="mark-edit" title="Change icon">${tile}<span class="edit">${icon("pencil")}</span><input type="file" name="icon" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" aria-label="Change ${escape(label)}'s icon" data-save></label></form>${reset}</span>`

  const allowed = data.consents.filter((c) => c.connection === view.connection)

  const apps =
    allowed.length === 0 || view.level === "none"
      ? ""
      : `<section id="allowed"><header><h2>Apps you allowed</h2></header><div class="list">${allowed.map((c) => `<div class="row"><div class="about"><b title="${escape(allowedSaid(data, c.connection, c.tools))}, since ${escape(day(c.granted))}">${escape(c.app)}</b></div>${form("revoke", formToken, { ...hidden, app: c.app }, `<button class="btn btn-secondary" type="submit">Revoke</button>`, "")}</div>`).join("")}</div></section>`

  // An admin's own access, token and apps fold under Who has access, which leads their page.
  const folded = data.whoHas[view.connection] !== undefined && view.level !== "none"

  const body = `<div class="top">${crumbs([
    ["Connections", "/_connections"],
    [label, null],
  ])}
<div class="head head-act" id="detail" data-connection="${escape(view.connection)}"><div>${headingHtml("h1", `${heading}${escape(label)}`, sub(`${view.level === "none" ? "" : `<span class="state is-${tone}">${escape(word)}</span> `}${about}`), { cls: "said" })}</div>${action === "" ? "" : `<div class="act">${action}</div>`}</div>${saidHtml(notice, `${origin}/mcp`)}
${problemCard}${lackingCard}
${asked ? askCard(data, ask, back) : ""}</div>
${whoHasHtml(data.whoHas[view.connection], view.connection, formToken)}
${needsApp ? app : ""}
${
  view.level === "none"
    ? use.replace(
        '<section id="use">',
        `<section id="use" class="offpanel"><header><h2>${icon("lock")}Get access</h2></header>${gives}`,
      )
    : !folded
      ? `${use}
${tools}`
      : `<details class="list-of" id="mine" open><summary><h2>Your access</h2><span class="small">${LEVEL_SAID[picked]}${view.tools.length === 0 ? "" : ` · ${view.tools.filter((t) => t.usable).length} of ${view.tools.length} tools on`}</span>${icon("chevronDown")}</summary>${use.replace(`<header><h2>Your access</h2></header>`, "")}
${tools}
${account}
${apps}</details>`
}
${folded ? "" : account}
${needsApp ? "" : app}
${folded ? "" : apps}`

  return mainShell(
    label,
    workspace,
    switcher,
    data.person,
    body,
    connectionHref(view.connection, keep),
  )
}

const appSteps = (origin: string, p: Extract<Provider, { readonly signIn: "oauth" }>) => {
  const maker = p.maker ?? p.name
  const preview = p.api === undefined ? PREVIEW_PROGRAM.get(p.issuer) : undefined

  return `<ol class="steps">
<li><span>Make an OAuth app at ${escape(maker)}.</span><a class="btn btn-secondary" href="${escape(p.registration.kind === "admin" ? p.registration.registerAt : p.docs)}" target="_blank" rel="noopener noreferrer">Open ${escape(maker)}'s app settings${icon("externalLink")}</a></li>
<li><div class="field">Callback URL${copyField(callbackOf(origin, registrationOf(p.issuer)), "the callback URL")}</div><span class="small">Give the app this URL as its callback (redirect) URL.</span></li>
<li><span>Paste its client ID and secret below.</span></li>
</ol>${
    preview === undefined
      ? ""
      : `<p class="small">${escape(maker)}'s MCP servers are a preview: the Cloud project that owns the app must be in the <a href="${escape(preview)}" target="_blank" rel="noopener noreferrer">${escape(maker)} Workspace Developer Preview Program</a>, and its client must have Use this client for an AI-powered agent ticked.</p>`
  }`
}

const clientFields = (clientId: string) =>
  `<label class="field">Client ID<input class="input" name="clientId" autocomplete="off" spellcheck="false" value="${escape(clientId)}"></label>
<label class="field">Client secret<input class="input" name="secret" type="password" autocomplete="off"></label>`

const clientForm = (formToken: string, connection: string, says: string) =>
  form(
    "connections/client",
    formToken,
    { connection, c: connection },
    `${clientFields("")}<div class="actions"><button class="btn btn-primary" type="submit">${escape(says)}</button></div>`,
    "clientform",
  )

const PREVIEW_PROGRAM = new Map([
  ["https://accounts.google.com", "https://developers.google.com/workspace/preview"],
])

/** What an agent's row says it may use. */
const appsOf = (apps: AgentApps) =>
  apps === null
    ? "Every app"
    : apps.length === 0
      ? "No apps"
      : apps.length <= 3
        ? apps.join(", ")
        : `${apps.slice(0, 2).join(", ")} and ${apps.length - 2} more`

/** The button that opens the apps picker for one sign-in or token. */
const appsButton = (kind: "signins" | "tokens", id: string, name: string, apps: AgentApps) =>
  `<button class="btn btn-secondary" type="button" data-apps="${kind}" data-id="${escape(id)}" data-name="${escape(name)}" data-chosen="${escape(JSON.stringify(apps))}">Apps</button>`

/** The picker: every app, or only the ones ticked (searched and filtered in the page, however many the workspace has). */
const appsDialog = (data: AccountData, formToken: string) =>
  `<dialog class="card made overlay appsd" id="apps-dialog" aria-labelledby="apps-title" data-me="${escape(data.person.email)}">${form(
    "tokens/apps",
    formToken,
    { id: "", apps: "" },
    `<header><h2 id="apps-title">Apps<span class="who"></span></h2></header>
<div class="choices"><label><input type="radio" name="every" value="every"><span><b>Every app</b><span>All ${data.apps.length.toLocaleString("en-US")} apps you can use, and every app made later</span></span></label><label><input type="radio" name="every" value="some"><span><b>Only these apps</b><span>It can't see, open, make or change any other</span></span></label></div>
<div class="pick"><input class="input" type="search" placeholder="Search ${data.apps.length.toLocaleString("en-US")} apps" aria-label="Search apps" autocomplete="off">
<div class="filters"><button type="button" data-f="selected">Selected<span></span></button><button type="button" data-f="all">All<span></span></button><button type="button" data-f="yours">Yours<span></span></button></div>
<div class="found" role="group" aria-label="Apps"></div></div>
<footer><span class="count"></span><button class="btn btn-ghost" type="submit" formmethod="dialog" formnovalidate>Cancel</button><button class="btn btn-primary save" type="submit">Save</button></footer>`,
    "",
  )}</dialog>
<script type="application/json" id="apps-data">${JSON.stringify(data.apps).replaceAll("<", "\\u003c")}</script>`

const APPS_SCRIPT = `
const appsDialog = document.getElementById("apps-dialog")
if (appsDialog) {
  const all = JSON.parse(document.getElementById("apps-data").textContent)
  const me = appsDialog.dataset.me
  const f = appsDialog.querySelector("form")
  const q = appsDialog.querySelector("input[type=search]")
  const pick = appsDialog.querySelector(".pick")
  const found = appsDialog.querySelector(".found")
  const count = appsDialog.querySelector(".count")
  const save = appsDialog.querySelector(".save")
  const SHOWN = 100
  let chosen = new Set()
  let filter = "selected"
  const every = () => f.elements.every.value === "every"
  const sync = () => {
    f.elements.apps.value = every() ? "*" : [...chosen].join("\\n")
    count.innerHTML = every() ? "" : chosen.size + (chosen.size === 1 ? " app" : " apps") + " <span>of " + all.length.toLocaleString("en-US") + "</span>"
    const counts = { selected: chosen.size, all: all.length, yours: all.filter((a) => a.owner === me).length }
    for (const b of appsDialog.querySelectorAll("[data-f]")) {
      b.setAttribute("aria-pressed", String(b.dataset.f === filter))
      b.querySelector("span").textContent = counts[b.dataset.f].toLocaleString("en-US")
    }
  }
  const render = () => {
    pick.hidden = every()
    const term = q.value.trim().toLowerCase()
    let pool = all.filter((a) => term === "" || a.name.includes(term))
    if (filter === "selected") pool = pool.filter((a) => chosen.has(a.name))
    if (filter === "yours") pool = pool.filter((a) => a.owner === me)
    const rows = pool.slice(0, SHOWN).map((a) => {
      const row = document.createElement("label")
      const box = Object.assign(document.createElement("input"), { type: "checkbox", value: a.name, checked: chosen.has(a.name) })
      const text = document.createElement("span")
      text.append(Object.assign(document.createElement("b"), { textContent: a.name }), Object.assign(document.createElement("small"), { textContent: a.owner }))
      row.append(box, text)
      return row
    })
    const said = pool.length === 0
      ? (term === "" ? (filter === "selected" ? "None yet: search, or pick from All." : "No apps here.") : 'No app has "' + term + '" in its name.')
      : pool.length > SHOWN ? "Showing " + SHOWN + " of " + pool.length.toLocaleString("en-US") + ". Search to find more." : ""
    if (said !== "") rows.push(Object.assign(document.createElement("p"), { className: "more", textContent: said }))
    found.replaceChildren(...rows)
    sync()
  }
  found.addEventListener("change", (e) => {
    const box = e.target
    if (box.checked) chosen.add(box.value); else chosen.delete(box.value)
    sync()
  })
  q.addEventListener("input", () => { if (q.value.trim() !== "" && filter === "selected") filter = "all"; render() })
  for (const b of appsDialog.querySelectorAll("[data-f]")) b.addEventListener("click", () => { filter = b.dataset.f; render() })
  for (const r of f.elements.every) r.addEventListener("change", render)
  f.addEventListener("submit", (e) => {
    if (e.submitter?.getAttribute("formmethod") === "dialog") return
    save.disabled = true
    save.textContent = "Saving"
  })
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-apps]")
    if (!b) return
    const apps = JSON.parse(b.dataset.chosen)
    chosen = new Set(apps ?? [])
    filter = chosen.size > 0 ? "selected" : "all"
    f.action = "/_settings/" + b.dataset.apps + "/apps"
    f.elements.id.value = b.dataset.id
    f.elements.every.value = apps === null ? "every" : "some"
    appsDialog.querySelector(".who").textContent = b.dataset.name
    q.value = ""
    save.disabled = false
    save.textContent = "Save"
    render()
    appsDialog.showModal()
  })
}`

export const agentsPage = (
  workspace: string,
  origin: string,
  address: string,
  data: AccountData,
  formToken: string,
  notice: Notice | null,
) => {
  const mcp = `${origin}/mcp`
  // Claude Code and pi send a token over plain http only to the host localhost.
  const needsToken = address.startsWith("http://") && new URL(address).hostname !== "localhost"

  const signedIn =
    data.signedIn.length === 0
      ? `<p class="muted">No agents signed in yet.</p>`
      : `<div class="list">${data.signedIn
          .map(
            (g) =>
              `<div class="row" data-signin="${escape(g.id)}"><div class="about"><b>${escape(g.clientName)}</b><span class="small">${isLoopback(g.redirectHost) ? "On this computer" : g.redirectHost === DEVICE_HOST ? "With a sign-in code" : `Back to <code>${escape(g.redirectHost)}</code>`} · signed in ${escape(day(g.created))} · last used ${escape(moment(g.used))} UTC</span><span class="small apps-of">${escape(appsOf(g.apps))}</span></div><div class="acts">${appsButton("signins", g.id, g.clientName, g.apps)}${form("signins/revoke", formToken, { id: g.id, name: g.clientName }, `<button class="btn btn-secondary" type="submit">Sign out</button>`, "")}</div></div>`,
          )
          .join("")}</div>`

  const tokens =
    data.tokens.length === 0
      ? `<p class="muted">None yet. Make one for each agent you use, so you can revoke one alone.</p>`
      : `<div class="list">${data.tokens
          .map(
            (t) =>
              `<div class="row" data-token="${escape(t.id)}"><div class="about"><b>${escape(t.label === "" ? "No label" : t.label.charAt(0).toUpperCase() + t.label.slice(1))}</b><span class="small" title="Made ${escape(day(t.created))}">${t.expires === null ? "never expires" : `expires ${escape(day(t.expires))}`}</span><span class="small apps-of">${escape(appsOf(t.apps))}</span></div><div class="acts">${appsButton("tokens", t.id, t.label === "" ? "No label" : t.label.charAt(0).toUpperCase() + t.label.slice(1), t.apps)}${form("tokens/revoke", formToken, { id: t.id }, `<button class="btn btn-ghost btn-square" type="submit" aria-label="Revoke ${escape(t.label === "" ? "this token" : t.label)}" title="Revoke">${icon("x")}</button>`, "")}</div></div>`,
          )
          .join("")}</div>`

  const make = form(
    "tokens/create",
    formToken,
    {},
    `<label class="field grow">Label<input class="input" name="label" maxlength="60" placeholder="Like laptop" aria-label="Label"></label><label class="field">Expires<span class="select"><select class="input" name="days" aria-label="Expires"><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="">Never</option></select>${icon("chevronDown")}</span></label><button class="btn btn-primary" type="submit">${icon("key")}Make a token</button>`,
    "make",
  )

  const body = `<div class="top"><div class="head"><h1>Agents</h1></div>${saidHtml(notice, mcp)}</div>
${
  notice?.made === undefined || notice.made === null
    ? `<section id="connect">
<div class="field">Address for your agent${copyField(address, "address")}${needsToken ? `<span class="small">Claude Code and pi sign in only over https or to localhost, so here they need a token.</span>` : ""}</div>
</section>`
    : ""
}
${
  data.signedIn.length === 0
    ? ""
    : `<section id="signed-in"><header><h2>Agents signed in</h2></header>
${signedIn}</section>`
}
<section id="tokens"><header class="head-act"><div>${headingHtml("h2", "Tokens")}</div><details class="newtoken"><summary class="btn btn-secondary">${icon("key")}Make a token</summary></details></header>
<div class="newtoken-form" hidden>${make}</div>
${tokens}</section>
${appsDialog(data, formToken)}`

  return shell(workspace, navOf(data), "agents", body, undefined, APPS_SCRIPT)
}

const initials = (p: Member) => {
  const words = p.name
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "")

  const first = words[0] ?? p.email
  const last = words.length > 1 ? (words.at(-1) ?? "") : ""

  return last === "" ? first.slice(0, 2) : `${first.charAt(0)}${last.charAt(0)}`
}

const avatar = (p: Member, small = false) =>
  `<span class="av${small ? " sm" : ""}" aria-hidden="true">${escape(initials(p))}</span>`

const firstName = (p: Member) => p.name.trim().split(/\s+/)[0] || (p.email.split("@")[0] ?? p.email)

const whoHtml = (p: Member, me: string, extra = "") =>
  `<span class="who"><span><b>${escape(p.name)}${p.id === me ? " (you)" : ""}</b><small>${escape(p.email)}${extra}</small></span></span>`

const LEVEL_CHOICES: ReadonlyArray<readonly [Level, string]> = [
  ["none", "Off"],
  ["read", "Read only"],
  ["all", "Read and change"],
]

const levelSelect = (label: string, chosen: Level | "", unset: string | null) =>
  `<span class="select"><select class="input" name="level" aria-label="${escape(label)}" data-save>${[...(unset === null ? [] : [["", unset] as const]), ...LEVEL_CHOICES].map(([v, t]) => `<option value="${v}"${v === chosen ? " selected" : ""}>${escape(t)}</option>`).join("")}</select>${icon("chevronDown")}</span><button class="btn btn-secondary save" type="submit">Save</button>`

const LEVEL_WORD: Readonly<Record<Level, string>> = {
  none: "Off",
  read: "Read only",
  all: "Read and change",
}

const GETS: Readonly<Record<Level, readonly [string, string]>> = {
  none: ["can't use it", "can't use it"],
  read: ["gets read tools only", "get read tools only"],
  all: ["gets all tools", "get all tools"],
}

const andList = (names: ReadonlyArray<string>) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

const differLine = (
  members: ReadonlyArray<Member>,
  results: Readonly<Record<string, Result>>,
  setting: Level,
) => {
  const differ = new Map<string, { level: Level; from: string; people: Array<Member> }>()

  for (const p of members) {
    const r = results[p.id]

    if (r === undefined || r.level === setting) continue

    const key = `${r.level} ${r.from}`
    const same = differ.get(key)

    if (same === undefined) differ.set(key, { level: r.level, from: r.from, people: [p] })
    else same.people.push(p)
  }

  if (differ.size === 0) return ""

  const parts = [...differ.values()].map(({ level, from, people }) => {
    const why = from.startsWith("group:")
      ? `, via ${from.slice("group:".length)}`
      : from.startsWith("person:")
        ? ", by an exception"
        : ", from everyone"

    const names = andList(
      people.map(
        (p) =>
          `<span data-person="${escape(p.email)}" data-level="${level}">${escape(firstName(p))}</span>`,
      ),
    )

    return `${names} ${GETS[level][people.length === 1 ? 0 : 1]}${why}`
  })

  return `<p class="small differ">Effective access: ${parts.join("; ")}.</p>`
}

const groupLink = (group: Group) =>
  `<a class="gl" href="/_settings/groups/${encodeURIComponent(group.name)}">${group.source === "scim" ? icon("lock") : ""}${escape(group.name)}</a>`

const confirmed = (label: string, warning: string, doIt: string) =>
  `<details class="danger"><summary class="btn btn-secondary btn-danger"><span class="closed">${escape(label)}</span><span class="opened">Cancel</span></summary>${doIt.replace("<!--warning-->", `<p class="small">${escape(warning)}</p>`)}</details>`

const personRow = (p: Member, data: WorkspaceData, formToken: string) => {
  const groups = p.groups.map((name) => {
    const group = data.groups.find((g) => g.name === name)

    return group === undefined ? `<span class="chip">${escape(name)}</span>` : groupLink(group)
  })

  const mine = p.id === data.me

  const tags = p.status === "invited" ? ' <span class="role">Invited</span>' : ""

  const role = mine
    ? `<p class="small">You're an admin. Another admin can change that.</p>`
    : form(
        "people/role",
        formToken,
        { person: p.email },
        `<span class="select"><select class="input" name="role" aria-label="${escape(p.email)}'s role" data-save><option value="member"${p.role === "member" ? " selected" : ""}>Member</option><option value="admin"${p.role === "admin" ? " selected" : ""}>Admin: manages people, groups and connections</option></select>${icon("chevronDown")}</span><button class="btn btn-secondary save" type="submit">Save</button>`,
      )

  const setting = (c: WorkspaceData["connections"][number]) => {
    const label = connectionLabel(c.connection)
    const result = c.result[p.id]
    const own = c.people[p.id]

    const now =
      result === undefined
        ? ""
        : own === undefined
          ? `${LEVEL_WORD[result.level]}, from ${result.from.startsWith("group:") ? result.from.slice("group:".length) : "everyone"}`
          : ""

    return `<div class="setting" data-connection="${escape(c.connection)}"><div><b>${escape(label)}</b><span class="small">${escape(now)}</span></div>${form("access", formToken, { connection: c.connection, who: `person:${p.email}` }, levelSelect(`${p.email} on ${label}`, own ?? "", "No exception"), "")}</div>`
  }

  const own = data.connections.filter((c) => c.people[p.id] !== undefined)
  const rest = data.connections.filter((c) => c.people[p.id] === undefined)

  const settings =
    data.connections.length === 0
      ? `<p class="small">There are no connections yet, so nothing to set.</p>`
      : `${own.length === 0 ? `<p class="small">None: ${escape(firstName(p))} gets what their groups get.</p>` : own.map(setting).join("")}${
          rest.length === 0
            ? ""
            : `<details class="names others"><summary>${own.length === 0 ? "Add an exception" : `Other connections (${rest.length})`}</summary><div class="more-of">${rest.map(setting).join("")}</div></details>`
        }`

  const remove = mine
    ? ""
    : confirmed(
        `Remove from the workspace`,
        `Removing ${p.email} revokes their API tokens and connection tokens and closes their open pages, now.`,
        form(
          "people/remove",
          formToken,
          { person: p.email },
          `<!--warning--><button class="btn btn-secondary btn-danger" type="submit">Remove ${escape(firstName(p))}</button>`,
          "",
        ),
      )

  const exceptions =
    own.length === 0 ? "" : `${own.length} ${own.length === 1 ? "exception" : "exceptions"}`

  return `<details class="person" data-person="${escape(p.email)}" data-find="${escape(`${p.name} ${p.email} ${p.groups.join(" ")}`.toLowerCase())}"><summary>${whoHtml(
    p,
    data.me,
  )
    .replace('<span class="who">', `<span class="who">${avatar(p)}`)
    .replace(
      "</b>",
      `${tags}</b>`,
    )}<span class="p-role${p.role === "admin" ? " is-admin" : ""}">${p.role === "admin" ? "Admin" : "Member"}</span><span class="p-groups">${groups.length === 0 ? '<span class="p-none">No groups</span>' : groups.join("")}</span><span class="p-exc">${exceptions}</span>${icon("chevronDown")}</summary>
<div class="more-of"><div class="setting"><div><b>Role</b></div>${role}</div>
<div><h3>Exceptions</h3></div>${settings}${remove}</div></details>`
}

const scimPath = (path: string) => {
  const [route = "", query] = path.split("?")

  const plain =
    query === undefined
      ? route
      : `${route}?${[...new URLSearchParams(query)].map(([k, v]) => `${k}=${v}`).join("&")}`

  return plain.length > 90 ? `${plain.slice(0, 90)}...` : plain
}

const scimAsked = (
  r: WorkspaceData["scim"]["recent"][number],
  nameOf: (emailOrId: string) => string,
) => {
  const ok = r.status < 400
  const [route = "", query = ""] = r.path.split("?")
  const filtered = /"([^"]+)"/.exec(new URLSearchParams(query).get("filter") ?? "")?.[1]
  const [, kind, id] = /^\/(Users|Groups)(?:\/([^/]+))?$/.exec(route) ?? []
  const added = ok && r.method === "POST" ? /\S+@\S+/.exec(r.note)?.[0] : undefined
  const key = id ?? filtered ?? added

  const one =
    kind === "Users"
      ? key === undefined
        ? "someone"
        : nameOf(key)
      : key === undefined
        ? "a group"
        : `the group ${key}`

  const [done, tried] =
    kind === undefined
      ? ["Checked the connection", "Couldn't check the connection"]
      : r.method === "GET"
        ? key === undefined
          ? kind === "Users"
            ? ["Listed everyone", "Couldn't list everyone"]
            : ["Listed the groups", "Couldn't list the groups"]
          : [`Looked up ${one}`, `Couldn't look up ${one}`]
        : r.method === "POST"
          ? [`Added ${one}`, `Couldn't add ${one}`]
          : r.method === "DELETE" || r.note.startsWith("deactivated ")
            ? [`Removed ${one}`, `Couldn't remove ${one}`]
            : [`Changed ${one}`, `Couldn't change ${one}`]

  return ok ? done : tried
}

/** What a directory's refused request means to the admin who has to fix it there. */
const scimSaid = (note: string) => {
  const got = /userName must be the person's email.*\(got "([^"]*)"\)/.exec(note)?.[1]

  return got === undefined
    ? sentence(note.replace(/^(refused|\d{3}): /, "")).replace(/[^.]$/, "$&.")
    : `Your directory sent "${got}" as the username. Set the app's username to the person's email there.`
}

const peoplePage = (
  workspace: string,
  origin: string,
  data: WorkspaceData,
  formToken: string,
  notice: Notice | null,
) => {
  const domain = data.people.find((p) => p.id === data.me)?.email.split("@")[1] ?? "example.com"

  const invite = form(
    "people/invite",
    formToken,
    {},
    `<label class="field grow">Email<input class="input" type="email" name="email" required autocomplete="off" placeholder="name@${escape(domain)}"></label><label class="field">Role<span class="select"><select class="input" name="role"><option value="member">Member</option><option value="admin">Admin</option></select>${icon("chevronDown")}</span></label><button class="btn btn-primary" type="submit">${icon("plus")}Invite</button>`,
    "make",
  )

  const joining = form(
    "joining",
    formToken,
    {},
    `<span class="select"><select class="input" name="joining" aria-label="Who can join" data-save><option value="open"${data.joining === "open" ? " selected" : ""}>Anyone the front door lets in, on their first visit</option><option value="invite"${data.joining === "invite" ? " selected" : ""}>Only people invited here</option></select>${icon("chevronDown")}</span><button class="btn btn-secondary save" type="submit">Save</button>`,
  )

  const rename = form(
    "rename",
    formToken,
    {},
    `<label class="field grow">Name<input class="input" name="name" required autocomplete="off" maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="${escape(workspace)}" aria-label="Workspace name"></label><button class="btn btn-secondary" type="submit">Rename</button>`,
    "make",
  )

  const nameOf = (key: string) => {
    const p = data.people.find((x) => x.email === key || x.id === key)

    return p === undefined || p.name.trim() === "" ? key : p.name
  }

  const live = data.scim.tokens.filter((t) => t.revoked === null)

  const scimTokens =
    live.length === 0
      ? `<p class="muted">None yet. Make one for your directory, then paste it there with the base URL.</p>`
      : `<div class="list">${live
          .map(
            (t) =>
              `<div class="row" data-scim-token="${escape(t.id)}"><div class="about"><b>${escape(t.label === "" ? "No label" : t.label.charAt(0).toUpperCase() + t.label.slice(1))}</b><span class="small">Made ${escape(day(t.created))} by ${escape(nameOf(t.madeBy))} · ${t.lastUsed === null ? "never used" : `last used ${escape(ago(t.lastUsed))}`}</span></div>${form("scim/revoke", formToken, { id: t.id }, `<button class="btn btn-secondary" type="submit">Revoke</button>`, "")}</div>`,
          )
          .join("")}</div>`

  const scimMake = form(
    "scim/token",
    formToken,
    {},
    `<label class="field grow">Label<input class="input" name="label" maxlength="60" autocomplete="off" placeholder="Like Okta" aria-label="Label"></label><button class="btn btn-primary" type="submit">${icon("key")}Make a token</button>`,
    "make",
  )

  const scimRows = data.scim.recent
    .map((r) => {
      const ok = r.status < 400

      return `<div class="row" data-scim-request="${escape(r.trace)}"><span class="${ok ? "yes" : "nope"}">${icon(ok ? "check" : "alert")}</span><div class="about"><b>${escape(scimAsked(r, nameOf))}</b>${ok ? "" : `<span>${escape(scimSaid(r.note))}</span>`}<span class="small">${escape(ago(r.at))}</span></div></div>`
    })
    .join("")

  const scimTech = data.scim.recent
    .map(
      (r) =>
        `<li><code>${escape(r.method)} ${escape(scimPath(r.path))}</code> answered ${r.status} at ${escape(moment(r.at))} UTC · trace <code>${escape(r.trace)}</code></li>`,
    )
    .join("")

  const directory = `<section id="directory"><header>${headingHtml("h2", "Directory sync", sub('<a href="https://github.com/janedogco/openbelt/blob/main/docs/people.md#directory-sync-scim">Set it up</a>'))}</header>
<div class="field">Base URL${copyField(`${origin}/scim/v2`, "base URL")}</div>
${scimMake}
${scimTokens}</section>
${scimRows === "" ? "" : `<section id="directory-requests"><header><h2>Last requests from your directory</h2></header><div class="list kept">${scimRows}</div><details class="names tech"><summary>Technical details</summary><ol>${scimTech}</ol></details></section>`}`

  const body = `<div class="top"><div class="head head-act"><div><h1>People <span class="count">${data.people.length}</span></h1></div><a class="btn btn-primary" href="#invite">${icon("plus")}Invite someone</a></div>${saidHtml(notice, `${origin}/mcp`)}</div>
${
  data.asks.length === 0
    ? ""
    : `<section id="asks"><header>${headingHtml("h2", "Asked to join")}</header><div class="list">${data.asks
        .map(
          (email) =>
            `<div class="row"><div class="about"><b>${escape(email)}</b></div>${form("people/invite", formToken, { email, role: "member" }, `<button class="btn btn-primary" type="submit">Invite</button>`, "")}</div>`,
        )
        .join("")}</div></section>`
}
<section id="people">${data.people.length > 8 ? `<label class="find">${icon("search")}<input class="input" id="find" type="search" placeholder="Search people and groups" autocomplete="off" aria-label="Search people"></label>` : ""}<div class="list ppl"><div class="ppl-cols" aria-hidden="true"><span>Person</span><span>Role</span><span>Groups</span><span>Exceptions</span><span></span></div>${data.people.map((p) => personRow(p, data, formToken)).join("")}</div><p class="small" id="none" hidden>Nobody matches.</p></section>
<section id="invite"><header>${headingHtml("h2", "Invite someone", sub(`They're in once they open ${escape(workspace)}, signed in as that email.`))}</header>${invite}</section>
<section id="joining"><header><h2>Who can join</h2></header>${joining}</section>
<section id="name"><header><h2>Workspace name</h2></header>${rename}</section>
${directory}`

  return shell(workspace, "admin", "people", body, undefined, FIND_SCRIPT)
}

const groupsPage = (
  workspace: string,
  data: WorkspaceData,
  formToken: string,
  notice: Notice | null,
) => {
  const create = form(
    "groups/create",
    formToken,
    {},
    `<label class="field grow">Name<input class="input" name="name" required maxlength="40" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?" title="Lowercase letters, digits and dashes, like support" autocomplete="off" placeholder="support"></label><button class="btn btn-primary" type="submit">${icon("plus")}New group</button>`,
    "make",
  )

  const rows = data.groups
    .map((g) => {
      const members = data.people.filter((p) => p.groups.includes(g.name))

      const set = Map.groupBy(
        data.connections.filter((c) => c.groups[g.name] !== undefined),
        (c) => c.groups[g.name] ?? "none",
      )

      const parts = (["all", "read", "none"] as const).flatMap((level) => {
        const n = (set.get(level) ?? []).length

        return n === 0 ? [] : [[LEVEL_WORD[level], n] as const]
      })

      const [only] = parts

      const rules =
        parts.length === 1 && only !== undefined
          ? `${only[0]} for ${only[1]} ${only[1] === 1 ? "connection" : "connections"}`
          : parts.map(([word, n]) => `${word}: ${n}`).join(" · ")

      return `<a class="group" href="/_settings/groups/${encodeURIComponent(g.name)}" data-group="${escape(g.name)}"><div><b>${escape(g.name)}${g.source === "scim" ? `<span class="badge">${icon("lock")}From your directory</span>` : ""}</b><span class="small">${escape(rules === "" ? "Workspace default" : rules)}</span></div><span class="stack">${members
        .slice(0, 5)
        .map((p) => avatar(p, true))
        .join(
          "",
        )}</span><span class="small">${members.length === 1 ? "1 person" : `${members.length} people`}</span>${icon("chevronRight")}</a>`
    })
    .join("")

  const body = `<div class="top"><div class="head head-act"><div>${headingHtml("h1", "Groups")}</div>${data.groups.length === 0 ? "" : `<button class="btn btn-primary" type="button" data-open="new-group">${icon("plus")}New group</button>`}</div>${saidHtml(notice, "")}</div>
${
  data.groups.length === 0
    ? `<section id="groups" class="empty page">${tiles(icon("users"))}<b>No groups yet</b><p>Put people in a group, like eng or contractors, and set what they can use together.</p>${create}</section>`
    : `<section id="groups"><div class="list">${rows}</div></section>
<dialog class="card made overlay" id="new-group" aria-labelledby="new-group-title"><header><h2 id="new-group-title">New group</h2></header>${form(
        "groups/create",
        formToken,
        {},
        `<label class="field">Name<input class="input" name="name" required maxlength="40" pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?" title="Lowercase letters, digits and dashes, like design" autocomplete="off" placeholder="Like design"></label><div class="actions"><button class="btn btn-ghost" type="submit" formmethod="dialog" formnovalidate>Cancel</button><button class="btn btn-primary" type="submit">Make group</button></div>`,
        "make-group",
      )}</dialog>`
}`

  return shell(workspace, "admin", "groups", body)
}

const WHOSE: Readonly<Record<CredentialOwner, string>> = {
  none: "No sign-in",
  person: "Personal accounts",
  workspace: "Shared account",
  both: "Shared or personal accounts",
}

const CAN: Readonly<Record<Level, string>> = {
  none: "off by default",
  read: "read only",
  all: "read and change",
}

const crumbs = (trail: ReadonlyArray<readonly [string, string | null]>) =>
  `<nav class="crumbs" aria-label="Breadcrumbs">${trail
    .map(([name, href]) =>
      href === null
        ? `<span aria-current="page">${escape(name)}</span>`
        : `<a href="${escape(href)}">${escape(name)}</a>`,
    )
    .join(icon("chevronRight"))}</nav>`

const choices = (
  name: string,
  label: string,
  options: ReadonlyArray<readonly [value: string, title: string, sub?: string]>,
  chosen: string,
) =>
  `<fieldset class="field"><legend>${escape(label)}</legend><div class="choices">${options
    .map(
      ([value, title, line]) =>
        `<label><input type="radio" name="${escape(name)}" value="${escape(value)}"${value === chosen ? " checked" : ""}><span><b>${escape(title)}</b>${line === undefined ? "" : `<span>${escape(line)}</span>`}</span></label>`,
    )
    .join("")}</div></fieldset>`

const levelChoices = (chosen: string) =>
  choices(
    "everyone",
    "What people can do",
    [
      ["read", "Read only"],
      ["all", "Read and change"],
    ],
    chosen,
  )

const workspaceConnectionsPage = (
  workspace: string,
  data: WorkspaceData,
  notice: Notice | null,
) => {
  const people = data.people.length

  const stateOf = (c: WorkspaceData["connections"][number]) => {
    const { status } = c

    if (status.problem !== null) return { word: "Not working", tone: "error" }

    if (c.credential === "none") return { word: "Ready", tone: "success" }

    if (status.needsApp) return { word: "Needs setup", tone: "error" }

    if (status.workspaceSignIn === "stopped")
      return { word: "Workspace sign-in stopped", tone: "error" }

    if (status.workspaceSignIn === "missing" && c.credential === "workspace")
      return { word: "Not connected", tone: "muted" }

    if (c.credential === "workspace" || status.workspaceSignIn === "set")
      return { word: "Ready", tone: "success" }

    return {
      word: `${status.connected} of ${people} connected`,
      tone: status.connected === 0 ? "muted" : "success",
    }
  }

  const rows = data.connections
    .toSorted(
      (a, b) =>
        Number(b.status.problem !== null) - Number(a.status.problem !== null) ||
        connectionLabel(a.connection).localeCompare(connectionLabel(b.connection)),
    )
    .map((c) => {
      const label = connectionLabel(c.connection)
      const state = stateOf(c)

      return `<a class="crow" href="/_connections/${encodeURIComponent(c.connection)}" data-connection="${escape(c.connection)}">${markOf(c, label, data.icons[c.connection])}<span class="name"><b>${escape(label)}</b><small>${escape(`${WHOSE[c.credential]} · ${CAN[c.everyone]}`)}</small></span>${state === null ? "" : `<span class="state is-${state.tone}">${escape(state.word)}</span>`}${icon("chevronRight")}</a>`
    })
    .join("")

  const failing = data.connections.filter((c) => c.status.problem !== null)

  const body = `<div class="top"><div class="head head-act"><div><h1>Connections</h1></div><div class="actions"><a class="btn btn-secondary" href="/_settings/events/requests">Access requests</a><a class="btn btn-primary" href="/_settings/connections/add">${icon("plus")}Add a connection</a></div></div>${saidHtml(notice, "")}${
    failing.length === 0
      ? ""
      : noticeHtml(
          false,
          `<p>${and(failing.map((c) => `<a href="/_connections/${encodeURIComponent(c.connection)}">${escape(connectionLabel(c.connection))}</a>`))} ${failing.length === 1 ? "isn't" : "aren't"} working.</p>`,
          "broken",
        )
  }</div>
${data.connections.length === 0 ? `<section id="connections" class="empty page">${tiles(icon("plug"))}<b>No connections yet</b><p>Add GitHub, Linear or another tool, and your apps and agents can use it.</p><a class="btn btn-secondary" href="/_settings/connections/add">Browse the catalog</a></section>` : `<section id="connections"><div class="rows">${rows}</div></section>`}`

  return shell(workspace, "admin", "connections", body)
}

const catalogPage = (workspace: string, data: WorkspaceData) => {
  const added = new Set(data.connections.map((c) => c.connection))

  const row = (p: Provider, group = "") => {
    const there = added.has(p.id)
    const href = there ? `/_connections/${p.id}` : `/_settings/connections/add/${p.id}`

    return `<a class="crow" href="${escape(href)}" data-provider="${escape(p.id)}" data-find="${escape(`${p.name} ${p.maker ?? ""} ${group} ${p.about} ${p.id}`.toLowerCase())}">${markOf({ connection: p.id, provider: p.id }, p.name, undefined)}<span class="name"><b>${escape(p.name)}</b><small>${escape(p.about)}</small></span>${there ? `<span class="state is-success">Added</span>` : ""}${icon("chevronRight")}</a>`
  }

  const byMaker = Map.groupBy(CATALOG, (p) => p.maker ?? p.name)

  const entries = [...byMaker.entries()].map(([maker, providers]) => {
    const [only] = providers

    return providers.length === 1 && only !== undefined
      ? { name: only.name, html: row(only) }
      : {
          name: SUITES.get(maker) ?? maker,
          html: `<div class="cgroup"><h3>${escape(SUITES.get(maker) ?? maker)}</h3>${providers
            .toSorted((a, b) =>
              a.name.replace(`${maker} `, "").localeCompare(b.name.replace(`${maker} `, "")),
            )
            .map((p) => row(p, SUITES.get(maker) ?? maker))
            .join("")}</div>`,
        }
  })

  const rows = entries
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((e) => e.html)
    .join("")

  const body = `<div class="top">${crumbs([
    ["Connections", "/_settings/connections"],
    ["Add a connection", null],
  ])}<div class="head"><h1>Add a connection</h1></div></div>
<section id="catalog"><label class="find">${icon("search")}<input class="input" id="find" type="search" placeholder="Search ${CATALOG.length} services" autocomplete="off" aria-label="Search services"></label>
<div class="rows">${rows}</div>
<p class="small" id="none" hidden>Nothing in the catalog matches.</p>
<p class="small">Not here? <a href="/_settings/connections/address">Add one by its address</a>.</p></section>`

  return shell(workspace, "admin", "connections", body, "/_settings/connections/add", FIND_SCRIPT)
}

const SUITES = new Map([["Google", "Google Workspace"]])

const providerPage = (
  workspace: string,
  origin: string,
  data: WorkspaceData,
  p: Provider,
  formToken: string,
  notice: Notice | null,
  fields: Readonly<Record<string, string>>,
) => {
  const taken = data.connections.some((c) => c.connection === p.id)
  const name = fields["name"] ?? (taken ? `${p.id}-2` : p.id)
  const maker = p.maker ?? p.name

  const whose =
    p.signIn === "none"
      ? ""
      : choices(
          "credential",
          `Whose ${maker} account`,
          [
            [
              "person",
              "Each person connects their own",
              `Agents and apps see what that person sees in ${maker}.`,
            ],
            [
              "workspace",
              "One account for everyone",
              "An admin connects it once. Good for a shared bot account.",
            ],
          ],
          fields["credential"] ?? (p.credential === "workspace" ? "workspace" : "person"),
        )

  const registered = p.signIn === "oauth" && data.registered.includes(p.issuer.replace(/\/+$/, ""))

  const register =
    p.signIn !== "oauth" || p.registration.kind !== "admin"
      ? ""
      : registered
        ? `<p class="small">It uses the ${escape(maker)} OAuth app your workspace already set up.</p>`
        : `<section class="setup"><header>${headingHtml("h2", `Register an OAuth app at ${escape(maker)}`, sub("Once per workspace. You can also do it later, on its page."))}</header>
${appSteps(origin, p)}
${clientFields(fields["clientId"] ?? "")}</section>`

  const named = taken || name !== p.id

  const nameField = named
    ? `<label class="field">Name<input class="input" name="name" required maxlength="30" pattern="[a-z][a-z0-9\\-]*" value="${escape(name)}" autocomplete="off" spellcheck="false">${taken ? `<span class="small">${escape(p.name)} is already added as ${escape(p.id)}. Add it again under another name, for a second account or workspace.</span>` : ""}</label>`
    : ""

  const inner = `${nameField}${whose}${levelChoices(fields["everyone"] ?? p.level)}${register}<div class="actions"><button class="btn btn-primary" type="submit">Add ${escape(p.name)}</button><a class="btn btn-secondary" href="/_settings/connections/add">Cancel</a></div>`

  const body = `<div class="top">${crumbs([
    ["Connections", "/_settings/connections"],
    ["Add a connection", "/_settings/connections/add"],
    [p.name, null],
  ])}<div class="head">${headingHtml("h1", `Add ${escape(p.name)}`, p.note === undefined || (p.signIn === "oauth" && PREVIEW_PROGRAM.has(p.issuer)) ? null : sub(escape(p.note)))}</div>${saidHtml(notice, "")}</div>
${form("connections/add", formToken, named ? { provider: p.id } : { provider: p.id, name, c: name }, inner, "addform")}`

  return shell(workspace, "admin", "connections", body, `/_settings/connections/add/${p.id}`)
}

const addressPage = (
  workspace: string,
  formToken: string,
  notice: Notice | null,
  fields: Readonly<Record<string, string>>,
) => {
  const inner = `<label class="field">Name<input class="input" name="name" required maxlength="30" pattern="[a-z][a-z0-9\\-]*" title="Lowercase letters, digits and dashes, starting with a letter" placeholder="team-wiki" value="${escape(fields["name"] ?? "")}" autocomplete="off" spellcheck="false"></label>
<label class="field">MCP address<input class="input" name="url" type="url" required placeholder="https://mcp.example.com/mcp" value="${escape(fields["url"] ?? "")}" autocomplete="off" spellcheck="false"></label>
${choices(
  "credential",
  "Whose account",
  [
    [
      "person",
      "Each person connects their own",
      "OpenBelt finds out whether it signs in or takes a token.",
    ],
    ["workspace", "One account for everyone", "An admin connects it, or sets its token, once."],
    ["none", "No account", "The server takes no sign-in."],
  ],
  fields["credential"] ?? "person",
)}${levelChoices(fields["everyone"] ?? "read")}<div class="actions"><button class="btn btn-primary" type="submit">Add</button><a class="btn btn-secondary" href="/_settings/connections/add">Cancel</a></div>`

  const body = `<div class="top">${crumbs([
    ["Connections", "/_settings/connections"],
    ["Add a connection", "/_settings/connections/add"],
    ["By address", null],
  ])}<div class="head"><h1>Add by address</h1></div>${saidHtml(notice, "")}</div>
${form("connections/add", formToken, {}, inner, "addform")}`

  return shell(workspace, "admin", "connections", body, "/_settings/connections/address")
}

export const workspaceSettingsPage = (
  workspace: string,
  origin: string,
  data: WorkspaceData,
  page: Exclude<WorkspacePage, { readonly kind: "events" | "requests" }>,
  formToken: string,
  notice: Notice | null,
  fields: Readonly<Record<string, string>>,
): { readonly html: string; readonly status: number } =>
  Match.value(page).pipe(
    Match.discriminatorsExhaustive("kind")({
      people: () => ({ html: peoplePage(workspace, origin, data, formToken, notice), status: 200 }),
      groups: () => ({ html: groupsPage(workspace, data, formToken, notice), status: 200 }),
      group: ({ name }) => ({
        html: groupPage(workspace, data, name, formToken, notice),
        status: data.groups.some((g) => g.name === name) ? 200 : 404,
      }),
      connections: () => ({ html: workspaceConnectionsPage(workspace, data, notice), status: 200 }),
      catalog: () => ({ html: catalogPage(workspace, data), status: 200 }),
      address: () => ({ html: addressPage(workspace, formToken, notice, fields), status: 200 }),
      provider: ({ id }) => {
        const p = providerById(id)

        return p === undefined
          ? { html: catalogPage(workspace, data), status: 404 }
          : {
              html: providerPage(workspace, origin, data, p, formToken, notice, fields),
              status: 200,
            }
      },
    }),
  )

const groupPage = (
  workspace: string,
  data: WorkspaceData,
  name: string,
  formToken: string,
  notice: Notice | null,
) => {
  const back = crumbs([
    ["Groups", "/_settings/groups"],
    [name, null],
  ])

  const group = data.groups.find((g) => g.name === name)

  if (group === undefined)
    return shell(
      workspace,
      "admin",
      "groups",
      `<div class="top">${back}<div class="head">${headingHtml("h1", `No group ${escape(name)}`, sub(`${escape(workspace)} has no group of that name: it may have been deleted.`))}</div>${saidHtml(notice, "")}</div>`,
      `/_settings/groups/${name}`,
    )

  const synced = group.source === "scim"
  const members = data.people.filter((p) => p.groups.includes(name))
  const others = data.people.filter((p) => !p.groups.includes(name))

  const levelRow = (c: WorkspaceData["connections"][number]) => {
    const label = connectionLabel(c.connection)
    const setting = c.groups[name] ?? c.everyone

    return `<div class="setting" data-connection="${escape(c.connection)}" data-level="${setting}"><div class="conn">${markOf({ connection: c.connection }, label, undefined)}<div><b>${escape(label)}</b>${differLine(members, c.result, setting)}</div></div>${form("access", formToken, { connection: c.connection, who: `group:${name}` }, levelSelect(`${name} on ${label}`, c.groups[name] ?? "", `Workspace default (${LEVEL_WORD[c.everyone].toLowerCase()})`), "")}</div>`
  }

  const own = data.connections.filter((c) => c.groups[name] !== undefined)

  const rest = data.connections.filter((c) => c.groups[name] === undefined)

  const tally = (["all", "read", "none"] as const)
    .flatMap((level) => {
      const n = own.filter((c) => c.groups[name] === level).length

      return n === 0
        ? []
        : [`<span class="lvl is-${level}">${n} ${LEVEL_WORD[level].toLowerCase()}</span>`]
    })
    .join("")

  const levels =
    data.connections.length === 0
      ? `<p class="muted">${escape(workspace)} has no connections yet, so there's nothing to set.</p>`
      : `${own.length === 0 ? `<p class="muted">Nothing set: it gets the workspace default on every connection.</p>` : `<div class="list">${own.map(levelRow).join("")}</div>`}${
          rest.length === 0
            ? ""
            : `<details class="names others"><summary><b>${rest.length} more on the workspace default</b>${icon("chevronRight")}</summary><div class="list">${rest.map(levelRow).join("")}</div></details>`
        }`

  const memberRows = members
    .map(
      (p) =>
        `<div class="member" data-person="${escape(p.email)}">${whoHtml(p, data.me).replace('<span class="who">', `<span class="who">${avatar(p)}`)}${synced ? "" : form("groups/remove", formToken, { group: name, person: p.email }, `<button class="btn btn-ghost btn-square" type="submit" aria-label="Take ${escape(p.email)} out of ${escape(name)}" title="Remove from ${escape(name)}">${icon("x")}</button>`, "")}</div>`,
    )
    .join("")

  const add =
    synced || others.length === 0
      ? ""
      : `<div>${form(
          "groups/add",
          formToken,
          { group: name },
          `<span class="select"><select class="input" name="person" aria-label="Who to add to ${escape(name)}" required data-save><option value="" selected disabled>Add someone</option>${others.map((p) => `<option value="${escape(p.email)}">${escape(p.name)} · ${escape(p.email)}</option>`).join("")}</select>${icon("chevronDown")}</span><button class="btn btn-secondary save" type="submit">${icon("plus")}Add</button>`,
          "add",
        )}</div>`

  const memberList =
    memberRows === "" && add === ""
      ? `<p class="muted">Nobody yet.</p>`
      : `<div class="list">${memberRows === "" ? `<p class="muted">Nobody yet.</p>` : memberRows}${add}</div>`

  const remove = synced
    ? ""
    : `<div id="delete">${confirmed(
        "Delete group",
        `Deleting ${name} takes ${members.length === 1 ? "its 1 person" : `its ${members.length} people`} out of it and drops its levels; their access goes back to the rest of their settings.`,
        form(
          "groups/delete",
          formToken,
          { name },
          `<!--warning--><button class="btn btn-secondary btn-danger" type="submit">Delete ${escape(name)}</button>`,
          "",
        ),
      )}</div>`

  const body = `<div class="top">${back}<div class="head head-act"><div>${headingHtml("h1", `${escape(name)} <span class="count">${members.length}</span>${synced ? `<span class="badge">${icon("lock")}From your directory</span>` : ""}`, synced ? sub("Your directory decides who's in it; you decide what it can use.") : null)}</div>${remove}</div>${saidHtml(notice, "")}</div>
<section id="levels"><header class="sect"><h2>What it can use</h2><span class="lvls">${tally}</span></header>${levels}</section>
<section id="members"><header class="sect"><h2>Members <span class="count">${members.length}</span></h2></header>${memberList}</section>`

  return shell(workspace, "admin", "groups", body, `/_settings/groups/${name}`)
}

const support = (trace: string, detail = "") =>
  `<details class="trace"><summary>Technical details</summary>${detail === "" ? "" : `<p>${escape(detail)}</p>`}<p>Trace ${escape(trace)}</p></details>`

export const deniedPage = (
  workspace: string,
  title: string,
  message: string,
  trace: string,
  person: Person,
) =>
  shell(
    workspace,
    person === null ? "none" : "member",
    "",
    `<div class="head denied">${headingHtml("h1", escape(title), sub(escape(message)), { cls: "lead" })}${support(trace)}</div>`,
  )

const EVENTS_SCRIPT = `
const filters = [...document.querySelectorAll('.event-filter')];
for (const filter of filters) {
  const input = filter.querySelector('input');
  const values = [...filter.querySelectorAll('.event-values a')];
  const count = filter.querySelector('[data-filter-count]');
  const narrow = () => {
    const q = input.value.trim().toLowerCase();
    let matches = 0;
    for (const value of values) {
      const match = value.textContent.toLowerCase().includes(q);
      value.hidden = !match || matches >= 40;
      if (match) matches++;
    }
    count.textContent = matches === 0 ? 'No matching values' : matches > 40 ? 'Showing 40 of ' + matches + '. Type to narrow the list.' : matches + (matches === 1 ? ' value' : ' values');
  };
  input.addEventListener('input', narrow);
  filter.addEventListener('toggle', () => {
    if (!filter.open) return;
    for (const other of filters) if (other !== filter) other.open = false;
    const picker = filter.querySelector('.event-picker');
    picker.classList.remove('is-end');
    if (picker.getBoundingClientRect().right > document.documentElement.clientWidth - 16) picker.classList.add('is-end');
    input.value = '';
    narrow();
    input.focus();
  });
  narrow();
}
document.addEventListener('click', e => {
  for (const filter of filters) if (!filter.contains(e.target)) filter.open = false;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') for (const filter of filters) {
    if (filter.open) {
      filter.open = false;
      filter.querySelector('summary').focus();
    }
  }
});
`

const emailInitials = (who: string) =>
  (who.split("@")[0] ?? "")
    .split(/[. _-]+/)
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase()

const eventTabs = (on: "events" | "requests") =>
  `<nav class="tabs" aria-label="Events">${(
    [
      ["events", "/_settings/events", "Events"],
      ["requests", "/_settings/events/requests", "Access requests"],
    ] as const
  )
    .map(
      ([key, href, text]) =>
        `<a href="${href}"${key === on ? ' aria-current="page"' : ""}>${text}</a>`,
    )
    .join("")}</nav>`

export const eventsPage = (workspace: string, data: EventsData, notice: Notice | null) => {
  const { shown } = data

  const href = (page: number) =>
    `/_settings/events?${new URLSearchParams({ ...shown, page: String(page) }).toString()}`

  const fields = [
    {
      name: "person",
      label: "Person",
      glyph: "users",
      values: data.people.map((value) => [value, value] as const),
    },
    {
      name: "tool",
      label: "Tool",
      glyph: "settings",
      values: data.tools.map((value) => [value, value] as const),
    },
    {
      name: "app",
      label: "App",
      glyph: "grid",
      values: data.apps.map((value) => [value, value] as const),
    },
    {
      name: "outcome",
      label: "Result",
      glyph: "circleCheck",
      values: [
        ["ok", "Success"],
        ["errors", "Errors"],
        ["refused", "Refused"],
      ],
    },
    {
      name: "source",
      label: "Source",
      glyph: "plug",
      values: [
        ["tools", "OpenBelt tools"],
        ["connections", "Connections"],
      ],
    },
  ] as const

  const filterHref = (name: (typeof fields)[number]["name"], value: string) =>
    `/_settings/events?${new URLSearchParams({ ...shown, [name]: value, page: "0" }).toString()}`

  const pickers = fields
    .map(({ name, label, glyph, values }) => {
      const options = [
        ...new Map([
          ...values,
          ...(shown[name] === "" || shown[name] === "all"
            ? []
            : [
                [
                  shown[name],
                  values.find(([value]) => value === shown[name])?.[1] ?? shown[name],
                ] as const,
              ]),
        ]).entries(),
      ]
        .filter(([value]) => value !== "")
        .toSorted((a, b) => a[1].localeCompare(b[1]))

      return `<details class="event-filter" data-filter="${name}"><summary class="btn btn-secondary">${icon(glyph)}${label}</summary><div class="event-picker"><label class="visually-hidden" for="filter-${name}">Search ${label.toLowerCase()}</label><input class="input" id="filter-${name}" type="search" placeholder="Search ${label.toLowerCase()}…" autocomplete="off"><div class="event-values">${options.map(([value, text]) => `<a href="${escape(filterHref(name, value))}"${shown[name] === value ? ' aria-current="true"' : ""}>${escape(text)}</a>`).join("")}</div><span class="small" data-filter-count></span></div></details>`
    })
    .join("")

  const chips = fields
    .flatMap(({ name, label, values }) => {
      if (shown[name] === "" || shown[name] === "all") return []

      const selectedLabel = values.find(([value]) => value === shown[name])?.[1] ?? shown[name]

      return `<a class="btn btn-secondary event-chip" href="${escape(filterHref(name, name === "source" || name === "outcome" ? "all" : ""))}" aria-label="Remove ${label} ${escape(selectedLabel)}"><span class="muted">${label}</span>${escape(selectedLabel)}${icon("x")}</a>`
    })
    .join("")

  const rows = data.events
    .map((event) => {
      const ok = event.outcome === "ok"
      const refused = event.outcome === "refused"

      const state = ok
        ? "Success"
        : refused
          ? "Refused"
          : event.outcome === "invalid"
            ? "Invalid"
            : event.outcome === "defect"
              ? "Internal error"
              : "Failed"

      const letters = emailInitials(event.person)

      const tool = event.source === "tools"
      const via = tool ? event.client || "Unknown client" : "Connection call"

      const duration =
        event.ms >= 1000
          ? `${(event.ms / 1000).toFixed(1)} s`
          : `${event.ms.toLocaleString("en-US")} ms`

      return `<li class="event" data-trace="${escape(event.trace)}"><details><summary><span class="event-action" title="${tool ? "OpenBelt tool" : "Connection call"}">${icon(tool ? "bot" : "plug")}<code>${escape(event.tool)}</code>${event.app === "" ? "" : `<span class="event-app">${escape(event.app)}</span>`}</span><span class="event-person" data-ms="${escape(duration)}"><span class="event-avatar" aria-hidden="true">${escape(letters)}</span><span>${escape(event.person)}</span></span><span class="event-client">${escape(via)}</span><span class="state ${ok ? "is-success" : refused ? "is-warning" : "is-error"}">${state}</span><span class="event-duration num${event.ms >= 1000 ? " is-slow" : ""}">${duration}</span><time class="event-when num" datetime="${escape(event.at)}" title="${escape(moment(event.at))}">${escape(since(event.at))}</time>${icon("chevronDown")}</summary><div class="event-detail"><dl><div><dt>Person</dt><dd>${escape(event.person)}</dd></div>${tool ? `<div><dt>Client</dt><dd>${escape(via)}</dd></div>` : event.client === "" ? "" : `<div><dt>Runs as</dt><dd>${escape(event.client)}</dd></div>`}${event.app === "" ? "" : `<div><dt>App</dt><dd>${escape(event.app)}</dd></div>`}<div><dt>When</dt><dd>${escape(moment(event.at))}</dd></div><div><dt>Duration</dt><dd><span>${event.ms.toLocaleString("en-US")} ms</span></dd></div><div><dt>Trace</dt><dd><code>${escape(event.trace)}</code></dd></div></dl>${event.error === "" ? "" : `<div class="is-error"><h3>Reason</h3><pre>${escape(event.error)}</pre></div>`}${event.args === "" ? "" : `<div><h3>Arguments</h3><pre>${escape(event.args)}</pre></div>`}</div></details></li>`
    })
    .join("")

  const body = `<div class="top"><div class="head head-act"><h1>Events</h1><div class="actions"><a class="btn btn-secondary" href="${escape(href(shown.page))}">Refresh</a></div></div>${eventTabs("events")}${saidHtml(notice, "")}</div>
<div class="event-controls"><div class="event-bar"><form class="event-search" method="get" action="/_settings/events">${icon("search")}<label class="visually-hidden" for="event-query">Search events</label><input class="input" id="event-query" type="search" name="q" value="${escape(shown.q)}" placeholder="Search tools, people, apps…" aria-label="Search events">${fields.map(({ name }) => `<input type="hidden" name="${name}" value="${escape(shown[name])}">`).join("")}</form><div class="event-shortcuts">${pickers}</div><span class="event-count">${data.total.toLocaleString("en-US")} matching ${data.total === 1 ? "event" : "events"}</span></div><div class="event-chips">${chips}${chips === "" && shown.q === "" ? "" : '<a class="btn btn-ghost" href="/_settings/events">Clear</a>'}</div></div>
<section class="event-feed" aria-label="Events">${rows === "" ? `<div class="event-empty">${headingHtml("h2", data.retained === 0 ? "No events yet" : "No matching events", data.retained === 0 ? sub("Ask your agent to call an OpenBelt tool, then refresh.") : sub("Try another search or clear the filters."))}</div>` : `<div class="event-cols" aria-hidden="true"><span>Event</span><span>Person</span><span>Client</span><span>Result</span><span class="num">Duration</span><span class="num">When</span><span></span></div><ol class="event-list">${rows}</ol>`}<div class="event-footer"><span class="small">${data.total === 0 ? "0" : `${(shown.page * 50 + 1).toLocaleString("en-US")}–${Math.min((shown.page + 1) * 50, data.total).toLocaleString("en-US")}`} of ${data.total.toLocaleString("en-US")}</span><div class="actions">${shown.page === 0 ? "" : `<a class="btn btn-secondary" href="${escape(href(shown.page - 1))}">Previous</a>`}${(shown.page + 1) * 50 >= data.total ? "" : `<a class="btn btn-secondary" href="${escape(href(shown.page + 1))}">Next</a>`}</div></div></section>
`

  return shell(workspace, "admin", "events", body, href(shown.page), EVENTS_SCRIPT)
}

export const asksPage = (
  workspace: string,
  data: AsksData,
  formToken: string,
  notice: Notice | null,
) => {
  const card = (g: AsksData["groups"][number]) => {
    const back = { back: "requests" }
    const s = g.suggestion

    const whom =
      s === null
        ? ""
        : s.who === "everyone"
          ? "everyone"
          : `the ${s.who.slice("group:".length)} group`

    const key = `${g.connection}-${g.want}`

    const opens = (what: "who" | "others", text: string) =>
      `<a href="#${what}-${escape(key)}" data-opens="${what}-${escape(key)}" aria-controls="${what}-${escape(key)}" aria-expanded="false">${text}</a>`

    const others =
      s === null || s.others.length === 0
        ? ""
        : `<details class="names" id="others-${escape(key)}"><summary>Who else it changes</summary><div class="faces">${s.others
            .slice(0, 12)
            .map((e) => `<span class="face">${escape(e)}</span>`)
            .join(
              "",
            )}${s.others.length > 12 ? `<span class="small">and ${s.others.length - 12} more</span>` : ""}</div></details>`

    const who = `<details class="names" id="who-${escape(key)}"><summary>See who</summary><div class="list">${g.asks
      .map(
        (a) =>
          `<div class="row" data-asker="${escape(a.email)}"><div class="about"><b>${escape(a.name || a.email)}</b><span class="small">${escape(a.email)} · ${a.groups.length === 0 ? "no groups" : escape(a.groups.join(", "))} · ${escape(day(a.asked))}${a.note === "" ? "" : ` · "${escape(a.note)}"`}</span></div><div class="actions">${form("access", formToken, { ...back, connection: g.connection, who: `person:${a.email}`, level: g.want }, `<button class="btn btn-secondary" type="submit">Give</button>`, "")}${form("access/asks/close", formToken, { ...back, connection: g.connection, want: g.want, person: a.email }, `<button class="btn btn-ghost" type="submit">Not now</button>`, "")}</div></div>`,
      )
      .join("")}</div></details>`

    const shown = g.asks.map((a) => a.email).join(",")

    const setGroup = (kind: string) =>
      s === null
        ? ""
        : form(
            "access",
            formToken,
            { ...back, connection: g.connection, who: s.who, level: g.want },
            `<button class="btn ${kind}" type="submit">${s.who === "everyone" ? "Allow everyone" : `Allow ${escape(s.who.slice("group:".length))}`}</button>`,
            "",
          )

    const groupOption = (kind: string) =>
      s === null
        ? ""
        : `<div class="opt"><div class="about"><span><b>${escape(whom.charAt(0).toUpperCase() + whom.slice(1))}</b> <span class="small">${s.answered === g.asks.length ? `all ${g.asks.length} who asked` : `${s.answered} of the ${g.asks.length} who asked`}${s.others.length === 0 ? "" : ` + ${opens("others", `${s.others.length} who didn't`)}`}</span></span></div>${setGroup(kind)}</div>`

    const label = connectionLabel(g.connection)

    const latest =
      g.asks
        .map((a) => a.asked)
        .toSorted()
        .at(-1) ?? ""

    const named = g.asks.slice(0, 2).map((a) => escape(a.name || a.email))

    const askedBy =
      g.asks.length > 2 ? `${named.join(", ")} and ${g.asks.length - 2} more` : named.join(" and ")

    const faces = g.asks
      .slice(0, 3)
      .map(
        (a) => `<span class="req-face" aria-hidden="true">${escape(emailInitials(a.email))}</span>`,
      )
      .join("")

    return `<div class="req" data-asks="${escape(g.connection)}/${g.want}" data-find="${escape(`${label} ${g.connection} ${g.asks.map((a) => `${a.name} ${a.email}`).join(" ")}`.toLowerCase())}"><div class="req-row"><span class="req-conn">${markOf({ connection: g.connection }, label, undefined)}<b>${escape(label)}</b></span><span class="req-level is-${g.want}">${LEVEL_SAID[g.want]}</span><span class="req-who"><span class="req-faces">${faces}</span>${opens("who", askedBy)}</span><time class="req-when" datetime="${escape(latest)}">${escape(day(latest))}</time><div class="acts">${form("access/asks/grant", formToken, { ...back, connection: g.connection, want: g.want, people: shown }, `<button class="btn btn-secondary" type="submit" title="Give ${g.asks.length === 1 ? "them" : `all ${g.asks.length}`} ${LEVEL_SAID[g.want].toLowerCase()}">Allow</button>`, "")}${form("access/asks/close", formToken, { ...back, connection: g.connection, want: g.want, people: shown }, `<button class="btn btn-ghost btn-square" type="submit" aria-label="Not now" title="Not now">${icon("x")}</button>`, "")}</div></div>
${who.replace("</div></details>", `</div>${groupOption("btn-secondary")}${others}</details>`)}</div>`
  }

  const people = new Set(data.groups.flatMap((g) => g.asks.map((a) => a.email))).size

  const body = `<div class="top"><div class="head"><h1>Access requests</h1></div>${eventTabs("requests")}${saidHtml(notice, "")}</div>
${
  data.groups.length === 0
    ? `<section id="requests" class="empty page">${tiles(icon("inbox"))}<b>No requests</b><p>When someone asks for more access on a connection's page, it shows up here.</p></section>`
    : `<section id="requests">${data.groups.length > 12 ? `<label class="find">${icon("search")}<input class="input" id="find" type="search" placeholder="Search connections and people" autocomplete="off" aria-label="Search connections and people"></label>` : ""}
<div class="reqs"><div class="req-cols" aria-hidden="true"><span>Connection</span><span>Asks for</span><span>Asked by</span><span>Latest</span><span></span></div><div id="rows">${data.groups.map(card).join("")}</div><div class="req-foot small">${data.groups.length} ${data.groups.length === 1 ? "request" : "requests"} from ${people} ${people === 1 ? "person" : "people"}</div></div>
<p class="small" id="none" hidden>No request matches.</p></section>`
}`

  return shell(
    workspace,
    "admin",
    "events",
    body,
    "/_settings/events/requests",
    `${FIND_SCRIPT}\n${ASKS_SCRIPT}`,
  )
}

const ALONE = `
body { background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); }
.alone { box-sizing: border-box; max-width: 24rem; min-height: 100dvh; margin: 0 auto; padding: var(--openbelt-space-xl) var(--openbelt-space-md); display: grid; align-content: center; gap: var(--openbelt-space-xs); text-align: center; }
.alone h1 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
.alone .lead { color: var(--openbelt-color-muted); overflow-wrap: anywhere; }
.alone .small { margin-top: var(--openbelt-space-xs); color: var(--openbelt-color-muted); }
.alone .brand-logo { --logo-size: 32px; margin-inline: auto; margin-bottom: var(--openbelt-space-xl); color: var(--openbelt-color-primary); }
.alone .actions, .alone .choose { display: grid; gap: var(--openbelt-space-xs); margin-top: var(--openbelt-space-md); }
.alone .actions .btn, .alone .choose .btn, .alone > .btn { width: 100%; height: 40px; justify-content: center; }
.alone > .btn { margin-top: var(--openbelt-space-md); }
.alone .notice { text-align: left; }
/* Auth pages: fields and buttons share the small radius, panels the medium one; every line is a hairline. */
.alone .input, .alone .btn-secondary { border-width: 0.5px; }
.alone .trace { margin-top: var(--openbelt-space-xl); font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.alone .trace summary { width: max-content; margin: 0 auto; cursor: pointer; list-style: none; text-decoration: underline; text-underline-offset: 3px; }
.alone .trace summary::-webkit-details-marker { display: none; }
.alone .trace p { overflow-wrap: anywhere; }
.alone .trace p { margin-top: var(--openbelt-space-2xs); }
.alone .pair { display: flex; align-items: center; justify-content: center; gap: var(--openbelt-space-sm); margin-bottom: var(--openbelt-space-lg); }
.alone .pair > .mark, .alone .pair > .ntile { flex: none; width: 48px; height: 48px; border-radius: var(--openbelt-tile-radius); }
.alone .ntile { display: grid; place-items: center; font: 600 21px/1 var(--openbelt-font-body); }
.alone .pair-link { display: grid; color: var(--openbelt-color-muted); }
.alone .pair-link .icon { width: 18px; height: 18px; }
.alone .brand-logo.foot { --logo-size: 14px; margin: var(--openbelt-space-xl) auto 0; color: var(--openbelt-color-muted); }
`

const OUTCOME = `
.alone.outcome { gap: var(--openbelt-space-xs); }
.outcome .mark { width: 44px; height: 44px; margin: 0 auto var(--openbelt-space-sm); border-radius: 999px; display: grid; place-items: center; color: var(--openbelt-color-success); background: color-mix(in srgb, var(--openbelt-color-success) 16%, transparent); }
.outcome .mark.failed { color: var(--openbelt-color-error); background: color-mix(in srgb, var(--openbelt-color-error) 16%, transparent); }
.outcome .mark.neutral { color: var(--openbelt-color-muted); background: var(--openbelt-color-subtle); }
.outcome .mark svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; }
`

const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'

const WORDMARK = wordmarkSvg.trim().replace("<svg ", '<svg class="brand-logo" ')

const FOOT_LOGO = WORDMARK.replace('class="brand-logo"', 'class="brand-logo foot"')

/** An app's or agent's tile: its first letter on the colour its name gives it (colors.ts), as in the gallery. */
const nameTile = (name: string) =>
  `<span class="ntile" style="background:${colorOfName(name)};color:#fff" aria-hidden="true">${escape((/[a-z0-9]/i.exec(name)?.[0] ?? "?").toUpperCase())}</span>`

/** What asks and what it gets, side by side: the head of a consent page. */
const pairHtml = (asks: string, gets: string) =>
  `<div class="pair">${asks}<span class="pair-link" aria-hidden="true">${icon("arrowLeftRight")}</span>${gets}</div>`

export type InviteAsk = {
  readonly admins: ReadonlyArray<string>
  readonly subject: string
  readonly body: string
}

const mailto = (ask: InviteAsk) =>
  `mailto:${ask.admins.map(encodeURIComponent).join(",")}?subject=${encodeURIComponent(ask.subject)}&body=${encodeURIComponent(ask.body)}`

export const refusedPage = (
  title: string,
  message: string,
  trace: string,
  ask?: InviteAsk,
  go?: { readonly href: string; readonly text: string },
  detail = "",
) => {
  const action =
    go !== undefined
      ? `<p class="actions"><a class="btn btn-primary" href="${escape(go.href)}">${escape(go.text)}</a></p>`
      : ask === undefined || ask.admins.length === 0
        ? ""
        : `<p class="actions"><a class="btn btn-primary" href="${escape(mailto(ask))}">Email ${ask.admins.length === 1 ? escape(ask.admins[0] ?? "") : "the admins"}</a></p>`

  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escape(title)} · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${ALONE}${OUTCOME}</style>
</head>
<body>
<main class="alone outcome">${WORDMARK}<div class="mark neutral">${CROSS}</div>${headingHtml("h1", escape(title), sub(escape(message)), { cls: "lead" })}${action}${support(trace, detail)}</main>
</body>
</html>`
}

/** Where a flow ends, done or not, and the person goes back to whatever sent them (a terminal, an agent): a mark, one line, nothing to do here. */
export const outcomePage = (o: {
  readonly ok: boolean
  readonly title: string
  readonly message: string
}) => `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escape(o.title)} · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${ALONE}${OUTCOME}</style>
</head>
<body>
<main class="alone outcome">${WORDMARK}<div class="mark${o.ok ? "" : " failed"}">${o.ok ? icon("check").replace('class="icon" ', "") : CROSS}</div>${headingHtml("h1", escape(o.title), sub(escape(o.message)), { cls: "lead" })}</main>
</body>
</html>`

/** One decision on a page of its own (an app asking for a connection): no sidebar, the question and its buttons. */
const decisionPage = (title: string, body: string, path: string, lead: string) => `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escape(title)} · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${STYLE}${ALONE}
main.decide { max-width: 26rem; }
main.decide .ask { text-align: center; gap: var(--openbelt-space-sm); }
main.decide .appname { white-space: normal; overflow-wrap: anywhere; }
main.decide p.for { margin: var(--openbelt-space-2xs) 0 0; color: var(--openbelt-color-muted); overflow-wrap: anywhere; text-align: center; }
main.decide .pair .stack { display: flex; align-items: center; gap: var(--openbelt-space-xs); }
main.decide .pair .stack > .mark { width: 48px; height: 48px; border-radius: var(--openbelt-tile-radius); }
main.decide .pair .stack .more { font: var(--openbelt-type-label); color: var(--openbelt-color-muted); }
main.decide .accounts { margin-top: var(--openbelt-space-xs); text-align: left; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); }
main.decide .acct { display: flex; align-items: flex-start; gap: var(--openbelt-space-sm); padding: var(--openbelt-space-sm) var(--openbelt-space-md); }
main.decide .acct + .acct { border-top: 1px solid var(--openbelt-color-border); }
main.decide .acct > .mark { flex: none; }
main.decide .acct .who { flex: 1; min-width: 0; display: grid; gap: 2px; }
main.decide .acct .who b { font-weight: 600; }
main.decide .acct summary { list-style: none; display: inline-flex; align-items: center; gap: 2px; width: fit-content; cursor: pointer; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
main.decide .acct summary::-webkit-details-marker { display: none; }
main.decide .acct summary:hover { color: var(--openbelt-color-primary); }
main.decide .acct summary .icon { width: 14px; height: 14px; transition: transform var(--openbelt-duration) var(--openbelt-ease); }
main.decide .acct details[open] summary .icon { transform: rotate(180deg); }
main.decide .asked-tools { margin: var(--openbelt-space-2xs) 0 0; padding: 0; list-style: none; display: grid; gap: 2px; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); overflow-wrap: anywhere; }
main.decide .acct .state { flex: none; align-self: center; display: inline-flex; align-items: center; gap: 4px; color: var(--openbelt-color-muted); font: var(--openbelt-type-label); }
main.decide .acct .state .icon { width: 14px; height: 14px; }
main.decide .acct > form, main.decide .acct > .btn { flex: none; align-self: center; }
main.decide .ask .actions .btn:disabled { opacity: 0.4; cursor: default; }
main.decide .ask .when { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
main.decide .ask .actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--openbelt-space-sm); margin-top: var(--openbelt-space-xs); }
main.decide .ask .actions .btn { width: 100%; justify-content: center; height: 40px; }
main.decide h1 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
</style>
</head>
<body>
<main class="alone decide">${lead}${body}${FOOT_LOGO}</main>
<script>if (location.pathname + location.search !== ${JSON.stringify(path)}) history.replaceState(null, "", ${JSON.stringify(path)})</script>
</body>
</html>`

const isLoopback = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)

const CONSENT = `
.alone dl { display: grid; gap: var(--openbelt-space-sm); margin: var(--openbelt-space-sm) 0; padding: var(--openbelt-space-md); border: 0.5px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); }
.alone dl div { display: grid; gap: var(--openbelt-space-2xs); }
.alone dt { font: var(--openbelt-type-label); color: var(--openbelt-color-muted); }
.alone dl { text-align: left; }
.alone dd { margin: 0; overflow-wrap: anywhere; }
.alone dd .small { margin-left: var(--openbelt-space-2xs); }
.alone ul.can { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.alone ul.grants { margin: var(--openbelt-space-sm) 0 0; padding: var(--openbelt-space-sm) var(--openbelt-space-md); gap: var(--openbelt-space-xs); text-align: left; border: 0.5px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); }
.alone .choose.pair { grid-template-columns: 1fr 1fr; gap: var(--openbelt-space-sm); }
.alone ul.grants li { display: flex; align-items: center; gap: var(--openbelt-space-xs); }
.alone ul.grants .icon { flex: none; width: 15px; height: 15px; color: var(--openbelt-color-success); }
.alone dd .small { margin-left: 0; }
`

export type Consent = {
  readonly workspace: string
  readonly client: {
    readonly id: string
    readonly name: string
    readonly kind: "registered" | "document"
  }
  readonly redirectHost: string
  /** A device sign-in's code, to check against the terminal before allowing it. */
  readonly userCode: string | null
  readonly person: { readonly email: string; readonly name: string }
  readonly fields: Readonly<Record<string, string>>
  readonly formToken: string
}

export const consentPage = (c: Consent) => {
  const hidden = Object.entries({ ...c.fields, form: c.formToken })
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join("")

  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Sign in an agent · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${ALONE}${CONSENT}</style>
</head>
<body>
<main class="alone" id="consent">${WORDMARK}${headingHtml("h1", `${escape(c.client.name)} wants to access ${escape(c.workspace)}`, sub(`Signed in as ${escape(c.person.email)}`), { cls: "lead" })}
<ul class="can grants">${[`Build and change ${escape(c.workspace)}'s apps`, "Read and change their data", "Use the connections you have"].map((line) => `<li>${icon("check")}${line}</li>`).join("")}</ul>
<form method="post" action="/_oauth/authorize" class="choose pair">${hidden}<button class="btn btn-secondary" type="submit" name="decision" value="deny">Cancel</button><button class="btn btn-primary" type="submit" name="decision" value="allow">Allow</button></form>
${c.userCode !== null ? `<p class="small">Allow it only if your terminal shows <code>${escape(c.userCode)}</code></p>` : isLoopback(c.redirectHost) || c.redirectHost === DEVICE_HOST ? "" : `<p class="small">It returns to <code>${escape(c.redirectHost)}</code></p>`}

</main>
</body>
</html>`
}

/**
 * The base host's page that asks which workspace (one MCP address, or Start building in the browser): a workspace you're in or invited to,
 * a colleague's workspace to ask to join (the same work domain), or a new one, named for you.
 */
/** Where someone stands in a workspace they can open: in it, or invited (by whom, when known). */
export type Membership =
  | { readonly kind: "in" }
  | { readonly kind: "invited"; readonly by: string | null }

export type WorkspacePick = {
  readonly asking:
    | {
        readonly kind: "agent"
        readonly client: {
          readonly id: string
          readonly name: string
          readonly kind: "registered" | "document"
        }
        readonly redirectHost: string
        readonly userCode: string | null
        readonly handle: string
      }
    | { readonly kind: "browser"; readonly current: WorkspaceId | null }
  readonly person: { readonly email: string; readonly name: string }
  /** Workspaces they can open: in it (as an admin or a member: the page doesn't say which), or invited (by whom, when known). */
  readonly workspaces: ReadonlyArray<{
    readonly workspace: Workspace
    readonly membership: Membership
    readonly origin: string
  }>
  /** Workspaces made for their work domain they aren't in: they can ask its admins to invite them. */
  readonly colleagues: ReadonlyArray<{
    readonly workspace: Workspace
    readonly creator: string
    readonly domain: string
  }>
  /** The new workspace's name: suggested (Create starts closed), or after a create that was refused (it starts open, the problem says why). */
  readonly name: { readonly kind: "suggested" | "retry"; readonly value: string }
  readonly problem: string | null
  readonly formToken: string
}

const WORKSPACE_PICK = `
.alone .workspaces { display: grid; gap: var(--openbelt-space-xs); margin: var(--openbelt-space-sm) 0; text-align: left; }
.alone .workspaces .label { margin: var(--openbelt-space-xs) var(--openbelt-space-2xs) 0; font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.alone .workspaces .group { border: 0.5px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); overflow: hidden; }
.alone .workspaces .pick { position: relative; display: flex; flex-wrap: wrap; gap: var(--openbelt-space-sm); align-items: center; width: 100%; padding: var(--openbelt-space-sm) var(--openbelt-space-md); border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; list-style: none; }
.alone .workspaces .pick + .pick { border-top: 0.5px solid var(--openbelt-color-border); }
.alone .workspaces .pick:hover { background: var(--openbelt-color-subtle); }
.alone .workspaces .pick:focus-visible { outline-offset: -2px; }
.alone .workspaces .pick::-webkit-details-marker { display: none; }
.alone .workspaces .mono { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border: 0.5px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); font-weight: 600; text-transform: uppercase; }
.alone .workspaces .mono.new { background: none; border-style: dashed; }
.alone .workspaces .mono .icon { width: 16px; height: 16px; }
.alone .workspaces .what { display: grid; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.alone .workspaces .what .small { margin-top: 0; font: var(--openbelt-type-body-sm); }
.alone .workspaces .pick > .icon { flex: none; width: 18px; height: 18px; }
.alone .workspaces .tag { flex: none; padding: var(--openbelt-space-2xs) var(--openbelt-space-xs); border: 0.5px solid var(--openbelt-color-border-strong); border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-subtle); color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); line-height: 1; }
.alone .workspaces .tag.strong { border-color: var(--openbelt-color-primary); background: var(--openbelt-color-primary); color: var(--openbelt-color-on-primary); }
.alone .workspaces label.pick input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.alone .workspaces label.pick:has(input:focus-visible) { outline: 2px solid var(--openbelt-color-primary); outline-offset: -2px; }
.alone .workspaces label.pick:not(:has(input:checked)) > .icon, .alone .workspaces label.pick:not(:has(input:checked)) .input { display: none; }
.alone .workspaces label.pick .input { flex-basis: 100%; }
.alone .workspaces .input, .alone .name-workspace .input { width: 100%; height: 44px; }
.alone .workspaces details .row { display: flex; gap: var(--openbelt-space-xs); padding: 0 var(--openbelt-space-md) var(--openbelt-space-sm); }
.alone .workspaces details .input { flex: 1; min-width: 0; }
.alone .workspaces details .btn { flex: none; height: 44px; }
.alone .workspaces details[open] .pick:hover { background: none; }
.alone .name-workspace { display: grid; gap: var(--openbelt-space-xs); margin-top: var(--openbelt-space-sm); }
.alone .name-workspace .btn { justify-content: center; height: 44px; }
`

// A row marks only what changes a tap: an invite (Join) or a colleague's workspace (Ask). Being an admin doesn't.
const pickRow = (
  value: string,
  name: string,
  about: string | null,
  tag: string | null,
  origin: string | null,
) => ({
  value,
  origin,
  body: `<span class="mono" aria-hidden="true">${escape(name.slice(0, 1))}</span><span class="what"><strong>${escape(name)}</strong>${about === null ? "" : `<span class="small">${escape(about)}</span>`}</span>${tag === null ? "" : `<span class="tag${tag === "Join" ? " strong" : ""}">${tag}</span>`}`,
})

export const workspacePickPage = (c: WorkspacePick) => {
  const action =
    c.asking.kind === "agent"
      ? "/_oauth/authorize"
      : `/_start?${new URLSearchParams({ switch: "1", current: c.asking.current ?? "" }).toString()}`

  const carried: Array<[string, string]> = [["form", c.formToken]]

  if (c.asking.kind === "agent") carried.push(["handle", c.asking.handle])

  const hidden = carried
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join("")

  const problem =
    c.problem === null
      ? ""
      : `<div class="notice notice-error" role="alert">${icon("alert")}<div><p>${escape(c.problem)}</p></div></div>`

  const nameInput = (id: string) =>
    `<input class="input" id="${id}" name="name" value="${escape(c.name.value)}" aria-label="Workspace name" pattern="[a-z0-9][a-z0-9\\-]{0,39}" autocomplete="off" required>`

  const head = `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${c.asking.kind === "agent" ? "Connect an agent" : "Your workspace"} · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${ALONE}${CONSENT}${WORKSPACE_PICK}</style>
</head>
<body>
<main class="alone" id="consent">${WORDMARK}`

  const tail = `</main>
${
  c.asking.kind === "browser"
    ? `<div class="workspace-opening" hidden role="status" aria-label="Opening workspace"><div class="workspace-opening-mark">${slotSvg}</div><div class="workspace-opening-progress" role="progressbar" aria-label="Opening workspace"></div></div>
<script>
const opening = document.querySelector(".workspace-opening")
const forms = document.querySelectorAll("main form")
for (const pick of forms) pick.addEventListener("submit", (event) => {
  event.preventDefault()
  if (!opening.hidden) return
  const row = event.submitter
  const origin = row?.dataset.workspaceOrigin
  opening.hidden = false
  for (const form of forms) form.inert = true
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (origin) { location.assign(origin + "/?open=" + encodeURIComponent(pick.elements.form.value)); return }
    if (row?.name === "choice") {
      const chosen = pick.querySelector("input[data-chosen]") ?? pick.appendChild(Object.assign(document.createElement("input"), { type: "hidden", name: "choice" }))
      chosen.dataset.chosen = ""
      chosen.value = row.value
    }
    pick.submit()
  }))
})
addEventListener("pageshow", () => {
  opening.hidden = true
  for (const form of forms) form.inert = false
})
document.querySelector("details.create-workspace")?.addEventListener("toggle", (event) => { if (event.target.open) document.getElementById("workspace-name").focus() })
</script>`
    : `<script>
document.querySelector("input[name=choice][value=create]").addEventListener("change", () => document.getElementById("workspace-name").focus())
</script>`
}
</body>
</html>`

  // Nothing to pick from, in the browser: only the new workspace's name.
  if (c.asking.kind === "browser" && c.workspaces.length === 0 && c.colleagues.length === 0)
    return `${head}${headingHtml("h1", "Name your workspace", sub(`Signed in as ${escape(c.person.email)}. Your apps, data and connections live in it; you're its first admin, and others join when you invite them.`), { cls: "lead" })}
${problem}
<form method="post" action="${action}" class="name-workspace">${hidden}<input type="hidden" name="choice" value="create"><label class="visually-hidden" for="workspace-name">Workspace name</label>${nameInput("workspace-name")}<button class="btn btn-primary" type="submit">Continue</button></form>
${tail}`

  const currentId = c.asking.kind === "browser" ? c.asking.current : null
  const current = c.workspaces.find((o) => o.workspace.id === currentId)
  const first = c.workspaces[0]
  const colleague = c.colleagues[0]

  const selected =
    c.name.kind === "retry"
      ? "create"
      : current !== undefined
        ? `workspace:${current.workspace.id}`
        : first !== undefined
          ? `workspace:${first.workspace.id}`
          : colleague !== undefined
            ? `ask:${colleague.workspace.id}`
            : "create"

  const mine = c.workspaces
    .filter((o) => o.membership.kind === "in")
    .map((o) => pickRow(`workspace:${o.workspace.id}`, o.workspace.name, null, null, o.origin))

  const others = [
    ...c.workspaces.flatMap((o) =>
      o.membership.kind === "invited"
        ? [
            pickRow(
              `workspace:${o.workspace.id}`,
              o.workspace.name,
              o.membership.by === null ? "Invited" : `Invited by ${o.membership.by}`,
              "Join",
              o.origin,
            ),
          ]
        : [],
    ),
    ...c.colleagues.map((o) =>
      pickRow(`ask:${o.workspace.id}`, o.workspace.name, `Made by ${o.creator}`, "Ask", null),
    ),
  ]

  // Labels only when there are two lists to tell apart.
  const lists = (render: (r: ReturnType<typeof pickRow>) => string) =>
    [
      mine.length === 0
        ? ""
        : `${others.length === 0 ? "" : `<p class="label">Your workspaces</p>`}<div class="group">${mine.map(render).join("")}</div>`,
      others.length === 0
        ? ""
        : `${mine.length === 0 ? "" : `<p class="label">Other workspaces</p>`}<div class="group">${others.map(render).join("")}</div>`,
    ].join("")

  const createTitle =
    c.workspaces.length + c.colleagues.length === 0 ? "Create your workspace" : "Create a workspace"

  const createMark = `<span class="mono new" aria-hidden="true">${icon("plus")}</span>`

  // In the browser a row is the choice: one tap opens it. Create has a name to type, so it's a form of its own.
  if (c.asking.kind === "browser") {
    const button = (r: ReturnType<typeof pickRow>) => {
      const here = r.value === `workspace:${currentId}`

      return `<button class="pick" type="submit" name="choice" value="${escape(r.value)}"${r.origin === null ? "" : ` data-workspace-origin="${escape(r.origin)}"`}${here ? ` aria-current="true"` : ""}>${r.body}${here ? icon("check") : ""}</button>`
    }

    return `${head}${headingHtml("h1", "Choose workspace", null, { cls: "lead" })}
${problem}
<form method="post" action="${action}">${hidden}<div class="workspaces">${lists(button)}</div></form>
<div class="workspaces"><details class="group create-workspace"${c.name.kind === "retry" ? " open" : ""}><summary class="pick">${createMark}<span class="what"><strong>${createTitle}</strong></span></summary><form method="post" action="${action}">${hidden}<input type="hidden" name="choice" value="create"><div class="row">${nameInput("workspace-name")}<button class="btn btn-primary" type="submit">Create</button></div></form></details></div>
${tail}`
  }

  // An agent's consent: a row only selects (a check shows which); Continue grants it.
  const option = (r: ReturnType<typeof pickRow>) =>
    `<label class="pick"><input type="radio" name="choice" value="${escape(r.value)}"${r.value === selected ? " checked" : ""}>${r.body}${icon("check")}</label>`

  const options = `${lists(option)}<div class="group"><label class="pick"><input type="radio" name="choice" value="create"${selected === "create" ? " checked" : ""}>${createMark}<span class="what"><strong>${createTitle}</strong></span>${icon("check")}${nameInput("workspace-name")}</label></div>`

  const { client, redirectHost, userCode } = c.asking

  // The agent's name is its own claim; where it sends you back is what proves who it is, so that shows when it runs elsewhere
  // (an agent on this computer has nothing to show: a loopback address says nothing to a person).
  const where = [
    client.kind === "document" ? `Described at <code>${escape(client.id)}</code>` : null,
    userCode !== null
      ? `Continue only if your terminal shows <code>${escape(userCode)}</code>`
      : isLoopback(redirectHost) || redirectHost === DEVICE_HOST
        ? null
        : `Sends you back to <code>${escape(redirectHost)}</code>`,
  ].filter((line) => line !== null)

  return `${head}${headingHtml("h1", `Connect ${escape(client.name)} to OpenBelt`, where.length === 0 ? null : sub(where.join(". ")), { cls: "lead" })}
${problem}
<form method="post" action="${action}">${hidden}<div class="workspaces">${options}</div>
<div class="choose"><button class="btn btn-primary" type="submit" name="decision" value="allow">Continue</button><button class="btn btn-secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></div></form>
${tail}`
}

/** A trial workspace's claim link, opened signed in on the base host (trials.ts): one button makes it theirs. */
export const claimPage = (c: {
  readonly workspace: string
  readonly email: string
  readonly formToken: string
}) => `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claim ${escape(c.workspace)} · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${ALONE}${CONSENT}</style>
</head>
<body>
<main class="alone" id="consent">${WORDMARK}${headingHtml("h1", `Claim ${escape(c.workspace)}`, sub(`Signed in as ${escape(c.email)}. Your agent made this workspace and its apps; claimed, it's yours: you're its admin, its apps open for you and whoever you invite, and the agent goes on working, as you.`), { cls: "lead" })}
<form method="post" class="choose"><input type="hidden" name="form" value="${escape(c.formToken)}"><button class="btn btn-primary" type="submit">Claim it</button></form>
</main>
</body>
</html>`

/**
 * What the base host's sign-in pages add for an agent's sign-in (its link is where they go on to): the agent, as the consent page
 * names it, so Continue there is also Allow (the forms carry allow=1, base.ts ALLOWED_PARAM); and Google sign-in, first, when it's
 * set up (google.ts).
 */
type SignInExtras = {
  readonly agent?: { readonly name: string; readonly redirectHost: string } | null
  readonly google?: boolean
}

/** The pages someone signs in on (OPENBELT_SIGNIN=email): their email, the code sent to it, a link an admin made, signed out. */
export type SignInView =
  | ({
      readonly step: "email"
      readonly workspace: string
      readonly next: string
      readonly attempt: string
      /** Filled in: what was typed, the email this browser remembers (REMEMBERED_COOKIE), or an agent's login_hint. */
      readonly email: string
      /** The email is the one this browser remembers: "Welcome back". */
      readonly welcome?: boolean
      readonly problem: string | null
    } & SignInExtras)
  | ({
      // Google vouched for `email`, but the form named `asked` (another account picked at Google): which one?
      readonly step: "google_other"
      readonly workspace: string
      readonly next: string
      readonly attempt: string
      readonly email: string
      readonly asked: string
      readonly ticket: string
    } & SignInExtras)
  | ({
      readonly step: "code"
      readonly workspace: string
      readonly next: string
      readonly attempt: string
      readonly email: string
      readonly problem: string | null
      readonly inbox: Inbox | null
    } & SignInExtras)
  | {
      readonly step: "link"
      readonly workspace: string
      readonly email: string
      readonly ticket: string
    }
  | { readonly step: "gone"; readonly workspace: string; readonly message: string }
  | { readonly step: "signed_out"; readonly workspace: string; readonly door: string | null }

const SIGN_IN = `
#signin { gap: var(--openbelt-space-sm); }
#signin .lead strong { color: var(--openbelt-color-primary); font-weight: 600; }
#signin form { display: grid; gap: var(--openbelt-space-sm); margin: var(--openbelt-space-sm) 0 0; text-align: left; }
#signin form > label:not(.visually-hidden) { font: var(--openbelt-type-label); }
#signin .again form { margin: 0; }
#signin .input { width: 100%; height: 40px; }
#signin .code-input { font: var(--openbelt-type-mono-md); font-size: 24px; letter-spacing: 0.4em; height: 56px; padding-left: 0.4em; text-align: center; }
#signin .btn { justify-content: center; }
#signin .btn-primary, #signin .open-inbox { width: 100%; height: 40px; }
#signin .notice p { overflow-wrap: anywhere; }
#signin .again { display: flex; justify-content: center; flex-wrap: wrap; gap: var(--openbelt-space-2xs); }
#signin .again .btn { color: var(--openbelt-color-muted); }
#signin .btn-secondary { width: 100%; height: 40px; }
#signin .google svg, #signin .mail .icon { width: 18px; height: 18px; flex: none; }
#signin .spin { display: none; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; }
#signin .btn[aria-busy="true"] { opacity: 0.8; pointer-events: none; }
#signin .btn[aria-busy="true"] .spin { display: inline-block; }
#signin .btn[aria-busy="true"] > svg { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
/* On a phone the keyboard takes the bottom half: the form sits near the top, so its button stays in view. */
@media (max-width: 600px) { #signin { align-content: start; padding-top: var(--openbelt-space-3xl); } }
#signin .or { display: flex; align-items: center; gap: var(--openbelt-space-xs); margin: var(--openbelt-space-2xs) 0 0; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
#signin .or::before, #signin .or::after { content: ""; flex: 1; border-top: 0.5px solid var(--openbelt-color-border-strong); }
`

/** Google's "G", as its sign-in buttons show it. */
const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`

/** The page's heading: the agent being connected (the consent page's words), else what the page would say. */
const signInHeading = (v: SignInExtras, otherwise: string) =>
  v.agent === undefined || v.agent === null
    ? headingHtml("h1", otherwise, null, { cls: "lead" })
    : headingHtml(
        "h1",
        `Connect ${escape(v.agent.name)} to OpenBelt`,
        isLoopback(v.agent.redirectHost)
          ? null
          : sub(`Sends you back to <code>${escape(v.agent.redirectHost)}</code>`),
        { cls: "lead" },
      )

/** What every form on an agent's sign-in page carries: Continue is Allow. */
const allowOf = (v: SignInExtras): Record<string, string> =>
  v.agent === undefined || v.agent === null ? {} : { allow: "1" }

const SPIN = `<span class="spin" aria-hidden="true"></span>`

const googleForm = (
  v: SignInExtras & { readonly next: string; readonly attempt: string },
  email: string,
) =>
  v.google === true
    ? `<form method="post" action="/_signin/google" class="google-form">${hiddenOf({ next: v.next, attempt: v.attempt, email, ...allowOf(v) })}<button class="btn btn-primary google" type="submit">${GOOGLE_G}${SPIN}Continue with Google</button></form>`
    : ""

/** A button says it's working once its form is sent; Continue with Google takes the email typed so far. */
const SIGN_IN_SCRIPT = `<script>
document.querySelectorAll("#signin form").forEach((form) => form.addEventListener("submit", (event) => {
  const field = document.getElementById("email")
  if (form.classList.contains("google-form") && field) form.elements.email.value = field.value
  const button = event.submitter
  if (button) setTimeout(() => button.setAttribute("aria-busy", "true"))
}))
addEventListener("pageshow", () => document.querySelectorAll("#signin [aria-busy]").forEach((b) => b.removeAttribute("aria-busy")))
</script>`

/** The sign-in page's address with the empty email form, even in a browser that remembers one. */
const anotherEmail = (next: string, attempt: string) =>
  `/_signin?${new URLSearchParams({ next, attempt, another: "1" }).toString()}`

const claimHeading = (next: string, workspace: string) =>
  next.startsWith("/claim/")
    ? `Claim ${escape(/^\/claim\/([a-z0-9-]+)~/.exec(next)?.[1] ?? workspace)}: sign in and it's yours`
    : null

const problemOf = (problem: string | null) =>
  problem === null
    ? ""
    : `<div class="notice notice-error" role="alert">${icon("alert")}<div><p>${escape(problem)}</p></div></div>`

const hiddenOf = (fields: Readonly<Record<string, string>>) =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join("")

const openInbox = (link: { readonly name: string; readonly href: string }) =>
  `<a class="btn btn-secondary open-inbox" href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">Open ${escape(link.name)}${icon("externalLink")}</a>`

const signInBody = (v: SignInView) => {
  if (v.step === "email") {
    const google = v.google === true

    return `${signInHeading(v, claimHeading(v.next, v.workspace) ?? (v.welcome === true ? "Welcome back" : "Sign in"))}${problemOf(v.problem)}${google ? `${googleForm(v, v.email)}<p class="or">or</p>` : ""}
<form method="post" action="/_signin">${hiddenOf({ next: v.next, attempt: v.attempt, ...allowOf(v) })}<label for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="email" enterkeyhint="send" placeholder="you@example.com" required${google || v.email !== "" ? "" : " autofocus"} value="${escape(v.email)}"><button class="btn ${google ? "btn-secondary" : "btn-primary"} mail" type="submit">${icon("mail")}${SPIN}Email me a code</button></form>`
  }

  if (v.step === "google_other")
    return `${headingHtml("h1", "Different Google account", sub(`Google signed you in as <strong>${escape(v.email)}</strong>, not <strong>${escape(v.asked)}</strong>.`), { cls: "lead" })}
<form method="post" action="/_signin/google/other">${hiddenOf({ t: v.ticket, next: v.next, attempt: v.attempt })}<button class="btn btn-primary" type="submit">${SPIN}Continue as ${escape(v.email)}</button></form>
<form method="post" action="/_signin">${hiddenOf({ email: v.asked, next: v.next, attempt: v.attempt, ...allowOf(v) })}<button class="btn btn-secondary mail" type="submit">${icon("mail")}${SPIN}Email a code to ${escape(v.asked)}</button></form>`

  if (v.step === "code")
    return `${headingHtml("h1", "Check your email", sub(`We sent a code to <strong>${escape(v.email)}</strong>.`), { cls: "lead" })}${problemOf(v.problem)}${v.inbox === null ? "" : openInbox(inboxLink(v.inbox))}
<form method="post" action="/_signin/code">${hiddenOf({ email: v.email, next: v.next, attempt: v.attempt, ...allowOf(v) })}<label class="visually-hidden" for="code">Code</label><input class="input code-input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus><button class="btn btn-primary" type="submit">${SPIN}Sign in</button></form>
<div class="again"><form method="post" action="/_signin">${hiddenOf({ email: v.email, next: v.next, attempt: v.attempt, ...allowOf(v) })}<button class="btn btn-ghost" type="submit">Send another code</button></form><a class="btn btn-ghost" href="${escape(anotherEmail(v.next, v.attempt))}">Use another email</a></div>`

  if (v.step === "link")
    return `${headingHtml("h1", "Sign in", sub(`Continue as ${escape(v.email)}.`), { cls: "lead" })}
<form method="post" action="/_signin/link">${hiddenOf({ t: v.ticket })}<button class="btn btn-primary" type="submit">Sign in</button></form>`

  if (v.step === "gone")
    return `${headingHtml("h1", "This link doesn't work", sub(escape(v.message)), { cls: "lead" })}<a class="btn btn-primary" href="/_signin">Sign in with your email</a>`

  return `${headingHtml("h1", "You're signed out", v.door === null ? null : sub(`${escape(v.workspace)} still opens as ${escape(v.door)} on this computer.`), { cls: "lead" })}<a class="btn btn-primary" href="/_signin">Sign in</a>`
}

/** The page a device sign-in (`openbelt login`) is approved on: the code to check against the terminal, or a box to type it in. */
export type DeviceView =
  | {
      readonly kind: "confirm"
      readonly client: string
      readonly userCode: string
      readonly authorize: string
    }
  | { readonly kind: "enter"; readonly problem: string | null }

const DEVICE = `
#signin .code-shown { margin: 0; padding: var(--openbelt-space-sm); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-subtle); font: var(--openbelt-type-mono-md); font-size: 28px; letter-spacing: 0.15em; text-align: center; }
#signin .code-input { letter-spacing: 0.15em; text-transform: uppercase; }
`

export const devicePage = (v: DeviceView) => `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Sign in · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${ALONE}${SIGN_IN}${DEVICE}</style>
</head>
<body>
<main class="alone" id="signin">${WORDMARK}${
  v.kind === "confirm"
    ? `${headingHtml("h1", `Sign in ${escape(v.client)}`, sub("Check your terminal or agent shows this code."), { cls: "lead" })}
<p class="code-shown">${escape(v.userCode)}</p>
<a class="btn btn-primary" href="${escape(v.authorize)}">Continue</a>`
    : `${headingHtml("h1", "Enter the code from your terminal", null, { cls: "lead" })}${problemOf(v.problem)}
<form method="get" action="${DEVICE_PATH}"><label class="visually-hidden" for="code">Code</label><input class="input code-input" id="code" name="user_code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="BCDF-GHJK" maxlength="9" required autofocus><button class="btn btn-primary" type="submit">Continue</button></form>`
}</main>
</body>
</html>`

export const signInPage = (v: SignInView) => `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Sign in · ${escape(v.workspace)} · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="text/markdown" href="/auth.md" title="For AI agents">
<style>${tokensCss}${baseCss}${componentsCss}${logoCss}${ALONE}${SIGN_IN}</style>
</head>
<body>
<main class="alone" id="signin">${WORDMARK}${signInBody(v)}</main>
${SIGN_IN_SCRIPT}
</body>
</html>`
