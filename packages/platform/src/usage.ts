// How much an app is used, kept in its own object (AppDO): who opened its pages each day, and how many of its functions ran. Opens are
// counted in memory and written at most once a second (and when the object sleeps or the panel asks), so a page costs no write of its
// own: one write per open cost a 32-client load 4% of its pages a second, and a single client 14%. Days are UTC days.
//
// A person is counted by their email, for 90 days. Someone on the public host has no identity: they are a hash of their address with
// the day and a salt only this app keeps, so their visits on different days can't be joined, and the row goes once the day is over.
// Each day's totals stay 90 days, so a viral public app reads ~90 rows, never one per visitor (3 million rows took 0.8 s).
import * as Effect from "effect/Effect"
import type { DurableObjectStorage } from "./runtime/index.ts"

/** How long a person's opens, the daily totals and the sources stay. */
const KEEP_DAYS = 90

/** The most sources (hosts of the pages that linked to the public page) kept for one day; the rest count as "other". */
const SOURCES_A_DAY = 20

/** The most people the panel lists. */
const PEOPLE_SHOWN = 50

/** How often buffered opens are written while pages keep opening. */
const FLUSH_MS = 1000

/** Rows a multi-row INSERT carries at once (3 bindings each, well under SQLite's limit). */
const CHUNK = 200

/** Who opened a page: a signed-in person, or someone on the public host. */
export type Opener =
  | { readonly kind: "person"; readonly email: string; readonly name: string }
  | {
      readonly kind: "public"
      readonly address: string
      readonly agent: string
      /** The host of the page that linked here ("direct": none), or undefined for a link from the app's own pages. */
      readonly source: string | undefined
    }

type UsageWindow = {
  /** People who opened it (each counted once). */
  readonly people: number
  /** Pages opened, by people and on the public host. */
  readonly opens: number
  /** Visitors on the public host, each counted once a day. */
  readonly visitors: number
  /** Its functions' runs on live data, and how many of them failed. */
  readonly runs: number
  readonly failed: number
}

type UsageStats = {
  /** The last 7, 30 and 90 days, today included. */
  readonly windows: Readonly<Record<"7" | "30" | "90", UsageWindow>>
  /** The 7 and 30 days before those. */
  readonly before: Readonly<Record<"7" | "30", UsageWindow>>
  /** One row per day that had any use, oldest first, the last 90 days. */
  readonly days: ReadonlyArray<{
    readonly day: string
    readonly people: number
    readonly opens: number
    readonly visitors: number
  }>
  /** The people who opened it most in 90 days, each with their opens in each window and their last open. */
  readonly people: ReadonlyArray<{
    readonly email: string
    readonly name: string
    readonly opens: Readonly<Record<"7" | "30" | "90", number>>
    readonly last: string
  }>
  /** Where the public page's visitors came from on their first open of a day ("direct", a host, or "other"), in each window. */
  readonly sources: ReadonlyArray<{
    readonly source: string
    readonly visitors: Readonly<Record<"7" | "30" | "90", number>>
  }>
  /** When a person last opened it (a time), or a visitor (a day), or null. */
  readonly lastOpened: string | null
}

