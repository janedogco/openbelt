// The sign-up funnel (docs/running.md, "The sign-up funnel"): a `funnel: <step>` line each time a person or an agent takes a step
// towards using OpenBelt, read by the ops machine's Glance page and digest. Who took it is a visitor id that changes every day: an
// HMAC, under the session secret, of the day, their address and their browser, never the address itself. So a day's steps count each
// visitor once with no cookie that follows them. kind says whose step it is: a person's, an agent's, a bot's (a headless browser, a
// crawler, a script; check_app's own browser among them), ours (OPENBELT_INTERNAL_EMAILS) or a test person's (*.test). source is where
// they came from: ?utm_source= or ?ref= on the link, else the host of the page that linked here. A cookie keeps only that name for a week,
// so the later steps carry it too.

import { createHmac } from "node:crypto"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { browserOf, clientAddress } from "./http.ts"
import { REMEMBERED_COOKIE, SESSION_SECRET } from "./session.ts"

/** The steps, in order: a person's in the browser, then an agent's (each agent's later steps are its tool calls' own lines). */
export type Step =
  | "landing"
  | "start"
  | "signin"
  | "code"
  | "google"
  | "signed_in"
  | "workspace"
  | "mcp"
  | "authorize"
  | "agent_signed_in"

export type Kind = "person" | "agent" | "bot" | "internal" | "test"

const AGENT_STEPS: ReadonlySet<Step> = new Set(["mcp", "authorize", "agent_signed_in"])

const SOURCE_COOKIE = "__Host-openbelt_from"

const SOURCE_DAYS = 7

/** A source as it's logged and kept: a short lowercase name or host. */
const SOURCE = /^[a-z0-9][a-z0-9._-]{0,59}$/

/** A User-Agent no person's browser sends: none at all, a headless browser, a crawler, a link preview, a script's HTTP library. */
const BOTS =
  /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl\/|wget\/|python|go-http|node-fetch|undici|axios|okhttp|java\/|libwww|httpx|aiohttp|scrapy|monitor|uptime/i

const SETTINGS = Config.all({
  /** Our own addresses and @domains (commas or spaces between): their steps are kind "internal", left out of the counts. */
  internal: Config.String("OPENBELT_INTERNAL_EMAILS").pipe(
    Config.withDefault(""),
    Config.map((given) =>
      given
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== ""),
    ),
  ),
  /** OpenBelt's own hosts: a link from one of them (or a host under it) is no source. */
  hosts: Config.all([
    Config.String("OPENBELT_HOST").pipe(Config.withDefault("localhost")),
    Config.String("OPENBELT_BASE_HOST").pipe(Config.withDefault("")),
    Config.String("OPENBELT_PUBLIC_HOST").pipe(Config.withDefault("")),
  ]),
  secret: SESSION_SECRET,
})

const onList = (list: ReadonlyArray<string>, email: string) =>
  list.some((entry) => (entry.startsWith("@") ? email.endsWith(entry) : email === entry))

const under = (host: string, own: string) =>
  own !== "" && (host === own || host.endsWith(`.${own}`))

/** Where a link came from: its utm_source or ref, else the linking page's host (no www.), or undefined from OpenBelt itself or nowhere. */
const sourceOf = (url: URL, referer: string | undefined, hosts: ReadonlyArray<string>) => {
  const tagged = (url.searchParams.get("utm_source") ?? url.searchParams.get("ref") ?? "")
    .trim()
    .toLowerCase()

  if (SOURCE.test(tagged)) return tagged

  const from = URL.parse(referer ?? "")

  if (from === null || (from.protocol !== "https:" && from.protocol !== "http:")) return undefined

  const host = from.hostname.toLowerCase().replace(/^www\./, "")

  if ([url.hostname, ...hosts].some((own) => under(host, own.toLowerCase()))) return undefined

  return SOURCE.test(host) ? host : undefined
}

/** An agent's name from its User-Agent when it gave none at initialize: the product before the first "/" ("claude-code/2.1" → "claude-code"). */
export const agentOfUserAgent = (agent: string | undefined) =>
  /^([A-Za-z][\w.-]{0,59})(?:\/|\s|$)/.exec(agent ?? "")?.[1] ?? "unknown"

export type Visit = {
  readonly visitor: string
  readonly kind: Kind
  readonly source: string
  /** The source this request found, when the browser keeps none yet: keepSource sets it. */
  readonly found: string | undefined
}

/**
 * Logs one step of the funnel for this request. email is who took it, when known (shown in the line); viewer only decides kind (someone
 * signed in on the marketing page). For a person's steps, the browser's remembered email decides kind too.
 */
export const funnel = Effect.fnUntraced(function* (
  step: Step,
  url: URL | undefined,
  trace: string,
  more: {
    readonly email?: string
    readonly viewer?: string | undefined
    readonly agent?: string
    readonly detail?: string
  } = {},
) {
  const request = yield* HttpServerRequest
  const settings = yield* SETTINGS.pipe(Effect.orDie)
  const agent = request.headers["user-agent"] ?? ""
  const address = clientAddress(request.headers, Option.getOrUndefined(request.remoteAddress))
  const day = new Date().toISOString().slice(0, 10)

  const visitor = createHmac("sha256", Redacted.value(settings.secret))
    .update(`funnel\n${day}\n${address}\n${agent}`)
    .digest("hex")
    .slice(0, 16)

  const known = (
    more.email ??
    more.viewer ??
    (AGENT_STEPS.has(step) ? "" : (request.cookies[REMEMBERED_COOKIE] ?? ""))
  ).toLowerCase()

  const kind: Kind = known.endsWith(".test")
    ? "test"
    : known !== "" && onList(settings.internal, known)
      ? "internal"
      : step === "mcp"
        ? "agent"
        : more.email !== undefined || more.viewer !== undefined
          ? "person"
          : agent === "" || BOTS.test(agent)
            ? "bot"
            : "person"

  const kept = request.cookies[SOURCE_COOKIE] ?? ""

  const found =
    url === undefined ? undefined : sourceOf(url, request.headers["referer"], settings.hosts)

  const source = SOURCE.test(kept) ? kept : (found ?? "direct")

  const shown = [more.email, more.detail].filter((part) => part !== undefined && part !== "")

  const line = Effect.logInfo(`funnel: ${[step, ...shown].join(" ")}`).pipe(
    Effect.annotateLogs({ trace, step, visitor, kind, source, browser: browserOf(agent) }),
  )

  yield* more.agent === undefined ? line : line.pipe(Effect.annotateLogs("agent", more.agent))

  return { visitor, kind, source, found: SOURCE.test(kept) ? undefined : found } satisfies Visit
})

/** The answer, with the source cookie set when this request found where the visitor came from and the browser kept none yet. */
export const keepSource = (
  response: HttpServerResponse.HttpServerResponse,
  visit: Visit,
): HttpServerResponse.HttpServerResponse =>
  visit.found === undefined
    ? response
    : HttpServerResponse.setCookieUnsafe(response, SOURCE_COOKIE, visit.found, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        maxAge: Duration.days(SOURCE_DAYS),
      })
