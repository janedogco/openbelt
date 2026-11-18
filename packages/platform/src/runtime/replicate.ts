// Backups of every object's SQLite off the machine (OPENBELT_BACKUP_URL): file:///<dir>, or s3://<bucket>/<prefix>?endpoint=<url>
// with OPENBELT_BACKUP_KEY_ID and OPENBELT_BACKUP_SECRET (Backblaze B2, MinIO, any S3). Each database thread sends a file's new WAL
// frames after every commit and, when it opens, closes or changed in the last few minutes, a snapshot of it (localdb-worker.ts).
// This process gathers them and uploads one batch every OPENBELT_BACKUP_SECONDS (1): one PUT a second however many files changed,
// and no listing while it runs. Litestream watched each file on its own: at 20,000 files it held 8.6 GB and 120,000 open files,
// uploaded nothing, and listed each file's copy every 17 s (about $3,000 a month of B2 class C calls). A batch nothing needs any more
// (every file in it has a newer snapshot) is deleted. Asynchronous: a commit never waits for the upload, so losing the machine loses
// at most the last interval or so. `bun run data restore-backup` puts the files back (scripts/data.ts).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { S3Client } from "bun"
import { Schema } from "effect"
import { say } from "./observe.ts"
import { positive } from "./settings.ts"

/** One piece from a database thread: a file's new WAL frames, or the file whole. */
export type Piece = {
  readonly db: string
  readonly cls: string
  readonly name: string
  /** wakes: a wake file's rows as JSON (backUpAll), for the objects whose snapshots don't name them. */
  readonly kind: "frames" | "snapshot" | "wakes"
  readonly time: number
  readonly pageSize: number | undefined
  readonly data: Uint8Array
}

const WakeRowSchema = Schema.Struct({
  key: Schema.String,
  cls: Schema.String,
  name: Schema.String,
  at: Schema.Number,
})

/** A wake file's row (actor.ts wakeRow), as backUpAll sends a wake file's rows. */
export type WakeRow = typeof WakeRowSchema.Type

export const WakeRows = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(WakeRowSchema)))

/** An object's soonest job (jobs.ts __jobs), null with none. */
export const SoonestJob = Schema.decodeUnknownSync(Schema.NullOr(Schema.Number))

/** Where batches go: put, get, list, delete by name. */
export type Store = {
  readonly put: (name: string, data: Uint8Array) => Promise<void>
  readonly get: (name: string) => Promise<Uint8Array>
  readonly list: () => Promise<ReadonlyArray<string>>
  readonly delete: (name: string) => Promise<void>
}

