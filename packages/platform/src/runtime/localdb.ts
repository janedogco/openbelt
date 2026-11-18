// Each object's SQLite is a file on this machine: <data>/<namespace>/<object id>.sqlite, opened by the process that owns the object
// (actor.ts). Where: OPENBELT_DATA, by default ~/.openbelt/data; compose puts it on a volume. A backup or snapshot of that directory is a
// backup of every workspace's data (scripts/data.ts).
//
// The files run on worker threads (localdb-worker.ts): a commit's fsync and a wait for another process's lock block a thread, not the
// event loop. Each file is locked while open (EXCLUSIVE), so a deploy's other slot waits for this one to let go and never opens it
// twice.
//
// Durability (OPENBELT_LOCAL_DB_SYNC): by default a commit is written to the file's WAL but not synced to disk on its own (SQLite's
// synchronous NORMAL), and each file written to is synced about once a second (localdb-worker.ts). A process that crashes loses
// nothing acknowledged; a kernel panic or a power cut loses at most about the last second, less than a standby loses with the whole
// machine (docs/running.md). Every object is its own file, so syncing each commit was a disk sync per write: at 500 req/s about
// 2,000 a second, the disk the limit (a lab: p99 over 1 s, up to 18% errors in a minute; synced once a second, 0-0.02%). FULL syncs
// each commit instead.
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { dbContext, now as dbNow, type DbContext, type DbTiming } from "./db-observe.ts"
import { recordDb, say } from "./observe.ts"
import { backingUp, collect, SNAPSHOT_SECONDS, type Piece } from "./replicate.ts"
import { positive } from "./settings.ts"
import type { RawDb, RawResult } from "./sql.ts"

const dir =
  (process.env["OPENBELT_DATA"] ?? "") === ""
    ? join(homedir(), ".openbelt", "data")
    : (process.env["OPENBELT_DATA"] ?? "")

/** Where objects' files live. */
export const dataDir = (): string => dir

/** The lock a backup holds while it copies: no file is checkpointed or closed meanwhile (scripts/data.ts). */
const snapshotLockOf = (data: string) => join(data, ".snapshot.lock")

const sync =
  (process.env["OPENBELT_LOCAL_DB_SYNC"] ?? "SECOND").toUpperCase() === "FULL" ? "FULL" : "SECOND"

const WAIT_MS = positive("OPENBELT_LOCAL_DB_WAIT_MS", 15_000)

/** App database threads per process; control objects have one additional thread. */
const THREADS = positive("OPENBELT_DB_THREADS", 4)

type Reply = { readonly started?: number; readonly finished?: number } & (
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string }
)

let workers: ReadonlyArray<Worker> | undefined

let next = 0

const waiting = new Map<
  number,
  {
    readonly resolve: (v: unknown) => void
    readonly reject: (e: Error) => void
    readonly at: number
    readonly op: unknown
    readonly key: unknown
    readonly observation:
      | {
          readonly context: DbContext
          readonly sent: number
          readonly sqlQueueMs: number
        }
      | undefined
  }
>()

/** Requests a thread hasn't answered in 10 s, said every 10 s: a stuck file or thread shows here, not as a silent hang. */
const STUCK_MS = 10_000

