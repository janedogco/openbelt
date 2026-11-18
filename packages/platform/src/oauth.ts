import type { SqlValue } from "./runtime/index.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type AgentApps, decodeAgentApps, type Json, PersonId } from "./model.ts"
import { lookedUp, type Reach, urlProblem } from "./upstream.ts"
import { exchange, textUpTo } from "./outbound.ts"

export const ACCESS_PREFIX = "pra_"

const REFRESH_PREFIX = "prr_"

const CODE_PREFIX = "prc_"

const SCOPE = "mcp"

const CODE_MS = 5 * 60_000

const REFRESH_MS = 30 * 86_400_000

const USED_EVERY_MS = 60_000

const EXPIRED_KEPT_MS = 7 * 86_400_000

const PENDING_MS = 10 * 60_000

const DOCUMENT_MS = 60 * 60_000

const UNUSED_CLIENT_MS = 86_400_000

/** A device sign-in (RFC 8628): how long the person has to approve it, and how often its client asks. */
const DEVICE_MS = 10 * 60_000

const DEVICE_POLL_S = 5

const DEVICE_PREFIX = "prd_"

/** The page a device sign-in is approved on, and where its authorization code comes back to (this host's own). */
export const DEVICE_PATH = "/_oauth/device"

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** Consonants only: a code a person reads off a terminal spells no word, and no letter looks like a digit. */
const USER_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ"

const USER_CODE_LENGTH = 8

const USER_CODE = new RegExp(`^[${USER_CODE_LETTERS}]{${USER_CODE_LENGTH}}$`)

/** A typed user code, any case, with or without its dash: the 8 letters, or undefined. */
const userCodeOf = (typed: string) => {
  const letters = typed.toUpperCase().replaceAll(/[^A-Z]/g, "")

  return USER_CODE.test(letters) ? letters : undefined
}

/** A user code as people see it: BCDF-GHJK. */
const shownUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

const randomUserCode = () => {
  // Bytes past the last whole multiple of the alphabet are dropped, so every letter is as likely.
  const limit = 256 - (256 % USER_CODE_LETTERS.length)
  const letters: Array<string> = []

  while (letters.length < USER_CODE_LENGTH)
    for (const byte of crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH)))
      if (byte < limit && letters.length < USER_CODE_LENGTH)
        letters.push(USER_CODE_LETTERS[byte % USER_CODE_LETTERS.length] ?? "")

  return letters.join("")
}

const UNUSED_CLIENTS_KEPT = 500

const DOCUMENT_BYTES = 10_000

const hex = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes)).toHex()

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => new Uint8Array(digest)),
  )

const hashOf = (token: string) => Effect.map(sha256(token), (bytes) => bytes.toHex())

const challengeOf = (verifier: string) =>
  Effect.map(sha256(verifier), (bytes) =>
    bytes.toBase64({ alphabet: "base64url", omitPadding: true }),
  )

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/

const decodePersonId = Schema.decodeUnknownSync(PersonId)

export const metadataOf = (origin: string, workspace: string) => ({
  resource: {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: `OpenBelt (${workspace})`,
    resource_documentation: `${origin}/_settings/agents`,
  },
  server: {
    issuer: origin,
    authorization_endpoint: `${origin}/_oauth/authorize`,
    token_endpoint: `${origin}/_oauth/token`,
    registration_endpoint: `${origin}/_oauth/register`,
    revocation_endpoint: `${origin}/_oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
    device_authorization_endpoint: `${origin}/_oauth/device_authorization`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  },
})

export const challengeHeader = (origin: string, failed: string | undefined) =>
  [
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${SCOPE}"`,
    ...(failed === undefined
      ? []
      : [`error="invalid_token"`, `error_description="${failed.replaceAll(/["\\]/g, "'")}"`]),
  ].join(", ")

const ClientMetadata = Schema.Struct({
  /** Left out by a client that signs in with a device code only (the CLI): it has nowhere to be sent back to. */
  redirect_uris: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(5)),
  ),
  client_name: Schema.optionalKey(Schema.String),
  client_uri: Schema.optionalKey(Schema.String),
  logo_uri: Schema.optionalKey(Schema.String),
  grant_types: Schema.optionalKey(Schema.Array(Schema.String)),
  response_types: Schema.optionalKey(Schema.Array(Schema.String)),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  software_id: Schema.optionalKey(Schema.String),
  software_version: Schema.optionalKey(Schema.String),
})

const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(ClientMetadata))

const MetadataDocument = Schema.Struct({ client_id: Schema.String, ...ClientMetadata.fields })

const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(MetadataDocument))

const decodeUris = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

const NEVER = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:"])

const nameOf = (said: string | undefined, fallback: string) =>
  (said ?? "").replaceAll(/\s+/g, " ").trim().slice(0, 100) || fallback

const redirectProblem = (uri: string) => {
  if (!URL.canParse(uri)) return `"${uri.slice(0, 100)}" isn't a URL`

  const url = new URL(uri)

  if (url.hash !== "") return `${uri.slice(0, 100)} has a fragment (#), which a redirect URI can't`

  if (NEVER.has(url.protocol)) return `${url.protocol} can't be a redirect URI`

  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname))
    return `${uri.slice(0, 100)} is plain http to another machine: use https, or http to localhost or 127.0.0.1`

  return undefined
}

/** A loopback http URI (RFC 8252 7.3): this machine by any of its names, on any port. */
const loopbackOf = (uri: string) => {
  if (!URL.canParse(uri)) return undefined

  const url = new URL(uri)

  return url.protocol === "http:" && LOOPBACK.has(url.hostname) ? url : undefined
}

/**
 * Whether `asked` is one of `registered`: exactly, or as a loopback http URI with any of
 * localhost, 127.0.0.1 or [::1] and any port, the path and query the same. Clients register
 * http://localhost/callback and come back on http://127.0.0.1:53124/callback, or the other way.
 */
