import { objectHash, objectFileId } from "./object-id.ts"
// Durable Objects, run in this process. Each object lives in one of the machine's platform processes, the one its key hashes to
// (runtime/supervisor.ts starts OPENBELT_PROCESSES of them): started on first use, its SQLite a file in OPENBELT_DATA named after its key
// (localdb.ts), put to sleep when idle. Every way in (a call, an HTTP request, a page's socket, a job coming due) is one event
// (events.ts): one at a time per object. A request that lands on another process goes to the owner over loopback.
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join as joinPath } from "node:path"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { current, event, eventsEnded, onFlush, othersUnderWay, outside } from "./events.ts"
import {
  type LogQuery,
  type LogRecord,
  logsOf,
  mergeLogs,
  mergeTraces,
  observed,
  resolveTrace,
  say,
  SPAN_HEADER,
  traceView,
  type TraceView,
  underParent,
} from "./observe.ts"
import { mergeMetrics, prometheusText } from "./metrics.ts"
import { type JobBook, Jobs, makeJobBook } from "./jobs.ts"
import {
  type Envelope,
  implOf,
  type ObjectMembers,
  type Transport,
  useTransport,
} from "./object.ts"
import { Browser, browser } from "./browser.ts"
import { fromPlatform, internalHeaders } from "./internal-key.ts"
import { fromWire, toWire } from "./wire.ts"
import { loader, WorkerLoader } from "./sandbox.ts"
import { claimSocket, type Socket } from "./socket.ts"
import { DurableObjectState, type ObjectState } from "./state.ts"
import { makeStorage } from "./storage.ts"
import { commit, drained, type RawDb } from "./sql.ts"
import { closeLocal, dataDir, openLocal } from "./localdb.ts"
import { positive } from "./settings.ts"

/** What an object's runtime offers its code: its id and key, its database, its wake-up, and keeping it awake. */
type ActorContext = {
  readonly actorId: string
  readonly key: ReadonlyArray<string>
  readonly db: RawDb
  /** Book the object's one wake-up for `at` (a timer here and a row in this process's wake file), or none. */
  readonly wake: (at: number | null) => void
  /** Holds the object awake until the promise settles. */
  readonly keepAwake: <T>(promise: Promise<T>) => Promise<T>
  /** Aborts when the object is put to sleep. */
  readonly abortSignal: AbortSignal
}

type Instance = {
  readonly cls: string
  readonly name: string
  readonly members: ObjectMembers
  readonly state: ObjectState
  readonly book: JobBook
  readonly sockets: Set<Socket>
  readonly scope: Scope.Closeable
  autoResponse: { readonly request: string; readonly response: string } | undefined
  /** This process's own timer for a job due soon (see arm). */
  soon: ReturnType<typeof setTimeout> | undefined
  /** The actor's context, for calls this process makes to it directly (callHere). */
  readonly ctx: ActorContext
  /** Set once it is being put to sleep: calls go through the engine again, to wherever it wakes next. */
  stopping: boolean
  /** Pages bridged to it in this process (attachHere): closed when it stops, so they connect again to wherever it wakes. */
  readonly pages: Set<{ readonly page: PageEnd; readonly ended: () => void }>
}

/** The objects alive in this process, by actor id, and by class and name (for a call an object makes to itself). */
const instances = new Map<string, Promise<Instance>>()

const live = new Map<string, Instance>()

const nameOf = (cls: string, name: string) => `${cls}/${name}`

/** The actor ids of the objects awake in this process (what /_admin/actors calls awake: the engine's list doesn't say). */
export const awakeHere = (): ReadonlySet<string> => new Set(instances.keys())

const instanceOf = (c: ActorContext, cls: string): Promise<Instance> => {
  const existing = instances.get(c.actorId)

  if (existing !== undefined) return existing

  const began = performance.now()
  const made = start(c, cls)

  onFlush(c.actorId, async () => await durable(c))
  instances.set(c.actorId, made)
  made.then(
    () => {
      say("info", `actor: ${nameOf(cls, c.key[1] ?? "")} awake`, {
        actor: nameOf(cls, c.key[1] ?? ""),
        ms: Math.round(performance.now() - began),
      })

      return undefined
    },
    (error: unknown) => {
      instances.delete(c.actorId)
      say("error", `actor: ${nameOf(cls, c.key[1] ?? "")} failed to start`, {
        actor: nameOf(cls, c.key[1] ?? ""),
        cause: error instanceof Error ? (error.stack ?? error.message) : String(error),
      })

      return undefined
    },
  )

  return made
}

