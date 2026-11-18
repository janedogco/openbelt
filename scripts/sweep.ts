//   - a dev server (`bun --watch .../packages/platform/src/server.ts`) whose folder is gone, or whose
//     parent is launchd (its dev.ts died), is stopped with everything under it. Verify's servers
//     and the tailnet service's (no --watch) never match.
import { existsSync } from "node:fs"
import { serves } from "./tailscale.ts"
import { killTree } from "./verify/drive/processes.ts"

const cwdOf = (pid: number) =>
  Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .stdout.toString()
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1)

/** Dev servers nobody owns any more, with why. */
export const orphanDevs = () =>
  Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="])
    .stdout.toString()
    .trim()
    .split("\n")
    .flatMap((row) => {
      const [pid = "", ppid = "", ...command] = row.trim().split(/\s+/)
      const line = command.join(" ")

      if (!/\bbun --watch \S*packages\/platform\/src\/server\.ts\b/.test(line)) return []

      const cwd = cwdOf(Number(pid)) ?? ""
      const gone = cwd !== "" && !existsSync(cwd)

      return gone || ppid === "1"
        ? [{ pid: Number(pid), cwd, why: gone ? "its folder is gone" : "its bun run dev died" }]
        : []
    })

const listening = (port: number) =>
  Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"])
    .stdout.toString()
    .trim() !== ""

export const deadServes = () =>
  serves().flatMap(({ https, proxy }) => {
    const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(proxy)?.[1] ?? 0)
    const dev = port === 1337 || (port >= 1340 && port <= 1389)

    return dev && !listening(port) ? [{ https, proxy }] : []
  })

export const sweep = () => {
  const done: Array<string> = []

  for (const orphan of orphanDevs()) {
    killTree(orphan.pid)
    done.push(`stopped an orphaned bun run dev (${orphan.why}): ${orphan.cwd}`)
  }

  for (const dead of deadServes()) {
    Bun.spawnSync(["tailscale", "serve", `--https=${dead.https}`, "off"])
    done.push(`turned off tailscale serve on ${dead.https} (nothing on ${dead.proxy})`)
  }

  return done
}

if (import.meta.main) {
  const done = sweep()

  console.log(done.length === 0 ? "nothing to clean up" : done.join("\n"))
}
