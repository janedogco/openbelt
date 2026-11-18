import { openAggregates } from "./aggregates.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  type Change,
  Conflict,
  type DatasetName,
  type Doc,
  type Json,
  type LogLine,
  Missing,
  Refused,
  type RunAuthority,
  type Writer,
} from "./model.ts"
import type { Tree } from "./trees.ts"

export const MAX_LIMIT = 1000

export const DEFAULT_LIMIT = 100

const MAX_DOC = 64_000

const CHUNK = 500

type Row = {
  id: string
  collection: string
  data: string
  author: string
  author_name: string
  updated_by: string
  created: string
  updated: string
  seq: number
}

const COLUMNS = "id, collection, data, author, author_name, updated_by, created, updated, seq"

type Hooks = {
  readonly log: (level: LogLine["level"], trace: string, message: string) => Effect.Effect<void>
  readonly announce: (change: Change, origin: RunAuthority) => Effect.Effect<void>
  readonly checkStorage?: (trace: string) => Effect.Effect<void, Refused>
  readonly label: string
  readonly committed?: (
    changes: ReadonlyArray<Committed>,
    trace: string,
    chain: ReadonlyArray<string>,
    origin: RunAuthority,
    tree: Tree | undefined,
  ) => Effect.Effect<void>
}

export type Committed = {
  readonly change: Change
  readonly before: Doc | null
}

export type RunReads = {
  readonly docs: ReadonlyArray<{
    readonly collection: string
    readonly id: string
    readonly seq: number
  }>
  readonly collections: ReadonlyArray<{
    readonly collection: string
    readonly version: number
  }>
  readonly everything: number | null
}

export type Moved = {
  readonly docs: ReadonlyArray<{
    readonly collection: string
    readonly id: string
    readonly before: number
    readonly after: number
  }>
  readonly collections: ReadonlyArray<{
    readonly collection: string
    readonly before: number
    readonly after: number
  }>
  readonly seq: { readonly before: number; readonly after: number }
}

export type RunWrite = {
  readonly collection: string
  readonly id: string
  readonly data: Json | null
  readonly stamp: Stamp
}

type ListRange = {
  readonly limit: number
  readonly cursor: string | undefined
  readonly maxBytes?: number | undefined
}

const decodeData = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const toDoc = (row: Row): Doc => ({
  id: row.id,
  collection: row.collection,
  data: decodeData(row.data),
  author: row.author,
  authorName: row.author_name,
  updatedBy: row.updated_by,
  created: row.created,
  updated: row.updated,
  seq: row.seq,
})

const asObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

const cursorOf = (born: number) => btoa(`born:${born}`)

