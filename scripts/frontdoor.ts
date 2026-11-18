// 2. Holding requests while the platform restarts (an upgrade, or the dev server reloading). Without
import { readFileSync } from "node:fs"
import { Option, Schema } from "effect"
import { exitWithParent } from "../packages/platform/src/runtime/lifeline.ts"

const HOLD_MS = 30_000

const SERVICE_RESTART = 1012

const WHOIS_TTL_MS = 60_000

type Who = { readonly login: string; readonly name: string } | null

const known = new Map<string, { readonly who: Who; readonly until: number }>()

const Whois = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      Node: Schema.Struct({ Tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))) }),
      UserProfile: Schema.Struct({ LoginName: Schema.String, DisplayName: Schema.String }),
    }),
  ),
)

const whoOf = (text: string): Who =>
  Option.match(Whois(text), {
    onNone: (): Who => null,
    onSome: (w): Who =>
      (w.Node.Tags ?? []).length > 0
        ? null
        : { login: w.UserProfile.LoginName, name: w.UserProfile.DisplayName },
  })

const whois = async (address: string): Promise<Who> => {
  const cached = known.get(address)

  if (cached !== undefined && cached.until > Date.now()) return cached.who

  const proc = Bun.spawn(["tailscale", "whois", "--json", address], {
    stdout: "pipe",
    stderr: "ignore",
  })

  const who = whoOf(await new Response(proc.stdout).text())

  known.set(address, { who, until: Date.now() + WHOIS_TTL_MS })

  return who
}

const OURS = ["tailscale-user-login", "tailscale-user-name", "x-forwarded-proto", "x-forwarded-for"]

/**
 * A name as a header value: as it is when it's printable ASCII, otherwise an RFC 2047 encoded word,
 * as tailscale serve sends one (a header can't hold "王小明"; the gateway decodes it).
 */
const headerWord = (name: string) =>
  /^[\x20-\x7e]*$/.test(name) ? name : `=?utf-8?b?${Buffer.from(name).toString("base64")}?=`

const passOn = (request: Request, who: Who, address: string, proto: "https" | "http") => {
  const headers = new Headers(request.headers)

  for (const name of OURS) headers.delete(name)

  headers.set("x-forwarded-proto", proto)
  headers.set("x-forwarded-for", address)

  if (who !== null) {
    headers.set("tailscale-user-login", who.login)
    headers.set("tailscale-user-name", headerWord(who.name))
  }

  return headers
}

const Certificate = Schema.Struct({
  serverName: Schema.String,
  cert: Schema.String,
  key: Schema.String,
})

const Listener = Schema.Struct({
  address: Schema.String,
  port: Schema.Number,
  certificates: Schema.Array(Certificate),
  identity: Schema.optional(Schema.Literals(["email", "tailscale"])),
  owner: Schema.optional(Schema.Struct({ login: Schema.String, name: Schema.String })),
})

export type Listener = typeof Listener.Type

/**
 * The names the owner door answers: every name under localhost (browsers resolve them to this
 * machine themselves, never by DNS), so a page can't have one unless it's served from here. Not
 * bare localhost or 127.0.0.1: another OpenBelt on this machine lets a function's fetch or a
 * connection reach those, and here it would be the owner.
 */
const LOCAL_NAME = /^.+\.localhost$/

const RETRY = JSON.stringify({
  error: "OpenBelt is restarting (an update): try again in a few seconds",
  code: "unavailable",
})

const CUT = JSON.stringify({
  error:
    "OpenBelt restarted (an update) while answering this request, so it may or may not have happened: check before you try it again",
  code: "unavailable",
})

const FALLBACK_PAGE =
  "<!doctype html><meta http-equiv=refresh content=3><title>OpenBelt</title><p>OpenBelt is updating. This page reloads in a few seconds."

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * Bun's WebSocket client, which takes headers (who sent it, and the Host that says which app).
 * SAFETY: Bun's constructor takes these options; the DOM lib in tsconfig hides them.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY above
const Upstream = WebSocket as typeof WebSocket & {
  new (url: string, options: { readonly headers: Headers }): WebSocket
}

type Socket = {
  readonly path: string
  readonly headers: Headers
  upstream?: WebSocket
  queue: Array<string | Uint8Array<ArrayBuffer>>
}

const HANDSHAKE = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
]