const start = async (c: ActorContext, cls: string): Promise<Instance> => {
  const impl = implOf(cls)

  if (impl === undefined) throw new Error(`no Durable Object class "${cls}" is declared here`)

  const name = c.key[1] ?? ""
  // What start-up builds (an MCP server, say) lives as long as the object does.
  const scope = Scope.makeUnsafe()
  const book = await makeJobBook(c.db)
  const storage = await makeStorage(c.db)
  const sockets = new Set<Socket>()

  // Set while the object is built (an app's constructor sets it), before its instance exists: kept here and given to the instance.
  // Looked up from `live` instead, it was lost, and a page's "ping" got no "pong".
  let autoResponse: Instance["autoResponse"]

  const state: ObjectState = {
    cls,
    id: { toString: () => name },
    storage,
    getWebSockets: () => Effect.sync(() => [...sockets].filter((socket) => !socket.closed())),
    acceptWebSocket: (socket) =>
      Effect.sync(() => {
        sockets.add(socket)
      }),
    setWebSocketAutoResponse: (request, response) =>
      Effect.sync(() => {
        autoResponse = { request, response }

        const found = live.get(nameOf(cls, name))

        if (found !== undefined) found.autoResponse = autoResponse
      }),
  }

  const exit = await Effect.runPromiseExit(
    observed(Effect.flatten(impl)).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(DurableObjectState, state),
      Effect.provideService(Jobs, book.jobs),
      Effect.provideService(WorkerLoader, loader),
      Effect.provideService(Browser, browser),
    ),
  )

  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)

  const instance: Instance = {
    cls,
    name,
    members: exit.value,
    state,
    book,
    sockets,
    scope,
    autoResponse,
    soon: undefined,
    ctx: c,
    stopping: false,
    pages: new Set(),
  }

  live.set(nameOf(cls, name), instance)

  // An object put to sleep any way (idle, /_admin/actors/sleep, the process stopping) leaves no entry behind with its database
  // closed: every call made here (callHere) would fail "Database is closed". Its abort signal fires on any stop.
  const retire = () => retireHere(instance)

  if (c.abortSignal.aborted) retire()
  else c.abortSignal.addEventListener("abort", retire, { once: true })

  // A wake-up for whatever jobs it already holds: they were booked before it slept or died.
  await arm(c, instance)

  return instance
}

/** Book the object's one wake-up for its earliest job (or none), then make the booking durable before anyone is told it is. */
const arm = async (c: ActorContext, instance: Instance) => {
  c.wake(await instance.book.next())
  // At once: inside the turn, nobody else can add to the commit (see durable).
  await commit(c.db, false)
  instance.book.settled()
}

/** Run the jobs that are due (and the object's own `alarm`), arm the next wake-up, and make it all durable. */
const fire = async (c: ActorContext, instance: Instance) => {
  await execute(instance, instance.book.dispatch())

  if (Object.hasOwn(instance.members, "alarm")) {
    await execute(instance, member(instance, "alarm", [{ retryCount: 0, isRetry: false }]))
  }

  // The wake-up that fired is spent; arm the next.
  await arm(c, instance)
  await settle(c, instance)
}

/** A job the event booked has its wake-up: done before the event gives its turn up. */
const booked = async (c: ActorContext, instance: Instance) => {
  if (instance.book.changed()) await arm(c, instance)
}

/** The end of an event that keeps its turn to the end (an alarm, a socket message): a booked job armed, its writes durable. */
const settle = async (c: ActorContext, instance: Instance) => {
  await booked(c, instance)
  await durable(c)
}

// An output gate, for requests (call, http): the event gives its turn up as soon as its code is done, and its answer waits for its
// writes to be durable outside it, so the next event runs meanwhile and shares the commit. Waiting inside the turn made an object's
// writes one at a time, each paying for its own commit: 32 writers got 58 writes a second, as many as one did; with the gate, 277.

/**
 * The object's writes so far have run (queued kv writes included); each async statement is durable when it returns.
 *
 * Outside the turn (a request's or a call's answer), the commit waits a moment to be shared when other events are under way, and
 * for the transaction its writes are in, even when another event holds it open. Inside the turn (`holdingTurn`: before an event
 * waits outside, an alarm's or a socket message's end) it commits at once: the events it would wait for are queued behind this
 * turn, so they could add nothing, and waiting held the object for 10 ms each time. One app's function, called by 8 clients at
 * once, went from 764 calls a second with one client to 153 (each run's wait for its sandbox began with that wait).
 */
const durable = async (c: ActorContext, holdingTurn = true) => {
  await commit(c.db, !holdingTurn && othersUnderWay(c.actorId), !holdingTurn)
  await drained(c.db)
}

// ---- running an object's code ----

const encodeError = (error: unknown): unknown => {
  if (typeof error !== "object" || error === null) return error

  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(error)) out[key] = value

  if (error instanceof Error && !("message" in out)) out["message"] = error.message

  return out
}

const encode = <A, E>(exit: Exit.Exit<A, E>): Envelope => {
  if (Exit.isSuccess(exit)) return { ok: true, json: toWire(exit.value) }

  const failure = exit.cause.reasons.find(Cause.isFailReason)

  if (failure !== undefined) return { ok: false, error: toWire(encodeError(failure.error)) }

  const squashed = Cause.squash(exit.cause)

  return {
    ok: false,
    defect: {
      message: squashed instanceof Error ? squashed.message : String(squashed),
      ...(squashed instanceof Error && squashed.stack !== undefined
        ? { stack: squashed.stack }
        : {}),
    },
  }
}

/** The arguments of a call, from the wire text they crossed as. */
const argsOf = (text: string): ReadonlyArray<unknown> => {
  const parsed = fromWire(text)

  return Array.isArray(parsed) ? parsed : []
}

