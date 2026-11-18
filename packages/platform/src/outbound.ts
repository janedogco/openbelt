// OpenBelt's own requests to the outside: a workspace's MCP servers, sign-in servers, API connections and the documents they point at,
// the email it sends (mail.ts) and the CDN purges (cdn.ts).
// One way to send them, through Effect's HttpClient: each is a span (`<METHOD> <host>`, openbelt.outbound saying what for, and the
// status), a caller that is interrupted (a timeout, a client gone) cancels it, and none follows a redirect, outlasts its time or
// reads past its size. Not a function's own fetch: capabilities.ts sends that byte for byte, and reads the raw answer.
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpMethod,
} from "effect/http"
import type { HttpClientResponse } from "effect/http"
import * as Stream from "effect/Stream"
import { recordOutbound } from "./runtime/metrics.ts"

/** What a request was for: its span's openbelt.outbound, and the outbound metrics' `kind`. */
export type Kind = "mcp" | "oauth" | "api" | "client-document" | "mail" | "cdn" | "push"

/** It didn't answer within its time, or couldn't be reached at all (no connection, a reset, a TLS failure). */
class OutboundFailed extends Data.TaggedError("OutboundFailed")<{
  readonly reason: "timeout" | "unreachable"
  readonly detail: string
}> {}

/** What is sent: a method, headers, and a body when it has one (always text: JSON, a form, a GraphQL query). */
export type Sending = {
  readonly method?: string
  readonly headers?: ConstructorParameters<typeof Headers>[0]
  readonly body?: string
}

export type Request = Sending & {
  readonly kind: Kind
  readonly url: string
  readonly timeoutMs: number
  /** A body of bytes instead of text (an encrypted push, push.ts). */
  readonly bytes?: Uint8Array
}

/** The answer's status and headers, with its body as a stream to read (once) the way the caller needs. */
export type Answer = {
  readonly status: number
  readonly headers: Headers
  readonly stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>
}

/** The body as text, or undefined when it is over `most` bytes (what is past it is not read). */
export const textUpTo = Effect.fnUntraced(function* (answer: Answer, most: number) {
  if (Number(answer.headers.get("content-length") ?? "0") > most) return undefined

  const chunks: Array<Uint8Array> = []
  let size = 0

  yield* Stream.runForEachWhile(answer.stream, (chunk) =>
    Effect.sync(() => {
      size += chunk.byteLength

      if (size > most) return false

      chunks.push(chunk)

      return true
    }),
  )

  return size > most ? undefined : new TextDecoder().decode(Buffer.concat(chunks))
})

/** The first chunk of the body, as text (at most 2 KB): what a refusal says, without reading the rest. */
export const firstWords = Effect.fnUntraced(function* (answer: Answer) {
  let first: Uint8Array | undefined

  yield* Stream.runForEachWhile(answer.stream, (chunk) =>
    Effect.sync(() => {
      first = chunk

      return false
    }),
  )

  return first === undefined ? "" : new TextDecoder().decode(first.slice(0, 2048))
})

const statusClass = (status: number) => `${Math.floor(status / 100)}xx`

const requestOf = (request: Request) => {
  const headers = new Headers(request.headers)
  const method = (request.method ?? "GET").toUpperCase()

  const base = HttpClientRequest.make(HttpMethod.isHttpMethod(method) ? method : "GET")(
    request.url,
    { headers: Object.fromEntries(headers.entries()) },
  )

  if (request.bytes !== undefined)
    return HttpClientRequest.bodyUint8Array(
      base,
      request.bytes,
      headers.get("content-type") ?? "application/octet-stream",
    )

  return request.body === undefined
    ? base
    : HttpClientRequest.bodyText(
        base,
        request.body,
        headers.get("content-type") ?? "text/plain;charset=UTF-8",
      )
}

/**
 * Send `request`, and `read` its answer within the same time limit (the body is the answer's too). The span is OpenBelt's own (the
 * HttpClient's records the request's headers, a token among them); no trace context is sent, so what reaches the server is what
 * OpenBelt sent before.
 */
export const exchange = <A, E>(request: Request, read: (answer: Answer) => Effect.Effect<A, E>) => {
  const url = new URL(request.url)
  const method = (request.method ?? "GET").toUpperCase()

  return Effect.suspend(() => {
    // One count per exchange, once its answer is read or it failed: its status class, or why it has none.
    const started = Date.now()
    let answered: string | undefined

    const record = (outcome: string) => recordOutbound(request.kind, outcome, Date.now() - started)

    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      const response: HttpClientResponse.HttpClientResponse = yield* client.execute(
        requestOf(request),
      )

      answered = statusClass(response.status)

      yield* Effect.annotateCurrentSpan({ "openbelt.status": String(response.status) })

      return yield* read({
        status: response.status,
        headers: new Headers(Object.entries(response.headers)),
        stream: response.stream,
      })
    }).pipe(
      Effect.timeoutOrElse({
        duration: request.timeoutMs,
        orElse: () =>
          Effect.fail(
            new OutboundFailed({
              reason: "timeout",
              detail: `no answer within ${request.timeoutMs / 1000}s`,
            }),
          ),
      }),
      Effect.catchIf(HttpClientError.isHttpClientError, (error) =>
        Effect.fail(new OutboundFailed({ reason: "unreachable", detail: error.message })),
      ),
      Effect.tap(() => record(answered ?? "unreachable")),
      Effect.tapError((error) =>
        record(error instanceof OutboundFailed ? error.reason : (answered ?? "unreachable")),
      ),
    )
  }).pipe(
    Effect.withSpan(`${method} ${url.host}`, {
      kind: "client",
      attributes: { "openbelt.outbound": request.kind, "openbelt.host": url.host },
    }),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provide(FetchHttpClient.layer),
  )
}
