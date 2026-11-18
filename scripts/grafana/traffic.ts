// Made-up use of a running OpenBelt, so its Grafana dashboards have something to show (bun run grafana traffic): a few people, one
// app ("traffic") whose functions are fast, slow, sometimes failing, scheduled, and calling a fake service outside (served here,
// slow now and then, failing now and then); agents calling them over MCP, pages loading, and some requests that are refused.
// The load comes in waves. It deploys the app into the workspace it's pointed at; run it against a dev or lab platform, not one people use.
/* oxlint-disable no-await-in-loop -- each worker sends one request at a time, in order */
import { Schema } from "effect"
import { connect, type Json } from "../verify/drive/mcp.ts"
import { appOrigin } from "../../packages/platform/src/hosts.ts"

/** What /_admin/tokens answers (docs/mcp.md). */
const Minted = Schema.Struct({ token: Schema.String })

const PEOPLE = ["ada@example.com", "grace@example.com", "linus@example.com", "margaret@example.com"]

/** The fake service the app's `outside` function calls: answers in 20 to 400 ms, a 503 one time in eight. */
const fakeService = () =>
  Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(20 + Math.random() * 380)

      return Math.random() < 0.125
        ? new Response("busy", { status: 503 })
        : Response.json({ price: Math.round(Math.random() * 10_000) / 100 })
    },
  })

const app = (outside: string) => [
  {
    path: "index.html",
    content: `<!doctype html><title>traffic</title><h1>orders</h1><script type="module">
import { db } from "/sdk.js"
db.collection("orders").watch((docs) => (document.querySelector("h1").textContent = docs.length + " orders"))
</script>`,
  },
  {
    path: "openbelt.json",
    content: JSON.stringify({
      description: "Made-up orders, for Grafana's dashboards (bun run grafana traffic)",
      functions: {
        place: "places an order: input { item, cents }",
        report: "a slow report over the orders",
        flaky: "fails about one time in five",
        outside: "asks the fake price service outside",
        tick: "runs every minute",
      },
      network: [outside],
      schedules: { tick: { cron: "* * * * *" } },
    }),
  },
  {
    path: "functions/place.js",
    content:
      "export default async (input, { db }) => { const o = await db.collection('orders').add(input ?? {}); console.log('placed', o.id); return o.id }",
  },
  {
    path: "functions/report.js",
    content:
      "export default async (input, { db }) => { const until = Date.now() + 200 + Math.random() * 900; let n = 0; while (Date.now() < until) n++; const page = await db.collection('orders').list({ limit: 50 }); return { orders: page.docs.length, spins: n } }",
  },
  {
    path: "functions/flaky.js",
    content:
      "export default async () => { if (Math.random() < 0.2) { console.warn('flaky: the dice said no'); throw new Error('flaky failed on purpose') } return 'ok' }",
  },
  {
    path: "functions/outside.js",
    content: `export default async () => { const r = await fetch('http://${outside}/price'); if (!r.ok) { console.error('price service answered', r.status); throw new Error('price service ' + r.status) } return r.json() }`,
  },
  {
    path: "functions/tick.js",
    content:
      "export default async (input, { db }) => { await db.collection('ticks').add({ at: Date.now() }); return 'tick' }",
  },
]

/** An agent's call to one of the app's functions. */
const fn = (name: string, input: Json) => ({
  tool: "call_function",
  args: { app: "traffic", function: name, input },
})

/** How busy it is at `t` ms in: waves a few minutes long, between about a quarter and all of the workers. */
const busy = (t: number) => 0.6 + 0.4 * Math.sin(t / 45_000)

export const traffic = async (url: string, admin: string, minutes: number) => {
  const service = fakeService()

  const outside = `localhost:${service.port}`

  const mint = async (email: string) => {
    const response = await fetch(`${url}/_admin/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })

    if (!response.ok)
      throw new Error(`minting a token for ${email}: ${response.status} ${await response.text()}`)

    return Schema.decodeUnknownSync(Minted)(await response.json()).token
  }

  const sessions = await Promise.all(
    PEOPLE.map(async (email) => ({ email, mcp: await connect(`${url}/mcp`, await mint(email)) })),
  )

  const deployed = await sessions[0]?.mcp.call("deploy_app", {
    app: "traffic",
    files: app(outside),
  })

  if (deployed === undefined || deployed.isError)
    throw new Error(`deploy_app traffic: ${deployed?.text}`)

  const page = appOrigin(url, "traffic")

  const started = Date.now()

  const until = started + minutes * 60_000

  const counts = { calls: 0, failed: 0 }

  // What one step does: an agent's MCP call (some refused: no such function), or a page and its SDK loading, or a missing page.
  const steps: ReadonlyArray<
    | { readonly tool: string; readonly args: Readonly<Record<string, Json>> }
    | { readonly get: string }
  > = [
    fn("place", { item: "tea", cents: 450 }),
    fn("place", { item: "cake", cents: 650 }),
    fn("flaky", null),
    fn("outside", null),
    fn("report", null),
    fn("nope", null),
    { tool: "search", args: { query: "traffic" } },
    { get: `${page}/` },
    { get: `${page}/sdk.js` },
    { get: `${url}/no-such-page` },
  ]

  const send = async (session: (typeof sessions)[number], step: (typeof steps)[number]) => {
    if ("get" in step) await (await fetch(step.get)).arrayBuffer()
    else await session.mcp.call(step.tool, step.args)
  }

  const worker = async (n: number) => {
    const session = sessions[n % sessions.length]

    if (session === undefined) return

    while (Date.now() < until) {
      // The wave decides whether this worker sends now or rests.
      if (Math.random() > busy(Date.now() - started) * (n < 3 ? 1 : 0.5)) {
        await Bun.sleep(400)
        continue
      }

      const step = steps[Math.floor(Math.random() * steps.length)]

      try {
        if (step !== undefined) await send(session, step)
        counts.calls++
      } catch {
        counts.failed++
      }

      await Bun.sleep(50 + Math.random() * 250)
    }
  }

  const progress = setInterval(
    () =>
      console.log(
        `traffic: ${Math.round((Date.now() - started) / 1000)} s, ${counts.calls} calls, ${counts.failed} failed to send`,
      ),
    15_000,
  )

  console.log(
    `traffic: ${minutes} min against ${url}, app "traffic" at ${page}; the fake service outside is ${outside}`,
  )

  await Promise.all(Array.from({ length: 6 }, (_, n) => worker(n)))

  clearInterval(progress)
  await service.stop(true)
  console.log(`traffic: done, ${counts.calls} calls`)
}
