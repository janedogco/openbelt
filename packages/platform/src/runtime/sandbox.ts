// Where an app's functions (and an agent's `execute`) run: QuickJS compiled to WASM, in sandbox processes (sandbox-process.ts), a
// few per tenant (a workspace) and never shared with another tenant. Each starts with a clean environment (as nobody when the platform
// is root) and confines itself before it takes any code (sandbox-confine.ts: no files, no processes, no connections), so code that
// escaped QuickJS's WASM would find no secret and nothing to reach. In a process, a set of code runs in boxes, each its own WASM
// instance with its memory capped and the code loaded once; a box does one run at a time, so module scope lasts from run to run, as in
// any long-lived isolate, and a run's calls are known to be that run's. A box has the language and the web globals a function uses
// (sandbox-globals.ts): no network of its own (its fetch is a call out to the platform, capabilities.ts), no files, no processes, no
// host environment. A run past its CPU budget is interrupted where it is; one past its wall time, or whose caller gives up, is
// stopped, and a process that doesn't stop it is ended.
import { writeFileSync } from "node:fs"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { outside, reenter } from "./events.ts"
import { recordBoxesMade, recordProcessEnded, recordSandbox, recordSandboxCpu } from "./metrics.ts"
import { say } from "./observe.ts"
import { turnFor } from "./turns.ts"
import type { ToWorker } from "./sandbox-process.ts"
import { positive } from "./settings.ts"

export type SandboxCode = {
  /** The module a run imports; its default export is the entrypoint class. */
  readonly mainModule: string
  /** Every module of the sandbox by path (relative to its root). */
  readonly modules: Readonly<Record<string, string>>
  /** A run is stopped after this long. */
  readonly wallMs: number
  /** Whose code it is (a workspace): each tenant's code runs in processes of its own, never beside another's. */
  readonly tenant: string
}

export type WorkerStub = {
  /** The entrypoint class's methods, each now an Effect; a function argument is the callback into the platform. */
  readonly getEntrypoint: <Members>() => Members
}

export type SandboxLoader = {
  /** The sandbox for `id`, made from `getCode` the first time and kept while it is used. */
  readonly get: <E = never, R = never>(
    id: string,
    getCode: () => SandboxCode | Effect.Effect<SandboxCode, E, R>,
  ) => Effect.Effect<WorkerStub, E, R>
}

export class WorkerLoader extends Context.Service<WorkerLoader, SandboxLoader>()(
  "openbelt/WorkerLoader",
) {}

type Reply = unknown

/** Processes per tenant: a run that spins holds its process for its CPU budget, and the tenant's other runs go on in another. */
const PROCESSES = positive("OPENBELT_SANDBOX_PROCESSES", 2)

/** A run's heap, in MB: its box's WASM memory can't grow past it. */
const RUN_MB = positive("OPENBELT_SANDBOX_RUN_MB", 128)

const IDLE_MB = positive("OPENBELT_SANDBOX_IDLE_MB", 128)

/** Sandbox processes kept on the machine (each about 60 MB at rest): past it the longest idle one ends before another starts. */
const MACHINE_PROCESSES = positive("OPENBELT_SANDBOX_MACHINE_PROCESSES", 16)

/**
 * A process whose memory went past this ends once it is idle, and the next run starts a new one: a run's heap stays with its
 * process after the run (WASM memory doesn't shrink), and a process per workspace kept each one's.
 */
const RECYCLE_BYTES = positive("OPENBELT_SANDBOX_RECYCLE_MB", 160) * 1024 * 1024

/** CPU time a run may use (its waits on the platform don't count), a third of the 30 s wall limit. */
const CPU_MS = 10_000

const IDLE_MS = 10 * 60_000

/** How long a sandbox may take to stop a run it was told to stop before it is ended, and its other runs with it. */
const STUCK_MS = 2_000

const ABANDONED = "the run was abandoned: its caller stopped waiting for it"

