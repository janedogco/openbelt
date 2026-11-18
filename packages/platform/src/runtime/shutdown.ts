// How the process stops on SIGTERM or SIGINT: in order, each step capped, and a hard deadline over all of it. A handler that sent
// itself SIGTERM again, counting on no listener being left so the default action would end the process, never exited once a Chrome
// launched meanwhile (check_app, a home page's picture booked after a deploy) had added Puppeteer's listener (6 of 6 tries).
import type { Server } from "bun"
import { awakeHere, stopHost } from "./actor.ts"
import { say, stopExport } from "./observe.ts"
import { endSandboxes } from "./sandbox.ts"
import { closeLine } from "./turns.ts"

/** Past this the process exits whatever is still going. */
const DEADLINE_MS = 22_000

/** How long the requests in flight get to finish (a function's run, a page's write) before they are cut. */
const DRAIN_MS = 5000

/** How long /_health says the process is stopping, while it still serves, before it stops taking connections: a proxy in front
 * (Caddy checks every second) sends to the next process meanwhile, so no request is sent on a connection as it closes. */
const UNHEALTHY_FIRST_MS = 2000

let stoppingSince: number | undefined

/** Whether this process is stopping (/_health answers 503 then). */
export const stopping = () => stoppingSince !== undefined

/** `work`, or nothing once `ms` have passed. */
const capped = async (work: Promise<unknown>, ms: number) => {
  await Promise.race([work.catch(() => undefined), Bun.sleep(ms)])
}

const stop = async (server: Server<unknown>, signal: "SIGTERM" | "SIGINT") => {
  const code = signal === "SIGTERM" ? 143 : 130
  const began = Date.now()
  const step = (what: string) => say("info", `shutdown: ${what}`, { ms: Date.now() - began })

  setTimeout(() => {
    step("past its deadline; exiting")
    process.exit(code)
  }, DEADLINE_MS)

  stoppingSince = began

  // Runs waiting in line for a sandbox are refused now, before they start, so their requests answer (a webhook 503 with
  // Retry-After) while this process still serves, rather than waiting on objects that are about to stop.
  closeLine()

  await Bun.sleep(UNHEALTHY_FIRST_MS)

  // No new connections (a proxy in front retries them on the process that serves next); the requests in flight finish, up to
  // DRAIN_MS. Then what's left is cut: pages' sockets (a graceful stop never returns while one is open; the page reconnects) and
  // requests past the cap.
  void server.stop(false)

  for (let waited = 0; waited < DRAIN_MS && server.pendingRequests > 0; waited += 50) {
    // oxlint-disable-next-line no-await-in-loop -- waiting for the requests in flight
    await Bun.sleep(50)
  }

  const cut = server.pendingRequests

  await capped(server.stop(true), 200)
  step(`stopped taking requests (${cut} cut)`)

  // The objects this process holds go to sleep, each finishing what it was doing (actor.ts); their files are closed, so the next
  // process to serve this data opens them whole.
  const awake = awakeHere().size

  await capped(stopHost(), 6000)
  step(`stopped ${awake} objects (${awakeHere().size} still awake)`)
  endSandboxes()
  await capped(stopExport(), 1000)
  step("done; exiting")
  process.exit(code)
}

/** Stop in order on SIGTERM or SIGINT (a second one exits at once). */
export const stopOnSignals = (server: Server<unknown>) => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping()) process.exit(signal === "SIGTERM" ? 143 : 130)

      void stop(server, signal)
    })
  }
}
