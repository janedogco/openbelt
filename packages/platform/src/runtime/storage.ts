// What a Durable Object keeps: SQL (sql.exec), a synchronous key-value store (kv), and transactions, over the actor's SQLite.
// The kv store is a table in the same database, so a transaction (a savepoint) covers both, and a rollback undoes both.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import { type Cursor, cursorOf, type RawDb, type Row, run, rowsOf } from "./sql.ts"
import { say } from "./observe.ts"
import { pinTurn } from "./events.ts"
import { fromWire, toWire } from "./wire.ts"

const encode = toWire

const decode = fromWire

/** Synchronous key-value storage: values are JSON (bytes allowed), keys sort as strings. */
export type Kv = {
  readonly get: <T = unknown>(key: string) => T | undefined
  readonly put: <T>(key: string, value: T) => void
  readonly delete: (key: string) => boolean
  readonly list: <T = unknown>(options?: {
    readonly prefix?: string
  }) => IterableIterator<[string, T]>
}

export type Sql = {
  readonly exec: <T extends Row = Row>(
    query: string,
    ...bindings: ReadonlyArray<unknown>
  ) => Effect.Effect<Cursor<T>>
}

export type DurableObjectStorage = {
  readonly sql: Sql
  readonly kv: Kv
  /**
   * Run `effect` so that its SQL and kv writes all happen or none do: a failure, defect or interruption rolls them back.
   * Nested, it joins the outer one.
   */
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * The kv store over a raw database, kept in memory: loaded when the object starts, read from memory, and each write queued to the
 * database behind every statement before it (the async API has no synchronous call; the kv interface stays synchronous).
 */
const makeKv = async (db: RawDb) => {
  await run(db, `CREATE TABLE IF NOT EXISTS __kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)

  const values = new Map<string, string>()

  for (const row of rowsOf(await run(db, `SELECT k, v FROM __kv`))) {
    values.set(String(row["k"]), String(row["v"]))
  }

  const kv: Kv = {
    get: <T = unknown>(key: string) => {
      const cell = values.get(key)

      // SAFETY: the caller names the type it stored under this key.
      return cell === undefined ? undefined : (decode(cell) as T)
    },
    put: (key, value) => {
      const encoded = encode(value)

      values.set(key, encoded)
      void run(
        db,
        `INSERT INTO __kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
        [key, encoded],
      ).catch(() => undefined)
    },
    delete: (key) => {
      const had = values.delete(key)

      void run(db, `DELETE FROM __kv WHERE k = ?`, [key]).catch(() => undefined)

      return had
    },
    list: <T = unknown>(options?: { readonly prefix?: string }) => {
      const prefix = options?.prefix ?? ""

      // SAFETY: each stored value is the type the caller put under its key (as in get).
      const entries = [...values]
        .filter(([k]) => k.startsWith(prefix))
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]): [string, T] => [k, decode(v) as T])

      return entries[Symbol.iterator]()
    },
  }

  return {
    kv,
    snapshot: () => new Map(values),
    restore: (saved: Map<string, string>) => {
      values.clear()

      for (const [k, v] of saved) values.set(k, v)
    },
  }
}

/** The storages whose transaction the running fiber is inside: a transaction nested in one is a savepoint of it, not a new one. */
const Inside = Context.Reference<ReadonlySet<object>>("openbelt/storage/inside", {
  defaultValue: () => new Set(),
})

/** How long a transaction waits for one already open on its object (a call cycle back into the object would wait forever). */
const TRANSACTION_WAIT = "30 seconds"

/**
 * A Durable Object's storage over a raw database. Transactions are savepoints, and SQLite's savepoints are a stack: two transactions
 * of one object that overlapped (one event's waiting on a fetch while another event's ran) released each other's ("no such savepoint:
 * sp_N in RELEASE sp_N", under load), so they take turns. One nested inside another (the same fiber) joins it as a savepoint.
 */
export const makeStorage = async (db: RawDb): Promise<DurableObjectStorage> => {
  let savepoints = 0

  const token = {}

  const turn = Semaphore.makeUnsafe(1)

  const store = await makeKv(db)

  return {
    sql: {
      exec: <T extends Row = Row>(query: string, ...bindings: ReadonlyArray<unknown>) =>
        Effect.promise(() => run(db, query, bindings)).pipe(Effect.map((r) => cursorOf<T>(r))),
    },
    kv: store.kv,
    transaction: Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const inside = yield* Inside

      const savepoint = Effect.acquireUseRelease(
        Effect.promise(async () => {
          const name = `sp_${++savepoints}`

          await run(db, `SAVEPOINT ${name}`)

          return { name, saved: store.snapshot() }
        }),
        () => effect.pipe(Effect.provideService(Inside, new Set([...inside, token]))),
        ({ name, saved }, exit) =>
          Effect.promise(async () => {
            if (Exit.isFailure(exit)) {
              store.restore(saved)
              await run(db, `ROLLBACK TO ${name}`)
            }

            await run(db, `RELEASE ${name}`)
          }),
      )

      if (inside.has(token)) return yield* savepoint

      const began = Date.now()

      const took = yield* Effect.timeoutOption(turn.take(1), TRANSACTION_WAIT)

      if (Date.now() - began > 5000)
        say("warn", `storage: a transaction waited ${Date.now() - began} ms for another to end`, {})

      if (Option.isNone(took))
        return yield* Effect.die(
          new Error(
            `a transaction waited ${TRANSACTION_WAIT} for another on the same object to end: a call that comes back into an object while its transaction is open waits for itself`,
          ),
        )

      return yield* Effect.acquireUseRelease(
        Effect.sync(pinTurn),
        () => savepoint,
        (unpin) => Effect.sync(unpin).pipe(Effect.andThen(turn.release(1))),
      )
    }),
  }
}
