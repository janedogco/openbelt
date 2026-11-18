import * as Effect from "effect/Effect"
import { Refused } from "../model.ts"
import {
  callbackOf,
  type Client,
  documented,
  grant,
  howToRegister,
  register,
  registrationOf,
} from "../oauth-client.ts"
import { normalized } from "../oauth-wire.ts"
import { type Context, secretKeyOf } from "./context.ts"
import type { SignIn } from "./store.ts"

type ClientRow = {
  redirect: string
  client_id: string
  secret: string | null
  auth: string
  method: string
  no_resource: number
}

type StoredClient = {
  readonly id: string
  readonly secret: string | null
  readonly auth: string
  readonly method: string
}

type Grant = "code" | "refresh"

const appNeeded = (connection: string, issuer: string, redirect: string, origin: string) =>
  new Refused({
    message: `${connection}'s sign-in server (${issuer}) doesn't let OpenBelt register itself, so a workspace admin registers an OAuth app for OpenBelt there once, with the callback URL ${redirect}, then gives OpenBelt its client id and secret on ${connection}'s page: send a workspace admin this link, ${origin}/_connections/${connection}`,
    connect: { url: `${origin}/_connections/${connection}`, why: "admin_setup" },
  })

const storedOf = (row: ClientRow): StoredClient => ({
  id: row.client_id,
  secret: row.secret,
  auth: row.auth,
  method: row.method,
})