const pool = () => {
  if (workers !== undefined) return workers

  const made = Array.from({ length: THREADS + 1 }, (_, index) => {
    const worker = new Worker(new URL("./localdb-worker.ts", import.meta.url))

    worker.addEventListener(
      "message",
      (event: MessageEvent<Reply | { readonly backup: Piece }>) => {
        if ("backup" in event.data) return collect(event.data.backup)

        const reply = event.data
        const waiter = waiting.get(reply.id)

        if (waiter === undefined) return

        waiting.delete(reply.id)

        const observation = waiter.observation

        if (
          observation !== undefined &&
          reply.started !== undefined &&
          reply.finished !== undefined
        ) {
          const received = dbNow()

          const timing: DbTiming = {
            queueMs: Math.max(0, reply.started - observation.sent),
            executionMs: Math.max(0, reply.finished - reply.started),
            transportMs: Math.max(0, received - reply.finished),
            sqlQueueMs: observation.sqlQueueMs,
          }

          recordDb(
            observation.context.parent,
            String(waiter.op),
            index,
            observation.sent,
            received,
            timing,
            reply.ok,
          )
        }

        if (reply.ok) waiter.resolve(reply.result)
        else waiter.reject(new Error(reply.error))
      },
    )

    worker.addEventListener("error", (event) => {
      say("error", `localdb: a database thread failed: ${event.message}`, {})
    })

    return worker
  })

  workers = made

  const lock = snapshotLockOf(dataDir())

  // Each thread checkpoints its busy files now and then, between snapshots (localdb-worker.ts).
  setInterval(() => {
    for (const worker of made) void ask(worker, { op: "checkpoint", lock }).catch(() => undefined)

    const now = Date.now()
    const stuck = [...waiting.values()].filter((w) => now - w.at > STUCK_MS)

    if (stuck.length > 0)
      say("warn", `localdb: ${stuck.length} request(s) unanswered for over ${STUCK_MS / 1000} s`, {
        oldest: stuck
          .map((w) => `${String(w.op)} ${String(w.key)} ${Math.round((now - w.at) / 1000)} s`)
          .slice(0, 5),
      })
  }, 5000).unref()

  // Each thread snapshots the backed-up files that changed since their last, so a restore replays at most this long of frames.
  if (backingUp)
    setInterval(() => {
      for (const worker of made) void ask(worker, { op: "snapshots", lock }).catch(() => undefined)
    }, SNAPSHOT_SECONDS * 1000).unref()

  return made
}

const workerOf = (actorId: string, cls: string) => {
  const all = pool()

  let h = 0

  for (let i = 0; i < actorId.length; i++) h = (h * 31 + actorId.charCodeAt(i)) >>> 0

  const index = cls === "ApexDO" || cls === "WorkspaceDO" || cls === "McpDO" ? THREADS : h % THREADS

  // SAFETY: the pool has THREADS app workers and one control worker at index THREADS.
  return all[index] as Worker
}

const ask = (worker: Worker, message: Record<string, unknown>) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++next

    const context = dbContext.getStore()
    const sent = context === undefined ? undefined : dbNow()

    const observation =
      context === undefined || sent === undefined
        ? undefined
        : {
            context,
            sent,
            sqlQueueMs: context.dispatched ? 0 : Math.max(0, sent - context.enqueued),
          }

    if (context !== undefined) context.dispatched = true

    waiting.set(id, {
      resolve,
      reject,
      at: Date.now(),
      op: message["op"],
      key: message["key"],
      observation,
    })
    worker.postMessage({ ...message, id, ...(sent === undefined ? {} : { timed: true }) })
  })

/** The object's database file, opened and locked for this process; backed up when OPENBELT_BACKUP_URL is set (replicate.ts). */
export const openLocal = async (
  namespace: string,
  actorId: string,
  object: { readonly cls: string; readonly name: string },
): Promise<RawDb> => {
  const rel = join(namespace, `${actorId}.sqlite`)
  const path = join(dataDir(), rel)
  const worker = workerOf(actorId, object.cls)

  mkdirSync(join(dataDir(), namespace), { recursive: true })

  const began = performance.now()

  await ask(worker, {
    op: "open",
    key: actorId,
    path,
    sync,
    waitMs: WAIT_MS,
    lock: snapshotLockOf(dataDir()),
    backup: backingUp ? { rel, ...object } : undefined,
  })

  const waited = performance.now() - began

  if (waited > 50)
    say("warn", `localdb: ${actorId} waited ${Math.round(waited)} ms to open its file`, {
      actor: actorId,
    })

  return {
    execute: async (query, bindings = []): Promise<RawResult> => {
      try {
        // SAFETY: the worker answers an exec with a RawResult (localdb-worker.ts exec).
        return (await ask(worker, { op: "exec", key: actorId, query, bindings })) as RawResult
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} (in: ${query.slice(0, 120)})`,
          {
            cause: error,
          },
        )
      }
    },
  }
}

/** Close the object's file (it went to sleep, or this process is stopping): the lock goes with it. */
export const closeLocal = (actorId: string, cls: string) =>
  ask(workerOf(actorId, cls), {
    op: "close",
    key: actorId,
    lock: snapshotLockOf(dataDir()),
  }).catch(() => undefined)
