// An Effect that waits on something other events must run to finish (another run's latch, a turn of the retries) gives up its
// event's turn while it waits: otherwise the event holds the object, the run it waits for needs the object, and neither moves.
import * as Effect from "effect/Effect"
import { outside, yieldTurn } from "./events.ts"

export const idle = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(yieldTurn),
    () => effect,
    (back) => Effect.promise(async () => await back?.()),
  )

/**
 * Every request the platform sends (a connection's server, a webhook's sender) is a wait outside the object: the event that
 * sends it gives up its turn, so an upstream that takes twenty seconds holds up that one call and not every page of the workspace.
 */
export const yieldOnFetch = () => {
  const real = globalThis.fetch

  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      outside(() => real(input, init)),
    real,
  )
}