export const openFrontDoor = (options: {
  readonly listeners: ReadonlyArray<Listener>
  readonly to: number
  readonly updating?: string
}) => {
  const upstream = `127.0.0.1:${options.to}`

  const page = (() => {
    try {
      return options.updating === undefined ? FALLBACK_PAGE : readFileSync(options.updating, "utf8")
    } catch {
      return FALLBACK_PAGE
    }
  })()

  const listening = () =>
    Bun.connect({
      hostname: "127.0.0.1",
      port: options.to,
      socket: {
        data: () => {},
        open: (socket) => {
          socket.end()
        },
      },
    }).then(
      () => true,
      () => false,
    )

  const unavailable = (request: Request) =>
    request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html")
      ? new Response(page, {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", "retry-after": "3" },
        })
      : new Response(RETRY, {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "3" },
        })

  const serve = (listener: Listener) => {
    const tailnet = listener.certificates.length > 0

    return Bun.serve<Socket>({
      hostname: listener.address,
      port: listener.port,
      idleTimeout: 0,
      // None: plain HTTP (an empty list is the same to Bun).
      tls: listener.certificates.map((c) => ({
        serverName: c.serverName,
        cert: Bun.file(c.cert),
        key: Bun.file(c.key),
      })),
      async fetch(request, server) {
        const address = server.requestIP(request)?.address ?? ""
        const url = new URL(request.url)

        if (listener.owner !== undefined && !LOCAL_NAME.test(url.hostname))
          return new Response(
            `${url.hostname} isn't a name under localhost, so this door doesn't answer it: open http://acme.localhost:${listener.port}\n`,
            { status: 421 },
          )

        const who =
          listener.identity === "email"
            ? null
            : tailnet
              ? await whois(address)
              : (listener.owner ?? null)

        const headers = passOn(request, who, address, tailnet ? "https" : "http")
        const target = `http://${upstream}${url.pathname}${url.search}`

        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (!(await listening()))
            return new Response(RETRY, {
              status: 503,
              headers: { "content-type": "application/json" },
            })

          for (const h of HANDSHAKE) headers.delete(h)

          return server.upgrade(request, {
            data: { path: `${url.pathname}${url.search}`, headers, queue: [] },
          })
            ? undefined
            : new Response("expected a WebSocket upgrade\n", { status: 400 })
        }

        const body =
          request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer()

        const deadline = Date.now() + HOLD_MS

        // oxlint-disable-next-line no-await-in-loop -- waiting for the platform to listen
        while (!(await listening())) {
          if (Date.now() > deadline) return unavailable(request)

          // oxlint-disable-next-line no-await-in-loop -- see above
          await sleep(250)
        }

        // Uncompressed: Bun's fetch would decompress the body and keep its content-encoding header.
        headers.set("accept-encoding", "identity")

        return fetch(target, { method: request.method, headers, body, redirect: "manual" }).catch(
          () => new Response(CUT, { status: 502, headers: { "content-type": "application/json" } }),
        )
      },
      websocket: {
        open(ws) {
          const socket = new Upstream(`ws://${upstream}${ws.data.path}`, {
            headers: ws.data.headers,
          })

          ws.data.upstream = socket
          socket.binaryType = "arraybuffer"

          socket.addEventListener("open", () => {
            for (const message of ws.data.queue) socket.send(message)

            ws.data.queue = []
          })
          socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
            ws.send(event.data)
          })
          socket.addEventListener("close", (event) => {
            ws.close(
              event.code === 1005 || event.code === 1006 ? SERVICE_RESTART : event.code,
              event.reason,
            )
          })
          socket.addEventListener("error", () =>
            ws.close(SERVICE_RESTART, "OpenBelt is restarting"),
          )
        },
        message(ws, received) {
          const socket = ws.data.upstream
          const message = Buffer.isBuffer(received) ? Uint8Array.from(received) : received

          if (socket?.readyState === WebSocket.OPEN) socket.send(message)
          else ws.data.queue.push(message)
        },
        close(ws, code, reason) {
          ws.data.upstream?.close(code === 1005 || code === 1006 ? 1000 : code, reason)
        },
      },
    })
  }

  const servers = options.listeners.map(serve)

  return {
    urls: servers.map((s) => s.url.href),
    stop: () => Promise.all(servers.map((s) => s.stop(true))),
  }
}

const Config = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      listeners: Schema.Array(Listener),
      to: Schema.Number,
      updating: Schema.String,
    }),
  ),
)

if (import.meta.main) {
  exitWithParent()

  const file = process.argv[2] ?? ""

  const config = Option.getOrElse(Config(readFileSync(file, "utf8")), () => {
    console.error(`front door: ${file} isn't a front door config ({ listeners, to, updating })`)

    return process.exit(2)
  })

  const door = openFrontDoor(config)

  console.log(`front door: ${door.urls.join(", ")} → 127.0.0.1:${config.to}`)
}
