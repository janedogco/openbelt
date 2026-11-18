import { EventsQuery } from "./events.ts"
import { pwaResponse } from "./pwa.ts"
import { AppAnswer, PushSubscription } from "./push.ts"
import { PageTiming, recordPageTiming, TIMING_BYTES } from "./timing.ts"
import * as HttpBody from "effect/http/HttpBody"
import { THEME_DATA } from "./theme.ts"
import { AppName, RESERVED_APP_NAMES, THEME_HEADER, ThemeChange } from "./model.ts"
import * as Runtime from "./runtime/index.ts"
import * as Config from "effect/Config"
import * as Redacted from "effect/Redacted"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Headers from "effect/http/Headers"
import { fromWeb, HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import FAVICON from "../../../brand/logo/favicon.svg" with { type: "text" }
import {
  eventsPage,
  asksPage,
  connectionPage,
  consentPage,
  refusedPage,
  outcomePage,
  agentsPage,
  type Ask,
  connectionsPage,
  deniedPage,
  type InviteAsk,
  doneNotice,
  isConnectionsPage,
  type Notice,
  refusedNotice,
  type WorkspacePage,
  workspacePageAt,
  workspaceSettingsPage,
  pageAfter,
  Section,
  SettingsAction,
  signInPage,
  type SignInView,
} from "./settings.ts"
import { appFrame, frameSignIn, publicFrame } from "./frame.ts"
import { Fields } from "./answers.ts"
import { CLI_ROUTE, cliResponse } from "./cli-dist.ts"
import { type Card, connectionLabel, galleryParts, homePage } from "./home.ts"
import { colorOfName } from "./colors.ts"
import { workspaceAuthMd, tellYourHuman } from "./welcome.ts"
import { funnel, keepSource } from "./funnel.ts"
import {
  basicOf,
  bearer,
  browserOf,
  clientAddress,
  crossOrigin,
  decodeAuthorize,
  fieldsOf,
  htmlOf,
  json,
  localPath,
  markdown,
  WORKSPACE_PAGE,
  pathOf,
  sameHost,
  wantsMarkdown,
  withOAuthCors,
} from "./http.ts"
import type { Listed, PageAsk } from "./directory.ts"
import { clientDocument } from "./oauth-client.ts"
import {
  APP_SEPARATOR,
  appOfHost,
  appOrigin,
  appUrl,
  frameUrl,
  isPagePath,
  workspaceOfApp,
  inWorkspace,
  type Place,
  placeOf,
} from "./hosts.ts"
import McpDO, { UNKNOWN_SESSION } from "./mcp.ts"
import {
  ADDRESS_HEADER,
  type Audience,
  AUDIENCE_HEADER,
  PUBLIC_HOST,
  publicLabel,
  publicNameOf,
  publicUrl,
} from "./public.ts"
import { EDGE_SECONDS, edgeKept } from "./cdn.ts"
import { type AuthorizeRequest, challengeHeader, metadataOf } from "./oauth.ts"
import { deviceRoute } from "./device.ts"
import { scimError } from "./scim.ts"
import {
  Email,
  emailOf,
  type Inventory,
  isSlug,
  type Json,
  newTrace,
  type Workspace,
  WorkspaceId,
  type ErrorCode,
  WorkspaceName,
  TEST_PEOPLE_LIVE,
  type AppRecord,
  type PanelAccess,
  AppView,
  privateApp,
  PublicBlock,
  type StoredView,
  type Viewer,
} from "./model.ts"
import WorkspaceDO from "./workspace.ts"
import { MISS_FRESH_MS, openWorkspaceNames } from "./workspace-names.ts"
import { isLoopback, logOver, type OverLimit, overLimit } from "./rate.ts"
import ApexDO, { APEX } from "./apex.ts"
import { loginKey } from "./login.ts"
import { inboxOf } from "./inbox.ts"
import { ALLOWED_PARAM, authorizeRequestOf, openBase } from "./base.ts"
import { CLEARED_GOOGLE_COOKIE, GOOGLE, GOOGLE_COOKIE, googleCookie } from "./google.ts"
import { type Admission, refusalOf, tokenRefusal } from "./people.ts"
import { SDK_JS, SDK_VERSION } from "./sdk.ts"
import {
  ADMIN_TOKEN,
  isAdminBearer,
  cameThroughFrontDoor,
  ATTEMPT_COOKIE,
  attemptCookie,
  CLEARED_COOKIE,
  COOKIE,
  FRONT_DOOR_SECRET,
  frontDoorViewer,
  GATEWAY_HEADERS,
  REMEMBERED_COOKIE,
  REMEMBERED_DAYS,
  SESSION_SECRET,
  SIGNIN,
  sessionCookie,
  sessions,
} from "./session.ts"
import { UPLOADS, fileHeaders, fileUrlValid, sizeOf } from "./files.ts"
import AppDO, { CUT_OFF, cappedBody, drainBody, MAX_WRITE_BODY } from "./app.ts"
import { type Starter, STARTERS } from "./starters.ts"

/** The most an MCP request may carry: a deploy's files included. */
const MAX_MCP_BODY = 64 * 1024 * 1024

/**
 * MCP request bodies this process holds at once, from before the first byte is read until the answer, in all and per person (by
 * email, so their workspaces share one). Each is held several times over while it is decoded, parsed and handed to the person's
 * McpDO: 60 requests of 63 MB at once from one person took a 4 GB container through its swap, and the kernel ended a platform
 * process. One person's share holds one request at the cap with room for their small ones beside it.
 */
const MCP_BODIES_BYTES = 192 * 1024 * 1024

const MCP_BODIES_PERSON_BYTES = MAX_MCP_BODY + 16 * 1024 * 1024

const mcpBodies = { all: 0, of: new Map<string, number>() }

/**
 * Books `bytes` of MCP request for `who`: undefined past either share. `settle` lowers the booking to what the body turned out to
 * be; `release` gives it back (once, however often it is called).
 */
const bookMcpBody = (who: string, bytes: number) => {
  const theirs = mcpBodies.of.get(who) ?? 0

  if (mcpBodies.all + bytes > MCP_BODIES_BYTES || theirs + bytes > MCP_BODIES_PERSON_BYTES)
    return undefined

  let held = bytes

  const move = (by: number) => {
    mcpBodies.all += by

    const now = (mcpBodies.of.get(who) ?? 0) + by

    if (now <= 0) mcpBodies.of.delete(who)
    else mcpBodies.of.set(who, now)
  }

  move(held)

  return {
    settle: (actual: number) => {
      if (actual >= held) return

      move(actual - held)
      held = actual
    },
    release: () => {
      move(-held)
      held = 0
    },
  }
}

const TokenRequest = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      email: Email,
      days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
    }),
    Schema.Struct({
      user: Email,
      days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
    }),
  ]),
)

const WorkspaceAdminRequest = Schema.fromJsonString(Schema.Struct({ email: Email }))

const BROWSER_HEADERS = ["cookie", "origin", "sec-fetch-mode"]

/** An IP address as a URL's hostname (`10.0.0.5`, `[::1]`): what a load balancer's health check sends as the host. */
const isAddress = (hostname: string) =>
  hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)

const inviteAskOf = (workspace: WorkspaceName, admission: Admission): InviteAsk | undefined => {
  if (admission.kind === "member" || admission.kind === "anonymous" || admission.kind === "trial")
    return undefined

  const who = admission.kind === "signed_out" ? "me" : admission.email

  return {
    admins: admission.admins,
    subject: `Invite me to ${workspace} on OpenBelt`,
    body: `Could you invite ${who} to ${workspace}? I'm not a member, and it's invite-only.`,
  }
}

const refused = (
  workspace: WorkspaceName,
  admission: Admission,
  asJson: boolean,
  trace: string,
) => {
  const message = refusalOf(workspace, admission)

  if (message === undefined) return undefined

  return asJson
    ? json({ error: message, code: "not_member", trace }, 403)
    : htmlOf(
        refusedPage(
          admission.kind === "trial"
            ? "This workspace is a trial until someone claims it"
            : `Not a member of ${workspace}`,
          message,
          trace,
          inviteAskOf(workspace, admission),
        ),
        {
          status: 403,
          headers: { "cache-control": "no-store" },
        },
      )
}

const reply = (status: number, body: Readonly<Record<string, Json>> | null) =>
  body === null
    ? HttpServerResponse.empty({ status })
    : HttpServerResponse.text(JSON.stringify(body), {
        status,
        contentType: "application/scim+json",
        headers: { "cache-control": "no-store" },
      })

const noToken = (workspace: WorkspaceName, origin: string, what: string, trace: string) =>
  json(
    {
      error: `${what} needs an API token for the workspace "${workspace}": send Authorization: Bearer <token>. Whoever runs this OpenBelt makes the first (POST ${origin}/_admin/tokens; see docs/mcp.md); with one, make more (bun run workspace tokens create).`,
      code: "unauthorized",
      trace,
    },
    401,
  )

const signInFirst = (workspace: WorkspaceName, origin: string, trace: string) =>
  HttpServerResponse.setHeader(
    json(
      {
        error: `${tellYourHuman(origin, `the workspace ${workspace}`)}. A client that can't sign in sends Authorization: Bearer <API token>, made in ${origin}/_settings/agents.`,
        code: "unauthorized",
        trace,
      },
      401,
    ),
    "www-authenticate",
    challengeHeader(origin, undefined),
  )

const OAUTH_ROUTE =
  /^\/(\.well-known\/oauth-protected-resource(\/mcp)?|\.well-known\/oauth-authorization-server|_oauth\/(authorize|token|register|revoke|device|device_authorization))$/

/**
 * What an old name of a renamed workspace still answers as itself, pages too: OAuth (an agent's, whose issuer it holds; a connection's
 * sign-in coming back to the redirect address its provider has).
 */
const OAUTH_PAGE = /^\/(_oauth\/|\.well-known\/)/

const DATA_ROUTE = /^(?:_preview\/[^/]+\/)?_(db|ws|log|fn|files|aggregates)(?:\/|$)/

const TOOLS_ROUTE = /^(?:_preview\/([^/]+)\/)?_tools(\/call)?$/

const SDK_ROUTE = /^\/(?:_preview\/[^/]+\/)?sdk\.js$/

const HOOK_ROUTE = /^\/(?:_preview\/[^/]+\/)?_hook\/[^/]+(\/[^/]+)?$/

/**
 * Under `tailscale`, what a request that didn't come through the front door may still reach: paths that carry their own
 * credentials (a token, a webhook's signature) or none worth having. Everything else is a person's, and refused.
 */
/** The link previewers of chat apps and social networks, by their user agents (iMessage sends facebookexternalhit's). */
const LINK_PREVIEWER =
  /Slackbot|Slack-ImgProxy|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Discordbot|WhatsApp|TelegramBot|SkypeUriPreview|MicrosoftPreview|redditbot|Embedly|Iframely|Mastodon|Bluesky|Pinterestbot|vkShare|Google-PageRenderer/i

const NO_FRONT_DOOR_NEEDED =
  /^\/(mcp|auth\.md|_admin\/.*|scim\/v2(\/.*)?|_tls\/ask|_health|favicon\.(ico|svg)|\.well-known\/oauth-(protected-resource(\/mcp)?|authorization-server)|_oauth\/(token|register|revoke|device_authorization|clients\/[^/]+\.json))$/

/** The operator's routes (OPENBELT_ADMIN_TOKEN), which may name a workspace nobody made yet (its first token), and the health checks. */
/** Sign-in codes one address may ask for in an hour, across every host: each is an email someone receives. */
const CODES_PER_ADDRESS = 30

const OPERATOR_ROUTE = /^\/(_admin\/.*|_health|_tls\/ask)$/

/** A host whose workspace nobody made: a page says where to start, anything else is told so as JSON. */
const noSuchWorkspace = Effect.fnUntraced(function* (
  workspace: WorkspaceName,
  base: string,
  trace: string,
) {
  const request = yield* HttpServerRequest
  const message = `No workspace called ${workspace}. Start at ${base}`

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    (request.headers["accept"] ?? "").includes("text/html")
  )
    return htmlOf(
      refusedPage(
        `No workspace called "${workspace}"`,
        `Check the address, or make one of your own.`,
        trace,
        undefined,
        {
          href: `${base}/`,
          text: "Go to OpenBelt",
        },
      ),
      { status: 404, headers: { "cache-control": "no-store" } },
    )

  return json({ error: message, code: "missing", trace }, 404)
})

/** The workspace host's routes that take an API token and never a cookie (manage): they check the token themselves. */
const TOKEN_ONLY_ROUTE = /^\/_(workspace|me)\/.+$/

/** How long a process trusts the apps it read a workspace lets frame its others (workspace_embed_set). */
const EMBED_FRESH_MS = 5_000

/** Where someone signs in: a workspace's host, or the base host (no workspace in its name, under email sign-in). */
type SignInPlace =
  | { readonly kind: "workspace"; readonly workspace: Workspace }
  | { readonly kind: "apex" }

const signInHtml = (view: SignInView, status = 200) =>
  htmlOf(signInPage(view), { status, headers: WORKSPACE_PAGE })

/** The workspace host's sign-in pages under OPENBELT_SIGNIN=email: the email asked for, the code typed, an admin's link, signing out. */
const SIGN_IN_ROUTE = /^\/(_signin(\/(code|link))?|_signout)$/

/** The email an agent's sign-in link hints at (login_hint on /_oauth/authorize), when next is that link: on this host, or
 *  carried here from a workspace host's sign-in (/_start/carry, whose own next is the workspace's authorize link). */
const hintedEmail = (next: string, origin: string) => {
  if (!URL.canParse(next, origin)) return undefined

  const to = new URL(next, origin)

  if (to.origin !== origin) return undefined

  const inner = to.searchParams.get("next") ?? ""

  const link =
    to.pathname === "/_start/carry" && URL.canParse(inner, origin) ? new URL(inner, origin) : to

  return link.pathname === "/_oauth/authorize"
    ? emailOf(link.searchParams.get("login_hint") ?? "")
    : undefined
}

/** Nobody signed in, under email sign-in: a page goes to sign in and comes back; anything else is told where to. */
const signedOut = Effect.fnUntraced(function* (
  workspaceOrigin: string,
  url: URL,
  own: string | undefined,
  trace: string,
) {
  const request = yield* HttpServerRequest
  const accept = request.headers["accept"] ?? ""

  const page =
    (request.method === "GET" || request.method === "HEAD") &&
    accept.includes("text/html") &&
    request.headers["upgrade"] === undefined

  if (!page)
    return json(
      {
        error:
          own === undefined
            ? `nobody is signed in: sign in at ${workspaceOrigin}/_signin, or send an API token (Authorization: Bearer <token>). An AI agent reads ${workspaceOrigin}/auth.md (it adds ${workspaceOrigin}/mcp, and its human signs in).`
            : `nobody is signed in: an app's pages and data are for people signed in to ${workspaceOrigin}. A person opens the app in their browser and signs in; an agent tries it with the check_app tool.`,
        code: "unauthorized",
        trace,
      },
      401,
    )

  const here = `${url.pathname}${url.search}`

  if (own === undefined)
    return HttpServerResponse.redirect(
      `${workspaceOrigin}/_signin${here === "/" ? "" : `?next=${encodeURIComponent(here)}`}`,
      { status: 302, headers: { "cache-control": "no-store" } },
    )

  // An app's host: this browser gets a nonce, and the session comes back only in a ticket made for it (login.ts handoff).
  const attempt = crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true })

  return HttpServerResponse.redirect(
    `${workspaceOrigin}/_signin?next=${encodeURIComponent(url.href)}&attempt=${attempt}`,
    { status: 302, headers: { "cache-control": "no-store", "set-cookie": attemptCookie(attempt) } },
  )
})

const PanelChange = Schema.fromJsonString(
  Schema.Struct({
    form: Schema.String,
    view: Schema.optionalKey(AppView),
    public: Schema.optionalKey(PublicBlock),
  }),
)

const DeleteAsk = Schema.fromJsonString(Schema.Struct({ form: Schema.String }))

/** Add from the Apps page: the form token, and the name to add the starter as when the page offers another (journal-2). */
const StarterAsk = Schema.fromJsonString(
  Schema.Struct({ form: Schema.String, app: Schema.optionalKey(AppName) }),
)

const ToolCallBody = Schema.fromJsonString(
  Schema.Struct({
    tool: Schema.String,
    input: Schema.optionalKey(Schema.Json),
    fields: Schema.optionalKey(Fields),
  }),
)

const adminsOnly = (
  workspace: WorkspaceName,
  what: string,
  admins: ReadonlyArray<string>,
  trace: string,
  viewer: Viewer | null,
) =>
  htmlOf(
    deniedPage(
      workspace,
      "For the workspace's admins",
      `${what} is for ${workspace}'s admins${admins.length > 0 ? ` (${admins.join(", ")})` : ""}. Your own connections are under Connections, beside Apps.`,
      trace,
      viewer,
    ),
    { status: 403, headers: WORKSPACE_PAGE },
  )

/**
 * The workspace's home: private to whoever sees it, and pointing an agent that fetched it at the workspace's /auth.md.
 * Not no-store, so Back from an app restores the gallery from the back/forward cache as it was left (scroll, Show more,
 * search); its script checks the viewer again when it is restored.
 */
const HOME_PAGE = {
  ...WORKSPACE_PAGE,
  "cache-control": "private, no-cache",
  vary: "accept",
  link: '</auth.md>; rel="alternate"; type="text/markdown"',
}

/** How many apps a page of the home page shows (divides by 2 to 6 columns), and its recently updated shelf. */
const HOME_PAGE_CARDS = 60

const HOME_SHELF = 12

/** An app as the home page shows it, from the workspace's directory; `manage` when the viewer may delete it. */
const cardOf = (app: Listed, manage: boolean): Card => ({
  name: app.name,
  description: app.description,
  owner: app.owner,
  created: app.created,
  updated: app.updated,
  shot: app.shot,
  // Its own colour when it gave one, else its name's: the card's tint.
  color: app.color !== null && /^#[0-9a-f]{6}$/.test(app.color) ? app.color : colorOfName(app.name),
  // A live app with no picture yet: one is booked when it deploys, and the page looks for it a while.
  coming: app.entered && app.updated !== null && app.shot === null,
  entered: app.entered,
  manage,
})

const backTo = (text: string | null | undefined, workspaceOrigin: string) => {
  if (text === null || text === undefined || !URL.canParse(text)) return null

  const to = new URL(text)

  const workspace = new URL(workspaceOrigin)

  return inWorkspace(to, workspace) && appOfHost(to.host, workspace.host) !== undefined
    ? to.href
    : null
}

const askOf = (connection: string | null, app: string | null, env: string | null): Ask | null =>
  connection !== null && isSlug(connection) && app !== null && isSlug(app)
    ? { connection, app, env: env === null || env === "" ? undefined : env }
    : null

const decodeAction = Schema.decodeUnknownOption(SettingsAction)

/** The operator's view of the running platform (gateway.observe). */
const OBSERVE_ROUTE = /^\/_admin\/(logs|trace|metrics|actors(\/sleep)?)$/

const decodeLevel = Schema.decodeUnknownOption(Runtime.LogLevel)

/** `since` as ms since the epoch: an ISO time, or how long ago (30s, 5m, 2h). */
const sinceOf = (given: string) => {
  const ago = /^(\d+)(s|m|h)$/.exec(given)
  const unit = { s: 1000, m: 60_000, h: 3_600_000 }[ago?.[2] ?? "s"] ?? 1000

  return ago === null ? Date.parse(given) || undefined : Date.now() - Number(ago[1]) * unit
}

const decodeFormText = Schema.decodeUnknownOption(Schema.String)

const multipartFields = (bytes: Uint8Array<ArrayBuffer>, contentType: string) =>
  Effect.promise(async () => {
    const parsed = await new Response(bytes, { headers: { "content-type": contentType } })
      .formData()
      .catch(() => new FormData())

    const fields: Record<string, string> = {}
    let file: File | undefined

    parsed.forEach((value, key) => {
      if (value instanceof File) file = value
      else fields[key] = Option.getOrElse(decodeFormText(value), () => "")
    })

    if (file !== undefined) {
      fields["type"] = file.type
      fields["base64"] = new Uint8Array(await file.arrayBuffer()).toBase64()
    }

    return fields
  })