const provided = <A, E, R>(instance: Instance, effect: Effect.Effect<A, E, R>) =>
  // SAFETY: the object's services are the only requirements its members may have (ObjectImpl); the type system can't see through the
  // record it returned.
  Effect.scoped(effect).pipe(
    Effect.provideService(DurableObjectState, instance.state),
    Effect.provideService(Jobs, instance.book.jobs),
    Effect.provideService(WorkerLoader, loader),
    Effect.provideService(Browser, browser),
  ) as Effect.Effect<A, E>

/** A member of the object, called: an Effect. */
const member = (instance: Instance, method: string, args: ReadonlyArray<unknown>) =>
  Effect.suspend((): Effect.Effect<unknown, unknown> => {
    if (!Object.hasOwn(instance.members, method)) {
      return Effect.die(new Error(`${instance.cls} has no method "${method}"`))
    }

    const found = instance.members[method]

    // SAFETY: a function member is called with the arguments the caller sent; what it returns is checked below.
    const result =
      typeof found === "function" ? (found as (...a: Array<unknown>) => unknown)(...args) : found

    // SAFETY: a member is an Effect or a function to one (ObjectMembers's contract); its requirements are provided in `provided`.
    return Effect.isEffect(result)
      ? (result as Effect.Effect<unknown, unknown>)
      : Effect.die(new Error(`${instance.cls}.${method} must be an Effect or return one`))
  })

const execute = async <A, E, R>(
  instance: Instance,
  effect: Effect.Effect<A, E, R>,
  parent?: string,
) => await Effect.runPromiseExit(observed(underParent(provided(instance, effect), parent)))

// ---- a request across the actor boundary ----

type SerializedRequest = {
  readonly method: string
  readonly url: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | null
}

type SerializedResponse = {
  readonly status: number
  readonly statusText: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | null
}

// SAFETY: Buffer.from reads the bytes of an ArrayBuffer or a view alike; its overloads don't say so.
const base64 = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes as ArrayBuffer).toString("base64")

const serializeRequest = async (request: Request): Promise<SerializedRequest> => ({
  method: request.method,
  url: request.url,
  headers: [...request.headers.entries()],
  body:
    request.body === null || request.method === "GET" || request.method === "HEAD"
      ? null
      : base64(await request.arrayBuffer()),
})

const requestOf = (s: SerializedRequest) =>
  new Request(s.url, {
    method: s.method,
    headers: s.headers.map(([k, v]): [string, string] => [k, v]),
    ...(s.body === null ? {} : { body: Buffer.from(s.body, "base64") }),
  })

const NO_BODY = new Set([101, 204, 205, 304])

const serializeResponse = async (response: Response): Promise<SerializedResponse> => ({
  status: response.status,
  statusText: response.statusText,
  headers: [...response.headers.entries()],
  body: NO_BODY.has(response.status) ? null : base64(await response.arrayBuffer()),
})

const responseOf = (s: SerializedResponse) =>
  new Response(s.body === null ? null : Buffer.from(s.body, "base64"), {
    status: s.status,
    statusText: s.statusText,
    headers: s.headers.map(([k, v]): [string, string] => [k, v]),
  })

const fetchEffect = Effect.fn("Runtime.fetch")(function* (instance: Instance, request: Request) {
  const handler = instance.members["fetch"]

  if (!Effect.isEffect(handler)) return new Response("Not implemented", { status: 404 })

  const context = yield* Effect.context()

  // SAFETY: `fetch` is an Effect of an HTTP response needing the request (ObjectMembers's contract).
  const response = yield* (handler as Effect.Effect<HttpServerResponse.HttpServerResponse>).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
  )

  return HttpServerResponse.toWeb(response, { context })
})

// ---- a call to an object in this process ----

/** No call runs in this instance again (it is going to sleep): its pages close, and open again to wherever it wakes next. */
const retireHere = (instance: Instance) => {
  instance.stopping = true

  if (live.get(nameOf(instance.cls, instance.name)) === instance) {
    live.delete(nameOf(instance.cls, instance.name))
  }

  closePages(instance)
}

/** Close the pages bridged to it here: the SDK opens them again, to wherever the object wakes next. */
const closePages = (instance: Instance) => {
  for (const end of instance.pages) {
    end.ended()

    try {
      end.page.close(1012, "the object moved")
    } catch {
      // already closed
    }
  }

  instance.pages.clear()
}

/** The object, if it is awake in this process and not being put to sleep: a call to it then runs here (callHere, fetchHere). */
const here = (cls: string, name: string) => {
  const instance = live.get(nameOf(cls, name))

  return instance === undefined || instance.stopping ? undefined : instance
}

/** A call to an object in this process, in its turn: its booked jobs armed, its writes durable before the answer. */
const callHere = async (instance: Instance, method: string, args: string, parent?: string) => {
  const c = instance.ctx

  const exit = await event(c.actorId, instance.cls, instance.name, async () => {
    const ran = await execute(
      instance,
      member(instance, method, argsOf(args)).pipe(Effect.withSpan(`${instance.cls}.${method}`)),
      parent,
    )

    await booked(c, instance)

    return ran
  })

  await durable(c, false)

  return encode(exit)
}

/** A request to an object awake in this process, run here as the actor's `http` action runs it (see callHere). */
const fetchHere = async (instance: Instance, request: Request) => {
  const c = instance.ctx

  const exit = await event(c.actorId, instance.cls, instance.name, async () => {
    const ran = await execute(
      instance,
      fetchEffect(instance, request).pipe(Effect.withSpan(`${instance.cls}.fetch`)),
      request.headers.get(SPAN_HEADER) ?? undefined,
    )

    await booked(c, instance)

    return ran
  })

  await durable(c, false)

  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)

  return exit.value
}

