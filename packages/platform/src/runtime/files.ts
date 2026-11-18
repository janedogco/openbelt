// Where apps' files live (files.ts holds what's allowed): a folder on this machine's disk (<data>/<namespace>/files/), or an
// S3-compatible bucket (OPENBELT_FILES=s3://key:secret@host/bucket, R2 and MinIO too). The gateway streams uploads and downloads
// through it; no object ever holds the bytes. Memory stays bounded either way: Bun's own S3 writer and reader buffer a fast or
// slow peer's whole file (1 GB: 2.6 GB of RSS), so uploads are multipart here, 8 MB at a time, and downloads ranges, 4 ahead.
import { AwsClient } from "aws4fetch"
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hostNamespace } from "./actor.ts"
import { dataDir } from "./localdb.ts"
import { say } from "./observe.ts"
import { positive, text } from "./settings.ts"

export type Stored = { readonly size: number; readonly type: string }

export type FileStore = {
  readonly kind: "disk" | "s3"
  /** Streams `body` in as `key`; refuses (and keeps nothing) past `max` bytes or when fewer than `expected` arrive. */
  readonly put: (
    key: string,
    body: ReadableStream<Uint8Array>,
    type: string,
    expected: number,
    max: number,
  ) => Promise<{ size: number; sha256: string } | StoreFailure>
  readonly head: (key: string) => Promise<Stored | null>
  /** The bytes from `start` to `end` inclusive (or all). */
  readonly read: (key: string, start?: number, end?: number) => ReadableStream<Uint8Array>
  readonly remove: (key: string) => Promise<void>
  /** What uploads left half done, older than `ms`, removed (a disk's temporary files, a bucket's unfinished multipart uploads): how many. */
  readonly sweep: (ms: number) => Promise<number>
}

const MB = 1024 * 1024

/** Why an upload kept nothing: the client stopped sending, it sent more than allowed, or the store failed. */
export type FileFailed = "cut_off" | "too_large" | "store_error"

class Stopped extends Error {
  constructor(
    readonly failed: FileFailed,
    message: string,
  ) {
    super(message)
  }
}

/** The body's chunks; a read that fails (the client went away) is the client's doing, not the store's. */
async function* chunksOf(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()

  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>

    try {
      next = await reader.read()
    } catch (error) {
      throw new Stopped(
        "cut_off",
        `the connection closed (${error instanceof Error ? error.message : String(error)})`,
      )
    }

    if (next.done) return

    yield next.value
  }
}

/**
 * Why a write to the store kept nothing: `failed` says whose doing; for the store's own, `store` is what it said (its HTTP status
 * and S3 error code, like 403 SignatureDoesNotMatch or 404 NoSuchBucket) or "unreachable" when nothing answered.
 */
export type StoreFailure = {
  readonly failed: FileFailed
  readonly error: string
  readonly store?: { readonly status: number; readonly code: string } | "unreachable"
}

/** A store's refusal: its HTTP status and the <Code> of its S3 error body. */
class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    body: string,
  ) {
    super(`storage answered ${status} ${code}: ${body.slice(0, 300)}`)
  }
}

const failure = (error: unknown): StoreFailure => {
  if (error instanceof Stopped) return { failed: error.failed, error: error.message }

  if (error instanceof Refused)
    return {
      failed: "store_error",
      error: error.message,
      store: { status: error.status, code: error.code },
    }

  // Anything else on the way to a store is the network: fetch rejects only when nothing answered.
  return {
    failed: "store_error",
    error: error instanceof Error ? error.message : String(error),
    store: "unreachable",
  }
}

/** Where the disk store keeps files: the namespace's folder, known once the host has started. */
const root = () => join(dataDir(), hostNamespace(), "files")

/** A store's answer, or an error with its status and what it said. */
const ok = async (response: Response) => {
  if (response.ok) return response

  const body = await response.text()

  throw new Refused(response.status, /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "", body)
}

/** A key's file in the disk store. */
const pathOf = (key: string) => join(root(), key)