const PAST_WALL = "the sandbox was stopped: a run went past"

/** Whether `text` (an error's message) is a run stopped at its wall time (SandboxCode wallMs). */
export const ranPastWall = (text: string) => text.includes(PAST_WALL)

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly host: ((op: unknown) => Promise<Reply>) | undefined
}

type SandboxProcess = {
  readonly send: (message: ToWorker) => void
  readonly kill: () => void
  readonly ready: Promise<void>
  readonly down: (error: Error) => void
  readonly tenant: string
  /** The sets of code it has been sent. */
  readonly sent: Set<string>
  readonly runs: Map<string, Pending>
  boxes: number
  /** Runs given this process and not yet in `runs` (between the pick and the send, an await): counted as under way. */
  picked: number
  dead: boolean
  used: number
  /** CPU time it has used, as it last said (user and system). */
  cpuMs: number
  /** The most memory it has held (its peak resident set). */
  peakBytes: number
  /** Its boxes' WASM memory, as it last said. */
  wasmBytes: number
}

const processes = new Map<string, Array<SandboxProcess>>()

/** Boxes made by this process's sandboxes since it started (the pool's, in a supervisor). */
let boxesMadeHere = 0

/** CPU time this process's sandboxes have used since it started, ended ones too (the pool's, in a supervisor). */
let cpuMsHere = 0

const tally = () => {
  const all = [...processes.values()].flat()

  return {
    processes: all.length,
    boxes: all.reduce((sum, sandbox) => sum + sandbox.boxes, 0),
    made: boxesMadeHere,
    cpuMs: cpuMsHere,
    wasmBytes: all.reduce((sum, sandbox) => sum + sandbox.wasmBytes, 0),
    peakBytes: all.reduce((most, sandbox) => Math.max(most, sandbox.peakBytes), 0),
  }
}

const recount = () => recordSandbox(tally())

/**
 * A subprocess's CPU time in microseconds, as a number. Bun's types say number, but Bun 1.4 gives a bigint, and mixing it with a
 * number throws: in the supervisor, that ended the platform when a sandbox process ended.
 */
const micros = (time: number | bigint) => Number(time)

/** CPU time a sandbox has used past what it last said: added to the machine's count. */
const usedCpu = (sandbox: SandboxProcess, cpuMs: number) => {
  if (cpuMs <= sandbox.cpuMs) return

  recordSandboxCpu((cpuMs - sandbox.cpuMs) / 1000)
  cpuMsHere += cpuMs - sandbox.cpuMs
  sandbox.cpuMs = cpuMs
}

const endProcess = (sandbox: SandboxProcess, why: string, kind: "idle" | "stuck" | "failed") => {
  if (sandbox.dead) return

  sandbox.dead = true

  const list = processes.get(sandbox.tenant) ?? []
  const at = list.indexOf(sandbox)

  if (at !== -1) list.splice(at, 1)

  if (list.length === 0) processes.delete(sandbox.tenant)

  for (const pending of sandbox.runs.values()) pending.reject(new Error(why))

  sandbox.runs.clear()
  sandbox.down(new Error(why))
  sandbox.kill()
  recordProcessEnded(kind)
  recount()

  if (kind !== "idle")
    say("error", `sandbox: a process for ${sandbox.tenant} ended (${why})`, {
      workspace: sandbox.tenant,
    })
}

/** Answer a run's call (a db call, a fetch) with its callback, or refuse it when the run has ended. */
const answer = (
  sandbox: SandboxProcess,
  asked: { readonly run: string; readonly call: number; readonly op: string },
) => {
  const pending = sandbox.runs.get(asked.run)

  void (async () => {
    let text = JSON.stringify({
      ok: false,
      error: "this run has ended, so its calls are refused",
      status: 400,
      code: "invalid",
    })

    if (pending?.host !== undefined) {
      try {
        text = JSON.stringify(await pending.host(JSON.parse(asked.op)))
      } catch (error) {
        text = JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          status: 500,
          code: "internal",
        })
      }
    }

    if (!sandbox.dead)
      sandbox.send({
        t: "reply",
        run: asked.run,
        call: asked.call,
        text,
      } satisfies ToWorker)
  })()
}