// ---- a page's socket bridged in this process ----

/** A page's end of a socket, as a bridge in this process holds it (serve.ts, the internal server). */
export type PageEnd = {
  readonly send: (data: string | ArrayBuffer) => void
  readonly close: (code: number, reason: string) => void
}

/** What the page's messages and its close go to, once bridged here. */
export type LocalPeer = {
  readonly message: (data: string | ArrayBuffer) => void
  readonly close: (code: number, reason: string) => void
}

/**
 * Bridge a page's socket to an object awake in this process. The object is kept awake while the page is open (keepAwake).
 * Undefined when the object or the socket isn't here.
 */
const attachHere = (
  cls: string,
  name: string,
  sid: string,
  page: PageEnd,
): LocalPeer | undefined => {
  const instance = here(cls, name)

  if (instance === undefined) return undefined

  const socket = claimSocket(sid)

  if (socket === undefined) return undefined

  const c = instance.ctx

  let release: () => void = nothing

  const open = new Promise<void>((resolve) => {
    release = resolve
  })

  const end = { page, ended: () => release() }

  instance.pages.add(end)

  try {
    void c.keepAwake(open)
  } catch {
    // a context already stopping: its pages close with it
  }

  socket.connect({
    send: (data) => page.send(data),
    close: (code, reason) => page.close(code, reason),
  })

  return {
    message: (data) => {
      if (instance.autoResponse !== undefined && data === instance.autoResponse.request) {
        page.send(instance.autoResponse.response)

        return
      }

      void event(c.actorId, cls, instance.name, async () => {
        await execute(instance, member(instance, "webSocketMessage", [socket, data]))
        await settle(c, instance)
      }).catch(() => undefined)
    },
    close: (code, reason) => {
      instance.pages.delete(end)
      release()
      socket.disconnected()
      instance.sockets.delete(socket)

      void event(c.actorId, cls, instance.name, async () => {
        await execute(instance, member(instance, "webSocketClose", [socket, code, reason, true]))
        await settle(c, instance)
      }).catch(() => undefined)
    },
  }
}

// ---- the machine's other platform processes ----
//
// With several processes (runtime/supervisor.ts) a request lands on any of them (the kernel spreads connections), and an object
// lives in the one its key hashes to (ownerOf). A call, a request or a socket for an object another process owns goes straight to
// that process over loopback (its internal server); the supervisor tells each process the others' ports.

const SELF = Number(process.env["OPENBELT_PROCESS"] ?? "-1")

const shared = Number(process.env["OPENBELT_PROCESSES"] ?? "1") > 1 && process.send !== undefined

/** Each process's internal server's port. */
const peers = new Map<number, number>()

/** What a platform process and its supervisor say about the processes' internal servers. */
export type PeerMessage =
  | { readonly t: "peer"; readonly port: number }
  | { readonly t: "peers"; readonly ports: ReadonlyArray<readonly [number, number]> }

if (shared)
  process.on("message", (message: PeerMessage) => {
    if (typeof message !== "object" || message === null || message.t !== "peers") return

    peers.clear()

    for (const [index, port] of message.ports) peers.set(index, port)

    for (const told of peersTold) told()
  })

/** Calls waiting for a peer's port (portFor), woken when the supervisor sends the ports. */
const peersTold = new Set<() => void>()

/** Nothing to do (a placeholder before a promise's resolve is known). */
const nothing = () => undefined

const internal = (port: number, path: string, cls: string, name: string) =>
  `http://127.0.0.1:${port}${path}?cls=${encodeURIComponent(cls)}&name=${encodeURIComponent(name)}`

/** A call sent to the process holding the object (its internal server). */
const forwardCall = async (
  port: number,
  cls: string,
  name: string,
  method: string,
  args: string,
  parent: string | undefined,
): Promise<unknown> => {
  const response = await fetch(internal(port, "/call", cls, name), {
    method: "POST",
    headers: { ...internalHeaders, "content-type": "application/json" },
    body: JSON.stringify({ method, args, parent: parent ?? null }),
  })

  if (!response.ok)
    throw new Error(
      `the process holding ${cls}/${name} answered ${response.status}: ${await response.text()}`,
    )

  return await response.json()
}

/**
 * How long a forwarded request waits for the process holding its object: the front door's idle limit (serve.ts), past which the
 * request it serves is gone anyway. Unbounded, fetch's own limit (300 s) held MCP calls 5 minutes under a 900 requests a second
 * overload.
 */
const FORWARD_MS = 120_000

/** A request sent to the process holding the object, answered as the engine answers one (a serialized response: a 101 too). */
const forwardFetch = async (port: number, cls: string, name: string, request: Request) => {
  const response = await fetch(internal(port, "/fetch", cls, name), {
    method: "POST",
    headers: { ...internalHeaders, "content-type": "application/json" },
    body: JSON.stringify(await serializeRequest(request)),
    signal: AbortSignal.timeout(FORWARD_MS),
  })

  if (!response.ok)
    throw new Error(
      `the process holding ${cls}/${name} answered ${response.status}: ${await response.text()}`,
    )

  // SAFETY: the internal server answers what serializeResponse made.
  return responseOf((await response.json()) as SerializedResponse)
}

