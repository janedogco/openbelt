// A page's WebSocket as a Durable Object holds it: the server end of a pair, with an attachment (what the object knows about this
// socket: who opened it, what it watches). The other end is the browser's, which the gateway bridges to it (serve.ts).
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Headers from "effect/http/Headers"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Schema from "effect/Schema"
import { DurableObjectState } from "./state.ts"

/** An attachment could not be encoded, decoded, or isn't there. */
class SocketAttachmentError extends Data.TaggedError("SocketAttachmentError")<{
  readonly reason: "encode" | "decode" | "missing"
  readonly message: string
  readonly cause?: unknown
}> {}

/** What the actor's raw socket does for a Socket: send to the page, close it. */
export type Wire = {
  readonly send: (data: string | ArrayBuffer) => void
  readonly close: (code: number, reason: string) => void
}

export type Socket = {
  readonly id: string
  /** The page went away, or this end closed. */
  readonly closed: () => boolean
  /** The page's end is connected: what was sent before it was goes out now. */
  readonly connect: (wire: Wire) => void
  /** The page's end went away. */
  readonly disconnected: () => void
  readonly send: (data: string | ArrayBuffer) => Effect.Effect<void>
  readonly close: (code: number, reason: string) => Effect.Effect<void>
  readonly setAttachment: <S extends Schema.Constraint>(
    schema: S,
    value: NoInfer<S["Type"]>,
  ) => Effect.Effect<void, SocketAttachmentError, S["EncodingServices"]>
  readonly getAttachment: <S extends Schema.Constraint>(
    schema: S,
  ) => Effect.Effect<S["Type"], SocketAttachmentError, S["DecodingServices"]>
}

/** Sockets by id until the page's end connects: `upgrade()` makes one, the gateway's bridge finds it by the id the response carries. */
const waiting = new Map<string, Socket>()

/** The socket a response named, taken: it is handed to the bridge once. */
export const claimSocket = (id: string): Socket | undefined => {
  const found = waiting.get(id)

  waiting.delete(id)

  return found
}

/** The most text one batch frame carries; a replay of more goes out as several. */
const BATCH_BYTES = 256 * 1024

/**
 * Messages as frames. A reconnect that replays 1,200 missed changes sent 1,200 frames, and a socket between that dropped frames once
 * it was full (as Rivet's did) lost most of them and the hello after. A page that says it reads batches (`?batch=1`) gets the
 * messages sent in one go as one frame, `{"type":"batch","messages":[...]}`, 256 KB at most; one that doesn't (an SDK from before)
 * gets a frame each.
 */
const framesOf = (texts: ReadonlyArray<string>): Array<string> => {
  if (texts.length === 1) return [...texts]

  const frames: Array<string> = []
  let part: Array<string> = []
  let size = 0

  for (const text of texts) {
    if (part.length > 0 && size + text.length > BATCH_BYTES) {
      frames.push(`{"type":"batch","messages":[${part.join(",")}]}`)
      part = []
      size = 0
    }

    part.push(text)
    size += text.length + 1
  }

  if (part.length > 0)
    frames.push(
      part.length === 1 ? (part[0] ?? "") : `{"type":"batch","messages":[${part.join(",")}]}`,
    )

  return frames
}

const makeSocket = (batching: boolean): Socket => {
  const id = crypto.randomUUID()
  /** The attachment, as encoded by its schema. */
  let attachment: unknown = undefined
  let wire: Wire | undefined = undefined
  /** What was sent and hasn't gone out yet, in order: before the page's end connected (the hello, a replay), or this turn's. */
  const queued: Array<string | ArrayBuffer> = []
  let flushing = false
  let closed = false

  /** Everything queued goes out now, the text in batches when the page reads them. */
  const flush = () => {
    flushing = false

    if (wire === undefined) return

    const out = queued.splice(0)
    let texts: Array<string> = []

    const sendTexts = () => {
      for (const frame of batching ? framesOf(texts) : texts) wire?.send(frame)
      texts = []
    }

    for (const data of out) {
      if (typeof data === "string") texts.push(data)
      else {
        sendTexts()
        wire.send(data)
      }
    }

    sendTexts()
  }

  const socket: Socket = {
    id,
    closed: () => closed,
    connect: (to) => {
      wire = to
      flush()
    },
    disconnected: () => {
      closed = true
      wire = undefined
    },
    send: (data) =>
      Effect.sync(() => {
        if (closed) return

        queued.push(data)

        if (wire === undefined) return

        if (!batching) {
          flush()

          return
        }

        // What this turn sends goes out together, once it yields.
        if (!flushing) {
          flushing = true
          queueMicrotask(flush)
        }
      }),
    close: (code, reason) =>
      Effect.sync(() => {
        if (closed) return

        flush()
        closed = true
        wire?.close(code, reason)
      }),
    setAttachment: (schema, value) =>
      Schema.encodeEffect(schema)(value).pipe(
        Effect.mapError(
          (cause) =>
            new SocketAttachmentError({
              reason: "encode",
              message: "Could not encode the socket's attachment",
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          Effect.sync(() => {
            attachment = encoded
          }),
        ),
      ),
    getAttachment: (schema) =>
      attachment === undefined
        ? Effect.fail(
            new SocketAttachmentError({
              reason: "missing",
              message: "The socket has no attachment",
            }),
          )
        : Schema.decodeUnknownEffect(schema)(attachment).pipe(
            Effect.mapError(
              (cause) =>
                new SocketAttachmentError({
                  reason: "decode",
                  message: "Could not decode the socket's attachment",
                  cause,
                }),
            ),
          ),
  }

  waiting.set(id, socket)

  return socket
}

/** The headers a 101 response carries so the gateway can bridge the page to this socket (serve.ts). */
export const UPGRADE = {
  id: "x-openbelt-socket",
  cls: "x-openbelt-object-class",
  name: "x-openbelt-object-name",
}

/**
 * Accept a page's WebSocket: the response to return from `fetch` (a 101 naming the socket, which the gateway upgrades the page's
 * connection for), and the socket to send to.
 */
export const upgrade = Effect.fn("Runtime.upgrade")(function* (
  options: { readonly batching: boolean } = { batching: false },
) {
  const state = yield* DurableObjectState
  const socket = makeSocket(options.batching)

  yield* state.acceptWebSocket(socket)

  return [
    HttpServerResponse.empty({
      status: 101,
      headers: Headers.fromInput({
        [UPGRADE.id]: socket.id,
        [UPGRADE.cls]: state.cls,
        [UPGRADE.name]: encodeURIComponent(state.id.toString()),
      }),
    }),
    socket,
  ] as const
})
