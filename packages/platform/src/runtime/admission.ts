// Admission: past what this process can serve, a new request is refused at once (503, Retry-After) instead of joining a queue
// that only grows until every request in it times out. The signal is the requests under way in this process: at 500 requests a
// second over 4 processes there are at most about 40, so the cap is reached only by real overload.
//
// Not the event loop's delay: refusing when the loop ran late (over 50 ms, with 16 or more requests under way) refused 3 to 15% of
// a cold 500 requests a second on 4 processes, and protected nothing: with it off, the same load had no errors and a lower p99 (a
// lab: 0 refused, p99 36 ms by the second minute), each process at about half a core.
import { recordShed } from "./metrics.ts"
import { say } from "./observe.ts"

const number = (name: string, fallback: number) => {
  const set = Number(process.env[name])

  return Number.isFinite(set) && set > 0 ? set : fallback
}

/** Requests under way in this process past which new ones are refused. */
const MAX_UNDER_WAY = number("OPENBELT_SHED_UNDER_WAY", 256)

let underWay = 0

let shed = 0

let lastSaid = Date.now()

/** Paths a busy process still answers: its health (a load balancer's question), its operator's, certificates. */
const ALWAYS = /^\/(_health|_admin\/|_tls\/ask)/

const BUSY_HEADER = "x-openbelt-busy"

/**
 * A 503 to send now instead of serving `request`, or undefined to serve it. Refused requests did nothing, so any of them, a POST
 * too, can be sent again: the SDK does, after Retry-After.
 */
export const refusal = (request: Request): Response | undefined => {
  // A request whose URL doesn't parse isn't this cap's to judge: the server answers it (400) as before.
  const path = URL.parse(request.url)?.pathname

  if (path === undefined) return undefined

  // A socket's upgrade is one request for a connection that lasts: refused, a page reconnects at once and is refused again (a
  // burst of 1,000 page opens got 128 to 256 sockets through), so upgrades aren't counted against the cap.
  // An agent's MCP call is few and worth more than a page load, and an MCP client shows a bare 503 as a failed call (a seed of 500
  // deploys failed on it): not counted either.
  if (ALWAYS.test(path) || path === "/mcp" || request.headers.get("upgrade") !== null)
    return undefined

  if (underWay < MAX_UNDER_WAY) return undefined

  shed++
  recordShed()

  const now = Date.now()

  if (now - lastSaid > 10_000) {
    say(
      "warn",
      `admission: busy, refused ${shed} requests in the last ${Math.round((now - lastSaid) / 1000)} s`,
      { shed, underWay },
    )
    shed = 0
    lastSaid = now
  }

  return new Response("OpenBelt is busy: try again in a second\n", {
    status: 503,
    headers: { "retry-after": "1", [BUSY_HEADER]: "1", "content-type": "text/plain" },
  })
}

/** Count a request under way until `done` settles. */
export const admitted = async <A>(done: Promise<A>): Promise<A> => {
  underWay++

  try {
    return await done
  } finally {
    underWay--
  }
}
