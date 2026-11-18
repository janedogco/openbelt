// The HTTP front: a Bun server that answers each request with the worker's `fetch`, and bridges a page's WebSocket (a 101 from an
// object, naming its socket) to the actor that holds it.
import { admitted, refusal } from "./admission.ts"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import type { Host, LocalPeer } from "./actor.ts"
import { internalHeaders } from "./internal-key.ts"
import { recordOpen, recordRequest } from "./metrics.ts"
import { linkTrace, observed, say, serverTiming } from "./observe.ts"
import { UPGRADE } from "./socket.ts"
import type { WorkerEntry } from "./worker.ts"

type Bridge = {
  readonly cls: string
  readonly name: string
  readonly id: string
}

/** The actor's end of a page's socket, as the bridge uses it. */
type Upstream = {
  readonly readyState: number
  readonly send: (data: string | ArrayBuffer) => void
  readonly close: (code: number, reason: string) => void
}

type Page = {
  bridge: Bridge
  /** What the page sent before its actor end was open. */
  queued: Array<string | Buffer>
  upstream: Upstream | undefined
  /** The object's end in this process, when it is here (no engine between). */
  local?: LocalPeer
}

export type ServeOptions = {
  readonly port: number
  readonly hostname?: string
  readonly host: Host
  readonly worker: WorkerEntry
}

const closeCode = (code: number | undefined) =>
  code !== undefined && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000

/** A request slower than this is logged whatever its answer. */
const SLOW_REQUEST_MS = 1000

/** A request's path as logs and spans show it: a token webhook's token (/_hook/<function>/<token>) is left out. */
const shownPath = (path: string) => path.replace(/(\/_hook\/[^/]+)\/.+$/, "$1/<token>")

/**
 * Text a page or an agent reads, worth compressing, in a body held whole (MCP's answers are JSON, held whole too). Events
 * (text/event-stream) are left as they are: a client reads each as it comes.
 */
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|xml)|image\/svg\+xml)/

/** Below this, gzip's header costs about what it saves. */
const COMPRESS_FROM_BYTES = 1024

/** The headers a 304 keeps: what says which version it is and how long it may be kept. */
const NOT_MODIFIED_KEEPS = [
  "etag",
  "cache-control",
  "vary",
  "x-openbelt-trace",
  "x-openbelt-version",
]

