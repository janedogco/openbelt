// How long a page took to load where it was opened, which the server's own spans can't say: a page whose every request the
// platform answered in 5 ms took 7 s on a phone, lost in sign-in redirects and in each file waiting for the one before it. Every
// OpenBelt page and app page reports its load once (TIMING_JS, POST /_timing), and it becomes a trace of its own: the page, then
// each file it fetched with its redirects, DNS, connect, TLS, wait and download, each linked to the request's server trace
// (Server-Timing: traceparent on every answer, serve.ts).
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import { recordSpan } from "./runtime/observe.ts"

/** Sent once per page: after load, when no new file has started for a second (15 s at most), or when the page is left first. */
export const TIMING_JS = String.raw`() => {
  if (window.__openbeltTiming || !window.performance || !performance.getEntriesByType || !window.fetch) return;
  window.__openbeltTiming = true;
  let hidden = document.visibilityState !== "visible";
  addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") hidden = true; });
  const ms = (n) => Math.max(0, Math.round((n || 0) * 10) / 10);
  const named = (url) => { const u = String(url).split(/[?#]/)[0]; return u.startsWith(location.origin) ? u.slice(location.origin.length) || "/" : u; };
  const traced = (e) => { const s = (e.serverTiming || []).find((t) => t.name === "traceparent"); return s ? s.description.slice(0, 60) : undefined; };
  const entry = (e) => ({ name: named(e.name).slice(0, 300), kind: String(e.initiatorType || "navigation").slice(0, 30), protocol: e.nextHopProtocol ? String(e.nextHopProtocol).slice(0, 20) : undefined,
    at: [e.startTime, e.redirectStart, e.redirectEnd, e.fetchStart, e.domainLookupStart, e.domainLookupEnd, e.connectStart, e.secureConnectionStart, e.connectEnd, e.requestStart, e.responseStart, e.responseEnd].map(ms),
    bytes: typeof e.transferSize === "number" ? e.transferSize : undefined, trace: traced(e) });
  let sent = false;
  const send = () => {
    const nav = performance.getEntriesByType("navigation")[0];
    if (sent || !nav) return;
    sent = true;
    const c = navigator.connection || {};
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    const body = { now: ms(performance.now()), page: named(location.href).slice(0, 300), hidden: hidden,
      nav: Object.assign(entry(nav), { type: String(nav.type).slice(0, 20), redirects: nav.redirectCount || 0, interactive: ms(nav.domInteractive), ready: ms(nav.domContentLoadedEventEnd), loaded: ms(nav.loadEventEnd), paint: paint ? ms(paint.startTime) : undefined }),
      resources: performance.getEntriesByType("resource").slice(0, 150).map(entry),
      connection: typeof c.effectiveType === "string" ? c.effectiveType.slice(0, 10) : undefined, rtt: typeof c.rtt === "number" ? c.rtt : undefined, downlink: typeof c.downlink === "number" ? c.downlink : undefined };
    try { fetch("/_timing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true, credentials: "same-origin" }).catch(() => {}); } catch (e) {}
  };
  let seen = -1, still = 0, waited = 0;
  const settle = () => {
    const now = performance.getEntriesByType("resource").length;
    still = now === seen ? still + 1 : 0;
    seen = now;
    waited += 500;
    if (still >= 2 || waited >= 15000) send(); else setTimeout(settle, 500);
  };
  const start = () => setTimeout(settle, 500);
  if (document.readyState === "complete") start(); else addEventListener("load", start, { once: true });
  addEventListener("pagehide", send, { once: true });
}`
  .split("\n")
  .map((line) => line.trim())
  .join(" ")

/** A page's report is at most this large. */
export const TIMING_BYTES = 64_000

/** ms since the page began (its time origin); 0 is "didn't happen" (or a cross-origin file's hidden phase). */
const Ms = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 }))

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))

const Entry = Schema.Struct({
  name: Text(300),
  kind: Text(30),
  protocol: Schema.optionalKey(Text(20)),
  /** start, redirectStart, redirectEnd, fetchStart, dnsStart, dnsEnd, connectStart, tlsStart, connectEnd, requestStart, responseStart, responseEnd */
  at: Schema.Tuple([Ms, Ms, Ms, Ms, Ms, Ms, Ms, Ms, Ms, Ms, Ms, Ms]),
  bytes: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1e12 }))),
  /** The server's traceparent for it (00-<trace>-<span>-01), from Server-Timing. */
  trace: Schema.optionalKey(Text(60)),
})

type Entry = typeof Entry.Type

export const PageTiming = Schema.Struct({
  /** When it was sent: the page's clock is mapped onto this server's by it, so a phone's wrong clock doesn't matter. */
  now: Ms,
  page: Text(300),
  /** The page was hidden at some point before it reported: a hidden tab's timers and loads are slowed on purpose. */
  hidden: Schema.Boolean,
  nav: Schema.Struct({
    ...Entry.fields,
    type: Text(20),
    redirects: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    interactive: Ms,
    ready: Ms,
    loaded: Ms,
    paint: Schema.optionalKey(Ms),
  }),
  resources: Schema.Array(Entry).check(Schema.isMaxLength(150)),
  connection: Schema.optionalKey(Text(10)),
  rtt: Schema.optionalKey(Ms),
  downlink: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1e6 }))),
})