/**
 * What a sandbox process writes, checked: it runs a tenant's code, and one that escaped QuickJS would control what it says. Its own
 * values (a call's op, a run's answer) stay strings the platform parses where it uses them.
 */
const fromSandbox = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ t: Schema.Literal("ready"), confined: Schema.String }),
      Schema.Struct({ t: Schema.Literal("log"), text: Schema.String }),
      Schema.Struct({
        t: Schema.Literal("call"),
        run: Schema.String,
        call: Schema.Number,
        op: Schema.String,
      }),
      Schema.Struct({
        t: Schema.Literal("done"),
        run: Schema.String,
        ok: Schema.Boolean,
        payload: Schema.String,
      }),
      Schema.Struct({ t: Schema.Literal("boxes"), alive: Schema.Number, made: Schema.Number }),
      Schema.Struct({
        t: Schema.Literal("usage"),
        cpuMs: Schema.Finite,
        peakKb: Schema.Finite,
        wasmBytes: Schema.Finite,
      }),
    ]),
  ),
)

/** The process's start: its runtime and entry, with nothing of the platform's environment; as nobody when the platform is root. */
const command = () => {
  const entry = [
    process.execPath,
    "--smol",
    new URL("./sandbox-process.ts", import.meta.url).pathname,
    String(IDLE_MB),
  ]

  return process.getuid?.() === 0
    ? ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "--no-new-privs", ...entry]
    : entry
}

const startProcess = (tenant: string): SandboxProcess => {
  const child = Bun.spawn(command(), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      ...(process.env.OPENBELT_SANDBOX_WARM_SECONDS === undefined
        ? {}
        : { OPENBELT_SANDBOX_WARM_SECONDS: process.env.OPENBELT_SANDBOX_WARM_SECONDS }),
    },
  })

  try {
    writeFileSync(`/proc/${child.pid}/oom_score_adj`, "1000")
  } catch {
    // not Linux, or not allowed: the kernel picks as it would
  }

  let up!: () => void
  let down!: (error: Error) => void

  const ready = new Promise<void>((resolve, reject) => {
    up = resolve
    down = reject
  })

  ready.catch(() => undefined)

  let made = 0

  let errors = ""

  const sandbox: SandboxProcess = {
    send: (message) => {
      void Promise.resolve(child.stdin.write(`${JSON.stringify(message)}\n`)).catch(() => undefined)
    },
    kill: () => child.kill("SIGKILL"),
    ready,
    down: (error) => down(error),
    tenant,
    sent: new Set(),
    runs: new Map(),
    boxes: 0,
    picked: 0,
    dead: false,
    used: Date.now(),
    cpuMs: 0,
    peakBytes: 0,
    wasmBytes: 0,
  }

  const receive = (line: string) => {
    const decoded = fromSandbox(line)

    if (Option.isNone(decoded)) return

    const message = decoded.value

    switch (message.t) {
      case "ready": {
        say("info", `sandbox: a process for ${tenant} is up (${message.confined})`, {
          workspace: tenant,
        })
        up()

        return
      }

      case "log": {
        say("error", message.text.slice(0, 1000), { workspace: tenant })

        return
      }

      case "boxes": {
        sandbox.boxes = message.alive

        if (message.made > made) {
          recordBoxesMade(message.made - made)
          boxesMadeHere += message.made - made
        }

        made = message.made
        recount()

        return
      }

      case "usage": {
        usedCpu(sandbox, message.cpuMs)
        sandbox.peakBytes = message.peakKb * 1024
        sandbox.wasmBytes = message.wasmBytes
        recount()

        recycleIfLarge(sandbox)

        return
      }

      case "call": {
        answer(sandbox, message)

        return
      }

      case "done": {
        const pending = sandbox.runs.get(message.run)

        sandbox.runs.delete(message.run)

        if (pending === undefined) return

        if (!message.ok) return pending.reject(new Error(message.payload))

        try {
          pending.resolve(JSON.parse(message.payload))
        } catch {
          pending.reject(new Error("the sandbox answered with something that isn't JSON"))
        }
      }
    }
  }

  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ""

    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })

      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        receive(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
      }
    }
  })().catch(() => undefined)

  void (async () => {
    for await (const chunk of child.stderr)
      errors = `${errors}${new TextDecoder().decode(chunk)}`.slice(-2000)
  })().catch(() => undefined)

  // What it used in all, killed or not: the CPU since it last said is counted, and the workspace's share is in the line.
  const spent = () => {
    const final = child.resourceUsage()

    if (final === undefined) return

    usedCpu(sandbox, Math.round((micros(final.cpuTime.user) + micros(final.cpuTime.system)) / 1000))

    const peakBytes = Math.max(sandbox.peakBytes, final.maxRSS)
    const cpuSeconds = Math.round(sandbox.cpuMs / 100) / 10
    const peakMb = Math.round(peakBytes / 1024 / 1024)

    say(
      "info",
      `sandbox: a process for ${tenant} used ${cpuSeconds} s of CPU, at most ${peakMb} MB`,
      { workspace: tenant, cpu_seconds: cpuSeconds, peak_mb: peakMb },
    )
  }

  void child.exited.then((code) => {
    endProcess(
      sandbox,
      errors.trim() === ""
        ? `the sandbox's process ended (exit ${code})`
        : `the sandbox's process ended: ${errors.trim()}`,
      "failed",
    )

    return spent()
  })

  processes.set(tenant, [...(processes.get(tenant) ?? []), sandbox])
  recount()

  return sandbox
}

