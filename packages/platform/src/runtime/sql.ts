// An object's SQLite (its file, on a database thread: localdb.ts), as the Durable Object code sees it: sql.exec with positional
// bindings and several statements in one string, rows by column name, blobs as ArrayBuffer.
import * as Effect from "effect/Effect"
import { withDbContext } from "./db-observe.ts"
import { recordCommit } from "./metrics.ts"
import { say } from "./observe.ts"

/** What an object's database gives back for one statement. */
export type RawResult = {
  readonly columns?: ReadonlyArray<string>
  readonly rows?: ReadonlyArray<ReadonlyArray<unknown>>
  readonly changes?: number
}

/** The object's database, asked over its thread (localdb.ts). */
export type RawDb = {
  readonly execute: (query: string, bindings?: ReadonlyArray<unknown>) => Promise<RawResult>
}

/** Every statement of a database, in the order it was asked for: kv writes are queued without waiting, and a read after them sees them. */
const queues = new WeakMap<RawDb, Promise<unknown>>()

/** Statements asked for and not yet finished, per database. */
const pending = new WeakMap<RawDb, number>()

const enqueue = <A>(db: RawDb, work: () => Promise<A>): Promise<A> => {
  pending.set(db, (pending.get(db) ?? 0) + 1)

  const step = async () => {
    try {
      return await work()
    } finally {
      const left = (pending.get(db) ?? 1) - 1

      pending.set(db, left)

      // Nothing else waiting: end the transaction soon (GROUP_MS), not when the event settles: an event waiting seconds on a browser
      // held its writes uncommitted all that while.
      if (left === 0) void flush(db)
    }
  }

  const done = (queues.get(db) ?? Promise.resolve()).then(step, step)

  queues.set(
    db,
    done.catch(() => undefined),
  )

  return done
}

/**
 * Group commit: an object's statements run inside one transaction, opened by the first and committed when its event settles
 * (`commit`), not one commit per statement.
 */
type Batch = {
  open: boolean
  savepoints: number
  /** The commit that events settling now share, if one is due. */
  flushing: Promise<unknown> | undefined
  /** Starts the due commit now instead of after its wait (an event alone asked for it). */
  hurry: (() => void) | undefined
  /** The open transaction's number: one more each time a transaction ends (committed or rolled back). */
  generation: number
  /** Who waits for a transaction to be committed (strict commit), by its number. */
  ends: Map<number, PromiseWithResolvers<void>>
}

/** A transaction over: whoever waits for it learns it committed, or that it was rolled back (its writes are gone). */
const ended = (batch: Batch, committed: boolean, error?: unknown) => {
  const waiting = batch.ends.get(batch.generation)

  batch.ends.delete(batch.generation)
  batch.generation += 1

  if (committed) waiting?.resolve()
  else waiting?.reject(error ?? new Error("the transaction was rolled back"))
}

/** Resolves when transaction `generation` is committed; rejects if it was rolled back. */
const endOf = (batch: Batch, generation: number): Promise<void> => {
  if (batch.generation > generation) return Promise.resolve()

  const found = batch.ends.get(generation)

  if (found !== undefined) return found.promise

  const made = Promise.withResolvers<void>()

  // Nobody may be waiting by the time it ends.
  made.promise.catch(() => undefined)
  batch.ends.set(generation, made)

  return made.promise
}

const batches = new WeakMap<RawDb, Batch>()

const batchOf = (db: RawDb): Batch => {
  const found = batches.get(db)

  if (found !== undefined) return found

  const made: Batch = {
    open: false,
    savepoints: 0,
    flushing: undefined,
    hurry: undefined,
    generation: 0,
    ends: new Map(),
  }

  batches.set(db, made)

  return made
}

const READS = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i

const count = (batch: Batch, statement: string) => {
  if (/^\s*SAVEPOINT\b/i.test(statement)) batch.savepoints += 1
  else if (/^\s*RELEASE\b/i.test(statement)) batch.savepoints = Math.max(0, batch.savepoints - 1)
}

