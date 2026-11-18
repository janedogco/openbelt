import { lookup } from "node:dns/promises"
import * as Config from "effect/Config"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { HttpClientError } from "effect/http"
import { type Json, Refused } from "./model.ts"
import * as Runtime from "./runtime/index.ts"
import { privateAddress } from "./runtime/egress.ts"
import { bearerChallenge, LIMITED } from "./oauth-wire.ts"
import { type Answer, exchange, firstWords, textUpTo } from "./outbound.ts"

export const correlation = Effect.map(References.CurrentLogAnnotations, (annotations) =>
  Option.match(Schema.decodeUnknownOption(Schema.String)(annotations["trace"]), {
    onNone: (): Readonly<Record<string, string>> => ({}),
    onSome: (trace) => ({ "x-correlation-id": trace }),
  }),
)

const PROTOCOL = "2025-06-18"

const MAX_RESULT_CHARS = 100_000

/** How long a server has to answer: initialize and tools/list, and a tool call (DeepWiki takes 10-20s). */
const OPEN_MS = 20_000

const CALL_MS = 60_000

export type UpstreamTool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Json
  readonly annotations: Json
  readonly readOnly: boolean
}

export type UpstreamCredential =
  | {
      readonly kind: "unsigned"
      readonly token: string | undefined
      readonly challenged: (challenge: string) => Effect.Effect<never, Refused>
    }
  | {
      readonly kind: "signed_in"
      readonly token: string
      readonly renew: Effect.Effect<string, Refused>
      readonly turnedDown: Effect.Effect<void>
      readonly missingScope: (scope: string) => Refused
    }

export type Upstream = {
  readonly connection: string
  readonly url: string
  readonly key: string
  readonly credential: UpstreamCredential
}

const tokenOf = (upstream: Upstream) => upstream.credential.token

type Attempt = Upstream & { readonly renewed: boolean }

export const redact = (text: string, token: string | undefined) =>
  token === undefined || token.length < 4 ? text : text.replaceAll(token, "***")

export const sealing = Effect.fn("upstream.sealing")(function* (master: string) {
  const key = yield* Effect.promise(async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(master),
      "HKDF",
      false,
      ["deriveKey"],
    )

    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("openbelt-connections"),
        info: new TextEncoder().encode("v1"),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    )
  })

  return {
    seal: Effect.fnUntraced(function* (plain: string, bound: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12))

      const sealed = yield* Effect.promise(() =>
        crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(bound) },
          key,
          new TextEncoder().encode(plain),
        ),
      )

      return `v1.${iv.toBase64()}.${new Uint8Array(sealed).toBase64()}`
    }),

    open: Effect.fnUntraced(function* (sealed: string, bound: string) {
      const [version, iv, data] = sealed.split(".")

      if (version !== "v1" || iv === undefined || data === undefined) return undefined

      return yield* Effect.tryPromise(() =>
        crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.fromBase64(iv),
            additionalData: new TextEncoder().encode(bound),
          },
          key,
          Uint8Array.fromBase64(data),
        ),
      ).pipe(
        Effect.map((plain) => new TextDecoder().decode(plain)),
        Effect.orElseSucceed(() => undefined),
      )
    }),
  }
})

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"])

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".ts.net"]

export type Reach = {
  readonly allowLocal: boolean
  readonly host: string
  /** OPENBELT_BASE_HOST when the base host is on a domain of its own, else "". */
  readonly baseHost: string
  readonly ports: ReadonlyArray<string>
}

export const REACH = Config.all({
  allowLocal: Config.String("OPENBELT_ALLOW_LOCAL_CONNECTIONS").pipe(
    Config.withDefault(""),
    Config.map((v) => v === "1"),
  ),
  host: Config.String("OPENBELT_HOST").pipe(
    Config.withDefault("localhost"),
    Config.map((h) => h.toLowerCase()),
  ),
  baseHost: Config.String("OPENBELT_BASE_HOST").pipe(
    Config.withDefault(""),
    Config.map((h) => h.toLowerCase()),
  ),
  ports: Config.all([
    Config.String("OPENBELT_PORT").pipe(Config.withDefault("")),
    Config.String("OPENBELT_DOOR_PORT").pipe(Config.withDefault("")),
  ]).pipe(Config.map((ports) => ports.filter((p) => p !== ""))),
})

