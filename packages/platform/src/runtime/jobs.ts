// Durable callbacks: work an object books for later ("run this function at 9:00", "take this picture in 10 seconds") that survives
// the object sleeping or the process dying. A job is a row in the object's own database, so booking one joins the transaction that
// decides to; the object's one wake-up is armed for the earliest. Delivery is at least once: a job is leased when it starts (its
// time moves out by the retry delay) and deleted only when its handler succeeds and nobody replaced it meanwhile.
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Scope from "effect/Scope"
import { type RawDb, rowsOf, run } from "./sql.ts"

type CallbackOptions = {
  /** How long after a delivery starts before it is tried again if it hasn't succeeded. Defaults to 30 seconds. */
  readonly retry?: { readonly delay: Duration.Input }
}

export type CallbackSchedule<Payload> = { readonly payload: Payload } & (
  | { readonly at: Date | number; readonly after?: never }
  | { readonly after: Duration.Input; readonly at?: never }
)

export type Callback<Payload> = {
  /** Book a job, or replace the pending one with this id. */
  readonly schedule: (id: string, options: CallbackSchedule<Payload>) => Effect.Effect<void>
  /** Cancel a pending job; absent is fine, and a handler already running is not interrupted. */
  readonly cancel: (id: string) => Effect.Effect<void>
  /** The pending jobs whose id starts with `prefix` (all of them by default), with the payload each was booked with. */
  readonly pending: (
    prefix?: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly payload: string }>>
}

type Handler = {
  readonly run: (payload: unknown) => Effect.Effect<void, unknown>
  readonly retryMs: number
}

const DEFAULT_RETRY_MS = 30_000

/** The object's jobs: what `makeCallback` registers with, and what the actor runs when the object wakes. */
export type JobsApi = {
  readonly register: <Payload>(name: string, handler: Handler) => Callback<Payload>
}

export class Jobs extends Context.Service<Jobs, JobsApi>()("openbelt/Jobs") {}

export type JobBook = {
  readonly jobs: JobsApi
  /** Run every job that is due, one after another; a handler's failure is logged and leaves its job to be retried. */
  readonly dispatch: () => Effect.Effect<void>
  /** When the earliest job is due, in ms since the epoch; null when there is none. A change since the last call: `changed`. */
  readonly next: () => Promise<number | null>
  readonly changed: () => boolean
  readonly settled: () => void
}

const dueAt = (options: CallbackSchedule<unknown>) =>
  options.at !== undefined
    ? Math.max(0, options.at instanceof Date ? options.at.getTime() : options.at)
    : Date.now() + Duration.toMillis(Duration.fromInputUnsafe(options.after))

/** The job table of one object, over its database. */
export const makeJobBook = async (db: RawDb): Promise<JobBook> => {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS __jobs (
      callback TEXT NOT NULL, id TEXT NOT NULL, run_at INTEGER NOT NULL, payload TEXT NOT NULL,
      version INTEGER NOT NULL, PRIMARY KEY (callback, id))`,
  )
  await run(db, "CREATE INDEX IF NOT EXISTS __jobs_by_time ON __jobs (run_at)")

  const handlers = new Map<string, Handler>()
  let dirty = false
  let version = Date.now()

  const jobs: JobsApi = {
    register: <Payload>(name: string, handler: Handler): Callback<Payload> => {
      handlers.set(name, handler)

      return {
        schedule: (id, options) =>
          Effect.promise(async () => {
            await run(
              db,
              `INSERT INTO __jobs (callback, id, run_at, payload, version) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (callback, id) DO UPDATE SET run_at = excluded.run_at,
                 payload = excluded.payload, version = excluded.version`,
              [name, id, dueAt(options), JSON.stringify(options.payload ?? null), ++version],
            )
            dirty = true
          }),
        cancel: (id) =>
          Effect.promise(async () => {
            await run(db, "DELETE FROM __jobs WHERE callback = ? AND id = ?", [name, id])
            dirty = true
          }),
        pending: (prefix = "") =>
          Effect.promise(async () =>
            rowsOf(
              await run(
                db,
                "SELECT id, payload FROM __jobs WHERE callback = ? AND substr(id, 1, ?) = ? ORDER BY id",
                [name, prefix.length, prefix],
              ),
            ).map((row) => ({ id: String(row["id"]), payload: String(row["payload"]) })),
          ),
      }
    },
  }

  const earliest = async () => {
    const cell = (await run(db, "SELECT MIN(run_at) FROM __jobs")).rows?.[0]?.[0]

    return typeof cell === "number" ? cell : null
  }

  const dispatch = Effect.fn("Jobs.dispatch")(function* () {
    for (;;) {
      const now = Date.now()

      const [due] = rowsOf(
        yield* Effect.promise(() =>
          run(
            db,
            "SELECT callback, id, payload, version FROM __jobs WHERE run_at <= ? ORDER BY run_at LIMIT 1",
            [now],
          ),
        ),
      )

      if (due === undefined) return

      const callback = String(due["callback"])
      const id = String(due["id"])
      const held = Number(due["version"])
      const handler = handlers.get(callback)

      // Leased: if this delivery doesn't finish, the job is due again after the retry delay.
      yield* Effect.promise(() =>
        run(db, "UPDATE __jobs SET run_at = ? WHERE callback = ? AND id = ? AND version = ?", [
          now + (handler?.retryMs ?? DEFAULT_RETRY_MS),
          callback,
          id,
          held,
        ]),
      )
      dirty = true

      if (handler === undefined) {
        yield* Effect.logWarning(`job ${callback}/${id} has no handler here: it stays, leased`)

        continue
      }

      const exit = yield* Effect.exit(handler.run(JSON.parse(String(due["payload"]))))

      if (Exit.isSuccess(exit)) {
        yield* Effect.promise(() =>
          run(db, "DELETE FROM __jobs WHERE callback = ? AND id = ? AND version = ?", [
            callback,
            id,
            held,
          ]),
        )
        dirty = true
      } else {
        yield* Effect.logError(`job ${callback}/${id} failed; it runs again later`, exit.cause)
      }
    }
  })

  return {
    jobs,
    dispatch,
    next: earliest,
    changed: () => dirty,
    settled: () => {
      dirty = false
    },
  }
}

/** Register a durable callback on this object: call it in the object's inner Effect, then `schedule` jobs for it. */
export const makeCallback = Effect.fn("Runtime.makeCallback")(function* <Payload, E, R>(
  name: string,
  handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
  options?: CallbackOptions,
) {
  const jobs = yield* Jobs
  const context = yield* Effect.context<Exclude<R, Scope.Scope>>()

  return jobs.register<Payload>(name, {
    retryMs: Duration.toMillis(Duration.fromInputUnsafe(options?.retry?.delay ?? DEFAULT_RETRY_MS)),
    run: (payload) =>
      Effect.scoped(
        // SAFETY: the payload was stored as this callback's JSON, written by its own `schedule`.
        handler(payload as Payload),
      ).pipe(Effect.provideContext(context), Effect.asVoid),
  })
})