/** One statement in the object's transaction (opened by the first write; a read alone runs outside one). */
const inBatch = async (
  db: RawDb,
  statement: string,
  bindings: ReadonlyArray<unknown>,
): Promise<RawResult> => {
  const batch = batchOf(db)
  const alone = !batch.open && READS.test(statement)

  if (!batch.open && !alone) {
    await db.execute("BEGIN", [])
    batch.open = true
  }

  const result = await db.execute(statement, bindings)

  if (/^\s*COMMIT\b/i.test(statement)) {
    batch.open = false
    ended(batch, true)
  } else if (!alone) count(batch, statement)

  return result
}

/** Commit the object's open transaction, unless a savepoint is still open (an event waiting outside mid-transaction): its settle commits. */
const commitIfIdle = async (db: RawDb) => {
  const batch = batchOf(db)

  if (!batch.open || batch.savepoints > 0) return

  try {
    await inBatch(db, "COMMIT", [])
  } catch (error) {
    // A commit that failed (a database closed under it) is over: its events get the error, and the transaction is let go. Left
    // open, every queue that drained asked for the commit again, 100 times a second per object, each failing and logged: 2.5
    // million lines a minute, until the platform ran out of memory (a capacity lab).
    await db.execute("ROLLBACK", []).catch(() => undefined)
    batch.open = false
    batch.savepoints = 0
    ended(batch, false, error)
    throw error
  }

  recordCommit()
}

/**
 * How long a commit waits for more events to share it, when others are under way. A commit was a durable write (3 to 5 ms when
 * measured, on the engine's storage), and one per event held a busy object to half the requests the synchronous build served (63 against 109 a second in the same
 * soak). Alone, an event doesn't wait: always waiting cost a lone write 10 of its 20 ms; never waiting halved a busy object's writes
 * (117 a second against 277, 32 writers).
 */
const GROUP_MS = 10

/** The commit that ends the object's open transaction, shared by every event that settles before it runs. */
const flush = (db: RawDb, share = true): Promise<unknown> => {
  const batch = batchOf(db)

  if (!batch.open) return Promise.resolve()

  // A commit already due (a queue that drained asked for it) starts now for an event that has nobody to share it with.
  if (!share) batch.hurry?.()

  batch.flushing ??= new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, share ? GROUP_MS : 0)

    batch.hurry = () => {
      clearTimeout(timer)
      resolve()
    }
  }).then(() =>
    enqueue(db, async () => {
      batch.flushing = undefined
      batch.hurry = undefined
      await commitIfIdle(db)
    }),
  )

  return batch.flushing
}

/**
 * The object's writes so far are committed (durable) once this resolves: what an event waits for before its answer leaves. `share`:
 * other events are under way, so the commit waits a moment (GROUP_MS) for theirs; alone, it goes at once.
 */
export const commit = async (db: RawDb, share = true, strict = false): Promise<unknown> => {
  if (!strict) return await flush(db, share)

  // Strict: the transaction this event's writes are in, found after them in the queue, must have committed. The shared commit
  // alone wasn't enough: it is skipped while another event of the object holds a savepoint open (waiting outside mid-transaction),
  // and an answer that went out then named writes that a kill -9 lost (2 of 17,942 in the crash-recovery check, at 1 process).
  const generation = await enqueue(db, async () => {
    const batch = batchOf(db)

    return batch.open ? batch.generation : undefined
  })

  if (generation === undefined) return undefined

  const end = endOf(batchOf(db), generation)

  await flush(db, share)

  const late = Symbol("late")

  const done = await Promise.race([end, Bun.sleep(STRICT_WAIT_MS).then(() => late)])

  if (done === late)
    say(
      "warn",
      `sql: an answer waited ${STRICT_WAIT_MS / 1000} s for its writes to commit (another event of the object held its transaction open) and went out first`,
      {},
    )

  return undefined
}

/** How long an answer waits for the transaction its writes are in, when another event holds it open: then it goes anyway, logged. */
const STRICT_WAIT_MS = 30_000

/** Resolves when every statement queued so far has run (rejects if one failed). */
export const drained = (db: RawDb): Promise<unknown> => queues.get(db) ?? Promise.resolve()

export type SqlValue = string | number | null | ArrayBuffer

export type Row = Record<string, SqlValue>

const toBinding = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)

  if (typeof value === "boolean") return value ? 1 : 0

  return value
}

const fromCell = (value: unknown): unknown =>
  value instanceof Uint8Array
    ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    : value