const redirectMatches = (asked: string, registered: ReadonlyArray<string>) => {
  const a = loopbackOf(asked)

  return registered.some((r) => {
    if (r === asked) return true

    const b = loopbackOf(r)

    return a !== undefined && b !== undefined && a.pathname === b.pathname && a.search === b.search
  })
}

/** What a grant says it went back to: a device sign-in (a code, on this host's page), else the redirect's host. */
export const DEVICE_HOST = "device"

const hostOf = (uri: string) => new URL(uri).host || new URL(uri).protocol

const destinationOf = (uri: string) => {
  const loopback = loopbackOf(uri)

  return loopback === undefined ? uri : `loopback:${loopback.pathname}${loopback.search}`
}

type Client = {
  readonly id: string
  readonly name: string
  readonly redirectUris: ReadonlyArray<string>
  readonly kind: "registered" | "document"
  readonly secret: boolean
}

type OAuthError = {
  readonly ok: false
  readonly status: number
  readonly error: string
  readonly description: string
}

const oauthError = (error: string, description: string, status = 400): OAuthError => ({
  ok: false,
  status,
  error,
  description,
})

const AuthorizeRequestSchema = Schema.Struct({
  responseType: Schema.String,
  clientId: Schema.String,
  redirectUri: Schema.String,
  state: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  challenge: Schema.String,
  challengeMethod: Schema.String,
  resource: Schema.optional(Schema.Struct({ url: Schema.String, ours: Schema.Boolean })),
})

export type AuthorizeRequest = typeof AuthorizeRequestSchema.Type

const decodePending = Schema.decodeUnknownOption(Schema.fromJsonString(AuthorizeRequestSchema))

type Authorize =
  | { readonly kind: "page"; readonly title: string; readonly message: string }
  | { readonly kind: "redirect"; readonly location: string }
  | {
      readonly kind: "consent"
      readonly client: Client
      readonly redirectHost: string
      readonly scope: string
      /** A device sign-in's user code (BCDF-GHJK), for the person to check against their terminal; null for any other sign-in. */
      readonly userCode: string | null
    }

export type SignedIn = {
  readonly id: string
  readonly client: string
  readonly clientName: string
  readonly redirectHost: string
  readonly created: string
  readonly used: string
  readonly apps: AgentApps
}

type AccessCheck =
  | {
      readonly kind: "valid"
      readonly person: PersonId
      readonly grant: string
      readonly client: string
      readonly apps: AgentApps
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "expired"; readonly expired: string }
  | { readonly kind: "revoked"; readonly revoked: string; readonly why: string }

type TokenAnswer = { readonly status: number; readonly body: Readonly<Record<string, Json>> }

export type ClientRow = {
  id: string
  name: string
  redirect_uris: string
  secret_hash: string | null
  kind: string
}

const toClient = (row: ClientRow): Client => ({
  id: row.id,
  name: row.name,
  redirectUris: decodeUris(row.redirect_uris),
  kind: row.kind === "document" ? "document" : "registered",
  secret: row.secret_hash !== null,
})

const tokenFail = (e: OAuthError): TokenAnswer => ({
  status: e.status,
  body: { error: e.error, error_description: e.description },
})

type DevicePoll =
  | { readonly kind: "answer"; readonly answer: TokenAnswer }
  | { readonly kind: "code"; readonly code: string; readonly verifier: string }

const deviceAnswer = (error: string, description: string): DevicePoll => ({
  kind: "answer",
  answer: tokenFail(oauthError(error, description)),
})

type GrantRow = {
  id: string
  client: string
  client_name: string
  redirect_host: string
  person: string
  scope: string
  created: string
  used: string
  revoked: string | null
  revoked_why: string | null
  refresh_current: string | null
  refresh_previous: string | null
  apps: string | null
}

type Pair = {
  readonly access: string
  readonly refresh: string
  readonly accessHash: string
  readonly refreshHash: string
}