type Sender = "connection" | "fetch" | "client"

const FROM: Record<Sender, string> = {
  connection: "OpenBelt calls a connection from its own servers",
  fetch: "a function's fetch goes out from OpenBelt's own servers",
  client: "OpenBelt fetches an OAuth client's metadata document from its own servers",
}

const INSTEAD: Record<Sender, string> = {
  connection: "connect a server outside OpenBelt",
  fetch:
    "a function reaches its workspace's data through its ctx (db, call), and another app's through that app's functions, not over HTTP",
  client: "host the client's metadata document on a public https URL",
}

export const urlProblem = (url: string, reach: Reach, sender: Sender) => {
  if (!URL.canParse(url))
    return sender === "connection"
      ? `"${url.slice(0, 100)}" isn't a URL: send the server's MCP URL, like https://mcp.deepwiki.com/mcp`
      : `"${url.slice(0, 100)}" isn't a URL`

  const parsed = new URL(url)
  const host = parsed.hostname
  const local = LOCAL_NAMES.has(host)
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : parsed.port

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return `${parsed.protocol} isn't http or https`

  if (parsed.username !== "" || parsed.password !== "")
    return sender === "connection"
      ? "a connection's URL can't carry a user or password: set its token with connections token instead"
      : "a URL can't carry a user or password: put it in a header with a secret (secrets.NAME)"

  if (local && reach.allowLocal && reach.ports.includes(port))
    return `${parsed.host} is OpenBelt itself (it listens on port ${port} here), and ${FROM[sender]}, so it would act as OpenBelt: ${INSTEAD[sender]}. A test server goes on another port`

  if (local && reach.allowLocal) return undefined

  const bare = host.replace(/^\[|\]$/g, "").replace(/\.$/, "")
  const literal = /^[\d.]+$/.test(bare) || bare.includes(":")

  if (
    bare === reach.host ||
    bare.endsWith(`.${reach.host}`) ||
    (reach.baseHost !== "" && bare === reach.baseHost)
  )
    return `${host} is OpenBelt's own (its workspace and app hosts are under ${reach.host}${reach.baseHost === "" || reach.baseHost === reach.host ? "" : `, its base host is ${reach.baseHost}`}), and ${FROM[sender]}, so it would act as OpenBelt: ${INSTEAD[sender]}`

  if (
    LOCAL_NAMES.has(bare) ||
    (literal && privateAddress(bare)) ||
    !bare.includes(".") ||
    PRIVATE_SUFFIXES.some((suffix) => bare.endsWith(suffix))
  ) {
    return `${host} is this machine's or a private network's address, and ${FROM[sender]}, so it must be a public host`
  }

  if (parsed.protocol !== "https:")
    return sender === "connection"
      ? `${url.slice(0, 100)} isn't https: a connection's server must be https${reach.allowLocal ? " (or http to localhost, here)" : ""}`
      : `use https:// (plain http is only for localhost under bun run dev and verify)`

  return undefined
}

export const resolvesPrivate = Effect.fn("upstream.resolvesPrivate")(function* (url: string) {
  const host = new URL(url).hostname

  if (LOCAL_NAMES.has(host) || /^[\d.]+$/.test(host) || host.startsWith("[")) return

  // A lookup is a wait outside the object: whoever asked gives up its turn meanwhile, so a slow resolver holds up one call, not the workspace.
  const addresses = yield* Runtime.idle(
    Effect.tryPromise({
      try: async () => (await lookup(host, { all: true })).map((found) => found.address),
      catch: (cause) =>
        cause instanceof Error &&
        "code" in cause &&
        ["ENOTFOUND", "ENODATA"].includes(String(cause.code))
          ? new Refused({ message: `${host} doesn't resolve to an address: check the URL` })
          : new Refused({
              message: `couldn't look up ${host} (the DNS lookup failed), so OpenBelt can't tell it's a public host: try again`,
            }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () =>
          Effect.fail(
            new Refused({
              message: `couldn't look up ${host} (the DNS lookup took over 5 seconds), so OpenBelt can't tell it's a public host: try again`,
            }),
          ),
      }),
    ),
  )

  if (addresses.length === 0) {
    yield* new Refused({ message: `${host} doesn't resolve to an address: check the URL` })
  }

  const inside = addresses.find(privateAddress)

  if (inside !== undefined) {
    yield* new Refused({
      message: `${host} points at ${inside}, a private or local address, which OpenBelt doesn't send to: it sends from its own servers, so it must be a public host`,
    })
  }
})

