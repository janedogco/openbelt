// (bun run dev, bun run tailnet, verify), or nobody. The gateway reads it and tells a
import { createHash, timingSafeEqual } from "node:crypto"
import { ADDRESS_HEADER, AUDIENCE_HEADER } from "./public.ts"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { THEME_HEADER, Viewer } from "./model.ts"

/**
 * __Host-: the browser keeps it to the one host that set it (Secure, Path=/, no Domain), so a page
 * of one app can't plant one that another app's host would read.
 */
export const COOKIE = "__Host-openbelt_session"

/** Sets the session cookie on this host until `until`: never readable by a page's scripts, and sent on a link followed from elsewhere. */
export const sessionCookie = (value: string, until: number) =>
  `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((until - Date.now()) / 1000))}`

/** An app's host gives the browser it sends to sign in this nonce, and takes a session back only in a ticket made for it. */
export const ATTEMPT_COOKIE = "__Host-openbelt_attempt"

export const attemptCookie = (value: string) =>
  `${ATTEMPT_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`

export const CLEARED_COOKIE = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`

/**
 * The base host remembers who last signed in (with a code or Google) in this browser, for a year: its sign-in page then says "Welcome
 * back" with the email filled in, a code one tap away. Signing out keeps it; signing in with another email replaces it.
 */
export const REMEMBERED_COOKIE = "__Host-openbelt_email"

export const REMEMBERED_DAYS = 365

const Session = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("test"),
    ...Viewer.fields,
    groups: Schema.optionalKey(Schema.Array(Schema.String)),
    host: Schema.String,
    until: Schema.Number,
    by: Schema.NullOr(Schema.String),
    /** The apps the agent that opened it may use (absent: every app): elsewhere it's a stranger. */
    apps: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("check"),
    host: Schema.String,
    until: Schema.Number,
    by: Schema.NullOr(Schema.String),
    apps: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  // Someone who signed in with an email code (OPENBELT_SIGNIN=email): `session` names the workspace's record of it (login.ts), which is
  // asked on every request, together with its originating base-host sign-in, so signing out ends the browser session across workspaces.
  Schema.Struct({
    kind: Schema.Literal("person"),
    session: Schema.String,
    host: Schema.String,
    until: Schema.Number,
  }),
])

type Session = typeof Session.Type

export const SESSION_MS = 15 * 60_000

const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(Session))

export const ADMIN_TOKEN = Config.Redacted("OPENBELT_ADMIN_TOKEN")

/**
 * What signs sessions: OPENBELT_SESSION_SECRET (bun run deploy makes one per stage and keeps it), else the admin token (bun run
 * dev, verify), so a leaked admin token doesn't also forge every session on a deployed stage. Set but empty counts as unset.
 */
export const SESSION_SECRET = Config.Redacted("OPENBELT_SESSION_SECRET").pipe(
  Config.option,
  Config.flatMap((given) =>
    Option.isSome(given) && Redacted.value(given.value) !== ""
      ? Config.succeed(given.value)
      : ADMIN_TOKEN,
  ),
)

const digest = (text: string) => createHash("sha256").update(text).digest()

/**
 * Whether an Authorization header carries the admin token, compared in constant time over both values' SHA-256 (so neither how
 * much of it matched nor its length shows in how long the answer takes).
 */
export const isAdminBearer = (header: string | undefined, adminToken: Redacted.Redacted) => {
  const sent = /^Bearer (.+)$/.exec(header ?? "")?.[1]

  return sent !== undefined && timingSafeEqual(digest(sent), digest(Redacted.value(adminToken)))
}

/**
 * What says who is viewing on this host (OPENBELT_SIGNIN):
 * - "tailscale": the front door (cameThroughFrontDoor): tailscale serve, which sets Tailscale-User-Login on every request
 *   from a person's device and replaces any a client sent (bun run dev, bun run tailnet), or an identity-aware proxy that sets
 *   it the same way (deploy/signin). A request that didn't come through it names nobody, and is refused but on the paths
 *   that carry their own credentials.
 * - "email": people sign in at /_signin with a code sent to their email, and the workspace keeps their session (login.ts). The front
 *   door still names whoever it names (bun run dev's owner door: you, with no sign-in), but a request that skipped it isn't
 *   refused: it is signed out, and a page sends it to sign in.
 * - "off": nothing: nobody is signed in, /_me is null, writes are anonymous.
 */
const SIGN_INS = ["tailscale", "email", "off"] as const

export type SignIn = (typeof SIGN_INS)[number]

export const SIGNIN = Config.Literals(SIGN_INS, "OPENBELT_SIGNIN").pipe(
  Config.withDefault("off" as const),
)

export const openHosts = (signIn: SignIn) => signIn === "off"

/**
 * Who may say who is viewing: the front door. That's a proxy on this machine (tailscale serve, bun run dev's and bun run tailnet's
 * front door, verify), which reaches OpenBelt over loopback, or one elsewhere (another container, another machine) that adds
 * `x-openbelt-front-door: <OPENBELT_FRONT_DOOR_SECRET>` to every request it forwards. Anyone else reaching the port (compose
 * publishes it on every address) could send Tailscale-User-Login and be anyone, in any workspace. With a secret set (every hosted
 * stage), only the secret counts, loopback included: whatever runs on the machine reaches loopback (gateway.ts throughFrontDoor).
 */
export const FRONT_DOOR_SECRET = Config.option(Config.Redacted("OPENBELT_FRONT_DOOR_SECRET"))

const FRONT_DOOR_HEADER = "x-openbelt-front-door"

const loopback = (address: string) =>
  address === "::1" || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address)

export const cameThroughFrontDoor = (
  remote: string | undefined,
  headers: Readonly<Record<string, string | undefined>>,
  secret: Option.Option<Redacted.Redacted>,
) => {
  if (remote !== undefined && loopback(remote)) return true

  const sent = headers[FRONT_DOOR_HEADER]

  if (sent === undefined || Option.isNone(secret)) return false

  const want = new TextEncoder().encode(Redacted.value(secret.value))
  const got = new TextEncoder().encode(sent)

  return want.length > 0 && got.length === want.length && timingSafeEqual(want, got)
}

export const GATEWAY_HEADERS = [
  "x-openbelt-viewer",
  "x-openbelt-viewer-name",
  "x-openbelt-viewer-groups",
  "x-openbelt-viewer-for",
  THEME_HEADER,
  "x-openbelt-caller",
  "x-openbelt-caller-env",
  "x-openbelt-path",
  "x-openbelt-from",
  "x-openbelt-trace",
  "x-openbelt-body",
  AUDIENCE_HEADER,
  ADDRESS_HEADER,
]

const SAYS_WHO =
  /^(tailscale-|cf-|x-openbelt-|x-forwarded-|forwarded$|x-real-ip$|true-client-ip$|host$)/

export const saysWho = (name: string) => SAYS_WHO.test(name.toLowerCase())

const CREDENTIALS = /^(cookie|authorization)$/

export const outsideHeaders = (sent: Readonly<Record<string, string>>) => {
  const headers = new Headers()

  for (const [key, value] of Object.entries(sent)) {
    const name = key.toLowerCase()

    if (GATEWAY_HEADERS.includes(name) || saysWho(name) || CREDENTIALS.test(name)) continue

    try {
      headers.append(key, value)
    } catch {}
  }

  for (const name of GATEWAY_HEADERS) headers.delete(name)

  return headers
}

/**
 * A name the front door sent as an RFC 2047 encoded word (=?utf-8?b?...?= or =?utf-8?q?...?=, as
 * tailscale serve and frontdoor.ts send one that isn't ASCII) decoded; any other value as it is.
 */
const encodedWord = (value: string) => {
  const word = /^=\?utf-8\?([bq])\?([^?]*)\?=$/i.exec(value.trim())

  if (word === null) return value

  const [, kind = "", text = ""] = word

  try {
    const bytes =
      kind.toLowerCase() === "b"
        ? Uint8Array.fromBase64(text)
        : Uint8Array.from(text.replaceAll("_", " ").match(/=[0-9a-f]{2}|[^]/gi) ?? [], (c) =>
            c.length === 3 ? Number.parseInt(c.slice(1), 16) : c.charCodeAt(0),
          )

    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return value
  }
}

export const frontDoorViewer = (
  email: string | undefined,
  name: string | undefined,
  userAgent: string | undefined,
): Viewer | null => {
  const login = (email ?? "").trim().toLowerCase()

  if (login === "" || (userAgent ?? "").includes("OpenBeltCheck/")) return null

  const shown = encodedWord(name ?? "")
    .trim()
    .slice(0, 100)

  return { email: login, name: shown === "" ? (login.split("@")[0] ?? login) : shown }
}

const base64url = (bytes: Uint8Array) =>
  bytes.toBase64({ alphabet: "base64url", omitPadding: true })

const fromBase64url = (text: string) => {
  try {
    return Uint8Array.fromBase64(text, { alphabet: "base64url" })
  } catch {
    return undefined
  }
}

/** Why a session cookie opened nothing on this host. */
type SessionRefusal =
  | "no session cookie"
  | "malformed cookie"
  | "bad signature"
  | "cookie for another host"
  | "cookie expired"

type Inspected =
  | { readonly kind: "open"; readonly session: Session }
  | { readonly kind: "refused"; readonly reason: SessionRefusal }

const refused = (reason: SessionRefusal) => ({ kind: "refused", reason }) satisfies Inspected

export const sessions = (secret: Redacted.Redacted) => {
  const key = Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(`session:${Redacted.value(secret)}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  )

  /** The session a cookie carries on `host`, or why it carries none (sign-in logs say which, so a lost session can be told from a broken one). */
  const inspect = Effect.fnUntraced(function* (cookie: string | undefined, host: string) {
    if (cookie === undefined || cookie === "") return refused("no session cookie")

    const [payload = "", signature = "", extra] = cookie.split(".")
    const sig = fromBase64url(signature)
    const body = fromBase64url(payload)

    if (payload === "" || extra !== undefined || sig === undefined || body === undefined)
      return refused("malformed cookie")

    const k = yield* key

    const ok = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", k, sig, new TextEncoder().encode(payload)).catch(() => false),
    )

    if (!ok) return refused("bad signature")

    const session = Option.getOrNull(decodeSession(new TextDecoder().decode(body)))

    if (session === null) return refused("malformed cookie")

    if (session.host !== host) return refused("cookie for another host")

    if (session.until <= Date.now()) return refused("cookie expired")

    return { kind: "open", session } satisfies Inspected
  })

  return {
    formToken: Effect.fnUntraced(function* (email: string, host: string) {
      const k = yield* key

      const signature = yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`form:${host}:${email}`)),
      )

      return base64url(new Uint8Array(signature)).slice(0, 32)
    }),

    seal: Effect.fnUntraced(function* (session: Session) {
      const payload = base64url(new TextEncoder().encode(JSON.stringify(session)))
      const k = yield* key

      const signature = yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload)),
      )

      return `${payload}.${base64url(new Uint8Array(signature))}`
    }),

    open: (cookie: string | undefined, host: string) =>
      inspect(cookie, host).pipe(
        Effect.map((opened) => (opened.kind === "open" ? opened.session : null)),
      ),

    inspect,
  }
}