/**
 * The tenant's least busy sandbox (the fewest runs under way: a process runs one at a time, so a spinning run holds its process),
 * the one with more warm boxes free between equals (a box waits loaded for its next run), or a new one while it has fewer than
 * PROCESSES and all it has are busy. Without the warm boxes between equals, runs that start together split between the processes
 * differently each time, and one made boxes while the other's sat warm: a second fan-out of 40 made 20 new ones.
 */
const processFor = (tenant: string): SandboxProcess => {
  const list = processes.get(tenant) ?? []

  const load = (sandbox: SandboxProcess) => sandbox.runs.size + sandbox.picked

  const free = (sandbox: SandboxProcess) => sandbox.boxes - load(sandbox)

  const least = list.toSorted((a, b) => load(a) - load(b) || free(b) - free(a))[0]

  const chosen =
    least === undefined || (load(least) > 0 && list.length < PROCESSES)
      ? (makeRoom(), startProcess(tenant))
      : least

  // Counted now, not when the run is sent (after an await): picks in a burst all read the same load, and 40 runs at once went
  // to one process, or to the one without warm boxes, which made 20 new.
  chosen.picked += 1

  return chosen
}

/** An idle process a run made large ends (its memory goes back to the machine); its workspace's next run starts a new one. */
const recycleIfLarge = (sandbox: SandboxProcess) => {
  if (sandbox.runs.size === 0 && sandbox.picked === 0 && sandbox.peakBytes > RECYCLE_BYTES) {
    say(
      "info",
      `sandbox: a process for ${sandbox.tenant} ends: a run made it ${Math.round(sandbox.peakBytes / 1024 / 1024)} MB (OPENBELT_SANDBOX_RECYCLE_MB)`,
      { workspace: sandbox.tenant },
    )
    endProcess(sandbox, "a run made it large: the next run starts a new one", "idle")
  }
}

