// The Worker: the one stateless front of the platform. `class Gateway extends Worker("Gateway", impl)`: `impl` runs once at
// start (it reads config and finds the objects), and returns the `fetch` Effect that answers a request.
import type * as Effect from "effect/Effect"
import * as Effectable from "effect/Effectable"
import type { HttpServerRequest } from "effect/http/HttpServerRequest"
import type { HttpServerResponse } from "effect/http/HttpServerResponse"

/** What a worker's `impl` returns. */
export type WorkerEntry = {
  readonly fetch: Effect.Effect<HttpServerResponse, never, HttpServerRequest>
}

export type WorkerClass = {
  new (_: never): object
} & Effect.Effect<WorkerEntry, unknown>

export const Worker = (_name: string, impl: Effect.Effect<WorkerEntry, unknown>): WorkerClass =>
  // SAFETY: a class made an Effect: its constructor never runs (`new (_: never)`).
  Object.assign(
    class {},
    Effectable.Prototype({ label: "openbelt/Worker", evaluate: () => impl }),
    // SAFETY: a class made an Effect: its constructor never runs (`new (_: never)`).
  ) as unknown as WorkerClass
