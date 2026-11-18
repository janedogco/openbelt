import { assertWorkspaceSettings, upgradeWorkspaces } from "./workspace-upgrade.ts"
// The platform as several processes on one port (OPENBELT_PROCESSES; "auto" is one per 2 CPUs, at most 4). One process serves about
// 1,700 page requests a second on one core; the others serve the objects they own, and a request for another's object crosses
// loopback (docs/running.md, "More capacity"). This process starts the platform processes
// (server.ts again, with OPENBELT_PROCESS set), each serving the same port (SO_REUSEPORT: the kernel spreads connections), and:
// - lets them serve only once all of them are ready and know each other's internal ports: a request for an object another process
//   owns (actor.ts, by key hash) goes to that process over loopback;
// - starts one again that ends (a crash, an out-of-memory kill), and gives up past 5 in a minute, so its own supervisor (compose,
//   a service) starts the whole again;
// - holds the machine's one pool of sandboxes, which the processes' runs go to (sandbox.ts servePool): a pool per process put
//   each workspace's sandboxes in every process, 15 of 16 GB at 50 workspaces;
// - passes SIGTERM on and waits for each process's ordered stop (shutdown.ts) before it exits.
import { cpus } from "node:os"
import { join } from "node:path"
import { say, startExport, stopExport } from "./observe.ts"
import type { PeerMessage } from "./actor.ts"
import { dataDir } from "./localdb.ts"
import { backUpAll } from "./replicate.ts"
import { newInternalKey } from "./internal-key.ts"
import { endSandboxes, type PoolMessage, servePool } from "./sandbox.ts"
import { closeLine } from "./turns.ts"

/** What a platform process and its supervisor say about starting. */
export type StartMessage = { readonly t: "ready" } | { readonly t: "go" }

const wanted = () => {
  const set = (process.env["OPENBELT_PROCESSES"] ?? "1").trim()

  if (set === "auto") return Math.min(4, Math.max(1, Math.floor(cpus().length / 2)))

  const n = Number(set)

  return Number.isInteger(n) && n >= 1 ? n : 1
}

assertWorkspaceSettings(process.env)

const N = wanted()

/** How long the processes may take to stop once told to, before they are killed. */
const STOP_MS = 25_000

/** Restarts in this window past which the supervisor gives up. */
const RESTARTS = { most: 5, withinMs: 60_000 }

type Child = { readonly index: number; process: Bun.Subprocess; connected: boolean }

const children: Array<Child> = []

let stopping = false

let open = false

const restarts: Array<number> = []

/** The key the processes' internal servers want on every request (internal-key.ts). */
const INTERNAL_KEY = newInternalKey()

const start = (index: number): Child => {
  // A run can finish after its process ended (killed): its answer has nowhere to go.
  const pool = servePool((message) => {
    if (spawned.exitCode !== null || spawned.signalCode !== null) return

    try {
      child.process.send(message)
    } catch {
      // ended between the check and the send
    }
  })

  const spawned = Bun.spawn(
    [process.execPath, ...process.execArgv, join(import.meta.dir, "../server.ts")],
    {
      env: {
        ...process.env,
        OPENBELT_PROCESS: String(index),
        OPENBELT_PROCESSES: String(N),
        OPENBELT_SANDBOX_POOL: "parent",
        OPENBELT_INTERNAL_KEY: INTERNAL_KEY,
      },
      // A lifeline (runtime/lifeline.ts): the process ends when this one does, however it ended.
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
      ipc: (message: PoolMessage | StartMessage | PeerMessage) => {
        if (message.t === "ready") ready(child)
        else if (message.t === "peer") peer(index, message.port)
        else if (message.t !== "go" && message.t !== "peers") pool.onMessage(message)
      },
    },
  )

  const child: Child = { index, process: spawned, connected: false }

  const ended = async () => {
    const code = await spawned.exited

    pool.gone()
    child.connected = false
    gone(index)

    if (stopping) return

    const now = Date.now()

    restarts.push(now)

    while (restarts.length > 0 && now - (restarts[0] ?? now) > RESTARTS.withinMs) restarts.shift()

    if (restarts.length > RESTARTS.most) {
      say(
        "error",
        `supervisor: platform processes ended ${restarts.length} times in a minute; stopping, for this one's supervisor to start it again`,
      )
      process.exit(1)
    }

    say("warn", `supervisor: platform process ${index} ended (exit ${code}); starting it again`)
    setTimeout(() => {
      if (!stopping) children[index] = start(index)
    }, 1000)
  }

  void ended()

  return child
}

// ---- each process's internal server (actor.ts): each tells this one its port, this one tells the rest ----

const portOf = new Map<number, number>()

const tellAll = (message: PeerMessage) => {
  for (const c of children) {
    try {
      c.process.send(message)
    } catch {
      // ended meanwhile
    }
  }
}

const peer = (index: number, port: number) => {
  portOf.set(index, port)
  tellAll({ t: "peers", ports: [...portOf] })
}

/** A process ended: its server is gone. */
const gone = (index: number) => {
  portOf.delete(index)
  tellAll({ t: "peers", ports: [...portOf] })
}

const ready = (child: Child) => {
  child.connected = true

  // Started again later: the others serve already.
  if (open) return child.process.send({ t: "go" } satisfies StartMessage)

  if (children.length < N || !children.every((c) => c.connected)) return

  open = true

  say("info", `supervisor: ${N} platform processes ready; serving`)

  for (const c of children) c.process.send({ t: "go" } satisfies StartMessage)
}

const stop = async () => {
  if (stopping) return

  stopping = true

  // The pool's line is here: runs that haven't started are refused now, while their processes can still answer for them.
  closeLine()

  for (const c of children) c.process.kill("SIGTERM")

  const all = Promise.all(children.map((c) => c.process.exited))

  const late = setTimeout(() => {
    for (const c of children) c.process.kill("SIGKILL")
  }, STOP_MS)

  await all
  clearTimeout(late)
  endSandboxes()
  await stopExport()
  process.exit(0)
}

process.on("SIGTERM", () => void stop())

process.on("SIGINT", () => void stop())

// The pool of sandboxes is here: its lines (a process up, ended, what it used) go to the OTLP backend too.
await startExport()

await upgradeWorkspaces(
  join(dataDir(), process.env["OPENBELT_NAMESPACE"] ?? "openbelt"),
  process.env["OPENBELT_SECRETS_KEY"] ?? "",
)

// Every file once to a new backup, while no process holds one (replicate.ts); a bucket that can't be reached doesn't stop the start.
await backUpAll(dataDir()).catch((error: unknown) =>
  say("error", `backup: couldn't take every file once; trying again at the next start`, {
    said: String(error).slice(0, 300),
  }),
)

for (let index = 0; index < N; index++) children.push(start(index))

say("info", `supervisor: starting ${N} platform process${N === 1 ? "" : "es"}`)
