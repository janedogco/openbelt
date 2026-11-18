import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ReconnectKind, Refused } from "../model.ts"
import type { Tokens } from "../oauth-client.ts"
import { type AuthServer, decodeAuthServer } from "../oauth-discovery.ts"
import { quirksOf, type Quirks } from "../providers.ts"
import { type Context, keyOf, refreshKeyOf, whose } from "./context.ts"

export const TOKEN = /^[\x21-\x7e]{1,8192}$/

export const scopesOf = (text: string) => [...new Set(text.split(/[\s,]+/).filter((s) => s !== ""))]

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const decodeParams = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

const DAY_MS = 24 * 60 * 60_000

const keepFor = (lifetimeMs: number | null) => Math.max(DAY_MS, 2 * (lifetimeMs ?? 0))

const refreshAt = (seconds: number) => {
  const lasts = Math.max(0, seconds) * 1000

  return Date.now() + (lasts >= 120_000 ? lasts - 60_000 : lasts / 2)
}

export type BrokenKind = ReconnectKind

const decodeBrokenKind = Schema.decodeUnknownOption(ReconnectKind)

export type Broken = {
  readonly kind: BrokenKind
  readonly why: string
  readonly at: number
}

export type Version = { readonly sealed: string; readonly refresh: string | null }

type Pasted = {
  readonly kind: "pasted"
  readonly access: string
  readonly setBy: string
  readonly version: Version
}

export type SignedIn = {
  readonly kind: "signed_in"
  readonly access: string
  readonly refresh: string | undefined
  readonly client: string
  readonly setBy: string
  readonly expires: number | undefined
  readonly lasts: number | undefined
  /** The scope the server granted, sent back on each refresh (Entra wants it). */
  readonly scope: string | undefined
  readonly retryAt: number | undefined
  readonly failures: number
  readonly used: number | undefined
  readonly origin: string | undefined
  readonly turnedDown: number | undefined
  readonly refreshing: number | undefined
  readonly broken: Broken | undefined
  readonly version: Version
}

type CredentialRow = {
  sealed: string
  set_by: string
  refresh: string | null
  expires: number | null
  client: string | null
  broken: string | null
  broken_kind: string | null
  broken_at: number | null
  lasts: number | null
  scope: string | null
  retry_at: number | null
  failures: number | null
  used: number | null
  origin: string | null
  turned_down: number | null
  refreshing: number | null
}

export type SignIn = {
  readonly resource: string
  readonly scopes: ReadonlyArray<string>
  readonly server: AuthServer
  readonly params: Readonly<Record<string, string>>
  readonly provider: string | undefined
  readonly quirks: Quirks
}

const undef = <T>(value: T | null) => (value === null ? undefined : value)

const AS_READ = "connection = ? AND owner = ? AND sealed = ? AND refresh IS ?"

const asRead = (connection: string, owner: string, version: Version) =>
  [connection, owner, version.sealed, version.refresh] as const