/** How long an object with nothing to do stays in memory before it sleeps (its state is kept; the next call wakes it). */
const sleepMs = positive("OPENBELT_ACTOR_SLEEP_SECONDS", 600) * 1000

/** How long an object being put to sleep waits for its events under way, within the process's stop (shutdown.ts). */
const SLEEP_DRAIN_MS = 4000

// ---- hosting ----

export type HostOptions = {
  readonly namespace: string
}

export type Host = {
  /** A page's socket bridged to its object in this process, if the object and its socket are here. */
  readonly attach: (cls: string, name: string, sid: string, page: PageEnd) => LocalPeer | undefined
  /** The internal server's address for a page's socket whose object another process of this machine holds. */
  readonly peerSocket: (cls: string, name: string, sid: string) => string | undefined
}

/** Stop the objects this process runs; set once the host runs. */
export let stopHost: () => Promise<void> = async () => undefined

// ---- where objects live, and their wake-ups ----
//
// Each object lives in the process its key hashes to (FNV-1a over cls/name, mod OPENBELT_PROCESSES). A process starts an object the
// first time something asks for it, gives it a context of its own (its file in OPENBELT_DATA, named after its key), and puts it to
// sleep when it has been idle for OPENBELT_ACTOR_SLEEP_SECONDS with no page open. A wake-up it books is a timer in this process and a
// row in <data>/<namespace>/.wakes-<process>.sqlite; a process that starts arms the rows it owns, so a job comes due after a crash.

/** The namespace this process serves (startHost): its objects' files are under <data>/<namespace>. */
let namespace = ""

/** The namespace this process serves (startHost). */
export const hostNamespace = () => namespace

const PROCESS_COUNT = Math.max(1, Number(process.env["OPENBELT_PROCESSES"] ?? "1"))

/** Which process owns the object. */
const ownerOf = (cls: string, name: string) => objectHash(nameOf(cls, name)) % PROCESS_COUNT

/** A file-safe id from the object's key: readable, and unique by its hash. */
/** Whether an object has a file in this namespace (it was ever started), asked without starting it or making one. */
export const hasFile = (cls: string, name: string) =>
  existsSync(joinPath(dataDir(), namespace, `${objectFileId(cls, name)}.sqlite`))

type LocalObject = {
  readonly cls: string
  readonly name: string
  readonly ctx: ActorContext
  readonly abort: AbortController
  active: number
  used: number
  sleeping: Promise<void> | undefined
}

const localObjects = new Map<string, LocalObject>()

/** Wake-ups booked by objects this process owns (asleep or awake), by key. */
const localTimers = new Map<
  string,
  { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }
>()

let wakeIndex: Database | undefined

const wakeRow = (key: string, cls: string, name: string, at: number | null) => {
  if (wakeIndex === undefined) return

  if (at === null) wakeIndex.query("DELETE FROM wakes WHERE key = ?").run(key)
  else
    wakeIndex
      .query(
        "INSERT INTO wakes (key, cls, name, at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at",
      )
      .run(key, cls, name, at)
}

/** The object's alarm: started if it isn't, its due jobs run in its turn. */
const fireLocal = async (cls: string, name: string) => {
  try {
    const object = await ensureLocal(cls, name)

    object.used = Date.now()

    await event(object.ctx.actorId, cls, name, async () => {
      await fire(object.ctx, await instanceOf(object.ctx, cls))
    })
  } catch (error) {
    say("error", `actor: ${nameOf(cls, name)} alarm failed`, {
      cause: String(error).slice(0, 300),
    })
  }
}

const armLocalTimer = (cls: string, name: string, at: number) => {
  const key = nameOf(cls, name)

  clearTimeout(localTimers.get(key)?.timer)

  const wait = Math.max(0, at - Date.now())

  const timer = setTimeout(
    () => {
      localTimers.delete(key)

      // Woken early (setTimeout holds at most 24.8 days): look again.
      if (Date.now() < at) return armLocalTimer(cls, name, at)

      void fireLocal(cls, name)
    },
    Math.min(wait, 3_600_000),
  )

  localTimers.set(key, { at, timer })
}

const localContext = (
  cls: string,
  name: string,
  db: RawDb,
  abort: AbortController,
): ActorContext => {
  const key = nameOf(cls, name)

  return {
    actorId: objectFileId(cls, name),
    key: [cls, name],
    db,
    wake: (at) => {
      const armed = localTimers.get(key)

      // Unchanged: nothing to write (an every-minute schedule books its next run each minute; most bookings change nothing).
      if (armed?.at === (at ?? undefined)) return

      if (at === null) {
        clearTimeout(armed?.timer)
        localTimers.delete(key)
      } else armLocalTimer(cls, name, at)

      wakeRow(key, cls, name, at)
    },
    keepAwake: async (promise) => {
      const object = localObjects.get(key)

      if (object !== undefined) object.active++

      try {
        return await promise
      } finally {
        if (object !== undefined) {
          object.active--
          object.used = Date.now()
        }
      }
    },
    abortSignal: abort.signal,
  }
}

const starting = new Map<string, Promise<LocalObject>>()

