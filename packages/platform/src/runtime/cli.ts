// The openbelt CLI's builds this platform hands out (/install, /_cli/*; docs/cli.md): openbelt-<target>[.exe] in
// OPENBELT_CLI_DIR, which the image fills from its cli stage (the Dockerfile) and a checkout fills with
// `bun run cli:dist`. A build is known by its bytes' sha256, which is how `openbelt update` tells it has another.
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { text } from "./settings.ts"

/** The platforms a CLI is built for, as Rust names them. */
export const CLI_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-pc-windows-gnu",
] as const

export type CliTarget = (typeof CLI_TARGETS)[number]

const DIR = text("OPENBELT_CLI_DIR", join(import.meta.dir, "../../../../cli/dist"))

export type CliBuild = {
  readonly file: string
  readonly bytes: Uint8Array
  readonly sha256: string
}

const seen = new Map<string, { readonly stamp: string; readonly build: CliBuild }>()

/** A target's file name: openbelt-<target>, with .exe for Windows. */
export const cliFile = (target: CliTarget) =>
  `openbelt-${target}${target.includes("windows") ? ".exe" : ""}`

/** The build for `target` this platform has, read again when its file changes; undefined when it has none. */
export const cliBuild = (target: CliTarget): CliBuild | undefined => {
  const file = cliFile(target)
  const path = join(DIR, file)

  try {
    const stat = statSync(path)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const known = seen.get(file)

    if (known?.stamp === stamp) return known.build

    const bytes = readFileSync(path)
    const build = { file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") }

    seen.set(file, { stamp, build })

    return build
  } catch {
    return undefined
  }
}
