// Sign in with Google on the base host (OPENBELT_GOOGLE_CLIENT_ID and OPENBELT_GOOGLE_CLIENT_SECRET, under email sign-in): Google
// says who someone is instead of a code sent to them. The base host is an OpenID Connect client of Google's: PKCE, a nonce, and a
// state kept by the base host's object (apex.ts, login.ts) and bound to this browser by a cookie. The ID token comes straight from
// Google's token endpoint over TLS, as the answer to a code and the client's secret, so its claims are checked (issuer, audience,
// expiry, nonce, a verified email) but not its signature (OpenID Connect Core 3.1.3.7). OPENBELT_GOOGLE_ISSUER is Google unless a
// check points it at a stand-in.
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { exchange, textUpTo } from "./outbound.ts"

const TIMEOUT_MS = 10_000

const MOST_BYTES = 64 * 1024

/** The browser's half of a Google sign-in: the state the base host sent Google, for 10 minutes. */
export const GOOGLE_COOKIE = "__Host-openbelt_google"

export const googleCookie = (state: string) =>
  `${GOOGLE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`

export const CLEARED_GOOGLE_COOKIE = `${GOOGLE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`

export type Google = {
  readonly id: string
  readonly secret: Redacted.Redacted
  readonly issuer: string
}

/** Google sign-in's client, when both halves are set; otherwise the base host signs in with codes alone. */
export const GOOGLE = Config.all({
  id: Config.String("OPENBELT_GOOGLE_CLIENT_ID").pipe(Config.withDefault("")),
  secret: Config.Redacted("OPENBELT_GOOGLE_CLIENT_SECRET").pipe(Config.option),
  issuer: Config.String("OPENBELT_GOOGLE_ISSUER").pipe(
    Config.withDefault("https://accounts.google.com"),
  ),
}).pipe(
  Config.map(({ id, secret, issuer }): Google | null =>
    id === "" || Option.isNone(secret) || Redacted.value(secret.value) === ""
      ? null
      : { id, secret: secret.value, issuer: issuer.replace(/\/$/, "") },
  ),
)

/** Where the base host's Google sign-in comes back. */
const googleRedirect = (origin: string) => `${origin}/_signin/google/callback`

const Discovery = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      issuer: Schema.String,
      authorization_endpoint: Schema.String,
      token_endpoint: Schema.String,
    }),
  ),
)

const TokenAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id_token: Schema.String })),
)

const Claims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      iss: Schema.String,
      aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      exp: Schema.Number,
      nonce: Schema.optionalKey(Schema.String),
      email: Schema.optionalKey(Schema.String),
      email_verified: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
    }),
  ),
)

type Endpoints = { readonly authorize: string; readonly token: string; readonly issuer: string }

/** Google's endpoints, from its discovery document (read once per object). */
export const endpointsOf = (google: Google) =>
  exchange(
    {
      kind: "oauth",
      url: `${google.issuer}/.well-known/openid-configuration`,
      timeoutMs: TIMEOUT_MS,
    },
    (answer) =>
      textUpTo(answer, MOST_BYTES).pipe(
        Effect.map((text) =>
          Option.map(Discovery(text ?? ""), (d): Endpoints => ({
            authorize: d.authorization_endpoint,
            token: d.token_endpoint,
            issuer: d.issuer,
          })),
        ),
      ),
  ).pipe(
    Effect.catchTag("OutboundFailed", () => Effect.succeed(Option.none<Endpoints>())),
    Effect.map(Option.getOrUndefined),
  )

/** The link that sends someone to Google: an email they're expected to use is offered first. */
export const authorizeLink = (
  endpoints: Endpoints,
  google: Google,
  p: {
    readonly origin: string
    readonly state: string
    readonly nonce: string
    readonly challenge: string
    readonly hint: string | null
  },
) => {
  const link = new URL(endpoints.authorize)

  const params = new URLSearchParams({
    response_type: "code",
    client_id: google.id,
    redirect_uri: googleRedirect(p.origin),
    scope: "openid email",
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  })

  if (p.hint !== null) params.set("login_hint", p.hint)

  link.search = params.toString()

  return link.toString()
}

/** Who Google says signed in: their verified email, or why not (for the log; the page says Google sign-in didn't work). */
export const emailFromGoogle = Effect.fnUntraced(function* (
  endpoints: Endpoints,
  google: Google,
  p: {
    readonly origin: string
    readonly code: string
    readonly verifier: string
    readonly nonce: string
  },
) {
  const reply = yield* exchange(
    {
      kind: "oauth",
      method: "POST",
      url: endpoints.token,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: p.code,
        redirect_uri: googleRedirect(p.origin),
        client_id: google.id,
        client_secret: Redacted.value(google.secret),
        code_verifier: p.verifier,
      }).toString(),
      timeoutMs: TIMEOUT_MS,
    },
    (answer) =>
      textUpTo(answer, MOST_BYTES).pipe(Effect.map((text) => ({ status: answer.status, text }))),
  ).pipe(
    Effect.catchTag("OutboundFailed", (error) =>
      Effect.succeed({ status: 0, text: `unreachable: ${error.detail}` }),
    ),
  )

  const token = TokenAnswer(reply.text ?? "")

  if (reply.status !== 200 || Option.isNone(token))
    return {
      ok: false as const,
      why: `Google's token endpoint answered ${reply.status}: ${(reply.text ?? "").slice(0, 200)}`,
    }

  const payload = token.value.id_token.split(".")[1] ?? ""

  const claims = Claims(
    new TextDecoder().decode(Uint8Array.fromBase64(payload, { alphabet: "base64url" })),
  )

  if (Option.isNone(claims)) return { ok: false as const, why: "an ID token it couldn't read" }

  const c = claims.value
  const audience = Array.isArray(c.aud) ? c.aud : [c.aud]
  // Google's tokens name it either way (its documentation): with the scheme, or without.
  const issuers = [endpoints.issuer, endpoints.issuer.replace(/^https:\/\//, "")]

  const why = !issuers.includes(c.iss)
    ? `the ID token is from ${c.iss}`
    : !audience.includes(google.id)
      ? "the ID token is for another client"
      : c.exp * 1000 < Date.now()
        ? "the ID token expired"
        : c.nonce !== p.nonce
          ? "the ID token's nonce isn't this sign-in's"
          : c.email === undefined || !(c.email_verified === true || c.email_verified === "true")
            ? "Google didn't say the email is verified"
            : null

  return why === null
    ? { ok: true as const, email: (c.email ?? "").toLowerCase() }
    : { ok: false as const, why }
})
