import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Refused } from "./model.ts"
import type { AuthServer } from "./oauth-discovery.ts"
import type { Quirks } from "./providers.ts"
import { decodeJson, type Fetcher, LIMITED, normalized } from "./oauth-wire.ts"

const Registered = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
})

/** A token answer as servers send it: some say expires_in as a string ("3600"). */
const TokensSent = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Union([Schema.Number, Schema.NumberFromString])),
  refresh_token: Schema.optionalKey(Schema.String),
  /** How long the refresh token lasts (Google, for an app in Testing: 7 days); a string too. */
  refresh_token_expires_in: Schema.optionalKey(
    Schema.Union([Schema.Number, Schema.NumberFromString]),
  ),
  scope: Schema.optionalKey(Schema.String),
})

const LONGEST_S = 365 * 24 * 60 * 60

export type Tokens = {
  readonly access_token: string
  readonly token_type: string | undefined
  readonly expires_in: number | undefined
  readonly refresh_token: string | undefined
  readonly refresh_token_expires_in: number | undefined
  readonly scope: string | undefined
}

const tokensOf = (sent: typeof TokensSent.Type): Tokens => {
  const seconds = sent.expires_in

  return {
    access_token: sent.access_token,
    token_type: sent.token_type,
    expires_in:
      seconds === undefined || !Number.isFinite(seconds) || seconds < 1
        ? undefined
        : Math.min(Math.floor(seconds), LONGEST_S),
    refresh_token: sent.refresh_token,
    refresh_token_expires_in: sent.refresh_token_expires_in,
    scope: sent.scope,
  }
}

const TokenError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
  /** Google's finer reason under invalid_grant: invalid_rapt (its session control). */
  error_subtype: Schema.optionalKey(Schema.String),
})

/** RFC 6749 §5.2's errors: the server's verdict on a grant, so the credential is dead (reconnect). */
const VERDICTS = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
])

export const registrationOf = (issuer: string) =>
  `${new URL(issuer).hostname.replace(/[^a-z0-9-]/g, "_")}-${createHash("sha256").update(normalized(issuer)).digest("hex").slice(0, 12)}`

/**
 * Where a workspace host's sign-ins with one registration come back: one redirect URI per
 * authorization server (or an admin's app at it), shared by the connections that sign in there.
 * A code can only come back on the one its server was sent to: with one for all, a malicious
 * connection's server could send someone on to another server's sign-in and have that server's
 * code (and the PKCE verifier) sent to its own token endpoint (RFC 9700 §4.4, mix-up).
 */
export const callbackOf = (origin: string, registration: string) =>
  `${origin}/_oauth/callback/${registration}`

export const clientDocument = (origin: string, registration: string) => ({
  client_id: `${origin}/_oauth/clients/${registration}.json`,
  client_name: `OpenBelt (${new URL(origin).hostname})`,
  client_uri: origin,
  redirect_uris: [callbackOf(origin, registration)],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
})

export type Client = {
  readonly clientId: string
  readonly secret: string | undefined
  readonly auth: "none" | "client_secret_post" | "client_secret_basic"
  readonly method: "cimd" | "dcr" | "registered"
}

/**
 * How OpenBelt gets a client at `server` with nothing registered yet, in MCP's order (2026-07-28:
 * an admin's app first, which the caller already looked for; then a client ID metadata document;
 * then dynamic registration, deprecated): cimd when the server takes one and `reachable` (the workspace
 * host is one the server can fetch the document from: public https, no front door in the way);
 * dcr when it takes registrations; admin when it takes neither (an admin registers an app there).
 */
export const howToRegister = (server: AuthServer, reachable: boolean) =>
  server.client_id_metadata_document_supported === true && reachable
    ? ("cimd" as const)
    : server.registration_endpoint !== undefined
      ? ("dcr" as const)
      : ("admin" as const)

export const documented = (origin: string, registration: string) =>
  ({
    clientId: clientDocument(origin, registration).client_id,
    secret: undefined,
    auth: "none",
    method: "cimd",
  }) satisfies Client

export const register = Effect.fn("oauth.register")(function* (
  http: Fetcher,
  name: string,
  origin: string,
  registration: string,
  server: AuthServer,
  endpoint: string,
) {
  const { client_id: _, ...metadata } = clientDocument(origin, registration)

  const got = yield* http.fetch(name, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(metadata),
  })

  const registered = Option.getOrUndefined(decodeJson(Registered)(got.text))

  if (got.status >= 300 || registered === undefined)
    return yield* new Refused({
      message: `${name}'s authorization server ${server.issuer} refused OpenBelt's registration (HTTP ${got.status}): ${got.text.slice(0, 300)}`,
    })

  // Exactly as the server registered it; with a secret and no method, RFC 7591's default (basic).
  const method = registered.token_endpoint_auth_method

  const auth =
    registered.client_secret === undefined || method === "none"
      ? "none"
      : method === "client_secret_post"
        ? "client_secret_post"
        : "client_secret_basic"

  return {
    clientId: registered.client_id,
    secret: registered.client_secret,
    auth,
    method: "dcr",
  } satisfies Client
})

const base64url = (bytes: Uint8Array) =>
  bytes.toBase64({ alphabet: "base64url", omitPadding: true })

export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

export const pkce = Effect.fnUntraced(function* () {
  const verifier = randomToken()

  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )

  return { verifier, challenge: base64url(new Uint8Array(digest)) }
})

export const PROTOCOL_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
])

