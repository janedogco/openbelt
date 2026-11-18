import * as Effect from "effect/Effect"
import type { DurableObjectStorage } from "./runtime/index.ts"
import {
  type AggregateDefinition,
  type AggregateResult,
  type DatasetName,
  Refused,
} from "./model.ts"

type Definitions = Readonly<Record<string, AggregateDefinition>>

type Stored = { name: string; collection: string; field: string | null }

type Total = { n: number; total: number; invalid: number; dirty: number }

const MAX = Number.MAX_SAFE_INTEGER

const pathOf = (definition: AggregateDefinition) =>
  definition.op === "count" ? null : `$."${definition.field}"`

const valid = (row: string, field: string) =>
  `(${field} IS NULL OR (json_type(${row}.data, ${field}) = 'integer' AND json_extract(${row}.data, ${field}) BETWEEN -${MAX} AND ${MAX}))`

const amount = (row: string, field: string) =>
  `iif(${field} IS NOT NULL AND ${valid(row, field)}, json_extract(${row}.data,${field}), 0)`

export const openAggregates = (storage: DurableObjectStorage, dataset: DatasetName) => {
  const { sql, kv } = storage
  const source = `docs_${dataset}`
  const definitions = `aggregate_defs_${dataset}`
  const values = `aggregate_values_${dataset}`
  const installed = `aggregates:installed:${dataset}`
  const observed = `aggregates:config:${dataset}`

  const drop = Effect.fnUntraced(function* () {
    if (kv.get<boolean>(installed) !== true) {
      kv.delete(observed)

      return
    }

    for (const event of ["insert", "update", "delete"])
      yield* sql.exec(`DROP TRIGGER IF EXISTS ${definitions}_${event}`)
    yield* sql.exec(`DROP TABLE IF EXISTS ${values}`)
    yield* sql.exec(`DROP TABLE IF EXISTS ${definitions}`)
    kv.delete(installed)
    kv.delete(observed)
  })

  const create = Effect.fnUntraced(function* () {
    if (kv.get<boolean>(installed) === true) return
    yield* sql.exec(
      `CREATE TABLE IF NOT EXISTS ${definitions} (name TEXT PRIMARY KEY, collection TEXT NOT NULL, field TEXT)`,
    )
    yield* sql.exec(`CREATE INDEX ${definitions}_collection ON ${definitions}(collection)`)
    yield* sql.exec(
      `CREATE TABLE IF NOT EXISTS ${values} (name TEXT NOT NULL, author TEXT NOT NULL, n INTEGER NOT NULL, total INTEGER NOT NULL, invalid INTEGER NOT NULL, dirty INTEGER NOT NULL, PRIMARY KEY(name,author))`,
    )
    const added = amount("NEW", "d.field")
    const removed = amount("OLD", "d.field")

    const adding = `INSERT INTO ${values}(name,author,n,total,invalid,dirty)
      SELECT d.name,NEW.author,1,${added},iif(${valid("NEW", "d.field")},0,1),0 FROM ${definitions} d WHERE d.collection=NEW.collection AND NEW.gone=0
      ON CONFLICT(name,author) DO UPDATE SET n=n+1,
      total=iif(dirty=1 OR ABS(total)+ABS(excluded.total)>${MAX},0,total+excluded.total),
      dirty=iif(dirty=1 OR ABS(total)+ABS(excluded.total)>${MAX},1,0),invalid=invalid+excluded.invalid;`

    const removing = `UPDATE ${values} SET n=n-1,
      total=iif(dirty=1 OR ABS(total)+ABS(${removed})>${MAX},0,total-(${removed})),
      dirty=iif(dirty=1 OR ABS(total)+ABS(${removed})>${MAX},1,0),invalid=invalid-iif(${valid("OLD", "d.field")},0,1)
      FROM ${definitions} d WHERE ${values}.name=d.name AND ${values}.author=OLD.author AND d.collection=OLD.collection AND OLD.gone=0;
      DELETE FROM ${values} WHERE author=OLD.author AND n=0;`

    yield* sql.exec(
      `CREATE TRIGGER ${definitions}_insert AFTER INSERT ON ${source} BEGIN ${adding} END`,
    )
    yield* sql.exec(
      `CREATE TRIGGER ${definitions}_update AFTER UPDATE ON ${source} BEGIN ${removing} ${adding} END`,
    )
    yield* sql.exec(
      `CREATE TRIGGER ${definitions}_delete AFTER DELETE ON ${source} BEGIN ${removing} END`,
    )
    kv.put(installed, true)
  })

  return {
    prune: Effect.fnUntraced(function* (declared: Definitions) {
      const signature = JSON.stringify(
        Object.entries(declared).toSorted(([a], [b]) => a.localeCompare(b)),
      )

      if (kv.get<string>(observed) === signature) return

      if (kv.get<boolean>(installed) !== true && Object.keys(declared).length === 0) return
      yield* storage.transaction(
        Effect.gen(function* () {
          if (kv.get<boolean>(installed) === true) {
            const stored = yield* (yield* sql.exec<Stored>(
              `SELECT name,collection,field FROM ${definitions}`,
            )).toArray()

            for (const entry of stored) {
              const next = Object.hasOwn(declared, entry.name) ? declared[entry.name] : undefined

              if (
                next !== undefined &&
                next.collection === entry.collection &&
                pathOf(next) === entry.field
              )
                continue
              yield* sql.exec(`DELETE FROM ${values} WHERE name=?`, entry.name)
              yield* sql.exec(`DELETE FROM ${definitions} WHERE name=?`, entry.name)
            }

            const [left] = yield* (yield* sql.exec<{ n: number }>(
              `SELECT COUNT(*) AS n FROM ${definitions}`,
            )).toArray()

            if (left?.n === 0) yield* drop()
          }

          kv.put(observed, signature)
        }),
      )
    }),
    read: Effect.fn("Aggregates.read")(function* (
      name: string,
      definition: AggregateDefinition,
      owner: string | null,
      checkStorage: () => Effect.Effect<void, Refused>,
    ): Effect.fn.Return<AggregateResult, Refused> {
      return yield* storage.transaction(
        Effect.gen(function* () {
          yield* create()

          const [stored] = yield* (yield* sql.exec<Stored>(
            `SELECT name,collection,field FROM ${definitions} WHERE name=?`,
            name,
          )).toArray()

          const field = pathOf(definition)

          if (
            stored === undefined ||
            stored.collection !== definition.collection ||
            stored.field !== field
          ) {
            yield* sql.exec(`DELETE FROM ${values} WHERE name=?`, name)
            yield* sql.exec(
              `INSERT INTO ${definitions}(name,collection,field) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET collection=excluded.collection,field=excluded.field`,
              name,
              definition.collection,
              field,
            )
            const v = amount("s", "d.field")
            yield* sql.exec(
              `INSERT INTO ${values}(name,author,n,total,invalid,dirty)
            SELECT d.name,s.author,COUNT(*),iif(TOTAL(ABS(${v}))>${MAX},0,CAST(TOTAL(${v}) AS INTEGER)),SUM(iif(${valid("s", "d.field")},0,1)),iif(TOTAL(ABS(${v}))>${MAX},1,0)
            FROM ${source} s JOIN ${definitions} d ON d.collection=s.collection WHERE d.name=? AND s.gone=0 GROUP BY s.author`,
              name,
            )
            yield* checkStorage()
          }

          const rows = yield* (yield* sql.exec<Total>(
            `SELECT n,total,invalid,dirty FROM ${values} WHERE name=? AND (? IS NULL OR author=?)`,
            name,
            owner,
            owner,
          )).toArray()

          const count = rows.reduce((n, row) => n + row.n, 0)

          if (definition.op === "count") return { count, value: count, approximate: false }

          if (rows.some((row) => row.invalid !== 0))
            return yield* new Refused({
              message: `aggregate "${name}" requires safe integer values in ${definition.collection}.${definition.field}; fix missing, fractional or nonnumeric values, or read the source records instead`,
            })
          let exact = rows.reduce((n, row) => n + BigInt(row.total), 0n)

          if (rows.some((row) => row.dirty !== 0)) {
            const parts = yield* (yield* sql.exec<{ value: number }>(
              `SELECT json_extract(data,?) AS value FROM ${source} WHERE collection=? AND gone=0 AND (? IS NULL OR author=?)`,
              field,
              definition.collection,
              owner,
              owner,
            )).toArray()

            exact = parts.reduce((n, row) => n + BigInt(row.value), 0n)
          }

          const value = Number(exact)

          if (!Number.isFinite(value))
            return yield* new Refused({
              message: `aggregate "${name}" is too large to return as a number; read a smaller set of source records`,
            })

          return { count, value, approximate: !Number.isSafeInteger(value) }
        }),
      )
    }),
    drop,
  }
}
