import * as Runtime from "../runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type Json, newTrace } from "../model.ts"
import { type Client, randomToken, revoke, type Tokens } from "../oauth-client.ts"
import type { AuthServer } from "../oauth-discovery.ts"
import { type Context, keyOf, refreshKeyOf, whose } from "./context.ts"
import type { Registrations } from "./registrations.ts"
import type { SignIn, Store } from "./store.ts"

const Revocation = Schema.Struct({
  connection: Schema.String,
  owner: Schema.String,
  whose: Schema.String,
  issuer: Schema.String,
  url: Schema.optionalKey(Schema.String),
  endpoint: Schema.String,
  client: Schema.Struct({
    id: Schema.String,
    secret: Schema.NullOr(Schema.String),
    auth: Schema.String,
    method: Schema.String,
  }),
  token: Schema.String,
  hint: Schema.Literals(["refresh_token", "access_token"]),
  tries: Schema.Number,
})

type Revocation = typeof Revocation.Type

const decodeRevocation = Schema.decodeUnknownOption(Revocation)

const REVOKED = {
  revoked: "revoked at the server",
  refused: "deleted (the server didn't take the revocation)",
  unanswered: "deleted (the server didn't answer the revocation)",
} as const

export const openRevocation = Effect.fnUntraced(function* (
  ctx: Context,
  store: Store,
  registrations: Registrations,
) {
  const { rows, sealer, http } = ctx

  const endsAnother = Effect.fnUntraced(function* (
    owner: string,
    client: string,
    leaving: ReadonlyArray<string>,
  ) {
    const staying = yield* rows<{ connection: string }>(
      "SELECT connection FROM connection_credentials WHERE owner = ? AND client = ? AND broken IS NULL",
      owner,
      client,
    )

    return staying.find((s) => !leaving.includes(s.connection))?.connection
  })

  const revocationOf = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    leaving: ReadonlyArray<string>,
    replacedBy?: string,
  ) {
    const [row] = yield* rows<{
      sealed: string
      refresh: string | null
      client: string | null
      set_by: string
    }>(
      "SELECT sealed, refresh, client, set_by FROM connection_credentials WHERE connection = ? AND owner = ?",
      connection,
      owner,
    )

    const signIn = yield* store.signInOf(connection)
    const endpoint = signIn?.server.revocation_endpoint

    if (row?.client === null || row === undefined || signIn === undefined || endpoint === undefined)
      return undefined

    const issuer = signIn.server.issuer

    // A new sign-in with the same app replaces this one (connect again): at a server where one
    // revocation ends every grant to the app (Google), revoking the old token would end the new.
    if (signIn.quirks.revokeEndsAllGrants && replacedBy === row.client) {
      yield* Effect.logInfo(
        `connection ${connection}: the sign-in replaced isn't revoked at the server: ${issuer} would end the new one with it (same app)`,
      )

      return undefined
    }

    const registration = yield* registrations.storedById(issuer, row.client)

    if (registration === undefined) return undefined

    // Another connection of the owner's signs in with the same app and stays (Google: Gmail,
    // Calendar and Drive on one admin's app): revoking this token could end that one too.
    const staying = yield* endsAnother(owner, row.client, [...leaving, connection])

    if (staying !== undefined) {
      yield* Effect.logInfo(
        `connection ${connection}: a sign-in deleted, not revoked at the server: ${staying} signs in with the same app, and revoking could end that one too`,
      )

      return undefined
    }

    const revocation: Revocation = {
      connection,
      owner,
      whose: whose(owner, row.set_by),
      issuer,
      endpoint,
      client: {
        id: registration.client_id,
        secret: registration.secret,
        auth: registration.auth,
        method: registration.method,
      },
      token: row.refresh ?? row.sealed,
      hint: row.refresh === null ? "access_token" : "refresh_token",
      tries: 0,
    }

    return revocation
  })

  const revokeNow = Effect.fnUntraced(function* (revocation: Revocation) {
    const { connection, owner, issuer } = revocation

    const token = yield* sealer.open(
      revocation.token,
      revocation.hint === "refresh_token"
        ? refreshKeyOf(connection, owner)
        : keyOf(connection, owner),
    )

    if (token === undefined) return "refused" as const

    const said = yield* revoke(
      http,
      connection,
      revocation.endpoint,
      yield* registrations.opened(issuer, revocation.client),
      token,
      revocation.hint,
    )

    yield* Effect.logInfo(`connection ${connection}: ${revocation.whose} sign-in ${REVOKED[said]}`)

    return said
  })

  const revokeJob: Runtime.Callback<Json> = yield* Runtime.makeCallback(
    "signin_revoke",
    (payload: Json) =>
      Effect.gen(function* () {
        const revocation = Option.getOrUndefined(decodeRevocation(payload))

        if (revocation === undefined) {
          yield* Effect.logWarning("a signin_revoke job's payload isn't a revocation: dropped")

          return
        }

        const said = yield* revokeNow(revocation)

        if (said === "unanswered" && revocation.tries < 3)
          yield* revokeLater({ ...revocation, tries: revocation.tries + 1 })
      }).pipe(Effect.annotateLogs({ trace: newTrace() })),
  )

  const revokeLater = (revocation: Revocation) =>
    revokeJob
      .schedule(`${revocation.connection}/${revocation.owner}/${randomToken().slice(0, 8)}`, {
        after: revocation.tries === 0 ? 0 : 30_000 * 2 ** revocation.tries,
        payload: revocation,
      })
      .pipe(Effect.orDie)

  const revokeAfter = Effect.fnUntraced(function* (
    credentials: ReadonlyArray<{ readonly connection: string; readonly owner: string }>,
  ) {
    const ended = new Set<string>()

    for (const { connection, owner } of credentials) {
      const revocation = yield* revocationOf(
        connection,
        owner,
        credentials.flatMap((c) => (c.owner === owner ? [c.connection] : [])),
      )

      const app = `${owner}\u0000${revocation?.issuer ?? ""}\u0000${revocation?.client.id ?? ""}`

      if (revocation !== undefined && !ended.has(app)) {
        yield* revokeLater(revocation)

        if ((yield* store.signInOf(connection))?.quirks.revokeEndsAllGrants === true) ended.add(app)
      }
    }
  })

  const revokeGranted = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    server: AuthServer,
    signIn: SignIn | undefined,
    client: Client,
    tokens: Tokens,
  ) {
    if (server.revocation_endpoint === undefined) return

    const staying =
      signIn?.quirks.revokeEndsAllGrants === true
        ? yield* endsAnother(owner, client.clientId, [])
        : undefined

    if (staying !== undefined) {
      yield* Effect.logInfo(
        `connection ${connection}: what a grant brought isn't kept, and isn't revoked: ${staying} signs in with the same app, and revoking would end that one too`,
      )

      return
    }

    yield* revoke(
      http,
      connection,
      server.revocation_endpoint,
      client,
      tokens.refresh_token ?? tokens.access_token,
      tokens.refresh_token === undefined ? "access_token" : "refresh_token",
    )
  })

  return { revocationOf, revokeNow, revokeAfter, revokeGranted }
})

export type Revocations = Effect.Success<ReturnType<typeof openRevocation>>