const LOOKUP_MS = 60_000

const lookups = new Map<string, { readonly until: number; readonly problem: string | undefined }>()

export const lookedUp = Effect.fn("upstream.lookedUp")(function* (url: string) {
  const host = new URL(url).hostname
  const known = lookups.get(host)

  if (known !== undefined && known.until > Date.now()) return known.problem

  const checked = yield* Effect.result(resolvesPrivate(url))
  const problem = Result.isFailure(checked) ? checked.failure.message : undefined

  if (problem === undefined || !problem.startsWith("couldn't look up"))
    lookups.set(host, { until: Date.now() + LOOKUP_MS, problem })

  return problem
})

const RpcReply = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})

type RpcReply = typeof RpcReply.Type

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(RpcReply))

const ListedTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.optionalKey(Schema.Json),
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})

const ToolsPage = Schema.Struct({
  tools: Schema.Array(ListedTool),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const decodeToolsPage = Schema.decodeUnknownOption(Schema.fromJsonString(ToolsPage))

const InitializeResult = Schema.Struct({ protocolVersion: Schema.String })

const decodeInitialize = Schema.decodeUnknownOption(InitializeResult)

const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Json),
  structuredContent: Schema.optionalKey(Schema.Json),
  isError: Schema.optionalKey(Schema.Boolean),
})

export type ToolResult = typeof ToolResult.Type

const decodeToolResult = Schema.decodeUnknownOption(Schema.fromJsonString(ToolResult))

type Session = { readonly id: string | undefined; readonly protocol: string }

type Sent = {
  readonly status: number
  readonly session: string | undefined
  readonly reply: RpcReply | undefined
  readonly challenge: string | null
  readonly said: string
  readonly retryAfter: string | null
  /** Its reply went past MAX_REPLY_BYTES and wasn't read. */
  readonly tooLarge: boolean
}

/**
 * The most a connection's server may answer one call with: past it the rest isn't read. Every byte read is held in the platform
 * process until the reply is decoded: a server that answered tools/list with 1.2 GB ended the process (out of memory).
 */
const MAX_REPLY_BYTES = 16 * 1024 * 1024

/**
 * The reply to request `id` in a Server-Sent Events answer: read until it arrives (the rest is not read), the answer ends, or
 * MAX_REPLY_BYTES are read without it (`over`).
 */
const readSse = Effect.fnUntraced(function* (stream: Answer["stream"], id: number) {
  const decoder = new TextDecoder()
  let buffer = ""
  let found: RpcReply | undefined

  let over = false
  let bytes = 0

  const take = (text: string) => {
    buffer += text

    let end = buffer.search(/\r?\n\r?\n/)

    while (end !== -1) {
      const event = buffer.slice(0, end)

      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "")

      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")

      const reply = Option.getOrUndefined(decodeReply(data))

      if (reply !== undefined && reply.id === id) {
        found = reply

        return false
      }

      end = buffer.search(/\r?\n\r?\n/)
    }

    return true
  }

  yield* Stream.runForEachWhile(stream, (chunk) =>
    Effect.sync(() => {
      bytes += chunk.byteLength

      if (bytes > MAX_REPLY_BYTES) {
        over = true

        return false
      }

      return take(decoder.decode(chunk, { stream: true }))
    }),
  )

  if (found === undefined && !over) take(`${decoder.decode()}\n\n`)

  return { reply: found, over }
})

let nextId = 1

