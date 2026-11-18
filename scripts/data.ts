// OpenBelt's data, the directory every object's SQLite file is in (OPENBELT_DATA; runtime/localdb.ts): `bun run data backup|restore`.
//   backup <dest> [--data <dir>]     a copy of it in <dest>, taken while the platform runs
//   restore <backup> [--data <dir>]  a backup put back as it, the platform stopped (what was there is set aside beside it)
//   restore-backup <url> <dir>       a replicated backup (OPENBELT_BACKUP_URL, runtime/replicate.ts) made into a data directory <dir>
// --data defaults to OPENBELT_DATA, or ~/.openbelt/data (bun run dev's). A standby is a restore into the standby's own directory.
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { dlopen, FFIType } from "bun:ffi"
import { Database } from "bun:sqlite"
import { exitWithParent } from "../packages/platform/src/runtime/lifeline.ts"
import { dataDir } from "../packages/platform/src/runtime/localdb.ts"
import {
  decode,
  SoonestJob,
  storeOf,
  type WakeRow,
  WakeRows,
} from "../packages/platform/src/runtime/replicate.ts"

const LOCK_EX = 2

const LOCK_UN = 8

/**
 * `work` holding the snapshot lock (<data>/.snapshot.lock) exclusively: no platform checkpoints or closes an object's file
 * meanwhile (runtime/localdb-worker.ts), so each database file stays as it was while its WAL only grows, and a copy of the two,
 * file by file, is one the next open recovers like a crash's: nothing acknowledged before the copy began is lost.
 */
const holdingObjects = <A>(data: string, work: () => A): A => {
  const lock = join(data, ".snapshot.lock")

  if (!existsSync(lock)) closeSync(openSync(lock, "a"))

  const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })

  const fd = openSync(lock, "r")

  try {
    libc.symbols.flock(fd, LOCK_EX)

    try {
      return work()
    } finally {
      libc.symbols.flock(fd, LOCK_UN)
    }
  } finally {
    closeSync(fd)
    libc.close()
  }
}

/** `from` copied to `to`: a clone where the filesystem can (APFS, btrfs, XFS), so gigabytes take milliseconds; otherwise whole. */
const copy = (from: string, to: string) => {
  const made = Bun.spawnSync(
    process.platform === "darwin"
      ? ["cp", "-c", "-R", from, to]
      : ["cp", "-a", "--reflink=auto", from, to],
    { stderr: "pipe" },
  )

  if (made.exitCode !== 0) {
    rmSync(to, { recursive: true, force: true })
    throw new Error(`couldn't copy ${from} to ${to}: ${made.stderr.toString().trim()}`)
  }
}

/**
 * Each namespace's wake files (<namespace>/.wakes-<process>.sqlite, runtime/actor.ts) copied again, each as one moment's: the
 * platform checkpoints them on its own (they aren't under the snapshot lock), so the file-by-file copy may have caught one between
 * its database and its WAL. SQLite reads a consistent copy beside the platform's writes (VACUUM INTO).
 */
