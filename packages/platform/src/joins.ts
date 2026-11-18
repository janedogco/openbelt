// Asks to join an invite-only workspace, kept in the workspace's own SQLite: someone at the same work domain as the person who made it asks
// on the base host's workspace picker (base.ts), and the workspace's admins see the ask on People and on the home page until they invite
// them (or someone does). An ask lets nobody in: inviting is still the admins' to do.
import * as Effect from "effect/Effect"
import type { DurableObjectStorage } from "./runtime/index.ts"

export const openJoinAsks = Effect.fn("JoinAsks.open")(function* (
  storage: DurableObjectStorage,
  people: {
    /** Whether `email` is anywhere in the workspace's people already (in, invited or removed): their ask is settled. */
    readonly known: (email: string) => Effect.Effect<boolean>
  },
) {
  const { sql } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS join_asks (
    email TEXT PRIMARY KEY, asked TEXT NOT NULL)`)

  return {
    /** `email` asks to be let in; asking again keeps the first ask's time. */
    ask: Effect.fnUntraced(function* (email: string) {
      yield* sql.exec(
        "INSERT INTO join_asks (email, asked) VALUES (?, ?) ON CONFLICT (email) DO NOTHING",
        email,
        new Date().toISOString(),
      )
    }),

    /** Who asked and isn't in the workspace's people yet, oldest first; an ask someone settled (an invite) is forgotten. */
    pending: Effect.fnUntraced(function* () {
      const asks = yield* (yield* sql.exec<{ email: string }>(
        "SELECT email FROM join_asks ORDER BY asked LIMIT 100",
      )).toArray()

      const open: Array<string> = []

      for (const { email } of asks) {
        if (yield* people.known(email))
          yield* sql.exec("DELETE FROM join_asks WHERE email = ?", email)
        else open.push(email)
      }

      return open
    }),
  }
})
