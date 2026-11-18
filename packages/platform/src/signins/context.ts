import type { SqlValue } from "../runtime/index.ts"
import type { DurableObjectStorage } from "../runtime/index.ts"
import * as Effect from "effect/Effect"
import { type ConnectLink, Refused } from "../model.ts"
import { type Fetcher, normalized } from "../oauth-wire.ts"
import type { sealing } from "../upstream.ts"

export type Sealer = Effect.Success<ReturnType<typeof sealing>>

export const rowsOf =
  (sql: DurableObjectStorage["sql"]) =>
  <T extends Record<string, SqlValue>>(query: string, ...bindings: Array<string | number | null>) =>
    Effect.flatMap(sql.exec<T>(query, ...bindings), (cursor) => cursor.toArray())

export type Context = {
  readonly storage: DurableObjectStorage
  readonly sql: DurableObjectStorage["sql"]
  readonly rows: ReturnType<typeof rowsOf>
  readonly sealer: Sealer
  readonly http: Fetcher
  readonly forgetSessions: (match: (key: string) => boolean) => void
  readonly outside: boolean
  readonly commit: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
}

export const keyOf = (connection: string, owner: string) => `${connection}\u0000${owner}`

export const refreshKeyOf = (connection: string, owner: string) =>
  `${keyOf(connection, owner)}\u0000refresh`

export const secretKeyOf = (issuer: string, clientId: string) =>
  `client\u0000${normalized(issuer)}\u0000${clientId}`

export const verifierKeyOf = (state: string) => `signin\u0000${state}`

export const whose = (owner: string, setBy: string) =>
  owner === "workspace" ? "the workspace's" : `${setBy}'s`

export const connectUrl = (
  origin: string,
  connection: string,
  owner: "workspace" | "mine",
  scope?: string,
) => {
  const query = new URLSearchParams()

  if (owner === "workspace") query.set("for", "workspace")

  if (scope !== undefined) query.set("scope", scope)

  return `${origin}/_connections/${connection}/connect${query.size === 0 ? "" : `?${query.toString()}`}`
}

export const connectLink = (
  origin: string,
  connection: string,
  owner: string,
  why: ConnectLink["why"],
  scope?: string,
): ConnectLink => ({
  url: connectUrl(origin, connection, owner === "workspace" ? "workspace" : "mine", scope),
  why,
})

const sendLink = (owner: string, setBy: string, url: string) =>
  owner === "workspace"
    ? `a workspace admin connects it again for the workspace: send one this link, ${url}`
    : `${setBy} connects it again: send them this link, ${url}`

export const reconnectRefusal = (
  connection: string,
  owner: string,
  setBy: string,
  why: string,
  origin: string,
) => {
  const connect = connectLink(origin, connection, owner, "reconnect")

  return new Refused({
    message: `${whose(owner, setBy)} sign-in to ${connection} stopped working (${why}): ${sendLink(owner, setBy, connect.url)}`,
    connect,
  })
}
