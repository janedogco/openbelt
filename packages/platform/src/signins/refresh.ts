import * as Deferred from "effect/Deferred"
import { positive } from "../runtime/settings.ts"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { Refused } from "../model.ts"
import * as Runtime from "../runtime/index.ts"
import { type Context, connectLink, keyOf, reconnectRefusal, whose } from "./context.ts"
import type { Registrations } from "./registrations.ts"
import type { Revocations } from "./revocation.ts"
import type { Broken, BrokenKind, SignedIn, Store, Version } from "./store.ts"

const backoff = (failures: number) =>
  Math.min(
    positive("OPENBELT_REFRESH_BACKOFF_SECONDS", 30) * 1000 * 2 ** Math.max(0, failures - 1),
    15 * 60_000,
  )

const inWords = (seconds: number) => {
  const minutes = Math.round(seconds / 60)

  return seconds < 90
    ? `${Math.max(1, seconds)} second${seconds === 1 ? "" : "s"}`
    : `${minutes} minute${minutes === 1 ? "" : "s"}`
}

const FRESH_MS = positive("OPENBELT_REFRESH_HOLD_SECONDS", 60) * 1000

/**
 * A server that turns down the token a refresh just got, and again after the next refresh within
 * this long, takes none it gives (Linear's, once OpenBelt was disconnected on its side): the
 * sign-in stops (reconnect).
 */
const TURNED_DOWN_AGAIN_MS = 30 * 60_000

const BACKGROUND_MS = 5_000

const SWEEP_AT_ONCE = 6

const SWEEP_BUDGET_MS = 20_000

const PAUSE_MS = 60_000

type Why = "expired" | "rejected" | "forced" | "background"

type Fresh = { readonly token: string; readonly version: Version }

type Decision =
  | { readonly kind: "use"; readonly token: string }
  | { readonly kind: "reconnect"; readonly broken: Broken }
  | { readonly kind: "break"; readonly reason: Omit<Broken, "at"> }
  | { readonly kind: "backing_off"; readonly retryAt: number; readonly failures: number }
  | { readonly kind: "turned_down"; readonly at: number }
  | { readonly kind: "grant"; readonly refresh: string }

const decide = (
  credential: SignedIn,
  now: number,
  why: Why,
  stale: string,
  spent: boolean,
): Decision => {
  const forced = why === "forced"

  if (credential.broken !== undefined) return { kind: "reconnect", broken: credential.broken }

  if (
    !forced &&
    credential.access !== stale &&
    (credential.expires === undefined || credential.expires > now)
  )
    return { kind: "use", token: credential.access }

  if (credential.refresh === undefined)
    return {
      kind: "break",
      reason: {
        kind: "expired",
        why: "its access token expired, and the server gave no refresh token",
      },
    }

  // Spent already, and what came back for it was never stored: sending it again would be a
  if (spent)
    return {
      kind: "break",
      reason: {
        kind: "unsaved",
        why: "its refresh token was used and what came back couldn't be saved",
      },
    }

  const live = credential.lasts === undefined || credential.lasts > now + 2_000

  if (!forced && credential.retryAt !== undefined && credential.retryAt > now)
    return live && why !== "rejected"
      ? { kind: "use", token: credential.access }
      : { kind: "backing_off", retryAt: credential.retryAt, failures: credential.failures }

  if (
    why === "rejected" &&
    credential.turnedDown !== undefined &&
    now - credential.turnedDown < FRESH_MS
  )
    return { kind: "turned_down", at: credential.turnedDown }

  return { kind: "grant", refresh: credential.refresh }
}

const verdictKind = (cutShort: boolean, said: string): BrokenKind =>
  cutShort ? "cut_short" : /invalid_rapt/.test(said) ? "rapt" : "revoked"

