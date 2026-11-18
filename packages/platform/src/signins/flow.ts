import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { type Person, Refused } from "../model.ts"
import { authorizeUrl, pkce, PROTOCOL_PARAMS, randomToken } from "../oauth-client.ts"
import { askable, discover, discoverApi, type Found } from "../oauth-discovery.ts"
import { normalized, same } from "../oauth-wire.ts"
import { providerAt } from "../providers.ts"
import { type Context, connectLink, keyOf, verifierKeyOf } from "./context.ts"
import type { Registrations } from "./registrations.ts"
import type { Revocations } from "./revocation.ts"
import { scopesOf, type SignIn, type Store, TOKEN } from "./store.ts"

export const SignInReturn = Schema.Struct({
  state: Schema.String,
  code: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
  iss: Schema.optionalKey(Schema.String),
})

export type SignInReturn = typeof SignInReturn.Type

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const SIGN_IN_MS = 10 * 60_000

const MORE_SCOPES = 10

const paramsOf = (text: string) => {
  const params = Object.fromEntries(
    text
      .split(/\s+/)
      .filter((p) => p.includes("="))
      .map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as const),
  )

  const protocol = Object.keys(params).filter((k) => PROTOCOL_PARAMS.has(k))

  return protocol.length === 0
    ? Effect.succeed(params)
    : Effect.fail(
        new Refused({
          message: `authorize parameters can't set ${protocol.join(", ")}: those are the sign-in's own (${[...PROTOCOL_PARAMS].join(", ")}), and scopes are asked for as scopes. Take ${protocol.length === 1 ? "it" : "them"} out`,
        }),
      )
}

export type Takes = (connection: string, owner: string) => Effect.Effect<boolean>