/** Ends the longest idle processes until there is room for another under MACHINE_PROCESSES. */
const makeRoom = () => {
  const all = [...processes.values()].flat()
  const over = all.length - MACHINE_PROCESSES + 1

  const longestIdle = all
    .filter((sandbox) => sandbox.runs.size === 0 && sandbox.picked === 0)
    .toSorted((a, b) => a.used - b.used)
    .slice(0, Math.max(over, 0))

  for (const sandbox of longestIdle)
    endProcess(sandbox, "the machine had more sandbox processes than it keeps", "idle")
}

const evict = () => {
  const now = Date.now()

  for (const sandbox of [...processes.values()].flat()) {
    if (sandbox.runs.size === 0 && now - sandbox.used > IDLE_MS)
      endProcess(sandbox, "the tenant was idle", "idle")
  }
}

/** A run here, in this process's own sandboxes: a supervisor's (its pool, servePool), or a platform running alone. */
const callHere = async (
  id: string,
  code: SandboxCode,
  method: string,
  args: ReadonlyArray<unknown>,
  signal: AbortSignal,
): Promise<unknown> => {
  // SAFETY: a function among the arguments is the callback into the platform (an Effect's promise, see functions.ts run).
  const host = args.find((a) => typeof a === "function") as
    | ((op: unknown) => Promise<Reply>)
    | undefined

  const run = crypto.randomUUID()

  // The caller's event is waiting on the sandbox, from here to the answer: others may run meanwhile (events.ts).
  return await outside(async () => {
    const turn = await turnFor(code.tenant, args.some(isNested), signal, ABANDONED)

    const calling =
      host === undefined ? undefined : (op: unknown) => turn.callOut(isCtxCall(op), () => host(op))

    try {
      return await runInSandbox(id, code, method, args, signal, calling, run)
    } finally {
      turn.end()
    }
  })
}

/**
 * The argument that marks a run another run ctx.call'd (functions.ts): it goes ahead of new runs for a turn. Plain JSON, as the
 * host callback's marker is, so it crosses to the supervisor's pool; the harness's run ignores an argument past its own.
 */
export const NESTED_RUN = { __nested: true } as const

const isNested = (arg: unknown) => typeof arg === "object" && arg !== null && "__nested" in arg

/** Whether a run's call out is a ctx.call (functions.ts): the run waits on another run. */
const isCtxCall = (op: unknown) =>
  typeof op === "object" && op !== null && "op" in op && op.op === "call"

/** The run in its workspace's sandbox, once it has its turn. */
const runInSandbox = async (
  id: string,
  code: SandboxCode,
  method: string,
  args: ReadonlyArray<unknown>,
  signal: AbortSignal,
  host: ((op: unknown) => Promise<Reply>) | undefined,
  run: string,
): Promise<unknown> => {
  const sandbox = processFor(code.tenant)

  let counted = true

  // The pick's count, handed over to `runs` when the run is sent, or dropped if it never is.
  const unpick = () => {
    if (counted) sandbox.picked -= 1

    counted = false
  }

  try {
    sandbox.used = Date.now()

    await sandbox.ready

    if (signal.aborted) throw new Error(ABANDONED)

    if (!sandbox.sent.has(id)) {
      sandbox.send({
        t: "code",
        id,
        code: { main: code.mainModule, modules: code.modules },
      } satisfies ToWorker)
      sandbox.sent.add(id)
    }

    // Only JSON crosses; the callback becomes a marker the box replaces with its calls out.
    const crossing = JSON.stringify(
      args.map((a) => (typeof a === "function" ? { __host: true } : a)),
    )

    return await new Promise((resolve, reject) => {
      let stuck: ReturnType<typeof setTimeout> | undefined

      const stop = (why: string) => {
        if (!sandbox.runs.has(run)) return

        sandbox.send({ t: "stop", run, why } satisfies ToWorker)
        stuck = setTimeout(() => {
          if (sandbox.runs.has(run)) endProcess(sandbox, why, "stuck")
        }, STUCK_MS)
      }

      // From its turn, not from its call: the wait in line isn't the run's time (turns.ts).
      const timer = setTimeout(
        () => stop(`${PAST_WALL} ${code.wallMs / 1000}s without finishing`),
        code.wallMs,
      )

      const abandoned = () => stop(ABANDONED)

      signal.addEventListener("abort", abandoned, { once: true })

      const settle =
        <A>(f: (value: A) => void) =>
        (value: A) => {
          clearTimeout(timer)
          clearTimeout(stuck)
          signal.removeEventListener("abort", abandoned)
          f(value)
        }

      sandbox.runs.set(run, {
        resolve: settle(resolve),
        reject: settle(reject),
        host: host === undefined ? undefined : reenter(host),
      })
      unpick()
      sandbox.send({
        t: "run",
        run,
        id,
        method,
        args: crossing,
        cpuMs: CPU_MS,
        memoryMb: RUN_MB,
      } satisfies ToWorker)
    })
  } finally {
    unpick()

    recycleIfLarge(sandbox)
  }
}