export const openOAuth = Effect.fn("OAuth.open")(function* (
  storage: DurableObjectStorage,
  reach: Reach,
  accessMs: number,
  secret: string,
) {
  const { sql } = storage

  const rows = <T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: Array<string | number | null>
  ) => Effect.flatMap(sql.exec<T>(query, ...bindings), (cursor) => cursor.toArray())

  const written = (query: string, ...bindings: Array<string | number | null>) =>
    Effect.flatMap(sql.exec(query, ...bindings), (cursor) => cursor.rowsWritten)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, secret_hash TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('registered', 'document')), created TEXT NOT NULL,
    fetched INTEGER)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY, client TEXT NOT NULL, client_name TEXT NOT NULL,
    redirect_host TEXT NOT NULL, person TEXT NOT NULL, scope TEXT NOT NULL, created TEXT NOT NULL,
    used TEXT NOT NULL, revoked TEXT, revoked_why TEXT, refresh_current TEXT,
    refresh_previous TEXT)`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS oauth_grants_person ON oauth_grants (person)")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS oauth_codes (
    hash TEXT PRIMARY KEY, client TEXT NOT NULL, person TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL, grant_id TEXT,
    used INTEGER NOT NULL DEFAULT 0)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS oauth_tokens (
    hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), expires INTEGER NOT NULL,
    used INTEGER)`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id)")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS oauth_consents (
    person TEXT NOT NULL, client TEXT NOT NULL, destination TEXT NOT NULL, granted TEXT NOT NULL,
    PRIMARY KEY (person, client, destination))`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS oauth_pending (
    hash TEXT PRIMARY KEY, person TEXT NOT NULL, request TEXT NOT NULL, expires INTEGER NOT NULL)`)

  const grantColumns = (yield* rows<{ name: string }>("PRAGMA table_info(oauth_grants)")).map(
    (c) => c.name,
  )

  for (const column of ["refresh_current", "refresh_previous", "apps"]) {
    if (!grantColumns.includes(column))
      yield* sql.exec(`ALTER TABLE oauth_grants ADD COLUMN ${column} TEXT`)
  }

  const key = yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(`openbelt-oauth:${secret}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  )

  const successorOf = Effect.fnUntraced(function* (refresh: string) {
    const derive = (label: string) =>
      Effect.promise(() =>
        crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${label}:${refresh}`)),
      ).pipe(Effect.map((mac) => new Uint8Array(mac).toHex()))

    const access = `${ACCESS_PREFIX}${yield* derive("access")}`
    const next = `${REFRESH_PREFIX}${yield* derive("refresh")}`

    return {
      access,
      refresh: next,
      accessHash: yield* hashOf(access),
      refreshHash: yield* hashOf(next),
    } satisfies Pair
  })

  const freshPair = Effect.fnUntraced(function* () {
    const access = `${ACCESS_PREFIX}${hex(32)}`
    const refresh = `${REFRESH_PREFIX}${hex(32)}`

    return {
      access,
      refresh,
      accessHash: yield* hashOf(access),
      refreshHash: yield* hashOf(refresh),
    } satisfies Pair
  })

  const commit = <A, E>(effect: Effect.Effect<A, E>) => storage.transaction(effect)

  const stored = Effect.fnUntraced(function* (id: string) {
    const [row] = yield* rows<ClientRow & { fetched: number | null }>(
      "SELECT id, name, redirect_uris, secret_hash, kind, fetched FROM oauth_clients WHERE id = ?",
      id,
    )

    return row
  })

  const pruneClients = Effect.fnUntraced(function* () {
    const unused = `id NOT IN (SELECT client FROM oauth_grants) AND id NOT IN (SELECT client FROM oauth_codes)
         AND id NOT IN (SELECT client FROM oauth_consents)`

    yield* sql.exec(
      `DELETE FROM oauth_clients WHERE created < ? AND ${unused}`,
      new Date(Date.now() - UNUSED_CLIENT_MS).toISOString(),
    )
    yield* sql.exec(
      `DELETE FROM oauth_clients WHERE id IN (
         SELECT id FROM oauth_clients WHERE ${unused} ORDER BY created DESC LIMIT -1 OFFSET ?)`,
      UNUSED_CLIENTS_KEPT,
    )
  })

  const fetchDocument = Effect.fnUntraced(function* (id: string) {
    const problem = urlProblem(id, reach, "client") ?? (yield* lookedUp(id))

    if (problem !== undefined)
      return oauthError("invalid_client", `the client_id ${id} can't be fetched: ${problem}`)

    const text = yield* exchange(
      {
        kind: "client-document",
        url: id,
        headers: { accept: "application/json" },
        timeoutMs: 5000,
      },
      (answer) =>
        answer.status < 200 || answer.status >= 300
          ? Effect.succeed(`HTTP ${answer.status}`)
          : textUpTo(answer, DOCUMENT_BYTES).pipe(Effect.map((got) => got ?? "over 10 KB")),
    ).pipe(Effect.orElseSucceed(() => "no answer"))

    const document = decodeDocument(text)

    if (Option.isNone(document))
      return oauthError(
        "invalid_client",
        `the client_id ${id} is a URL, so OpenBelt fetched it for the client's metadata, and got ${text.startsWith("HTTP") || text === "no answer" || text === "over 10 KB" ? text : "JSON without client_id and redirect_uris"}`,
      )

    if (document.value.client_id !== id)
      return oauthError(
        "invalid_client",
        `the metadata document at ${id} names ${document.value.client_id} as its client_id: it must name its own URL`,
      )

    const redirects = document.value.redirect_uris ?? []
    const bad = redirects.map(redirectProblem).find((p) => p !== undefined)

    if (bad !== undefined)
      return oauthError("invalid_client", `the metadata document at ${id}: ${bad}`)

    const name = nameOf(document.value.client_name, new URL(id).host)
    const uris = JSON.stringify(redirects)

    yield* sql.exec(
      `INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, kind, created, fetched)
       VALUES (?, ?, ?, NULL, 'document', ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris,
         fetched = excluded.fetched`,
      id,
      name,
      uris,
      new Date().toISOString(),
      Date.now(),
    )

    yield* pruneClients()

    return {
      ok: true as const,
      client: toClient({ id, name, redirect_uris: uris, secret_hash: null, kind: "document" }),
    }
  })

  const clientOf = Effect.fnUntraced(function* (id: string) {
    const row = yield* stored(id)
    const isDocument = id.startsWith("https://") || (reach.allowLocal && id.startsWith("http://"))

    if (
      row !== undefined &&
      (row.kind === "registered" || (row.fetched ?? 0) + DOCUMENT_MS > Date.now())
    )
      return { ok: true as const, client: toClient(row) }

    if (isDocument) {
      const fetched = yield* fetchDocument(id)

      return !fetched.ok && row !== undefined
        ? { ok: true as const, client: toClient(row) }
        : fetched
    }

    return oauthError(
      "invalid_client",
      `there's no client "${id.slice(0, 80)}" in this workspace: register first (POST /_oauth/register), or use an https URL to your client's metadata document as client_id`,
      401,
    )
  })

  const secretMatches = Effect.fnUntraced(function* (id: string, given: string | undefined) {
    const row = yield* stored(id)

    if (row === undefined || row.secret_hash === null) return true

    return given !== undefined && (yield* hashOf(given)) === row.secret_hash
  })

  const keepPair = Effect.fnUntraced(function* (grant: string, pair: Pair) {
    const now = Date.now()

    yield* sql.exec(
      `INSERT INTO oauth_tokens (hash, grant_id, kind, expires) VALUES (?, ?, 'access', ?), (?, ?, 'refresh', ?)
       ON CONFLICT (hash) DO UPDATE SET expires = MAX(expires, excluded.expires)`,
      pair.accessHash,
      grant,
      now + accessMs,
      pair.refreshHash,
      grant,
      now + REFRESH_MS,
    )

    yield* sql.exec(
      "DELETE FROM oauth_tokens WHERE (kind = 'refresh' AND expires < ?) OR expires < ?",
      now,
      now - EXPIRED_KEPT_MS,
    )
    yield* sql.exec("DELETE FROM oauth_codes WHERE expires < ?", now)
    yield* sql.exec("DELETE FROM oauth_pending WHERE expires < ?", now)
  })

  const pairBody = (pair: Pair, scope: string) => ({
    access_token: pair.access,
    token_type: "Bearer",
    expires_in: Math.round(accessMs / 1000),
    refresh_token: pair.refresh,
    scope,
  })

  const signOutGrant = (grant: string, why: string) =>
    written(
      "UPDATE oauth_grants SET revoked = ?, revoked_why = ? WHERE id = ? AND revoked IS NULL",
      new Date().toISOString(),
      why,
      grant,
    )

  /** The client a token or device request is from: its client_id (or Authorization: Basic), and its secret when it has one. */
  const authenticated = Effect.fnUntraced(function* (
    form: Readonly<Record<string, string>>,
    basic: { readonly id: string; readonly secret: string } | undefined,
  ) {
    const clientId = basic?.id ?? form["client_id"] ?? ""

    if (clientId === "")
      return oauthError("invalid_client", "send client_id (or Authorization: Basic)", 401)

    const found = yield* clientOf(clientId)

    if (!found.ok) return found

    if (!(yield* secretMatches(clientId, basic?.secret ?? form["client_secret"])))
      return oauthError("invalid_client", "the client_secret isn't this client's", 401)

    return found
  })

  const mac = (text: string) =>
    Effect.promise(() => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))).pipe(
      Effect.map((signed) => new Uint8Array(signed)),
    )

  /** The PKCE verifier of a device sign-in: derived from its device code, so it is never stored and only the client can trade. */
  const verifierOf = (deviceCode: string) =>
    Effect.map(mac(`device-verifier:${deviceCode}`), (bytes) =>
      bytes.toBase64({ alphabet: "base64url", omitPadding: true }),
    )

  // Made on the first device sign-in, not when the object starts: an object's start stays as cheap as it was, and most never
  // see one.
  let devicesMade = false

  const devices = Effect.suspend(() =>
    devicesMade
      ? Effect.void
      : sql
          .exec(`CREATE TABLE IF NOT EXISTS oauth_devices (
              hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, state TEXT NOT NULL UNIQUE,
              client TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, polled INTEGER,
              interval INTEGER NOT NULL, code TEXT, refused TEXT)`)
          .pipe(Effect.tap(() => Effect.sync(() => (devicesMade = true)))),
  )

  /** The device sign-in an authorize link is for, while it waits: the same client, state and challenge the device page gave. */
  const waitingDevice = Effect.fnUntraced(function* (
    client: string,
    state: string | undefined,
    challenge: string,
  ) {
    yield* devices

    const [row] = yield* rows<{ user_code: string }>(
      `SELECT user_code FROM oauth_devices WHERE state = ? AND client = ? AND challenge = ?
         AND code IS NULL AND refused IS NULL AND expires >= ?`,
      state ?? "",
      client,
      challenge,
      Date.now(),
    )

    return row === undefined ? undefined : shownUserCode(row.user_code)
  })

  const pollDevice = Effect.fnUntraced(function* (
    deviceCode: string,
    client: string,
  ): Effect.fn.Return<DevicePoll> {
    yield* devices

    const hash = yield* hashOf(deviceCode)
    const verifier = yield* verifierOf(deviceCode)

    return yield* commit(
      Effect.gen(function* () {
        const [row] = yield* rows<{
          client: string
          expires: number
          polled: number | null
          interval: number
          code: string | null
          refused: string | null
        }>(
          "SELECT client, expires, polled, interval, code, refused FROM oauth_devices WHERE hash = ?",
          hash,
        )

        if (row === undefined || row.client !== client)
          return deviceAnswer(
            "invalid_grant",
            "that device_code isn't one this host gave this client: sign in again",
          )

        const now = Date.now()
        const done = sql.exec("DELETE FROM oauth_devices WHERE hash = ?", hash)

        if (row.refused !== null) {
          yield* done

          return deviceAnswer("access_denied", row.refused)
        }

        if (row.code !== null) {
          yield* done

          return { kind: "code", code: row.code, verifier } satisfies DevicePoll
        }

        if (row.expires < now) {
          yield* done

          return deviceAnswer(
            "expired_token",
            "nobody approved this sign-in within 10 minutes: sign in again",
          )
        }

        // RFC 8628 3.5: asking sooner than the interval (a second's leeway) adds 5 seconds to it.
        const early = row.polled !== null && now - row.polled < (row.interval - 1) * 1000
        const interval = row.interval + (early ? 5 : 0)

        yield* sql.exec(
          "UPDATE oauth_devices SET polled = ?, interval = ? WHERE hash = ?",
          now,
          interval,
          hash,
        )

        return early
          ? deviceAnswer("slow_down", `ask every ${interval} seconds`)
          : deviceAnswer("authorization_pending", "the person hasn't approved this sign-in yet")
      }),
    )
  })

  const forgetConsent = (person: string, client: string) =>
    sql.exec("DELETE FROM oauth_consents WHERE person = ? AND client = ?", person, client)

  return {
    /** A client as it is stored, to copy into another object (one MCP address: registered at the base host, signed in to a workspace). */
    clientRow: Effect.fnUntraced(function* (id: string) {
      const row = yield* stored(id)

      return row === undefined
        ? null
        : ({
            id: row.id,
            name: row.name,
            redirect_uris: row.redirect_uris,
            secret_hash: row.secret_hash,
            kind: row.kind,
          } satisfies ClientRow)
    }),

    /** A client registered elsewhere (the base host), kept here as it was, so this workspace can sign it in and trade its codes. */
    adopt: Effect.fnUntraced(function* (row: ClientRow) {
      yield* sql.exec(
        `INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, kind, created, fetched)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        row.id,
        row.name,
        row.redirect_uris,
        row.secret_hash,
        row.kind,
        new Date().toISOString(),
        row.kind === "document" ? Date.now() : null,
      )
    }),

    register: Effect.fnUntraced(function* (text: string) {
      const asked = decodeMetadata(text)

      if (Option.isNone(asked))
        return oauthError(
          "invalid_client_metadata",
          'send JSON with redirect_uris, like {"client_name": "My agent", "redirect_uris": ["http://127.0.0.1:33418/callback"]}',
        )

      const metadata = asked.value
      const redirects = metadata.redirect_uris ?? []
      const bad = redirects.map(redirectProblem).find((p) => p !== undefined)

      if (bad !== undefined) return oauthError("invalid_redirect_uri", bad)

      // Liberal in what it takes: grant types and response types it doesn't do are left out of
      // the answer (RFC 7591 3.2.1), not refused; only one with neither authorization_code nor
      // the device code is.
      const grants = metadata.grant_types ?? ["authorization_code"]
      const device = grants.includes(DEVICE_GRANT)

      if (!grants.includes("authorization_code") && !device)
        return oauthError(
          "invalid_client_metadata",
          `OpenBelt signs agents in with authorization_code or ${DEVICE_GRANT} (and refresh_token), and grant_types has ${grants.join(", ") || "none"}`,
        )

      if (redirects.length === 0 && !device)
        return oauthError(
          "invalid_redirect_uri",
          `send redirect_uris (where to send the person back), or sign in with a device code (grant_types with ${DEVICE_GRANT}), which needs none`,
        )

      const asksFor = metadata.token_endpoint_auth_method ?? "none"

      const method = ["none", "client_secret_post", "client_secret_basic"].includes(asksFor)
        ? asksFor
        : "client_secret_basic"

      const id = `c_${hex(12)}`
      const clientSecret = method === "none" ? undefined : `prs_${hex(24)}`
      const name = nameOf(metadata.client_name, "An unnamed agent")
      const now = new Date()

      yield* sql.exec(
        `INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, kind, created)
         VALUES (?, ?, ?, ?, 'registered', ?)`,
        id,
        name,
        JSON.stringify(redirects),
        clientSecret === undefined ? null : yield* hashOf(clientSecret),
        now.toISOString(),
      )
      yield* pruneClients()

      const registered = {
        client_id: id,
        client_id_issued_at: Math.floor(now.getTime() / 1000),
        client_name: name,
        redirect_uris: [...redirects],
        grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
        response_types: ["code"],
        token_endpoint_auth_method: method,
        scope: SCOPE,
      }

      const body: TokenAnswer["body"] =
        clientSecret === undefined
          ? registered
          : { ...registered, client_secret: clientSecret, client_secret_expires_at: 0 }

      return { ok: true as const, id, name, body }
    }),

    authorize: Effect.fnUntraced(function* (
      asked: AuthorizeRequest,
      issuer: string,
      person: PersonId | undefined,
      /** A device sign-in another object keeps (the base host's), already found waiting there: its user code. */
      deviceElsewhere?: string,
    ): Effect.fn.Return<Authorize> {
      if (asked.clientId === "")
        return {
          kind: "page",
          title: "This sign-in link is incomplete",
          message: "Go back to your agent and start signing in again.",
        }

      const found = yield* clientOf(asked.clientId)

      if (!found.ok)
        return { kind: "page", title: "Unknown client", message: `${found.description}.` }

      const client = found.client

      // A device sign-in's code comes back to this host's own page: only for a device sign-in of this client that is waiting,
      // started at /_oauth/device_authorization and opened from the device page (its state and challenge).
      const device = asked.redirectUri === `${issuer}${DEVICE_PATH}`

      const userCode = !device
        ? undefined
        : (deviceElsewhere ?? (yield* waitingDevice(client.id, asked.state, asked.challenge)))

      if (device && userCode === undefined)
        return {
          kind: "page",
          title: "This sign-in code was used or ran out",
          message: "Go back to your terminal and sign in again.",
        }

      if (
        asked.redirectUri === "" ||
        (!device && !redirectMatches(asked.redirectUri, client.redirectUris))
      )
        return {
          kind: "page",
          title: "Unknown redirect",
          message: `${client.name} didn't register ${asked.redirectUri === "" ? "a redirect_uri on this link" : asked.redirectUri} as where to send you back, so OpenBelt won't send you there. Start again from your agent.`,
        }

      // RFC 9207: iss on every answer, so a client talking to several servers knows whose it is.
      const back = (params: Readonly<Record<string, string>>) => {
        const url = new URL(asked.redirectUri)

        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

        if (asked.state !== undefined) url.searchParams.set("state", asked.state)

        url.searchParams.set("iss", issuer)

        return { kind: "redirect" as const, location: url.toString() }
      }

      const fail = (error: string, description: string) =>
        back({ error, error_description: description })

      if (asked.responseType !== "code")
        return fail("unsupported_response_type", "OpenBelt answers response_type=code only")

      if (asked.challenge === "" || !CHALLENGE.test(asked.challenge))
        return fail(
          "invalid_request",
          "PKCE is required: send code_challenge (43 base64url characters) with code_challenge_method=S256",
        )

      if (asked.challengeMethod !== "S256")
        return fail(
          "invalid_request",
          `code_challenge_method must be S256${asked.challengeMethod === "" ? "" : `, not ${asked.challengeMethod}`}`,
        )

      if (asked.resource !== undefined && !asked.resource.ours)
        return fail(
          "invalid_target",
          `${asked.resource.url} isn't this workspace's MCP server: a sign-in here is for ${issuer}/mcp only`,
        )

      const scope = SCOPE

      if (person === undefined)
        return {
          kind: "consent",
          client,
          redirectHost: device ? DEVICE_HOST : hostOf(asked.redirectUri),
          scope,
          userCode: userCode ?? null,
        }

      const code = `${CODE_PREFIX}${hex(24)}`

      yield* sql.exec(
        `INSERT INTO oauth_codes (hash, client, person, redirect_uri, challenge, scope, expires)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        yield* hashOf(code),
        client.id,
        person,
        asked.redirectUri,
        asked.challenge,
        scope,
        Date.now() + CODE_MS,
      )

      return back({ code })
    }),

    denied: (asked: AuthorizeRequest, issuer: string) => {
      const url = new URL(asked.redirectUri)

      url.searchParams.set("error", "access_denied")
      url.searchParams.set("error_description", "the person didn't allow it")

      if (asked.state !== undefined) url.searchParams.set("state", asked.state)

      url.searchParams.set("iss", issuer)

      return url.toString()
    },

    remembered: Effect.fnUntraced(function* (
      person: PersonId,
      client: string,
      redirectUri: string,
    ) {
      const [row] = yield* rows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM oauth_consents WHERE person = ? AND client = ? AND destination = ?",
        person,
        client,
        destinationOf(redirectUri),
      )

      return (row?.n ?? 0) > 0
    }),

    remember: Effect.fnUntraced(function* (person: PersonId, client: string, redirectUri: string) {
      yield* sql.exec(
        `INSERT INTO oauth_consents (person, client, destination, granted) VALUES (?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET granted = excluded.granted`,
        person,
        client,
        destinationOf(redirectUri),
        new Date().toISOString(),
      )
    }),

    pend: Effect.fnUntraced(function* (person: PersonId, asked: AuthorizeRequest) {
      const handle = `h_${hex(16)}`

      yield* sql.exec(
        "INSERT INTO oauth_pending (hash, person, request, expires) VALUES (?, ?, ?, ?)",
        yield* hashOf(handle),
        person,
        JSON.stringify(asked),
        Date.now() + PENDING_MS,
      )

      return handle
    }),

    take: Effect.fnUntraced(function* (handle: string) {
      const hash = yield* hashOf(handle)

      const [row] = yield* rows<{ person: string; request: string; expires: number }>(
        "SELECT person, request, expires FROM oauth_pending WHERE hash = ?",
        hash,
      )

      if (row === undefined) return undefined

      yield* sql.exec("DELETE FROM oauth_pending WHERE hash = ?", hash)

      const asked = decodePending(row.request)

      return row.expires < Date.now() || Option.isNone(asked)
        ? undefined
        : { person: decodePersonId(row.person), asked: asked.value }
    }),

    token: Effect.fnUntraced(function* (
      form: Readonly<Record<string, string>>,
      basic: { readonly id: string; readonly secret: string } | undefined,
      active: (person: PersonId) => Effect.Effect<boolean>,
      issuer: string,
    ): Effect.fn.Return<TokenAnswer> {
      const fail = tokenFail
      const found = yield* authenticated(form, basic)

      if (!found.ok) return fail(found)

      const client = found.client
      const grantType = form["grant_type"] ?? ""

      const trade = Effect.fnUntraced(function* (
        code: string,
        verifier: string,
        redirectUri: string | undefined,
      ): Effect.fn.Return<TokenAnswer> {
        if (verifier === "")
          return fail(
            oauthError(
              "invalid_request",
              "code_verifier is required: OpenBelt signs in with PKCE (S256) only",
            ),
          )

        if (!VERIFIER.test(verifier))
          return fail(
            oauthError(
              "invalid_request",
              "code_verifier must be 43-128 characters of A-Z a-z 0-9 - . _ ~",
            ),
          )

        const hash = yield* hashOf(code)
        const challenge = yield* challengeOf(verifier)
        const pair = yield* freshPair()

        return yield* commit(
          Effect.gen(function* () {
            const [row] = yield* rows<{
              client: string
              person: string
              redirect_uri: string
              challenge: string
              scope: string
              expires: number
              grant_id: string | null
            }>(
              "SELECT client, person, redirect_uri, challenge, scope, expires, grant_id FROM oauth_codes WHERE hash = ?",
              hash,
            )

            if (row === undefined || row.client !== client.id)
              return fail(
                oauthError(
                  "invalid_grant",
                  "that code isn't one this workspace gave this client: sign in again",
                ),
              )

            // Used once: a second use means it leaked, so what it made is signed out (RFC 6749 4.1.2).
            if (
              (yield* written(
                "UPDATE oauth_codes SET used = 1 WHERE hash = ? AND used = 0",
                hash,
              )) === 0
            ) {
              if (row.grant_id !== null)
                yield* signOutGrant(
                  row.grant_id,
                  "its sign-in code was used twice, so OpenBelt signed it out",
                )

              return fail(oauthError("invalid_grant", "that code was used already: sign in again"))
            }

            if (row.expires < Date.now())
              return fail(
                oauthError(
                  "invalid_grant",
                  "that code expired (they last 5 minutes): sign in again",
                ),
              )

            if (redirectUri !== undefined && redirectUri !== row.redirect_uri)
              return fail(
                oauthError("invalid_grant", "redirect_uri isn't the one the code was given for"),
              )

            if (challenge !== row.challenge)
              return fail(
                oauthError(
                  "invalid_grant",
                  "code_verifier doesn't match the code_challenge it was given for",
                ),
              )

            const person = decodePersonId(row.person)

            if (!(yield* active(person)))
              return fail(
                oauthError(
                  "invalid_grant",
                  "the person who signed in isn't in the workspace any more",
                ),
              )

            const grant = `g_${hex(8)}`
            const now = new Date().toISOString()

            const redirectHost =
              row.redirect_uri === `${issuer}${DEVICE_PATH}`
                ? DEVICE_HOST
                : hostOf(row.redirect_uri)

            // A new sign-in by the same agent (its name, and where it sends you back) keeps the apps its last one was limited to.
            const [last] = yield* rows<{ apps: string | null }>(
              "SELECT apps FROM oauth_grants WHERE person = ? AND client_name = ? AND redirect_host = ? ORDER BY created DESC LIMIT 1",
              person,
              client.name,
              redirectHost,
            )

            yield* sql.exec(
              `INSERT INTO oauth_grants (id, client, client_name, redirect_host, person, scope, created,
                 used, refresh_current, apps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              grant,
              client.id,
              client.name,
              redirectHost,
              person,
              row.scope,
              now,
              now,
              pair.refreshHash,
              last?.apps ?? null,
            )
            yield* sql.exec("UPDATE oauth_codes SET grant_id = ? WHERE hash = ?", grant, hash)
            yield* keepPair(grant, pair)

            return { status: 200, body: pairBody(pair, row.scope) } satisfies TokenAnswer
          }),
        )
      })

      // RFC 8628: once the person approved, the device code stands for the authorization code their
      // approval made, traded with the verifier only this server derives from the device code.
      if (grantType === DEVICE_GRANT) {
        const polled = yield* pollDevice(form["device_code"] ?? "", client.id)

        return polled.kind === "answer"
          ? polled.answer
          : yield* trade(polled.code, polled.verifier, undefined)
      }

      if (grantType === "authorization_code")
        return yield* trade(form["code"] ?? "", form["code_verifier"] ?? "", form["redirect_uri"])

      if (grantType === "refresh_token") {
        const presented = form["refresh_token"] ?? ""
        const hash = yield* hashOf(presented)
        const next = yield* successorOf(presented)

        return yield* commit(
          Effect.gen(function* () {
            const [row] = yield* rows<GrantRow & { kind: string; expires: number }>(
              `SELECT g.*, t.kind, t.expires FROM oauth_tokens t
               JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?`,
              hash,
            )

            const which =
              row === undefined
                ? "unknown"
                : hash === row.refresh_current
                  ? "current"
                  : hash === row.refresh_previous
                    ? "previous"
                    : "older"

            yield* Effect.logInfo(
              `oauth/refresh client=${client.name} grant=${row?.id ?? "-"} token=${hash.slice(0, 8)} is=${which}${row?.revoked === null || row === undefined ? "" : " revoked"}`,
            )

            if (row === undefined || row.kind !== "refresh")
              return fail(
                oauthError(
                  "invalid_grant",
                  "that refresh token isn't one this workspace gave: sign in again",
                ),
              )

            if (row.client !== client.id) {
              yield* signOutGrant(
                row.id,
                `its refresh token was presented by another client (${client.name}), so OpenBelt signed it out`,
              )

              return fail(
                oauthError(
                  "invalid_grant",
                  "that refresh token isn't this client's: sign in again",
                ),
              )
            }

            if (row.revoked !== null)
              return fail(
                oauthError(
                  "invalid_grant",
                  `this sign-in was signed out on ${row.revoked.slice(0, 10)}: ${row.revoked_why ?? ""}. Sign in again`,
                ),
              )

            if (row.expires < Date.now())
              return fail(
                oauthError(
                  "invalid_grant",
                  "that refresh token expired (unused for 30 days): sign in again",
                ),
              )

            if (which === "older")
              return fail(
                oauthError(
                  "invalid_grant",
                  "that refresh token was replaced twice since (another copy of this client refreshed): sign in again",
                ),
              )

            if (!(yield* active(decodePersonId(row.person)))) {
              yield* signOutGrant(row.id, "the person isn't in the workspace any more")

              return fail(
                oauthError(
                  "invalid_grant",
                  "the person who signed in isn't in the workspace any more",
                ),
              )
            }

            if (which === "current")
              yield* sql.exec(
                "UPDATE oauth_grants SET refresh_previous = ?, refresh_current = ? WHERE id = ?",
                hash,
                next.refreshHash,
                row.id,
              )

            yield* keepPair(row.id, next)

            return { status: 200, body: pairBody(next, row.scope) } satisfies TokenAnswer
          }),
        )
      }

      return fail(
        oauthError(
          grantType === "" ? "invalid_request" : "unsupported_grant_type",
          `grant_type must be authorization_code, refresh_token or ${DEVICE_GRANT}${grantType === "" ? "" : `, not ${grantType}`}`,
        ),
      )
    }),

    /** POST /_oauth/device_authorization (RFC 8628 3.1): a device code for the client to poll with, and a user code for the person. */
    deviceStart: Effect.fnUntraced(function* (
      form: Readonly<Record<string, string>>,
      basic: { readonly id: string; readonly secret: string } | undefined,
      issuer: string,
    ): Effect.fn.Return<TokenAnswer> {
      const found = yield* authenticated(form, basic)

      if (!found.ok) return tokenFail(found)

      yield* devices

      const deviceCode = `${DEVICE_PREFIX}${hex(32)}`
      const userCode = randomUserCode()
      const now = Date.now()

      yield* sql.exec("DELETE FROM oauth_devices WHERE expires < ?", now - DEVICE_MS)

      const made = yield* written(
        `INSERT INTO oauth_devices (hash, user_code, state, client, challenge, expires, interval)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        yield* hashOf(deviceCode),
        userCode,
        hex(16),
        found.client.id,
        yield* challengeOf(yield* verifierOf(deviceCode)),
        now + DEVICE_MS,
        DEVICE_POLL_S,
      )

      if (made === 0) return tokenFail(oauthError("temporarily_unavailable", "ask again", 503))

      const page = `${issuer}${DEVICE_PATH}`

      return {
        status: 200,
        body: {
          device_code: deviceCode,
          user_code: shownUserCode(userCode),
          verification_uri: page,
          verification_uri_complete: `${page}?user_code=${shownUserCode(userCode)}`,
          expires_in: DEVICE_MS / 1000,
          interval: DEVICE_POLL_S,
        },
      } satisfies TokenAnswer
    }),

    /**
     * The device sign-in a person typed or followed the code of, while it waits for them: the client's name, and the
     * authorization link that asks for their consent as any agent's sign-in does, coming back to this host's page.
     */
    deviceFind: Effect.fnUntraced(function* (typed: string, issuer: string) {
      const code = userCodeOf(typed)

      if (code === undefined) return undefined

      yield* devices

      const [row] = yield* rows<{
        client: string
        state: string
        challenge: string
        expires: number
        code: string | null
        refused: string | null
      }>(
        "SELECT client, state, challenge, expires, code, refused FROM oauth_devices WHERE user_code = ?",
        code,
      )

      if (
        row === undefined ||
        row.expires < Date.now() ||
        row.code !== null ||
        row.refused !== null
      )
        return undefined

      const found = yield* clientOf(row.client)

      if (!found.ok) return undefined

      const link = new URL(`${issuer}/_oauth/authorize`)

      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: found.client.id,
        redirect_uri: `${issuer}${DEVICE_PATH}`,
        code_challenge: row.challenge,
        code_challenge_method: "S256",
        state: row.state,
      }))
        link.searchParams.set(k, v)

      return { client: found.client.name, userCode: shownUserCode(code), authorize: link.href }
    }),

    /** The consent's answer, back on this host's device page: the code the client trades next, or why it was refused. Once, in time. */
    deviceDone: Effect.fnUntraced(function* (
      state: string,
      outcome: { readonly code: string } | { readonly refused: string },
    ) {
      yield* devices

      return (
        (yield* written(
          `UPDATE oauth_devices SET code = ?, refused = ?
           WHERE state = ? AND code IS NULL AND refused IS NULL AND expires >= ?`,
          "code" in outcome ? outcome.code : null,
          "refused" in outcome ? outcome.refused : null,
          state,
          Date.now(),
        )) > 0
      )
    }),

    /** A device code's poll where the token endpoint is another object's (the base host's, which trades the code at the workspace). */
    devicePoll: Effect.fnUntraced(function* (
      form: Readonly<Record<string, string>>,
      basic: { readonly id: string; readonly secret: string } | undefined,
    ): Effect.fn.Return<DevicePoll> {
      const found = yield* authenticated(form, basic)

      if (!found.ok) return { kind: "answer", answer: tokenFail(found) }

      return yield* pollDevice(form["device_code"] ?? "", found.client.id)
    }),

    check: Effect.fnUntraced(function* (token: string) {
      const hash = yield* hashOf(token)

      const [row] = yield* rows<{
        id: string
        person: string
        client_name: string
        used: string
        revoked: string | null
        revoked_why: string | null
        kind: string
        expires: number
        apps: string | null
      }>(
        `SELECT g.id, g.person, g.client_name, g.used, g.revoked, g.revoked_why, t.kind, t.expires, g.apps FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?`,
        hash,
      )

      if (row === undefined || row.kind !== "access") {
        yield* Effect.logInfo(`oauth/use access=${hash.slice(0, 8)} is=unknown`)

        return { kind: "unknown" } satisfies AccessCheck
      }

      if (row.revoked !== null)
        return {
          kind: "revoked",
          revoked: row.revoked,
          why: row.revoked_why ?? "",
        } satisfies AccessCheck

      const now = Date.now()

      if (row.expires <= now) {
        yield* Effect.logInfo(
          `oauth/use access=${hash.slice(0, 8)} grant=${row.id} is=expired ${Math.round((now - row.expires) / 1000)}s ago`,
        )

        return {
          kind: "expired",
          expired: new Date(row.expires).toISOString(),
        } satisfies AccessCheck
      }

      if (row.expires - now < accessMs / 2)
        yield* sql.exec("UPDATE oauth_tokens SET expires = ? WHERE hash = ?", now + accessMs, hash)

      if (Date.parse(row.used) + USED_EVERY_MS < now)
        yield* sql.exec(
          "UPDATE oauth_grants SET used = ? WHERE id = ?",
          new Date(now).toISOString(),
          row.id,
        )

      return {
        kind: "valid",
        person: decodePersonId(row.person),
        grant: row.id,
        client: row.client_name,
        apps: decodeAgentApps(row.apps),
      } satisfies AccessCheck
    }),

    /**
     * POST /_oauth/revoke (RFC 7009): sign out the grant an access or refresh token is of, when
     * the client is the grant's. Answers 200 either way, as the RFC says.
     */
    revoke: Effect.fnUntraced(function* (token: string, clientId: string) {
      const [row] = yield* rows<{ grant_id: string; client: string; person: string }>(
        `SELECT t.grant_id, g.client, g.person FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.hash = ?`,
        yield* hashOf(token),
      )

      if (row === undefined || (clientId !== "" && row.client !== clientId)) return false

      yield* forgetConsent(row.person, row.client)

      return (yield* signOutGrant(row.grant_id, "its client signed it out (revoked its token)")) > 0
    }),

    signedIn: Effect.fnUntraced(function* (person: PersonId) {
      const found = yield* rows<GrantRow>(
        "SELECT * FROM oauth_grants WHERE person = ? AND revoked IS NULL ORDER BY created DESC",
        person,
      )

      return found.map((g): SignedIn => ({
        id: g.id,
        client: g.client,
        clientName: g.client_name,
        redirectHost: g.redirect_host,
        created: g.created,
        used: g.used,
        apps: decodeAgentApps(g.apps),
      }))
    }),

    setApps: Effect.fnUntraced(function* (person: PersonId, grant: string, apps: AgentApps) {
      return yield* written(
        "UPDATE oauth_grants SET apps = ? WHERE id = ? AND person = ? AND revoked IS NULL",
        apps === null ? null : JSON.stringify(apps),
        grant,
        person,
      )
    }),

    signOut: Effect.fnUntraced(function* (person: PersonId, grant: string, why: string) {
      const [row] = yield* rows<{ person: string; client: string }>(
        "SELECT person, client FROM oauth_grants WHERE id = ? AND revoked IS NULL",
        grant,
      )

      if (row === undefined || row.person !== person) return false

      yield* forgetConsent(person, row.client)

      return (yield* signOutGrant(grant, why)) > 0
    }),

    signOutPerson: Effect.fnUntraced(function* (person: PersonId, why: string) {
      yield* sql.exec("DELETE FROM oauth_consents WHERE person = ?", person)
      yield* sql.exec("DELETE FROM oauth_pending WHERE person = ?", person)

      return yield* written(
        "UPDATE oauth_grants SET revoked = ?, revoked_why = ? WHERE person = ? AND revoked IS NULL",
        new Date().toISOString(),
        why,
        person,
      )
    }),
  }
})
