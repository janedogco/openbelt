import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Refused } from "./model.ts"
import { bearerChallenge, decodeJson, type Fetcher, normalized, same } from "./oauth-wire.ts"

const ProtectedResource = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
})

const AuthServer = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  revocation_endpoint: Schema.optionalKey(Schema.String),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  client_id_metadata_document_supported: Schema.optionalKey(Schema.Boolean),
  code_challenge_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  authorization_response_iss_parameter_supported: Schema.optionalKey(Schema.Boolean),
})

export type AuthServer = typeof AuthServer.Type

export const decodeAuthServer = Schema.decodeUnknownSync(Schema.fromJsonString(AuthServer))

const decodeServer = decodeJson(AuthServer)

const decodeResource = decodeJson(ProtectedResource)

/** RFC 9728 §3.1: the well-known URL with the resource's path after it, then at the root. */
const resourceMetadataUrls = (resource: URL) => {
  const path = resource.pathname.replace(/\/$/, "")

  return [
    ...(path === "" ? [] : [`${resource.origin}/.well-known/oauth-protected-resource${path}`]),
    `${resource.origin}/.well-known/oauth-protected-resource`,
  ]
}

/** RFC 8414 §3.1 (path inserted), then OIDC with the path inserted, then OIDC appended. */
const serverMetadataUrls = (issuer: URL) => {
  const path = issuer.pathname.replace(/\/$/, "")

  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    ...(path === "" ? [] : [`${issuer.origin}${path}/.well-known/openid-configuration`]),
  ]
}

/**
 * RFC 9728 §3.3: metadata naming `named` covers the connection at `url` when it's for that URL, or
 * for one that contains it: its origin (a server that names its root), or a path above it on the
 * same origin (Google's per-tool metadata names .../mcp for .../mcp/v1). Never another origin:
 * tokens for one host aren't sent to another.
 */
const covers = (named: string, url: string) => {
  const mcp = new URL(url)
  const asking = normalized(`${mcp.origin}${mcp.pathname}`)
  const resource = normalized(named)

  return (
    resource === asking ||
    resource === mcp.origin ||
    (URL.canParse(resource) &&
      new URL(resource).origin === mcp.origin &&
      asking.startsWith(`${resource}/`))
  )
}

const READS = /(^|[^a-z])read(only)?($|[^a-z])/i

/**
 * The scopes as a request may ask for them: Entra's `.default` (everything the app was granted
 * for one resource) can't be asked for beside another scope (AADSTS70011), so when one is among
 * them it's asked for alone, with offline_access when that's there (how Entra gives a refresh
 * token).
 */
export const askable = (scopes: ReadonlyArray<string>) => {
  const all = scopes.find((s) => s === ".default" || s.endsWith("/.default"))

  return all === undefined
    ? scopes
    : [all, ...(scopes.includes("offline_access") ? ["offline_access"] : [])]
}

const narrowScopes = (offered: ReadonlyArray<string>) => {
  const reading = offered.filter((s) => READS.test(s))

  return reading.length > 0 ? reading : offered
}

export type Found = {
  readonly resource: string
  readonly scopes: ReadonlyArray<string>
  readonly offered: ReadonlyArray<string>
  readonly server: AuthServer
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "openbelt", version: "1.0.0" },
  },
})