/** What app_info tells an agent: the day it was last opened, not the time, since any member reads it. */
type UsageSummary = {
  readonly last7: UsageWindow
  readonly last30: UsageWindow
  readonly lastOpened: string | null
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const daysBefore = (day: string, n: number) =>
  dayOf(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000)

/** Link checkers and crawlers on the public host, which aren't visitors. */
const ROBOT = /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|httpclient|headless|monitor/i

/** A host a source may be: a DNS name with a dot, not one of the panel's own words. */
const HOST = /^(?=.{4,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/

const hex = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("hex")

export const openUsage = Effect.fn("Usage.open")(function* (storage: DurableObjectStorage) {
  const { sql, kv } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS usage_days (
    day TEXT PRIMARY KEY, opens INTEGER NOT NULL DEFAULT 0, people INTEGER NOT NULL DEFAULT 0,
    visitors INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0)`)
  // who: "p:<email>" for a person, "v:<hash>" for a visitor on the public host (only today's).
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS usage_openers (
    day TEXT NOT NULL, who TEXT NOT NULL, opens INTEGER NOT NULL, PRIMARY KEY (day, who)) WITHOUT ROWID`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS usage_people (
    email TEXT PRIMARY KEY, name TEXT NOT NULL, last TEXT NOT NULL)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS usage_sources (
    day TEXT NOT NULL, source TEXT NOT NULL, opens INTEGER NOT NULL, PRIMARY KEY (day, source)) WITHOUT ROWID`)

  const salt = (() => {
    const kept = kv.get<string>("usage_salt")

    if (kept !== undefined) return kept

    const made = crypto.randomUUID()

    kv.put("usage_salt", made)

    return made
  })()

  /** Opens not written yet, by day and opener (with a visitor's first source), and people's names. */
  const opens = new Map<
    string,
    { day: string; who: string; n: number; source: string | undefined }
  >()

  const names = new Map<string, { name: string; at: string }>()
  const ran = new Map<string, { runs: number; failed: number }>()
  let flushed = Date.now()
  let trimmed = ""

  /** What's past keeping goes, once a day: a visitor's row the day after, the rest after 90 days. */
  const trim = Effect.fnUntraced(function* () {
    const today = dayOf(Date.now())

    if (trimmed === today) return

    const oldest = daysBefore(today, KEEP_DAYS - 1)

    yield* sql.exec("DELETE FROM usage_days WHERE day < ?", oldest)
    yield* sql.exec("DELETE FROM usage_sources WHERE day < ?", oldest)
    yield* sql.exec("DELETE FROM usage_openers WHERE day < ?", oldest)
    yield* sql.exec("DELETE FROM usage_openers WHERE day < ? AND who LIKE 'v:%'", today)
    yield* sql.exec("DELETE FROM usage_people WHERE last < ?", oldest)
    trimmed = today
  })

  const write = Effect.fnUntraced(function* () {
    const opened = [...opens.values()]
    const named = [...names]
    const runs = [...ran]

    opens.clear()
    names.clear()
    ran.clear()

    const totals = new Map<string, { opens: number; people: number; visitors: number }>()
    const linked = new Map<string, { day: string; source: string; n: number }>()

    const total = (day: string) => {
      const t = totals.get(day) ?? { opens: 0, people: 0, visitors: 0 }

      totals.set(day, t)

      return t
    }

    for (let i = 0; i < opened.length; i += CHUNK) {
      const chunk = opened.slice(i, i + CHUNK)
      const added = new Map(chunk.map((o) => [`${o.day}\n${o.who}`, o]))

      const rows = yield* (yield* sql.exec<{ day: string; who: string; opens: number }>(
        `INSERT INTO usage_openers (day, who, opens) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}
         ON CONFLICT (day, who) DO UPDATE SET opens = opens + excluded.opens
         RETURNING day, who, opens`,
        ...chunk.flatMap((o) => [o.day, o.who, o.n]),
      )).toArray()

      for (const o of chunk) total(o.day).opens += o.n

      // A row holds only what this write adds when it's new: the opener's first open that day.
      for (const row of rows) {
        const o = added.get(`${row.day}\n${row.who}`)

        if (o === undefined || row.opens !== o.n) continue

        if (row.who.startsWith("p:")) total(row.day).people += 1
        else total(row.day).visitors += 1

        if (o.source === undefined) continue

        const key = `${o.day}\n${o.source}`

        linked.set(key, { day: o.day, source: o.source, n: (linked.get(key)?.n ?? 0) + 1 })
      }
    }

    for (const [day, r] of runs)
      yield* sql.exec(
        `INSERT INTO usage_days (day, runs, failed) VALUES (?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET runs = runs + excluded.runs, failed = failed + excluded.failed`,
        day,
        r.runs,
        r.failed,
      )

    for (const [day, t] of totals)
      yield* sql.exec(
        `INSERT INTO usage_days (day, opens, people, visitors) VALUES (?, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET opens = opens + excluded.opens, people = people + excluded.people,
           visitors = visitors + excluded.visitors`,
        day,
        t.opens,
        t.people,
        t.visitors,
      )

    for (let i = 0; i < named.length; i += CHUNK) {
      const chunk = named.slice(i, i + CHUNK)

      yield* sql.exec(
        `INSERT INTO usage_people (email, name, last) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}
         ON CONFLICT (email) DO UPDATE SET name = excluded.name, last = MAX(last, excluded.last)`,
        ...chunk.flatMap(([email, p]) => [email, p.name, p.at]),
      )
    }

    for (const s of linked.values()) {
      const [kept] = yield* (yield* sql.exec<{ n: number; has: number }>(
        "SELECT COUNT(*) AS n, MAX(source = ?) AS has FROM usage_sources WHERE day = ?",
        s.source,
        s.day,
      )).toArray()

      const source =
        kept !== undefined && kept.has !== 1 && kept.n >= SOURCES_A_DAY ? "other" : s.source

      yield* sql.exec(
        `INSERT INTO usage_sources (day, source, opens) VALUES (?, ?, ?)
         ON CONFLICT (day, source) DO UPDATE SET opens = opens + excluded.opens`,
        s.day,
        source,
        s.n,
      )
    }
  })

  /**
   * Write what's buffered, in one transaction, and trim. Counting never fails a page, a run or the panel: a write that fails loses its
   * opens and says so.
   */
  const flush = Effect.fnUntraced(function* () {
    flushed = Date.now()

    const writing = opens.size > 0 || ran.size > 0 || names.size > 0

    yield* storage
      .transaction(writing ? Effect.andThen(write(), trim()) : trim())
      .pipe(Effect.catchCause((cause) => Effect.logWarning("usage: opens weren't saved", cause)))
  })

  const flushSoon = () => (Date.now() - flushed >= FLUSH_MS ? flush() : Effect.void)

  /** Someone opened one of the app's pages (its live version). */
  const opened = Effect.fnUntraced(function* (opener: Opener) {
    const now = Date.now()
    const day = dayOf(now)

    if (opener.kind === "public" && ROBOT.test(opener.agent)) return

    // A visitor is their address that day: one browser changing its user agent is still one visitor.
    const who =
      opener.kind === "person"
        ? `p:${opener.email}`
        : `v:${hex(
            yield* Effect.promise(() =>
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`${salt}\n${day}\n${opener.address}`),
              ),
            ),
          ).slice(0, 24)}`

    const key = `${day}\n${who}`
    const before = opens.get(key)

    const source =
      opener.kind === "public" && opener.source !== undefined
        ? opener.source === "direct" || HOST.test(opener.source)
          ? opener.source
          : "direct"
        : undefined

    opens.set(key, { day, who, n: (before?.n ?? 0) + 1, source: before?.source ?? source })

    if (opener.kind === "person")
      names.set(opener.email, { name: opener.name, at: new Date(now).toISOString() })

    yield* flushSoon()
  })

  /** One of its functions ran on live data. */
  const ranOnce = Effect.fnUntraced(function* (ok: boolean) {
    const day = dayOf(Date.now())
    const r = ran.get(day) ?? { runs: 0, failed: 0 }

    ran.set(day, { runs: r.runs + 1, failed: r.failed + (ok ? 0 : 1) })

    yield* flushSoon()
  })

  const windowOf = Effect.fnUntraced(function* (from: string, to: string) {
    const [days] = yield* (yield* sql.exec<{
      opens: number | null
      visitors: number | null
      runs: number | null
      failed: number | null
    }>(
      "SELECT SUM(opens) AS opens, SUM(visitors) AS visitors, SUM(runs) AS runs, SUM(failed) AS failed FROM usage_days WHERE day >= ? AND day <= ?",
      from,
      to,
    )).toArray()

    const [people] = yield* (yield* sql.exec<{ n: number }>(
      "SELECT COUNT(DISTINCT who) AS n FROM usage_openers WHERE day >= ? AND day <= ? AND who LIKE 'p:%'",
      from,
      to,
    )).toArray()

    return {
      people: people?.n ?? 0,
      opens: days?.opens ?? 0,
      visitors: days?.visitors ?? 0,
      runs: days?.runs ?? 0,
      failed: days?.failed ?? 0,
    } satisfies UsageWindow
  })

  const lastOpened = Effect.fnUntraced(function* () {
    const [row] = yield* (yield* sql.exec<{ day: string | null }>(
      "SELECT MAX(day) AS day FROM usage_days WHERE opens > 0",
    )).toArray()

    const [person] = yield* (yield* sql.exec<{ last: string | null }>(
      "SELECT MAX(last) AS last FROM usage_people",
    )).toArray()

    // A person's open has its time; a visitor's only its day.
    if (person?.last != null && (row?.day == null || person.last.slice(0, 10) >= row.day))
      return person.last

    return row?.day ?? null
  })

  // A visitor's row from a day that's over goes as the object wakes, too, not only when it's next used.
  yield* flush()

  return {
    opened,
    ran: ranOnce,
    flush,

    /** What the app's panel shows its owner. */
    stats: Effect.fn("Usage.stats")(function* () {
      yield* flush()

      const today = dayOf(Date.now())
      const from = (n: number) => daysBefore(today, n - 1)

      const windows = {
        "7": yield* windowOf(from(7), today),
        "30": yield* windowOf(from(30), today),
        "90": yield* windowOf(from(90), today),
      }

      const before = {
        "7": yield* windowOf(daysBefore(today, 13), daysBefore(today, 7)),
        "30": yield* windowOf(daysBefore(today, 59), daysBefore(today, 30)),
      }

      const days = yield* (yield* sql.exec<{
        day: string
        people: number
        opens: number
        visitors: number
      }>(
        "SELECT day, people, opens, visitors FROM usage_days WHERE day >= ? AND (opens > 0 OR runs > 0) ORDER BY day",
        from(90),
      )).toArray()

      const people = yield* (yield* sql.exec<{
        email: string
        name: string | null
        last: string | null
        o7: number
        o30: number
        o90: number
      }>(
        `SELECT substr(o.who, 3) AS email, p.name, p.last,
           SUM(CASE WHEN o.day >= ? THEN o.opens ELSE 0 END) AS o7,
           SUM(CASE WHEN o.day >= ? THEN o.opens ELSE 0 END) AS o30,
           SUM(o.opens) AS o90
         FROM usage_openers o LEFT JOIN usage_people p ON p.email = substr(o.who, 3)
         WHERE o.who LIKE 'p:%' AND o.day >= ?
         GROUP BY o.who ORDER BY o90 DESC, p.last DESC LIMIT ?`,
        from(7),
        from(30),
        from(90),
        PEOPLE_SHOWN,
      )).toArray()

      const linked = yield* (yield* sql.exec<{
        source: string
        o7: number
        o30: number
        o90: number
      }>(
        `SELECT source,
           SUM(CASE WHEN day >= ? THEN opens ELSE 0 END) AS o7,
           SUM(CASE WHEN day >= ? THEN opens ELSE 0 END) AS o30,
           SUM(opens) AS o90
         FROM usage_sources WHERE day >= ? GROUP BY source ORDER BY o90 DESC, source LIMIT 10`,
        from(7),
        from(30),
        from(90),
      )).toArray()

      return {
        windows,
        before,
        days,
        people: people.map((p) => ({
          email: p.email,
          name: p.name ?? p.email,
          opens: { "7": p.o7, "30": p.o30, "90": p.o90 },
          last: p.last ?? "",
        })),
        sources: linked.map((s) => ({
          source: s.source,
          visitors: { "7": s.o7, "30": s.o30, "90": s.o90 },
        })),
        lastOpened: yield* lastOpened(),
      } satisfies UsageStats
    }),

    /** What app_info says. */
    summary: Effect.fn("Usage.summary")(function* () {
      yield* flush()

      const today = dayOf(Date.now())

      return {
        last7: yield* windowOf(daysBefore(today, 6), today),
        last30: yield* windowOf(daysBefore(today, 29), today),
        lastOpened: (yield* lastOpened())?.slice(0, 10) ?? null,
      } satisfies UsageSummary
    }),
  }
})
