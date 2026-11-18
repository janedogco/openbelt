// Turns for sandbox runs: at most OPENBELT_SANDBOX_RUNS under way on the machine and OPENBELT_SANDBOX_TENANT_RUNS per workspace,
// the rest waiting in line. Each run may hold its box's heap (OPENBELT_SANDBOX_RUN_MB), so this is what bounds the sandboxes'
// memory: without it, 40 runs at once from one person took a 4 GB machine past its limit, and the kernel ended a platform process.
//
// A run waiting on a ctx.call gives its turn to the runs it called and takes one again after, or runs that call runs would hold
// every turn and wait on each other for good. It keeps its heap while it waits (parked), so parked runs have limits of their own
// (OPENBELT_SANDBOX_PARKED, OPENBELT_SANDBOX_TENANT_PARKED): a new run starts only while the running and the parked are under
// them, and a ctx.call that would park a run past one (a deep tree of nested calls) is refused at once, never queued, so nothing
// waits on a turn held by a run that waits on it. Runs a ctx.call started, and runs taking their turn back, go ahead of the line
// and don't count the parked: work under way finishes before more starts.
//
// A new run waits in line at most OPENBELT_SANDBOX_LINE_MS, and not at all once the platform is stopping (closeLine): it's refused
// before it starts, so its caller can send it again (a webhook answers 503 with Retry-After). The wait isn't the run's time: its
// wall limit starts when it has its turn (sandbox.ts).
import { positive } from "./settings.ts"

const MACHINE_RUNS = positive("OPENBELT_SANDBOX_RUNS", 16)

const TENANT_RUNS = positive("OPENBELT_SANDBOX_TENANT_RUNS", 6)

const MACHINE_PARKED = positive("OPENBELT_SANDBOX_PARKED", 16)

const TENANT_PARKED = positive("OPENBELT_SANDBOX_TENANT_PARKED", 8)

/** How long a new run may wait in line for a turn. */
export const LINE_MS = positive("OPENBELT_SANDBOX_LINE_MS", 60_000)

/** What every refused turn's message starts with: the run didn't start, so sending it again is safe. */
const NO_TURN = "it didn't start:"

const LINE_FULL = `${NO_TURN} this workspace's runs were busy for ${LINE_MS / 1000}s (${TENANT_RUNS} run at once, the rest wait in line). Send it again in a moment`

const CLOSING = `${NO_TURN} the server is restarting. Send it again in a few seconds`

/** Whether `text` (an error's message) is a refused turn. */
export const refusedTurn = (text: string) => text.includes(NO_TURN)

/** Counts per workspace, and the machine's. */
const counter = () => {
  const of = new Map<string, number>()
  let all = 0

  return {
    all: () => all,
    of: (tenant: string) => of.get(tenant) ?? 0,
    add: (tenant: string, by: 1 | -1) => {
      all += by

      const now = (of.get(tenant) ?? 0) + by

      if (now === 0) of.delete(tenant)
      else of.set(tenant, now)
    },
  }
}

const running = counter()

const parked = counter()

type Waiting = {
  readonly tenant: string
  readonly ahead: boolean
  readonly go: () => void
  readonly refuse: (why: string) => void
}

const line: Array<Waiting> = []

let closed = false

const next = () => {
  // A copy: admitting one takes it out of the line.
  for (const waiting of line.slice()) {
    const { tenant } = waiting

    const room =
      running.all() < MACHINE_RUNS &&
      running.of(tenant) < TENANT_RUNS &&
      // A new run (not one a ctx.call started, nor one taking its turn back) also counts the parked: it may park too, and new runs
      // alone mustn't reach the parked limits, or a burst of requests that each ctx.call would be refused.
      (waiting.ahead ||
        (running.all() + parked.all() < MACHINE_PARKED &&
          running.of(tenant) + parked.of(tenant) < TENANT_PARKED))

    if (room) {
      line.splice(line.indexOf(waiting), 1)
      waiting.go()
    }
  }
}