// ---- one pool per machine ----
//
// A platform that runs as several processes (runtime/supervisor.ts) has one pool of sandboxes for all of them, in the supervisor:
// with a pool per process, each of 4 processes started a workspace's sandboxes, and 50 workspaces' took 15 of a machine's 16 GB. A process's
// run goes to the supervisor over its IPC channel (the code once per version, then the method and the arguments as JSON), the
// supervisor runs it in the workspace's sandbox and sends each of the run's calls out (a db call, a fetch) back to the process the run
// belongs to, which answers it in the run's event as before.

/** What a platform process and its supervisor send each other about runs. */
export type PoolMessage =
  | {
      readonly t: "sbx-run"
      readonly req: string
      readonly id: string
      readonly code: SandboxCode | undefined
      readonly method: string
      readonly args: string
    }
  | { readonly t: "sbx-abort"; readonly req: string }
  | {
      readonly t: "sbx-host-reply"
      readonly req: string
      readonly call: number
      readonly ok: boolean
      readonly text: string
    }
  | {
      readonly t: "sbx-done"
      readonly req: string
      readonly ok: boolean
      readonly text: string
      readonly missing?: boolean
    }
  | { readonly t: "sbx-host"; readonly req: string; readonly call: number; readonly op: string }
  | {
      readonly t: "sbx-stats"
      readonly processes: number
      readonly boxes: number
      readonly made: number
      readonly cpuMs: number
      readonly wasmBytes: number
      readonly peakBytes: number
    }

const pooled = process.env["OPENBELT_SANDBOX_POOL"] === "parent" && process.send !== undefined

type PoolRun = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly host: ((op: unknown) => Promise<Reply>) | undefined
  readonly again: () => void
}

const poolRuns = new Map<string, PoolRun>()

/** The versions this process sent the pool (each is sent once, then named by id). */
const sentToPool = new Set<string>()

const toPool = (message: PoolMessage) => process.send?.(message)

/** The pool's boxes made, as last told: what this process's counter has added so far. */
let poolMadeSeen = 0

/** The pool's CPU time, as last told. */
let poolCpuMsSeen = 0