const disk = (): FileStore => {
  const path = pathOf

  return {
    kind: "disk",
    put: async (key, body, type, expected, max) => {
      const final = path(key)
      const temp = join(root(), ".partial", crypto.randomUUID())

      await mkdir(dirname(temp), { recursive: true })
      await mkdir(dirname(final), { recursive: true })

      const writer = Bun.file(temp).writer()
      const hasher = new Bun.CryptoHasher("sha256")
      let size = 0

      try {
        for await (const chunk of chunksOf(body)) {
          size += chunk.length

          if (size > max) throw new Stopped("too_large", `files are limited to ${max} bytes`)

          hasher.update(chunk)
          // A FileSink takes the chunk at once (a number) or once its buffer drains (a promise): waiting is the backpressure.
          await writer.write(chunk)

          if (size % (8 * MB) < chunk.length) await writer.flush()
        }

        await writer.end()

        if (size !== expected) throw new Stopped("cut_off", `${size} of ${expected} bytes arrived`)

        await Bun.write(`${final}.type`, type)
        await rename(temp, final)

        return { size, sha256: hasher.digest("hex") }
      } catch (error) {
        await Promise.resolve(writer.end()).catch(() => {})
        await rm(temp, { force: true })

        return failure(error)
      }
    },
    head: async (key) => {
      const found = await stat(path(key)).catch(() => null)

      if (found === null) return null

      return { size: found.size, type: await Bun.file(`${path(key)}.type`).text() }
    },
    read: (key, start, end) =>
      (start === undefined
        ? Bun.file(path(key))
        : Bun.file(path(key)).slice(start, (end ?? 0) + 1)
      ).stream(),
    remove: async (key) => {
      await rm(path(key), { force: true })
      await rm(`${path(key)}.type`, { force: true })
    },
    sweep: async (ms) => {
      const partial = join(root(), ".partial")
      const names = await readdir(partial).catch(() => [])
      let removed = 0

      for (const name of names) {
        const found = await stat(join(partial, name)).catch(() => null)

        if (found !== null && Date.now() - found.mtimeMs > ms) {
          await rm(join(partial, name), { force: true })
          removed++
        }
      }

      return removed
    },
  }
}