/**
 * One SQL string split into its statements, each with the bindings its `?`s take. Quotes, line comments and a trigger's
 * BEGIN..END are respected: a `;` inside them doesn't end a statement.
 */
const split = (query: string): ReadonlyArray<string> => {
  const known = splits.get(query)

  if (known !== undefined) return known

  const made = splitNow(query)

  // The platform's queries are a few hundred constant strings: splitting each again on every call was 7% of the main thread at
  // 200 requests a second. A query built with its values in it would fill this, so it is emptied past a bound.
  if (splits.size >= 2000) splits.clear()

  splits.set(query, made)

  return made
}

const splits = new Map<string, ReadonlyArray<string>>()

const splitNow = (query: string): ReadonlyArray<string> => {
  const statements: Array<string> = []
  let current = ""
  let quote = ""
  let depth = 0

  for (let i = 0; i < query.length; i++) {
    const ch = query.charAt(i)

    if (quote !== "") {
      current += ch

      if (ch === quote) quote = ""

      continue
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      current += ch

      continue
    }

    if (ch === "-" && query.charAt(i + 1) === "-") {
      while (i < query.length && query.charAt(i) !== "\n") i++

      continue
    }

    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/\w/.test(query.charAt(i - 1)))) {
      const word = (/^\w+/.exec(query.slice(i))?.[0] ?? "").toUpperCase()

      if (word === "BEGIN" && /TRIGGER/i.test(current)) depth++

      if (word === "END" && depth > 0) depth--
    }

    if (ch === ";" && depth === 0) {
      if (current.trim() !== "") statements.push(current.trim())

      current = ""

      continue
    }

    current += ch
  }

  if (current.trim() !== "") statements.push(current.trim())

  return statements
}

const WRITES = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i

/** One statement; a write's row count comes from SQLite's changes() when the driver doesn't report it. */
const one = async (
  db: RawDb,
  statement: string,
  bindings: ReadonlyArray<unknown>,
): Promise<RawResult> => {
  const result = await inBatch(db, statement, bindings.map(toBinding))

  if (result.changes !== undefined || !WRITES.test(statement)) return result

  const changed = await inBatch(db, "SELECT changes()", [])

  return { ...result, changes: Number(changed.rows?.[0]?.[0] ?? 0) }
}

/** The result of the last statement of `query`, run in order, the bindings dealt out to each by its `?`s. */
export const run = (
  db: RawDb,
  query: string,
  bindings: ReadonlyArray<unknown> = [],
): Promise<RawResult> =>
  withDbContext(() =>
    enqueue(db, async () => {
      const statements = split(query)

      if (statements.length <= 1) return one(db, query, bindings)

      let used = 0
      let last: RawResult = {}

      for (const statement of statements) {
        const n = (statement.match(/\?/g) ?? []).length

        // oxlint-disable-next-line no-await-in-loop -- statements run in order
        last = await one(db, statement, bindings.slice(used, used + n))
        used += n
      }

      return last
    }),
  )

/** A statement's rows as objects keyed by column name. */
export const rowsOf = <T extends Row>(result: RawResult): Array<T> => {
  const columns = result.columns ?? []

  return (result.rows ?? []).map(
    (row) =>
      // SAFETY: the columns and cells come from the same statement; the caller names the row type it selected.
      Object.fromEntries(columns.map((name, i) => [name, fromCell(row[i])])) as T,
  )
}

/** What `sql.exec` returns: the rows read now, and what the statement changed. */
export type Cursor<T extends Row> = {
  readonly columnNames: ReadonlyArray<string>
  readonly toArray: () => Effect.Effect<Array<T>>
  readonly one: () => Effect.Effect<T>
  readonly rowsRead: Effect.Effect<number>
  readonly rowsWritten: Effect.Effect<number>
}

export const cursorOf = <T extends Row>(result: RawResult): Cursor<T> => {
  const rows = rowsOf<T>(result)

  return {
    columnNames: result.columns ?? [],
    toArray: () => Effect.succeed(rows),
    one: () =>
      rows.length === 1
        ? // SAFETY: the length was just checked: the one row is there.
          Effect.succeed(rows[0] as T)
        : Effect.die(new Error(`Expected exactly one row, got ${rows.length}`)),
    rowsRead: Effect.succeed(rows.length),
    rowsWritten: Effect.succeed(result.changes ?? 0),
  }
}