const fromPool = (message: PoolMessage) => {
  // The pool's numbers, so this process's /_admin/metrics shows the machine's sandboxes (they live in the supervisor).
  if (message.t === "sbx-stats") {
    recordSandbox(message)

    if (message.made > poolMadeSeen) recordBoxesMade(message.made - poolMadeSeen)

    poolMadeSeen = message.made

    if (message.cpuMs > poolCpuMsSeen) recordSandboxCpu((message.cpuMs - poolCpuMsSeen) / 1000)

    poolCpuMsSeen = message.cpuMs

    return
  }

  const run = poolRuns.get(message.req)

  if (run === undefined) return

  if (message.t === "sbx-done") {
    // The supervisor started again and has lost the code: send it with the run once more.
    if (message.missing === true) return run.again()

    poolRuns.delete(message.req)

    if (!message.ok) return run.reject(new Error(message.text))

    try {
      return run.resolve(JSON.parse(message.text))
    } catch {
      return run.reject(new Error("the sandbox answered with something that isn't JSON"))
    }
  }

  if (message.t !== "sbx-host") return

  const reply = (ok: boolean, text: string) =>
    toPool({ t: "sbx-host-reply", req: message.req, call: message.call, ok, text })

  if (run.host === undefined) return reply(false, "this run takes no calls out")

  void run.host(JSON.parse(message.op)).then(
    (value) => reply(true, JSON.stringify(value)),
    (error: unknown) => reply(false, error instanceof Error ? error.message : String(error)),
  )
}

if (pooled)
  process.on("message", (message: PoolMessage) => {
    if (typeof message === "object" && message !== null && message.t.startsWith("sbx-"))
      fromPool(message)
  })

/** A run in the machine's pool, in the supervisor: as callHere, the waits and the calls out the same. */
const callPooled = async (
  id: string,
  code: SandboxCode,
  method: string,
  args: ReadonlyArray<unknown>,
  signal: AbortSignal,
): Promise<unknown> => {
  // SAFETY: a function among the arguments is the callback into the platform (an Effect's promise, see functions.ts run).
  const host = args.find((a) => typeof a === "function") as
    | ((op: unknown) => Promise<Reply>)
    | undefined

  const crossing = JSON.stringify(args.map((a) => (typeof a === "function" ? { __host: true } : a)))

  return await outside(
    () =>
      new Promise((resolve, reject) => {
        const req = crypto.randomUUID()

        const send = (withCode: boolean) => {
          toPool({
            t: "sbx-run",
            req,
            id,
            code: withCode ? code : undefined,
            method,
            args: crossing,
          })
          sentToPool.add(id)
        }

        const abandoned = () => toPool({ t: "sbx-abort", req })

        const settle =
          <A>(f: (value: A) => void) =>
          (value: A) => {
            signal.removeEventListener("abort", abandoned)
            f(value)
          }

        poolRuns.set(req, {
          resolve: settle(resolve),
          reject: settle(reject),
          host: host === undefined ? undefined : reenter(host),
          again: () => send(true),
        })

        if (signal.aborted) abandoned()
        else {
          signal.addEventListener("abort", abandoned, { once: true })
          send(!sentToPool.has(id))
        }
      }),
  )
}

const call = pooled ? callPooled : callHere

/** The code of each version a platform process sent, kept for its runs after the first. */
const poolCode = new Map<string, SandboxCode>()

const POOL_CODE_KEPT = 2000

/**
 * The supervisor's side of the pool for one platform process: what to do with each message it sends, and what to do when it
 * ends (its runs are abandoned).
 */