const bornOf = (cursor: string) => {
  try {
    const match = /^born:(\d+)$/.exec(atob(cursor))

    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

export const sized = (data: Json) => {
  const text = JSON.stringify(data)
  const bytes = new TextEncoder().encode(text).length

  return bytes > MAX_DOC
    ? Effect.fail(
        new Refused({ message: `documents are limited to 64 KB; this one is ${bytes} bytes` }),
      )
    : Effect.succeed(text)
}

export const missing = (collection: string, id: string) =>
  new Missing({
    message: `there's no document "${id}" in ${collection}. set(id, data) creates one with that id.`,
  })

export const checkSeq = (
  collection: string,
  id: string,
  before: Doc | null,
  ifSeq: number | undefined,
): Effect.Effect<void, Conflict | Missing> => {
  if (ifSeq === undefined) return Effect.void

  if (before === null) return ifSeq === 0 ? Effect.void : Effect.fail(missing(collection, id))

  if (ifSeq === before.seq) return Effect.void

  return Effect.fail(
    new Conflict({
      message:
        ifSeq === 0
          ? `${collection}/${id} already exists (seq ${before.seq}), and ifSeq 0 only creates. get(id) it and decide: update it with ifSeq: ${before.seq}, or leave it.`
          : `${collection}/${id} changed since you read it: ifSeq was ${ifSeq}, its seq is now ${before.seq}. get(id) the current document, apply your change to it and try again.`,
      seq: before.seq,
    }),
  )
}

export const mergeInto = (collection: string, id: string, before: Doc | null, patch: Json) => {
  const fields = asObject(patch)
  const current = before === null ? Option.some({}) : asObject(before.data)

  return Option.isNone(fields) || Option.isNone(current)
    ? Effect.fail(
        new Refused({
          message: `update merges the fields of a JSON object into a document that is an object; use set(id, data) to replace ${collection}/${id} whole`,
        }),
      )
    : Effect.succeed<Json>({ ...current.value, ...fields.value })
}

export type Stamp = {
  readonly by: Writer
  readonly author?: string | undefined
  readonly updatedBy?: string | undefined
}

export const stampOf = (stamp: Stamp, before: Doc | null) => ({
  author: stamp.author ?? before?.author ?? stamp.by.author,
  authorName: stamp.author ?? before?.authorName ?? stamp.by.name,
  updatedBy: stamp.updatedBy ?? stamp.by.author,
})

export type PlannedWrite =
  | {
      readonly op: "put"
      readonly id: string
      readonly data: Json
      readonly before: Doc | null
      readonly stamp: Stamp
    }
  | { readonly op: "delete"; readonly id: string; readonly before: Doc }

export const openDataset = Effect.fn("Dataset.open")(function* (
  storage: DurableObjectStorage,
  name: DatasetName,
  hooks: Hooks,
) {
  const { sql, kv } = storage
  const docs = `docs_${name}`
  const seqKey = `seq:${name}`
  const resetKey = `reset:${name}`
  const where = hooks.label

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS ${docs} (
    collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, author TEXT NOT NULL,
    author_name TEXT NOT NULL, updated_by TEXT NOT NULL, created TEXT NOT NULL,
    updated TEXT NOT NULL, seq INTEGER NOT NULL,
    born INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection, id))`)
  yield* sql.exec(`CREATE INDEX IF NOT EXISTS ${docs}_seq ON ${docs} (seq)`)
  yield* sql.exec(`CREATE INDEX IF NOT EXISTS ${docs}_born ON ${docs} (collection, born)`)
  yield* sql.exec(`CREATE INDEX IF NOT EXISTS ${docs}_coll_seq ON ${docs} (collection, seq)`)

  const seq = () => kv.get<number>(seqKey) ?? 0

  const bump = (floor: number) => {
    kv.put(seqKey, floor + 1)
    kv.put(resetKey, floor + 1)
  }

  const size = Effect.fnUntraced(function* () {
    const [row] = yield* (yield* sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${docs} WHERE gone = 0`,
    )).toArray()

    return row?.n ?? 0
  })

  const commit = <A, E>(effect: Effect.Effect<A, E>) => storage.transaction(effect)

  const get = Effect.fn("Dataset.get")(function* (collection: string, id: string) {
    const [row] = yield* (yield* sql.exec<Row>(
      `SELECT ${COLUMNS} FROM ${docs} WHERE collection = ? AND id = ? AND gone = 0`,
      collection,
      id,
    )).toArray()

    return row === undefined ? null : toDoc(row)
  })

  const put = Effect.fnUntraced(function* (
    collection: string,
    id: string,
    data: Json,
    text: string,
    stamp: Stamp,
    before: Doc | null,
  ) {
    const next = seq() + 1
    const now = new Date().toISOString()

    const doc: Doc = {
      id,
      collection,
      data,
      ...stampOf(stamp, before),
      created: before?.created ?? now,
      updated: now,
      seq: next,
    }

    yield* before === null
      ? sql.exec(
          `INSERT OR REPLACE INTO ${docs} (${COLUMNS}, born) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          collection,
          text,
          doc.author,
          doc.authorName,
          doc.updatedBy,
          doc.created,
          now,
          next,
          next,
        )
      : sql.exec(
          `UPDATE ${docs} SET data = ?, author = ?, author_name = ?, updated_by = ?, updated = ?, seq = ? WHERE collection = ? AND id = ?`,
          text,
          doc.author,
          doc.authorName,
          doc.updatedBy,
          now,
          next,
          collection,
          id,
        )
    kv.put(seqKey, next)

    const change: Change = { op: before === null ? "add" : "update", doc }

    return change
  })

  const drop = Effect.fnUntraced(function* (before: Doc) {
    const gone: Doc = { ...before, seq: seq() + 1 }

    yield* sql.exec(
      `UPDATE ${docs} SET gone = 1, seq = ? WHERE collection = ? AND id = ?`,
      gone.seq,
      gone.collection,
      gone.id,
    )
    kv.put(seqKey, gone.seq)

    return gone
  })

  const told = Effect.fnUntraced(function* (
    change: Change,
    by: Writer,
    trace: string,
    origin: RunAuthority,
  ) {
    const verb = { add: "added", update: "updated", delete: "deleted" }[change.op]

    yield* hooks.log(
      "info",
      trace,
      `${verb} ${where}${change.doc.collection}/${change.doc.id} (seq ${change.doc.seq}) by ${by.author}`,
    )
    yield* hooks.announce(change, origin)

    return change.doc
  })

  const aggregates = openAggregates(storage, name)

  return {
    aggregates,
    seq,

    resetAt: () => kv.get<number>(resetKey) ?? 0,

    compact: Effect.fn("Dataset.compact")(function* () {
      const [row] = yield* (yield* sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${docs} WHERE gone = 1 AND data != 'null'`,
      )).toArray()

      const n = row?.n ?? 0

      if (n > 0)
        yield* commit(
          Effect.gen(function* () {
            yield* sql.exec(`UPDATE ${docs} SET data = 'null' WHERE gone = 1`)
            bump(seq())
          }),
        )

      return n
    }),

    get,

    list: Effect.fn("Dataset.list")(function* (collection: string, range: ListRange) {
      const before = range.cursor === undefined ? Number.MAX_SAFE_INTEGER : bornOf(range.cursor)

      if (before === undefined) {
        return yield* new Refused({
          message: `cursor "${range.cursor?.slice(0, 40)}" isn't one a list returned: pass the cursor from the previous page as is, or leave it out to start from the newest`,
        })
      }

      const rows = yield* (yield* sql.exec<Row & { born: number }>(
        `SELECT ${COLUMNS}, born FROM ${docs} WHERE collection = ? AND born < ? AND gone = 0 ORDER BY born DESC LIMIT ?`,
        collection,
        before,
        range.limit + 1,
      )).toArray()

      const kept: Array<Row & { born: number }> = []
      let bytes = 0

      for (const row of rows.slice(0, range.limit)) {
        bytes += row.data.length + 200

        if (kept.length > 0 && range.maxBytes !== undefined && bytes > range.maxBytes) break

        kept.push(row)
      }

      const last = kept.at(-1)

      return {
        docs: kept.map(toDoc),
        cursor: kept.length < rows.length && last !== undefined ? cursorOf(last.born) : null,
      }
    }),

    writeMany: Effect.fn("Dataset.writeMany")(function* (
      collection: string,
      writes: ReadonlyArray<PlannedWrite>,
      by: Writer,
      trace: string,
      origin: RunAuthority,
    ) {
      const stored = yield* Effect.forEach(writes, (write) =>
        Effect.map(write.op === "put" ? sized(write.data) : Effect.succeed(""), (text) => ({
          write,
          text,
        })),
      )

      const changes = yield* commit(
        Effect.gen(function* () {
          const done = yield* Effect.forEach(stored, ({ write, text }) =>
            Effect.gen(function* () {
              const now = yield* get(collection, write.id)

              if ((now?.seq ?? 0) !== (write.before?.seq ?? 0)) {
                return yield* new Conflict({
                  message: `${collection}/${write.id} changed while the batch was checked (its seq is now ${now?.seq ?? "gone"}); nothing was written. Send the batch again.`,
                  seq: now?.seq ?? 0,
                })
              }

              if (write.op === "put") {
                const change = yield* put(collection, write.id, write.data, text, write.stamp, now)
                const one: Committed = { change, before: now }

                return one
              }

              const gone: Doc = now ?? write.before

              const one: Committed = {
                change: { op: "delete", doc: yield* drop(gone) },
                before: gone,
              }

              return one
            }),
          )

          if (stored.some(({ write }) => write.op === "put") && hooks.checkStorage !== undefined)
            yield* hooks.checkStorage(trace)

          if (hooks.committed !== undefined)
            yield* hooks.committed(done, trace, [], origin, undefined)

          return done.map((one) => one.change)
        }),
      )

      const [only] = changes

      if (changes.length === 1 && only !== undefined) return [yield* told(only, by, trace, origin)]

      yield* hooks.log(
        "info",
        trace,
        `wrote ${changes.length} documents to ${where}${collection} in one batch (seq ${only?.doc.seq ?? seq()}-${seq()}) by ${by.author}`,
      )

      for (const change of changes) yield* hooks.announce(change, origin)

      return changes.map((change) => change.doc)
    }),

    version: Effect.fnUntraced(function* (collection: string) {
      const [row] = yield* (yield* sql.exec<{ v: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS v FROM ${docs} WHERE collection = ?`,
        collection,
      )).toArray()

      return row?.v ?? 0
    }),

    commitRun: Effect.fn("Dataset.commitRun")(function* (run: {
      readonly reads: RunReads
      readonly writes: ReadonlyArray<RunWrite>
      readonly by: Writer
      readonly trace: string
      readonly chain: ReadonlyArray<string>
      readonly origin: RunAuthority
      readonly tree: Tree
      readonly check?: () => Effect.Effect<string | undefined>
      readonly inside: (changes: ReadonlyArray<Committed>) => Effect.Effect<void>
    }) {
      const texts = yield* Effect.forEach(run.writes, (write) =>
        write.data === null ? Effect.succeed("") : Effect.orDie(sized(write.data)),
      )

      const outcome = yield* commit(
        Effect.gen(function* () {
          for (const read of run.reads.docs) {
            const now = yield* get(read.collection, read.id)

            if ((now?.seq ?? 0) !== read.seq) {
              return {
                stale: `${read.collection}/${read.id} changed since the run read it (seq ${read.seq}, now ${now?.seq ?? "gone"})`,
              } as const
            }
          }

          for (const read of run.reads.collections) {
            const [row] = yield* (yield* sql.exec<{ v: number }>(
              `SELECT COALESCE(MAX(seq), 0) AS v FROM ${docs} WHERE collection = ?`,
              read.collection,
            )).toArray()

            if ((row?.v ?? 0) !== read.version) {
              return {
                stale: `${read.collection} changed since the run listed it (a document there was written)`,
              } as const
            }
          }

          if (run.reads.everything !== null && seq() !== run.reads.everything) {
            return {
              stale: `the data changed since the run read db.collections() (seq ${run.reads.everything}, now ${seq()})`,
            } as const
          }

          const more = run.check === undefined ? undefined : yield* run.check()

          if (more !== undefined) return { stale: more } as const

          const seqBefore = seq()
          const versionsBefore = new Map<string, number>()

          for (const write of run.writes) {
            if (versionsBefore.has(write.collection)) continue

            const [row] = yield* (yield* sql.exec<{ v: number }>(
              `SELECT COALESCE(MAX(seq), 0) AS v FROM ${docs} WHERE collection = ?`,
              write.collection,
            )).toArray()

            versionsBefore.set(write.collection, row?.v ?? 0)
          }

          const done: Array<Committed> = []

          for (const [i, write] of run.writes.entries()) {
            const now = yield* get(write.collection, write.id)

            if (write.data === null) {
              if (now !== null)
                done.push({
                  change: { op: "delete", doc: yield* drop(now) },
                  before: now,
                })
              continue
            }

            const change = yield* put(
              write.collection,
              write.id,
              write.data,
              texts[i] ?? "",
              write.stamp,
              now,
            )

            done.push({ change, before: now })
          }

          if (run.writes.some((write) => write.data !== null) && hooks.checkStorage !== undefined)
            yield* hooks.checkStorage(run.trace)

          yield* run.inside(done)

          if (hooks.committed !== undefined)
            yield* hooks.committed(done, run.trace, run.chain, run.origin, run.tree)

          const moved: Moved = {
            docs: done.map(({ change, before }) => ({
              collection: change.doc.collection,
              id: change.doc.id,
              before: before?.seq ?? 0,
              after: change.doc.seq,
            })),
            collections: [...versionsBefore].map(([collection, before]) => ({
              collection,
              before,
              after: Math.max(
                before,
                ...done.flatMap((one) =>
                  one.change.doc.collection === collection ? [one.change.doc.seq] : [],
                ),
              ),
            })),
            seq: { before: seqBefore, after: seq() },
          }

          return { changes: done, moved } as const
        }),
      )

      if ("stale" in outcome) return outcome

      const [only] = outcome.changes

      if (outcome.changes.length === 1 && only !== undefined) {
        yield* told(only.change, run.by, run.trace, run.origin)
      } else if (outcome.changes.length > 1) {
        yield* hooks.log(
          "info",
          run.trace,
          `wrote ${outcome.changes.length} documents to ${where || "live "}data in one run's commit (seq ${only?.change.doc.seq ?? seq()}-${seq()}) by ${run.by.author}`,
        )

        for (const one of outcome.changes) yield* hooks.announce(one.change, run.origin)
      }

      return outcome
    }),

    clear: Effect.fn("Dataset.clear")(function* (
      collection: string,
      by: Writer,
      trace: string,
      origin: RunAuthority,
    ) {
      let count = 0

      for (;;) {
        const rows = yield* (yield* sql.exec<Row>(
          `SELECT ${COLUMNS} FROM ${docs} WHERE collection = ? AND gone = 0 ORDER BY born LIMIT ?`,
          collection,
          CHUNK,
        )).toArray()

        if (rows.length === 0) break

        const gone = yield* commit(
          Effect.gen(function* () {
            const dropped = yield* Effect.forEach(rows, (row) => drop(toDoc(row)))
            const before = rows.map(toDoc)

            if (hooks.committed !== undefined) {
              yield* hooks.committed(
                dropped.map((doc, i) => ({
                  change: { op: "delete", doc },
                  before: before[i] ?? doc,
                })),
                trace,
                [],
                origin,
                undefined,
              )
            }

            return dropped
          }),
        )

        for (const doc of gone) yield* hooks.announce({ op: "delete", doc }, origin)

        count += gone.length
      }

      yield* hooks.log(
        "info",
        trace,
        `deleted all ${count} documents in ${where}${collection} (now seq ${seq()}) by ${by.author}`,
      )

      return { deleted: count }
    }),

    replay: Effect.fn("Dataset.replay")(function* (
      since: number,
      send: (change: Change) => Effect.Effect<void>,
    ) {
      let after = since

      for (;;) {
        const rows = yield* (yield* sql.exec<Row & { born: number; gone: number }>(
          `SELECT ${COLUMNS}, born, gone FROM ${docs} WHERE seq > ? ORDER BY seq LIMIT ?`,
          after,
          CHUNK,
        )).toArray()

        for (const row of rows) {
          const op = row.gone === 1 ? "delete" : row.born > since ? "add" : "update"

          yield* send({ op, doc: toDoc(row) })
        }

        const last = rows.at(-1)

        if (rows.length < CHUNK || last === undefined) return

        after = last.seq
      }
    }),

    reset: Effect.fn("Dataset.reset")(function* (why: string, trace: string) {
      const count = yield* commit(
        Effect.gen(function* () {
          const n = yield* size()

          yield* sql.exec(`DELETE FROM ${docs}`)
          bump(seq())

          return n
        }),
      )

      yield* hooks.log(
        "info",
        trace,
        `${where || "live "}data reset: ${count} documents deleted (${why})`,
      )

      return { deleted: count }
    }),

    size,

    seed: Effect.fn("Dataset.seed")(function* (from: DatasetName, cap: number, trace: string) {
      const copied = yield* commit(
        Effect.gen(function* () {
          const [total] = yield* (yield* sql.exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM docs_${from} WHERE gone = 0`,
          )).toArray()

          yield* sql.exec(`DELETE FROM ${docs} WHERE gone = 1`)
          yield* sql.exec(
            `INSERT INTO ${docs} (${COLUMNS}, born) SELECT ${COLUMNS}, born FROM docs_${from} WHERE gone = 0 ORDER BY born DESC LIMIT ?`,
            cap,
          )

          bump(Math.max(seq(), kv.get<number>(`seq:${from}`) ?? 0))

          if (hooks.checkStorage !== undefined) yield* hooks.checkStorage(trace)

          const n = total?.n ?? 0

          return { docs: Math.min(n, cap), capped: n > cap }
        }),
      )

      yield* hooks.log(
        "info",
        trace,
        `${where}data seeded with ${copied.docs} ${from} documents${copied.capped ? ` (the newest ${cap})` : ""}`,
      )

      return copied
    }),

    drop: Effect.fn("Dataset.drop")(function* (why: string, trace: string) {
      const count = yield* size()

      yield* commit(
        Effect.gen(function* () {
          yield* aggregates.drop()
          yield* sql.exec(`DROP TABLE IF EXISTS ${docs}`)
          bump(seq())
        }),
      )
      yield* hooks.log("info", trace, `${where}data deleted: ${count} documents (${why})`)

      return { deleted: count }
    }),

    counts: Effect.fn("Dataset.counts")(function* () {
      const rows = yield* (yield* sql.exec<{
        collection: string
        n: number
        last: string
      }>(
        `SELECT collection, COUNT(*) AS n, MAX(updated) AS last FROM ${docs} WHERE gone = 0 GROUP BY collection ORDER BY collection`,
      )).toArray()

      return rows.map((r) => ({ name: r.collection, docs: r.n, lastWrite: r.last }))
    }),
  }
})