export const openFlow = (
  ctx: Context,
  store: Store,
  registrations: Registrations,
  revocations: Revocations,
  takes: Takes,
) => {
  const { sql, rows, sealer, http } = ctx

  const signedInOf = (column: "connection" | "owner", value: string) =>
    rows<{ connection: string; owner: string }>(
      `SELECT connection, owner FROM connection_credentials WHERE ${column} = ? AND client IS NOT NULL`,
      value,
    )

  const endSignIns = Effect.fnUntraced(function* (connection: string) {
    const ending = yield* signedInOf("connection", connection)

    yield* ctx.commit(
      Effect.gen(function* () {
        yield* revocations.revokeAfter(ending)
        yield* sql.exec(
          "DELETE FROM connection_credentials WHERE connection = ? AND client IS NOT NULL",
          connection,
        )
        yield* sql.exec("DELETE FROM connection_signins WHERE connection = ?", connection)
      }),
    )
    ctx.forgetSessions((k) => k.startsWith(keyOf(connection, "")))

    if (ending.length > 0)
      yield* Effect.logInfo(
        `connection ${connection}: ${ending.length} sign-in${ending.length === 1 ? "" : "s"} ended (it doesn't sign in that way anymore)`,
      )
  })

  const forgetOAuth = Effect.fnUntraced(function* (connection: string) {
    yield* endSignIns(connection)
    yield* sql.exec("DELETE FROM connection_oauth WHERE connection = ?", connection)
    yield* registrations.forgetUnusedClients
  })

  const keepSignIn = Effect.fnUntraced(function* (
    connection: string,
    found: Found,
    scopes: string | undefined,
    params: Readonly<Record<string, string>>,
    origin: string,
  ) {
    const before = yield* store.signInOf(connection)

    if (before === undefined) {
      yield* sql.exec(
        "DELETE FROM connection_credentials WHERE connection = ? AND client IS NULL",
        connection,
      )
      ctx.forgetSessions((k) => k.startsWith(keyOf(connection, "")))
    }

    if (before !== undefined && !same(before.server.issuer, found.server.issuer)) {
      yield* Effect.logInfo(
        `connection ${connection}: it signs in at ${found.server.issuer} now, not ${before.server.issuer}, so OpenBelt registers there again`,
      )
      yield* endSignIns(connection)
    }

    yield* sql.exec(
      `INSERT INTO connection_oauth (connection, resource, scopes, server, discovered, params) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection) DO UPDATE SET resource = excluded.resource, scopes = excluded.scopes,
         server = excluded.server, discovered = excluded.discovered, params = excluded.params`,
      connection,
      found.resource,
      JSON.stringify(scopes === undefined ? found.scopes : askable(scopesOf(scopes))),
      JSON.stringify(found.server),
      new Date().toISOString(),
      JSON.stringify(params),
    )

    const provider = providerAt({ issuer: found.server.issuer })

    if (provider !== undefined)
      yield* sql.exec(
        "UPDATE connections SET provider = ? WHERE name = ? AND provider IS NULL",
        provider,
        connection,
      )

    yield* registrations.forgetUnusedClients

    const signIn = yield* store.signInOf(connection)

    if (signIn === undefined) return yield* Effect.die("a sign-in just kept is there")

    const registered = yield* Effect.result(registrations.clientFor(connection, signIn, origin))

    if (Result.isFailure(registered))
      yield* Effect.logInfo(
        `connection ${connection}: not registered yet: ${registered.failure.message}`,
      )

    return signIn
  })

  return {
    endSignIns,

    signedInOf,

    discover: Effect.fnUntraced(function* (
      connection: string,
      url: string,
      takesNone: boolean,
      mode: "oauth" | "token" | undefined,
      origin: string,
      scopes: string | undefined,
      params: string | undefined,
    ) {
      const extra = yield* paramsOf(params ?? "")

      if (takesNone || mode === "token") {
        yield* forgetOAuth(connection)

        return undefined
      }

      const found = yield* discover(http, connection, url)

      if (Option.isNone(found)) {
        if (mode === "oauth")
          return yield* new Refused({
            message: `${connection} doesn't sign in with OAuth: it publishes no protected resource metadata (RFC 9728), at its well-known URL or in a 401's challenge. Add it with signIn "token", and set its token`,
          })

        yield* forgetOAuth(connection)

        return undefined
      }

      return yield* keepSignIn(connection, found.value, scopes, extra, origin)
    }),

    /** An HTTP API's sign-in: its metadata's authorization server, else its catalog entry's issuer. */
    discoverApi: Effect.fnUntraced(function* (
      connection: string,
      url: string,
      issuer: string | undefined,
      origin: string,
      scopes: string,
      params: string | undefined,
    ) {
      const extra = yield* paramsOf(params ?? "")
      const found = yield* discoverApi(http, connection, url, issuer)

      if (Option.isNone(found))
        return yield* new Refused({
          message: `${connection} names no authorization server to sign in at: it publishes no protected resource metadata (RFC 9728), and it isn't from OpenBelt's catalog. Add it with its token instead (credential "workspace" or "person", then set the token)`,
        })

      return yield* keepSignIn(connection, found.value, scopes, extra, origin)
    }),

    challenged: Effect.fnUntraced(function* (
      connection: string,
      url: string,
      takesNone: boolean,
      mode: "oauth" | "token" | undefined,
      owner: string | undefined,
      challenge: string,
      origin: string,
    ) {
      const turnedDown = new Refused({
        message: `${connection} refused OpenBelt (HTTP 401): it wants a token${owner === undefined ? ", and this call had none" : " this call's isn't"}`,
      })

      if ((yield* store.signInOf(connection)) !== undefined) return yield* turnedDown

      if (mode === "token")
        return yield* new Refused({
          message: `${connection} refused OpenBelt (HTTP 401) asking for a sign-in (OAuth), and a workspace admin set it up to take pasted tokens: ${owner === undefined ? "this call had none" : "the token this call sent isn't one it takes"}. Set a token it takes, or a workspace admin adds it again to sign in with OAuth (signIn "oauth")`,
        })

      const found = yield* discover(http, connection, url, challenge)

      if (Option.isNone(found)) return yield* turnedDown

      const issuer = found.value.server.issuer

      yield* Effect.logInfo(
        `connection ${connection}: a call was answered 401 naming OAuth metadata, so it signs in with OAuth at ${issuer}`,
      )

      if (takesNone)
        return yield* new Refused({
          message: `${connection} asks for a sign-in (OAuth at ${issuer}) when a tool is called, and it's set up to take no token: a workspace admin adds it again taking each person's sign-in (credential "person", or "workspace"), on ${origin}/_connections/${connection}`,
          connect: { url: `${origin}/_connections/${connection}`, why: "admin_setup" },
        })

      yield* keepSignIn(connection, found.value, undefined, {}, origin)

      const whose = owner ?? "me"
      const connect = connectLink(origin, connection, whose, "not_connected")

      return yield* new Refused({
        message: `${connection} signs in with OAuth (at ${issuer}: its tools asked for it), so a pasted token doesn't do: ${whose === "workspace" ? "a workspace admin connects it for the workspace: send one this link" : "connect yours: open (or send the person) this link"}, ${connect.url}`,
        connect,
      })
    }),

    start: Effect.fnUntraced(function* (
      connection: string,
      signIn: SignIn,
      owner: string,
      person: Person,
      origin: string,
      back: string,
      more: ReadonlyArray<string>,
    ) {
      const offered = signIn.server.scopes_supported
      const extra = more.filter((s) => !signIn.scopes.includes(s))

      const odd = extra.filter(
        (s) => !TOKEN.test(s) || (offered !== undefined && !offered.includes(s)),
      )

      if (odd.length > 0 || extra.length > MORE_SCOPES)
        return yield* new Refused({
          message: `${connection}'s sign-in server doesn't offer ${odd.length > 0 ? odd.map((s) => `"${s.slice(0, 80)}"`).join(", ") : `more than ${MORE_SCOPES} scopes on top`}, so nothing was asked for${offered === undefined ? "" : `: it offers ${offered.slice(0, 20).join(", ")}`}`,
        })

      const { client, redirect } = yield* registrations.clientFor(connection, signIn, origin)
      const { verifier, challenge } = yield* pkce()
      const state = randomToken()

      const scopes = askable([...new Set([...signIn.scopes, ...extra])])

      yield* sql.exec("DELETE FROM connection_signins WHERE expires < ?", Date.now())
      yield* sql.exec(
        `INSERT INTO connection_signins (state, connection, owner, person, verifier, client_id, redirect, scopes, back, expires)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        state,
        connection,
        owner,
        person.id,
        yield* sealer.seal(verifier, verifierKeyOf(state)),
        client.clientId,
        redirect,
        JSON.stringify(scopes),
        back,
        Date.now() + SIGN_IN_MS,
      )
      yield* Effect.logInfo(
        `connection ${connection}: ${person.email} started signing in for ${owner === "workspace" ? "the workspace" : "themselves"}`,
      )

      return {
        url: authorizeUrl({
          server: signIn.server,
          quirks: signIn.quirks,
          clientId: client.clientId,
          redirect,
          scopes,
          resource: signIn.resource,
          state,
          challenge,
          params: { ...signIn.quirks.authorize, ...signIn.params },
        }),
        expires: new Date(Date.now() + SIGN_IN_MS).toISOString(),
      }
    }),

    finish: Effect.fnUntraced(function* (
      person: Person,
      answer: SignInReturn,
      origin: string,
      arrived: string,
    ) {
      const [pending] = yield* rows<{
        connection: string
        owner: string
        person: string
        verifier: string
        client_id: string
        redirect: string
        scopes: string
        back: string
        expires: number
      }>("SELECT * FROM connection_signins WHERE state = ?", answer.state)

      yield* sql.exec("UPDATE connection_signins SET verifier = '' WHERE state = ?", answer.state)

      if (pending === undefined || pending.verifier === "" || pending.expires < Date.now())
        return yield* new Refused({
          message:
            "this sign-in link is unknown, already used or more than 10 minutes old, so nothing changed: start again with Connect on Connections",
        })

      const { connection, owner } = pending

      if (pending.person !== person.id) {
        yield* Effect.logWarning(
          `connection ${connection}: a sign-in ${person.email} didn't start came back to them: refused`,
        )

        return yield* new Refused({
          message: `this sign-in was started by someone else, so it can't connect anything for ${person.email}: start your own with Connect on Connections`,
        })
      }

      // Each registration's sign-ins come back to its own redirect URI (callbackOf): one that came
      // back to another's was sent on to that server's sign-in by this one's (a mix-up, RFC 9700
      // §4.4), and its code is never sent to this one's token endpoint.
      if (arrived !== pending.redirect) {
        yield* Effect.logWarning(
          `connection ${connection}: a sign-in came back to ${arrived}, not ${pending.redirect}, where it was sent: refused (its server may have sent ${person.email} on to another's sign-in)`,
        )

        return yield* new Refused({
          message: `this sign-in to ${connection} came back from another server's sign-in than its own, so nothing was connected and nothing was sent to ${connection}. If you didn't expect to sign in to another service, tell your workspace's admins: ${connection}'s server may not be what it says`,
        })
      }

      if (owner === "workspace" && person.role !== "admin")
        return yield* new Refused({
          message: `only a workspace admin connects ${connection} for the workspace, and ${person.email} isn't one anymore, so nothing was connected`,
        })

      const signIn = yield* store.signInOf(connection)

      if (signIn === undefined)
        return yield* new Refused({
          message: `${connection} doesn't sign in with OAuth anymore (an admin changed it), so nothing was connected`,
        })

      // RFC 9207: the answer came from the server the person was sent to; one that says it always
      // names itself must have.
      if (
        (answer.iss === undefined &&
          signIn.server.authorization_response_iss_parameter_supported === true) ||
        (answer.iss !== undefined && !same(answer.iss, signIn.server.issuer))
      )
        return yield* new Refused({
          message: `the sign-in came back from ${answer.iss?.slice(0, 200) ?? "a server that didn't say which it is"}, not ${signIn.server.issuer}, where it was sent, so nothing was connected: start again`,
        })

      const registered = yield* registrations.clientById(signIn.server.issuer, pending.client_id)

      // The server couldn't use OpenBelt's client metadata document (it couldn't fetch it from this
      // workspace host, or doesn't take it after all): OpenBelt registers itself there instead, when it can.
      if (answer.error === "invalid_client" && registered.client.method === "cimd")
        return yield* registrations.documentRefused(connection, signIn, origin, pending.redirect)

      if (answer.error !== undefined || answer.code === undefined)
        return yield* new Refused({
          message: `${connection} didn't let OpenBelt in (${answer.error?.slice(0, 60) ?? "no code"}${answer.error_description === undefined ? "" : `: ${answer.error_description.slice(0, 200)}`}), so nothing was connected. Connect again to try once more`,
        })

      const verifier = yield* sealer.open(pending.verifier, verifierKeyOf(answer.state))

      if (verifier === undefined)
        return yield* new Refused({ message: "this sign-in can't be finished here: start again" })

      const granted = yield* registrations.grantAdapting(connection, signIn, registered, "code", {
        grant_type: "authorization_code",
        code: answer.code,
        redirect_uri: pending.redirect,
        code_verifier: verifier,
      })

      if (granted.kind === "forgotten") {
        yield* registrations.forgetClient(signIn.server.issuer, pending.client_id)

        return yield* new Refused({
          message: `${connection}'s sign-in server doesn't know OpenBelt's registration (invalid_client), so nothing was connected: connect again, and OpenBelt registers there again`,
        })
      }

      if (granted.kind === "verdict")
        return yield* new Refused({
          message: `${connection} refused the sign-in (${granted.why}), so nothing was connected: connect again`,
        })

      if (granted.kind === "transient")
        return yield* new Refused({
          message: `${connection}'s sign-in server ${granted.status === 0 ? "didn't answer" : `answered ${granted.why}`}, so nothing was connected: connect again in a moment`,
        })

      const now = yield* store.signInOf(connection)

      const [still] = yield* rows<{ role: string; removed: string | null }>(
        "SELECT role, removed FROM people WHERE id = ?",
        person.id,
      )

      const kept =
        now !== undefined &&
        (yield* rows("SELECT state FROM connection_signins WHERE state = ?", answer.state))
          .length === 1 &&
        still !== undefined &&
        still.removed === null &&
        (owner !== "workspace" || still.role === "admin") &&
        normalized(now.server.issuer) === normalized(signIn.server.issuer) &&
        (yield* registrations.storedById(signIn.server.issuer, pending.client_id)) !== undefined &&
        (yield* takes(connection, owner))

      if (!kept) {
        yield* revocations.revokeGranted(
          connection,
          owner,
          signIn.server,
          signIn,
          registered.client,
          granted.tokens,
        )

        return yield* new Refused({
          message: `${connection} was removed or changed while you signed in (it may not take ${owner === "workspace" ? "the workspace's" : "your own"} sign-in anymore), or your place in the workspace did, so nothing was connected: connect again if it's still there`,
        })
      }

      // An old sign-in of theirs is replaced: the server is told the old one is done with, once
      // the new one is kept (unless that would end the new one: the same app at Google).
      const replaced = yield* revocations.revocationOf(
        connection,
        owner,
        [connection],
        pending.client_id,
      )

      ctx.forgetSessions((k) => k === keyOf(connection, owner))
      yield* store.storeTokens(
        connection,
        owner,
        granted.tokens,
        { refresh: undefined, scope: decodeNames(pending.scopes).join(" ") },
        pending.client_id,
        person.email,
        origin,
        "new",
      )

      yield* sql.exec("DELETE FROM connection_signins WHERE state = ?", answer.state)

      if (replaced !== undefined) yield* revocations.revokeNow(replaced)

      const whose = owner === "workspace" ? "the workspace" : person.email

      yield* Effect.logInfo(
        `connection ${connection}: ${person.email} connected it for ${whose}${granted.tokens.refresh_token === undefined ? " (no refresh token: it needs connecting again when it expires)" : ""}`,
      )

      return { connection, owner, back: pending.back, whose }
    }),
  }
}
