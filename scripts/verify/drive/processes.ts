// mints an API token; killTree stops it and every process below it (a check's
// Chrome), not just its pid; orphans finds ones whose parent is gone.
import { Option, Schema } from "effect"

const Token = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
)

export const mintToken = async (
  url: string,
  admin: string,
  user: string,
  ms: number,
  stuck: () => boolean = () => false,
) => {
  const deadline = Date.now() + ms

  while (Date.now() < deadline && !stuck()) {
    // oxlint-disable-next-line no-await-in-loop -- polling for readiness is sequential by design
    const body = await fetch(`${url}/_admin/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}` },
      body: JSON.stringify({ email: user }),
      signal: AbortSignal.timeout(3000),
    }).then(
      (r) => r.text(),
      () => "",
    )

    const token = Option.getOrUndefined(Option.map(Token(body), (d) => d.token))

    if (token !== undefined) return token

    // oxlint-disable-next-line no-await-in-loop -- polling for readiness is sequential by design
    await Bun.sleep(250)
  }

  return undefined
}

export const nameWorkspaceAdmin = async (url: string, admin: string, email: string) =>
  fetch(`${url}/_admin/workspace-admins`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}` },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(5000),
  }).then(
    (r) => r.ok,
    () => false,
  )

export const tree = (pid: number): ReadonlyArray<number> => {
  const rows = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]).stdout.toString().trim().split("\n")

  const children = rows.flatMap((row) => {
    const [child, parent] = row.trim().split(/\s+/).map(Number)

    return parent === pid && child !== undefined ? [child] : []
  })

  return [pid, ...children.flatMap(tree)]
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

const signal = (pid: number, name: "SIGTERM" | "SIGKILL") => {
  try {
    process.kill(pid, name)
  } catch {}
}

export const killTree = (pid: number, crash = false) => {
  const pids = tree(pid)

  for (const p of pids.toReversed()) signal(p, crash ? "SIGKILL" : "SIGTERM")

  const deadline = Date.now() + 5000

  while (pids.some(alive) && Date.now() < deadline) Bun.sleepSync(50)

  for (const p of pids.filter(alive)) signal(p, "SIGKILL")

  return pids
}

export const orphans = (root: string) =>
  Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="])
    .stdout.toString()
    .trim()
    .split("\n")
    .flatMap((row) => {
      const [pid = "", ppid = "", ...command] = row.trim().split(/\s+/)
      const line = command.join(" ")

      const ours = line.includes(`${root}/packages/platform/src/server.ts`)

      return ppid === "1" && ours && !line.includes("agent-browser")
        ? [`${pid} ${line.slice(0, 120)}`]
        : []
    })

/**
 * A free port whose +1, +10, +100 and +101 are free too: a check's platforms take ports from it. Below 32,768, where neither Linux
 * (32,768 up) nor macOS (49,152 up) hands out ports of its own: a port picked there was taken, before the platform bound it, by one
 * of its processes' internal servers (port 0), and the platform failed to start (EADDRINUSE, at 4 processes in CI).
 */
export const freeBase = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 12_000)

    const held = [base, base + 1, base + 10, base + 100, base + 101].map((port) => {
      try {
        void Bun.serve({ port, fetch: () => new Response() }).stop(true)

        return false
      } catch {
        return true
      }
    })

    if (!held.some(Boolean)) return base
  }

  throw new Error("no free ports")
}

/** SIGKILL, for a process that may be gone already. */
export const hardKill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // gone
  }
}
