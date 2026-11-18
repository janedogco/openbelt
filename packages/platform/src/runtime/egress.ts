// check_app's Chrome reaches the network only through this proxy (browser.ts). It runs pages agents wrote, on the platform's own
// machine: without it a page, or a check's eval step, reads the cloud's metadata service, the engine and anything else on the
// private network by navigating there (a top-level navigation isn't subject to CORS or Chrome's local-network checks).
// OpenBelt's own names go to its own ports only. Any other name is looked up here, refused when one of its addresses is private,
// loopback or link-local, and connected to at the address that was checked, so a name that answers differently the second time
// gets nowhere. Headers that say who is viewing are dropped: a page can't claim to be someone by sending them.
import { lookup } from "node:dns/promises"
import {
  createServer,
  type IncomingMessage,
  request as forward,
  type ServerResponse,
} from "node:http"
import { connect, isIP } from "node:net"
import type { Duplex } from "node:stream"
import { say } from "./observe.ts"

const privateV4 = (ip: string) => {
  const parts = ip.split(".").map(Number)

  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false

  const [a = 0, b = 0, c = 0] = parts

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

const privateV6 = (ip: string) => {
  const lower = ip.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1]

  if (mapped !== undefined) return privateV4(mapped)

  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true

  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd][0-9a-f]{0,2}:/.test(lower) ||
    /^fe[89ab][0-9a-f]?:/.test(lower) ||
    /^ff[0-9a-f]{0,2}:/.test(lower) ||
    lower.startsWith("64:ff9b:")
  )
}

/** This machine's, a private network's, link-local (the cloud's metadata service), multicast or reserved. */
export const privateAddress = (address: string) =>
  address.includes(":") ? privateV6(address) : privateV4(address)

/**
 * What a front door says about who is viewing, or where a request came from: session.ts's saysWho, but for OpenBelt's own
 * x-openbelt- headers other than the front door's, which the gateway drops itself (check_app adds one, x-openbelt-readonly, which
 * only narrows what a call may do). This proxy reaches OpenBelt from loopback, which the gateway believes: none may get through.
 */
const FRONT_DOOR =
  /^(tailscale-|cf-|x-forwarded-|forwarded$|x-real-ip$|true-client-ip$|x-openbelt-front-door$)/

const HOST = (process.env["OPENBELT_HOST"] ?? "localhost").toLowerCase()

const BASE_HOST = (process.env["OPENBELT_BASE_HOST"] || HOST).toLowerCase()

/** Where OpenBelt answers on this machine: its own port, and bun run dev's door and https ports. */
const OWN_PORTS = new Set(
  ["OPENBELT_PORT", "OPENBELT_DOOR_PORT", "OPENBELT_HTTPS_PORT"].flatMap((name) => {
    const port = process.env[name] ?? ""

    return port === "" ? [] : [port]
  }),
)

const loopbackName = (name: string) => name === "localhost" || name.endsWith(".localhost")

const ownName = (name: string) =>
  loopbackName(name) || name === HOST || name === BASE_HOST || name.endsWith(`.${HOST}`)

type Where = { readonly address: string; readonly port: number } | { readonly refused: string }

/**
 * Behind a front door that signs people in (deploy/signin), check_app's browser can't sign in: OpenBelt's own names over https go
 * to that proxy's listener for it instead (OPENBELT_CHECK_DOOR, host:port), which signs nobody in and only this network reaches.
 */
const CHECK_DOOR = /^(.+):(\d+)$/.exec(process.env["OPENBELT_CHECK_DOOR"] ?? "")

const addressesOf = (name: string) =>
  Promise.race([
    lookup(name, { all: true }).then(
      (found) => found.map((a) => a.address),
      () => [],
    ),
    Bun.sleep(5000).then(() => []),
  ])

const where = async (hostname: string, port: string): Promise<Where> => {
  const name = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")

  // A localhost name is this machine, where only OpenBelt's own ports are OpenBelt. Under OPENBELT_HOST, the proxy in front answers too.
  if (loopbackName(name))
    return OWN_PORTS.has(port)
      ? { address: "127.0.0.1", port: Number(port) }
      : { refused: `${name}:${port} isn't one of OpenBelt's ports` }

  if (CHECK_DOOR !== null && ownName(name) && port === "443")
    return { address: CHECK_DOOR[1] ?? "", port: Number(CHECK_DOOR[2]) }

  if (ownName(name) && !OWN_PORTS.has(port) && port !== "80" && port !== "443")
    return { refused: `${name}:${port} isn't one of OpenBelt's ports` }

  const addresses = isIP(name) === 0 ? await addressesOf(name) : [name]

  if (addresses.length === 0) return { refused: `${name} doesn't resolve` }

  // OpenBelt's own names may point at a private address (a load balancer's, this machine's): they reach only its ports, above.
  const inside = ownName(name) ? undefined : addresses.find(privateAddress)

  if (inside !== undefined)
    return { refused: `${name} is ${inside}, this machine's or a private network's address` }

  return { address: addresses[0] ?? "", port: Number(port) }
}

const refusal = (what: string, why: string) => {
  say("warn", `check_app's browser: ${what} refused: ${why}`, { from: "check_app" })

  return `OpenBelt's check browser reaches OpenBelt's own names and public addresses only: ${why}\n`
}

/** A plain http request, sent on to the checked address with the headers that say who is viewing dropped. */
const answer = async (req: IncomingMessage, res: ServerResponse) => {
  const url = URL.canParse(req.url ?? "") ? new URL(req.url ?? "") : undefined

  if (url === undefined || url.protocol !== "http:") {
    res.writeHead(400).end("not a proxy request\n")

    return
  }

  const port = url.port === "" ? "80" : url.port
  const to = await where(url.hostname, port)

  if ("refused" in to) {
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end(refusal(`${req.method} ${url.origin}`, to.refused))

    return
  }

  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([name]) => !FRONT_DOOR.test(name) && !name.startsWith("proxy-"),
    ),
  )

  const out = forward(
    {
      host: to.address,
      port: to.port,
      method: req.method,
      path: url.pathname + url.search,
      headers: { ...headers, host: url.host },
    },
    (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(res)
    },
  )

  out.on("error", () => {
    if (!res.headersSent) res.writeHead(502)

    res.end()
  })
  req.pipe(out)
}

/** https and sockets: a tunnel to the checked address. What goes through it is encrypted (https) or a WebSocket's frames. */
const tunnel = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const target = req.url ?? ""
  const at = target.lastIndexOf(":")
  const to = await where(target.slice(0, at), target.slice(at + 1))

  if ("refused" in to) {
    socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${refusal(`CONNECT ${target}`, to.refused)}`)

    return
  }

  const upstream = connect(to.port, to.address, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })

  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
}

/** The proxy, on a loopback port of its own; resolves to the port. One per process, for every check's browser. */
export const startEgress = async () => {
  const server = createServer((req, res) => void answer(req, res))

  server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void tunnel(req, socket, head)
  })

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()))

  const address = server.address()

  if (typeof address !== "object" || address === null)
    throw new Error("check_app's egress proxy has no port")

  // It never keeps the process alive: shutdown.ts ends the process when it is done.
  server.unref()

  return address.port
}