const sameTag = (a: string, b: string) =>
  a.trim().replace(/^W\//, "") === b.trim().replace(/^W\//, "")

/** Answers that say which version they are (a strong ETag: an app's files, /sdk.js) gzipped once, not on every request. */
const zipped = new Map<string, Uint8Array>()

/** gzip at level 4: about as small as the default 6 for pages this size, for less of the main thread (2% of it at 6). */
const zip = (etag: string | undefined, bytes: Uint8Array): Uint8Array => {
  const key = etag === undefined || etag.startsWith("W/") ? undefined : `${etag}:${bytes.length}`

  const known = key === undefined ? undefined : zipped.get(key)

  if (known !== undefined) return known

  const made = Bun.gzipSync(new Uint8Array(bytes), { level: 4 })

  if (key !== undefined) {
    if (zipped.size >= 1000) zipped.clear()

    zipped.set(key, made)
  }

  return made
}

/**
 * A GET answered 200 with an ETag the browser already has becomes a 304 with no body; otherwise a buffered text answer of 1 KB
 * or more, to any method, goes out gzipped to a client that accepts it (the home page 72 KB as 16, /sdk.js 23 as 7, MCP's
 * tools/list, a POST, 136 as 27). Its ETag turns weak (the bytes differ from the plain answer's), and `Vary: Accept-Encoding`
 * keeps caches from mixing the two. Only a 200: a part of a file (206) is the plain file's bytes, which its Content-Range counts.
 */
const negotiated = (request: Request, response: HttpServerResponse.HttpServerResponse) => {
  if (response.status !== 200) return response

  const etag = response.headers["etag"]
  const asked = request.headers.get("if-none-match")
  const reading = request.method === "GET" || request.method === "HEAD"

  if (
    reading &&
    etag !== undefined &&
    asked !== null &&
    asked.split(",").some((tag) => sameTag(tag, etag))
  ) {
    const kept = Object.fromEntries(
      NOT_MODIFIED_KEEPS.flatMap((name) => {
        const value = response.headers[name]

        return value === undefined ? [] : [[name, value]]
      }),
    )

    return HttpServerResponse.empty({ status: 304, headers: kept })
  }

  const body = response.body

  const compress =
    body instanceof HttpBody.Uint8Array &&
    body.body.length >= COMPRESS_FROM_BYTES &&
    COMPRESSIBLE.test(body.contentType) &&
    response.headers["content-encoding"] === undefined &&
    /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")

  if (!compress) return response

  const vary = response.headers["vary"]

  const gzipped = HttpServerResponse.setBody(
    response,
    HttpBody.uint8Array(zip(etag, body.body), body.contentType),
  ).pipe(
    HttpServerResponse.setHeaders({
      "content-encoding": "gzip",
      vary: vary === undefined ? "Accept-Encoding" : `${vary}, Accept-Encoding`,
    }),
  )

  return etag === undefined || etag.startsWith("W/")
    ? gzipped
    : HttpServerResponse.setHeader(gzipped, "etag", `W/${etag}`)
}

/**
 * One line for each request, with the trace id the answer carries (`bun run drive trace <id>`, or `app_logs` for the app's own
 * lines): at warn for a status of 400 or more (the platform's refusals included, which are most of what a person asks "why"
 * about) or a request slower than a second; at debug for the rest, which a busy instance writes a hundred a second of.
 */
const noteRequest = (request: Request, response: Response, ms: number) => {
  recordRequest(response.status, ms)

  const url = new URL(request.url)
  const path = shownPath(url.pathname)
  const trace = response.headers.get("x-openbelt-trace") ?? undefined

  say(
    response.status >= 400 || ms >= SLOW_REQUEST_MS ? "warn" : "debug",
    `request: ${request.method} ${url.host}${path} answered ${response.status} in ${Math.round(ms)} ms`,
    {
      method: request.method,
      host: url.host,
      path,
      status: response.status,
      ms: Math.round(ms),
      ...(trace === undefined ? {} : { trace }),
    },
  )
}

/** Serve `worker` on a port; resolves with a way to stop. */
export const serve = (options: ServeOptions) => {
  const answer = (request: Request, address: string | undefined) =>
    options.worker.fetch.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request).modify({
          remoteAddress: Option.fromUndefinedOr(address),
        }),
      ),
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const context = yield* Effect.context()
          const span = yield* Effect.option(Effect.currentSpan)

          // Which server trace each file a page fetched ran in, for the page's own timing report (timing.ts).
          const timed = Option.match(span, {
            onNone: () => response,
            onSome: (s) => HttpServerResponse.setHeader(response, "server-timing", serverTiming(s)),
          })

          const web = HttpServerResponse.toWeb(negotiated(request, timed), {
            withoutBody: request.method === "HEAD",
            context,
          })

          const openbelt = web.headers.get("x-openbelt-trace")

          // The request's trace id (its answer's header, the request line's) finds its spans too.
          if (openbelt !== null && Option.isSome(span)) linkTrace(openbelt, span.value.traceId)

          return web
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("the worker failed", cause).pipe(
          Effect.as(new Response("internal error\n", { status: 500 })),
        ),
      ),
      Effect.withSpan(
        `${request.method} ${new URL(request.url).host}${shownPath(new URL(request.url).pathname)}`,
        {
          kind: "server",
        },
      ),
      observed,
      Effect.runPromise,
    )

  const listening = Bun.serve<Page>({
    port: options.port,
    // Every address, IPv6 too (dual stack): a machine reached over IPv6 alone (boat's, many clouds' cheapest) couldn't reach
    // a platform on 0.0.0.0, the IPv4 addresses only.
    hostname: options.hostname ?? "::",
    // The supervisor's processes all serve this port (runtime/supervisor.ts): the kernel spreads connections over them (Linux).
    reusePort: Number(process.env["OPENBELT_PROCESSES"] ?? "1") > 1,
    // SPIKE: files stream in through the gateway; Bun's default refuses bodies over 128 MB.
    maxRequestBodySize: 4 * 1024 ** 3,
    idleTimeout: 120,
    fetch: async (request, server) => {
      const busy = refusal(request)

      if (busy !== undefined) return busy

      const began = performance.now()
      const response = await admitted(answer(request, server.requestIP(request)?.address))

      noteRequest(request, response, performance.now() - began)

      if (response.status !== 101) return response

      const id = response.headers.get(UPGRADE.id)
      const cls = response.headers.get(UPGRADE.cls)
      const name = response.headers.get(UPGRADE.name)

      if (id === null || cls === null || name === null) {
        return new Response("a socket upgrade that names no socket\n", { status: 500 })
      }

      const bridge: Bridge = { cls, name: decodeURIComponent(name), id }

      return server.upgrade(request, { data: { bridge, queued: [], upstream: undefined } })
        ? // SAFETY: Bun answers an upgraded request itself; fetch returns nothing then.
          undefined
        : new Response("couldn't upgrade the connection\n", { status: 500 })
    },
    websocket: {
      open: async (page) => {
        const { bridge } = page.data

        // Its object in this process: bridged here, with no engine between (actor.ts attachHere).
        const local = options.host.attach(bridge.cls, bridge.name, bridge.id, {
          send: (data) => page.send(typeof data === "string" ? data : new Uint8Array(data)),
          close: (code, reason) => page.close(closeCode(code), reason),
        })

        if (local !== undefined) {
          page.data.local = local

          for (const queued of page.data.queued.splice(0))
            local.message(
              typeof queued === "string" ? queued : new Uint8Array(queued).slice().buffer,
            )

          return
        }

        try {
          // Its object in another process of this machine: to that process's internal server.
          const peer = options.host.peerSocket(bridge.cls, bridge.name, bridge.id)

          if (peer === undefined) {
            page.close(1011, "the socket's object isn't here")

            return
          }

          // SAFETY: Bun's WebSocket takes headers as its second argument; the DOM type it is checked against has protocols only.
          const upstream = new WebSocket(peer, { headers: internalHeaders } as unknown as string[])

          // Listening before it opens: the object sends as soon as its end opens (a reconnect's replay, then its hello), and what
          // arrived before a listener was added after the open was lost (15 of a 1,200-change replay, with 4 processes).
          upstream.addEventListener("message", (message) => {
            const data = message.data

            if (typeof data === "string") page.send(data)
            else if (data instanceof ArrayBuffer) page.send(new Uint8Array(data))
          })

          // The actor's end may still be connecting: what the page sent meanwhile waits in `queued` until it is open.
          if (upstream.readyState === WebSocket.CONNECTING) {
            await new Promise<void>((resolve, reject) => {
              upstream.addEventListener("open", () => resolve())
              upstream.addEventListener("close", () => reject(new Error("closed while opening")))
            })
          }

          page.data.upstream = upstream

          upstream.addEventListener("close", (closed) => {
            page.close(closeCode(closed.code), closed.reason ?? "")
          })

          for (const queued of page.data.queued.splice(0)) {
            if (upstream.readyState === WebSocket.OPEN)
              upstream.send(
                typeof queued === "string" ? queued : new Uint8Array(queued).slice().buffer,
              )
          }
        } catch {
          page.close(1011, "the socket's object didn't answer")
        }
      },
      message: (page, message) => {
        const { upstream, local } = page.data

        if (local !== undefined) {
          local.message(
            typeof message === "string" ? message : new Uint8Array(message).slice().buffer,
          )

          return
        }

        // A page can talk while its actor end is still opening (queued) or already closing (dropped: nothing's listening, and a
        // send on a socket that isn't open throws, which would take the server down).
        if (upstream === undefined) page.data.queued.push(message)
        else if (upstream.readyState === WebSocket.OPEN)
          upstream.send(
            typeof message === "string" ? message : new Uint8Array(message).slice().buffer,
          )
      },
      close: (page, code, reason) => {
        page.data.local?.close(code, reason)
        page.data.upstream?.close(closeCode(code), reason)
      },
    },
  })

  // What it has under way, read from Bun's own counts: a climb that doesn't come back down is requests or streams left open.
  setInterval(
    () => recordOpen(listening.pendingRequests, listening.pendingWebSockets),
    5_000,
  ).unref()

  return listening
}