const send = Effect.fnUntraced(function* (
  upstream: Upstream,
  session: Session | undefined,
  method: string,
  params: Json | undefined,
  timeoutMs: number,
) {
  const request = !method.startsWith("notifications/")
  const id = nextId++

  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "OpenBelt-Connections/1",
    ...(yield* correlation),
  })

  if (tokenOf(upstream) !== undefined) headers.set("authorization", `Bearer ${tokenOf(upstream)}`)

  if (session !== undefined) headers.set("mcp-protocol-version", session.protocol)

  if (session?.id !== undefined) headers.set("mcp-session-id", session.id)

  const message =
    params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }

  return yield* exchange(
    {
      kind: "mcp",
      url: upstream.url,
      method: "POST",
      headers,
      body: JSON.stringify(request ? { ...message, id } : message),
      timeoutMs,
    },
    (answer): Effect.Effect<Sent, HttpClientError.HttpClientError> => {
      const sessionId = answer.headers.get("mcp-session-id") ?? undefined
      const ok = answer.status >= 200 && answer.status < 300

      if (!request || !ok)
        return Effect.map(ok ? Effect.succeed("") : firstWords(answer), (said) => ({
          status: answer.status,
          session: sessionId,
          reply: undefined,
          challenge: answer.headers.get("www-authenticate"),
          said,
          retryAfter: answer.headers.get("retry-after"),
          tooLarge: false,
        }))

      const reply = (answer.headers.get("content-type") ?? "").includes("text/event-stream")
        ? readSse(answer.stream, id)
        : Effect.map(textUpTo(answer, MAX_REPLY_BYTES), (text) => ({
            reply: text === undefined ? undefined : Option.getOrUndefined(decodeReply(text)),
            over: text === undefined,
          }))

      return Effect.map(reply, ({ reply: got, over }) => ({
        status: answer.status,
        session: sessionId,
        tooLarge: over,
        reply: got,
        challenge: null,
        said: "",
        retryAfter: null,
      }))
    },
  ).pipe(
    Effect.catchTag("OutboundFailed", (failed) =>
      failed.reason === "timeout"
        ? Effect.fail(
            new Refused({
              message: `${upstream.connection} didn't answer ${method} within ${timeoutMs / 1000}s: it may be busy or down; try again later`,
            }),
          )
        : Effect.logWarning(
            `couldn't reach ${upstream.connection} on ${method}: ${redact(failed.detail, tokenOf(upstream)).slice(0, 300)}`,
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new Refused({
                  message: `couldn't reach ${upstream.connection} at ${upstream.url}: it couldn't connect, or the connection broke. If it's down, try again later.`,
                }),
              ),
            ),
          ),
    ),
  )
})

const failed = (upstream: Upstream, method: string, sent: Sent) => {
  const { error, scope } = bearerChallenge(sent.challenge)
  const { credential } = upstream

  if (
    sent.status === 403 &&
    error === "insufficient_scope" &&
    scope !== undefined &&
    credential.kind === "signed_in"
  )
    return credential.missingScope(scope)

  // A rate limit isn't a refusal of the token (Google answers some with 403): nothing changes,
  // the sign-in included; the call is tried again later.
  if (
    sent.status === 429 ||
    ((sent.status === 403 || sent.status === 503) && LIMITED.test(sent.said))
  )
    return new Refused({
      message: `${upstream.connection} is limiting how often it's called (HTTP ${sent.status}${LIMITED.test(sent.said) ? `: ${redact(sent.said, tokenOf(upstream)).replace(/\s+/g, " ").slice(0, 120)}` : ""}): nothing changed; try again ${sent.retryAfter === null ? "in a minute" : `after ${sent.retryAfter.slice(0, 40)}${/^\d+$/.test(sent.retryAfter) ? "s" : ""}`}`,
    })

  if (sent.status === 401 || sent.status === 403) {
    return new Refused({
      message: `${upstream.connection} refused OpenBelt (HTTP ${sent.status}) on ${method}: ${tokenOf(upstream) === undefined ? "it wants a token, and this call had none" : "it didn't accept the token (it may be wrong, expired or missing a scope): set it again"}`,
    })
  }

  if (sent.status >= 300 && sent.status < 400) {
    return new Refused({
      message: `${upstream.connection} answered ${method} with a redirect (HTTP ${sent.status}), which OpenBelt doesn't follow: an admin sets the URL it redirects to (connections add)`,
    })
  }

  if (sent.tooLarge)
    return new Refused({
      message: `${upstream.connection} answered ${method} with more than ${MAX_REPLY_BYTES / 1024 / 1024} MB, the most OpenBelt reads of one reply: ask for less (a narrower call), or ask the server's owner`,
    })

  if (sent.reply?.error !== undefined) {
    return new Refused({
      message: `${upstream.connection} answered ${method} with error ${sent.reply.error.code}: ${redact(sent.reply.error.message, tokenOf(upstream)).slice(0, 500)}`,
    })
  }

  return new Refused({
    message: `${upstream.connection} answered ${method} with HTTP ${sent.status} and no MCP reply: is ${upstream.url} a Streamable HTTP MCP endpoint?`,
  })
}

