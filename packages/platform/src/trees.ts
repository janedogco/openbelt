import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import { FUNCTION_LIMITS, HOLD_UNREADABLE } from "./functions.ts"

const KEEP_MS = HOLD_UNREADABLE.giveUpMs + 24 * 3600_000

export type Tree = {
  readonly id: string
  readonly root: string
  runs: number
  calls: number
  requests: number
  reruns: number
}

type Row = {
  root: string
  runs: number
  calls: number
  requests: number
  reruns: number
  pending: number
}

export const openTrees = Effect.fn("Trees.open")(function* (storage: DurableObjectStorage) {
  const { sql } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS call_trees (
    id TEXT PRIMARY KEY, root TEXT NOT NULL, runs INTEGER NOT NULL, calls INTEGER NOT NULL,
    requests INTEGER NOT NULL, reruns INTEGER NOT NULL, pending INTEGER NOT NULL,
    at INTEGER NOT NULL)`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS call_trees_at ON call_trees (at)")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS call_tree_settled (
    tree TEXT NOT NULL, job TEXT NOT NULL, PRIMARY KEY (tree, job))`)

  const forget = (where: string, ...args: Array<string | number>) =>
    Effect.andThen(
      sql.exec(
        `DELETE FROM call_tree_settled WHERE tree IN (SELECT id FROM call_trees WHERE ${where})`,
        ...args,
      ),
      sql.exec(`DELETE FROM call_trees WHERE ${where}`, ...args),
    )

  const held = new Map<string, { tree: Tree; holders: number; stored: boolean }>()

  const save = (tree: Tree, pending: number) =>
    sql.exec(
      `INSERT INTO call_trees (id, root, runs, calls, requests, reruns, pending, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET runs = excluded.runs, calls = excluded.calls,
         requests = excluded.requests, reruns = excluded.reruns,
         pending = call_trees.pending + excluded.pending, at = excluded.at`,
      tree.id,
      tree.root,
      tree.runs,
      tree.calls,
      tree.requests,
      tree.reruns,
      pending,
      Date.now(),
    )

  return {
    start: (root: string): Tree => {
      const tree: Tree = {
        id: crypto.randomUUID(),
        root,
        runs: 1,
        calls: 0,
        requests: 0,
        reruns: 0,
      }

      held.set(tree.id, { tree, holders: 1, stored: false })

      return tree
    },

    book: Effect.fnUntraced(function* (tree: Tree) {
      if (tree.runs >= FUNCTION_LIMITS.tree.runs) return false

      tree.runs += 1

      const entry = held.get(tree.id)

      if (entry !== undefined) entry.stored = true

      yield* forget("at < ?", Date.now() - KEEP_MS)
      yield* save(tree, 1)

      return true
    }),

    claim: Effect.fnUntraced(function* (id: string, fn: string) {
      const entry = held.get(id)

      if (entry !== undefined) {
        entry.holders += 1

        return entry.tree
      }

      const [row] = yield* (yield* sql.exec<Row>(
        "SELECT root, runs, calls, requests, reruns, pending FROM call_trees WHERE id = ?",
        id,
      )).toArray()

      if (row === undefined) {
        const tree: Tree = { id, root: fn, runs: 1, calls: 0, requests: 0, reruns: 0 }

        held.set(id, { tree, holders: 1, stored: false })

        return tree
      }

      const tree: Tree = {
        id,
        root: row.root,
        runs: row.runs,
        calls: row.calls,
        requests: row.requests,
        reruns: row.reruns,
      }

      held.set(id, { tree, holders: 1, stored: true })

      return tree
    }),

    settled: Effect.fnUntraced(function* (id: string, job: string) {
      const first = yield* (yield* sql.exec(
        `INSERT INTO call_tree_settled (tree, job)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM call_trees WHERE id = ?)
         ON CONFLICT DO NOTHING RETURNING tree`,
        id,
        job,
        id,
      )).toArray()

      if (first.length === 0) return

      yield* sql.exec("UPDATE call_trees SET pending = MAX(pending - 1, 0) WHERE id = ?", id)
    }),

    release: Effect.fnUntraced(function* (tree: Tree) {
      const entry = held.get(tree.id)

      if (entry === undefined) return

      entry.holders -= 1

      if (entry.holders > 0) return

      held.delete(tree.id)

      if (!entry.stored) return

      const [row] = yield* (yield* sql.exec<{ pending: number }>(
        "SELECT pending FROM call_trees WHERE id = ?",
        tree.id,
      )).toArray()

      if (row === undefined || row.pending <= 0) yield* forget("id = ?", tree.id)
      else yield* save(tree, 0)
    }),
  }
})
