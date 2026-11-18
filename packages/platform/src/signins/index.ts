import * as Runtime from "../runtime/index.ts"
import type { DurableObjectStorage } from "../runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type Json, newTrace, Refused } from "../model.ts"
import { callbackOf, registrationOf } from "../oauth-client.ts"
import { fetcherFor } from "../oauth-http.ts"
import { normalized } from "../oauth-wire.ts"
import type { Reach } from "../upstream.ts"
import { type Context, connectLink, keyOf, rowsOf, type Sealer } from "./context.ts"
import { openFlow, type Takes } from "./flow.ts"
import { openRefresh } from "./refresh.ts"
import { openRegistrations } from "./registrations.ts"
import { openRevocation } from "./revocation.ts"
import { openStore, scopesOf } from "./store.ts"

export { keyOf } from "./context.ts"

export { SignInReturn } from "./flow.ts"

export { scopesOf, TOKEN } from "./store.ts"

const RefreshJob = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("sweep") }),
  Schema.Struct({ connection: Schema.String, owner: Schema.String }),
])

const decodeRefreshJob = Schema.decodeUnknownOption(RefreshJob)

const SWEEP_AT = "signin-sweep-at"

const SWEEP_LOST_MS = 60_000

export const openSignIns = Effect.fn("SignIns.open")(function* (
  storage: DurableObjectStorage,
  sealer: Sealer,
  reach: Reach,
  forgetSessions: (match: (key: string) => boolean) => void,
  outside: boolean,
  takes: Takes,
) {
  const ctx: Context = {
    storage,
    sql: storage.sql,
    rows: rowsOf(storage.sql),
    sealer,
    http: fetcherFor(reach),
    forgetSessions,
    outside,
    commit: (effect) => storage.transaction(effect),
  }

  const { sql, rows } = ctx

  const refreshJob: Runtime.Callback<Json> = yield* Runtime.makeCallback(
    "signin_refresh",
    (payload: Json): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (Option.isNone(decodeRefreshJob(payload)))
          yield* Effect.logWarning("a signin_refresh job's payload isn't one: sweeping anyway")

        storage.kv.delete(SWEEP_AT)
        yield* refresh.sweep(wake)
      }).pipe(Effect.annotateLogs({ trace: newTrace() })),
  )

  const wake = Effect.fn("SignIns.wake")(function* (at: number) {
    const when = Math.max(at, Date.now())
    const booked = storage.kv.get<number>(SWEEP_AT)

    if (booked !== undefined && booked <= when && booked > Date.now() - SWEEP_LOST_MS) return

    yield* refreshJob.schedule("sweep", { at: when, payload: { kind: "sweep" } }).pipe(Effect.orDie)
    storage.kv.put(SWEEP_AT, when)
  })

  const store = yield* openStore(ctx, wake)
  const registrations = yield* openRegistrations(ctx)
  const revocations = yield* openRevocation(ctx, store, registrations)
  const refresh = openRefresh(ctx, store, registrations, revocations)
  const flow = openFlow(ctx, store, registrations, revocations, takes)

  const hasCredential = Effect.fnUntraced(function* (connection: string, owner: string) {
    return (
      (yield* rows(
        "SELECT 1 FROM connection_credentials WHERE connection = ? AND owner = ? AND broken IS NULL",
        connection,
        owner,
      )).length > 0
    )
  })

  return {
    hasCredential,
    brokenOf: store.brokenOf,
    signInOf: store.signInOf,
    tokenFor: refresh.tokenFor,
    refreshNow: refresh.refreshNow,
    discover: flow.discover,
    discoverApi: flow.discoverApi,
    challenged: flow.challenged,
    start: flow.start,
    finish: flow.finish,
    setClient: registrations.setClient,
    documents: registrations.documents,
    appsAt: registrations.appsAt,

    needsApp: Effect.fnUntraced(function* (connection: string, origin: string) {
      const signIn = yield* store.signInOf(connection)

      return signIn !== undefined && (yield* registrations.needsApp(signIn, origin))
    }),

    kindOf: Effect.fnUntraced(function* (connection: string) {
      return (yield* store.signInOf(connection)) === undefined
        ? ("token" as const)
        : ("oauth" as const)
    }),

    owners: Effect.fnUntraced(function* (connection: string) {
      return (yield* rows<{ owner: string }>(
        "SELECT owner FROM connection_credentials WHERE connection = ? AND broken IS NULL",
        connection,
      )).map((r) => r.owner)
    }),

    setPasted: Effect.fnUntraced(function* (
      connection: string,
      owner: string,
      token: string,
      by: string,
      origin: string,
    ) {
      if ((yield* store.signInOf(connection)) !== undefined) {
        const connect = connectLink(origin, connection, owner, "not_connected")

        return yield* new Refused({
          message: `${connection} signs in with OAuth, so its credentials are set by connecting, not by pasting a token: connect with ${connect.url}`,
          connect,
        })
      }

      return yield* store.setPasted(connection, owner, token, by)
    }),

    clear: Effect.fnUntraced(function* (connection: string, owner: string) {
      const revocation = yield* revocations.revocationOf(connection, owner, [connection])

      forgetSessions((k) => k === keyOf(connection, owner))

      const cleared =
        (yield* (yield* sql.exec(
          "DELETE FROM connection_credentials WHERE connection = ? AND owner = ?",
          connection,
          owner,
        )).rowsWritten) > 0

      if (revocation !== undefined) yield* revocations.revokeNow(revocation)

      return cleared
    }),

    scopesShown: Effect.fnUntraced(function* (connection: string, person: string) {
      const signIn = yield* store.signInOf(connection)

      if (signIn === undefined) return undefined

      const [mine] = yield* rows<{ scope: string | null }>(
        "SELECT scope FROM connection_credentials WHERE connection = ? AND owner = ? AND broken IS NULL",
        connection,
        person,
      )

      const asked = signIn.scopes.filter((s) => s !== "offline_access")
      const granted = mine?.scope === null || mine === undefined ? undefined : scopesOf(mine.scope)

      return granted === undefined
        ? { asked: [...asked], missing: [] }
        : { asked: [...asked], granted, missing: asked.filter((s) => !granted.includes(s)) }
    }),

    shown: Effect.fnUntraced(function* (connection: string, origin: string) {
      const signIn = yield* store.signInOf(connection)

      if (signIn === undefined) return "token"

      const clients = yield* rows<{ redirect: string; method: string }>(
        "SELECT redirect, method FROM signin_clients WHERE issuer = ? ORDER BY redirect",
        normalized(signIn.server.issuer),
      )

      const broken = yield* rows<{
        owner: string
        set_by: string
        broken: string
        broken_kind: string | null
        broken_at: number | null
      }>(
        "SELECT owner, set_by, broken, broken_kind, broken_at FROM connection_credentials WHERE connection = ? AND broken IS NOT NULL",
        connection,
      )

      const once = yield* rows<{ owner: string; set_by: string }>(
        "SELECT owner, set_by FROM connection_credentials WHERE connection = ? AND client IS NOT NULL AND refresh IS NULL AND broken IS NULL",
        connection,
      )

      return {
        oauth: {
          issuer: signIn.server.issuer,
          callback: callbackOf(origin, registrationOf(signIn.server.issuer)),
          provider: signIn.provider ?? null,
          resource: signIn.resource,
          scopes: [...signIn.scopes],
          params: Object.entries({ ...signIn.quirks.authorize, ...signIn.params }).map(
            ([k, v]) => `${k}=${v}`,
          ),
          noRefreshToken: once.map((o) => (o.owner === "workspace" ? "the workspace" : o.set_by)),
          registered: clients.map((c) => `${c.method} for ${c.redirect}`),
          revokes: signIn.server.revocation_endpoint !== undefined,
          reconnect: broken.map((b) => ({
            who: b.owner === "workspace" ? "the workspace" : b.set_by,
            why: b.broken,
            kind: b.broken_kind ?? "revoked",
            at: b.broken_at === null ? null : new Date(b.broken_at).toISOString(),
          })),
        },
      }
    }),

    moved: Effect.fnUntraced(function* (connection: string) {
      yield* ctx.commit(
        Effect.gen(function* () {
          yield* revocations.revokeAfter(yield* flow.signedInOf("connection", connection))
          yield* sql.exec("DELETE FROM connection_credentials WHERE connection = ?", connection)
          yield* sql.exec("DELETE FROM connection_signins WHERE connection = ?", connection)
        }),
      )
    }),

    removed: Effect.fnUntraced(function* (connection: string) {
      yield* revocations.revokeAfter(yield* flow.signedInOf("connection", connection))

      for (const table of ["connection_credentials", "connection_oauth", "connection_signins"]) {
        yield* sql.exec(`DELETE FROM ${table} WHERE connection = ?`, connection)
      }

      yield* registrations.forgetUnusedClients
    }),

    personRemoved: Effect.fnUntraced(function* (person: string) {
      yield* revocations.revokeAfter(yield* flow.signedInOf("owner", person))

      return yield* (yield* sql.exec("DELETE FROM connection_credentials WHERE owner = ?", person))
        .rowsWritten
    }),
  }
})