export const openStore = Effect.fnUntraced(function* (
  ctx: Context,
  wake: (at: number) => Effect.Effect<void>,
) {
  const { sql, rows, sealer } = ctx

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_credentials (
    connection TEXT NOT NULL, owner TEXT NOT NULL, sealed TEXT NOT NULL, set_at TEXT NOT NULL,
    set_by TEXT NOT NULL, PRIMARY KEY (connection, owner))`)
  yield* sql.exec(
    "CREATE INDEX IF NOT EXISTS connection_credentials_owner ON connection_credentials (owner)",
  )

  for (const [column, type] of [
    ["refresh", "TEXT"],
    ["expires", "INTEGER"],
    ["client", "TEXT"],
    ["broken", "TEXT"],
    ["broken_kind", "TEXT"],
    ["broken_at", "INTEGER"],
    ["lasts", "INTEGER"],
    ["lifetime", "INTEGER"],
    ["kept", "INTEGER"],
    ["scope", "TEXT"],
    ["retry_at", "INTEGER"],
    ["failures", "INTEGER NOT NULL DEFAULT 0"],
    ["used", "INTEGER"],
    ["origin", "TEXT"],
    ["refreshing", "INTEGER"],
    ["turned_down", "INTEGER"],
  ] as const) {
    const [has] = yield* rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pragma_table_info('connection_credentials') WHERE name = ?",
      column,
    )

    if (has?.n === 0)
      yield* sql.exec(`ALTER TABLE connection_credentials ADD COLUMN ${column} ${type}`)
  }

  yield* sql.exec(
    "CREATE INDEX IF NOT EXISTS connection_credentials_due ON connection_credentials (expires) WHERE refresh IS NOT NULL AND broken IS NULL",
  )

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_oauth (
    connection TEXT PRIMARY KEY, resource TEXT NOT NULL, scopes TEXT NOT NULL, server TEXT NOT NULL,
    discovered TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}')`)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS connection_signins (
    state TEXT PRIMARY KEY, connection TEXT NOT NULL, owner TEXT NOT NULL, person TEXT NOT NULL,
    verifier TEXT NOT NULL, client_id TEXT NOT NULL, redirect TEXT NOT NULL, scopes TEXT NOT NULL,
    back TEXT NOT NULL, expires INTEGER NOT NULL)`)

  const decode = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    row: CredentialRow,
  ) {
    const access = yield* sealer.open(row.sealed, keyOf(connection, owner))

    const refresh =
      row.refresh === null
        ? undefined
        : yield* sealer.open(row.refresh, refreshKeyOf(connection, owner))

    if (access === undefined || (row.refresh !== null && refresh === undefined))
      return yield* new Refused({
        message: `the stored token for ${connection} can't be opened (OPENBELT_SECRETS_KEY changed since it was set): ${row.client === null ? "set" : "connect"} it again`,
      })

    const version: Version = { sealed: row.sealed, refresh: row.refresh }

    if (row.client === null) {
      const pasted: Pasted = { kind: "pasted", access, setBy: row.set_by, version }

      return pasted
    }

    const broken: Broken | undefined =
      row.broken === null
        ? undefined
        : {
            kind: Option.getOrElse(decodeBrokenKind(row.broken_kind), () => "revoked" as const),
            why: row.broken,
            at: row.broken_at ?? 0,
          }

    const signedIn: SignedIn = {
      kind: "signed_in",
      access,
      refresh,
      client: row.client,
      setBy: row.set_by,
      expires: undef(row.expires),
      lasts: undef(row.lasts),
      scope: undef(row.scope),
      retryAt: undef(row.retry_at),
      failures: row.failures ?? 0,
      used: undef(row.used),
      origin: undef(row.origin),
      turnedDown: undef(row.turned_down),
      refreshing: undef(row.refreshing),
      broken,
      version,
    }

    return signedIn
  })

  const loadCredential = Effect.fnUntraced(function* (connection: string, owner: string) {
    const [row] = yield* rows<CredentialRow>(
      `SELECT sealed, set_by, refresh, expires, client, broken, broken_kind, broken_at, lasts, scope,
         retry_at, failures, used, origin, turned_down, refreshing
       FROM connection_credentials WHERE connection = ? AND owner = ?`,
      connection,
      owner,
    )

    return row === undefined ? undefined : yield* decode(connection, owner, row)
  })

  const storeTokens = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    tokens: Tokens,
    kept: { readonly refresh: string | undefined; readonly scope: string | undefined },
    client: string,
    by: string,
    origin: string,
    over: "new" | Version,
  ) {
    const refresh = tokens.refresh_token ?? kept.refresh
    const scope = tokens.scope ?? kept.scope

    if (!TOKEN.test(tokens.access_token) || (refresh !== undefined && !TOKEN.test(refresh)))
      return yield* new Refused({
        message: `${connection} sent a token OpenBelt can't store (over 8 KB, or not one line of printable characters)`,
      })

    const now = Date.now()
    const expires = tokens.expires_in === undefined ? null : refreshAt(tokens.expires_in)
    const lifetime = tokens.expires_in === undefined ? null : tokens.expires_in * 1000
    const lasts = lifetime === null ? null : now + lifetime
    const sealed = yield* sealer.seal(tokens.access_token, keyOf(connection, owner))

    const sealedRefresh =
      refresh === undefined ? null : yield* sealer.seal(refresh, refreshKeyOf(connection, owner))

    const written =
      over === "new"
        ? yield* (yield* sql.exec(
            `INSERT INTO connection_credentials (connection, owner, sealed, set_at, set_by, refresh, expires, client,
               broken, broken_kind, broken_at, lasts, lifetime, kept, scope, retry_at, failures, used, origin,
               refreshing, turned_down)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL)
             ON CONFLICT (connection, owner) DO UPDATE SET sealed = excluded.sealed, set_at = excluded.set_at,
               set_by = excluded.set_by, refresh = excluded.refresh, expires = excluded.expires,
               client = excluded.client, broken = NULL, broken_kind = NULL, broken_at = NULL,
               lasts = excluded.lasts, lifetime = excluded.lifetime, kept = excluded.kept,
               scope = excluded.scope, retry_at = NULL, failures = 0, refreshing = NULL,
               turned_down = NULL, used = excluded.used, origin = excluded.origin`,
            connection,
            owner,
            sealed,
            new Date(now).toISOString(),
            by,
            sealedRefresh,
            expires,
            client,
            lasts,
            lifetime,
            now + keepFor(lifetime),
            scope ?? null,
            now,
            origin,
          )).rowsWritten
        : yield* (yield* sql.exec(
            `UPDATE connection_credentials SET sealed = ?, set_at = ?, refresh = ?, expires = ?, lasts = ?,
               lifetime = ?, scope = ?, retry_at = NULL, failures = 0, refreshing = NULL, origin = ?
             WHERE ${AS_READ} AND client = ? AND broken IS NULL`,
            sealed,
            new Date(now).toISOString(),
            sealedRefresh,
            expires,
            lasts,
            lifetime,
            scope ?? null,
            origin,
            ...asRead(connection, owner, over),
            client,
          )).rowsWritten

    if (written === 0) return undefined

    if (expires !== null && refresh !== undefined) yield* wake(Math.max(expires, now + 5_000))

    yield* Effect.logInfo(
      `connection ${connection}: ${whose(owner, by)} sign-in stored: access lasts ${tokens.expires_in === undefined ? "(no expires_in)" : `${tokens.expires_in}s`}, refresh token ${tokens.refresh_token === undefined ? (kept.refresh === undefined ? "none" : "kept (none sent)") : kept.refresh === undefined ? "new" : tokens.refresh_token === kept.refresh ? "the same (not rotated)" : "rotated"}${tokens.refresh_token_expires_in === undefined ? "" : ` (lasts ${tokens.refresh_token_expires_in}s)`}, scope ${tokens.scope === undefined ? "(not echoed)" : `"${tokens.scope}"`}`,
    )

    const stored: Version = { sealed, refresh: sealedRefresh }

    return { access: tokens.access_token, version: stored }
  })

  const markBroken = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    version: Version,
    broken: { readonly kind: BrokenKind; readonly why: string },
  ) {
    const marked = yield* (yield* sql.exec(
      `UPDATE connection_credentials SET broken = ?, broken_kind = ?, broken_at = ?, refreshing = NULL
       WHERE ${AS_READ} AND client IS NOT NULL`,
      broken.why,
      broken.kind,
      Date.now(),
      ...asRead(connection, owner, version),
    )).rowsWritten

    if (marked === 0) return false

    ctx.forgetSessions((k) => k === keyOf(connection, owner))
    yield* Effect.logWarning(`connection ${connection}: a sign-in stopped working: ${broken.why}`)

    return true
  })

  const backOff = (
    connection: string,
    owner: string,
    version: Version,
    failures: number,
    at: number,
  ) =>
    sql.exec(
      `UPDATE connection_credentials SET failures = ?, retry_at = ?, refreshing = NULL WHERE ${AS_READ}`,
      failures,
      at,
      ...asRead(connection, owner, version),
    )

  const markRefreshing = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    version: Version,
  ) {
    return (
      (yield* (yield* sql.exec(
        `UPDATE connection_credentials SET refreshing = ? WHERE ${AS_READ} AND refresh IS NOT NULL AND broken IS NULL`,
        Date.now(),
        ...asRead(connection, owner, version),
      )).rowsWritten) > 0
    )
  })

  const markTurnedDown = (connection: string, owner: string, version: Version) =>
    sql.exec(
      `UPDATE connection_credentials SET turned_down = ? WHERE ${AS_READ}`,
      Date.now(),
      ...asRead(connection, owner, version),
    )

  const markUsed = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    credential: SignedIn,
  ) {
    const now = Date.now()

    if (credential.used !== undefined && credential.used >= now - 60_000) return

    yield* sql.exec(
      `UPDATE connection_credentials SET used = ?, kept = MAX(COALESCE(kept, 0), ? + MAX(?, 2 * COALESCE(lifetime, 0)))
       WHERE connection = ? AND owner = ?`,
      now,
      now,
      DAY_MS,
      connection,
      owner,
    )
  })

  const setPasted = Effect.fnUntraced(function* (
    connection: string,
    owner: string,
    token: string,
    by: string,
  ) {
    ctx.forgetSessions((k) => k === keyOf(connection, owner))
    yield* sql.exec(
      `INSERT INTO connection_credentials (connection, owner, sealed, set_at, set_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (connection, owner) DO UPDATE SET sealed = excluded.sealed, set_at = excluded.set_at,
         set_by = excluded.set_by, refresh = NULL, expires = NULL, client = NULL, broken = NULL,
         broken_kind = NULL, broken_at = NULL, lasts = NULL, lifetime = NULL, kept = NULL, scope = NULL,
         retry_at = NULL, failures = 0, used = NULL, origin = NULL, refreshing = NULL, turned_down = NULL`,
      connection,
      owner,
      yield* sealer.seal(token, keyOf(connection, owner)),
      new Date().toISOString(),
      by,
    )
  })

  const signInOf = Effect.fnUntraced(function* (connection: string) {
    const [row] = yield* rows<{
      resource: string
      scopes: string
      server: string
      params: string
      provider: string | null
    }>(
      `SELECT o.resource, o.scopes, o.server, o.params, c.provider FROM connection_oauth o
       LEFT JOIN connections c ON c.name = o.connection WHERE o.connection = ?`,
      connection,
    )

    if (row === undefined) return undefined

    const signIn: SignIn = {
      resource: row.resource,
      scopes: decodeNames(row.scopes),
      server: decodeAuthServer(row.server),
      params: decodeParams(row.params),
      provider: undef(row.provider),
      quirks: quirksOf(row.provider),
    }

    return signIn
  })

  const brokenOf = Effect.fnUntraced(function* (connection: string, owner: string) {
    const [row] = yield* rows<{
      broken: string | null
      broken_kind: string | null
      broken_at: number | null
    }>(
      "SELECT broken, broken_kind, broken_at FROM connection_credentials WHERE connection = ? AND owner = ?",
      connection,
      owner,
    )

    if (row?.broken === null || row === undefined) return undefined

    const broken: Broken = {
      kind: Option.getOrElse(decodeBrokenKind(row.broken_kind), () => "revoked" as const),
      why: row.broken,
      at: row.broken_at ?? 0,
    }

    return broken
  })

  return {
    loadCredential,
    storeTokens,
    markBroken,
    backOff,
    markRefreshing,
    markTurnedDown,
    markUsed,
    setPasted,
    signInOf,
    brokenOf,
  }
})

export type Store = Effect.Success<ReturnType<typeof openStore>>
