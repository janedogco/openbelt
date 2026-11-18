// A thread that runs objects' SQLite files for the process (runtime/localdb.ts): bun:sqlite is synchronous, and a commit's fsync, a
// write waiting on the filesystem's journal, or a wait for another process's lock blocked the whole event loop (a lab at 500 req/s:
// 35% of the main thread's time in fsync and write, /_health taking seconds). Here they block only this thread. Messages in order:
// open, exec, close, checkpoint; each answered by id.
import { Database } from "bun:sqlite"
import { dlopen, FFIType } from "bun:ffi"
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs"
import { dirname } from "node:path"

declare const self: Worker

type Open = {
  readonly op: "open"
  readonly id: number
  readonly key: string
  readonly path: string
  /** FULL: each commit synced; SECOND: commits synced together about once a second (syncWritten). */
  readonly sync: "FULL" | "SECOND"
  readonly waitMs: number
  /** Backed up (runtime/replicate.ts): its file's path under the data directory, and the object it holds, else undefined. */
  readonly backup?: { readonly rel: string; readonly cls: string; readonly name: string }
  readonly lock: string
}

type Exec = {
  readonly op: "exec"
  readonly id: number
  readonly key: string
  readonly query: string
  readonly bindings: ReadonlyArray<unknown>
}

type Close = {
  readonly op: "close"
  readonly id: number
  readonly key: string
  readonly lock: string
}

type Checkpoint = { readonly op: "checkpoint"; readonly id: number; readonly lock: string }

/** A snapshot of every backed-up file that changed since its last (runtime/replicate.ts, every few minutes). */
type Snapshots = { readonly op: "snapshots"; readonly id: number; readonly lock: string }

type Message = (Open | Exec | Close | Checkpoint | Snapshots) & { readonly timed?: true }

const open = new Map<string, Database>()

/** Each open file's path, for its WAL's sync. */
const paths = new Map<string, string>()

/** Files with commits not yet synced to disk (sync SECOND). */
const unsynced = new Set<string>()

/** Writes since each file's last checkpoint. */
const written = new Map<string, number>()

const CHECKPOINT_EVERY = 1000

/**
 * What the backup has of each backed-up file: the WAL bytes read so far (offset, in the generation salt names) and whether it
 * changed since its last snapshot. Each commit's new WAL frames go out after it (capture), a snapshot is the file itself after a
 * checkpoint that empties the WAL (snapshot); a restore is the newest snapshot with the frames after it replayed in order.
 */
type Backed = {
  readonly path: string
  readonly rel: string
  readonly cls: string
  readonly name: string
  salt: string | undefined
  offset: number
  changed: boolean
}

const backed = new Map<string, Backed>()

/** One piece of a backup for runtime/replicate.ts: a file's new WAL frames, or a snapshot of the file. */
const send = (
  b: Backed,
  kind: "frames" | "snapshot",
  data: Uint8Array<ArrayBuffer>,
  pageSize: number | undefined,
) =>
  self.postMessage(
    {
      backup: {
        db: b.rel,
        cls: b.cls,
        name: b.name,
        kind,
        time: Date.now(),
        pageSize,
        data,
      },
    },
    [data.buffer],
  )

const WAL_HEADER = 32

const FRAME_HEADER = 24

/**
 * The frames committed since the last capture, read from the WAL right after a commit (this thread holds the file: nothing writes
 * meanwhile). Only whole transactions go out: up to the last commit frame (one whose header gives the database's size), never the
 * frames of a rolled-back transaction a later one overwrites. A checkpoint that emptied the WAL starts it again under a new salt:
 * reading starts over at its first frame.
 */