export const servePool = (send: (message: PoolMessage) => void) => {
  const runs = new Map<string, AbortController>()

  const stats = setInterval(() => send({ t: "sbx-stats", ...tally() }), 2000)

  stats.unref()

  const hostCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  let calls = 0

  const onMessage = (message: PoolMessage) => {
    if (message.t === "sbx-abort") return runs.get(message.req)?.abort()

    if (message.t === "sbx-host-reply") {
      const key = `${message.req}:${message.call}`
      const waiting = hostCalls.get(key)

      hostCalls.delete(key)

      if (waiting === undefined) return

      if (!message.ok) return waiting.reject(new Error(message.text))

      try {
        return waiting.resolve(JSON.parse(message.text))
      } catch {
        return waiting.reject(new Error("a call out answered with something that isn't JSON"))
      }
    }

    if (message.t !== "sbx-run") return

    // Idle tenants' sandboxes end here, as loader.get ends them in a platform running alone.
    evict()

    const code = message.code ?? poolCode.get(message.id)

    if (code === undefined)
      return send({ t: "sbx-done", req: message.req, ok: false, text: "", missing: true })

    if (message.code !== undefined) {
      poolCode.delete(message.id)
      poolCode.set(message.id, message.code)

      if (poolCode.size > POOL_CODE_KEPT) poolCode.delete(poolCode.keys().next().value ?? "")
    }

    const req = message.req

    const host = (op: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const at = calls++

        hostCalls.set(`${req}:${at}`, { resolve, reject })
        send({ t: "sbx-host", req, call: at, op: JSON.stringify(op) })
      })

    // SAFETY: the arguments crossed as the JSON callPooled made; the marker stands where the callback was.
    const parsed = JSON.parse(message.args) as Array<unknown>

    const args = parsed.map((a) =>
      typeof a === "object" && a !== null && "__host" in a ? host : a,
    )

    const controller = new AbortController()

    runs.set(req, controller)

    const finish = async () => {
      try {
        const value = await callHere(message.id, code, message.method, args, controller.signal)

        // The numbers first: a metrics read right after a run sees the boxes it made.
        send({ t: "sbx-stats", ...tally() })
        send({ t: "sbx-done", req, ok: true, text: JSON.stringify(value ?? null) })
      } catch (error) {
        send({
          t: "sbx-done",
          req,
          ok: false,
          text: error instanceof Error ? error.message : String(error),
        })
      } finally {
        runs.delete(req)
      }
    }

    void finish()
  }

  const gone = () => {
    clearInterval(stats)

    for (const controller of runs.values()) controller.abort()

    runs.clear()

    for (const waiting of hostCalls.values())
      waiting.reject(new Error("the platform process the run belongs to ended"))

    hostCalls.clear()
  }

  return { onMessage, gone }
}

/** End every sandbox sandbox: the process is stopping. */
export const endSandboxes = () => {
  for (const sandbox of [...processes.values()].flat())
    endProcess(sandbox, "the platform is stopping", "idle")
}

export const loader: SandboxLoader = {
  get: Effect.fn("Sandbox.get")(function* <E, R>(
    id: string,
    getCode: () => SandboxCode | Effect.Effect<SandboxCode, E, R>,
  ) {
    evict()

    const made = getCode()
    const code = Effect.isEffect(made) ? yield* made : made

    const entrypoint = new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== "string" || method === "then") return undefined

          return (...args: Array<unknown>) =>
            Effect.tryPromise({
              // Effect's signal: aborted when the run's caller is interrupted (its 30 s, a client gone), which ends the run here too.
              try: (signal) => call(id, code, method, args, signal),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            })
        },
      },
    )

    // SAFETY: the caller names the entrypoint's shape; its methods are made on demand from the names it calls.
    return { getEntrypoint: <Members>() => entrypoint as Members }
  }),
}

type Problem = { message?: string; position?: { line: number; column: number } }

/**
 * Whether `code` parses as a JavaScript module, and where it doesn't, worded as an engine words it: `SyntaxError: <what>` and the
 * position as the stack says it (`at <path>:<line>:<column>`). A sandbox's engine names the file of a module that fails to import,
 * not the line in it, so a deploy asks the host's parser.
 */
export const syntaxProblem = (code: string, path: string): string | undefined => {
  try {
    new Bun.Transpiler({ loader: "js" }).transformSync(code)

    return undefined
  } catch (error) {
    // SAFETY: Bun throws an AggregateError of BuildMessages (or one): a message and the position of the first problem.
    const thrown = error as { errors?: ReadonlyArray<Problem> } & Problem
    const found = thrown.errors?.[0] ?? thrown

    return `SyntaxError: ${found.message ?? "it doesn't parse"}${
      found.position === undefined
        ? ""
        : `\n    at ${path}:${found.position.line}:${found.position.column}`
    }`
  }
}