export const authorizeUrl = (input: {
  readonly server: AuthServer
  readonly quirks: Quirks
  readonly clientId: string
  readonly redirect: string
  readonly scopes: ReadonlyArray<string>
  readonly resource: string
  readonly state: string
  readonly challenge: string
  readonly params: Readonly<Record<string, string>>
}) => {
  const url = new URL(input.server.authorization_endpoint)
  const query = new URLSearchParams(url.search)

  for (const [key, value] of Object.entries(input.params))
    if (!PROTOCOL_PARAMS.has(key)) query.set(key, value)

  query.set("response_type", "code")
  query.set("client_id", input.clientId)
  query.set("redirect_uri", input.redirect)
  query.set("state", input.state)
  query.set("code_challenge", input.challenge)
  query.set("code_challenge_method", "S256")

  if (input.quirks.sendResource) query.set("resource", input.resource)

  if (input.scopes.length > 0) query.set("scope", input.scopes.join(" "))

  url.search = query.toString()

  return url.toString()
}

type Granted =
  | { readonly kind: "tokens"; readonly tokens: Tokens }
  | {
      readonly kind: "verdict"
      readonly error: string
      readonly description: string
      readonly why: string
    }
  | { readonly kind: "forgotten"; readonly description: string }
  | {
      readonly kind: "transient"
      readonly status: number
      readonly limited: boolean
      readonly retryAfter: number | undefined
      readonly why: string
    }

/** Retry-After (RFC 9110 §10.2.3): seconds, or a date; undefined when it says neither. */
const retryAfterOf = (header: string | null) => {
  if (header === null) return undefined

  const seconds = /^\s*(\d{1,7})\s*$/.exec(header)?.[1]

  if (seconds !== undefined) return Number(seconds)

  const at = Date.parse(header)

  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

const clientAuth = (client: Client, form: URLSearchParams) => {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  })

  if (client.auth === "client_secret_basic" && client.secret !== undefined)
    headers.set(
      "authorization",
      `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`)}`,
    )
  else form.set("client_id", client.clientId)

  if (client.auth === "client_secret_post" && client.secret !== undefined)
    form.set("client_secret", client.secret)

  return headers
}

export const grant = Effect.fn("oauth.grant")(function* (
  http: Fetcher,
  name: string,
  server: AuthServer,
  client: Client,
  fields: Readonly<Record<string, string>>,
  timeoutMs?: number,
) {
  const form = new URLSearchParams(fields)
  const headers = clientAuth(client, form)

  const got = yield* Effect.result(
    http.fetch(
      name,
      server.token_endpoint,
      { method: "POST", headers, body: form.toString() },
      timeoutMs,
    ),
  )

  if (Result.isFailure(got))
    return {
      kind: "transient",
      status: 0,
      limited: false,
      retryAfter: undefined,
      why: "no answer",
    } satisfies Granted

  const { status, text } = got.success
  const sent = Option.getOrUndefined(decodeJson(TokensSent)(text))

  // token_type isn't checked: servers say "bearer", "Bearer", even "user" (Slack) for one.
  if (status === 200 && sent !== undefined)
    return { kind: "tokens", tokens: tokensOf(sent) } satisfies Granted

  const error = Option.getOrUndefined(decodeJson(TokenError)(text))
  const description = (error?.error_description ?? "").slice(0, 200)
  const said = `${error?.error ?? ""} ${error?.error_subtype ?? ""} ${description}`

  // A rate limit decides nothing about the grant, whatever the status says it with (Google
  // answers some with 400 and "User rate limit exceeded").
  if (status === 429 || LIMITED.test(said))
    return {
      kind: "transient",
      status,
      limited: true,
      retryAfter: retryAfterOf(got.success.headers.get("retry-after")),
      why: `rate-limited (HTTP ${status}${description === "" ? "" : `: ${description}`})`,
    } satisfies Granted

  // GitHub answers a refused grant with HTTP 200 and its own codes (bad_refresh_token,
  // bad_verification_code): an error in a 200 is the server's verdict too.
  const verdict =
    error !== undefined &&
    (status === 200 ||
      (status >= 400 && status < 500 && (VERDICTS.has(error.error) || /invalid_rapt/.test(said))))

  if (error !== undefined && verdict && error.error === "invalid_client")
    return { kind: "forgotten", description } satisfies Granted

  if (error !== undefined && verdict)
    return {
      kind: "verdict",
      error: error.error,
      description,
      why: /invalid_rapt/.test(said)
        ? `it wants you to sign in again: your session there needs re-authentication (${error.error}, invalid_rapt: Google's session control)`
        : `${error.error}${description === "" ? "" : `, ${description}`}`,
    } satisfies Granted

  if (status === 200)
    return {
      kind: "verdict",
      error: "unreadable_answer",
      description: "",
      why: "it answered HTTP 200 with no token OpenBelt can read",
    } satisfies Granted

  return {
    kind: "transient",
    status,
    limited: false,
    retryAfter: retryAfterOf(got.success.headers.get("retry-after")),
    why: `HTTP ${status}`,
  } satisfies Granted
})

export const revoke = Effect.fn("oauth.revoke")(function* (
  http: Fetcher,
  name: string,
  endpoint: string,
  client: Client,
  token: string,
  hint: "refresh_token" | "access_token",
) {
  const form = new URLSearchParams({ token, token_type_hint: hint })
  const headers = clientAuth(client, form)

  const got = yield* Effect.result(
    http.fetch(name, endpoint, { method: "POST", headers, body: form.toString() }),
  )

  if (Result.isFailure(got) || got.success.status >= 500 || got.success.status === 429)
    return "unanswered" as const

  return got.success.status === 200 ? ("revoked" as const) : ("refused" as const)
})
