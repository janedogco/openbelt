// What a Durable Object is given when it starts: who it is, its storage, and the pages connected to it.
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Socket } from "./socket.ts"
import type { DurableObjectStorage } from "./storage.ts"

export type ObjectState = {
  /** The class this object is an instance of. */
  readonly cls: string
  /** The object's name, as `getByName` gave it. */
  readonly id: { readonly toString: () => string }
  readonly storage: DurableObjectStorage
  /** The pages connected now. */
  readonly getWebSockets: () => Effect.Effect<ReadonlyArray<Socket>>
  /** Take a page's socket as this object's: its messages and close come to `webSocketMessage` and `webSocketClose`. */
  readonly acceptWebSocket: (socket: Socket) => Effect.Effect<void>
  /** A page's `request` is answered `response` by the runtime, without waking the object's code. */
  readonly setWebSocketAutoResponse: (request: string, response: string) => Effect.Effect<void>
}

export class DurableObjectState extends Context.Service<DurableObjectState, ObjectState>()(
  "openbelt/DurableObjectState",
) {}