const s3 = (url: URL): FileStore => {
  const client = new Bun.S3Client({
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
    endpoint: `${url.searchParams.get("tls") === "off" ? "http" : "https"}://${url.host}`,
    bucket: url.pathname.replace(/^\//, ""),
    region: url.searchParams.get("region") ?? "auto",
  })

  // Bun's S3 writer buffers a fast request body whole (1 GB in: 2.6 GB RSS), so uploads are our own multipart: 8 MB parts, up
  // to PARALLEL in flight, the request body read only as parts go out.
  const aws = new AwsClient({
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
    service: "s3",
    region: url.searchParams.get("region") ?? "auto",
  })

  const base = `${url.searchParams.get("tls") === "off" ? "http" : "https"}://${url.host}${url.pathname.replace(/\/?$/, "/")}`
  const PART = 8 * MB
  const PARALLEL = 3

  return {
    kind: "s3",
    put: async (key, body, type, expected, max) => {
      const hasher = new Bun.CryptoHasher("sha256")
      let size = 0

      if (expected <= PART) {
        try {
          const chunks: Array<Uint8Array> = []

          for await (const chunk of chunksOf(body)) {
            size += chunk.length

            if (size > expected)
              throw new Stopped("too_large", `more than the ${expected} bytes it said`)

            chunks.push(chunk)
          }

          if (size !== expected)
            throw new Stopped("cut_off", `${size} of ${expected} bytes arrived`)

          const bytes = new Uint8Array(size)
          let at = 0

          for (const chunk of chunks) {
            bytes.set(chunk, at)
            at += chunk.length
          }

          await ok(
            await aws.fetch(base + key, {
              method: "PUT",
              body: bytes,
              headers: { "content-type": type },
            }),
          )

          return { size, sha256: hasher.update(bytes).digest("hex") }
        } catch (error) {
          return failure(error)
        }
      }

      let started: string

      try {
        started = await (
          await ok(
            await aws.fetch(`${base}${key}?uploads`, {
              method: "POST",
              headers: { "content-type": type },
            }),
          )
        ).text()
      } catch (error) {
        return failure(error)
      }

      const uploadId = encodeURIComponent(/<UploadId>([^<]+)<\/UploadId>/.exec(started)?.[1] ?? "")
      const etags: Array<string> = []
      const flying = new Set<Promise<void>>()
      let part = 0

      const send = async (bytes: Uint8Array<ArrayBuffer>) => {
        const n = ++part

        const sending = (async () => {
          const response = await ok(
            await aws.fetch(`${base}${key}?partNumber=${n}&uploadId=${uploadId}`, {
              method: "PUT",
              body: bytes,
            }),
          )

          etags[n - 1] = response.headers.get("etag") ?? ""
        })()

        flying.add(sending)
        void sending.finally(() => flying.delete(sending)).catch(() => {})

        if (flying.size >= PARALLEL) await Promise.race(flying)
      }

      try {
        let buffer = new Uint8Array(PART)
        let fill = 0

        for await (const chunk of chunksOf(body)) {
          size += chunk.length

          if (size > max) throw new Stopped("too_large", `files are limited to ${max} bytes`)

          hasher.update(chunk)

          for (let at = 0; at < chunk.length;) {
            const take = Math.min(PART - fill, chunk.length - at)

            buffer.set(chunk.subarray(at, at + take), fill)
            fill += take
            at += take

            if (fill === PART) {
              await send(buffer)
              buffer = new Uint8Array(PART)
              fill = 0
            }
          }
        }

        if (size !== expected) throw new Stopped("cut_off", `${size} of ${expected} bytes arrived`)

        if (fill > 0) await send(buffer.subarray(0, fill))

        await Promise.all(flying)

        const parts = etags.map(
          (etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
        )

        await ok(
          await aws.fetch(`${base}${key}?uploadId=${uploadId}`, {
            method: "POST",
            body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
          }),
        )

        return { size, sha256: hasher.digest("hex") }
      } catch (error) {
        await Promise.allSettled(flying)
        await aws.fetch(`${base}${key}?uploadId=${uploadId}`, { method: "DELETE" }).catch(() => {})

        return failure(error)
      }
    },
    head: async (key) => {
      const found = await client
        .file(key)
        .stat()
        .catch(() => null)

      return found === null ? null : { size: found.size, type: found.type }
    },
    // Bun's S3 stream reads ahead of a slow client without limit (1 GB to a 100 MB/s client: 2.4 GB RSS): ranges of 8 MB, each
    // asked for only when the client has taken the last.
    read: (key, start = 0, end) => {
      let at = start
      let known = end
      const ahead: Array<Promise<Uint8Array>> = []

      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            known ??= (await client.file(key).stat()).size - 1
            const last = known

            while (ahead.length < 4 && at <= last) {
              const upTo = Math.min(at + PART, last + 1)

              ahead.push(client.file(key).slice(at, upTo).bytes())
              at = upTo
            }

            const next = ahead.shift()

            if (next === undefined) return controller.close()

            controller.enqueue(await next)
          },
        },
        { highWaterMark: 0 },
      )
    },
    remove: async (key) => {
      await client.delete(key)
    },
    sweep: async (ms) => {
      const listed = await (await ok(await aws.fetch(`${base}?uploads`))).text()
      let removed = 0

      for (const [, upload = ""] of listed.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
        const key = /<Key>([^<]+)<\/Key>/.exec(upload)?.[1]
        const id = /<UploadId>([^<]+)<\/UploadId>/.exec(upload)?.[1]
        const initiated = Date.parse(/<Initiated>([^<]+)<\/Initiated>/.exec(upload)?.[1] ?? "")

        if (key !== undefined && id !== undefined && Date.now() - initiated > ms) {
          await aws.fetch(`${base}${key}?uploadId=${encodeURIComponent(id)}`, { method: "DELETE" })
          removed++
        }
      }

      return removed
    },
  }
}

const configured = text("OPENBELT_FILES", "")

export const fileStore: FileStore = configured.startsWith("s3://")
  ? s3(new URL(configured))
  : disk()

const hours = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)

  if (!Number.isFinite(value) || value <= 0)
    throw new Error(
      `the setting ${name}=${process.env[name] ?? ""} isn't one OpenBelt can use: a number of hours above 0`,
    )

  return Math.round(value * 3_600_000)
}

const mb = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)

  if (!Number.isFinite(value) || value < 0)
    throw new Error(
      `the setting ${name}=${process.env[name] ?? ""} isn't one OpenBelt can use: a number of megabytes`,
    )

  return Math.round(value * MB)
}

export const dataLimits = {
  app: mb("OPENBELT_DATA_APP_MB", 1024),
  versions: mb("OPENBELT_VERSIONS_APP_MB", 256),
  workspace: mb("OPENBELT_DATA_WORKSPACE_MB", 10 * 1024),
  floor: mb("OPENBELT_DATA_DISK_FLOOR_MB", 1024),
}