export const discover = Effect.fn("oauth.discover")(function* (
  http: Fetcher,
  name: string,
  url: string,
  challengeHeader?: string,
) {
  const probe =
    challengeHeader === undefined
      ? yield* http.fetch(name, url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: INITIALIZE,
        })
      : { status: 401, headers: new Headers({ "www-authenticate": challengeHeader }), text: "" }

  // Not a 401: still OAuth when it publishes protected resource metadata (RFC 9728 §3), as
  // Google's Workspace MCP servers do while answering initialize 200.
  const asked = probe.status === 401
  const challenge = bearerChallenge(asked ? probe.headers.get("www-authenticate") : null)
  const mcp = new URL(url)

  const candidates =
    challenge.metadata === undefined ? resourceMetadataUrls(mcp) : [challenge.metadata]

  let resource: typeof ProtectedResource.Type | undefined

  for (const candidate of candidates) {
    const got = yield* http.fetch(name, candidate, { headers: { accept: "application/json" } })

    resource = got.status === 200 ? Option.getOrUndefined(decodeResource(got.text)) : undefined

    if (resource !== undefined) break
  }

  if (!asked && resource === undefined) return Option.none<Found>()

  // A Bearer 401 with no resource metadata: a server of the 2025-03-26 spec names none, and its
  // authorization server is at its own origin (Atlassian's is). One with no metadata there either
  // wants a token of its own kind (pasted).
  if (resource === undefined && challenge.bearer) {
    const legacy = yield* http.fetch(name, `${mcp.origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
    })

    const server =
      legacy.status === 200 ? Option.getOrUndefined(decodeServer(legacy.text)) : undefined

    if (server !== undefined && same(server.issuer, mcp.origin))
      resource = {
        resource: `${mcp.origin}${mcp.pathname}`,
        authorization_servers: [server.issuer],
      }
  }

  if (resource === undefined) return Option.none<Found>()

  if (!covers(resource.resource, url))
    return yield* new Refused({
      message: `${name}'s protected resource metadata is for ${resource.resource}, not ${url}: check the connection's URL`,
    })

  const issuer = resource.authorization_servers[0]

  if (issuer === undefined || !URL.canParse(issuer))
    return yield* new Refused({
      message: `${name}'s protected resource metadata names no authorization server, so there's nowhere to sign in`,
    })

  const server = yield* serverAt(http, name, issuer)

  const scopes =
    challenge.scope === undefined
      ? narrowScopes(resource.scopes_supported ?? server.scopes_supported ?? [])
      : challenge.scope.split(" ").filter((s) => s !== "")

  // Without offline_access some servers give no refresh token, so every hour is a reconnect.
  const offline =
    server.scopes_supported?.includes("offline_access") === true &&
    !scopes.includes("offline_access")
      ? ["offline_access"]
      : []

  return Option.some<Found>({
    resource: resource.resource,
    scopes: askable([...scopes, ...offline]),
    offered: resource.scopes_supported ?? server.scopes_supported ?? [],
    server,
  })
})

/**
 * How an HTTP API (not an MCP server) signs in: where its protected resource metadata says, when
 * it publishes some for its URL, else at the issuer its catalog entry names (Google's APIs publish
 * none). Scopes are the entry's, so none are guessed here.
 */
export const discoverApi = Effect.fn("oauth.discoverApi")(function* (
  http: Fetcher,
  name: string,
  url: string,
  issuer: string | undefined,
) {
  let resource: typeof ProtectedResource.Type | undefined

  for (const candidate of resourceMetadataUrls(new URL(url))) {
    const got = yield* http.fetch(name, candidate, { headers: { accept: "application/json" } })

    resource = got.status === 200 ? Option.getOrUndefined(decodeResource(got.text)) : undefined

    if (resource !== undefined) break
  }

  if (resource !== undefined && !covers(resource.resource, url))
    return yield* new Refused({
      message: `${name}'s protected resource metadata is for ${resource.resource}, not ${url}: check the connection's URL`,
    })

  const at = resource?.authorization_servers[0] ?? issuer

  if (at === undefined || !URL.canParse(at)) return Option.none<Found>()

  const server = yield* serverAt(http, name, at)

  return Option.some<Found>({
    resource: resource?.resource ?? url,
    scopes: [],
    offered: resource?.scopes_supported ?? server.scopes_supported ?? [],
    server,
  })
})

const serverAt = Effect.fnUntraced(function* (http: Fetcher, name: string, issuer: string) {
  for (const candidate of serverMetadataUrls(new URL(issuer))) {
    const got = yield* http.fetch(name, candidate, { headers: { accept: "application/json" } })
    const server = got.status === 200 ? Option.getOrUndefined(decodeServer(got.text)) : undefined

    // RFC 8414 §3.3: the issuer in the metadata is the one asked for.
    if (server !== undefined && same(server.issuer, issuer)) {
      if (!(server.code_challenge_methods_supported ?? ["S256"]).includes("S256"))
        return yield* new Refused({
          message: `${name}'s authorization server ${issuer} doesn't do PKCE with S256, which MCP requires: OpenBelt can't sign in to it`,
        })

      const signInPage = http.pageProblem(server.authorization_endpoint)

      if (signInPage !== undefined)
        return yield* new Refused({
          message: `${name}'s authorization server sends people to sign in at ${server.authorization_endpoint.slice(0, 200)}, which OpenBelt doesn't send anyone to: ${signInPage}`,
        })

      return server
    }
  }

  return yield* new Refused({
    message: `${name}'s authorization server ${issuer} publishes no RFC 8414 or OpenID metadata, so OpenBelt can't sign in to it`,
  })
})
