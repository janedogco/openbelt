// zone. Each is a durable callback on the app's AppDO (makeCallback: a job in SQLite, run
import * as Runtime from "./runtime/index.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { nextRun } from "./cron.ts"
import { type AppConfig, type Json, type LogLine, newTrace, type ScheduleView } from "./model.ts"

type Schedules = NonNullable<AppConfig["schedules"]>

export type Wanted =
  | { readonly kind: "read"; readonly schedules: Schedules }
  | { readonly kind: "unreadable"; readonly problem: string }

type Outcome = {
  readonly ok: boolean
  readonly ms: number
  readonly error: string | null
}

type Hooks = {
  readonly log: (level: LogLine["level"], trace: string, message: string) => Effect.Effect<void>
  readonly wanted: () => Effect.Effect<Wanted>
  readonly run: (
    fn: string,
    input: Json,
    trace: string,
    due: {
      readonly scheduledFor: string
      readonly lastOkAt: string | null
      readonly manual: boolean
    },
    key: string,
  ) => Effect.Effect<Outcome>
}

type Row = {
  fn: string
  cron: string
  timezone: string
  next_at: number
  last_at: string | null
  last_ok: number | null
  last_ms: number | null
  last_error: string | null
  last_trace: string | null
}

const Due = Schema.Struct({ fn: Schema.String })

const decodeDue = Schema.decodeUnknownOption(Due)

const iso = (ms: number) => new Date(ms).toISOString()

const lastOkKey = (fn: string) => `schedules:lastok:${fn}`

/**
 * How far past its cron time a schedule may run. Every app's every-minute schedule fired in the same second, and 500 of them with
 * steady traffic stalled the engine's storage within minutes: each runs instead at a stable offset of up to a minute past its time
 * (the same offset every time, from the app and the function), so they arrive spread over the minute.
 */
const SPREAD_MS = 60_000

/** FNV-1a of `app:fn`, as an offset in [0, SPREAD_MS). */
const offsetOf = (app: string, fn: string) => {
  let hash = 0x811c9dc5

  for (const c of `${app}:${fn}`) hash = Math.imul(hash ^ (c.codePointAt(0) ?? 0), 0x01000193) >>> 0

  return hash % SPREAD_MS
}