const capture = (key: string) => {
  const b = backed.get(key)

  if (b === undefined) return

  let fd: number

  try {
    fd = openSync(`${b.path}-wal`, "r")
  } catch {
    return
  }

  try {
    const size = fstatSync(fd).size

    if (size < WAL_HEADER) return

    const header = Buffer.alloc(WAL_HEADER)

    readSync(fd, header, 0, WAL_HEADER, 0)

    const pageSize = header.readUInt32BE(8)
    const salt = header.subarray(16, 24).toString("hex")

    if (salt !== b.salt) {
      b.salt = salt
      b.offset = WAL_HEADER
    }

    if (size <= b.offset) return

    const length = size - b.offset
    const read = Buffer.alloc(length)

    readSync(fd, read, 0, length, b.offset)

    const frame = FRAME_HEADER + pageSize
    let end = 0

    for (let at = 0; at + frame <= length; at += frame) {
      // A frame of an older generation, past the new one's end: stop.
      if (read.subarray(at + 8, at + 16).toString("hex") !== salt) break

      if (read.readUInt32BE(at + 4) !== 0) end = at + frame
    }

    if (end === 0) return

    send(b, "frames", new Uint8Array(read.subarray(0, end)), pageSize)
    b.offset += end
    b.changed = true
  } finally {
    closeSync(fd)
  }
}

/** The file whole, its WAL checkpointed into it and emptied first: the base a restore replays later frames onto. */
const snapshot = (key: string) => {
  const b = backed.get(key)
  const db = open.get(key)

  if (b === undefined || db === undefined) return

  capture(key)
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  send(b, "snapshot", new Uint8Array(readFileSync(b.path)), undefined)
  b.salt = undefined
  b.offset = WAL_HEADER
  b.changed = false
}

const LOCK_SH = 1

const LOCK_NB = 4

const LOCK_UN = 8

const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})

/** A value bun:sqlite binds: null for a missing one, bytes as a Uint8Array (it refuses a bare ArrayBuffer and undefined). */
const bindable = (v: unknown) =>
  v === undefined
    ? null
    : v instanceof ArrayBuffer
      ? new Uint8Array(v)
      : ArrayBuffer.isView(v) && !(v instanceof Uint8Array)
        ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
        : v

// SAFETY: every value bindable gives back is one bun:sqlite binds (string, number, bigint, boolean, null, Uint8Array).
const bindings = (values: ReadonlyArray<unknown>) => values.map(bindable) as Array<never>

const setUp = (db: Database, message: Open) => {
  db.exec(`PRAGMA busy_timeout = ${message.waitMs}`)
  db.exec("PRAGMA locking_mode = EXCLUSIVE")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`PRAGMA synchronous = ${message.sync === "FULL" ? "FULL" : "NORMAL"}`)
  // Checkpoints are this thread's, never SQLite's own: a backup copies each file's database and its WAL, which only hold together if
  // no checkpoint rewrites the database between the two copies (checkpointAll, under the snapshot lock).
  db.exec("PRAGMA wal_autocheckpoint = 0")
}

const openFile = (message: Open) => {
  mkdirSync(dirname(message.path), { recursive: true })

  const db = new Database(message.path, { create: true, strict: false })

  setUp(db, message)

  // The lock now (a write takes it; EXCLUSIVE keeps it until close): fail here, not mid-event, if another process holds the file.
  db.exec("BEGIN IMMEDIATE")
  db.exec("COMMIT")
  open.set(message.key, db)
  written.set(message.key, 0)

  if (message.sync === "SECOND") paths.set(message.key, message.path)

  if (message.backup !== undefined) {
    backed.set(message.key, {
      path: message.path,
      ...message.backup,
      salt: undefined,
      offset: WAL_HEADER,
      changed: false,
    })
    // The file as it opened (after what a crash left in its WAL is recovered): every later frame applies onto it.
    underLock(message.lock, true, () => snapshot(message.key))
  }
}

