// One event at a time per object. A Durable Object handles a request, a call, an alarm or a socket message to its end before the
// next begins, except while it waits on something outside itself (another object, a function's sandbox, the network): there another
// event may run. Calls into an object arrive side by side; this keeps the rule, because OpenBelt's code assumes it (a
// read-modify-write in one event can't be torn by another).
//
// An event holds the object's lock. `outside` gives it up for the length of a wait, and takes it back after. A callback from the
// sandbox into the object (a function's db call) runs as part of the event that started the sandbox: `reenter`.
import { AsyncLocalStorage } from "node:async_hooks"
import { recordTurnWait } from "./metrics.ts"
import { say } from "./observe.ts"

class Lock {
  #queue: Array<() => void> = []

  #busy = false

  /** Whether an event has the turn now. */
  get held() {
    return this.#busy
  }

  /** Events waiting for their turn. */
  get queued() {
    return this.#queue.length
  }

  async acquire() {
    if (!this.#busy) {
      this.#busy = true

      return
    }

    await new Promise<void>((resolve) => this.#queue.push(resolve))
  }

  release() {
    const next = this.#queue.shift()

    if (next === undefined) this.#busy = false
    else next()
  }
}

/**
 * An object that makes its callers wait is the first thing to look for when something is slow, and nothing else says so: an event
 * that waited this long for its object's turn, and one that held the turn this long (its waits on the outside don't count: it
 * gives the turn up for those).
 */
const SLOW_TURN_MS = 1000

const SLOW_EVENT_MS = 5000

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** The event running here: which object, and whether it has given its turn up while it waits. */
export type Held = {
  readonly actorId: string
  readonly cls: string
  readonly name: string
  readonly lock: Lock
  /** Waits in flight that have given the turn up: the first gives it up, the last takes it back. */
  waiting: number
  /** Whether the event has the turn right now. */
  holding: boolean
  pinned: number
  /** The event is over: a fiber it forked, or a wait it abandoned, that outlived it holds nothing and takes nothing. */
  ended: boolean
  /** Milliseconds it has spent outside, without the turn, so far; and since when, while it is. */
  away: number
  awaySince: number
}

const als = new AsyncLocalStorage<Held>()

/** What makes an object's writes so far durable, by object (set once its actor is up). */
const flushes = new Map<string, () => Promise<void>>()

export const onFlush = (actorId: string, flush: () => Promise<void>) => {
  flushes.set(actorId, flush)
}

const locks = new Map<string, Lock>()

/**
 * Whether events of the object are under way, asked from outside its turn: one holding it, or one in line for it. A commit is worth
 * delaying a moment to share only then; alone, it goes at once.
 */
export const othersUnderWay = (actorId: string) => {
  const lock = locks.get(actorId)

  if (lock === undefined) return false

  return lock.queued > 0 || lock.held
}

/** The event running in this async context, if any. */
export const current = (): Held | undefined => als.getStore()

/** Each object's events under way (queued, running or waiting outside), and who waits for them to end. */
const underWay = new Map<string, { count: number; ended: Array<() => void> }>()

/**
 * Resolves once the object's events under way have ended, or after `ms`. An object put to sleep (a deploy's other slot taking it
 * over, or a process stopping) lets them finish first: closing it mid-event cut an agent's call_function off with "-32603 Internal
 * error", every swap.
 */
export const eventsEnded = async (actorId: string, ms: number) => {
  const under = underWay.get(actorId)

  if (under === undefined) return

  await Promise.race([new Promise<void>((resolve) => under.ended.push(resolve)), Bun.sleep(ms)])
}

/** Run `f` as one event of the object `actorId` (`cls`/`name`): after the one before it, and before the one after. */
export const event = async <T>(
  actorId: string,
  cls: string,
  name: string,
  f: () => Promise<T>,
): Promise<T> => {
  const under = underWay.get(actorId) ?? { count: 0, ended: [] }

  under.count++
  underWay.set(actorId, under)

  try {
    return await turn(actorId, cls, name, f)
  } finally {
    under.count--

    if (under.count === 0) {
      underWay.delete(actorId)

      for (const resolve of under.ended) resolve()
    }
  }
}

const turn = async <T>(
  actorId: string,
  cls: string,
  name: string,
  f: () => Promise<T>,
): Promise<T> => {
  const lock = locks.get(actorId) ?? (locks.set(actorId, new Lock()), locks.get(actorId))

  if (lock === undefined) throw new Error("unreachable: the lock was just made")

  const asked = performance.now()
  const ahead = lock.queued

  await lock.acquire()

  const started = performance.now()

  recordTurnWait(started - asked)

  if (started - asked > SLOW_TURN_MS) {
    say(
      "warn",
      `slow: ${cls}/${name} waited ${seconds(started - asked)} for its turn (${ahead} events ahead of it)`,
      {
        actor: `${cls}/${name}`,
        ms: Math.round(started - asked),
      },
    )
  }

  const held: Held = {
    actorId,
    cls,
    name,
    lock,
    waiting: 0,
    holding: true,
    pinned: 0,
    ended: false,
    away: 0,
    awaySince: 0,
  }

  try {
    return await als.run(held, f)
  } finally {
    held.ended = true

    const took = performance.now() - started - held.away

    if (took > SLOW_EVENT_MS) {
      say(
        "warn",
        `slow: ${cls}/${name} held its turn for ${seconds(took)} (${seconds(held.away)} more waiting outside); others wait for it`,
        { actor: `${cls}/${name}`, ms: Math.round(took) },
      )
    }

    // An event that ended while it was waiting (the wait was abandoned: a timeout) has already given the turn up.
    if (held.holding) {
      held.holding = false
      lock.release()
    }
  }
}

export const pinTurn = (): (() => void) => {
  const held = als.getStore()

  if (held === undefined || held.ended) return () => undefined

  held.pinned++

  return () => {
    held.pinned--
  }
}

/** Give the event's turn up while it waits; the function returned takes it back. Nothing to give up outside an event. */
export const yieldTurn = (): (() => Promise<void>) | undefined => {
  const held = als.getStore()

  if (held === undefined || held.ended || held.pinned > 0) return undefined

  if (held.waiting++ === 0 && held.holding) {
    held.holding = false
    held.awaySince = performance.now()
    held.lock.release()
  }

  return async () => {
    if (--held.waiting !== 0 || held.ended) return

    await held.lock.acquire()

    // The event ended while this waited in line (a timeout abandoned the wait, and its end gave nothing back since it held
    // nothing): the turn it was just handed is nobody's, so it goes on to the next. Kept, it was held forever: every later event of
    // the object waited until its caller gave up (a 100-run call tree on a slow machine, 293 s).
    //
    // Or another wait of the same event began while this one stood in line (calls made side by side, one back before the other
    // left): that one gave nothing up, since the event held nothing, and takes the turn back itself when it ends. Kept here, the
    // event held its turn while that wait was out, and the wait's own return queued for a turn its event already held: the object
    // stopped for good (on local files, whose answers come fast enough to land in that window, 8 deploys at once over one MCP
    // session stalled within seconds).
    if (held.ended || held.waiting > 0) {
      held.lock.release()

      return
    }

    held.holding = true
    held.away += performance.now() - held.awaySince
  }
}

/**
 * Wait on something outside the object without keeping its turn. What the event wrote so far is durable first: whatever the wait
 * sends (a request, a call to another object) is something the world may act on, and a crash mid-wait must not lose the record that
 * it was sent.
 */
export const outside = async <T>(f: () => Promise<T>): Promise<T> => {
  const held = als.getStore()

  if (held !== undefined && !held.ended) await flushes.get(held.actorId)?.()

  const back = yieldTurn()

  try {
    return await f()
  } finally {
    await back?.()
  }
}

/** A callback into the object from outside (the sandbox's db calls): it runs inside the event that handed it out, in its turn. */
export const reenter = <A extends ReadonlyArray<unknown>, R>(
  f: (...args: A) => Promise<R>,
): ((...args: A) => Promise<R>) => {
  const held = als.getStore()

  if (held === undefined) return f

  return async (...args) => {
    // The event still has its turn (it is not waiting): the callback is part of it.
    if (held.waiting === 0 && !held.ended) return await f(...args)

    await held.lock.acquire()

    // Its own turn-keeping state: a wait inside the callback gives the turn up and takes it back like any other.
    const inner: Held = {
      actorId: held.actorId,
      cls: held.cls,
      name: held.name,
      lock: held.lock,
      waiting: 0,
      holding: true,
      pinned: 0,
      ended: false,
      away: 0,
      awaySince: 0,
    }

    try {
      return await als.run(inner, () => f(...args))
    } finally {
      inner.ended = true

      if (inner.holding) {
        inner.holding = false
        held.lock.release()
      }
    }
  }
}