export const openSchedules = Effect.fn("Schedules.open")(function* (
  storage: DurableObjectStorage,
  app: string,
  hooks: Hooks,
) {
  const { sql, kv } = storage

  /** The first run of `fn` after now: its cron's next time after now less its offset, plus the offset. */
  const nextAt = (fn: string, cron: string, timezone: string) => {
    const offset = offsetOf(app, fn)

    return nextRun(cron, timezone, new Date(Date.now() - offset)).getTime() + offset
  }

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS schedules (
    fn TEXT PRIMARY KEY, cron TEXT NOT NULL, timezone TEXT NOT NULL, next_at INTEGER NOT NULL,
    last_at TEXT, last_ok INTEGER, last_ms INTEGER, last_error TEXT, last_trace TEXT)`)

  const rows = Effect.fnUntraced(function* () {
    return yield* (yield* sql.exec<Row>("SELECT * FROM schedules ORDER BY fn")).toArray()
  })

  const row = Effect.fnUntraced(function* (fn: string) {
    const [found] = yield* (yield* sql.exec<Row>(
      "SELECT * FROM schedules WHERE fn = ?",
      fn,
    )).toArray()

    return found
  })

  const fire = Effect.fn("Schedules.fire")(function* (payload: Json) {
    const due = decodeDue(payload)

    if (Option.isNone(due)) return

    const { fn } = due.value
    const current = yield* row(fn)
    const live = yield* hooks.wanted()

    if (live.kind === "unreadable") {
      if (current === undefined) return

      const next = nextAt(fn, current.cron, current.timezone)
      const trace = newTrace()

      yield* sql.exec("UPDATE schedules SET next_at = ? WHERE fn = ?", next, fn)
      yield* book(fn, next)
      yield* hooks.log("error", trace, `schedule ${fn} didn't run: ${live.problem}`)

      return
    }

    const wanted = live.schedules[fn]

    if (current === undefined || wanted === undefined) return

    if (Date.now() < current.next_at - 1000) {
      yield* book(fn, current.next_at)

      return
    }

    const trace = newTrace()
    const started = Date.now()

    const outcome = yield* hooks.run(
      fn,
      wanted.input ?? null,
      trace,
      {
        scheduledFor: iso(current.next_at),
        lastOkAt: kv.get<string>(lastOkKey(fn)) ?? null,
        manual: false,
      },
      `schedule:${current.next_at}`,
    )

    const how = outcome.ok ? "ran" : `failed: ${outcome.error ?? ""}`

    if (outcome.ok) kv.put(lastOkKey(fn), iso(started))

    yield* sql.exec(
      "UPDATE schedules SET last_at = ?, last_ok = ?, last_ms = ?, last_error = ?, last_trace = ? WHERE fn = ?",
      iso(started),
      outcome.ok ? 1 : 0,
      outcome.ms,
      outcome.error,
      trace,
      fn,
    )

    const after = yield* row(fn)

    if (after === undefined || after.cron !== current.cron || after.timezone !== current.timezone) {
      yield* hooks.log(outcome.ok ? "info" : "error", trace, `schedule ${fn} ${how}`)

      return
    }

    const next = nextAt(fn, after.cron, after.timezone)

    yield* sql.exec("UPDATE schedules SET next_at = ? WHERE fn = ?", next, fn)
    yield* book(fn, next)
    yield* hooks.log(
      outcome.ok ? "info" : "error",
      trace,
      `schedule ${fn} (${after.cron} ${after.timezone}) ${how}; next run ${iso(next)}`,
    )
  })

  /**
   * A run that died after its function ran (a defect, not the function failing) still books its
   * next time: the job would otherwise be retried, and run the function again, every few minutes.
   */
  const fireOnce = (payload: Json) =>
    fire(payload).pipe(
      Effect.catchDefect((defect) =>
        Effect.gen(function* () {
          const due = decodeDue(payload)
          const current = Option.isNone(due) ? undefined : yield* row(due.value.fn)

          yield* Effect.logError("a schedule's run failed inside the platform", defect)

          if (current === undefined) return

          const next = nextAt(current.fn, current.cron, current.timezone)

          yield* sql.exec("UPDATE schedules SET next_at = ? WHERE fn = ?", next, current.fn)
          yield* book(current.fn, next)
        }),
      ),
    )

  const job = yield* Runtime.makeCallback("schedule", fireOnce, { retry: { delay: "2 minutes" } })

  const book = (fn: string, at: number): Effect.Effect<void> =>
    job.schedule(fn, { at, payload: { fn } }).pipe(Effect.orDie)

  const sync = Effect.fn("Schedules.sync")(function* (trace: string) {
    const live = yield* hooks.wanted()

    if (live.kind === "unreadable") {
      const kept = yield* rows()

      for (const r of kept) yield* book(r.fn, r.next_at)

      if (kept.length > 0) {
        yield* hooks.log(
          "warn",
          trace,
          `schedules ${kept.map((r) => r.fn).join(", ")} kept as they were: ${live.problem}`,
        )
      }

      return
    }

    const wanted = live.schedules
    const had = new Map((yield* rows()).map((r) => [r.fn, r]))

    for (const [fn, schedule] of Object.entries(wanted)) {
      const timezone = schedule.timezone ?? "UTC"
      const before = had.get(fn)

      had.delete(fn)

      if (before !== undefined && before.cron === schedule.cron && before.timezone === timezone) {
        yield* book(fn, before.next_at)
        continue
      }

      const next = nextAt(fn, schedule.cron, timezone)

      yield* sql.exec(
        `INSERT INTO schedules (fn, cron, timezone, next_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (fn) DO UPDATE SET cron = excluded.cron, timezone = excluded.timezone,
             next_at = excluded.next_at`,
        fn,
        schedule.cron,
        timezone,
        next,
      )

      yield* book(fn, next)
      yield* hooks.log(
        "info",
        trace,
        `schedule ${fn}: ${schedule.cron} ${timezone}, next run ${iso(next)}`,
      )
    }

    for (const fn of had.keys()) {
      yield* sql.exec("DELETE FROM schedules WHERE fn = ?", fn)
      yield* job.cancel(fn).pipe(Effect.orDie)
      yield* hooks.log("info", trace, `schedule ${fn} removed: the live openbelt.json has none`)
    }
  })

  yield* sync(newTrace())

  return {
    sync,

    manual: (fn: string) => ({
      scheduledFor: new Date().toISOString(),
      lastOkAt: kv.get<string>(lastOkKey(fn)) ?? null,
      manual: true,
    }),

    ranOk: (fn: string, at: string) => kv.put(lastOkKey(fn), at),

    list: Effect.fnUntraced(function* () {
      return (yield* rows()).map((r): ScheduleView => ({
        function: r.fn,
        cron: r.cron,
        timezone: r.timezone,
        next: iso(r.next_at),
        last:
          r.last_at === null || r.last_trace === null
            ? null
            : {
                at: r.last_at,
                ok: r.last_ok === 1,
                ms: r.last_ms ?? 0,
                error: r.last_error,
                trace: r.last_trace,
              },
      }))
    }),
  }
})