const copyWakeFiles = (data: string, dest: string) => {
  for (const namespace of readdirSync(data, { withFileTypes: true })) {
    if (!namespace.isDirectory()) continue

    for (const file of readdirSync(join(data, namespace.name))) {
      if (!file.startsWith(".wakes-") || !file.endsWith(".sqlite")) continue

      const to = join(dest, namespace.name, file)

      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${to}${suffix}`, { force: true })

      const db = new Database(join(data, namespace.name, file), { readonly: true })

      try {
        db.query("VACUUM INTO ?").run(to)
      } finally {
        db.close()
      }
    }
  }
}

/** A copy of the data in `dest` (made whole, then moved into place: a backup with a BACKUP.json is complete). */
export const backup = (data: string, dest: string) => {
  if (!existsSync(data)) throw new Error(`no data at ${data}`)

  if (existsSync(dest)) throw new Error(`${dest} exists: a backup is not overwritten`)

  const partial = `${dest}.partial-${process.pid}`
  const began = performance.now()

  holdingObjects(data, () => copy(data, partial))
  rmSync(join(partial, ".snapshot.lock"), { force: true })
  copyWakeFiles(data, partial)
  writeFileSync(
    join(partial, "BACKUP.json"),
    JSON.stringify({ from: data, at: new Date().toISOString() }),
  )
  renameSync(partial, dest)

  return Math.round(performance.now() - began)
}

/** A backup put back as the data, the data that was there set aside beside it (never deleted). Only while no platform runs on it. */
export const restore = (from: string, data: string) => {
  if (!existsSync(join(from, "BACKUP.json")))
    throw new Error(`${from} is not a backup (no BACKUP.json)`)

  const aside =
    existsSync(data) && readdirSync(data).length > 0
      ? `${data}.before-restore-${Date.now()}`
      : undefined

  if (aside !== undefined) renameSync(data, aside)
  else rmSync(data, { recursive: true, force: true })

  mkdirSync(resolve(data, ".."), { recursive: true })
  copy(from, data)
  rmSync(join(data, "BACKUP.json"), { force: true })

  return aside
}

/**
 * The data back from a replicated backup (OPENBELT_BACKUP_URL; runtime/replicate.ts) into `data`, an empty or missing directory: for
 * each file, its newest snapshot with the frames captured after it written over it in order (a frame is a page; a commit frame says
 * how long the file is), then SQLite's integrity check. The wake files are made again from each object's __jobs (actor.ts).
 */
export const restoreBackup = async (url: string, data: string) => {
  if (existsSync(data) && readdirSync(data).length > 0)
    throw new Error(`${data} is not empty: restore into a new directory`)

  const began = performance.now()
  const store = storeOf(url)
  const names = (await store.list()).toSorted()

  const files = new Map<
    string,
    Array<ReturnType<typeof decode>[number] & { readonly batch: number }>
  >()

  let next = 0

  await Promise.all(
    Array.from({ length: 32 }, async () => {
      for (let at = next++; at < names.length; at = next++) {
        // oxlint-disable-next-line no-await-in-loop -- 32 at a time
        const pieces = decode(await store.get(names[at] ?? ""))

        for (const piece of pieces) {
          const list = files.get(piece.db) ?? []

          list.push({ ...piece, batch: at })
          files.set(piece.db, list)
        }
      }
    }),
  )

  const fetched = performance.now() - began

  type Wake = WakeRow

  const wakes = new Map<string, Map<string, Wake>>()
  const taken: Array<{ readonly namespace: string; readonly rows: ReadonlyArray<Wake> }> = []
  const bad: Array<string> = []

  for (const [db, list] of files) {
    list.sort((a, b) => a.time - b.time || a.batch - b.batch || a.seq - b.seq)

    const last = list.at(-1)

    if (last?.kind === "wakes") {
      taken.push({ namespace: dirname(db), rows: WakeRows(Buffer.from(last.data).toString()) })
      continue
    }

    const base = list.findLastIndex((p) => p.kind === "snapshot")
    const snapshot = list[base]

    if (snapshot === undefined) {
      bad.push(`${db}: no snapshot`)
      continue
    }

    const path = join(data, db)

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, snapshot.data)

    const fd = openSync(path, "r+")

    try {
      for (const piece of list.slice(base + 1)) {
        if (piece.kind !== "frames" || piece.pageSize === undefined) continue

        const frame = 24 + piece.pageSize
        const bytes = Buffer.from(piece.data.buffer, piece.data.byteOffset, piece.data.byteLength)

        for (let at = 0; at + frame <= bytes.length; at += frame) {
          const page = bytes.readUInt32BE(at)
          const size = bytes.readUInt32BE(at + 4)

          writeSync(fd, bytes, at + 24, piece.pageSize, (page - 1) * piece.pageSize)

          if (size !== 0) ftruncateSync(fd, size * piece.pageSize)
        }
      }
    } finally {
      closeSync(fd)
    }

    const sqlite = new Database(path)

    try {
      const ok = sqlite.query("PRAGMA integrity_check").values()[0]?.[0]

      if (ok !== "ok") bad.push(`${db}: ${String(ok)}`)

      const hasJobs = sqlite
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__jobs'")
        .values()

      if (hasJobs.length > 0) {
        const at = SoonestJob(sqlite.query("SELECT MIN(run_at) FROM __jobs").values()[0]?.[0])

        // The object it holds: any piece but backUpAll's says.
        const named = list.find((p) => p.cls !== "")

        if (at !== null && named !== undefined) {
          const { cls, name } = named
          const rows = wakes.get(dirname(db)) ?? new Map<string, Wake>()

          rows.set(`${cls}/${name}`, { key: `${cls}/${name}`, cls, name, at })
          wakes.set(dirname(db), rows)
        }
      }
    } finally {
      sqlite.close()
    }
  }

  // The wake rows taken with every file once, for objects no later piece names (one that did is set from its own jobs above).
  for (const { namespace, rows } of taken) {
    const into = wakes.get(namespace) ?? new Map<string, Wake>()

    for (const row of rows) if (!into.has(row.key)) into.set(row.key, row)

    wakes.set(namespace, into)
  }

  for (const [namespace, rows] of wakes) {
    const index = new Database(join(data, namespace, ".wakes-0.sqlite"))

    index.exec(
      "CREATE TABLE IF NOT EXISTS wakes (key TEXT PRIMARY KEY, cls TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL)",
    )

    const insert = index.query(
      "INSERT OR REPLACE INTO wakes (key, cls, name, at) VALUES (?, ?, ?, ?)",
    )

    index.transaction(() => {
      for (const row of rows.values()) insert.run(row.key, row.cls, row.name, row.at)
    })()
    index.close()
  }

  return {
    batches: names.length,
    files: files.size,
    bad,
    fetchMs: Math.round(fetched),
    ms: Math.round(performance.now() - began),
  }
}

if (import.meta.main) {
  exitWithParent()

  const [command = "", target = "", ...rest] = process.argv.slice(2)
  const at = rest.indexOf("--data")
  const data = resolve(at === -1 ? dataDir() : (rest[at + 1] ?? ""))

  if (command === "backup" && target !== "") {
    const ms = backup(data, resolve(target))

    console.log(`backed up ${data} to ${resolve(target)} in ${ms} ms`)
  } else if (command === "restore" && target !== "") {
    const aside = restore(resolve(target), data)

    console.log(
      `restored ${resolve(target)} as ${data}${aside === undefined ? "" : `; what was there is in ${aside}`}`,
    )
  } else if (command === "restore-backup" && target !== "" && rest[0] !== undefined) {
    const done = await restoreBackup(target, resolve(rest[0]))

    console.log(JSON.stringify(done))

    if (done.bad.length > 0) process.exit(1)
  } else {
    console.error(
      "usage: bun run data backup <dest> [--data <dir>] | restore <backup> [--data <dir>] | restore-backup <url> <dir>",
    )
    process.exit(2)
  }
}