/** The object in this process, started (its file opened, its code built) if it isn't. */
const ensureLocal = async (cls: string, name: string): Promise<LocalObject> => {
  const key = nameOf(cls, name)
  const found = localObjects.get(key)

  if (found !== undefined && found.sleeping === undefined) {
    found.used = Date.now()

    return found
  }

  if (found?.sleeping !== undefined) await found.sleeping

  const pending = starting.get(key)

  if (pending !== undefined) return await pending

  const made = (async () => {
    const id = objectFileId(cls, name)

    const db = await openLocal(namespace, id, { cls, name })

    const abort = new AbortController()

    const object: LocalObject = {
      cls,
      name,
      ctx: localContext(cls, name, db, abort),
      abort,
      active: 0,
      used: Date.now(),
      sleeping: undefined,
    }

    localObjects.set(key, object)
    await instanceOf(object.ctx, cls)

    return object
  })()

  starting.set(key, made)

  try {
    return await made
  } finally {
    starting.delete(key)
  }
}

/** Put the object to sleep: what it is doing finishes, its writes commit, its file closes. Its booked wake-up stays armed. */
const sleepLocal = async (object: LocalObject) => {
  const c = object.ctx
  const sleeping = live.get(nameOf(object.cls, object.name))

  if (sleeping !== undefined) sleeping.stopping = true

  await eventsEnded(c.actorId, SLEEP_DRAIN_MS)

  const gone = instances.get(c.actorId)

  instances.delete(c.actorId)

  const instance = await gone?.catch(() => undefined)

  if (instance !== undefined) {
    say("info", `actor: ${nameOf(instance.cls, instance.name)} asleep`, {
      actor: nameOf(instance.cls, instance.name),
    })
    live.delete(nameOf(instance.cls, instance.name))
    closePages(instance)
    await Effect.runPromise(Scope.close(instance.scope, Exit.void))
  }

  object.abort.abort()
  await commit(c.db, false).catch(() => undefined)
  await drained(c.db).catch(() => undefined)
  await closeLocal(c.actorId, object.cls)
}

const sleepIdle = () => {
  const now = Date.now()

  for (const [key, object] of localObjects) {
    if (object.sleeping !== undefined || object.active > 0 || now - object.used < sleepMs) continue

    const instance = live.get(key)

    if (instance !== undefined && instance.pages.size > 0) continue

    if (othersUnderWay(object.ctx.actorId)) continue

    void putToSleep(key, object)
  }
}

const putToSleep = (key: string, object: LocalObject) => {
  object.sleeping ??= sleepLocal(object).finally(() => {
    if (localObjects.get(key) === object) localObjects.delete(key)
  })

  return object.sleeping
}

/** Put the object with this id to sleep, if this process holds it (/_admin/actors/sleep). */
const sleepHere = async (id: string) => {
  for (const [key, object] of localObjects) {
    if (object.ctx.actorId !== id) continue

    await putToSleep(key, object)

    return true
  }

  return false
}