const open = Effect.fnUntraced(function* (upstream: Attempt) {
  const sent = yield* send(
    upstream,
    undefined,
    "initialize",
    {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "openbelt", version: "1.0.0" },
    },
    OPEN_MS,
  )

  const result = Option.getOrUndefined(decodeInitialize(sent.reply?.result))

  // A 2026-07-28 server has no initialize or sessions: every request stands alone.
  const sessionless = sent.reply?.error?.code === -32601 || [400, 404, 405].includes(sent.status)

  if (result === undefined && sessionless) return { id: undefined, protocol: "2026-07-28" }

  const { credential } = upstream

  if (result === undefined && sent.status === 401 && credential.kind === "signed_in") {
    if (!upstream.renewed) return undefined

    yield* credential.turnedDown
  }

  if (result === undefined) return yield* failed(upstream, "initialize", sent)

  const session: Session = { id: sent.session, protocol: result.protocolVersion }

  yield* send(upstream, session, "notifications/initialized", undefined, OPEN_MS)

  return session
})

export const upstreamClient = () => {
  const sessions = new Map<string, Deferred.Deferred<Session | undefined, Refused>>()

  const sessionOf = Effect.fnUntraced(function* (upstream: Attempt) {
    const known = sessions.get(upstream.key)

    // Waiting on another call's opening gives up the turn: that call's own steps need it.
    if (known !== undefined) return yield* Runtime.idle(Deferred.await(known))

    const deferred = Deferred.makeUnsafe<Session | undefined, Refused>()

    sessions.set(upstream.key, deferred)

    yield* Deferred.into(open(upstream), deferred)

    const opened = yield* Effect.result(Deferred.await(deferred))

    if (Result.isFailure(opened) || opened.success === undefined) {
      if (sessions.get(upstream.key) === deferred) sessions.delete(upstream.key)
    }

    if (Result.isFailure(opened)) return yield* opened.failure

    return opened.success
  })

  const drop = Effect.fnUntraced(function* (upstream: Upstream, session: Session) {
    const known = sessions.get(upstream.key)

    if (known === undefined) return

    const current = yield* Runtime.idle(Deferred.await(known)).pipe(Effect.option)

    if (Option.isNone(current) || current.value?.id === session.id) sessions.delete(upstream.key)
  })

  const request = Effect.fnUntraced(function* (
    first: Upstream,
    method: string,
    params: Json,
    timeoutMs: number,
  ) {
    let upstream: Attempt = { ...first, renewed: false }

    const renewable = () => upstream.credential.kind === "signed_in" && !upstream.renewed

    const renew = Effect.fnUntraced(function* () {
      const { credential } = upstream

      if (credential.kind !== "signed_in") return

      yield* Effect.logInfo(`${upstream.connection}: it answered 401, so the sign-in is refreshed`)
      upstream = {
        ...upstream,
        credential: { ...credential, token: yield* credential.renew },
        renewed: true,
      }
    })

    let opened = yield* sessionOf(upstream)

    if (opened === undefined && renewable()) {
      yield* renew()
      opened = yield* sessionOf(upstream)
    }

    if (opened === undefined) return yield* Effect.die("a session opens or fails")

    let session = opened
    let sent = yield* send(upstream, session, method, params, timeoutMs)

    const again = Effect.fnUntraced(function* () {
      yield* drop(upstream, session)

      const next = yield* sessionOf(upstream)

      if (next === undefined) return yield* failed(upstream, "initialize", { ...sent, status: 401 })

      session = next
      sent = yield* send(upstream, session, method, params, timeoutMs)

      return sent
    })

    if (sent.status === 404 && session.id !== undefined) {
      yield* Effect.logInfo(`${upstream.connection}: its session expired, so another was opened`)
      yield* again()
    }

    if (sent.status === 401 && renewable()) {
      yield* renew()
      yield* again()
    }

    if (sent.reply?.result === undefined) {
      const { credential } = upstream

      if (sent.status === 401 || sent.status === 403) yield* drop(upstream, session)

      if (sent.status === 401 && credential.kind === "signed_in" && upstream.renewed)
        yield* credential.turnedDown

      // Asked for OAuth on a call with no sign-in to renew (Google's tools/call).
      if (
        sent.status === 401 &&
        credential.kind === "unsigned" &&
        bearerChallenge(sent.challenge).metadata !== undefined
      )
        return yield* credential.challenged(sent.challenge ?? "")

      return yield* failed(upstream, method, sent)
    }

    return redact(redact(JSON.stringify(sent.reply.result), tokenOf(first)), tokenOf(upstream))
  })

  return {
    forget: (match: (key: string) => boolean) => {
      for (const key of sessions.keys()) if (match(key)) sessions.delete(key)
    },

    listTools: Effect.fnUntraced(function* (upstream: Upstream) {
      const tools: Array<UpstreamTool> = []
      let cursor: string | undefined

      for (let page = 0; page < 20; page++) {
        const result = yield* request(
          upstream,
          "tools/list",
          cursor === undefined ? {} : { cursor },
          OPEN_MS,
        )

        const decoded = Option.getOrUndefined(decodeToolsPage(result))

        if (decoded === undefined) {
          return yield* new Refused({
            message: `${upstream.connection}'s tools/list reply isn't a list of tools`,
          })
        }

        for (const tool of decoded.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema ?? { type: "object" },
            annotations: tool.annotations ?? {},
            readOnly: tool.annotations?.["readOnlyHint"] === true,
          })
        }

        cursor = decoded.nextCursor ?? undefined

        if (cursor === undefined) break
      }

      return tools
    }),

    callTool: Effect.fnUntraced(function* (upstream: Upstream, tool: string, args: Json) {
      const result = yield* request(
        upstream,
        "tools/call",
        { name: tool, arguments: args },
        CALL_MS,
      )

      const decoded = Option.getOrUndefined(decodeToolResult(result))

      if (decoded === undefined) {
        return yield* new Refused({
          message: `${upstream.connection}'s reply to ${tool} isn't a tool result`,
        })
      }

      return capped(decoded)
    }),
  }
}

const decodeText = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("resource"),
      resource: Schema.Struct({ text: Schema.String }),
    }),
  ]),
)

const blockText = (block: Json) =>
  Option.map(decodeText(block), (b) => (b.type === "text" ? b.text : b.resource.text))

const capped = (result: ToolResult): ToolResult => {
  if (JSON.stringify(result).length <= MAX_RESULT_CHARS) return result

  let left = MAX_RESULT_CHARS

  const content = result.content.map((block): Json => {
    const said = Option.getOrUndefined(blockText(block))

    if (said === undefined) return block

    const kept = said.slice(0, Math.max(0, left))

    left -= kept.length

    return kept.length === said.length
      ? block
      : {
          type: "text",
          text: `${kept}\n... (OpenBelt cut this: the server's reply was ${said.length} characters, past the ${MAX_RESULT_CHARS} a result keeps; ask for less)`,
        }
  })

  return { content, isError: result.isError ?? false }
}

export const textOf = (result: ToolResult) =>
  result.content.flatMap((block) => Option.toArray(blockText(block))).join("\n")
