// What every checkout's idle siblings leave on the disk, cleared without anyone asking: bun run dev, verify and check call
// tidy(), which once a day removes the build output (cargo targets, verify runs and data, fallow's cache) of each worktree of
// this repository untouched for a week. Only what a command makes again: never a worktree, a branch, a commit or a change.
// Then, when the disk is nearly full, one line says so and what to run. bun run worktrees tidy does it now, whatever the day.
import {
  existsSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

const DAY = 86_400_000

/** A worktree with no commit, checkout, verify run or dev log this long is idle. */
const IDLE_DAYS = 7

/** Below this much free disk, every call says so. */
const LOW_DISK_GB = 20

/** Folders a worktree makes again by itself: its cargo target (all of a build, before scripts/cargo.ts), fallow's cache. */
const REMADE = ["cli/target", ".fallow"]

/** What in .verify stays: design-score's judged rounds (climb/), which cost model calls to make again. */
const KEPT_IN_VERIFY = new Set(["climb"])

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore" })
    .stdout.toString()
    .trim()

const mtime = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : 0)

/** When anyone last did something there: a commit or checkout (its HEAD's reflog), a verify run, a dev server's log line. */
const lastActivity = (path: string) => {
  const dev = join(path, ".dev")

  return Math.max(
    Number(
      /\{(\d+)\}/.exec(git(path, "log", "-g", "-1", "--format=%gd", "--date=unix", "HEAD"))?.[1] ??
        0,
    ) * 1000,
    mtime(join(path, ".verify")),
    mtime(dev),
    ...(existsSync(dev) ? readdirSync(dev).map((f) => mtime(join(dev, f))) : []),
  )
}

/** The folders some running process works in (a dev server, a kept platform, a shell, an editor): their worktrees are in use. */
const workingDirs = () =>
  Bun.which("lsof") === null
    ? []
    : Bun.spawnSync(["lsof", "-d", "cwd", "-Fn"], { stdin: "ignore", stderr: "ignore" })
        .stdout.toString()
        .split("\n")
        .flatMap((line) => (line.startsWith("n") ? [line.slice(1)] : []))

/** The build output of a worktree that can go, with its size in KB (none of it is shared, so du's size is what goes). */
const remade = (path: string) => {
  const packages = join(path, "packages")

  const targets = existsSync(packages)
    ? readdirSync(packages).map((p) => `packages/${p}/target`)
    : []

  const verify = join(path, ".verify")

  const runs = existsSync(verify)
    ? readdirSync(verify).flatMap((f) => (KEPT_IN_VERIFY.has(f) ? [] : [`.verify/${f}`]))
    : []

  return [...REMADE, ...runs, ...targets].flatMap((rel) => {
    const dir = join(path, rel)

    return existsSync(dir)
      ? [
          {
            dir,
            kb: Number(Bun.spawnSync(["du", "-sk", dir]).stdout.toString().split(/\s/)[0] ?? 0),
          },
        ]
      : []
  })
}

const gb = (kb: number) =>
  kb < 1024 * 1024 ? `${Math.round(kb / 1024)} MB` : `${(kb / 1024 / 1024).toFixed(1)} GB`

/** Each idle worktree's build output removed: the lines say what went. */
const clearIdle = () => {
  const others = git(ROOT, "worktree", "list", "--porcelain")
    .split("\n")
    .flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []))

  const busy = workingDirs()

  return others.flatMap((path) => {
    if (path === ROOT || !existsSync(path)) return []

    const real = realpathSync(path)

    if (busy.some((cwd) => cwd === real || cwd.startsWith(`${real}/`))) return []

    const idle = Math.floor((Date.now() - lastActivity(path)) / DAY)

    if (idle < IDLE_DAYS) return []

    const gone = remade(path)

    for (const { dir } of gone) rmSync(dir, { recursive: true, force: true })

    return gone.length === 0 ? [] : [{ path, idle, kb: gone.reduce((sum, g) => sum + g.kb, 0) }]
  })
}

/** One line when the disk is nearly full: how full, and what frees it. */
export const lowDisk = () => {
  const disk = statfsSync(ROOT)
  const freeGb = (disk.bavail * disk.bsize) / 1024 ** 3

  return freeGb >= LOW_DISK_GB
    ? []
    : [
        `${freeGb.toFixed(1)} GB free on this disk: bun run worktrees lists the worktrees and prune --yes removes the merged ones; bun run worktrees tidy clears idle ones' build output now`,
      ]
}

/** The stamp that keeps tidy() to once a day, in the git directory every worktree shares. */
const stamp = join(
  git(ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  "openbelt-tidy",
)

/** Idle worktrees' build output cleared (once a day unless now), then the disk warning: lines to print, none when nothing happened. */
export const tidy = (now = false) => {
  const due = now || Date.now() - mtime(stamp) >= DAY

  if (!due) return lowDisk()

  writeFileSync(stamp, "")

  const cleared = clearIdle()
  const total = cleared.reduce((sum, c) => sum + c.kb, 0)

  const lines = now
    ? cleared.map((c) => `cleared ${gb(c.kb)} of build output in ${c.path} (idle ${c.idle} days)`)
    : []

  return [
    ...lines,
    ...(cleared.length > 0
      ? [
          `cleared ${gb(total)} of build output (cargo targets, verify runs) from ${cleared.length} worktree(s) idle ${IDLE_DAYS}+ days`,
        ]
      : now
        ? [`no worktree idle ${IDLE_DAYS}+ days has build output to clear`]
        : []),
    ...lowDisk(),
  ]
}