const exec = (message: Exec) => {
  const db = open.get(message.key)

  // wording: SQLite's own, for a database closed under a call
  if (db === undefined) throw new Error("Database is closed")

  const statement = db.query(message.query)

  const args = bindings(message.bindings)

  if (statement.columnNames.length > 0) {
    // SAFETY: values() returns one array of column values per row, in columnNames' order.
    const rows = statement.values(...args) as Array<Array<unknown>>

    // A write outside a transaction (INSERT ... RETURNING) committed on its own: its frames go now, not with a later COMMIT.
    if (!db.inTransaction) capture(message.key)

    return { columns: statement.columnNames, rows }
  }

  const ran = statement.run(...args)

  // wording: the statement sql.ts sends to end a transaction, not an error
  if (/^\s*COMMIT\b/i.test(message.query)) {
    const count = (written.get(message.key) ?? 0) + 1

    written.set(message.key, count)

    if (paths.has(message.key)) unsynced.add(message.key)
  }

  // Every commit's frames, a COMMIT's or a statement's on its own (outside a transaction) alike.
  if (!db.inTransaction) capture(message.key)

  return { columns: [], rows: [], changes: ran.changes }
}

/** Run `f` holding the snapshot lock shared (`wait`: until a snapshot lets go; otherwise skip and say so with undefined). */
const underLock = <A>(lock: string, wait: boolean, f: () => A): A | undefined => {
  if (!existsSync(lock)) closeSync(openSync(lock, "a"))

  const fd = openSync(lock, "r")

  try {
    if (libc.symbols.flock(fd, wait ? LOCK_SH : LOCK_SH | LOCK_NB) !== 0) return undefined

    try {
      return f()
    } finally {
      libc.symbols.flock(fd, LOCK_UN)
    }
  } finally {
    closeSync(fd)
  }
}

const closeFile = (key: string, lock: string) => {
  const db = open.get(key)

  if (db === undefined) return

  // Closing checkpoints the WAL into the database (the last connection's close does): not while a snapshot copies the files. A
  // backed-up file that changed since its last snapshot gets one first, so the process that opens it next starts from it.
  underLock(lock, true, () => {
    if (backed.get(key)?.changed === true) snapshot(key)

    db.close(false)
  })

  open.delete(key)
  written.delete(key)
  paths.delete(key)
  unsynced.delete(key)
  backed.delete(key)
}

/** Checkpoint the files with enough writes, unless a snapshot holds the lock (then next time). */
const checkpointAll = (lock: string) =>
  underLock(lock, false, () => {
    let done = 0

    for (const [key, db] of open) {
      if ((written.get(key) ?? 0) < CHECKPOINT_EVERY) continue

      db.exec("PRAGMA wal_checkpoint(PASSIVE)")
      written.set(key, 0)
      done++
    }

    return done
  }) ?? 0

/**
 * Sync the WAL of every file committed to since the last time: what makes its commits survive a power cut. One sync per file a
 * second at most, however many commits it had (a closed file's close checkpointed and synced it already).
 */
const syncWritten = () => {
  for (const key of unsynced) {
    unsynced.delete(key)

    const path = paths.get(key)

    if (path === undefined || !existsSync(`${path}-wal`)) continue

    try {
      const fd = openSync(`${path}-wal`, "r")

      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // gone with a checkpoint or a close meanwhile: those synced it
    }
  }
}

setInterval(syncWritten, 1000)

const handle = (message: Message): unknown => {
  if (message.op === "exec") return exec(message)

  if (message.op === "checkpoint") return checkpointAll(message.lock)

  if (message.op === "snapshots")
    return (
      underLock(message.lock, false, () => {
        let done = 0

        for (const [key, b] of backed) {
          if (!b.changed) continue

          snapshot(key)
          done++
        }

        return done
      }) ?? 0
    )

  if (message.op === "open") openFile(message)
  else closeFile(message.key, message.lock)

  return null
}

self.addEventListener("message", (event: MessageEvent<Message>) => {
  const message = event.data

  const started = message.timed === true ? performance.timeOrigin + performance.now() : undefined

  const timing = () =>
    started === undefined ? {} : { started, finished: performance.timeOrigin + performance.now() }

  try {
    const result = handle(message)

    postMessage({ id: message.id, ok: true, result, ...timing() })
  } catch (error) {
    postMessage({
      id: message.id,
      ok: false,
      ...timing(),
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