const iconResponse = (
  icon: { readonly type: string; readonly body: Uint8Array; readonly hash: string } | undefined,
  version: string | null,
) =>
  icon === undefined
    ? HttpServerResponse.text("No icon.\n", { status: 404 })
    : HttpServerResponse.uint8Array(icon.body, {
        contentType: icon.type,
        headers: {
          "cache-control":
            version === icon.hash ? "private, max-age=31536000, immutable" : "private, no-cache",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      })

/** A starter's picture made ahead changes only with its files and data, so its hash versions it. */
const starterPictureVersion = (starter: Starter) => starter.hash.slice(0, 12)

/** GET /_starters/<name>/picture[?theme=dark]: a starter's picture made ahead, the same for every workspace (the Starters tab's cards). */
const starterPicture = (name: string, url: URL) => {
  const starter = STARTERS.find((s) => s.name === name)

  if (starter === undefined || starter.picture.kind !== "current")
    return HttpServerResponse.text("No picture.\n", { status: 404 })

  return HttpServerResponse.uint8Array(
    url.searchParams.get("theme") === "dark" ? starter.picture.dark : starter.picture.light,
    {
      contentType: "image/webp",
      headers: {
        "cache-control":
          url.searchParams.get("v") === starterPictureVersion(starter)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        "x-content-type-options": "nosniff",
      },
    },
  )
}

const decodeSection = Schema.decodeUnknownOption(Section)

const decodeWorkspaceName = Schema.decodeUnknownOption(WorkspaceName)

const decodeFirst = Schema.decodeUnknownSync(
  Schema.Struct({ workspace: WorkspaceId, name: WorkspaceName }),
)

const MOVED = new Map([
  ["/_settings/activity", "/_settings/events"],
  ["/_settings/activity/requests", "/_settings/events/requests"],
  ["/_account", "/_connections"],
  ["/_access", "/_settings/events"],
  ["/_settings/access", "/_settings/events"],
  ["/_settings/access/asks", "/_settings/events/requests"],
])

/** An app's address on the workspace host, /<app> or /<app>/<path>: never /<app>/_..., which is OpenBelt's (the panel's). */
const FRAMED = /^\/([^/]+)(\/(?!_).*)?$/

const SHARED_ROUTE = /^(?:_preview\/[^/]+\/)?_(db|ws|fn|files|aggregates)(?:\/|$)/

const refererEnv = (referer: string | undefined, origin: string) => {
  if (referer === undefined || !sameHost(referer, origin)) return undefined

  return /^\/_preview\/([^/]+)\//.exec(new URL(referer).pathname)?.[1]
}

/** A name on this machine: localhost, or one under it (a workspace's, an app's). */
const local = (hostname: string) => hostname === "localhost" || hostname.endsWith(".localhost")

export default class Gateway extends Runtime.Worker(
  "Gateway",
  Effect.gen(function* () {
    const apps = yield* AppDO
    const workspaces = yield* WorkspaceDO
    const apex = (yield* ApexDO).getByName(APEX)
    const mcps = yield* McpDO
    const host = yield* Config.String("OPENBELT_HOST").pipe(Config.withDefault("localhost"))

    // The base host (the marketing site, sign-in, the one MCP address) on a domain of its own, apart from the workspaces' and their apps'
    // (openbelt.com beside <workspace>.openbelt.app): user-written pages then never share a registrable domain with the sign-in. Default: OPENBELT_HOST.
    const baseHost = yield* Config.String("OPENBELT_BASE_HOST").pipe(
      Config.withDefault(""),
      Config.map((given) => (given === "" ? host : given)),
    )

    // One under the other would read the base host as a workspace's (or a workspace's as a name of the base's), and put the sign-in on the
    // apps' registrable domain again.
    if (baseHost !== host && (baseHost.endsWith(`.${host}`) || host.endsWith(`.${baseHost}`)))
      return yield* Effect.die(
        new Error(
          `OPENBELT_BASE_HOST (${baseHost}) and OPENBELT_HOST (${host}) are one under the other: give the base host a domain of its own (openbelt.com beside openbelt.app), or leave OPENBELT_BASE_HOST unset to serve both on OPENBELT_HOST`,
        ),
      )

    const defaultWorkspace = yield* Config.String("OPENBELT_DEFAULT_WORKSPACE").pipe(
      Config.withDefault("acme"),
    )

    const commit = yield* Config.String("OPENBELT_COMMIT").pipe(Config.withDefault(""))

    // Where a browser's page load of an app's own host ends up: frame (the workspace's /<app>/<path>, what people get) or host (it
    // stays, as for the checks that read an app's page itself).
    const appPages = yield* Config.Literals(["frame", "host"], "OPENBELT_APP_PAGES").pipe(
      Config.withDefault("frame"),
    )

    // Where bun run dev serves the workspace host over https on the tailnet (OPENBELT_HOST), beside this
    const httpsPort = yield* Config.String("OPENBELT_HTTPS_PORT").pipe(Config.withDefault(""))

    const secureOrigin = (workspace: Workspace, url: URL) =>
      url.protocol === "https:"
        ? null
        : host === "localhost" || httpsPort === ""
          ? null
          : `https://${workspace.name}.${host}:${httpsPort}`

    /**
     * The MCP address an agent signs in to by itself, for the workspace's pages to show: the workspace's own over https (bun run dev's tailnet
     * one too); on plain http, the base host's under email sign-in when it's localhost, where Claude Code and pi send a token over
     * http (they do to no other name); else the workspace's own.
     */
    const signingInAt = (workspace: Workspace, url: URL, workspaceOrigin: string) => {
      const secure = secureOrigin(workspace, url)
      const base = baseOf(url.hostname)
      const port = url.port === "" ? "" : `:${url.port}`

      if (url.protocol === "http:" && secure !== null) return `${secure}/mcp`

      if (url.protocol === "http:" && signIn === "email" && base === "localhost")
        return `http://localhost${port}/mcp`

      return `${workspaceOrigin}/mcp`
    }

    const adminToken = yield* ADMIN_TOKEN
    const signIn = yield* SIGNIN

    const secretsKey = Redacted.value(
      yield* Config.Redacted("OPENBELT_SECRETS_KEY").pipe(Effect.orDie),
    )

    const googleSignIn = (yield* GOOGLE.pipe(Effect.orDie)) !== null

    // Public apps on a registrable domain of their own (<app>--<workspace>.openbelt.page), never under or over the workspaces' or the
    // base host's: a name there would read as both, and public pages would share cookies and reputation with them again.
    const publicHost = yield* PUBLIC_HOST

    if (publicHost !== "") {
      const beside = (other: string) =>
        publicHost === other || publicHost.endsWith(`.${other}`) || other.endsWith(`.${publicHost}`)

      for (const [setting, other] of [
        ["OPENBELT_HOST", host],
        ["OPENBELT_BASE_HOST", baseHost],
        ["localhost (this machine's names)", "localhost"],
      ] as const)
        if (beside(other))
          return yield* Effect.die(
            new Error(
              `OPENBELT_PUBLIC_HOST (${publicHost}) and ${setting} (${other}) are the same or one under the other: give public apps a registrable domain of their own (openbelt.page beside openbelt.app), or leave OPENBELT_PUBLIC_HOST unset`,
            ),
          )

      if (signIn !== "email")
        return yield* Effect.die(
          new Error(
            `OPENBELT_PUBLIC_HOST (${publicHost}) needs OPENBELT_SIGNIN=email, and this is ${signIn}: with tailscale the front door decides who reaches every name, so nothing would be public, and with off every app already opens for anyone. Set OPENBELT_SIGNIN=email, or leave OPENBELT_PUBLIC_HOST unset`,
          ),
        )
    }

    /** A name under the public host (or the public host itself): answered by publicRoute alone, as nobody. */
    const underPublic = (hostname: string) =>
      publicHost !== "" && (hostname === publicHost || hostname.endsWith(`.${publicHost}`))

    const uploads = (yield* UPLOADS) === "on"
    const frontDoorSecret = yield* FRONT_DOOR_SECRET

    const throughFrontDoor = Effect.fnUntraced(function* () {
      const request = yield* HttpServerRequest

      return cameThroughFrontDoor(
        // With a secret set, only the secret says a request came through the front door: anything on this machine reaches loopback.
        Option.isSome(frontDoorSecret) ? undefined : Option.getOrUndefined(request.remoteAddress),
        request.headers,
        frontDoorSecret,
      )
    })

    const session = sessions(yield* SESSION_SECRET)

    /** The domain a name's workspaces are under: localhost for *.localhost, else OPENBELT_HOST. */
    const domainOf = (hostname: string) => (local(hostname) ? "localhost" : host)

    /** The base host beside a name: localhost for *.localhost, else OPENBELT_BASE_HOST. */
    const baseOf = (hostname: string) => (local(hostname) ? "localhost" : baseHost)

    /**
     * The names OpenBelt answers under tailscale sign-in (bun run dev, bun run tailnet, verify): under
     * localhost or OPENBELT_HOST, this machine's addresses, and tailnet names (the front door serves
     * this Mac's own, so an old link still lands; Tailscale gives them out, so no page's owner can
     * point one here). Any other name on a request is a page whose own name was pointed at this
     * machine (DNS rebinding), same-origin with OpenBelt there, so it could send any
     * Tailscale-User-Login it likes.
     */
    const ownName = (hostname: string) =>
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".ts.net") ||
      hostname === baseHost ||
      underPublic(hostname) ||
      (host !== "" && (hostname === host || hostname.endsWith(`.${host}`)))

    const hereOf = (hostname: string) => {
      if (underPublic(hostname)) return undefined

      const domain = domainOf(hostname)
      const onBase = hostname !== baseHost && hostname.endsWith(`.${domain}`)

      const place: Place | undefined = onBase
        ? placeOf(hostname.slice(0, -domain.length - 1))
        : { kind: "workspace", workspace: defaultName }

      if (place === undefined) return undefined

      const name = Option.getOrUndefined(decodeWorkspaceName(place.workspace))

      return name !== undefined && (place.kind === "workspace" || isSlug(place.app))
        ? { place, onBase, name }
        : undefined
    }

    const names = yield* openWorkspaceNames((known) => apex.workspaceDirectory(known))

    /**
     * The apps each workspace lets frame its other apps (workspace_embed_set), as this process last read them: a page's
     * frame-ancestors names them. Kept EMBED_FRESH_MS, so a change reaches every process within that.
     */
    const embedRead = new Map<
      WorkspaceId,
      { readonly at: number; readonly apps: ReadonlyArray<string> }
    >()

    const embeddingOf = Effect.fnUntraced(function* (workspace: WorkspaceId) {
      const known = embedRead.get(workspace)

      if (known !== undefined && Date.now() - known.at < EMBED_FRESH_MS) return known.apps

      const named = yield* workspaces.getByName(workspace).embedding()

      embedRead.set(workspace, { at: Date.now(), apps: named })

      return named
    })

    /** Workspaces this process has seen a file for, or claimed in ApexDO: neither is undone, so each is looked for once. */
    const filed = new Set<WorkspaceId>()

    /**
     * The workspace a request's host names: its id and current name (an old name gives the workspace it was, as it is called now). A name with
     * no workspace yet may be one another process renamed a workspace to a moment ago: checked first (workspace-names.ts `unknown`).
     */
    const workspaceAt = Effect.fnUntraced(function* (here: { readonly name: WorkspaceName }) {
      const workspace = yield* names.named(here.name)

      if (workspace.name !== here.name || filed.has(workspace.id)) return workspace

      if (Runtime.hasFile("WorkspaceDO", workspace.id)) {
        filed.add(workspace.id)

        return workspace
      }

      // Under email sign-in only the operator or the base host makes a workspace; a name with none is a 404 (cheap for strangers).
      if (signIn === "email") return yield* names.unknown(here.name, MISS_FRESH_MS)

      // Elsewhere a first visit makes the workspace: its name is claimed in ApexDO first, so a rename to it can't race the visit.
      const first = decodeFirst(yield* apex.firstUse(here.name))
      const made: Workspace = { id: first.workspace, name: first.name }

      filed.add(made.id)

      return made
    })

    /** The base host itself (no workspace in its name) under email sign-in: where someone without a workspace starts (base.ts). */
    const isApex = (hostname: string) =>
      signIn === "email" && (hostname === "localhost" || hostname === baseHost)

    const defaultName = Schema.decodeUnknownSync(WorkspaceName)(defaultWorkspace)

    /** Workspaces this process has seen in use: one stays in use (nothing deletes a workspace), so it is asked about once. */
    const inUse = new Set<WorkspaceId>()

    /**
     * Whether someone made the workspace (the default one always): a made-up name has no file, and isn't given one just to say so (each
     * object is a file, so a stranger's made-up hosts would otherwise leave one each).
     */
    const workspaceExists = Effect.fnUntraced(function* (workspace: Workspace) {
      if (inUse.has(workspace.id)) return true

      const made =
        (yield* names.named(defaultName)).id === workspace.id ||
        (Runtime.hasFile("WorkspaceDO", workspace.id) &&
          (yield* workspaces.getByName(workspace.id).inUse()))

      if (made) inUse.add(workspace.id)

      return made
    })

    /** Who a sign-in session is (asked of the workspace once per request, however many times a request asks who is viewing). */
    const sessionViewers = new WeakMap<object, Viewer | null>()

    const sessionViewer = Effect.fnUntraced(function* (onHost: string, token: string) {
      const request = yield* HttpServerRequest
      const known = sessionViewers.get(request)

      if (known !== undefined) return known

      const hostname = onHost.replace(/:\d+$/, "")
      const here = hereOf(hostname)

      const viewer = isApex(hostname)
        ? yield* apex.loginViewer(token)
        : here === undefined
          ? null
          : yield* workspaces.getByName((yield* workspaceAt(here)).id).loginViewer(token)

      sessionViewers.set(request, viewer)

      return viewer
    })

    const frontDoor = Effect.fnUntraced(function* () {
      const request = yield* HttpServerRequest
      const agent = request.headers["user-agent"]

      const named = () =>
        frontDoorViewer(
          request.headers["tailscale-user-login"],
          request.headers["tailscale-user-name"],
          agent,
        )

      return signIn !== "off" && (yield* throughFrontDoor()) ? named() : null
    })

    const viewerOf = Effect.fnUntraced(function* (inPreview: boolean, onHost: string) {
      const request = yield* HttpServerRequest
      const opened = yield* session.open(request.cookies[COOKIE], onHost)

      if (opened !== null && opened.kind === "person") {
        const viewer = signIn === "email" ? yield* sessionViewer(onHost, opened.session) : null

        if (viewer !== null)
          return { viewer, person: null, checked: false, checkedBy: null, session: opened.session }
      } else if (opened !== null) {
        const person = opened.kind === "test" ? opened : null

        return {
          viewer: inPreview && person !== null ? { email: person.email, name: person.name } : null,
          person,
          checked: true,
          checkedBy: opened.by ?? "",
          session: null,
        }
      }

      return {
        viewer: yield* frontDoor(),
        person: null,
        checked: false,
        checkedBy: null,
        session: null,
      }
    })

    const admit = Effect.fnUntraced(function* (
      workspace: Workspace,
      who: { readonly viewer: Viewer | null; readonly checked: boolean },
      asJson: boolean,
      trace: string,
    ) {
      if (who.checked) return undefined

      const admission = yield* workspaces.getByName(workspace.id).admit(who.viewer)
      const answer = refused(workspace.name, admission, asJson, trace)

      if (answer !== undefined) {
        yield* Effect.logInfo(
          `refused ${who.viewer?.email ?? "a signed-out visitor"}: ${admission.kind}`,
        ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))
      }

      return answer
    })

    /**
     * Where to go after signing in: a path on the workspace host, or a page of one of the workspace's apps (whose host then gets the session
     * through a one-time ticket). Anything else (another workspace, anywhere else) goes home.
     */
    const landing = (workspace: Workspace, workspaceOrigin: string, next: string) => {
      if (!URL.canParse(next, workspaceOrigin)) return { kind: "here" as const, path: "/" }

      const to = new URL(next, workspaceOrigin)
      const from = new URL(workspaceOrigin)

      if (to.origin === from.origin) return { kind: "here" as const, path: pathOf(to) }

      const there = hereOf(to.hostname)

      if (
        to.protocol !== from.protocol ||
        to.port !== from.port ||
        there === undefined ||
        !there.onBase ||
        there.name !== workspace.name
      )
        return { kind: "here" as const, path: "/" }

      return there.place.kind === "app"
        ? { kind: "app" as const, origin: to.origin, path: pathOf(to) }
        : { kind: "here" as const, path: pathOf(to) }
    }

    const goOnInWorkspace = Effect.fnUntraced(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      next: string,
      carried: string | null,
      cookie: string | null,
      attempt: string,
    ) {
      const to = landing(workspace, workspaceOrigin, next)

      const headers =
        cookie === null
          ? { "cache-control": "no-store" }
          : { "cache-control": "no-store", "set-cookie": cookie }

      if (to.kind === "here") return HttpServerResponse.redirect(to.path, { status: 303, headers })

      // A ticket only for the browser the app's host sent here (its attempt): without one, the app's host starts it again.
      const ticket =
        carried === null || attempt === ""
          ? null
          : yield* workspaces
              .getByName(workspace.id)
              .loginHandoff(carried, new URL(to.origin).host, attempt)

      return HttpServerResponse.redirect(
        ticket === null
          ? `${to.origin}${to.path}`
          : `${to.origin}/_signin/return?ticket=${ticket}&to=${encodeURIComponent(to.path)}`,
        { status: 303, headers },
      )
    })

    /**
     * The sign-in pages (OPENBELT_SIGNIN=email): /_signin, /_signin/code, /_signin/link and /_signout, on a workspace's host (its people,
     * its sessions) or on the base host (anyone, the base host's own sessions, no links).
     */
    const signInRoute = Effect.fn("gateway.signIn")(function* (
      place: SignInPlace,
      workspaceOrigin: string,
      url: URL,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const path = url.pathname
      const workspace = place.kind === "workspace" ? place.workspace.name : "OpenBelt"
      const logged = place.kind === "workspace" ? place.workspace.id : "OpenBelt"
      const login = apex

      const linked =
        place.kind === "workspace" ? workspaces.getByName(place.workspace.id) : undefined

      const page = signInHtml

      /** The agent whose sign-in link `next` is, on the base host: the request, and who it is as the consent page names it. */
      const agentOf = Effect.fnUntraced(function* (next: string) {
        if (place.kind !== "apex" || !URL.canParse(next, url.origin)) return null

        const to = new URL(next, url.origin)

        if (to.origin !== url.origin || to.pathname !== "/_oauth/authorize") return null

        const asked = authorizeRequestOf(to)

        if (Option.isNone(asked)) return null

        const checked = yield* apex.oauthCheck(asked.value, url.origin)

        return checked.kind === "consent"
          ? {
              asked: asked.value,
              shown: { name: checked.client.name, redirectHost: checked.redirectHost },
            }
          : null
      })

      /** What a base host sign-in page adds (settings.ts SignInExtras): the agent it allows, and whether it offers Google. */
      const extrasOf = Effect.fnUntraced(function* (next: string) {
        const agent = yield* agentOf(next)

        return { agent: agent?.shown ?? null, google: place.kind === "apex" && googleSignIn }
      })

      /** Where someone goes on to after signing in: an agent's link they allowed there carries that (base.ts ALLOWED_PARAM). */
      const allowedNext = Effect.fnUntraced(function* (
        email: string,
        next: string,
        allow: boolean,
      ) {
        const agent = allow ? yield* agentOf(next) : null

        if (agent === null) return next

        const to = new URL(next, url.origin)

        to.searchParams.set(ALLOWED_PARAM, yield* apex.oauthPend(email, agent.asked))

        return `${to.pathname}${to.search}`
      })

      const goOn = (
        next: string,
        carried: string | null,
        cookie: string | null,
        attempt: string,
      ) =>
        place.kind === "workspace"
          ? goOnInWorkspace(place.workspace, workspaceOrigin, next, carried, cookie, attempt)
          : Effect.succeed(
              HttpServerResponse.redirect(localPath(next, url.origin), {
                status: 303,
                headers:
                  cookie === null
                    ? { "cache-control": "no-store" }
                    : { "cache-control": "no-store", "set-cookie": cookie },
              }),
            )

      if (request.method === "GET" && path === "/_signin") {
        const next = url.searchParams.get("next") ?? (place.kind === "workspace" ? "/" : "/_start")
        const attempt = url.searchParams.get("attempt") ?? ""
        const who = yield* viewerOf(false, url.host)

        if (who.viewer !== null) return yield* goOn(next, who.session, null, attempt)

        if (place.kind === "workspace" && request.headers["sec-fetch-dest"] === "iframe")
          return htmlOf(frameSignIn(url.href), {
            headers: {
              "cache-control": "no-store",
              "content-security-policy": "frame-ancestors 'self'",
              "x-frame-options": "SAMEORIGIN",
            },
          })

        if (place.kind === "workspace") return yield* carryFrom(place.workspace, url)

        const remembered = emailOf(request.cookies[REMEMBERED_COOKIE] ?? "")
        // An agent's sign-in link may say who it expects (OIDC's login_hint on /_oauth/authorize): offer that email, one
        // click from a code. A hint only fills the form: the code still goes to that address, and "Use another email" stays.
        const hinted = hintedEmail(next, url.origin)
        const offered = hinted ?? remembered
        const inspected = yield* session.inspect(request.cookies[COOKIE], url.host)

        // Why this browser has to sign in (again): a session lost with the email still remembered is one cookie gone; both gone is
        // the browser's storage cleared, or a browser that never signed in here.
        const why =
          inspected.kind === "refused"
            ? inspected.reason
            : inspected.session.kind === "person"
              ? "session ended"
              : "not a person's session"

        yield* Effect.logInfo(
          `sign-in: signed-out visitor at /_signin: ${why}; remembered email: ${remembered === undefined ? "no" : "yes"}`,
        ).pipe(
          Effect.annotateLogs({
            trace,
            workspace: logged,
            browser: browserOf(request.headers["user-agent"]),
            next: URL.canParse(next, url.origin) ? new URL(next, url.origin).pathname : "",
          }),
        )

        const shown = url.searchParams.has("another") ? undefined : offered

        const visit = yield* funnel("signin", url, trace)

        return keepSource(
          page({
            step: "email",
            workspace,
            next,
            attempt,
            email: shown ?? "",
            welcome: shown !== undefined && shown === remembered,
            problem: null,
            ...(yield* extrasOf(next)),
          }),
          visit,
        )
      }

      /** Signed in with Google (straight from Google, or after Continue as ...): the session, the remembered email, on to `went`. */
      const googleSignedIn = Effect.fnUntraced(function* (done: {
        readonly email: string
        readonly session: string
        readonly until: number
        readonly went: { readonly next: string; readonly attempt: string; readonly allow: boolean }
      }) {
        yield* Effect.logInfo(`sign-in: ${done.email} signed in with Google`).pipe(
          Effect.annotateLogs({ trace, workspace: logged }),
        )

        yield* funnel("signed_in", undefined, trace, { email: done.email, detail: "with Google" })

        const sealed = yield* session.seal({
          kind: "person",
          session: done.session,
          host: url.host,
          until: done.until,
        })

        const answer = yield* goOn(
          yield* allowedNext(done.email, done.went.next, done.went.allow),
          done.session,
          sessionCookie(sealed, done.until),
          done.went.attempt,
        )

        return HttpServerResponse.setCookieUnsafe(
          HttpServerResponse.setCookieUnsafe(answer, REMEMBERED_COOKIE, done.email, {
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            maxAge: Duration.days(REMEMBERED_DAYS),
          }),
          GOOGLE_COOKIE,
          "",
          { path: "/", secure: true, httpOnly: true, sameSite: "lax", maxAge: 0 },
        )
      })

      // Google sent someone back (google.ts): signed in as the email it vouches for, like a code; or the sign-in page again, saying so.
      if (
        request.method === "GET" &&
        path === "/_signin/google/callback" &&
        place.kind === "apex"
      ) {
        const done = yield* apex.googleFinish({
          origin: url.origin,
          state: url.searchParams.get("state") ?? "",
          kept: request.cookies[GOOGLE_COOKIE] ?? "",
          code: url.searchParams.get("code") ?? "",
        })

        if (done.kind === "refused") {
          yield* Effect.logWarning(`sign-in: Google sign-in refused: ${done.why}`).pipe(
            Effect.annotateLogs({ trace, workspace: logged }),
          )

          const next = done.went?.next ?? "/_start"

          return HttpServerResponse.setHeader(
            page(
              {
                step: "email",
                workspace,
                next,
                attempt: done.went?.attempt ?? "",
                email: "",
                problem: url.searchParams.has("error")
                  ? "Google sign-in was cancelled. Try again, or use your email."
                  : "Google sign-in didn't work. Try again, or use your email.",
                ...(yield* extrasOf(next)),
              },
              400,
            ),
            "set-cookie",
            CLEARED_GOOGLE_COOKIE,
          )
        }

        if (done.kind === "other") {
          yield* Effect.logInfo(
            "sign-in: Google vouched for another email than the form's; asking before signing it in",
          ).pipe(Effect.annotateLogs({ trace, workspace: logged }))

          return HttpServerResponse.setHeader(
            page({
              step: "google_other",
              workspace,
              next: done.went.next,
              attempt: done.went.attempt,
              email: done.email,
              asked: done.asked,
              ticket: done.ticket,
              agent: done.went.allow ? ((yield* agentOf(done.went.next))?.shown ?? null) : null,
            }),
            "set-cookie",
            CLEARED_GOOGLE_COOKIE,
          )
        }

        return yield* googleSignedIn(done)
      }

      if (linked === undefined && path === "/_signin/link")
        return HttpServerResponse.text("Not found.\n", { status: 404 })

      if (request.method === "GET" && path === "/_signin/link" && linked !== undefined) {
        const ticket = url.searchParams.get("t") ?? ""
        const email = ticket === "" ? null : yield* linked.loginLinkFor(ticket)

        return email === null
          ? page(
              {
                step: "gone",
                workspace,
                message:
                  "It was used already, or it's more than 15 minutes old. Ask whoever made it for another, or sign in with your email.",
              },
              410,
            )
          : page({ step: "link", workspace, email, ticket })
      }

      if (request.method !== "POST")
        return HttpServerResponse.text(`${request.method} ${path}: POST it\n`, { status: 405 })

      if (crossOrigin(request.headers, url.origin) !== undefined)
        return htmlOf(
          refusedPage(
            "Refused",
            "This form didn't come from this OpenBelt's own page, so nothing happened. Open the sign-in page and try again.",
            trace,
          ),
          { status: 403, headers: WORKSPACE_PAGE },
        )

      const body = yield* cappedBody(request, 10_000)

      if (body.kind !== "read")
        return HttpServerResponse.text("The form is over 10 KB.\n", { status: 400 })

      const form = fieldsOf(new TextDecoder().decode(body.bytes), request.headers["content-type"])
      const next = form["next"] ?? (place.kind === "workspace" ? "/" : "/_start")
      const attempt = form["attempt"] ?? ""

      if (path === "/_signout") {
        const who = yield* viewerOf(false, url.host)

        const opened = yield* session.open(request.cookies[COOKIE], url.host)
        const signingOut = opened?.kind === "person" ? opened.session : null

        if (signingOut !== null) {
          const parent =
            place.kind === "apex"
              ? yield* loginKey(signingOut)
              : yield* workspaces.getByName(place.workspace.id).loginParent(signingOut)

          if (parent !== null) {
            const affected = yield* apex.browserEnd(parent)

            for (const id of affected) yield* workspaces.getByName(id).loginEndParent(parent)
          } else if (place.kind === "workspace") {
            yield* workspaces.getByName(place.workspace.id).loginSignOut(signingOut)
          }

          yield* Effect.logInfo(`sign-in: ${who.viewer?.email ?? "someone"} signed out`).pipe(
            Effect.annotateLogs({ trace, workspace: logged }),
          )
        }

        if (place.kind === "workspace")
          return HttpServerResponse.redirect(
            `${url.protocol}//${baseOf(url.hostname)}${url.port === "" ? "" : `:${url.port}`}/_signedout`,
            {
              status: 303,
              headers: { ...WORKSPACE_PAGE, "set-cookie": CLEARED_COOKIE },
            },
          )

        const door = yield* frontDoor()

        return htmlOf(signInPage({ step: "signed_out", workspace, door: door?.email ?? null }), {
          headers: { ...WORKSPACE_PAGE, "set-cookie": CLEARED_COOKIE },
        })
      }

      if (path === "/_signin/link" && linked !== undefined) {
        const redeemed = yield* linked.loginRedeemLink(form["t"] ?? "")

        if (redeemed.kind === "gone")
          return page(
            {
              step: "gone",
              workspace,
              message:
                "It was used already, or it's more than 15 minutes old. Ask whoever made it for another, or sign in with your email.",
            },
            410,
          )

        yield* Effect.logInfo("sign-in: someone signed in with a link").pipe(
          Effect.annotateLogs({ trace, workspace: logged }),
        )

        return yield* goOn(
          "/",
          redeemed.session,
          yield* session
            .seal({
              kind: "person",
              session: redeemed.session,
              host: url.host,
              until: redeemed.until,
            })
            .pipe(Effect.map((sealed) => sessionCookie(sealed, redeemed.until))),
          "",
        )
      }

      if (place.kind === "workspace")
        return HttpServerResponse.redirect(
          `/_signin?${new URLSearchParams({ next, attempt }).toString()}`,
          { status: 303 },
        )

      // Allowed on this page: the agent its next is (an agent's sign-in page's forms carry allow=1, settings.ts).
      const allow = form["allow"] === "1"

      if (path === "/_signin/google/other" && place.kind === "apex") {
        const done = yield* apex.googleOther(form["t"] ?? "")

        if (done.kind === "gone")
          return page(
            {
              step: "email",
              workspace,
              next,
              attempt,
              email: "",
              problem: "That sign-in is over 10 minutes old, or was used. Sign in again.",
              ...(yield* extrasOf(next)),
            },
            410,
          )

        return yield* googleSignedIn(done)
      }

      if (path === "/_signin/google") {
        yield* funnel("google", undefined, trace)

        const started = yield* apex.googleStart({
          origin: url.origin,
          next,
          attempt,
          allow,
          hint: emailOf(form["email"] ?? "") ?? null,
        })

        if (started === null)
          return page(
            {
              step: "email",
              workspace,
              next,
              attempt,
              email: "",
              problem: "Google sign-in isn't working right now: use your email.",
              ...(yield* extrasOf(next)),
              google: false,
            },
            503,
          )

        return HttpServerResponse.redirect(started.location, {
          status: 303,
          headers: { "cache-control": "no-store", "set-cookie": googleCookie(started.state) },
        })
      }

      const email = emailOf(form["email"] ?? "")

      if (email === undefined)
        return page(
          {
            step: "email",
            workspace,
            next,
            attempt,
            email: form["email"] ?? "",
            problem: "That isn't an email address: type one like ada@acme.com.",
            ...(yield* extrasOf(next)),
          },
          400,
        )

      if (path === "/_signin") {
        const asked = yield* apex.codeAllow(
          clientAddress(request.headers, Option.getOrUndefined(request.remoteAddress)),
          CODES_PER_ADDRESS,
        )

        if (!asked.ok)
          return page(
            {
              step: "email",
              workspace,
              next,
              attempt,
              email,
              problem: `${CODES_PER_ADDRESS} codes were asked for from your network in the last hour, the most it may. Try again in ${Math.ceil(asked.retryAfter / 60)} min.`,
              ...(yield* extrasOf(next)),
            },
            429,
          )

        const [, inbox] = yield* Effect.all(
          [login.loginStart(workspace, email, trace), inboxOf(email)],
          { concurrency: "unbounded" },
        )

        yield* funnel("code", undefined, trace, { email })

        return page({
          step: "code",
          workspace,
          next,
          attempt,
          email,
          problem: null,
          inbox,
          agent: allow ? ((yield* agentOf(next))?.shown ?? null) : null,
        })
      }

      const finished = yield* login.loginFinish(email, form["code"] ?? "")

      if (finished.kind === "wrong")
        return page(
          {
            step: "code",
            workspace,
            next,
            attempt,
            email,
            problem: "That code didn't work. Check it, or send another.",
            inbox: yield* inboxOf(email),
            agent: allow ? ((yield* agentOf(next))?.shown ?? null) : null,
          },
          400,
        )

      yield* Effect.logInfo(`sign-in: ${email} signed in with a code`).pipe(
        Effect.annotateLogs({ trace, workspace: logged }),
      )

      yield* funnel("signed_in", undefined, trace, { email, detail: "with a code" })

      const sealed = yield* session.seal({
        kind: "person",
        session: finished.session,
        host: url.host,
        until: finished.until,
      })

      const answer = yield* goOn(
        yield* allowedNext(email, next, allow),
        finished.session,
        sessionCookie(sealed, finished.until),
        attempt,
      )

      // Only the base host takes codes, so only it remembers who typed one.
      return place.kind === "apex"
        ? HttpServerResponse.setCookieUnsafe(answer, REMEMBERED_COOKIE, email, {
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            maxAge: Duration.days(REMEMBERED_DAYS),
          })
        : answer
    })

    /** An app's host receiving a session from the workspace host: the ticket is used up, and the session's cookie set on this host. */
    const signInReturn = Effect.fn("gateway.signInReturn")(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      url: URL,
    ) {
      const request = yield* HttpServerRequest
      const to = localPath(url.searchParams.get("to") ?? "/", url.origin)

      const redeemed = yield* workspaces
        .getByName(workspace.id)
        .loginRedeemHandoff(
          url.searchParams.get("ticket") ?? "",
          url.host,
          request.cookies[ATTEMPT_COOKIE] ?? "",
        )

      if (redeemed.kind === "gone")
        return HttpServerResponse.redirect(
          `${workspaceOrigin}/_signin?next=${encodeURIComponent(`${url.origin}${to}`)}`,
          { status: 303, headers: { "cache-control": "no-store" } },
        )

      const sealed = yield* session.seal({
        kind: "person",
        session: redeemed.session,
        host: url.host,
        until: redeemed.until,
      })

      return HttpServerResponse.redirect(to, {
        status: 303,
        headers: {
          "cache-control": "no-store",
          "set-cookie": sessionCookie(sealed, redeemed.until),
        },
      })
    })

    /**
     * The workspace's host starting to take a sign-in from the base host (Start building, base.ts): this browser gets a nonce, and the
     * base host is asked for a ticket made for it, so a ticket nobody's browser started here can't sign anyone in.
     */
    const carryFrom = Effect.fn("gateway.carryFrom")(function* (workspace: Workspace, url: URL) {
      const next = url.searchParams.get("next") ?? "/"
      const who = yield* viewerOf(false, url.host)

      if (who.viewer !== null)
        return yield* goOnInWorkspace(
          workspace,
          url.origin,
          next,
          who.session,
          null,
          url.searchParams.get("attempt") ?? "",
        )

      const attempt = crypto
        .getRandomValues(new Uint8Array(32))
        .toBase64({ alphabet: "base64url", omitPadding: true })

      const port = url.port === "" ? "" : `:${url.port}`

      const asks = new URLSearchParams({
        workspace: workspace.name,
        attempt,
        next,
        appAttempt: url.searchParams.get("attempt") ?? "",
      })

      return HttpServerResponse.redirect(
        `${url.protocol}//${baseOf(url.hostname)}${port}/_start/carry?${asks.toString()}`,
        {
          status: 303,
          headers: { "cache-control": "no-store", "set-cookie": attemptCookie(attempt) },
        },
      )
    })

    /** The workspace's host receiving a sign-in carried from the base host: the ticket, in the browser whose nonce it was made for. */
    const carried = Effect.fn("gateway.carried")(function* (
      workspace: Workspace,
      url: URL,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const to = url.searchParams.get("to") ?? "/"

      const redeemed = yield* workspaces
        .getByName(workspace.id)
        .loginRedeemCarry(
          url.searchParams.get("ticket") ?? "",
          url.host,
          request.cookies[ATTEMPT_COOKIE] ?? "",
        )

      if (redeemed.kind === "gone")
        return HttpServerResponse.redirect(`/_signin?next=${encodeURIComponent(to)}`, {
          status: 303,
          headers: { "cache-control": "no-store" },
        })

      yield* Effect.logInfo("sign-in: someone's sign-in on the base host was carried here").pipe(
        Effect.annotateLogs({ trace, workspace: workspace.id }),
      )

      const sealed = yield* session.seal({
        kind: "person",
        session: redeemed.session,
        host: url.host,
        until: redeemed.until,
      })

      return yield* goOnInWorkspace(
        workspace,
        url.origin,
        to,
        redeemed.session,
        sessionCookie(sealed, redeemed.until),
        url.searchParams.get("appAttempt") ?? "",
      )
    })

    const mcp = Effect.fn("gateway.mcp")(function* (
      workspace: Workspace,
      origin: string,
      url: URL,
      trace: string,
      token: string | undefined,
    ) {
      const request = yield* HttpServerRequest

      const anonymousRate = Effect.gen(function* () {
        const remote = Option.getOrUndefined(request.remoteAddress)
        const trusted = yield* throughFrontDoor()

        if (isLoopback(remote) && request.headers["x-forwarded-for"] === undefined) return undefined
        const address = clientAddress(trusted ? request.headers : {}, remote)
        const over = overLimit(address, !["GET", "HEAD", "OPTIONS"].includes(request.method))

        return over === undefined
          ? undefined
          : yield* refusedOverLimit(address, over, url.pathname, trace)
      })

      if (token === undefined)
        return (yield* anonymousRate) ?? signInFirst(workspace.name, url.origin, trace)

      const check = yield* workspaces.getByName(workspace.id).checkToken(token)

      if (check.kind !== "valid") {
        const rate = yield* anonymousRate

        if (rate !== undefined) return rate
        yield* Effect.logInfo(`MCP refused a token: ${check.kind}`).pipe(
          Effect.annotateLogs({ trace, workspace: workspace.id }),
        )

        const why = tokenRefusal(workspace.name, check) ?? ""

        return HttpServerResponse.setHeader(
          json({ error: why, code: "unauthorized", trace }, 401),
          "www-authenticate",
          challengeHeader(url.origin, why),
        )
      }

      const over = yield* mcps
        .getByName(`${workspace.id}/${check.person.id}`)
        .requestLimit(!["GET", "HEAD", "OPTIONS"].includes(request.method))

      if (over !== null) return yield* refusedOverLimit("person", over, url.pathname, trace)

      const headers = Headers.merge(
        request.headers,
        Headers.fromInput({
          "x-openbelt-workspace": workspace.id,
          "x-openbelt-workspace-name": workspace.name,
          "x-openbelt-user": check.person.email,
          "x-openbelt-person": check.person.id,
          "x-openbelt-origin": origin,
          "x-openbelt-trace": trace,
          "x-openbelt-oauth-client": encodeURIComponent(check.client ?? ""),
          "x-openbelt-apps":
            check.apps === null ? "" : encodeURIComponent(JSON.stringify(check.apps)),
        }),
      )

      const bodiless = request.method === "GET" || request.method === "HEAD"
      const length = Number(request.headers["content-length"] ?? Number.NaN)

      // Booked before a byte is read: what it says it carries, the most one may when it doesn't say (then what it carried), none
      // past the cap (refused unread below).
      const booking = bookMcpBody(
        check.person.email,
        bodiless || length > MAX_MCP_BODY ? 0 : Number.isFinite(length) ? length : MAX_MCP_BODY,
      )

      if (booking === undefined) {
        yield* Effect.logWarning(
          `MCP request from ${check.person.email} refused: ${sizeOf(mcpBodies.all)} of MCP requests in flight here (${sizeOf(mcpBodies.of.get(check.person.email) ?? 0)} theirs)`,
        ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

        return HttpServerResponse.jsonUnsafe(
          {
            error: `this server is reading as many MCP requests as it holds at once (${sizeOf(MCP_BODIES_BYTES)} in all, ${sizeOf(MCP_BODIES_PERSON_BYTES)} of one person's): try again in a few seconds, and send large deploys one at a time`,
            code: "busy",
            trace,
          },
          { status: 503, headers: { "retry-after": "5", "x-openbelt-busy": "1" } },
        )
      }

      return yield* Effect.gen(function* () {
        const capped = yield* cappedBody(request, MAX_MCP_BODY)

        if (capped.kind === "over")
          return json(
            {
              error: `an MCP request is at most ${MAX_MCP_BODY / 1024 / 1024} MB: deploy large files in several calls`,
              code: "invalid",
              trace,
            },
            413,
          )

        if (capped.kind === "read") booking.settle(capped.bytes.length)

        const body = capped.kind === "read" ? new TextDecoder().decode(capped.bytes) : ""

        // An agent limited to some apps gets an MCP object of its own: one person's agents share one otherwise, and the
        // caller it keeps (what each request says) must never be another credential's.
        const theirs = mcps.getByName(
          check.apps === null
            ? `${workspace.id}/${check.person.id}`
            : `${workspace.id}/${check.person.id}/${check.credential}`,
        )

        const send = () =>
          theirs.fetch(
            fromWeb(
              new Request(url.href, {
                method: request.method,
                headers,
                body: bodiless ? null : body,
              }),
            ),
          )

        const response = yield* send()
        const claimed = request.headers["mcp-session-id"]

        if (response.headers[UNKNOWN_SESSION] === undefined || claimed === undefined)
          return response

        const earlier = yield* mcps
          .getByName(`${workspace.id}/${check.person.email}`)
          .savedSession(claimed)

        if (earlier === undefined) return response

        yield* theirs.adopt(earlier)
        yield* Effect.logInfo(
          `MCP session ${claimed} moved to ${check.person.email}'s instance`,
        ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

        return yield* send()
      }).pipe(Effect.ensuring(Effect.sync(booking.release)))
    })

    /** Whether an agent's `resource` is this workspace's MCP server: on any of its names (its old ones reach it too). */
    const ourResource = Effect.fnUntraced(function* (workspace: Workspace, resource: string) {
      if (!URL.canParse(resource)) return false

      const named = new URL(resource)
      const there = hereOf(named.hostname)

      return (
        there !== undefined &&
        there.place.kind === "workspace" &&
        (named.pathname === "/mcp" || named.pathname === "/mcp/") &&
        (yield* workspaceAt(there)).id === workspace.id
      )
    })

    const oauthRoute = Effect.fn("gateway.oauth")(function* (
      workspace: Workspace,
      url: URL,
      route: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const origin = url.origin
      const metadata = metadataOf(origin, workspace.name)

      const cors = withOAuthCors

      const oauthJson = (body: Readonly<Record<string, Json>>, status = 200) =>
        cors(
          HttpServerResponse.jsonUnsafe(body, {
            status,
            headers: { "cache-control": "no-store", pragma: "no-cache" },
          }),
        )

      if (request.method === "OPTIONS") return cors(HttpServerResponse.empty({ status: 204 }))

      if (route.startsWith(".well-known/")) {
        if (request.method !== "GET") return oauthJson({ error: "GET it" }, 405)

        return oauthJson(
          route === ".well-known/oauth-authorization-server" ? metadata.server : metadata.resource,
        )
      }

      if (route === "_oauth/authorize") return yield* authorize(workspace, url, trace)

      if (route === "_oauth/device") {
        const kept = workspaces.getByName(workspace.id)

        return yield* deviceRoute(url, {
          find: (typed, issuer) => kept.oauthDeviceFind(typed, issuer),
          done: (state, outcome) => kept.oauthDeviceDone(state, outcome),
        })
      }

      if (request.method !== "POST")
        return oauthJson({ error: "invalid_request", error_description: `POST /${route}` }, 405)

      const body = yield* cappedBody(request, 20_000)

      if (body.kind !== "read")
        return oauthJson(
          { error: "invalid_request", error_description: "the body is over 20 KB, or cut off" },
          400,
        )

      const text = new TextDecoder().decode(body.bytes)

      if (route === "_oauth/register") {
        const made = yield* workspaces.getByName(workspace.id).oauthRegister(text)

        yield* Effect.logInfo(
          made.ok
            ? `oauth: a client registered (${made.id}, ${made.name})`
            : `oauth: a registration was refused: ${made.description}`,
        ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

        return made.ok
          ? oauthJson(made.body, 201)
          : oauthJson({ error: made.error, error_description: made.description }, made.status)
      }

      const fields = fieldsOf(text, request.headers["content-type"])
      const basic = basicOf(request.headers["authorization"])

      if (route === "_oauth/revoke") {
        const out = yield* workspaces
          .getByName(workspace.id)
          .oauthRevoke(fields["token"] ?? "", basic?.id ?? fields["client_id"] ?? "")

        if (out)
          yield* Effect.logInfo("oauth: a client signed itself out").pipe(
            Effect.annotateLogs({ trace, workspace: workspace.id }),
          )

        return cors(HttpServerResponse.empty({ status: 200 }))
      }

      if (route === "_oauth/device_authorization") {
        const started = yield* workspaces
          .getByName(workspace.id)
          .oauthDeviceStart(fields, basic, origin)

        yield* Effect.logInfo(
          started.status === 200
            ? `oauth: a device sign-in started (client ${basic?.id ?? fields["client_id"] ?? ""})`
            : `oauth: a device sign-in was refused: ${JSON.stringify(started.body["error_description"])}`,
        ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

        return oauthJson(started.body, started.status)
      }

      const resource = fields["resource"]

      if (resource !== undefined && !(yield* ourResource(workspace, resource)))
        return oauthJson(
          {
            error: "invalid_target",
            error_description: `${resource} isn't this workspace's MCP server: tokens here are for ${origin}/mcp only`,
          },
          400,
        )

      const answer = yield* workspaces.getByName(workspace.id).oauthToken(fields, basic, origin)

      yield* Effect.logInfo(
        answer.status === 200
          ? `oauth: tokens for ${fields["grant_type"] ?? ""} (client ${basic?.id ?? fields["client_id"] ?? ""})`
          : `oauth: token refused: ${JSON.stringify(answer.body["error_description"])}`,
      ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

      return oauthJson(answer.body, answer.status)
    })

    const authorize = Effect.fn("gateway.authorize")(function* (
      workspace: Workspace,
      url: URL,
      trace: string,
    ) {
      const request = yield* HttpServerRequest

      const page = (title: string, message: string, status: number) =>
        htmlOf(refusedPage(title, message, trace), { status, headers: WORKSPACE_PAGE })

      const { viewer } = yield* viewerOf(false, url.host)

      const answer = (
        next:
          | { readonly kind: "page"; readonly title: string; readonly message: string }
          | { readonly kind: "refused"; readonly message: string }
          | { readonly kind: "redirect"; readonly location: string },
      ) =>
        Match.value(next).pipe(
          Match.when({ kind: "page" }, (p) => page(p.title, p.message, 400)),
          Match.when({ kind: "refused" }, (r) => page("Can't sign in an agent", r.message, 403)),
          Match.when({ kind: "redirect" }, (r) =>
            HttpServerResponse.redirect(r.location, {
              status: request.method === "POST" ? 303 : 302,
              headers: { "cache-control": "no-store" },
            }),
          ),
          Match.exhaustive,
        )

      if (request.method === "POST") {
        const from = request.headers["origin"]

        if (
          request.headers["sec-fetch-site"] !== "same-origin" ||
          from === undefined ||
          !sameHost(from, url.origin)
        )
          return page(
            "Refused",
            "This choice didn't come from OpenBelt's own sign-in page, so nothing was allowed. Start again from your agent.",
            403,
          )

        const form = yield* cappedBody(request, 20_000)

        if (form.kind !== "read") return page("Refused", "The form is over 20 KB.", 400)

        const fields = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(form.bytes)))

        if (
          viewer === null ||
          fields["form"] !== (yield* session.formToken(viewer.email, url.host))
        )
          return page(
            "Refused",
            "This page's form token isn't yours (it was opened by someone else, or before you signed in): start again from your agent.",
            403,
          )

        return answer(
          yield* workspaces
            .getByName(workspace.id)
            .oauthDecide(
              workspace.name,
              fields["handle"] ?? "",
              url.origin,
              viewer,
              fields["decision"] === "allow" ? "allow" : "deny",
            ),
        )
      }

      if (request.method !== "GET")
        return page("Not here", "GET this page, from your agent's sign-in link.", 405)

      const decoded = decodeAuthorize(Object.fromEntries(url.searchParams))

      if (Option.isNone(decoded))
        return page(
          "Can't sign in",
          "This sign-in link is malformed: start again from your agent.",
          400,
        )

      const q = decoded.value

      const asked: AuthorizeRequest = {
        responseType: q.response_type ?? "",
        clientId: q.client_id ?? "",
        redirectUri: q.redirect_uri ?? "",
        state: q.state,
        scope: q.scope,
        challenge: q.code_challenge ?? "",
        challengeMethod: q.code_challenge_method ?? "",
        resource:
          q.resource === undefined
            ? undefined
            : { url: q.resource, ours: yield* ourResource(workspace, q.resource) },
      }

      const dest = request.headers["sec-fetch-dest"]

      const next = yield* workspaces
        .getByName(workspace.id)
        .oauthAuthorize(
          workspace.name,
          asked,
          url.origin,
          viewer,
          dest === undefined || dest === "document",
        )

      if (next.kind !== "consent") return answer(next)

      if (viewer === null) return page("Can't sign in an agent", "Nobody is signed in.", 403)

      return htmlOf(
        consentPage({
          workspace: workspace.name,
          client: { id: next.client.id, name: next.client.name, kind: next.client.kind },
          redirectHost: next.redirectHost,
          userCode: next.userCode,
          person: next.person,
          fields: { handle: next.handle },
          formToken: yield* session.formToken(viewer.email, url.host),
        }),
        { headers: WORKSPACE_PAGE },
      )
    })

    const admin = Effect.fn("gateway.admin")(function* (
      workspace: Workspace,
      origin: string,
      route: "tokens" | "workspace-admins" | "signin-links",
      trace: string,
    ) {
      const request = yield* HttpServerRequest

      if (!isAdminBearer(request.headers["authorization"], adminToken)) {
        return json(
          {
            error: `/_admin/${route} needs Authorization: Bearer <OPENBELT_ADMIN_TOKEN>`,
            code: "unauthorized",
            trace,
          },
          401,
        )
      }

      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""))

      if (route === "signin-links") {
        const body = Schema.decodeUnknownOption(WorkspaceAdminRequest)(text)

        if (signIn !== "email")
          return json(
            {
              error: `people sign in with an email code only under OPENBELT_SIGNIN=email; here it is ${signIn}`,
              code: "invalid",
              trace,
            },
            400,
          )

        if (Option.isNone(body))
          return json(
            { error: 'send JSON like {"email": "ada@acme.com"}', code: "invalid", trace },
            400,
          )

        const link = yield* workspaces.getByName(workspace.id).loginLink(body.value.email)

        yield* Effect.logInfo(
          `sign-in: the platform admin made a sign-in link for ${body.value.email}`,
        ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

        return json({
          workspace: workspace.name,
          email: body.value.email,
          url: `${origin}/_signin/link?t=${link.ticket}`,
          expires: new Date(link.until).toISOString(),
          trace,
        })
      }

      if (route === "workspace-admins") {
        const body = Schema.decodeUnknownOption(WorkspaceAdminRequest)(text)

        if (Option.isNone(body))
          return json(
            { error: 'send JSON like {"email": "ada@acme.com"}', code: "invalid", trace },
            400,
          )

        const person = yield* workspaces.getByName(workspace.id).makeAdmin(body.value.email)

        yield* Effect.logInfo(`the platform admin made ${person.email} an admin`).pipe(
          Effect.annotateLogs({ trace, workspace: workspace.id }),
        )

        return json({ workspace: workspace.name, person, trace })
      }

      const body = Schema.decodeUnknownOption(TokenRequest)(text)

      if (Option.isNone(body))
        return json(
          {
            error:
              'send JSON like {"email": "ada@acme.com"} (or "user", its older name), optionally with "days": 14 to expire it',
            code: "invalid",
            trace,
          },
          400,
        )

      const email = "email" in body.value ? body.value.email : body.value.user

      return yield* workspaces
        .getByName(workspace.id)
        .tokenFor(email, body.value.days)
        .pipe(
          Effect.map(({ person, token, id, expires }) =>
            json({
              workspace: workspace.name,
              user: person.email,
              person: person.id,
              id,
              token,
              expires: expires ?? "never",
              mcp: `${origin}/mcp`,
              trace,
            }),
          ),
          Effect.catchTag("Refused", (e) =>
            Effect.succeed(json({ error: e.message, code: "invalid", trace }, 400)),
          ),
        )
    })

    const refusedOverLimit = Effect.fnUntraced(function* (
      address: string,
      over: OverLimit,
      path: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest

      const message = `more than ${over.limit} ${over.which === "writes" ? "changes (requests other than GET)" : "requests"} a minute came from ${address === "person" ? "your account in this workspace" : "your address"}, the most this OpenBelt takes (${over.setting}): try again in ${over.retryAfter} s`

      Runtime.recordRefused("rate", over.which)

      if (logOver(address))
        yield* Effect.logWarning(
          `rate limit: ${address} sent more than ${over.limit} ${over.which} a minute (${over.setting}); refused ${request.method} ${path} and the rest of this minute's`,
        ).pipe(Effect.annotateLogs({ trace }))

      const headers = { "retry-after": String(over.retryAfter), "cache-control": "no-store" }

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (request.headers["accept"] ?? "").includes("text/html")
      )
        return htmlOf(outcomePage({ ok: false, title: "Too many requests", message }), {
          status: 429,
          headers,
        })

      return HttpServerResponse.jsonUnsafe(
        { error: message, code: "rate_limited", retryAfter: over.retryAfter, trace },
        { status: 429, headers },
      )
    })

    /**
     * What the platform is doing, for the operator (Authorization: Bearer OPENBELT_ADMIN_TOKEN): /_admin/logs (recent log lines,
     * filtered), /_admin/trace?id= (one trace: its spans across objects, the sandbox and SQL, and its log lines), /_admin/actors (every
     * object with data, awake or asleep), POST /_admin/actors/sleep?id= (put one to sleep), /_admin/metrics (OpenBelt's metrics, in
     * Prometheus' text format). bun run drive logs|trace|actors|metrics reads them.
     */
    const observe = Effect.fn("gateway.observe")(function* (path: string, url: URL, trace: string) {
      const request = yield* HttpServerRequest

      if (!isAdminBearer(request.headers["authorization"], adminToken)) {
        return json(
          {
            error: `${path} needs Authorization: Bearer <OPENBELT_ADMIN_TOKEN>`,
            code: "unauthorized",
            trace,
          },
          401,
        )
      }

      const query = url.searchParams
      const given = (name: string) => query.get(name) ?? undefined

      if (path === "/_admin/logs") {
        const level = given("level")
        const since = given("since")

        const lines = yield* Effect.promise(() =>
          Runtime.machineLogs({
            trace: given("trace"),
            workspace: given("workspace"),
            app: given("app"),
            level: level === undefined ? undefined : Option.getOrUndefined(decodeLevel(level)),
            since: since === undefined ? undefined : sinceOf(since),
            text: given("text"),
            limit: Math.min(5000, Math.max(1, Number(given("limit") ?? 200) || 200)),
          }),
        )

        return HttpServerResponse.jsonUnsafe(lines)
      }

      if (path === "/_admin/trace") {
        const id = given("id")

        if (id === undefined)
          return json({ error: "/_admin/trace needs ?id=<trace id>", code: "invalid", trace }, 400)

        return HttpServerResponse.jsonUnsafe(yield* Effect.promise(() => Runtime.machineTrace(id)))
      }

      if (path === "/_admin/metrics") {
        const openbelt = yield* Effect.promise(Runtime.machineMetrics)

        return HttpServerResponse.text(openbelt, {
          contentType: "text/plain; version=0.0.4; charset=utf-8",
        })
      }

      if (path === "/_admin/actors" && request.method === "GET") {
        const state = given("state")
        const object = given("object")

        const found = yield* Effect.promise(Runtime.localActors)

        return HttpServerResponse.jsonUnsafe(
          found.filter(
            (actor) =>
              (state === undefined || actor.state === state) &&
              (object === undefined || actor.object.includes(object)),
          ),
        )
      }

      if (path === "/_admin/actors/sleep" && request.method === "POST") {
        const id = given("id")

        if (id === undefined)
          return json(
            {
              error: "POST /_admin/actors/sleep needs ?id=<actor id> (from /_admin/actors)",
              code: "invalid",
              trace,
            },
            400,
          )

        const slept = yield* Effect.promise(() => Runtime.sleepActor(id))

        return slept
          ? HttpServerResponse.jsonUnsafe({ slept: id })
          : json(
              {
                error: `no process holds ${id} awake: is the id from /_admin/actors?`,
                code: "missing",
                trace,
              },
              404,
            )
      }

      return json(
        {
          error: `no ${request.method} ${path}: /_admin/logs, /_admin/trace, /_admin/metrics, /_admin/actors, POST /_admin/actors/sleep`,
          code: "missing",
          trace,
        },
        404,
      )
    })

    const inventory = Effect.fn("gateway.inventory")(function* (
      workspace: Workspace,
      trace: string,
    ) {
      const request = yield* HttpServerRequest

      if (!isAdminBearer(request.headers["authorization"], adminToken)) {
        return json(
          {
            error: "the inventory needs Authorization: Bearer <OPENBELT_ADMIN_TOKEN>",
            code: "unauthorized",
            trace,
          },
          401,
        )
      }

      const records = yield* workspaces.getByName(workspace.id).apps()

      const listed = yield* Effect.forEach(
        records,
        (r) => Effect.map(apps.getByName(r.id).inventory(), (held) => ({ app: r.name, ...held })),
        { concurrency: 8 },
      )

      const shown: Inventory = {
        apps: listed,
        environments: (yield* workspaces.getByName(workspace.id).environments()).map((e) => e.env),
        tokens: yield* workspaces.getByName(workspace.id).tokens(),
      }

      return HttpServerResponse.jsonUnsafe(shown, { headers: { "cache-control": "no-store" } })
    })

    /** What an app's panel shows its viewer (frame.ts): About and Share to a member, every page to its owner or an admin. */
    const panelShown = Effect.fn("gateway.panelShown")(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      panel: {
        readonly record: AppRecord
        readonly view: StoredView
        readonly access: PanelAccess
      },
      trace: string,
    ) {
      if (panel.access === "none")
        return json(
          { error: privateApp(panel.record.name, workspace.name), code: "private", trace },
          403,
        )

      const { record, access, view } = panel
      const holder = workspaces.getByName(workspace.id)
      const about = yield* holder.panelAbout(record.id, record.owner)
      const shown = yield* apps.getByName(record.id).panel(access === "manage")
      const notes = new Map((yield* holder.environments(record.id)).map((e) => [e.env, e]))

      return HttpServerResponse.jsonUnsafe(
        {
          app: record.name,
          url: frameUrl(workspaceOrigin, record.name),
          publicUrl:
            shown.published && publicHost !== ""
              ? publicUrl(workspaceOrigin, record.name, workspace.name, publicHost)
              : null,
          workspace: workspace.name,
          description: record.description,
          owner: { email: record.owner, name: about.ownerName },
          created: record.created,
          color:
            about.color !== null && /^#[0-9a-f]{6}$/.test(about.color)
              ? about.color
              : colorOfName(record.name),
          access,
          view: shown.published ? "public" : view,
          publicHost: publicHost !== "",
          live: shown.live,
          details:
            shown.details === null
              ? null
              : {
                  ...shown.details,
                  environments: shown.details.environments.map(({ env, version }) => ({
                    env,
                    version,
                    note: notes.get(env)?.note ?? "",
                    by: notes.get(env)?.by ?? "",
                    lastWrite: notes.get(env)?.lastWrite ?? "",
                  })),
                },
          trace,
        },
        { headers: { "cache-control": "no-store" } },
      )
    })

    /**
     * The owner of an app, or an admin, changing who can view it ("view") or what visitors can use ("public"): from its frame alone,
     * with the frame's form token. Public, and what visitors can use, is openbelt.json's "public", so each change to it deploys a
     * new live version.
     */
    const panelChanged = Effect.fn("gateway.panelChanged")(function* (
      workspace: Workspace,
      url: URL,
      name: string,
      viewer: Viewer | null,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const crossed = crossOrigin(request.headers, url.origin)

      if (viewer === null || crossed !== undefined || request.headers["origin"] === undefined)
        return json(
          {
            error: `Change who can view an app from the app's page on ${url.host}, signed in.`,
            code: "denied",
            trace,
          },
          403,
        )

      const body = yield* cappedBody(request, 2048)

      if (body.kind !== "read")
        return json({ error: "The request is too large.", code: "invalid", trace }, 400)

      const asked = Schema.decodeUnknownOption(PanelChange)(new TextDecoder().decode(body.bytes))

      if (Option.isNone(asked))
        return json(
          {
            error:
              'Send {"view": "private" | "workspace" | "public"} or {"public": <openbelt.json "public">}, with "form": "<the page\'s form token>".',
            code: "invalid",
            trace,
          },
          400,
        )

      if (asked.value.form !== (yield* session.formToken(viewer.email, url.host)))
        return json({ error: "Reload the app's page and try again.", code: "denied", trace }, 403)

      const { view, public: block } = asked.value
      const change = view === "public" ? (block ?? "open") : view === undefined ? block : null

      if (view === undefined && block === undefined)
        return json({ error: 'Send "view" or "public".', code: "invalid", trace }, 400)

      if (change !== null && change !== undefined && publicHost === "")
        return json(
          {
            error:
              "This OpenBelt has no public host (OPENBELT_PUBLIC_HOST), so no app can be public here.",
            code: "invalid",
            trace,
          },
          400,
        )

      const holder = workspaces.getByName(workspace.id)

      return yield* Effect.gen(function* () {
        const found = yield* holder.setView(
          name,
          viewer,
          view === "private" ? "private" : "workspace",
        )

        const deployed =
          change === undefined
            ? null
            : yield* apps.getByName(found.record.id).publish(change, viewer.email, trace)

        // A new live version, as deploy_app's: its picture and link preview cards are taken again.
        if (deployed !== null)
          yield* apps.getByName(found.record.id).shootSoon(appUrl(url.origin, name))

        return json({ version: deployed?.version ?? null, trace })
      }).pipe(
        Effect.catchTags({
          Refused: (e) => Effect.succeed(json({ error: e.message, code: "denied", trace }, 403)),
        }),
      )
    })

    /** POST /<app>/_delete from the Apps page: its owner or a workspace admin deletes the app, with all it holds. */
    const appDeleted = Effect.fn("gateway.appDeleted")(function* (
      workspace: Workspace,
      url: URL,
      name: string,
      viewer: Viewer | null,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const crossed = crossOrigin(request.headers, url.origin)

      if (viewer === null || crossed !== undefined || request.headers["origin"] === undefined)
        return json(
          {
            error: `Delete an app from the Apps page on ${url.host}, signed in.`,
            code: "denied",
            trace,
          },
          403,
        )

      const body = yield* cappedBody(request, 1024)

      if (body.kind !== "read")
        return json({ error: "The request is too large.", code: "invalid", trace }, 400)

      const asked = Schema.decodeUnknownOption(DeleteAsk)(new TextDecoder().decode(body.bytes))

      if (Option.isNone(asked))
        return json(
          { error: 'Send {"form": "<the page\'s form token>"}.', code: "invalid", trace },
          400,
        )

      if (asked.value.form !== (yield* session.formToken(viewer.email, url.host)))
        return json({ error: "Reload the page and try again.", code: "denied", trace }, 403)

      return yield* workspaces
        .getByName(workspace.id)
        .deleteApp(name, viewer, trace)
        .pipe(
          Effect.map((deleted) => json({ deleted: deleted.name, trace })),
          Effect.catchTags({
            Refused: (e) => Effect.succeed(json({ error: e.message, code: "denied", trace }, 403)),
          }),
        )
    })

    /** POST /_starters/<starter> from the Apps page: the viewer adds a starter app (starters.ts) to the workspace, as theirs. */
    const starterAdded = Effect.fn("gateway.starterAdded")(function* (
      workspace: Workspace,
      url: URL,
      workspaceOrigin: string,
      starter: string,
      viewer: Viewer | null,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const crossed = crossOrigin(request.headers, url.origin)

      if (viewer === null || crossed !== undefined || request.headers["origin"] === undefined)
        return json(
          {
            error: `Add a starter from the Apps page on ${url.host}, signed in.`,
            code: "denied",
            trace,
          },
          403,
        )

      const body = yield* cappedBody(request, 1024)

      if (body.kind !== "read")
        return json({ error: "The request is too large.", code: "invalid", trace }, 400)

      const asked = Schema.decodeUnknownOption(StarterAsk)(new TextDecoder().decode(body.bytes))

      if (Option.isNone(asked))
        return json(
          { error: 'Send {"form": "<the page\'s form token>"}.', code: "invalid", trace },
          400,
        )

      if (asked.value.form !== (yield* session.formToken(viewer.email, url.host)))
        return json({ error: "Reload the page and try again.", code: "denied", trace }, 403)

      const there = workspaces.getByName(workspace.id)
      const admission = yield* there.admit(viewer)

      if (admission?.kind !== "member")
        return json(
          { error: "Only the workspace's people add apps to it.", code: "denied", trace },
          403,
        )

      const name = asked.value.app ?? starter

      return yield* there
        .addStarter(
          starter,
          name,
          { email: viewer.email, person: admission.person.id },
          workspaceOrigin,
          trace,
        )
        .pipe(
          Effect.map(() => json({ app: name, url: frameUrl(workspaceOrigin, name), trace })),
          Effect.catchTags({
            Refused: (e) => Effect.succeed(json({ error: e.message, code: "denied", trace }, 403)),
          }),
        )
    })

    const manage = Effect.fn("gateway.manage")(function* (
      workspace: Workspace,
      origin: string,
      route: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const sent = BROWSER_HEADERS.filter((name) => request.headers[name] !== undefined)

      if (sent.length > 0) {
        return json(
          {
            error: `/_${route} takes an API token only (Authorization: Bearer), and this request carries ${sent.join(", ")}, which a browser sends: pages and cookies can't manage the workspace. Use bun run workspace, or curl with a token.`,
            code: "unauthorized",
            trace,
          },
          401,
        )
      }

      const token = bearer(request.headers["authorization"])

      if (token === undefined) return noToken(workspace.name, origin, `/_${route}`, trace)

      const body = yield* cappedBody(request, MAX_WRITE_BODY)

      if (body.kind === "over")
        return json(
          { error: `the body is over ${MAX_WRITE_BODY} bytes`, code: "invalid", trace },
          413,
        )

      if (body.kind === "cut") return json({ error: CUT_OFF, code: "invalid", trace }, 400)

      const text = new TextDecoder().decode(body.bytes)

      const { check, answer } = yield* workspaces
        .getByName(workspace.id)
        .api(workspace.name, token, route, request.method, text, trace, origin)

      if (route === "workspace/rename" && answer?.status === 200) yield* names.reread()

      if (answer === null) {
        return json(
          {
            error: tokenRefusal(workspace.name, check) ?? "",
            code: "unauthorized",
            trace,
          },
          401,
        )
      }

      return json(answer.body, answer.status)
    })

    const scimRoute = Effect.fn("gateway.scim")(function* (
      workspace: Workspace,
      origin: string,
      path: string,
      search: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest

      const token = bearer(request.headers["authorization"])

      if (token === undefined) {
        const refusal = scimError(
          401,
          `send a SCIM token: Authorization: Bearer <token>, made in Settings (People, Directory sync) or with bun run workspace scim token`,
        )

        return reply(refusal.status, refusal.body)
      }

      const body = yield* cappedBody(request, MAX_WRITE_BODY)

      if (body.kind !== "read") {
        const refusal = scimError(
          body.kind === "over" ? 413 : 400,
          body.kind === "over" ? `the body is over ${MAX_WRITE_BODY} bytes` : CUT_OFF,
        )

        return reply(refusal.status, refusal.body)
      }

      const answer = yield* workspaces
        .getByName(workspace.id)
        .scim(
          workspace.name,
          token,
          request.method,
          path,
          search,
          new TextDecoder().decode(body.bytes),
          trace,
          origin,
        )

      return reply(answer.status, answer.body)
    })

    const workspacePicker = (workspace: Workspace, url: URL) =>
      signIn === "email"
        ? `${url.protocol}//${baseOf(url.hostname)}${url.port === "" ? "" : `:${url.port}`}/_start?switch=1&current=${workspace.id}`
        : "/"

    const home = Effect.fn("gateway.home")(function* (
      workspace: Workspace,
      origin: string,
      workspaceOrigin: string,
      url: URL,
      trace: string,
    ) {
      const who = yield* viewerOf(false, url.host)
      const refusal = yield* admit(workspace, who, false, trace)

      if (refusal !== undefined) return refusal

      // One page of the workspace's directory: a workspace can have thousands of apps, and none is woken for the page (directory.ts).
      const asked = url.searchParams
      const sorted = asked.get("sort")
      const from = Math.max(0, Math.floor(Number(asked.get("from") ?? "0")) || 0)

      const ask: PageAsk = {
        q: (asked.get("q") ?? "").slice(0, 200),
        sort: sorted === "created" || sorted === "name" ? sorted : "updated",
        offset: from,
        limit: HOME_PAGE_CARDS,
      }

      const found = yield* workspaces
        .getByName(workspace.id)
        .gallery(ask, HOME_SHELF, who.viewer?.email ?? null)

      const next = from + found.apps.length < found.total ? from + found.apps.length : null
      const viewerEmail = who.viewer?.email ?? null

      // Its owner or a workspace admin may delete an app; the workspace checks again when asked.
      const card = (app: Listed) =>
        cardOf(app, viewerEmail !== null && (found.admin || app.owner === viewerEmail))

      // A starter's name another app already has: that app, and the free name to add the starter as instead.
      const takenOf = (starter: string) => {
        const taken = found.taken[starter]

        return taken === undefined ? null : { card: card(taken.app), free: taken.free }
      }

      if (asked.get("grid") === "1") {
        const parts = galleryParts(
          found.apps.map(card),
          { q: ask.q, sort: ask.sort, from, total: found.total },
          workspaceOrigin,
          who.viewer?.email ?? null,
        )

        return HttpServerResponse.jsonUnsafe(
          { html: parts.grid, hero: parts.hero, total: found.total, next },
          { headers: { "cache-control": "no-store" } },
        )
      }

      return htmlOf(
        homePage({
          workspace: workspace.name,
          workspaceOrigin,
          switcher: workspacePicker(workspace, url),
          mcp: signingInAt(workspace, url, workspaceOrigin),
          viewer: who.viewer,
          form: who.viewer === null ? null : yield* session.formToken(who.viewer.email, url.host),
          signOut: who.session !== null,
          asks: found.asks,
          tab: asked.get("tab") === "starters" ? "starters" : "yours",
          starter: asked.get("starter"),
          // Only someone signed in can add one, so only they see them.
          starters:
            who.viewer === null
              ? []
              : STARTERS.map((s) => ({
                  name: s.name,
                  description: s.description,
                  icon: s.icon,
                  color: s.color,
                  picture: s.picture.kind === "current" ? starterPictureVersion(s) : null,
                  app: found.starters[s.name]?.app ?? null,
                  // As for any app: its owner or a workspace admin may remove it (the workspace checks again when asked).
                  manage: found.admin || found.starters[s.name]?.owner === who.viewer?.email,
                  inside: s.inside,
                  taken: takenOf(s.name),
                })),
          gallery: {
            cards: found.apps.map(card),
            total: found.total,
            next,
            from,
            recent: found.recent.map(card),
            jump: found.jump.map((j) => ({ card: card(j.app), opened: j.opened })),
            q: ask.q,
            sort: ask.sort,
          },
        }),
        { headers: HOME_PAGE },
      )
    })

    const settings = Effect.fn("gateway.settings")(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      url: URL,
      section: "connections" | "agents",
      notice: Notice | null,
      fields: Readonly<Record<string, string>>,
      trace: string,
      open: string | null = null,
    ) {
      const { viewer } = yield* viewerOf(false, url.host)
      const query = url.searchParams
      const pick = (name: string) => fields[name] ?? query.get(name)

      const ask =
        section === "connections"
          ? askOf(pick("connect"), pick("for") ?? query.get("app"), pick("env"))
          : null

      const back = backTo(pick("return"), workspaceOrigin)

      const shown = yield* workspaces
        .getByName(workspace.id)
        .account(workspace.name, viewer, ask, workspaceOrigin)

      const signedIn = query.get("signed_in")

      const said =
        notice ??
        (signedIn === null || !/^[a-z][a-z0-9-]{0,29}$/.test(signedIn)
          ? null
          : doneNotice(
              `${connectionLabel(signedIn)} is connected. Go back to your agent; you can close this tab.`,
            ))

      if (shown.kind === "refused" || viewer === null) {
        return htmlOf(
          deniedPage(
            workspace.name,
            viewer === null ? "Nobody is signed in" : `Not a member of ${workspace.name}`,
            (shown.kind === "refused" ? shown.message : null) ??
              `Settings are for whoever the workspace's front door (Tailscale) says you are, and it says nobody. Open ${workspaceOrigin}/_settings from a device signed in to the workspace.`,
            trace,
            null,
          ),
          { status: 403, headers: WORKSPACE_PAGE },
        )
      }

      const formToken = yield* session.formToken(viewer.email, url.host)

      if (section === "agents")
        return htmlOf(
          agentsPage(
            workspace.name,
            workspaceOrigin,
            signingInAt(workspace, url, workspaceOrigin),
            shown.page,
            formToken,
            notice,
          ),
          {
            headers: WORKSPACE_PAGE,
          },
        )

      const name = open ?? (fields["c"] === undefined || fields["c"] === "" ? null : fields["c"])

      const view =
        name === null ? undefined : shown.page.connections.find((v) => v.connection === name)

      if (name !== null && view === undefined)
        return htmlOf(
          connectionsPage(
            workspace.name,
            workspaceOrigin,
            workspacePicker(workspace, url),
            shown.page,
            formToken,
            back,
            refusedNotice(`there's no connection "${name}" in ${workspace.name}`),
          ),
          { status: 404, headers: WORKSPACE_PAGE },
        )

      return htmlOf(
        view === undefined
          ? connectionsPage(
              workspace.name,
              workspaceOrigin,
              workspacePicker(workspace, url),
              shown.page,
              formToken,
              back,
              said,
              notice === null && signedIn !== null && /^[a-z][a-z0-9-]{0,29}$/.test(signedIn)
                ? signedIn
                : null,
              pick("step") === "token" ? "token" : null,
            )
          : connectionPage(
              workspace.name,
              workspaceOrigin,
              workspacePicker(workspace, url),
              shown.page,
              view,
              formToken,
              back,
              said,
              url.searchParams.get("scope"),
            ),
        { headers: WORKSPACE_PAGE },
      )
    })

    const signInReturned = Effect.fn("gateway.signInReturned")(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      url: URL,
      trace: string,
    ) {
      const { viewer } = yield* viewerOf(false, url.host)

      const done = yield* workspaces.getByName(workspace.id).signInReturned(
        workspace.name,
        viewer,
        Object.fromEntries(url.searchParams),
        trace,
        workspaceOrigin,
        // Where it came back to, as the provider was told: an old name's host after a rename.
        `${url.origin}${url.pathname}`,
      )

      if (done.ok) {
        const back =
          /^\/_connections(\/[a-z0-9-]+)?(\?|$)/.test(done.back) && !done.back.includes("//")
            ? done.back
            : `/_connections/${done.connection}`

        const there = new URL(back, workspaceOrigin)

        const app = done.allowed ? backTo(there.searchParams.get("return"), workspaceOrigin) : null

        if (app !== null)
          return HttpServerResponse.redirect(app, {
            status: 303,
            headers: { "cache-control": "no-store" },
          })

        there.searchParams.set("signed_in", done.connection)

        return HttpServerResponse.redirect(`${there.pathname}${there.search}`, {
          status: 303,
          headers: { "cache-control": "no-store" },
        })
      }

      const failed = yield* settings(
        workspace,
        workspaceOrigin,
        new URL("/_connections", workspaceOrigin),
        "connections",
        refusedNotice(done.message),
        {},
        trace,
      )

      return HttpServerResponse.setStatus(failed, 400)
    })

    const connectNow = Effect.fn("gateway.connectNow")(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      url: URL,
      connection: string,
      trace: string,
    ) {
      const { viewer } = yield* viewerOf(false, url.host)

      const done = yield* workspaces.getByName(workspace.id).accountAction(
        workspace.name,
        viewer,
        "connect",
        {
          connection,
          whose: url.searchParams.get("for") === "workspace" ? "workspace" : "me",
          here: "",
          scope: url.searchParams.get("scope") ?? "",
        },
        trace,
        workspaceOrigin,
      )

      if (done.ok && done.go !== undefined)
        return HttpServerResponse.redirect(done.go, {
          status: 302,
          headers: { "cache-control": "no-store" },
        })

      const page = yield* settings(
        workspace,
        workspaceOrigin,
        new URL(`/_connections/${connection}`, workspaceOrigin),
        "connections",
        done,
        {},
        trace,
        connection,
      )

      return HttpServerResponse.setStatus(page, 400)
    })

    const settingsPost = Effect.fn("gateway.settingsPost")(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      url: URL,
      action: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const fetched = request.headers["sec-fetch-site"]
      const from = request.headers["origin"]

      const refuse = (why: string, viewer: Viewer | null) =>
        Effect.logWarning(`refused POST /_settings/${action}: ${why}`).pipe(
          Effect.annotateLogs({ trace, workspace: workspace.id }),
          Effect.as(
            htmlOf(
              deniedPage(
                workspace.name,
                "Refused",
                `This change was refused and nothing changed: ${why}. Changes come only from your settings pages themselves (${workspaceOrigin}/_settings): open them and do it there.`,
                trace,
                viewer,
              ),
              { status: 403, headers: WORKSPACE_PAGE },
            ),
          ),
        )

      if (fetched !== "same-origin")
        return yield* refuse(
          `it came from ${fetched === undefined ? "no page (no Sec-Fetch-Site)" : `a page with Sec-Fetch-Site: ${fetched}`}${from === undefined ? "" : ` (${from})`}`,
          null,
        )

      if (from === undefined || !sameHost(from, url.origin))
        return yield* refuse(`its Origin is ${from ?? "missing"}, not ${url.origin}`, null)

      const asked = decodeAction(action)

      if (Option.isNone(asked)) return yield* refuse(`there's no settings action "${action}"`, null)

      const limit = asked.value === "connections/icon" ? 1_000_000 : 20_000
      const form = yield* cappedBody(request, limit)

      if (form.kind === "over") return yield* refuse(`the form is over ${limit / 1000} KB`, null)

      if (form.kind === "cut") return yield* refuse(CUT_OFF, null)

      const contentType = request.headers["content-type"] ?? ""

      const fields = contentType.startsWith("multipart/form-data")
        ? yield* multipartFields(form.bytes, contentType)
        : Object.fromEntries(new URLSearchParams(new TextDecoder().decode(form.bytes)))

      const { viewer } = yield* viewerOf(false, url.host)

      if (viewer === null) return yield* refuse("nobody is signed in", null)

      if (fields["form"] !== (yield* session.formToken(viewer.email, url.host)))
        return yield* refuse(
          "the form token isn't the one your settings page gave you (reload it)",
          viewer,
        )

      const { form: _, ...rest } = fields

      const done = yield* workspaces
        .getByName(workspace.id)
        .accountAction(workspace.name, viewer, asked.value, rest, trace, workspaceOrigin)

      // Renamed: this process knows the new name at once (the others within DIRECTORY_FRESH_MS), for the page it goes on to.
      if (asked.value === "rename" && done.ok) yield* names.reread()

      if (!done.ok) {
        yield* Effect.logInfo(`${viewer.email}: settings ${action} refused: ${done.message}`).pipe(
          Effect.annotateLogs({ trace, workspace: workspace.id }),
        )
      }

      const back = backTo(rest["return"], workspaceOrigin)

      if (done.ok && done.go !== undefined)
        return HttpServerResponse.redirect(done.go, {
          status: 303,
          headers: { "cache-control": "no-store" },
        })

      if (asked.value === "allow" && done.ok && back !== null)
        return HttpServerResponse.redirect(back, {
          status: 303,
          headers: { "cache-control": "no-store" },
        })

      const after = pageAfter(asked.value, rest, done.ok)

      return after === "connections" || after === "agents"
        ? yield* settings(workspace, workspaceOrigin, url, after, done, rest, trace)
        : yield* workspaceSettings(workspace, url, after, done, trace, rest)
    })

    const workspaceSettings = Effect.fn("gateway.workspaceSettings")(function* (
      workspace: Workspace,
      url: URL,
      page: WorkspacePage,
      notice: Notice | null,
      trace: string,
      fields: Readonly<Record<string, string>> = {},
    ) {
      if (page.kind === "events") return yield* events(workspace, url, trace, notice, fields)

      if (page.kind === "requests") return yield* asks(workspace, url, trace, notice)

      const { viewer } = yield* viewerOf(false, url.host)
      const shown = yield* workspaces.getByName(workspace.id).workspacePage(viewer, url.origin)

      if (page.kind === "connections" && url.search !== "")
        return HttpServerResponse.redirect(`/_connections${url.search}`, { status: 301 })

      if (isConnectionsPage(page) && shown.kind === "refused")
        return HttpServerResponse.redirect("/_connections", {
          status: 302,
          headers: { "cache-control": "no-store" },
        })

      if (shown.kind === "refused" || viewer === null)
        return adminsOnly(
          workspace.name,
          "People and Groups",
          shown.kind === "refused" ? shown.admins : [],
          trace,
          viewer,
        )

      const formToken = yield* session.formToken(viewer.email, url.host)

      const made = workspaceSettingsPage(
        workspace.name,
        url.origin,
        shown.page,
        page,
        formToken,
        notice,
        fields,
      )

      return htmlOf(made.html, { status: made.status, headers: WORKSPACE_PAGE })
    })

    const events = Effect.fn("gateway.events")(function* (
      workspace: Workspace,
      url: URL,
      trace: string,
      notice: Notice | null = null,
      fields: Readonly<Record<string, string>> = {},
    ) {
      const { viewer } = yield* viewerOf(false, url.host)

      const pick = (name: string) => (fields[name] ?? url.searchParams.get(name) ?? "").trim()

      const query = Schema.decodeUnknownOption(EventsQuery)({
        q: pick("q").slice(0, 200),
        person: pick("person").slice(0, 200),
        tool: pick("tool").slice(0, 200),
        app: pick("app").slice(0, 200),
        source: pick("source") || "all",
        outcome: pick("outcome") || "all",
        page: Number(pick("page")),
      })

      if (Option.isNone(query))
        return htmlOf(
          refusedPage(
            "Invalid event filters",
            "Choose a source and result from the Events page, and a page number from 0 to 110.",
            trace,
          ),
          { status: 400 },
        )
      const shown = yield* workspaces.getByName(workspace.id).eventsPage(viewer, query.value)

      if (shown.kind === "refused")
        return adminsOnly(workspace.name, "Events", shown.admins, trace, viewer)

      return htmlOf(eventsPage(workspace.name, shown.page, notice), { headers: WORKSPACE_PAGE })
    })

    const asks = Effect.fn("gateway.asks")(function* (
      workspace: Workspace,
      url: URL,
      trace: string,
      notice: Notice | null = null,
    ) {
      const { viewer } = yield* viewerOf(false, url.host)
      const shown = yield* workspaces.getByName(workspace.id).asksPage(viewer)

      if (shown.kind === "refused" || viewer === null)
        return adminsOnly(
          workspace.name,
          "Access requests",
          shown.kind === "refused" ? shown.admins : [],
          trace,
          viewer,
        )

      const formToken = yield* session.formToken(viewer.email, url.host)

      return htmlOf(asksPage(workspace.name, shown.page, formToken, notice), {
        headers: WORKSPACE_PAGE,
      })
    })

    const pageTools = Effect.fn("gateway.tools")(function* (
      workspace: Workspace,
      name: string,
      path: string,
      origin: string,
      workspaceOrigin: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const [, under, call] = TOOLS_ROUTE.exec(path) ?? []
      const env = under
      const crossed = crossOrigin(request.headers, origin)

      if (crossed !== undefined) {
        const message = `a page of another origin (${crossed}) called "${name}"'s connection tools on ${origin}, so it was refused and nothing ran. Only "${name}"'s own pages call its tools, as whoever is viewing them.`
        const record = yield* workspaces.getByName(workspace.id).app(name)

        if (record !== null)
          yield* apps
            .getByName(record.id)
            .note("warn", trace, `refused ${request.method} /${path}: ${message}`)

        return json(
          {
            error: message,
            code: "cross_origin",
            fix: "Call tools.call from the app's own pages",
            trace,
          },
          403,
        )
      }

      const method = call === undefined ? "GET" : "POST"

      if (request.method !== method) {
        return json(
          {
            error: `${call === undefined ? "/_tools lists the app's tools (GET)" : "/_tools/call calls one (POST)"}; this was a ${request.method}`,
            code: "method",
            fix: 'Use tools.call and tools.list from "/sdk.js"',
            trace,
          },
          405,
        )
      }

      let asked: {
        readonly tool: string
        readonly input: Json
        readonly fields: ReadonlyArray<string> | undefined
      } | null = null

      if (call !== undefined) {
        // A form can't send JSON, so a page of another origin can't post one here without a preflight.
        if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
          return json(
            {
              error: "tools.call sends JSON (content-type: application/json)",
              code: "invalid",
              fix: 'Use tools.call from "/sdk.js"',
              trace,
            },
            415,
          )
        }

        const read = yield* cappedBody(request, 256_000)

        if (read.kind === "cut") return json({ error: CUT_OFF, code: "invalid", trace }, 400)

        const body =
          read.kind === "read"
            ? Schema.decodeUnknownOption(ToolCallBody)(new TextDecoder().decode(read.bytes))
            : Option.none()

        if (Option.isNone(body)) {
          return json(
            {
              error: `send {"tool": "<connection>.<tool>", "input": {...}, "fields": ["name", ...] (optional)}${read.kind === "over" ? " under 256 KB" : ""}`,
              code: "invalid",
              fix: 'tools.call("deepwiki.ask_wiki_question", { repoName, question })',
              trace,
            },
            400,
          )
        }

        asked = { tool: body.value.tool, input: body.value.input ?? {}, fields: body.value.fields }
      }

      const who = yield* viewerOf(env !== undefined, new URL(origin).host)
      const test = env !== undefined && who.person !== null ? who.person.email : null

      const answer = yield* workspaces
        .getByName(workspace.id)
        .pageTools(
          workspace.name,
          name,
          env,
          who.viewer,
          test,
          who.checkedBy,
          asked,
          trace,
          workspaceOrigin,
          request.headers["x-openbelt-readonly"] === "1",
        )

      return HttpServerResponse.jsonUnsafe(answer.body, {
        status: answer.status,
        headers: { "cache-control": "no-store" },
      })
    })

    /**
     * The AppDO of `record`, sent the request with what only the gateway may say about it. A body
     * is read here first, as far as any AppDO route reads one (a /_db write's): sent on as it
     * streams, a body cut off between two chunks reaches the AppDO as one that ended there, and
     * would run as if it were whole. Past that it's sent as none, with x-openbelt-body: over.
     */
    const forward = Effect.fnUntraced(function* (
      id: string,
      path: string,
      said: Headers.Headers,
      audience: Audience,
    ) {
      const request = yield* HttpServerRequest

      const headers = Headers.merge(
        Headers.removeMany(request.headers, GATEWAY_HEADERS),
        Headers.set(Headers.set(said, "x-openbelt-path", path), AUDIENCE_HEADER, audience),
      )

      if (request.method === "GET" || request.method === "HEAD")
        return yield* apps.getByName(id).fetch(request.modify({ headers }))

      const body = yield* cappedBody(request, MAX_WRITE_BODY)

      if (body.kind === "cut")
        return json({ error: CUT_OFF, code: "invalid", trace: said["x-openbelt-trace"] ?? "" }, 400)

      const url = new URL(request.originalUrl, `http://${request.headers["host"] ?? host}`)

      if (request.headers["x-forwarded-proto"] === "https") url.protocol = "https:"

      const sent = Headers.removeMany(headers, ["content-length", "transfer-encoding"])

      return yield* apps.getByName(id).fetch(
        fromWeb(
          new Request(url.href, {
            method: request.method,
            headers: body.kind === "over" ? Headers.set(sent, "x-openbelt-body", "over") : sent,
            body: body.kind === "over" ? null : body.bytes,
          }),
        ),
      )
    })

    const serve = Effect.fn("gateway.serve")(function* (
      workspace: Workspace,
      name: string,
      caller: string,
      path: string,
      origin: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const isData = SHARED_ROUTE.test(path)
      const env = /^_preview\/([^/]+)/.exec(path)?.[1]
      const writes = isData && request.method !== "GET" && request.method !== "HEAD"
      const onHost = new URL(origin).host
      const { viewer: who, person, checked, checkedBy } = yield* viewerOf(env !== undefined, onHost)
      const crossed = DATA_ROUTE.test(path) ? crossOrigin(request.headers, origin) : undefined

      if (writes && crossed === undefined && person !== null && env === undefined) {
        return json(
          {
            error: `${person.email} is a test person, so this write to the live app was refused and nothing was saved: ${TEST_PEOPLE_LIVE}`,
            code: "live_from_preview",
            hint: TEST_PEOPLE_LIVE,
            trace,
          },
          403,
        )
      }

      const { admission, record, envMissing, inEnv, hidden } = yield* workspaces
        .getByName(workspace.id)
        .route(
          name,
          env,
          writes && crossed === undefined ? (who?.email ?? "anonymous") : undefined,
          who,
          checked,
        )

      const refusal = refused(
        workspace.name,
        admission,
        DATA_ROUTE.test(path) || name !== caller,
        trace,
      )

      if (refusal !== undefined) {
        yield* Effect.logInfo(
          `refused ${who?.email ?? "a signed-out visitor"}: ${admission.kind}`,
        ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id, app: name }))

        return refusal
      }

      if (record === null) {
        const message = `there's no app "${name}" in ${workspace.name}`

        return isData || name !== caller
          ? json(
              { error: `${message}: db.apps() lists the workspace's apps`, code: "missing", trace },
              404,
            )
          : HttpServerResponse.text(`There's no app "${name}" in ${workspace.name}.\n`, {
              status: 404,
            })
      }

      if (hidden && name === caller) {
        const message = privateApp(name, workspace.name)

        return DATA_ROUTE.test(path)
          ? json({ error: message, code: "private", trace }, 403)
          : htmlOf(refusedPage(`${name} is private`, message, trace), {
              status: 403,
              headers: { "cache-control": "no-store" },
            })
      }

      if (crossed !== undefined) {
        const message = `a page of another origin (${crossed}) called "${name}"'s ${path.replace(/^_preview\/[^/]+\//, "")} on ${origin}, so it was refused and nothing was read or changed. A page reaches OpenBelt's data only through its own app's host, which is how OpenBelt knows which app it is: from another app's pages, use db.app("${name}") (docs/sdk.md).`

        yield* apps
          .getByName(record.id)
          .note("warn", trace, `refused ${request.method}: ${message}`)

        return json({ error: message, code: "cross_origin", trace }, 403)
      }

      if (envMissing) {
        const message = `there's no preview environment "${env}" in ${workspace.name}: it was never deployed into, or it was deleted after 7 days without deploys or writes. app_info({ app: "${name}" }) lists the environments it's in; deploy_app({ app: "${name}", preview: "${env}", ... }) makes it.`

        return isData || name !== caller
          ? json({ error: message, code: "missing", trace }, 404)
          : htmlOf(
              refusedPage(
                `No preview called "${env ?? ""}"`,
                "It may have expired. Open the live app, or ask your agent for a new preview link.",
                trace,
                undefined,
                { href: "/", text: "Open the live app" },
                message.charAt(0).toUpperCase() + message.slice(1),
              ),
              { status: 404 },
            )
      }

      let said = Headers.fromInput({ "x-openbelt-trace": trace, "x-openbelt-caller": caller })
      const from = refererEnv(request.headers["referer"], origin)

      if (from !== undefined) said = Headers.set(said, "x-openbelt-caller-env", from)

      if (who !== null) {
        said = Headers.set(said, "x-openbelt-viewer", who.email)
        said = Headers.set(said, "x-openbelt-viewer-name", encodeURIComponent(who.name))
      }

      // A page a browser opens shows the person's theme before it paints (reporter.ts): asked only then, never for its files and data.
      const dest = request.headers["sec-fetch-dest"]

      if (who !== null && request.method === "GET" && (dest === "document" || dest === "iframe"))
        said = Headers.set(said, THEME_HEADER, (yield* apex.theme(who.email)) ?? "system")

      if (admission.kind === "member")
        said = Headers.set(said, "x-openbelt-viewer-groups", admission.person.groups.join(","))

      if (person !== null && who !== null) {
        said = Headers.set(
          said,
          "x-openbelt-viewer-groups",
          inEnv ? (person.groups ?? []).join(",") : "",
        )

        if (checkedBy !== null && checkedBy !== "")
          said = Headers.set(said, "x-openbelt-viewer-for", checkedBy)
      }

      const filePath = /^(?:_preview\/[^/]+\/)?_files(?:\/([A-Za-z0-9-]+))?$/.exec(path)

      if (filePath !== null)
        return yield* files(
          workspace.id,
          record.id,
          name,
          caller,
          filePath[1],
          env ?? "",
          who?.email ?? "anonymous",
          trace,
        )

      return yield* forward(record.id, path, said, "workspace")
    })

    /**
     * A stored file's bytes (GET, HEAD, with Range): from the store alone, no object woken. `maxAge` (seconds) caps how long it is cached,
     * for a signed url that stops working sooner than a page's url does.
     */
    const download = Effect.fn("gateway.download")(function* (
      key: string,
      id: string,
      appId: string,
      trace: string,
      maxAge?: number,
    ) {
      const request = yield* HttpServerRequest
      const found = yield* Effect.promise(() => Runtime.fileStore.head(key))

      if (found === null) {
        yield* apps
          .getByName(appId)
          .note(
            "warn",
            trace,
            `file not found: ${id} (deleted, never stored, or another app's: a file's url works on its own app's host)`,
          )

        return json({ error: `there's no file ${id} in this app`, code: "missing", trace }, 404)
      }

      const served = fileHeaders(id, found.type)

      const headers =
        maxAge === undefined
          ? served
          : { ...served, "cache-control": `private, max-age=${Math.max(0, maxAge)}` }

      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers["range"] ?? "")

      if (range !== null && found.size > 0) {
        const [, from = "", to = ""] = range
        const start = from === "" ? Math.max(0, found.size - Number(to)) : Number(from)

        const end = from === "" || to === "" ? found.size - 1 : Math.min(Number(to), found.size - 1)

        if (start > end || start >= found.size)
          return HttpServerResponse.empty({
            status: 416,
            headers: { "content-range": `bytes */${found.size}` },
          })

        if (request.method === "GET") Runtime.recordFileDownload(end - start + 1)

        return HttpServerResponse.fromWeb(
          new Response(request.method === "HEAD" ? null : Runtime.fileStore.read(key, start, end), {
            status: 206,
            headers: {
              ...headers,
              "content-range": `bytes ${start}-${end}/${found.size}`,
              "content-length": String(end - start + 1),
            },
          }),
        )
      }

      if (request.method === "GET") Runtime.recordFileDownload(found.size)

      return HttpServerResponse.fromWeb(
        new Response(request.method === "HEAD" ? null : Runtime.fileStore.read(key), {
          headers: { ...headers, "content-length": String(found.size) },
        }),
      )
    })

    /** Uploads in flight in this process (Runtime.fileLimits.inFlight at most). */
    let uploading = 0

    /**
     * An app's files: POST /_files streams the body to the file store (files.ts) here in the gateway, never through an object;
     * WorkspaceDO holds the workspace's room for it first, AppDO keeps its record. GET and HEAD answer from the store alone (no object woken).
     */
    const files = Effect.fn("gateway.files")(function* (
      workspaceId: WorkspaceId,
      appId: string,
      appName: string,
      caller: string,
      id: string | undefined,
      env: string,
      author: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const sent = request.source instanceof Request ? request.source.body : null
      const app = apps.getByName(appId)
      const workspace = workspaces.getByName(workspaceId)

      yield* Effect.annotateCurrentSpan({
        "file.method": request.method,
        "file.store": Runtime.fileStore.kind,
      })

      if (request.method !== "GET" && request.method !== "HEAD" && caller !== appName)
        return json(
          {
            error: `${caller}'s pages read "${appName}"'s files (GET /a/${appName}/_files/<id>), but upload and delete them only on "${appName}"'s own pages`,
            code: "not_writable",
            trace,
          },
          403,
        )

      // Off (OPENBELT_UPLOADS): nothing new is stored or deleted; a file already stored is still read.
      if (!uploads && request.method !== "GET" && request.method !== "HEAD")
        return json(
          {
            error:
              "This OpenBelt doesn't take uploads: keep what the app needs in documents (db.collection), or link to files hosted elsewhere",
            code: "uploads_off",
            trace,
          },
          403,
        )

      if (request.method === "POST" && id === undefined) {
        const length = Number(request.headers["content-length"] ?? NaN)
        const type = request.headers["content-type"] ?? "application/octet-stream"
        const named = request.headers["x-openbelt-file-name"]
        const name = named === undefined ? null : decodeURIComponent(named).slice(0, 255)
        const what = `${name === null ? "a file" : `"${name}"`} (${type}, ${Number.isFinite(length) ? sizeOf(length) : "no length"})`

        const refuse = Effect.fnUntraced(function* (
          status: number,
          code: ErrorCode,
          outcome: string,
          message: string,
          headers: Record<string, string> = {},
        ) {
          Runtime.recordFileUpload(outcome, 0, 0)
          yield* app.note("warn", trace, `file upload refused: ${what} by ${author}: ${message}`)

          return HttpServerResponse.setHeaders(
            json({ error: message, code, trace }, status),
            headers,
          )
        })

        if (!Number.isFinite(length))
          return yield* refuse(
            411,
            "invalid",
            "invalid",
            "a file upload needs its Content-Length: send a Blob or File as the body",
          )

        if (length > Runtime.fileLimits.file)
          return yield* refuse(
            413,
            "file_too_large",
            "too_large",
            `files are limited to ${sizeOf(Runtime.fileLimits.file)}; this one is ${sizeOf(length)}. Make it smaller (resize an image, compress a video) or split it.`,
          )

        if (uploading >= Runtime.fileLimits.inFlight)
          return yield* refuse(
            503,
            "busy",
            "busy",
            `${uploading} uploads are under way on this server, its most at once: try again in a few seconds`,
            { "retry-after": "5", "x-openbelt-busy": "1" },
          )

        const free = yield* Effect.promise(Runtime.diskFree)

        if (free !== undefined && free - length < Runtime.fileLimits.floor)
          return yield* refuse(
            507,
            "disk_low",
            "disk_low",
            `the server's disk has ${sizeOf(free)} free, and uploads stop ${sizeOf(Runtime.fileLimits.floor)} before it fills: ask whoever runs OpenBelt to free space or move files to S3 (OPENBELT_FILES)`,
          )

        const room = yield* workspace.filesReserve(appId, length, Runtime.fileLimits.workspace)

        if (!room.ok)
          return yield* refuse(
            507,
            "workspace_storage_full",
            "workspace_full",
            `the workspace has used ${sizeOf(room.used)} of its ${sizeOf(Runtime.fileLimits.workspace)} for files, and this one is ${sizeOf(length)}: delete files it no longer needs (files.delete(id); /_settings shows which apps use the most)`,
          )

        const fileId = crypto.randomUUID()
        const began = performance.now()

        uploading++
        Runtime.recordFilesInFlight(uploading)

        const put = yield* Effect.promise(() =>
          Runtime.fileStore.put(
            `${workspaceId}/${appId}/${fileId}`,
            sent ?? new Blob([]).stream(),
            type,
            length,
            Runtime.fileLimits.file,
          ),
        ).pipe(
          Effect.withSpan("files.put", {
            attributes: { "file.bytes": length, "file.store": Runtime.fileStore.kind },
          }),
          Effect.ensuring(
            Effect.sync(() => {
              uploading--
              Runtime.recordFilesInFlight(uploading)
            }),
          ),
        )

        const ms = Math.round(performance.now() - began)

        if ("error" in put) {
          yield* workspace.filesRelease(appId, length)

          const cut = put.failed === "cut_off"

          if (put.failed === "store_error") Runtime.recordFileStoreError("put")
          Runtime.recordFileUpload(put.failed, 0, ms)
          yield* app.note(
            put.failed === "store_error" ? "error" : "warn",
            trace,
            put.failed === "store_error"
              ? `file upload failed: ${what} by ${author}: the file store (${Runtime.fileStore.kind}) said ${put.error}`
              : `file upload ${cut ? "cut off" : "refused"}: ${what} by ${author}: ${put.error} after ${ms} ms, so nothing was kept${cut ? " (the client stopped sending: a closed tab, a lost network)" : ""}`,
          )

          return json(
            {
              error:
                put.failed === "store_error"
                  ? `the file couldn't be stored: ${put.error}`
                  : `${put.error}, so nothing was kept: send it again`,
              code: put.failed === "store_error" ? "storage" : cut ? "invalid" : "file_too_large",
              trace,
            },
            put.failed === "store_error" ? 502 : cut ? 400 : 413,
          )
        }

        yield* app.fileAdded(
          { id: fileId, env, name, type, size: put.size, sha256: put.sha256, author },
          trace,
          `${ms} ms on ${Runtime.fileStore.kind}`,
        )
        Runtime.recordFileUpload("stored", put.size, ms)

        return json(
          {
            id: fileId,
            url: `/a/${appName}${env === "" ? "" : `/_preview/${encodeURIComponent(env)}`}/_files/${fileId}`,
            name,
            type,
            size: put.size,
            sha256: put.sha256,
          },
          201,
        )
      }

      if ((request.method === "GET" || request.method === "HEAD") && id !== undefined)
        return yield* download(`${workspaceId}/${appId}/${id}`, id, appId, trace)

      if (request.method === "DELETE" && id !== undefined) {
        const removed = yield* app.fileRemoved(id, author, trace)

        if (removed.kind === "missing")
          return json({ error: `there's no file ${id} in this app`, code: "missing", trace }, 404)

        if (removed.kind === "theirs")
          return json(
            {
              error: `only ${removed.author}, who uploaded this file, can delete it (you're ${author}): show the delete button only on a person's own files (the file's record says who: put its document's author beside it)`,
              code: "denied",
              rule: "files.delete",
              hint: "only whoever uploaded a file deletes it",
              trace,
            },
            403,
          )

        const size = removed.size

        yield* Effect.tryPromise(() =>
          Runtime.fileStore.remove(`${workspaceId}/${appId}/${id}`),
        ).pipe(
          Effect.tapError(() => Effect.sync(() => Runtime.recordFileStoreError("remove"))),
          Effect.ignore,
        )
        yield* workspace.filesRelease(appId, size)

        return HttpServerResponse.empty({ status: 204 })
      }

      return json(
        {
          error: "files: POST /_files with the file as the body, GET or DELETE /_files/<id>",
          code: "invalid",
          trace,
        },
        405,
      )
    })

    const oldLink = Effect.fn("gateway.oldLink")(function* (
      workspace: Workspace,
      workspaceOrigin: string,
      domainless: boolean,
      path: string,
      search: string,
      trace: string,
    ) {
      const request = yield* HttpServerRequest
      const [, name = "", rest] = /^\/a\/([^/]+)(\/.*)?$/.exec(path) ?? []

      if (!isSlug(name)) return HttpServerResponse.text("Not found.\n", { status: 404 })

      if (rest === "/_shot") {
        const refusal = yield* admit(
          workspace,
          yield* viewerOf(false, new URL(workspaceOrigin).host),
          false,
          trace,
        )

        if (refusal !== undefined) return refusal

        const record = yield* workspaces.getByName(workspace.id).app(name)

        return record === null
          ? HttpServerResponse.text(`There's no app "${name}" in ${workspace.name}.\n`, {
              status: 404,
            })
          : yield* forward(
              record.id,
              "_shot",
              Headers.fromInput({ "x-openbelt-trace": trace }),
              "workspace",
            )
      }

      if (domainless) {
        return HttpServerResponse.text(
          `Apps are served on hosts of their own, <app>--<workspace>.<domain>, and this deploy of OpenBelt has no domain (OPENBELT_HOST), so "${name}" has no host to send you to. Deploy it with OPENBELT_HOST set to a domain whose subdomains all reach it (docs/running.md).\n`,
          { status: 404 },
        )
      }

      const moved = `${appOrigin(workspaceOrigin, name)}${rest ?? "/"}${search}`

      if (request.method === "GET" || request.method === "HEAD")
        return HttpServerResponse.redirect(moved, { status: 301 })

      return json(
        {
          error: `apps are served on hosts of their own: send this ${request.method} to ${moved} (from a page, db.app("${name}") does it for you)`,
          code: "missing",
          trace,
        },
        404,
      )
    })

    const onAppHost = Effect.fn("gateway.appHost")(function* (
      workspace: Workspace,
      own: string,
      workspaceOrigin: string,
      origin: string,
      path: string,
      search: string,
      trace: string,
    ) {
      const other = /^\/a\/([^/]+)(\/.*)?$/.exec(path)
      const request = yield* HttpServerRequest
      const opened = yield* session.open(request.cookies[COOKIE], request.headers["host"] ?? "")
      const target = other?.[1] ?? own

      // check_app opened by an agent limited to some apps reaches only those: any other app (this host's, or /a/<app>/ on it) refuses.
      if (
        opened !== null &&
        opened.kind !== "person" &&
        opened.apps !== undefined &&
        !opened.apps.includes(target)
      )
        return json(
          {
            error: `this check was opened by an agent that may use only ${opened.apps.join(", ") || "no apps"}, so not "${target}"`,
            code: "not_allowed",
            trace,
          },
          403,
        )

      // An app an agent limited to some apps deployed last reads only those: its pages can't carry another app's data to it.
      if (other !== null && target !== own) {
        const reach = yield* workspaces.getByName(workspace.id).reachOf(own)

        if (reach !== null && !reach.includes(target))
          return json(
            {
              error: `${own} was last deployed by an agent that may use only ${reach.join(", ") || "no apps"}, so its pages can't read "${target}": its owner deploys it again with every app, or adds "${target}" to that agent in Settings, Agents and has it deploy again`,
              code: "not_allowed",
              trace,
            },
            403,
          )
      }

      if (TOOLS_ROUTE.test(path.slice(1)))
        return yield* pageTools(workspace, own, path.slice(1), origin, workspaceOrigin, trace)

      if (HOOK_ROUTE.test(path)) {
        const record = yield* workspaces.getByName(workspace.id).app(own)

        if (record === null)
          return json(
            { error: `there's no app "${own}" in ${workspace.name}`, code: "missing", trace },
            404,
          )

        return yield* forward(
          record.id,
          path.slice(1),
          Headers.fromInput({ "x-openbelt-trace": trace }),
          "workspace",
        )
      }

      if (other === null) return yield* serve(workspace, own, own, path.slice(1), origin, trace)

      const [, name = "", rest = "/"] = other
      const below = rest.slice(1)

      if (!isSlug(name)) return HttpServerResponse.text("Not found.\n", { status: 404 })

      if (SHARED_ROUTE.test(below)) return yield* serve(workspace, name, own, below, origin, trace)

      const to =
        name === own
          ? `/${below}${search}`
          : `${appOrigin(workspaceOrigin, name)}/${below}${search}`

      return HttpServerResponse.redirect(to, { status: 301 })
    })

    /** What the public host forwards to a published app: its data, functions, socket and aggregates (each then judged by the app). */
    const PUBLIC_ROUTE = /^_(db\/[^/]+(\/[^/]+)?|fn\/[^/]+|ws|aggregates\/[^/]+)$/

    /**
     * A name under the public host, <app>--<workspace>.<public host>: a published app, for anyone, who is nobody whatever the request
     * carries (no cookie, session or front door's Tailscale-User-* is read here, and none is set). Only the app's files and what its
     * openbelt.json "public" names (the app's object judges those); every OpenBelt page, another app, a preview, uploads and the
     * browser's log are a 404, as is an app that isn't published, a trial nobody has claimed, and any other name.
     */
    const publicRoute = Effect.fn("gateway.publicRoute")(function* (
      url: URL,
      trace: string,
      address: string | undefined,
    ) {
      const request = yield* HttpServerRequest
      const path = url.pathname
      const below = path.slice(1)
      const port = url.port === "" ? "" : `:${url.port}`
      const notFound = HttpServerResponse.text("Not found.\n", { status: 404 })

      const named =
        url.hostname === publicHost
          ? undefined
          : publicNameOf(url.hostname.slice(0, -publicHost.length - 1))

      const asked =
        named === undefined
          ? undefined
          : Option.getOrUndefined(decodeWorkspaceName(named.workspace))

      if (named === undefined || asked === undefined || !isSlug(named.app)) return notFound

      const workspace = yield* names.named(asked)

      if (!(yield* workspaceExists(workspace))) return notFound

      const record = yield* workspaces.getByName(workspace.id).publicApp(named.app)

      if (record === null) return notFound

      const workspaceOrigin = `${url.protocol}//${workspace.name}.${host}${port}`

      const answered = Effect.fnUntraced(function* (
        response: HttpServerResponse.HttpServerResponse,
      ) {
        const embedding = yield* embeddingOf(workspace.id).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        )

        const ancestors = [
          "'self'",
          workspaceOrigin,
          ...embedding
            .filter((app) => app !== named.app)
            .map((app) => appOrigin(workspaceOrigin, app)),
        ].join(" ")

        const kept = HttpServerResponse.removeHeader(
          HttpServerResponse.setHeader(response, "x-openbelt-app", named.app),
          "set-cookie",
        )

        return kept.headers["content-security-policy"] === undefined
          ? HttpServerResponse.setHeader(
              kept,
              "content-security-policy",
              `frame-ancestors ${ancestors}`,
            )
          : kept
      })

      // A renamed workspace's old public names: a page moves to the app's public name now (never cached: a rename back would loop), only
      // while the app is published; its data and socket answer as the same workspace, as on the workspace host.
      if (
        workspace.name !== asked &&
        (request.method === "GET" || request.method === "HEAD") &&
        (request.headers["accept"] ?? "").includes("text/html")
      ) {
        if (!(yield* apps.getByName(record.id).published())) return notFound

        const moved = new URL(url)

        moved.hostname = `${publicLabel(named.app, workspace.name)}.${publicHost}`

        return HttpServerResponse.redirect(moved.href, {
          status: 308,
          headers: { "cache-control": "no-store" },
        })
      }

      if (path === "/sdk.js")
        return yield* answered(
          HttpServerResponse.text(
            SDK_JS.replace("__WORKSPACE_HOST__", () =>
              JSON.stringify(url.host.slice(named.app.length + APP_SEPARATOR.length)),
            ),
            {
              contentType: "text/javascript; charset=utf-8",
              headers: { "cache-control": "no-cache", etag: `"${SDK_VERSION}"` },
            },
          ),
        )

      if (path === "/favicon.ico" || path === "/favicon.svg")
        return HttpServerResponse.text(FAVICON, {
          contentType: "image/svg+xml",
          headers: { "cache-control": "public, max-age=86400" },
        })

      if (path === "/_me")
        return HttpServerResponse.jsonUnsafe(null, { headers: { "cache-control": "no-store" } })

      if (path === "/_health") return json({ ok: true, sdk: SDK_VERSION })

      const said = Headers.fromInput({ "x-openbelt-trace": trace, "x-openbelt-caller": named.app })

      // A link previewer (iMessage, Slack, X, ...) gets the app's link preview (cards.ts) instead of its page, which it would never run:
      // the app's own card, since a published app is anyone's here.
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (path === "/_og.png" ||
          (!path.startsWith("/_") && LINK_PREVIEWER.test(request.headers["user-agent"] ?? "")))
      )
        return yield* answered(
          yield* forward(record.id, path === "/_og.png" ? "_og.png" : "_og", said, "public"),
        )

      if (
        below === "a" ||
        below.startsWith("a/") ||
        (below.startsWith("_") && !PUBLIC_ROUTE.test(below))
      )
        return notFound

      // A person's browser opening one of the app's pages gets it under the OpenBelt bar (frame.ts publicFrame), unless the app's
      // "public" turns the bar off; the app counts the visit as it says so (AppDO.publicPage). The frame's own request (Sec-Fetch-Dest:
      // iframe), a page the app opens itself (same-origin), curl, an agent's fetch, link previews, OpenBelt's routes, a path that
      // isn't a page and one starting "//" (which a browser reads as another host) get the answer itself.
      if (
        request.method === "GET" &&
        request.headers["sec-fetch-dest"] === "document" &&
        request.headers["sec-fetch-site"] !== "same-origin" &&
        !below.startsWith("_") &&
        !below.startsWith("/") &&
        isPagePath(path) &&
        (yield* apps
          .getByName(record.id)
          .publicPage(
            below,
            address,
            request.headers["user-agent"] ?? "",
            request.headers["referer"],
            url.host,
          ))
      )
        return yield* answered(
          htmlOf(
            publicFrame(
              named.app,
              `${url.protocol}//${baseHost}${port}/`,
              `${workspaceOrigin}/_signin?next=${encodeURIComponent(`/${named.app}/`)}`,
            ),
            { headers: { "cache-control": "no-store", vary: "sec-fetch-dest" } },
          ),
        )

      const response = yield* forward(
        record.id,
        below,
        address === undefined ? said : Headers.set(said, ADDRESS_HEADER, address),
        "public",
      )

      // A CDN in front keeps the app's files a minute (cdn.ts), and its going live purges them; browsers still ask each time.
      return yield* answered(
        edgeKept(request.method, below, response)
          ? HttpServerResponse.setHeader(
              response,
              "cdn-cache-control",
              `public, max-age=${EDGE_SECONDS}`,
            )
          : response,
      )
    })

    const base = yield* openBase({
      session,
      viewerOf,
      signIn: (url, trace) => signInRoute({ kind: "apex" }, url.origin, url, trace),
      mcp,
      workspaceExists,
      workspaceNamed: names.named,
      workspaceOrigin: (url, workspace) =>
        `${url.protocol}//${workspace.name}.${domainOf(url.hostname)}${url.port === "" ? "" : `:${url.port}`}`,
    })

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest
        const trace = newTrace()
        // originalUrl keeps the scheme (https when deployed); request.url is only the path.
        const url = new URL(request.originalUrl, `http://${request.headers["host"] ?? host}`)

        // A front door that ends HTTPS (tailscale serve, bun run dev's, compose's caddy) forwards plain HTTP and says so in this
        // header, which it sets itself. Behind caddy every link OpenBelt gave out was http:// until this was read whatever the
        // sign-in (a VPS trial). Anyone reaching the port directly could set it too, but it only changes the links they're given.
        if (request.headers["x-forwarded-proto"] === "https") url.protocol = "https:"
        const origin = url.origin
        const here = hereOf(url.hostname)
        const own = here?.place.kind === "app" ? here.place.app : undefined

        const response = yield* Effect.gen(function* () {
          // A load balancer checks each process by its address (Caddy's health checks send the upstream's address as the host),
          // so an address is answered before names are judged. A process that is stopping says so first, while it still serves,
          // so the proxy sends to the next one.
          if (url.pathname === "/_health" && Runtime.stopping())
            return json({ ok: false, stopping: true, commit }, 503)

          if (url.pathname === "/_health" && isAddress(url.hostname))
            return json({ ok: true, commit })

          const remote = Option.getOrUndefined(request.remoteAddress)
          const trusted = yield* throughFrontDoor()
          const forwarded = trusted && request.headers["x-forwarded-for"] !== undefined

          if (!OPERATOR_ROUTE.test(url.pathname) && (forwarded || !isLoopback(remote))) {
            const address = clientAddress(trusted ? request.headers : {}, remote)
            const write = !["GET", "HEAD", "OPTIONS"].includes(request.method)
            const over = overLimit(address, write, true)

            if (over !== undefined)
              return yield* refusedOverLimit(address, over, url.pathname, trace)
          }

          // A TLS proxy asking about a name (/_tls/ask) asks by OpenBelt's address (compose's caddy: openbelt:1337), and is told
          // nothing about anyone.
          if (signIn !== "off" && !ownName(url.hostname) && url.pathname !== "/_tls/ask")
            return HttpServerResponse.text(
              `${url.hostname} isn't a name for this OpenBelt (those are under ${host === "localhost" ? "localhost" : `localhost or ${host}`}${baseHost === host ? "" : `, and ${baseHost}`}${publicHost === "" ? "" : `, and public apps under ${publicHost}`}), so it doesn't answer it: open http://acme.localhost${url.port === "" ? "" : `:${url.port}`}\n`,
              { status: 421 },
            )

          // Straight to the port, past the front door: nobody is named, and a person's page or data isn't shown to nobody here,
          // whatever the workspace's joining (an "open" workspace shows signed-out visitors through the front door, which decides who those are).
          if (
            signIn === "tailscale" &&
            !NO_FRONT_DOOR_NEEDED.test(url.pathname) &&
            !SDK_ROUTE.test(url.pathname) &&
            !HOOK_ROUTE.test(url.pathname) &&
            !CLI_ROUTE.test(url.pathname) &&
            !(yield* throughFrontDoor())
          ) {
            yield* Effect.logInfo(
              `refused ${request.method} ${url.host}${url.pathname}: it didn't come through the front door`,
            ).pipe(Effect.annotateLogs({ trace }))

            return HttpServerResponse.text(
              `This OpenBelt says who is viewing at its front door, and this request didn't come through it: open ${origin} through the front door (the address people use), not this machine's port. A proxy elsewhere is the front door when it sends x-openbelt-front-door with OPENBELT_FRONT_DOOR_SECRET (docs/viewers.md).\n`,
              { status: 403 },
            )
          }

          if (underPublic(url.hostname)) {
            const address = clientAddress(trusted ? request.headers : {}, remote)
            const counted = forwarded || !isLoopback(remote)

            const over = counted
              ? overLimit(address, !["GET", "HEAD", "OPTIONS"].includes(request.method))
              : undefined

            if (over !== undefined)
              return yield* refusedOverLimit(address, over, url.pathname, trace)

            return yield* publicRoute(url, trace, counted ? address : undefined)
          }

          if (here === undefined)
            return HttpServerResponse.text(`No workspace at ${url.hostname}.\n`, { status: 404 })

          const { place, onBase } = here
          // Objects are keyed by the workspace's id; its addresses say its current name.
          const workspace = yield* workspaceAt(here)
          const port = url.port === "" ? "" : `:${url.port}`

          if (!OPERATOR_ROUTE.test(url.pathname) && url.pathname !== "/mcp") {
            const write = !["GET", "HEAD", "OPTIONS"].includes(request.method)
            const who = yield* viewerOf(false, url.host)

            const admission =
              who.viewer === null || isApex(url.hostname)
                ? null
                : yield* workspaces.getByName(workspace.id).admit(who.viewer)

            const member = admission?.kind === "member" ? admission.person : undefined

            const over =
              member === undefined
                ? forwarded || !isLoopback(remote)
                  ? overLimit(clientAddress(trusted ? request.headers : {}, remote), write)
                  : undefined
                : yield* mcps.getByName(`${workspace.id}/${member.id}`).requestLimit(write)

            if (over !== undefined && over !== null)
              return yield* refusedOverLimit(
                member === undefined
                  ? clientAddress(trusted ? request.headers : {}, remote)
                  : "person",
                over,
                url.pathname,
                trace,
              )
          }

          const domainless = !onBase && host === "localhost" && url.protocol === "https:"

          const workspaceOrigin = domainless
            ? origin
            : `${url.protocol}//${workspace.name}.${domainOf(url.hostname)}${port}`

          const path = url.pathname

          // An old name of a renamed workspace: a page opened there moves to the same path on the current host (an app's page to the
          // app's), never cached (a rename back would loop). Everything else is answered here as the same workspace: an agent's /mcp and
          // its OAuth (whose issuer it holds), an app's data, sockets, functions and webhooks, sign-ins coming back from a connection's
          // provider.
          if (
            onBase &&
            workspace.name !== here.name &&
            (request.method === "GET" || request.method === "HEAD") &&
            (request.headers["accept"] ?? "").includes("text/html") &&
            !OAUTH_PAGE.test(path) &&
            !HOOK_ROUTE.test(path) &&
            path !== "/_signin/return"
          ) {
            const moved = new URL(url)

            moved.hostname = `${place.kind === "app" ? `${place.app}${APP_SEPARATOR}` : ""}${workspace.name}.${domainOf(url.hostname)}`

            return HttpServerResponse.redirect(moved.href, {
              status: 308,
              headers: { "cache-control": "no-store" },
            })
          }

          if (SDK_ROUTE.test(path)) {
            // The SDK tells this app's host from its workspace's by the workspace's host, as this request named it.
            const workspaceHost =
              place.kind === "app"
                ? url.host.slice(place.app.length + APP_SEPARATOR.length)
                : url.host

            return HttpServerResponse.text(
              SDK_JS.replace("__WORKSPACE_HOST__", () => JSON.stringify(workspaceHost)),
              {
                contentType: "text/javascript; charset=utf-8",
                // Asked again on every page load, answered 304 while this platform's SDK is the one the browser has (serve.ts).
                headers: { "cache-control": "no-cache", etag: `"${SDK_VERSION}"` },
              },
            )
          }

          if (
            place.kind === "workspace" &&
            (request.method === "GET" || request.method === "HEAD")
          ) {
            const pwa = pwaResponse(path)

            if (pwa !== null) return pwa
          }

          // Browsers ask every origin for /favicon.ico; an app's own <link rel=icon> wins. The workspace's
          if (path === "/favicon.ico" || path === "/favicon.svg") {
            return HttpServerResponse.text(FAVICON, {
              contentType: "image/svg+xml",
              headers: { "cache-control": "public, max-age=86400" },
            })
          }

          if (path === "/_health")
            return json({
              ok: true,
              workspace: workspace.name,
              app: own ?? "",
              commit,
              sdk: SDK_VERSION,
            })

          if (own === undefined && path === "/_theme" && request.method === "POST") {
            const { viewer } = yield* viewerOf(false, url.host)
            const from = request.headers["origin"]

            if (
              viewer === null ||
              from === undefined ||
              !sameHost(from, url.origin) ||
              request.headers["sec-fetch-site"] !== "same-origin"
            )
              return json(
                { error: "Open your OpenBelt page and sign in before changing its theme." },
                403,
              )

            const body = yield* cappedBody(request, 2048)

            if (body.kind !== "read") return json({ error: "The theme choice is too large." }, 400)

            const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ThemeChange))(
              new TextDecoder().decode(body.bytes),
            )

            if (Option.isNone(decoded))
              return json({ error: "Choose System, Light or Dark from your person menu." }, 400)

            if (decoded.value.form !== (yield* session.formToken(viewer.email, url.host)))
              return json({ error: "Reload your OpenBelt page and choose the theme again." }, 403)

            return HttpServerResponse.setHeader(
              json({ theme: yield* apex.themeSet(viewer.email, decoded.value) }),
              "cache-control",
              "no-store",
            )
          }

          // The base host itself under email sign-in: where someone without a workspace starts (base.ts). The operator's routes and the
          // CLI answer there as they always have.
          if (isApex(url.hostname) && !OPERATOR_ROUTE.test(path) && !CLI_ROUTE.test(path))
            return yield* base.route(url, trace)

          // Under email sign-in, a name nobody made isn't offered a sign-in (which would make the workspace for whoever signs in): it's
          // a 404 that says where to start. The operator's routes still make one (/_admin/tokens).
          if (
            signIn === "email" &&
            !OPERATOR_ROUTE.test(path) &&
            !(yield* workspaceExists(workspace))
          )
            return yield* noSuchWorkspace(
              workspace.name,
              `${url.protocol}//${baseOf(url.hostname)}${port}`,
              trace,
            )

          // A page's report of how long it took to load (timing.ts), from OpenBelt's pages and every app page: kept as a trace of its
          // own, from someone this workspace admits, on the page's own origin. Always 204: a page has nothing to do with the answer.
          if (path === "/_timing" && request.method === "POST") {
            const who = yield* viewerOf(false, url.host)
            const from = request.headers["origin"]

            if (
              (who.viewer === null && !who.checked) ||
              from === undefined ||
              !sameHost(from, url.origin) ||
              (yield* admit(workspace, who, true, trace)) !== undefined
            )
              return HttpServerResponse.empty({ status: 204 })

            const body = yield* cappedBody(request, TIMING_BYTES)

            const timing =
              body.kind === "read"
                ? Schema.decodeUnknownOption(Schema.fromJsonString(PageTiming))(
                    new TextDecoder().decode(body.bytes),
                  )
                : Option.none()

            if (Option.isNone(timing)) return HttpServerResponse.empty({ status: 204 })

            const load = recordPageTiming(timing.value, {
              host: url.host,
              agent: request.headers["user-agent"] ?? "",
              person: who.viewer?.email ?? who.checkedBy ?? "",
              received: Date.now(),
            })

            yield* Effect.logInfo(
              `page load: ${load.page} in ${Math.round(load.ms)} ms (trace ${load.trace})`,
            ).pipe(
              Effect.annotateLogs({ workspace: workspace.id, ms: Math.round(load.ms) }),
              Effect.withParentSpan(load.span),
            )

            return HttpServerResponse.empty({ status: 204 })
          }

          // What an agent reads before it's in: how to connect to this workspace, also as the workspace host's home asked for as markdown.
          if (
            own === undefined &&
            (request.method === "GET" || request.method === "HEAD") &&
            (path === "/auth.md" || (path === "/" && wantsMarkdown(request.headers["accept"])))
          )
            return markdown(workspaceAuthMd(workspace.name, workspaceOrigin))

          // The CLI: from a workspace's host, signing in there; from the platform's own address (no workspace in it, though it
          // answers as the default workspace), asking which workspace.
          if (place.kind === "workspace" && CLI_ROUTE.test(path))
            return cliResponse(
              path,
              onBase
                ? { kind: "workspace", origin: workspaceOrigin }
                : { kind: "platform", origin },
            )

          // A TLS proxy issuing certificates on demand (compose's caddy) asks first whether a name is one of ours: OPENBELT_HOST or OPENBELT_BASE_HOST,
          // a workspace that is set up (it has apps or has issued tokens) or is the default one, or an app that exists. Anything else gets no certificate,
          // so a stranger's handshakes for made-up names can't spend the certificate authority's limits.
          if (path === "/_tls/ask") {
            const domain = (url.searchParams.get("domain") ?? "").toLowerCase()
            const bare = domain === host || domain === baseHost
            const there = bare ? undefined : hereOf(domain)

            if (!bare && (there === undefined || !there.onBase || domainOf(domain) !== host))
              return HttpServerResponse.text("not ours\n", { status: 404 })

            if (there !== undefined) {
              const named = yield* workspaceAt(there)
              const stub = workspaces.getByName(named.id)
              const asked = there.place

              // The default workspace's host always: it is where the first person is set up (/_admin/tokens), over HTTPS. An old name
              // of a renamed workspace too: it still answers.
              const known =
                asked.kind === "workspace"
                  ? yield* workspaceExists(named)
                  : (yield* workspaceExists(named)) && (yield* stub.app(asked.app)) !== null

              if (!known)
                return HttpServerResponse.text("no such workspace or app\n", { status: 404 })

              // A trial workspace nobody has claimed is anyone's to start (trials.ts): no certificate until a person claims it.
              if (yield* stub.trialUnclaimed())
                return HttpServerResponse.text("an unclaimed trial workspace\n", { status: 404 })
            }

            return HttpServerResponse.text("ok\n")
          }

          if (own === undefined && path === "/_switch")
            return HttpServerResponse.redirect(workspacePicker(workspace, url), { status: 303 })

          if (signIn === "email" && own === undefined && SIGN_IN_ROUTE.test(path))
            return yield* signInRoute({ kind: "workspace", workspace }, workspaceOrigin, url, trace)

          if (signIn === "email" && own !== undefined && path === "/_signin/return")
            return yield* signInReturn(workspace, workspaceOrigin, url)

          if (signIn === "email" && own === undefined && path === "/_signin/carry")
            return yield* carryFrom(workspace, url)

          if (signIn === "email" && own === undefined && path === "/_signin/return")
            return yield* carried(workspace, url, trace)

          // A signed file url (ctx.files.url) is read by whoever has it, before sign-in: the service an app posts a picture to fetches it.
          const signedFile =
            own !== undefined &&
            (request.method === "GET" || request.method === "HEAD") &&
            url.searchParams.has("sig")
              ? /^\/_files\/([A-Za-z0-9-]+)$/.exec(path)
              : null

          if (own !== undefined && signedFile !== null) {
            const fileId = signedFile[1] ?? ""
            const record = yield* workspaces.getByName(workspace.id).app(own)
            const key = `${workspace.id}/${record?.id ?? ""}/${fileId}`
            const expires = url.searchParams.get("expires")

            if (
              record === null ||
              !fileUrlValid(secretsKey, key, expires, url.searchParams.get("sig"))
            )
              return json(
                {
                  error:
                    "this file link is wrong or has expired: the app makes a new one (ctx.files.url)",
                  code: "denied",
                  trace,
                },
                403,
              )

            return yield* download(
              key,
              fileId,
              record.id,
              trace,
              Number(expires) - Math.floor(Date.now() / 1000),
            )
          }

          // A link previewer (Slack, iMessage, X, ...) never signs in: it gets the app's link preview (cards.ts), its card if
          // openbelt.json says "card": "public" and the workspace's private one otherwise, instead of a sign-in page to unfurl.
          if (
            own !== undefined &&
            (request.method === "GET" || request.method === "HEAD") &&
            (path === "/_og.png" ||
              (!path.startsWith("/_") && LINK_PREVIEWER.test(request.headers["user-agent"] ?? "")))
          ) {
            const record = yield* workspaces.getByName(workspace.id).app(own)

            if (record !== null)
              return yield* forward(
                record.id,
                path === "/_og.png" ? "_og.png" : "_og",
                Headers.fromInput({ "x-openbelt-trace": trace }),
                "workspace",
              )
          }

          const opening = url.searchParams.get("open")

          if (
            signIn === "email" &&
            own === undefined &&
            path === "/" &&
            request.method === "GET" &&
            opening !== null
          ) {
            const who = yield* viewerOf(false, url.host)

            if (who.viewer === null) return yield* carryFrom(workspace, url)

            const pickerHost = `${baseOf(url.hostname)}${port}`

            if (opening !== (yield* session.formToken(who.viewer.email, pickerHost)))
              return HttpServerResponse.redirect(`${url.protocol}//${pickerHost}/_start?switch=1`, {
                status: 303,
                headers: { "cache-control": "no-store" },
              })

            const refusal = yield* admit(workspace, who, false, trace)

            if (refusal !== undefined) return refusal

            if (who.session !== null) {
              const parent = yield* workspaces.getByName(workspace.id).loginParent(who.session)

              if (parent !== null) yield* apex.browserVisitParent(parent, workspace.id)
            }

            return yield* home(workspace, origin, workspaceOrigin, url, trace)
          }

          // People have one address for an app, <workspace>/<app>/<path>: its page in the workspace's frame. A browser's page load of the
          // app's own host goes there, unless the app opened it itself (a popup, a print view, a tab it opens for the camera) or it's
          // check_app's or the screenshots' browser; anything else that asks for the frame's address (curl, an agent's fetch, a link
          // preview's bot, whatever it sends) is sent to the app's own page, since only a person's browser shows a frame. Both come
          // before sign-in: each address then signs in as it always has.
          if (request.method === "GET" || request.method === "HEAD") {
            const dest = request.headers["sec-fetch-dest"]

            if (own === undefined) {
              const framed = FRAMED.exec(path)
              const name = framed?.[1] ?? ""

              if (
                framed !== null &&
                (dest !== "document" || LINK_PREVIEWER.test(request.headers["user-agent"] ?? "")) &&
                isSlug(name) &&
                !RESERVED_APP_NAMES.has(name)
              )
                return HttpServerResponse.redirect(
                  `${appOrigin(workspaceOrigin, name)}${framed[2] ?? "/"}${url.search}`,
                  { status: 302 },
                )
            } else if (
              appPages === "frame" &&
              dest === "document" &&
              request.headers["sec-fetch-site"] !== "same-origin" &&
              !path.startsWith("/_") &&
              !path.startsWith("/a/") &&
              isPagePath(path) &&
              !(yield* viewerOf(false, url.host)).checked
            )
              return HttpServerResponse.redirect(
                `${workspaceOrigin}/${own}${path === "/" ? "" : path}${url.search}`,
                { status: 302 },
              )
          }

          // Under email sign-in, a person's page or data needs someone signed in; whoever isn't goes to sign in (a page) or is told
          // to (anything else). What carries its own credentials (a token, a webhook's signature) or none worth having goes on.
          if (
            signIn === "email" &&
            !NO_FRONT_DOOR_NEEDED.test(path) &&
            !HOOK_ROUTE.test(path) &&
            !(own === undefined && TOKEN_ONLY_ROUTE.test(path))
          ) {
            const who = yield* viewerOf(false, url.host)

            if (who.viewer === null && !who.checked)
              return yield* signedOut(workspaceOrigin, url, own, trace)
          }

          if (path === "/_apps") {
            const refusal = yield* admit(workspace, yield* viewerOf(false, url.host), true, trace)

            if (refusal !== undefined) return refusal

            const records = yield* workspaces.getByName(workspace.id).apps()
            const named = url.searchParams.get("env")

            const env =
              named === null ? null : yield* workspaces.getByName(workspace.id).environment(named)

            const inEnv = new Set(env?.apps ?? [])

            return HttpServerResponse.jsonUnsafe(
              records.map((r) => {
                const there = env !== null && inEnv.has(r.name) ? env.env : null

                return {
                  app: r.name,
                  url: appUrl(workspaceOrigin, r.name, there ?? undefined),
                  description: r.description,
                  owner: r.owner,
                  env: there,
                }
              }),
            )
          }

          if (path === "/_me") {
            const inPreview = (url.searchParams.get("env") ?? "") !== ""
            const who = yield* viewerOf(inPreview, url.host)
            const refusal = yield* admit(workspace, who, true, trace)

            if (refusal !== undefined) return refusal

            return HttpServerResponse.jsonUnsafe(who.viewer, {
              headers: { "cache-control": "no-store" },
            })
          }

          // One app's notifications for the viewer (push.ts): GET where they stand (on, off, asked, none), POST { on } to answer, from
          // the app's frame (Allow, Not now, the panel's switch).
          const pushApp = /^\/_push\/apps\/([^/]+)$/.exec(path)?.[1]

          if (own === undefined && pushApp !== undefined) {
            const who = yield* viewerOf(false, url.host)
            const refusal = yield* admit(workspace, who, true, trace)

            if (refusal !== undefined) return refusal

            if (who.viewer === null)
              return json({ error: "Sign in to choose notifications.", trace }, 401)

            const posted = request.method === "POST"

            if (
              posted &&
              (crossOrigin(request.headers, url.origin) !== undefined ||
                request.headers["sec-fetch-site"] !== "same-origin")
            )
              return json({ error: "Choose notifications from the app's page.", trace }, 403)

            const body = posted ? yield* cappedBody(request, 256) : null

            const answer =
              body === null
                ? Option.some({ on: null })
                : body.kind === "read"
                  ? Schema.decodeUnknownOption(Schema.fromJsonString(AppAnswer))(
                      new TextDecoder().decode(body.bytes),
                    )
                  : Option.none()

            if (Option.isNone(answer))
              return json({ error: 'Send { "on": true } or { "on": false }.', trace }, 400)

            return yield* workspaces
              .getByName(workspace.id)
              .pushApp(who.viewer, decodeURIComponent(pushApp), answer.value.on)
              .pipe(
                Effect.map((state) =>
                  HttpServerResponse.setHeader(json(state), "cache-control", "no-store"),
                ),
                Effect.catchTag("Refused", (e) =>
                  Effect.succeed(json({ error: e.message, trace }, 404)),
                ),
              )
          }

          // Notifications on this device (push.ts): GET the key to subscribe with, POST a subscription to turn them on, DELETE it to
          // turn them off, POST /_push/status to ask. Only from the workspace's own page: a subscription is where pushes go.
          if (own === undefined && (path === "/_push" || path === "/_push/status")) {
            const who = yield* viewerOf(false, url.host)
            const refusal = yield* admit(workspace, who, true, trace)

            if (refusal !== undefined) return refusal

            if (who.viewer === null)
              return json({ error: "Sign in to turn notifications on.", trace }, 401)

            if (request.method === "GET")
              return HttpServerResponse.jsonUnsafe(
                { key: yield* workspaces.getByName(workspace.id).pushKey() },
                { headers: { "cache-control": "no-store" } },
              )

            if (
              (request.method !== "POST" && request.method !== "DELETE") ||
              crossOrigin(request.headers, url.origin) !== undefined ||
              request.headers["sec-fetch-site"] !== "same-origin"
            )
              return json({ error: "Turn notifications on from your OpenBelt page.", trace }, 403)

            const body = yield* cappedBody(request, 4096)

            const device =
              body.kind === "read"
                ? Schema.decodeUnknownOption(Schema.fromJsonString(PushSubscription))(
                    new TextDecoder().decode(body.bytes),
                  )
                : Option.none()

            if (Option.isNone(device))
              return json({ error: "Send the browser's push subscription.", trace }, 400)

            return yield* workspaces
              .getByName(workspace.id)
              .pushDevice(
                who.viewer,
                path === "/_push/status"
                  ? "status"
                  : request.method === "POST"
                    ? "subscribe"
                    : "unsubscribe",
                device.value,
              )
              .pipe(
                Effect.map((answer) =>
                  HttpServerResponse.setHeader(json(answer), "cache-control", "no-store"),
                ),
                Effect.catchTag("Refused", (e) =>
                  Effect.succeed(json({ error: e.message, trace }, 400)),
                ),
              )
          }

          const managed = /^\/_(workspace\/.+|me\/.+)$/.exec(path)?.[1]

          if (
            own !== undefined &&
            (path === "/mcp" ||
              path.startsWith("/_admin/") ||
              managed !== undefined ||
              /^\/_(account|access|settings|connections|oauth)(\/|$)/.test(path))
          ) {
            return json(
              {
                error: `${path} is on the workspace host, not an app's: ${workspaceOrigin}${path}`,
                code: "missing",
                trace,
              },
              404,
            )
          }

          if (own !== undefined)
            return yield* onAppHost(
              workspace,
              own,
              workspaceOrigin,
              origin,
              path,
              url.search,
              trace,
            )

          if (path === "/mcp")
            return yield* mcp(
              workspace,
              workspaceOrigin,
              url,
              trace,
              bearer(request.headers["authorization"]),
            )

          const directory = /^\/scim\/v2(\/.*)?$/.exec(path)

          if (directory !== null)
            return yield* scimRoute(
              workspace,
              origin,
              (directory[1] ?? "").replace(/\/$/, ""),
              url.search,
              trace,
            )

          if (OAUTH_ROUTE.test(path)) return yield* oauthRoute(workspace, url, path.slice(1), trace)

          if (path === "/_admin/tokens" && request.method === "POST")
            return yield* admin(workspace, origin, "tokens", trace)

          if (path === "/_admin/workspace-admins" && request.method === "POST")
            return yield* admin(workspace, origin, "workspace-admins", trace)

          if (path === "/_admin/signin-links" && request.method === "POST")
            return yield* admin(workspace, origin, "signin-links", trace)

          if (path === "/_admin/inventory") return yield* inventory(workspace, trace)

          if (OBSERVE_ROUTE.test(path)) return yield* observe(path, url, trace)

          if (managed !== undefined) return yield* manage(workspace, origin, managed, trace)

          if (path === "/") return yield* home(workspace, origin, workspaceOrigin, url, trace)

          const moved = MOVED.get(path)
          const sheet = (moved ?? path) === "/_connections" ? url.searchParams.get("c") : null

          if (moved !== undefined && sheet === null && request.method === "GET")
            return HttpServerResponse.redirect(`${moved}${url.search}`, { status: 301 })

          if (sheet !== null && request.method === "GET") {
            const rest = new URLSearchParams(url.search)

            rest.delete("c")

            return HttpServerResponse.redirect(
              `/_connections/${encodeURIComponent(sheet)}${rest.size === 0 ? "" : `?${rest.toString()}`}`,
              { status: 301 },
            )
          }

          const documented = /^\/_oauth\/clients\/([a-z0-9][a-z0-9_.-]{0,120})\.json$/.exec(
            path,
          )?.[1]

          if (documented !== undefined && request.method === "GET")
            return (yield* workspaces
              .getByName(workspace.id)
              .clientDocumented(workspaceOrigin, documented))
              ? HttpServerResponse.jsonUnsafe(clientDocument(workspaceOrigin, documented), {
                  headers: { "cache-control": "max-age=300" },
                })
              : json(
                  {
                    error: `there's no client metadata document ${documented} on ${workspaceOrigin}`,
                    code: "missing",
                    trace,
                  },
                  404,
                )

          if (
            /^\/_oauth\/callback(\/[a-z0-9][a-z0-9_.-]{0,120})?$/.test(path) &&
            request.method === "GET"
          )
            return yield* signInReturned(workspace, workspaceOrigin, url, trace)

          if (path === "/_connections" && request.method === "GET")
            return yield* settings(workspace, workspaceOrigin, url, "connections", null, {}, trace)

          const connectingTo = /^\/_connections\/([a-z][a-z0-9-]{0,29})\/connect$/.exec(path)?.[1]

          if (connectingTo !== undefined && request.method === "GET")
            return yield* connectNow(workspace, workspaceOrigin, url, connectingTo, trace)

          const iconFor = /^\/_connections\/([a-z][a-z0-9-]{0,29})\/icon$/.exec(path)?.[1]

          if (iconFor !== undefined && request.method === "GET") {
            const { viewer } = yield* viewerOf(false, url.host)

            return iconResponse(
              yield* workspaces.getByName(workspace.id).connectionIcon(viewer, iconFor),
              url.searchParams.get("v"),
            )
          }

          const connectionName = /^\/_connections\/([a-z][a-z0-9-]{0,29})$/.exec(path)?.[1]

          if (connectionName !== undefined && request.method === "GET")
            return yield* settings(
              workspace,
              workspaceOrigin,
              url,
              "connections",
              null,
              {},
              trace,
              connectionName,
            )

          if (path === "/_settings/events/requests" && request.method === "GET")
            return yield* asks(workspace, url, trace)

          if ((path === "/_settings" || path === "/_settings/") && request.method === "GET")
            return HttpServerResponse.redirect(`/_settings/agents${url.search}`, {
              status: 302,
              headers: { "cache-control": "no-store" },
            })

          const below = /^\/_settings\/(.+)$/.exec(path)?.[1]

          if (below !== undefined && request.method === "POST")
            return yield* settingsPost(workspace, workspaceOrigin, url, below, trace)

          const workspacePage = below === undefined ? undefined : workspacePageAt(below)

          if (workspacePage !== undefined && request.method === "GET")
            return yield* workspaceSettings(workspace, url, workspacePage, null, trace)

          const section = below === undefined ? Option.none() : decodeSection(below)

          if (Option.isSome(section) && request.method === "GET")
            return yield* Match.value(section.value).pipe(
              Match.when("events", () => events(workspace, url, trace)),
              Match.when(Match.is("people", "groups"), (kind) =>
                workspaceSettings(workspace, url, { kind }, null, trace),
              ),
              Match.orElse((kind) =>
                settings(workspace, workspaceOrigin, url, kind, null, {}, trace),
              ),
            )

          if (path === "/a" || path === "/a/")
            return HttpServerResponse.redirect("/", { status: 301 })

          if (path.startsWith("/a/"))
            return yield* oldLink(workspace, workspaceOrigin, domainless, path, url.search, trace)

          const starterPictured = /^\/_starters\/([a-z0-9-]+)\/picture$/.exec(path)

          if (starterPictured !== null) return starterPicture(starterPictured[1] ?? "", url)

          const starterAsked = /^\/_starters\/([a-z0-9-]+)$/.exec(path)

          if (starterAsked !== null) {
            if (request.method !== "POST")
              return HttpServerResponse.text(`${request.method} ${path}: POST it\n`, {
                status: 405,
              })

            const who = yield* viewerOf(false, url.host)
            const refusal = yield* admit(workspace, who, true, trace)

            if (refusal !== undefined) return refusal

            return yield* starterAdded(
              workspace,
              url,
              workspaceOrigin,
              starterAsked[1] ?? "",
              who.checked ? null : who.viewer,
              trace,
            )
          }

          // An app's page in the workspace's frame, last: every platform route above is _-prefixed, has a dot or is a reserved
          // app name (scripts/guard.ts), so none is ever an app's. /<app>/<path> frames the page at <path>; /<app>/_panel is the panel's.
          const framed = FRAMED.exec(path) ?? /^\/([^/]+)(\/_panel|\/_delete)$/.exec(path)

          if (framed !== null && isSlug(framed[1] ?? "")) {
            const name = framed[1] ?? ""

            if (framed[2] === "/_delete") {
              if (request.method !== "POST")
                return HttpServerResponse.text(`${request.method} ${path}: POST it\n`, {
                  status: 405,
                })

              const who = yield* viewerOf(false, url.host)
              const refusal = yield* admit(workspace, who, true, trace)

              if (refusal !== undefined) return refusal

              return yield* appDeleted(workspace, url, name, who.checked ? null : who.viewer, trace)
            }

            const panelAsked = framed[2] === "/_panel"
            const inner = `${appOrigin(workspaceOrigin, name)}${framed[2] ?? "/"}${url.search}`

            const who = yield* viewerOf(false, url.host)
            const refusal = yield* admit(workspace, who, panelAsked, trace)

            if (refusal !== undefined) return refusal

            const viewer = who.checked ? null : who.viewer
            const panel = yield* workspaces.getByName(workspace.id).panelOf(name, viewer)

            if (panel === null || domainless)
              return panelAsked
                ? json({ error: `there's no app "${name}"`, code: "missing", trace }, 404)
                : HttpServerResponse.text("Not found.\n", { status: 404 })

            if (panel.access === "none" && viewer !== null && !panelAsked)
              return htmlOf(
                refusedPage(`${name} is private`, privateApp(name, workspace.name), trace),
                { status: 403, headers: WORKSPACE_PAGE },
              )

            if (!panelAsked && request.method === "GET") {
              const form =
                panel.access === "manage" && viewer !== null
                  ? yield* session.formToken(viewer.email, url.host)
                  : null

              return htmlOf(
                appFrame(name, inner, { access: panel.access, form, workspace: workspace.name }),
                { headers: WORKSPACE_PAGE },
              )
            }

            if (panelAsked && request.method === "GET")
              return yield* panelShown(workspace, workspaceOrigin, panel, trace)

            if (panelAsked && request.method === "POST")
              return yield* panelChanged(workspace, url, name, viewer, trace)
          }

          return HttpServerResponse.text("Not found.\n", { status: 404 })
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("unhandled", cause).pipe(
              Effect.annotateLogs({ trace }),
              Effect.as(
                json(
                  {
                    error: `internal error; see the platform log for trace ${trace}`,
                    code: "internal",
                    trace,
                  },
                  500,
                ),
              ),
            ),
          ),
        )

        // A refusal sent while the client is still uploading resets the connection it reuses for
        if (response.status >= 400 && request.method !== "GET" && request.method !== "HEAD") {
          yield* drainBody(request)
        }

        if (underPublic(url.hostname))
          return HttpServerResponse.removeHeader(
            HttpServerResponse.setHeader(response, "x-openbelt-trace", trace),
            "set-cookie",
          )

        let themed = response

        if (
          own === undefined &&
          Predicate.isTagged(response.body, "Uint8Array") &&
          response.body.contentType.startsWith("text/html")
        ) {
          const html = response.body.text ?? new TextDecoder().decode(response.body.body)

          if (html.includes(THEME_DATA)) {
            const { viewer } = yield* viewerOf(false, url.host)

            const preference =
              viewer === null
                ? null
                : {
                    theme: yield* apex.theme(viewer.email),
                    form: yield* session.formToken(viewer.email, url.host),
                  }

            themed = HttpServerResponse.setBody(
              response,
              HttpBody.text(
                html.replace(THEME_DATA, JSON.stringify(preference)),
                "text/html; charset=utf-8",
              ),
            )

            // A page that already says it's private (the gallery) chose how the browser keeps it.
            if (!(response.headers["cache-control"] ?? "").startsWith("private"))
              themed = HttpServerResponse.setHeader(themed, "cache-control", "private, no-store")
          }
        }

        const traced = HttpServerResponse.setHeader(themed, "x-openbelt-trace", trace)

        if (own === undefined) return traced

        const named = HttpServerResponse.setHeader(traced, "x-openbelt-app", own)

        // A file keeps its own (stricter) policy; a page gets the app's: its own pages, the workspace's (/<app>), and the
        // apps the workspace lets frame the others (a builder showing what it builds), never any other app or web page.
        if (named.headers["content-security-policy"] !== undefined) return named

        const workspaceHost = workspaceOfApp(url)

        const embedding =
          here === undefined
            ? []
            : yield* embeddingOf((yield* names.named(here.name)).id).pipe(
                Effect.orElseSucceed((): ReadonlyArray<string> => []),
              )

        return HttpServerResponse.setHeader(
          named,
          "content-security-policy",
          `frame-ancestors ${[
            "'self'",
            workspaceHost.origin,
            ...embedding
              .filter((app) => app !== own)
              .map((app) => appOrigin(workspaceHost.origin, app)),
          ].join(" ")}`,
        )
      }),
    }
  }),
) {}
