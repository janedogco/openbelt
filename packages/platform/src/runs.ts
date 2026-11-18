import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { RunView } from "./model.ts"

const KEEP_RUNS = 1000

const KEY_HOURS = 24

type RunRecord = {
  readonly id: string
  readonly fn: string
  readonly trigger: string
  readonly caller: string | null
  readonly manual: string | null
  readonly version: string | null
  readonly enqueuedBy: string | null
  readonly env: string | null
  readonly started: number
  readonly ms: number
  readonly attempts: number
  readonly reads: number
  readonly writes: number
  readonly outcome: "ok" | "error"
  readonly error: { readonly kind: string; readonly message: string } | null
  readonly key: string | null
  readonly replayed: boolean
  readonly input: string
  readonly inputHash: string
  readonly result: string | null
  readonly logs: ReadonlyArray<string>
  readonly trace: string
}

type Row = {
  id: string
  fn: string
  trigger: string
  caller: string | null
  manual: string | null
  version: string | null
  enqueued_by: string | null
  env: string | null
  started: number
  ms: number
  attempts: number
  reads: number
  writes: number
  outcome: string
  error_kind: string | null
  error: string | null
  key: string | null
  replayed: number
  input_bytes: number
  input_hash: string
  input_preview: string
  result: string | null
  logs: string
  trace: string
}

const Logs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const PREVIEW = 300

const LOG_TAIL = 20

export const hashOf = (what: string | Uint8Array<ArrayBuffer>) =>
  Effect.promise(async () =>
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        Predicate.isString(what) ? new TextEncoder().encode(what) : what,
      ),
    ).toHex(),
  )

export const newRunId = () =>
  `r${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join("")}`

const viewOf = (r: Row): RunView => ({
  id: r.id,
  function: r.fn,
  trigger: r.trigger,
  caller: r.caller,
  manual: r.manual,
  version: r.version,
  enqueuedBy: r.enqueued_by,
  env: r.env,
  started: new Date(r.started).toISOString(),
  ms: r.ms,
  attempts: r.attempts,
  reads: r.reads,
  writes: r.writes,
  outcome: r.outcome === "ok" ? "ok" : "error",
  error: r.error_kind === null ? null : { kind: r.error_kind, message: r.error ?? "" },
  key: r.key,
  replayed: r.replayed === 1,
  input: { bytes: r.input_bytes, hash: r.input_hash, preview: r.input_preview },
  result: r.result,
  logs: Option.getOrElse(Logs(r.logs), () => []),
  trace: r.trace,
})

export const openRuns = Effect.fn("Runs.open")(function* (storage: DurableObjectStorage) {
  const { sql } = storage

  let recorded = 0

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS runs (
    n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, fn TEXT NOT NULL,
    trigger TEXT NOT NULL, caller TEXT, manual TEXT, version TEXT, enqueued_by TEXT, env TEXT,
    started INTEGER NOT NULL, ms INTEGER NOT NULL, attempts INTEGER NOT NULL,
    reads INTEGER NOT NULL, writes INTEGER NOT NULL, outcome TEXT NOT NULL, error_kind TEXT,
    error TEXT, key TEXT, replayed INTEGER NOT NULL, input_bytes INTEGER NOT NULL,
    input_hash TEXT NOT NULL, input_preview TEXT NOT NULL, result TEXT, logs TEXT NOT NULL,
    trace TEXT NOT NULL)`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS runs_fn ON runs (fn, n)")

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS run_keys (
    scope TEXT NOT NULL, key TEXT NOT NULL, run TEXT NOT NULL, input_hash TEXT NOT NULL,
    result TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, key))`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS run_keys_at ON run_keys (at)")

  const select = Effect.fnUntraced(function* (
    where: string,
    ...args: Array<string | number | null>
  ) {
    return (yield* (yield* sql.exec<Row>(`SELECT * FROM runs ${where}`, ...args)).toArray()).map(
      viewOf,
    )
  })

  return {
    record: Effect.fnUntraced(function* (run: RunRecord) {
      const shown = run.input.length > PREVIEW ? `${run.input.slice(0, PREVIEW)}…` : run.input

      const result =
        run.result === null
          ? null
          : run.result.length > PREVIEW
            ? `${run.result.slice(0, PREVIEW)}…`
            : run.result

      yield* sql.exec(
        `INSERT INTO runs (id, fn, trigger, caller, manual, version, enqueued_by, env, started, ms,
           attempts, reads, writes, outcome, error_kind, error, key, replayed, input_bytes,
           input_hash, input_preview, result, logs, trace)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        run.id,
        run.fn,
        run.trigger,
        run.caller,
        run.manual,
        run.version,
        run.enqueuedBy,
        run.env,
        run.started,
        run.ms,
        run.attempts,
        run.reads,
        run.writes,
        run.outcome,
        run.error?.kind ?? null,
        run.error?.message.slice(0, 2000) ?? null,
        run.key,
        run.replayed ? 1 : 0,
        new TextEncoder().encode(run.input).length,
        run.inputHash,
        shown,
        result,
        JSON.stringify(run.logs.slice(-LOG_TAIL)),
        run.trace,
      )

      // Trimmed every 50 runs, not after each: the table keeps KEEP_RUNS runs and up to 50 more.
      if (++recorded % 50 === 0)
        yield* sql.exec("DELETE FROM runs WHERE n <= (SELECT MAX(n) FROM runs) - ?", KEEP_RUNS)
    }),

    list: Effect.fnUntraced(function* (options: {
      readonly fn: string | undefined
      readonly limit: number
      readonly failed: boolean
      readonly trace: string | undefined
    }) {
      return yield* select(
        "WHERE (? IS NULL OR fn = ?) AND (? = 0 OR outcome = 'error') AND (? IS NULL OR trace = ?) ORDER BY n DESC LIMIT ?",
        options.fn ?? null,
        options.fn ?? null,
        options.failed ? 1 : 0,
        options.trace ?? null,
        options.trace ?? null,
        options.limit,
      )
    }),

    lastOf: Effect.fnUntraced(function* (fns: ReadonlyArray<string>) {
      const found = new Map<string, RunView>()

      for (const fn of fns) {
        const [last] = yield* select("WHERE fn = ? ORDER BY n DESC LIMIT 1", fn)

        if (last !== undefined) found.set(fn, last)
      }

      return found
    }),

    keyed: Effect.fnUntraced(function* (scope: string, key: string) {
      const [row] = yield* (yield* sql.exec<{
        run: string
        input_hash: string
        result: string
        at: number
      }>(
        "SELECT run, input_hash, result, at FROM run_keys WHERE scope = ? AND key = ? AND at > ?",
        scope,
        key,
        Date.now() - KEY_HOURS * 3600_000,
      )).toArray()

      return row
    }),

    forgetEnv: (env: string) => {
      const scoped = `env:${env}#`

      return Effect.asVoid(
        sql.exec(
          "DELETE FROM run_keys WHERE substr(scope, instr(scope, '@') + 1, ?) = ?",
          scoped.length,
          scoped,
        ),
      )
    },

    remember: Effect.fnUntraced(function* (
      scope: string,
      key: string,
      run: string,
      inputHash: string,
      result: string,
    ) {
      yield* sql.exec("DELETE FROM run_keys WHERE at <= ?", Date.now() - KEY_HOURS * 3600_000)
      yield* sql.exec(
        "INSERT OR REPLACE INTO run_keys (scope, key, run, input_hash, result, at) VALUES (?, ?, ?, ?, ?, ?)",
        scope,
        key,
        run,
        inputHash,
        result,
        Date.now(),
      )
    }),
  }
})