type PageTiming = typeof PageTiming.Type

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

const round = (ms: number) => String(Math.round(ms))

const text = (value: number | string | undefined) =>
  value === undefined ? undefined : String(value)

const PHASES = ["redirects", "dns", "connect", "tls", "stalled", "waiting", "download"] as const

/**
 * One file's span under the page's (`at` maps the page's ms onto this server's clock): its phases as children, those the browser
 * timed (a cross-origin file without Timing-Allow-Origin has only its start and end), and a link to the server's trace for it.
 */
const fileSpan = (parent: Tracer.Span, name: string, e: Entry, at: (ms: number) => number) => {
  const [
    start,
    ,
    redirectEnd,
    fetchStart,
    dnsStart,
    dnsEnd,
    connectStart,
    tlsStart,
    connectEnd,
    requestStart,
    responseStart,
    responseEnd,
  ] = e.at

  const server = TRACEPARENT.exec(e.trace ?? "")
  const end = Math.max(start, responseEnd)

  const span = recordSpan({
    name,
    parent,
    start: at(start),
    end: at(end),
    attributes: {
      "openbelt.browser.ms": round(end - start),
      "openbelt.browser.protocol": e.protocol,
      "openbelt.browser.bytes": text(e.bytes),
      "openbelt.browser.cached": e.bytes === 0 && requestStart > 0 ? "true" : undefined,
      "openbelt.server.trace": server?.[1],
    },
    links:
      server === null
        ? []
        : [
            {
              span: Tracer.externalSpan({ traceId: server[1] ?? "", spanId: server[2] ?? "" }),
              attributes: { "openbelt.link": "server" },
            },
          ],
  })

  // A file the browser didn't time (cross-origin, or from its cache before asking) has no phases.
  if (requestStart === 0) return span

  const spans = {
    // Before its own request: redirects (cross-origin ones the browser times only as this gap) and, for a page, unloading the one before.
    redirects: [start, redirectEnd > 0 ? redirectEnd : fetchStart],
    dns: [dnsStart, dnsEnd],
    connect: [connectStart, tlsStart > 0 ? tlsStart : connectEnd],
    tls: [tlsStart, connectEnd],
    stalled: [connectEnd, requestStart],
    waiting: [requestStart, responseStart],
    download: [responseStart, responseEnd],
  } as const

  for (const phase of PHASES) {
    const [from, to] = spans[phase]

    if ((from > 0 || phase === "redirects") && to - from >= 1)
      recordSpan({ name: phase, parent: span, start: at(from), end: at(to) })
  }

  return span
}

/**
 * A page's report as a trace of its own, named for the page, with what the browser said about its connection and who opened it;
 * returns the trace and how long the page took (until load, or its last file, whichever was later).
 */
export const recordPageTiming = (
  timing: PageTiming,
  about: {
    readonly host: string
    readonly agent: string
    readonly person: string
    readonly received: number
  },
) => {
  const at = (ms: number) => about.received - timing.now + ms
  const ends = [timing.nav.loaded, timing.nav.at[11], ...timing.resources.map((r) => r.at[11])]
  const total = Math.min(Math.max(...ends), timing.now)
  const page = `${about.host}${timing.page}`

  const marks: ReadonlyArray<readonly [string, number]> = [
    ["first contentful paint", timing.nav.paint ?? 0],
    ["interactive", timing.nav.interactive],
    ["DOMContentLoaded", timing.nav.ready],
    ["load", timing.nav.loaded],
  ]

  const root = recordSpan({
    name: `page ${page}`,
    start: at(0),
    end: at(total),
    attributes: {
      "openbelt.browser.page": page,
      "openbelt.browser.ms": round(total),
      "openbelt.browser.agent": about.agent.slice(0, 300),
      "openbelt.browser.navigation": timing.nav.type,
      "openbelt.browser.redirects": String(timing.nav.redirects),
      "openbelt.browser.hidden": String(timing.hidden),
      "openbelt.browser.files": String(timing.resources.length),
      "openbelt.person": about.person === "" ? undefined : about.person,
      "openbelt.browser.connection": timing.connection,
      "openbelt.browser.rtt": text(timing.rtt),
      "openbelt.browser.downlink": text(timing.downlink),
      "openbelt.browser.protocol": timing.nav.protocol,
    },
    events: marks.flatMap(([mark, ms]) => (ms > 0 ? [[mark, at(ms)] as const] : [])),
  })

  fileSpan(root, `document ${timing.nav.name}`, timing.nav, at)

  for (const file of timing.resources) fileSpan(root, `${file.kind} ${file.name}`, file, at)

  return { trace: root.traceId, span: root, ms: total, page }
}