/** A turn for one of `tenant`'s runs: at once if there is room, else when one ends. Resolves to its release, which may be called twice. */
const take = (tenant: string, ahead: boolean, signal: AbortSignal, abandoned: string) =>
  new Promise<() => void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error(abandoned))

    let timer: ReturnType<typeof setTimeout> | undefined

    const leave = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", gaveUp)

      const at = line.indexOf(entry)

      if (at >= 0) line.splice(at, 1)
    }

    const entry: Waiting = {
      tenant,
      ahead,
      refuse: (why) => {
        leave()
        reject(new Error(why))
      },
      go: () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", gaveUp)
        running.add(tenant, 1)

        let held = true

        resolve(() => {
          if (!held) return

          held = false
          running.add(tenant, -1)
          next()
        })
      },
    }

    const gaveUp = () => {
      leave()
      reject(new Error(abandoned))
    }

    signal.addEventListener("abort", gaveUp, { once: true })

    // Ahead of everything that isn't, behind what already is.
    const behind = ahead ? line.findIndex((other) => !other.ahead) : -1

    if (behind === -1) line.push(entry)
    else line.splice(behind, 0, entry)

    next()

    // Work under way (a run a ctx.call started, one taking its turn back) waits for its turn however long; a new run, only so long.
    if (ahead || !line.includes(entry)) return

    if (closed) entry.refuse(CLOSING)
    else timer = setTimeout(() => entry.refuse(LINE_FULL), LINE_MS)
  })

/** The platform is stopping: the new runs in line are refused, and so is every new run that can't start at once from now on. */
export const closeLine = () => {
  closed = true

  for (const waiting of line.filter((w) => !w.ahead)) waiting.refuse(CLOSING)
}

export type Turn = {
  /** A call out of the run: a ctx.call gives the turn up while it waits, and the run takes one again after the last returns. */
  readonly callOut: <A>(isCall: boolean, f: () => Promise<A>) => Promise<A>
  /** The run is over: its turn goes to the next in line, and a ctx.call still out (not awaited) takes none after. */
  readonly end: () => void
}

/** Waits for a turn for a run of `tenant`. */
export const turnFor = async (
  tenant: string,
  nested: boolean,
  signal: AbortSignal,
  abandoned: string,
): Promise<Turn> => {
  let release: (() => void) | undefined = await take(tenant, nested, signal, abandoned)

  let calls = 0
  let retaking: Promise<void> | undefined
  let ended = false

  const retaken = async (): Promise<void> => {
    const now = retaking

    if (now === undefined) return

    await now

    return await retaken()
  }

  // Parked until it has its turn back: its heap is held all the while.
  const retake = async () => {
    try {
      const back = await take(tenant, true, signal, abandoned)

      if (ended) back()
      else release = back
    } finally {
      parked.add(tenant, -1)
    }
  }

  return {
    callOut: async (isCall, f) => {
      if (!isCall) return await f()

      // A call that starts while the run takes its turn back waits for that, then gives it up again.
      await retaken()

      if (calls === 0) {
        if (parked.all() >= MACHINE_PARKED || parked.of(tenant) >= TENANT_PARKED)
          throw new Error(
            parked.of(tenant) >= TENANT_PARKED
              ? `${TENANT_PARKED} of this workspace's runs are already waiting on a ctx.call, the most at once (OPENBELT_SANDBOX_TENANT_PARKED): make fewer nested calls at once, or call again in a moment`
              : `${MACHINE_PARKED} runs on this server are already waiting on a ctx.call, the most at once (OPENBELT_SANDBOX_PARKED): call again in a moment`,
          )

        parked.add(tenant, 1)
        release?.()
        release = undefined
      }

      calls += 1

      try {
        return await f()
      } finally {
        calls -= 1

        if (calls === 0) {
          if (ended) parked.add(tenant, -1)
          else {
            retaking = retake().finally(() => {
              retaking = undefined
            })

            await retaking
          }
        }
      }
    },
    end: () => {
      ended = true
      release?.()
      release = undefined
    },
  }
}
