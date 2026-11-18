// What an app's files may be and how they're served (runtime/files.ts stores them): a size as a person reads it, and the types a
// browser may show in place. Everything else is a download, and every file is served nosniff in a sandbox, so a file someone
// uploaded (an SVG or HTML with a script, say) never runs as the app.
import * as Config from "effect/Config"
import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Whether apps' pages may upload files (OPENBELT_UPLOADS=on|off; off by default): who may read a file, limits per workspace, taking one
 * down and backing them up are still open (docs/running.md "Files"). Off, an upload or delete is refused, the files already
 * stored are still read, and nothing an agent reads (the MCP instructions, the docs tool, app_info) mentions uploads.
 */
export const UPLOADS = Config.Literals(["on", "off"], "OPENBELT_UPLOADS").pipe(
  Config.withDefault("off" as const),
)

const KB = 1024

const MB = 1024 * KB

/** "1.2 MB": a size as a person reads it. */
export const sizeOf = (bytes: number) => {
  if (bytes < KB) return `${bytes} B`

  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`

  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`

  return `${(bytes / 1024 / MB).toFixed(2)} GB`
}

/** The types a browser shows in place; anything else downloads (Content-Disposition: attachment). */
const SHOWN = /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/|application\/pdf$|text\/plain)/

/** The headers a file is served with: its type, never sniffed, sandboxed, cached for good (its id never names other bytes). */
export const fileHeaders = (id: string, type: string) => {
  const headers = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    "cache-control": "private, max-age=31536000, immutable",
    etag: `"${id}"`,
    "accept-ranges": "bytes",
  }

  return SHOWN.test(type) ? headers : { ...headers, "content-disposition": "attachment" }
}

/** The most `ctx.files.read` hands a function (it crosses into the sandbox whole, and a fetch sends at most as much). */
export const FILE_READ_BYTES = 10 * MB

/** How long a signed file url works: an hour unless the function says, a week at most. */
export const FILE_URL_MS = { default: 60 * 60 * 1000, most: 7 * 24 * 60 * 60 * 1000 } as const

/** What a signed url signs: the file's key in the store (workspace, app, id) and when it stops working, in seconds since 1970. */
const signed = (secretsKey: string, key: string, expires: number) =>
  createHmac("sha256", `openbelt file url\n${secretsKey}`)
    .update(`${key}\n${expires}`)
    .digest("base64url")

/** The query a file's url carries to be read by anyone who has it, until `expires` (seconds since 1970): `?expires=…&sig=…`. */
export const fileUrlQuery = (secretsKey: string, key: string, expires: number) =>
  `expires=${expires}&sig=${signed(secretsKey, key, expires)}`

/** Whether `expires` and `sig` from a url sign the file at `key` and haven't run out. */
export const fileUrlValid = (
  secretsKey: string,
  key: string,
  expires: string | null,
  sig: string | null,
) => {
  if (expires === null || sig === null || !/^\d{1,12}$/.test(expires)) return false

  if (Number(expires) * 1000 < Date.now()) return false

  const want = Buffer.from(signed(secretsKey, key, Number(expires)))
  const got = Buffer.from(sig)

  return want.length === got.length && timingSafeEqual(want, got)
}