export const openRegistrations = Effect.fnUntraced(function* (ctx: Context) {
  const { sql, rows, sealer, http } = ctx

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS signin_clients (
    redirect TEXT PRIMARY KEY, origin TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL,
    secret TEXT, auth TEXT NOT NULL, method TEXT NOT NULL, registered TEXT NOT NULL,
    no_resource INTEGER NOT NULL DEFAULT 0)`)
  yield* sql.exec(
    "CREATE INDEX IF NOT EXISTS signin_clients_issuer ON signin_clients (issuer, client_id)",
  )

  const reachable = (origin: string) => {
    const host = new URL(origin).hostname

    return (
      ctx.outside &&
      origin.startsWith("https://") &&
      host !== "localhost" &&
      !host.endsWith(".localhost")
    )
  }

  const opened = Effect.fnUntraced(function* (issuer: string, stored: StoredClient) {
    const secret =
      stored.secret === null
        ? undefined
        : yield* sealer.open(stored.secret, secretKeyOf(issuer, stored.id))

    const client: Client = {
      clientId: stored.id,
      secret,
      auth:
        stored.auth === "client_secret_basic" || stored.auth === "client_secret_post"
          ? stored.auth
          : "none",
      method: stored.method === "cimd" || stored.method === "registered" ? stored.method : "dcr",
    }

    return client
  })

  const storedById = Effect.fnUntraced(function* (issuer: string, id: string) {
    const [row] = yield* rows<ClientRow>(
      "SELECT redirect, client_id, secret, auth, method, no_resource FROM signin_clients WHERE issuer = ? AND client_id = ?",
      normalized(issuer),
      id,
    )

    return row
  })

  const clientById = Effect.fnUntraced(function* (issuer: string, id: string) {
    const row = yield* storedById(issuer, id)

    if (row === undefined)
      return yield* new Refused({
        message: `OpenBelt's registration with the sign-in server ${issuer} is gone (the connection was changed, or the server forgot it): connect it again`,
      })

    return {
      client: yield* opened(issuer, storedOf(row)),
      redirect: row.redirect,
      noResource: row.no_resource === 1,
    }
  })

  const forgetClient = Effect.fnUntraced(function* (issuer: string, id: string) {
    const forgot = yield* (yield* sql.exec(
      "DELETE FROM signin_clients WHERE issuer = ? AND client_id = ? AND method != 'registered'",
      normalized(issuer),
      id,
    )).rowsWritten

    if (forgot > 0)
      yield* Effect.logWarning(
        `${issuer} doesn't know OpenBelt's registration ${id} anymore (invalid_client), so the next Connect registers again`,
      )
  })

  const keepClient = Effect.fnUntraced(function* (
    issuer: string,
    origin: string,
    redirect: string,
    made: Client,
    keep: "first" | "replace",
  ) {
    yield* sql.exec(
      `INSERT OR ${keep === "first" ? "IGNORE" : "REPLACE"} INTO signin_clients (redirect, origin, issuer, client_id, secret, auth, method, registered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      redirect,
      origin,
      normalized(issuer),
      made.clientId,
      made.secret === undefined
        ? null
        : yield* sealer.seal(made.secret, secretKeyOf(issuer, made.clientId)),
      made.auth,
      made.method,
      new Date().toISOString(),
    )
    yield* Effect.logInfo(`registered with ${issuer} (${made.method}) for ${redirect}`)
  })

  const forgetUnusedClients = sql.exec(
    `DELETE FROM signin_clients WHERE issuer NOT IN
       (SELECT rtrim(json_extract(server, '$.issuer'), '/') FROM connection_oauth)`,
  )

  const clientFor = Effect.fnUntraced(function* (
    connection: string,
    signIn: SignIn,
    origin: string,
  ) {
    const issuer = signIn.server.issuer
    const registration = registrationOf(issuer)
    const redirect = callbackOf(origin, registration)

    const known = () =>
      rows<ClientRow>(
        `SELECT redirect, client_id, secret, auth, method, no_resource FROM signin_clients WHERE issuer = ? AND origin = ?
         ORDER BY method = 'registered' DESC, registered LIMIT 1`,
        normalized(issuer),
        origin,
      )

    const [had] = yield* known()

    if (had !== undefined)
      return { client: yield* opened(issuer, storedOf(had)), redirect: had.redirect }

    const [elsewhere] = yield* rows<{ redirect: string }>(
      "SELECT redirect FROM signin_clients WHERE issuer = ? AND method = 'registered' LIMIT 1",
      normalized(issuer),
    )

    if (elsewhere !== undefined) {
      const there = `${new URL(elsewhere.redirect).origin}/_connections/${connection}`

      return yield* new Refused({
        message: `OpenBelt's app at ${issuer} calls back to ${elsewhere.redirect}, so connect from ${there} (or a workspace admin adds ${redirect} to the app's callback URLs and gives it to OpenBelt on ${origin}/_connections/${connection} too)`,
        connect: { url: there, why: "admin_setup" },
      })
    }

    const how = howToRegister(signIn.server, reachable(origin))
    const endpoint = signIn.server.registration_endpoint

    const made =
      how === "cimd"
        ? documented(origin, registration)
        : endpoint === undefined
          ? undefined
          : yield* register(http, connection, origin, registration, signIn.server, endpoint)

    if (made === undefined) return yield* appNeeded(connection, issuer, redirect, origin)

    yield* keepClient(issuer, origin, redirect, made, "first")

    const [kept] = yield* known()

    return {
      client: kept === undefined ? made : yield* opened(issuer, storedOf(kept)),
      redirect: kept?.redirect ?? redirect,
    }
  })

  const documentRefused = Effect.fnUntraced(function* (
    connection: string,
    signIn: SignIn,
    origin: string,
    redirect: string,
  ) {
    const issuer = signIn.server.issuer
    const endpoint = signIn.server.registration_endpoint

    yield* Effect.logWarning(
      `${issuer} answered invalid_client to OpenBelt's client metadata document for ${origin}`,
    )

    if (endpoint === undefined) return yield* appNeeded(connection, issuer, redirect, origin)

    const made = yield* register(
      http,
      connection,
      origin,
      registrationOf(issuer),
      signIn.server,
      endpoint,
    )

    yield* keepClient(issuer, origin, redirect, made, "replace")

    return yield* new Refused({
      message: `${connection}'s sign-in server couldn't use OpenBelt's client metadata document (it may not reach ${origin}), so OpenBelt registered itself there instead and nothing was connected yet: connect again`,
    })
  })

  /**
   * A token grant with `client` (`noResource`: its token endpoint refused RFC 8707's resource
   * before) for `signIn`. A server that refuses the resource (invalid_target; for a refresh,
   * invalid_request too: neither spends the code or the token) gets it once more without, and is
   * remembered for that (refusesResource), so the next grant is one request, not two (Entra).
   */
  const grantAdapting = Effect.fnUntraced(function* (
    connection: string,
    signIn: SignIn,
    registered: { readonly client: Client; readonly noResource: boolean },
    kind: Grant,
    fields: Readonly<Record<string, string>>,
    timeoutMs?: number,
  ) {
    const { client } = registered
    const resource = signIn.quirks.sendResource && !registered.noResource

    const first = yield* grant(
      http,
      connection,
      signIn.server,
      client,
      resource ? { ...fields, resource: signIn.resource } : fields,
      timeoutMs,
    )

    const without =
      resource &&
      first.kind === "verdict" &&
      (first.error === "invalid_target" ||
        (kind === "refresh" && first.error === "invalid_request"))

    if (!without) return first

    const answer = yield* grant(http, connection, signIn.server, client, fields, timeoutMs)

    if (answer.kind === "tokens") {
      yield* sql.exec(
        "UPDATE signin_clients SET no_resource = 1 WHERE issuer = ? AND client_id = ?",
        normalized(signIn.server.issuer),
        client.clientId,
      )
      yield* Effect.logInfo(
        `${signIn.server.issuer} refuses the resource parameter: OpenBelt's requests there go without it from now on`,
      )
    }

    return answer
  })

  const setClient = Effect.fnUntraced(function* (
    signIn: SignIn,
    origin: string,
    clientId: string,
    secret: string | undefined,
  ) {
    const issuer = signIn.server.issuer
    const redirect = callbackOf(origin, registrationOf(issuer))

    yield* sql.exec(
      "DELETE FROM signin_clients WHERE issuer = ? AND origin = ?",
      normalized(issuer),
      origin,
    )
    yield* keepClient(
      issuer,
      origin,
      redirect,
      {
        clientId,
        secret,
        auth: secret === undefined ? "none" : (signIn.quirks.clientAuth ?? "client_secret_post"),
        method: "registered",
      },
      "replace",
    )

    return redirect
  })

  const documents = Effect.fnUntraced(function* (origin: string, registration: string) {
    return (
      (yield* rows(
        "SELECT 1 FROM signin_clients WHERE origin = ? AND redirect = ? AND method = 'cimd'",
        origin,
        callbackOf(origin, registration),
      )).length > 0
    )
  })

  const needsApp = Effect.fnUntraced(function* (signIn: SignIn, origin: string) {
    const [had] = yield* rows(
      "SELECT 1 FROM signin_clients WHERE issuer = ? AND origin = ?",
      normalized(signIn.server.issuer),
      origin,
    )

    return had === undefined && howToRegister(signIn.server, reachable(origin)) === "admin"
  })

  const appsAt = Effect.fnUntraced(function* () {
    return (yield* rows<{ issuer: string }>(
      "SELECT DISTINCT issuer FROM signin_clients WHERE method = 'registered' ORDER BY issuer",
    )).map((r) => r.issuer)
  })

  return {
    needsApp,
    appsAt,
    storedById,
    opened,
    clientById,
    forgetClient,
    forgetUnusedClients,
    clientFor,
    documentRefused,
    grantAdapting,
    setClient,
    documents,
  }
})

export type Registrations = Effect.Success<ReturnType<typeof openRegistrations>>