let dataFree: { readonly at: number; readonly bytes: number | undefined } = {
  at: 0,
  bytes: undefined,
}

export const dataDiskFree = async (): Promise<number | undefined> => {
  if (Date.now() - dataFree.at < 1000) return dataFree.bytes

  const fs = await statfs(join(dataDir(), hostNamespace())).catch(() => undefined)

  dataFree = { at: Date.now(), bytes: fs === undefined ? undefined : fs.bavail * fs.bsize }

  return dataFree.bytes
}

/** The limits on apps' files: one file's size, a workspace's total (0: none), the disk's free space kept, uploads at once here. */
export const fileLimits = {
  file: mb("OPENBELT_FILES_MAX_MB", 100),
  workspace: mb("OPENBELT_FILES_WORKSPACE_MB", 10 * 1024),
  floor: mb("OPENBELT_FILES_DISK_FLOOR_MB", 2048),
  inFlight: positive("OPENBELT_FILES_IN_FLIGHT", 16),
  orphanMs: hours("OPENBELT_FILES_ORPHAN_HOURS", 24),
}

/**
 * Every OPENBELT_FILES_SWEEP_SECONDS (an hour), what uploads left half done more than a day ago goes: a process that died
 * mid-upload leaves a disk's temporary file, or a bucket's multipart upload, that nothing else removes. Each process sweeps; a
 * second sweep of the same leftovers finds them gone.
 */
export const sweepStoreEvery = () => {
  const every = positive("OPENBELT_FILES_SWEEP_SECONDS", 3600) * 1000
  // A day: a slow upload (100 MB over a poor link) can run for an hour or more, and must not lose its parts under it.
  const olderThan = Math.min(86_400_000, fileLimits.orphanMs)

  const sweep = async () => {
    try {
      const removed = await fileStore.sweep(olderThan)

      if (removed > 0)
        say("info", `files: ${removed} upload(s) left half done removed from the store`, {
          removed,
        })
    } catch (error) {
      say(
        "warn",
        `files: sweeping the store failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  setInterval(() => void sweep(), every).unref()
}

/** Bytes free where the disk store writes, or undefined on S3 (the bucket's limits are its own). */
export const diskFree = async (): Promise<number | undefined> => {
  if (fileStore.kind !== "disk") return undefined

  const data = join(dataDir(), hostNamespace())

  await mkdir(data, { recursive: true })

  const fs = await statfs(data)

  return fs.bavail * fs.bsize
}

/** What a store's refusal means for OPENBELT_FILES, in front of what it said. */
const fixFor = (put: StoreFailure) => {
  const said = put.error.slice(0, 200)

  if (put.store === "unreachable")
    return `nothing answered at the host in OPENBELT_FILES: check its name and port, and ?tls=off for a plain-HTTP one (${said})`

  if (put.store?.code === "NoSuchBucket" || put.store?.code === "InvalidBucketName")
    return `there's no such bucket: make it, or fix the bucket's name, the path in OPENBELT_FILES (${said})`

  if (put.store?.status === 401 || put.store?.status === 403)
    return `the access key or secret in OPENBELT_FILES is wrong, or the key may not write to this bucket (${said})`

  return said
}

/**
 * The store can be written, read and emptied, or why not, naming the part to fix: checked when the platform starts, so a wrong
 * OPENBELT_FILES stops it with a line saying so instead of failing each upload.
 */
export const checkFileStore = async (): Promise<string | undefined> => {
  const key = `.openbelt-check/${crypto.randomUUID()}`

  const where =
    fileStore.kind === "s3"
      ? `the bucket in OPENBELT_FILES (${new URL(configured).host}${new URL(configured).pathname})`
      : `the disk under ${join(dataDir(), hostNamespace(), "files")}`

  try {
    const put = await fileStore.put(key, new Blob(["ok"]).stream(), "text/plain", 2, 2)

    if ("error" in put) return `OpenBelt couldn't write a file to ${where}: ${fixFor(put)}`

    const back = await new Response(fileStore.read(key)).text()

    if (back !== "ok")
      return `OpenBelt wrote a file to ${where} but read back ${JSON.stringify(back.slice(0, 40))}`

    await fileStore.remove(key)

    return undefined
  } catch (error) {
    return `OpenBelt couldn't use ${where}: ${error instanceof Error ? error.message : String(error)}`
  }
}