export const storeOf = (url: string): Store => {
  if (url.startsWith("file://")) {
    const dir = new URL(url).pathname

    return {
      put: async (name, data) => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `.${name}.partial`), data)
        renameSync(join(dir, `.${name}.partial`), join(dir, name))
      },
      get: async (name) => new Uint8Array(readFileSync(join(dir, name))),
      list: async () => {
        try {
          return readdirSync(dir).filter((name) => !name.startsWith("."))
        } catch {
          return []
        }
      },
      delete: async (name) => rmSync(join(dir, name), { force: true }),
    }
  }

  const parsed = new URL(url)
  const prefix = parsed.pathname.replace(/^\/+/, "").replace(/\/*$/, "/").replace(/^\/$/, "")

  const endpoint = parsed.searchParams.get("endpoint")
  const region = parsed.searchParams.get("region")

  const client = new S3Client({
    bucket: parsed.hostname,
    ...(endpoint === null ? {} : { endpoint }),
    ...(region === null ? {} : { region }),
    accessKeyId: process.env["OPENBELT_BACKUP_KEY_ID"] ?? "",
    secretAccessKey: process.env["OPENBELT_BACKUP_SECRET"] ?? "",
  })

  return {
    put: async (name, data) => {
      await client.write(`${prefix}${name}`, data)
    },
    get: async (name) => await client.file(`${prefix}${name}`).bytes(),
    list: async () => {
      const names: Array<string> = []
      let token: string | undefined

      do {
        // oxlint-disable-next-line no-await-in-loop -- pages in order
        const page = await client.list({
          prefix,
          ...(token === undefined ? {} : { continuationToken: token }),
        })

        for (const item of page.contents ?? []) names.push(item.key.slice(prefix.length))

        token = page.isTruncated === true ? page.nextContinuationToken : undefined
      } while (token !== undefined)

      return names
    },
    delete: async (name) => {
      await client.delete(`${prefix}${name}`)
    },
  }
}

// A batch: gzip of records, each a u32 header length, its JSON header, a u32 data length and the data.

type Header = Omit<Piece, "data"> & { readonly seq: number }

const encode = (pieces: ReadonlyArray<Piece & { readonly seq: number }>) => {
  const parts: Array<Uint8Array> = []

  for (const { data, ...header } of pieces) {
    const json = Buffer.from(JSON.stringify(header))
    const lengths = Buffer.alloc(4)

    lengths.writeUInt32BE(json.length)
    parts.push(lengths, json)

    const size = Buffer.alloc(4)

    size.writeUInt32BE(data.length)
    parts.push(size, data)
  }

  return Bun.gzipSync(Buffer.concat(parts))
}

export const decode = (batch: Uint8Array): Array<Header & { readonly data: Uint8Array }> => {
  const raw = Buffer.from(Bun.gunzipSync(new Uint8Array(batch)))
  const out: Array<Header & { readonly data: Uint8Array }> = []

  for (let at = 0; at < raw.length;) {
    const headerLength = raw.readUInt32BE(at)
    // SAFETY: encode wrote this JSON from a Header.
    const header = JSON.parse(raw.subarray(at + 4, at + 4 + headerLength).toString()) as Header

    at += 4 + headerLength

    const dataLength = raw.readUInt32BE(at)

    out.push({ ...header, data: raw.subarray(at + 4, at + 4 + dataLength) })
    at += 4 + dataLength
  }

  return out
}

/** A batch's name: when it was made, so names sort in time order, and which process made it. */
const batchName = (at: number, seq: number) =>
  `${String(at).padStart(14, "0")}-${hostname()}-${process.pid}-${seq}.batch`

const url = process.env["OPENBELT_BACKUP_URL"] ?? ""

export const backingUp = url !== ""

const SECONDS = positive("OPENBELT_BACKUP_SECONDS", 1)

/** How often a file that changed gets a snapshot, at the most: a restore replays at most this long of its frames. */
export const SNAPSHOT_SECONDS = positive("OPENBELT_BACKUP_SNAPSHOT_SECONDS", 300)

let pending: Array<Piece & { readonly seq: number }> = []

let seq = 0

let batches = 0

/** The batches this process made that something may still need, oldest first, and the files each holds. */
const kept: Array<{ readonly name: string; readonly dbs: ReadonlySet<string> }> = []

/** The batch each file's newest snapshot is in. */
const newestSnapshot = new Map<string, string>()

/** What this process sent, said once a minute: what a bucket charges for (puts, deletes, bytes) and how far behind it is. */
const sent = { puts: 0, deletes: 0, bytes: 0, pieces: 0, failures: 0, slowestMs: 0 }

export const collect = (piece: Piece) => {
  startUploading()
  pending.push({ ...piece, seq: seq++ })
}

/**
 * Every file in the data directory once, before any process opens one (the supervisor, at start): a file only goes out when
 * opened, and most of 20,000 objects sleep for days. Again only when OPENBELT_BACKUP_URL changes (<data>/.backup-base says which it
 * was taken for). Each file is opened (what a crash left in its WAL recovered), emptied of its WAL and read; the wake files' rows
 * go with them, since an object never opened since doesn't say which object it is. Batches of about 32 MB.
 */
export const backUpAll = async (data: string) => {
  if (!backingUp) return

  const marker = join(data, ".backup-base")

  if (existsSync(marker) && readFileSync(marker, "utf8") === url) return

  const began = performance.now()
  const store = storeOf(url)
  let batch: Array<Piece & { readonly seq: number }> = []
  let size = 0
  let files = 0
  let made = 0

  const flush = async () => {
    if (batch.length === 0) return

    await store.put(batchName(Date.now(), made++), encode(batch))
    batch = []
    size = 0
  }

  for (const namespace of existsSync(data) ? readdirSync(data) : []) {
    const dir = join(data, namespace)

    if (namespace.startsWith(".") || !statSync(dir).isDirectory()) continue

    for (const file of readdirSync(dir)) {
      if (file.startsWith(".wakes-") && file.endsWith(".sqlite")) {
        const wakes = new Database(join(dir, file), { readonly: true })
        const rows = wakes.query("SELECT key, cls, name, at FROM wakes").all()

        wakes.close()
        batch.push({
          db: join(namespace, file),
          cls: "",
          name: "",
          kind: "wakes",
          time: Date.now(),
          pageSize: undefined,
          data: new Uint8Array(Buffer.from(JSON.stringify(rows))),
          seq: seq++,
        })
        continue
      }

      if (!file.endsWith(".sqlite") || file.startsWith(".")) continue

      const path = join(dir, file)

      // A file closed cleanly has no WAL (closing checkpointed it); one a crash left has, recovered by an open.
      if (existsSync(`${path}-wal`)) {
        const db = new Database(path)

        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        db.close()
      }

      const bytes = new Uint8Array(readFileSync(path))

      batch.push({
        db: join(namespace, file),
        cls: "",
        name: "",
        kind: "snapshot",
        time: Date.now(),
        pageSize: undefined,
        data: bytes,
        seq: seq++,
      })
      files++
      size += bytes.length

      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      if (size > 32 * 1024 * 1024) await flush()
    }
  }

  await flush()
  writeFileSync(marker, url)
  say("info", `backup: every file once, ${files} files in ${made} batches`, {
    ms: Math.round(performance.now() - began),
  })
}

/** Delete the batches no file needs: each file in it has a snapshot in a later batch, and none has its newest snapshot in it. */
const prune = async (store: Store) => {
  const order = new Map(kept.map((k, i) => [k.name, i]))
  const homes = new Set(newestSnapshot.values())

  const done = kept.filter(
    (k, i) =>
      !homes.has(k.name) &&
      [...k.dbs].every((db) => (order.get(newestSnapshot.get(db) ?? "") ?? -1) > i),
  )

  for (const k of done) {
    // oxlint-disable-next-line no-await-in-loop -- one after another, few
    await store.delete(k.name).catch(() => undefined)
    sent.deletes++
    kept.splice(kept.indexOf(k), 1)
  }
}

let uploading = false

/** The uploader, from the first piece on (a platform process's; never the supervisor's or a script's). */
const startUploading = () => {
  if (uploading || !backingUp) return

  uploading = true

  const store = storeOf(url)
  let busy = false
  let failures = 0

  const upload = async () => {
    if (busy || pending.length === 0) return

    busy = true

    const taking = pending

    pending = []

    const name = batchName(Date.now(), batches++)

    try {
      const began = performance.now()
      const batch = encode(taking)

      await store.put(name, batch)
      sent.puts++
      sent.bytes += batch.length
      sent.pieces += taking.length
      sent.slowestMs = Math.max(sent.slowestMs, Math.round(performance.now() - began))
      failures = 0
      kept.push({ name, dbs: new Set(taking.map((p) => p.db)) })

      for (const p of taking) if (p.kind === "snapshot") newestSnapshot.set(p.db, name)

      await prune(store)
    } catch (error) {
      // Sent again with the next batch: nothing is dropped, the loss window only grows meanwhile.
      pending = [...taking, ...pending]
      failures++
      sent.failures++

      if (failures === 1 || failures % 30 === 0)
        say("warn", `backup: couldn't upload a batch (${failures} in a row); keeping it`, {
          said: String(error).slice(0, 300),
        })
    } finally {
      busy = false
    }
  }

  setInterval(() => void upload(), SECONDS * 1000).unref()

  setInterval(() => {
    if (sent.puts + sent.failures === 0) return

    say("info", "backup: the last minute", {
      ...sent,
      kept: kept.length,
      waiting: pending.length,
    })
    Object.assign(sent, { puts: 0, deletes: 0, bytes: 0, pieces: 0, failures: 0, slowestMs: 0 })
  }, 60_000).unref()

  say("info", `backup: every ${SECONDS} s to ${url.replace(/\?.*$/, "")}`, {})
}