/** Put one object to sleep (its next call wakes it), in whichever of the machine's processes holds it. */
export const sleepActor = async (id: string): Promise<boolean> => {
  if (await sleepHere(id)) return true

  for (const port of peers.values()) {
    // oxlint-disable-next-line no-await-in-loop -- one process after another, until one holds it
    const answered = await fetch(`http://127.0.0.1:${port}/sleep?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: internalHeaders,
    }).catch(() => undefined)

    if (answered?.ok === true) return true
  }

  return false
}

const ownerPort = (cls: string, name: string) => peers.get(ownerOf(cls, name))

/**
 * How long a call waits for the owner's port: a process serves before the supervisor has sent it every other process's port, and a
 * process started again has none until it's up (a call in that window failed at once, "whose port isn't known yet", at 4 processes).
 */
const PORT_WAIT_MS = 10_000

/** The port of the process holding the object, once the supervisor has said it (PORT_WAIT_MS at most). */
const portFor = async (cls: string, name: string) => {
  const deadline = Date.now() + PORT_WAIT_MS

  for (;;) {
    const port = ownerPort(cls, name)

    if (port !== undefined) return port

    const left = deadline - Date.now()

    if (left <= 0) return notHere(cls, name)

    // oxlint-disable-next-line no-await-in-loop -- each message from the supervisor may or may not hold this port
    await new Promise<void>((done) => {
      const told = () => {
        clearTimeout(timer)
        peersTold.delete(told)
        done()
      }

      const timer = setTimeout(told, left)

      peersTold.add(told)
    })
  }
}

const callOwned = async (
  cls: string,
  name: string,
  method: string,
  args: string,
  parent?: string,
) => {
  const object = await ensureLocal(cls, name)
  const instance = await instanceOf(object.ctx, cls)

  object.used = Date.now()

  return await outside(() => callHere(instance, method, args, parent))
}

const fetchOwned = async (cls: string, name: string, request: Request) => {
  const object = await ensureLocal(cls, name)
  const instance = await instanceOf(object.ctx, cls)

  object.used = Date.now()

  return await outside(() => fetchHere(instance, request))
}

const notHere = (cls: string, name: string): never => {
  throw new Error(
    `${nameOf(cls, name)} belongs to process ${ownerOf(cls, name)}, whose port isn't known yet`,
  )
}

/** Run this process's objects: arm the wake-ups it owns, sleep idle objects, and serve the machine's other processes. */
export const startHost = async (options: HostOptions): Promise<Host> => {
  namespace = options.namespace

  const where = joinPath(dataDir(), options.namespace)

  mkdirSync(where, { recursive: true })
  // Every workspace's data is in there: the platform's user alone may open it, not the sandboxes' or check_app's Chrome's.
  chmodSync(dataDir(), 0o700)

  // One file per process (each writes only the objects it owns; several opening one file at start raced, "database is locked").

  const open = (file: string) => {
    const db = new Database(joinPath(where, file), { create: true, strict: false })

    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA journal_mode = WAL")
    // Synced with the WAL's next checkpoint, not on each booking: one write per booking on the main thread, no fsync of its own.
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec(
      "CREATE TABLE IF NOT EXISTS wakes (key TEXT PRIMARY KEY, cls TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL)",
    )

    return db
  }

  wakeIndex = open(`.wakes-${Math.max(0, SELF)}.sqlite`)

  const tryOpen = (file: string) => {
    try {
      return open(file)
    } catch {
      return undefined
    }
  }

  // The wake-ups this process owns, booked before it (or the process before it) stopped: in any process's file, since a different
  // number of processes owns differently.
  const rows = readdirSync(where)
    .filter((file) => file.startsWith(".wakes-") && file.endsWith(".sqlite"))
    .flatMap((file) => {
      // Another process's file, being made as this one starts: its rows are that process's.
      const db = file === `.wakes-${Math.max(0, SELF)}.sqlite` ? wakeIndex : tryOpen(file)

      if (db === undefined) return []

      // SAFETY: the rows are what wakeRow writes.
      const found = db.query("SELECT cls, name, at FROM wakes").all() as Array<{
        cls: string
        name: string
        at: number
      }>

      if (db !== wakeIndex) db.close()

      return found
    })

  const mine = (cls: string, name: string) => PROCESS_COUNT === 1 || ownerOf(cls, name) === SELF

  let armed = 0

  for (const row of rows) {
    if (!mine(row.cls, row.name)) continue

    armLocalTimer(row.cls, row.name, row.at)
    armed++
  }

  say("info", `runtime: local, ${armed} booked wake-ups armed`, { armed })

  setInterval(sleepIdle, 5000).unref()

  stopHost = async () => {
    await Promise.all([...localObjects.values()].map(async (o) => o.sleeping ?? sleepLocal(o)))
  }

  if (shared) {
    type Pipe = {
      readonly cls: string
      readonly name: string
      readonly sid: string
      peer?: LocalPeer | undefined
    }

    const server = Bun.serve<Pipe>({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 120,
      fetch: async (request, bun) => {
        // Only the platform's own processes: anything else on the machine reaches loopback too.
        if (!fromPlatform(request)) return new Response("forbidden\n", { status: 403 })

        const url = new URL(request.url)
        const cls = url.searchParams.get("cls") ?? ""
        const name = url.searchParams.get("name") ?? ""

        try {
          if (url.pathname === "/call") {
            // SAFETY: forwardCall's body.
            const sent = (await request.json()) as {
              method: string
              args: string
              parent: string | null
            }

            return Response.json(
              await callOwned(cls, name, sent.method, sent.args, sent.parent ?? undefined),
            )
          }

          if (url.pathname === "/fetch") {
            // SAFETY: forwardFetch's body.
            const original = requestOf((await request.json()) as SerializedRequest)

            return Response.json(await serializeResponse(await fetchOwned(cls, name, original)))
          }

          if (url.pathname === "/awake")
            return Response.json([...localObjects.values()].map((o) => o.ctx.actorId))

          // What this process kept for the operator's views (gateway /_admin/logs, trace, metrics): each process keeps its own.
          if (url.pathname === "/admin/logs")
            // SAFETY: machineLogs's query, as JSON.
            return Response.json(logsOf(JSON.parse(url.searchParams.get("q") ?? "{}") as LogQuery))

          if (url.pathname === "/admin/resolve")
            return new Response(resolveTrace(url.searchParams.get("id") ?? "") ?? "")

          if (url.pathname === "/admin/trace")
            return Response.json(
              traceView(
                url.searchParams.get("id") ?? "",
                url.searchParams.get("span") ?? undefined,
              ),
            )

          if (url.pathname === "/admin/metrics")
            return new Response(await Effect.runPromise(prometheusText))

          if (url.pathname === "/sleep") {
            const slept = await sleepHere(url.searchParams.get("id") ?? "")

            return new Response(slept ? "asleep\n" : "not here\n", { status: slept ? 200 : 404 })
          }

          if (url.pathname === "/ws") {
            const sid = url.searchParams.get("sid") ?? ""

            if (bun.upgrade(request, { data: { cls, name, sid } })) return undefined

            return new Response("couldn't upgrade\n", { status: 500 })
          }

          return new Response("not found\n", { status: 404 })
        } catch (error) {
          return new Response(String(error).slice(0, 500), { status: 502 })
        }
      },
      websocket: {
        open: (ws) => {
          ws.data.peer = attachHere(ws.data.cls, ws.data.name, ws.data.sid, {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          })

          if (ws.data.peer === undefined) ws.close(1011, "the socket's object isn't here")
        },
        message: (ws, message) => {
          ws.data.peer?.message(
            typeof message === "string" ? message : new Uint8Array(message).slice().buffer,
          )
        },
        close: (ws, code, reason) => ws.data.peer?.close(code, reason),
      },
    })

    process.send?.({ t: "peer", port: server.port ?? 0 } satisfies PeerMessage)
  }

  const transport: Transport = {
    call: async (cls, name, method, args, parent) => {
      const held = current()

      if (held !== undefined && held.cls === cls && held.name === name && !held.ended) {
        const instance = live.get(nameOf(cls, name))

        if (instance !== undefined)
          return encode(await execute(instance, member(instance, method, argsOf(args)), parent))
      }

      if (mine(cls, name)) return await callOwned(cls, name, method, args, parent)

      return await forwardCall(await portFor(cls, name), cls, name, method, args, parent)
    },
    fetch: async (cls, name, request) => {
      if (mine(cls, name)) return await fetchOwned(cls, name, request)

      return await forwardFetch(await portFor(cls, name), cls, name, request)
    },
  }

  useTransport(transport)

  return {
    attach: attachHere,
    peerSocket: (cls, name, sid) => {
      if (mine(cls, name)) return undefined

      const port = ownerPort(cls, name)

      return port === undefined
        ? undefined
        : `ws://127.0.0.1:${port}/ws?cls=${encodeURIComponent(cls)}&name=${encodeURIComponent(name)}&sid=${encodeURIComponent(sid)}`
    },
  }
}

/** One object: its class and name, its id, and whether a process of this machine holds it awake. */
export type ActorView = {
  readonly object: string
  readonly id: string
  readonly state: "awake" | "asleep"
  readonly created: string | null
}

/** What each other process of this platform answers at `path` on its internal server (nothing from one that doesn't answer). */
const fromPeers = async <A>(path: string, read: (response: Response) => Promise<A>) =>
  (
    await Promise.all(
      [...peers]
        .flatMap(([index, port]) => (index === SELF ? [] : [port]))
        .map(async (port) => {
          const answered = await fetch(`http://127.0.0.1:${port}${path}`, {
            headers: internalHeaders,
            signal: AbortSignal.timeout(5000),
          }).catch(() => undefined)

          return answered?.ok === true ? [await read(answered)] : []
        }),
    )
  ).flat()

/** /_admin/logs for the whole platform: each process keeps the lines it logged. */
export const machineLogs = async (query: LogQuery): Promise<ReadonlyArray<LogRecord>> =>
  mergeLogs(
    [
      logsOf(query),
      ...(await fromPeers(
        `/admin/logs?q=${encodeURIComponent(JSON.stringify(query))}`,
        // SAFETY: a peer's /admin/logs answers logsOf's lines.
        async (r) => (await r.json()) as ReadonlyArray<LogRecord>,
      )),
    ],
    query.limit,
  )

/**
 * /_admin/trace for the whole platform: a call into an object another process owns ran its spans there. Asked by the span trace
 * this process resolved the id to, which only the process the request entered knows.
 */
export const machineTrace = async (id: string): Promise<TraceView> => {
  // The span trace the id ran in, from whichever process the request entered.
  const spanTrace =
    resolveTrace(id) ??
    (
      await fromPeers(`/admin/resolve?id=${encodeURIComponent(id)}`, async (r) => await r.text())
    ).find((answer) => answer !== "") ??
    id

  const ownTrace = traceView(id, spanTrace)

  return mergeTraces([
    ownTrace,
    ...(await fromPeers(
      `/admin/trace?id=${encodeURIComponent(id)}&span=${encodeURIComponent(spanTrace)}`,
      // SAFETY: a peer's /admin/trace answers traceView's view.
      async (r) => (await r.json()) as TraceView,
    )),
  ])
}

/** /_admin/metrics for the whole platform: each process's counters added up. */
export const machineMetrics = async (): Promise<string> =>
  mergeMetrics([
    await Effect.runPromise(prometheusText),
    ...(await fromPeers("/admin/metrics", async (r) => await r.text())),
  ])

/** Every object of the namespace with a file, awake (held by a process of this machine) or asleep: /_admin/actors. */
export const localActors = async (): Promise<ReadonlyArray<ActorView>> => {
  const where = joinPath(dataDir(), namespace)

  const elsewhere = await Promise.all(
    [...peers.values()].map(async (port) => {
      const answered = await fetch(`http://127.0.0.1:${port}/awake`, {
        headers: internalHeaders,
      }).catch(() => undefined)

      // SAFETY: the internal server's /awake answers a list of ids.
      return answered?.ok === true ? ((await answered.json()) as ReadonlyArray<string>) : []
    }),
  )

  const awake = new Set([
    ...[...localObjects.values()].map((o) => o.ctx.actorId),
    ...elsewhere.flat(),
  ])

  return readdirSync(where)
    .filter((file) => file.endsWith(".sqlite") && !file.startsWith("."))
    .map((file) => {
      const id = file.slice(0, -".sqlite".length)
      const cls = id.split("-")[0] ?? ""

      return {
        object: `${cls}/${id.slice(cls.length + 1)}`,
        id,
        state: awake.has(id) ? ("awake" as const) : ("asleep" as const),
        created: new Date(statSync(joinPath(where, file)).birthtimeMs).toISOString(),
      }
    })
}