export const openRefresh = (
  ctx: Context,
  store: Store,
  registrations: Registrations,
  revocations: Revocations,
) => {
  const { rows } = ctx

  const refreshing = new Map<string, Deferred.Deferred<Fresh, Refused>>()

  /**
   * Refresh tokens this WorkspaceDO already sent in a grant the server answered, per credential: never
   * sent again, even if storing what came back failed (a rotating server would end the grant).
   */
  const spent = new Map<string, Set<string>>()

  const attempt = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    stale: string,
    origin: string,
    why: Why,
  ) {
    const slot = keyOf(connection, owner)
    const current = yield* store.loadCredential(connection, owner)

    if (current?.kind !== "signed_in")
      return yield* new Refused({
        message: `the sign-in to ${connection} was removed or replaced by a pasted token meanwhile, so this call has no sign-in to refresh: try it again`,
      })

    const where = current.origin ?? origin
    const used = spent.get(slot) ?? new Set<string>()

    spent.set(slot, used)

    const unchanged = new Refused({
      message: `the sign-in to ${connection} changed meanwhile (connected again, or refreshed by another call): try the call again`,
    })

    const broke = Effect.fnUntraced(function* (reason: Omit<Broken, "at">) {
      if (!(yield* store.markBroken(connection, owner, current.version, reason)))
        return yield* unchanged

      return yield* reconnectRefusal(connection, owner, current.setBy, reason.why, where)
    })

    const later = Effect.fnUntraced(function* (said: string, retryAfter: number | undefined) {
      const failures = current.failures + 1
      const wait = Math.max(backoff(failures), (retryAfter ?? 0) * 1000)

      yield* store.backOff(connection, owner, current.version, failures, Date.now() + wait)
      yield* Effect.logWarning(
        `connection ${connection}: a refresh got ${said}; next try in ${Math.round(wait / 1000)}s`,
      )

      return Math.round(wait / 1000)
    })

    const decided = decide(
      current,
      Date.now(),
      why,
      stale,
      current.refresh !== undefined && used.has(current.refresh),
    )

    if (decided.kind === "use") return { token: decided.token, version: current.version }

    if (decided.kind === "reconnect")
      return yield* reconnectRefusal(connection, owner, current.setBy, decided.broken.why, where)

    if (decided.kind === "break") return yield* broke(decided.reason)

    if (decided.kind === "backing_off")
      return yield* new Refused({
        message: `couldn't refresh the sign-in to ${connection}: ${decided.failures === 0 ? "the last try didn't work" : `its sign-in server didn't take the last ${decided.failures === 1 ? "try" : `${decided.failures} tries`}`}, so OpenBelt tries again in ${inWords(Math.ceil((decided.retryAt - Date.now()) / 1000))}; nothing was lost. Try the call again then`,
      })

    if (decided.kind === "turned_down") {
      const seconds = yield* later(
        "no use: the server turned down a token it gave just now (HTTP 401)",
        undefined,
      )

      return yield* new Refused({
        message: `${connection} turned down the token it gave ${Math.max(1, Math.round((Date.now() - decided.at) / 1000))}s ago (HTTP 401), as it did the one before, so OpenBelt doesn't refresh it again for ${inWords(seconds)}. If it keeps happening, the sign-in may lack what the server wants: ${owner === "workspace" ? "a workspace admin connects it again" : `${current.setBy} connects it again`} with ${connectLink(where, connection, owner, "reconnect").url}`,
      })
    }

    const refresh = decided.refresh
    const signIn = yield* store.signInOf(connection)

    if (signIn === undefined)
      return yield* new Refused({
        message: `${connection} doesn't sign in with OAuth anymore (a workspace admin changed it), so there's no sign-in to refresh`,
      })

    const kept = yield* Effect.result(
      registrations.clientById(signIn.server.issuer, current.client),
    )

    if (Result.isFailure(kept))
      return yield* broke({
        kind: "registration",
        why: "OpenBelt's registration with its sign-in server is gone",
      })

    // A refresh was sent and nothing came of it (OpenBelt restarted mid-grant): with a server that
    const cutShort = current.refreshing !== undefined

    if (cutShort)
      yield* Effect.logWarning(
        `connection ${connection}: a refresh started ${new Date(current.refreshing ?? 0).toISOString()} was cut short (OpenBelt restarted); trying once more${signIn.quirks.refreshRotates === false ? " (its server doesn't rotate refresh tokens)" : ", which a server that rotated it may refuse"}`,
      )

    if (!(yield* store.markRefreshing(connection, owner, current.version))) return yield* unchanged

    yield* Effect.logInfo(
      `connection ${connection}: refreshing ${whose(owner, current.setBy)} sign-in${why === "background" ? " (in the background)" : ""}`,
    )

    // The scope it was granted goes back (Entra wants it).
    const spend = { grant_type: "refresh_token", refresh_token: refresh }

    const answer = yield* registrations.grantAdapting(
      connection,
      signIn,
      kept.success,
      "refresh",
      signIn.quirks.scopeOnRefresh
        ? { ...spend, scope: current.scope ?? signIn.scopes.join(" ") }
        : spend,
      why === "background" ? BACKGROUND_MS : undefined,
    )

    if (answer.kind === "forgotten") {
      used.add(refresh)
      yield* registrations.forgetClient(signIn.server.issuer, current.client)

      return yield* broke({
        kind: "registration",
        why: `${connection}'s sign-in server doesn't know OpenBelt's registration anymore (invalid_client), so connecting again registers it again`,
      })
    }

    if (answer.kind === "verdict") {
      used.add(refresh)

      return yield* broke({
        kind: verdictKind(cutShort, answer.why),
        why: cutShort
          ? `a refresh was cut short when OpenBelt restarted, and ${connection} doesn't take the refresh token anymore (${answer.why})`
          : `${connection} refused to refresh it: ${answer.why}`,
      })
    }

    if (answer.kind === "transient") {
      const seconds = yield* later(
        answer.limited || answer.status === 0 ? answer.why : `no answer (${answer.why})`,
        answer.retryAfter,
      )

      const live = current.lasts === undefined || current.lasts > Date.now() + 2_000

      if (live && (why === "expired" || why === "background"))
        return { token: current.access, version: current.version }

      return yield* new Refused({
        message: `couldn't refresh the sign-in to ${connection}: its sign-in server ${answer.status === 0 ? "didn't answer" : `answered ${answer.why}`}. OpenBelt tries again in ${inWords(seconds)}; nothing was lost`,
      })
    }

    // Spent now, whatever happens next, when the server rotated it (a new one came back). One
    if (answer.tokens.refresh_token !== undefined && answer.tokens.refresh_token !== refresh)
      used.add(refresh)

    ctx.forgetSessions((k) => k === slot)

    const stored = yield* Effect.result(
      store.storeTokens(
        connection,
        owner,
        answer.tokens,
        { refresh, scope: current.scope },
        current.client,
        current.setBy,
        where,
        current.version,
      ),
    )

    if (Result.isFailure(stored))
      return yield* broke({
        kind: "unsaved",
        why: `the refreshed sign-in couldn't be saved (${stored.failure.message}), and the old one is spent`,
      })

    if (stored.success === undefined) {
      yield* revocations.revokeGranted(
        connection,
        owner,
        signIn.server,
        signIn,
        kept.success.client,
        answer.tokens,
      )
      yield* Effect.logInfo(
        `connection ${connection}: a refresh came back after the sign-in was ended or replaced; what it brought isn't kept`,
      )

      return yield* new Refused({
        message: `the sign-in to ${connection} was ended or replaced while it was refreshed, so this call has no token: try it again`,
      })
    }

    used.delete(refresh)

    return { token: stored.success.access, version: stored.success.version }
  })

  const refreshed = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    stale: string,
    origin: string,
    why: Why,
  ) {
    const slot = keyOf(connection, owner)

    const running = refreshing.get(slot)

    // Waiting on another call's grant gives up the turn: that call's own steps need it.
    if (running !== undefined) return yield* Runtime.idle(Deferred.await(running))

    const mine = Deferred.makeUnsafe<Fresh, Refused>()

    refreshing.set(slot, mine)

    // Uninterruptible: a caller going away mid-grant mustn't drop a rotated refresh token the
    const outcome = yield* Effect.exit(
      attempt(connection, owner, stale, origin, why).pipe(
        Effect.ensuring(Effect.sync(() => refreshing.delete(slot))),
        Effect.onExit((exit) => Deferred.done(mine, exit)),
        Effect.uninterruptible,
      ),
    )

    return yield* outcome
  })

  /**
   * The server answered 401 to the token a refresh just got (as `version`): its next 401 isn't
   * refreshed for FRESH_MS. A second time in a row (a refresh in between keeps the first's mark)
   * within TURNED_DOWN_AGAIN_MS: the server refreshes the sign-in but takes nothing it gives, as
   * Linear's does once the person disconnected OpenBelt there. It stops, so it shows under Needs
   * you, instead of a refresh and a 401 every minute.
   */
  const turnedDown = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    version: Version,
  ) {
    const current = yield* Effect.orElseSucceed(
      store.loadCredential(connection, owner),
      () => undefined,
    )

    if (current?.kind !== "signed_in" || current.version.sealed !== version.sealed) return

    if (
      current.turnedDown !== undefined &&
      Date.now() - current.turnedDown < TURNED_DOWN_AGAIN_MS
    ) {
      yield* store.markBroken(connection, owner, version, {
        kind: "rejected_after_refresh",
        why: `${connection} turned down the token it gave right after a refresh twice in a row (HTTP 401): it was most likely disconnected on ${connection}'s side`,
      })

      return
    }

    yield* store.markTurnedDown(connection, owner, version)
    yield* Effect.logWarning(
      `connection ${connection}: it turned down the token a refresh just got (HTTP 401): no refresh for a 401 for ${FRESH_MS / 1000}s`,
    )
  })

  const tokenFor = Effect.fnUntraced(function* (connection: string, owner: string, origin: string) {
    const credential = yield* store.loadCredential(connection, owner)

    if (credential === undefined) return undefined

    if (credential.kind === "pasted") return { kind: "pasted" as const, token: credential.access }

    if (credential.broken !== undefined)
      return yield* reconnectRefusal(
        connection,
        owner,
        credential.setBy,
        credential.broken.why,
        credential.origin ?? origin,
      )

    yield* store.markUsed(connection, owner, credential)

    const first: Fresh =
      credential.expires !== undefined && credential.expires <= Date.now()
        ? yield* refreshed(connection, owner, credential.access, origin, "expired")
        : { token: credential.access, version: credential.version }

    let latest = first.version

    return {
      kind: "signed_in" as const,
      token: first.token,
      renew: refreshed(connection, owner, first.token, origin, "rejected").pipe(
        Effect.map((fresh) => {
          latest = fresh.version

          return fresh.token
        }),
      ),
      turnedDown: Effect.suspend(() => turnedDown(connection, owner, latest)),
    }
  })

  const refreshNow = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    origin: string,
  ) {
    const credential = yield* store.loadCredential(connection, owner)

    if (credential?.kind !== "signed_in") {
      const connect = connectLink(origin, connection, owner, "not_connected")

      return yield* new Refused({
        message: `there's no sign-in to ${connection} ${owner === "workspace" ? "for the workspace" : "of yours"} to refresh: connect it first with ${connect.url}`,
        connect,
      })
    }

    yield* refreshed(connection, owner, credential.access, origin, "forced")

    const after = yield* store.loadCredential(connection, owner)

    return {
      connection,
      refreshed: true,
      refreshAt:
        after?.kind !== "signed_in" || after.expires === undefined
          ? null
          : new Date(after.expires).toISOString(),
    }
  })

  const paused = new Map<string, number>()

  const sweep = Effect.fn("SignIns.sweep")(function* (wake: (at: number) => Effect.Effect<void>) {
    const now = Date.now()
    const deadline = now + SWEEP_BUDGET_MS
    let skipped = false

    const due = yield* rows<{ connection: string; owner: string; issuer: string }>(
      `SELECT c.connection, c.owner, rtrim(json_extract(o.server, '$.issuer'), '/') AS issuer
       FROM connection_credentials c JOIN connection_oauth o ON o.connection = c.connection
       WHERE c.refresh IS NOT NULL AND c.broken IS NULL AND c.expires <= ? AND c.kept >= ?
         AND (c.retry_at IS NULL OR c.retry_at <= ?)
       ORDER BY c.expires LIMIT 500`,
      now,
      now,
      now,
    )

    yield* Effect.forEach(
      due,
      (row) =>
        Effect.gen(function* () {
          if (Date.now() > deadline || (paused.get(row.issuer) ?? 0) > Date.now()) {
            skipped = true

            return
          }

          const credential = yield* Effect.orElseSucceed(
            store.loadCredential(row.connection, row.owner),
            () => undefined,
          )

          if (credential?.kind !== "signed_in") return

          yield* Effect.result(
            refreshed(
              row.connection,
              row.owner,
              credential.access,
              credential.origin ?? "",
              "background",
            ),
          )

          const after = yield* Effect.orElseSucceed(
            store.loadCredential(row.connection, row.owner),
            () => undefined,
          )

          if (
            after?.kind === "signed_in" &&
            after.retryAt !== undefined &&
            after.retryAt > Date.now()
          )
            paused.set(row.issuer, Date.now() + PAUSE_MS)
        }),
      { concurrency: SWEEP_AT_ONCE, discard: true },
    )

    const [next] = yield* rows<{ at: number | null }>(
      `SELECT MIN(MAX(expires, COALESCE(retry_at, 0))) AS at FROM connection_credentials
       WHERE refresh IS NOT NULL AND broken IS NULL AND client IS NOT NULL AND kept >= ?`,
      Date.now(),
    )

    if (due.length > 0)
      yield* Effect.logInfo(
        `the sign-in sweep looked at ${due.length} due${skipped ? ", leaving some for the next sweep (a server paused, or out of time)" : ""}`,
      )

    if (next?.at !== null && next?.at !== undefined)
      yield* wake(Math.max(next.at, Date.now() + (skipped ? 30_000 : 5_000)))
  })

  return { refreshed, tokenFor, refreshNow, sweep }
}
