// Cargo for every checkout of this repository: one build directory (cargo's build-dir: dependencies, intermediates) in the
// shared git directory, so a worktree builds on what the others built, and each checkout's finished binary in its own
// cli/target (2 MB). A cold build of the CLI is about 50 s and 220 MB a checkout; a checkout after another, 20 s and 2 MB.
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

const commonDir = Bun.spawnSync(
  ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: ROOT },
)
  .stdout.toString()
  .trim()

/** Where cargo builds: inside the repository's .git, which every worktree shares and which goes when the clone goes. */
export const CARGO_BUILD =
  commonDir === "" ? join(ROOT, "cli/target") : join(commonDir, "cargo-build")

/** The environment every cargo call of ours runs with. */
export const cargoEnv = () => ({ ...process.env, CARGO_BUILD_BUILD_DIR: CARGO_BUILD })

// Cargo decides a crate is up to date by its source files' times, not by which checkout they're in: on one shared build
// directory, a checkout whose files were older than another's last build got that build (its binary, its clippy pass). A value
// of the checkout's own, given to the openbelt crate alone (its dependencies stay shared), keeps each checkout's build apart.
/** rustc's flags for the openbelt crate built from this checkout: after `--` of `cargo rustc` or `cargo clippy`. */
export const checkoutFlags = (checkout: string) => [
  "-C",
  `metadata=${Bun.hash(resolve(checkout)).toString(36)}`,
]

const TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-gnu",
} as const satisfies Record<string, string>

/** This machine's Rust target, as the CLI's builds are named, or undefined on a platform none is built for. */
export const hostTarget = Object.entries(TARGETS).find(
  ([platform]) => platform === `${process.platform}-${process.arch}`,
)?.[1]

const exe = process.platform === "win32" ? ".exe" : ""

/** This checkout's copy of this machine's CLI (bun run cli:dist), where the platform hands it out. */
export const cliDist = (checkout: string) =>
  join(checkout, "cli/dist", `openbelt-${hostTarget ?? "unknown"}${exe}`)

/** The release binary `cargo rustc --release --bin openbelt -- ...checkoutFlags(checkout)` made from that checkout. */
export const releaseBuild = (checkout: string) =>
  join(checkout, "cli/target/release", `openbelt${exe}`)

/** What a CLI build is made from: the crate's sources and lockfile, the scripts that build it, and the compiler. The same
 * value means the same binary, so a cli/dist binary stamped with it (cliDistSource) needs no new build: verify skips the
 * minute-long release build in CI when cli/ didn't change (the CI workflow caches cli/dist by the same inputs). */
export const cliSource = (checkout: string) => {
  const hash = new Bun.CryptoHasher("sha256")

  const files = [
    "cli/Cargo.toml",
    "cli/Cargo.lock",
    "scripts/cargo.ts",
    "scripts/cli-dist.ts",
    ...[...new Bun.Glob("cli/src/**").scanSync({ cwd: checkout })].toSorted(),
  ]

  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(checkout, file)))

  hash.update(Bun.spawnSync(["rustc", "-vV"]).stdout)

  return hash.digest("hex")
}

/** The stamp beside a cli/dist binary: the cliSource it was built from. */
export const cliDistSource = (checkout: string) => `${cliDist(checkout)}.source`
