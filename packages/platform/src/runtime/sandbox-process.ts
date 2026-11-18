// A tenant's sandbox process (sandbox.ts starts it, with a clean environment; it confines itself before it takes any code,
// sandbox-confine.ts). Messages come and go as JSON lines on its stdin and stdout. A set of code runs in boxes: each a QuickJS instance (WASM) of its own, its
// linear memory capped, the code's modules loaded once. A box does one run at a time, so module scope lasts from run to run in it
// (as a warm process's did) and a run's logs, calls and timers are known to be that run's; runs at once get boxes of their own. A
// run's CPU time is counted while its box runs, and an interrupt stops it past its budget.
import { createHash, createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import variant from "@jitl/quickjs-ng-wasmfile-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core"
import { confine } from "./sandbox-confine.ts"
import { GLOBALS } from "./sandbox-globals.ts"

type Code = { readonly main: string; readonly modules: Readonly<Record<string, string>> }

export type ToWorker =
  | { readonly t: "code"; readonly id: string; readonly code: Code }
  | {
      readonly t: "run"
      readonly run: string
      readonly id: string
      readonly method: string
      readonly args: string
      readonly cpuMs: number
      readonly memoryMb: number
    }
  | { readonly t: "reply"; readonly run: string; readonly call: number; readonly text: string }
  | { readonly t: "stop"; readonly run: string; readonly why: string }

type FromWorker =
  | { readonly t: "ready"; readonly confined: string }
  | { readonly t: "log"; readonly text: string }
  | { readonly t: "call"; readonly run: string; readonly call: number; readonly op: string }
  | { readonly t: "done"; readonly run: string; readonly ok: boolean; readonly payload: string }
  | { readonly t: "boxes"; readonly alive: number; readonly made: number }
  | {
      readonly t: "usage"
      readonly cpuMs: number
      readonly peakKb: number
      readonly wasmBytes: number
    }

const MB = 1024 * 1024

const IDLE_BYTES = Number(process.argv[2] ?? "128") * MB

const PAGE = 65_536

/** Idle boxes of one set of code kept past WARM_MS: a burst's extras are dropped once idle, so memory falls back. */
const KEEP_WARM = 4

const warmSeconds = Number(process.env.OPENBELT_SANDBOX_WARM_SECONDS ?? "")

const WARM_MS = (Number.isInteger(warmSeconds) && warmSeconds > 0 ? warmSeconds : 30) * 1000

/** What node:async_hooks is in a box: a box does one run at a time, so the store is that run's for as long as it lasts. */
const ASYNC_HOOKS = `
export class AsyncLocalStorage {
  #store = undefined
  getStore() { return this.#store }
  run(store, fn, ...args) { this.#store = store; return fn(...args) }
  enterWith(store) { this.#store = store }
  exit(fn, ...args) { return fn(...args) }
  disable() { this.#store = undefined }
  static bind(fn) { return fn }
  static snapshot() { return (fn, ...args) => fn(...args) }
}
export class AsyncResource {
  constructor(type) { this.type = type }
  runInAsyncScope(fn, self, ...args) { return fn.apply(self, args) }
  bind(fn) { return fn.bind(this) }
  static bind(fn) { return fn }
}
export default { AsyncLocalStorage, AsyncResource }
`

// Each run's callback is bound to its token: a call made by code a finished run left behind is refused, never taken as the next run's.
const serve = (main: string) => `
import Runner from ${JSON.stringify(`/app/${main}`)};
const call = globalThis.__hcall;
delete globalThis.__hcall;
const runner = new Runner({}, {});
globalThis.__start = (token, method, argsJson) => {
  const args = JSON.parse(argsJson).map((a) => (a !== null && typeof a === "object" && a.__host === true ? (op) => call(token, JSON.stringify(op)).then((t) => JSON.parse(t)) : a));
  return Promise.resolve(runner[method](...args)).then((r) => JSON.stringify(r === undefined ? null : r));
};
`

/** QuickJS's WASM, compiled once (a box compiling its own took 2.1 ms of the 2.7 a box costs) and read before the process confines
 * itself: after that it can read no file. */
const COMPILED = new WebAssembly.Module(
  readFileSync(
    new URL(
      "dist/emscripten-module.wasm",
      import.meta.resolve("@jitl/quickjs-ng-wasmfile-release-sync/package.json"),
    ),
  ),
)

/**
 * A box's own WASM module, its memory capped: the heap limit is the memory's, since QuickJS's own malloc limit counts a fraction of
 * what this build allocates (a 16 MB limit let one run reach 2.2 GB). A box's memory goes when the box does.
 */
const makeModule = (memoryMb: number) =>
  newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: (memoryMb * MB) / PAGE }),
      wasmModule: COMPILED,
    }),
  )

type Run = {
  readonly id: string
  readonly token: number
  readonly box: Box
  readonly cpuMs: number
  cpu: number
  stopped: string | undefined
  answer: QuickJSHandle | undefined
  done: boolean
}

type Box = {
  readonly code: string
  readonly mod: QuickJSWASMModule
  readonly rt: QuickJSRuntime
  readonly vm: QuickJSContext
  readonly memoryMb: number
  readonly calls: Map<number, { readonly token: number; readonly deferred: QuickJSDeferredPromise }>
  readonly timers: Map<number, ReturnType<typeof setTimeout>>
  run: Run | undefined
  sliceAt: number
  inSlice: boolean
  /** It hit a limit: not offered again. */
  broken: boolean
  /** When its last run ended. */
  freed: number
}

const codes = new Map<string, Code>()

const runs = new Map<string, Run>()

const idle = new Set<Box>()

let nextCall = 1

let nextToken = 1

let alive = 0

/** Every box alive, busy or idle: their WASM memory is most of what the process holds. */
const living = new Set<Box>()

let made = 0

const post = (message: FromWorker) => process.stdout.write(`${JSON.stringify(message)}\n`)

const counted = () => post({ t: "boxes", alive, made })

const errorText = (vm: QuickJSContext, handle: QuickJSHandle) => {
  // SAFETY: what QuickJS dumps for a thrown value: an error's fields, or the value itself
  const e = vm.dump(handle) as { name?: string; message?: string; stack?: string } | string

  if (typeof e !== "object" || e === null) return e

  return `${e.name ?? "Error"}: ${e.message ?? ""}${e.stack ? `\n${e.stack}` : ""}`
}

const dispose = (box: Box) => {
  idle.delete(box)

  // A box is its own WASM module: dropping it frees everything. One that hit a limit isn't torn down first (QuickJS's teardown of
  // a heap it ran out of, or a run it was interrupted in, aborts); a healthy one is, so a leak in it would show.
  if (!box.broken) {
    try {
      for (const { deferred } of box.calls.values()) deferred.dispose()
      box.calls.clear()
      box.vm.dispose()
      box.rt.dispose()
    } catch (error) {
      post({ t: "log", text: `sandbox: a box's teardown failed (${String(error).slice(0, 200)})` })
    }
  }

  alive -= 1
  living.delete(box)
  counted()
}

const cache = (box: Box) => {
  if (box.mod.getWasmMemory().buffer.byteLength > IDLE_BYTES) {
    dispose(box)

    return
  }

  idle.add(box)
  let bytes = [...idle].reduce((sum, b) => sum + b.mod.getWasmMemory().buffer.byteLength, 0)

  for (const oldest of idle) {
    if (bytes <= IDLE_BYTES) break
    bytes -= oldest.mod.getWasmMemory().buffer.byteLength
    dispose(oldest)
  }
}

const heapLimit = (box: Box) =>
  `the sandbox stopped it: it went past its heap limit (${box.memoryMb} MB)`

const finish = (run: Run, ok: boolean, given: string, limit = false) => {
  if (run.done) return
  run.done = true
  runs.delete(run.id)
  const { box } = run
  box.run = undefined

  // What the run left: its timers don't fire, its calls in flight are dropped (a reply finds nothing).
  for (const timer of box.timers.values()) clearTimeout(timer)
  box.timers.clear()

  if (limit) box.broken = true
  // Near its memory cap: not reused, and a run that failed there failed of it (the error itself may not have fit, and be null).
  const full = box.mod.getWasmMemory().buffer.byteLength > box.memoryMb * MB * 0.75
  let payload = given

  if (full) box.broken = true

  if (full && !ok) payload = heapLimit(box)

  if (ok && (full || payload.includes('"error":"out of memory"'))) {
    // SAFETY: a harness's answer is its JSON object; one that failed has ok: false and its error
    const said = JSON.parse(payload) as { ok?: boolean; error?: string }

    if (said.ok === false && (full || said.error === "out of memory")) {
      box.broken = true
      payload = JSON.stringify({ ...said, error: heapLimit(box) })
    }
  }

  // After the slice that finished it has unwound.
  queueMicrotask(() => {
    run.answer?.dispose()

    for (const [call, held] of box.calls) {
      if (held.token !== run.token) continue
      held.deferred.dispose()
      box.calls.delete(call)
    }

    box.freed = Date.now()

    if (box.broken) dispose(box)
    else cache(box)
    post({ t: "done", run: run.id, ok, payload })
  })
}

const fail = (run: Run, text: string) => {
  if (run.stopped !== undefined) return finish(run, false, run.stopped, true)

  if (run.cpu > run.cpuMs)
    return finish(
      run,
      false,
      `the sandbox stopped it: it used its ${run.cpuMs / 1000} s CPU-time budget (a loop that never yields?)`,
      true,
    )

  if (/out of memory/.test(text)) return finish(run, false, `${heapLimit(run.box)}\n${text}`, true)

  if (/stack overflow/.test(text))
    return finish(
      run,
      false,
      `RangeError: Maximum call stack size exceeded (it recursed too deep)\n${text}`,
      true,
    )
  finish(run, false, text)
}

/** Run QuickJS code in a box, counting its CPU time to the run the box is doing. */
const slice = <A>(box: Box, f: () => A): A => {
  const nested = box.inSlice

  if (!nested) {
    box.sliceAt = performance.now()
    box.inSlice = true
  }

  try {
    return f()
  } finally {
    if (!nested) {
      if (box.run !== undefined) box.run.cpu += performance.now() - box.sliceAt
      box.inSlice = false
    }
  }
}

/** Run what is ready in the box (promise jobs), then see whether the run's answer is in. */
const pump = (run: Run) => {
  if (run.done) return
  const { box } = run
  const jobs = slice(box, () => box.rt.executePendingJobs())

  if (jobs.error) {
    const text = errorText(box.vm, jobs.error)
    jobs.error.dispose()

    return fail(run, text)
  }

  if (run.cpu > run.cpuMs || run.stopped !== undefined) return fail(run, "")

  if (run.answer === undefined) return
  const state = box.vm.getPromiseState(run.answer)

  if (state.type === "pending") return

  if (state.type === "fulfilled") {
    const value = box.vm.dump(state.value)
    state.value.dispose()

    return finish(run, true, typeof value === "string" ? value : "null")
  }

  const text = errorText(box.vm, state.error)
  state.error.dispose()
  fail(run, text)
}

/** The host primitives the globals are made of (`__h`), and the run's way out (`__hcall`). */
const install = (box: Box) => {
  const { vm } = box
  const h = vm.newObject()

  const fn = (
    target: QuickJSHandle,
    name: string,
    f: (...args: Array<QuickJSHandle>) => QuickJSHandle | undefined,
  ) => {
    const defined = vm.newFunction(name, f)
    vm.setProp(target, name, defined)
    defined.dispose()
  }

  const bytes = (handle: QuickJSHandle) => {
    const view = vm.getArrayBuffer(handle)
    const copy = view.value.slice()
    view.dispose()

    return copy
  }

  const buffer = (b: Uint8Array) =>
    vm.newArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

  const url = (u: URL) =>
    vm.newString(
      JSON.stringify({
        href: u.href,
        origin: u.origin,
        protocol: u.protocol,
        username: u.username,
        password: u.password,
        host: u.host,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
      }),
    )

  const flag = (handle: QuickJSHandle | undefined) =>
    handle !== undefined && vm.dump(handle) === true

  fn(h, "now", () => vm.newNumber(performance.now()))
  fn(h, "timer", (msH, idH) => {
    const ms = vm.getNumber(msH)
    const id = vm.getNumber(idH)
    const run = box.run

    // A timer set outside a run (at a module's top level) never fires: there is no run to count it to.
    if (run === undefined) return undefined
    box.timers.set(
      id,
      setTimeout(() => {
        box.timers.delete(id)

        if (run.done || box.run !== run) return
        const fire = vm.getProp(vm.global, "__fire")
        const idHandle = vm.newNumber(id)
        const fired = slice(box, () => vm.callFunction(fire, vm.undefined, idHandle))
        fire.dispose()
        idHandle.dispose()

        if (fired.error) {
          const text = errorText(vm, fired.error)
          fired.error.dispose()

          return fail(run, text)
        }

        fired.value.dispose()
        pump(run)
      }, ms),
    )

    return undefined
  })
  fn(h, "clear", (idH) => {
    const id = vm.getNumber(idH)
    clearTimeout(box.timers.get(id))
    box.timers.delete(id)

    return undefined
  })
  // The globals send the text after one character of their own (a leading byte-order mark would be lost on the way).
  fn(h, "enc", (s) => buffer(new TextEncoder().encode(vm.getString(s).slice(1))))
  fn(h, "dec", (b, fatal) =>
    vm.newString(new TextDecoder("utf-8", { fatal: flag(fatal) }).decode(bytes(b))),
  )
  fn(h, "b64enc", (b, urlSafe, omit) => {
    const text = Buffer.from(bytes(b)).toString(flag(urlSafe) ? "base64url" : "base64")

    return vm.newString(flag(omit) ? text.replace(/=+$/, "") : text)
  })
  fn(h, "b64dec", (s, urlSafe) =>
    buffer(Buffer.from(vm.getString(s), flag(urlSafe) ? "base64url" : "base64")),
  )
  fn(h, "url", (hrefH, baseH) => {
    const href = vm.getString(hrefH)
    const base = vm.typeof(baseH) === "string" ? vm.getString(baseH) : undefined
    const parsed = URL.parse(href, base)

    if (parsed === null) throw new TypeError(`Invalid URL: ${href}`)

    return url(parsed)
  })
  fn(h, "urlSet", (hrefH, fieldH, valueH) => {
    const u = new URL(vm.getString(hrefH))
    // SAFETY: the field is one of URL's settable string fields (the globals' list)
    const fields = u as unknown as Record<string, string>
    fields[vm.getString(fieldH)] = vm.getString(valueH)

    return url(u)
  })
  fn(h, "random", (n) =>
    buffer(crypto.getRandomValues(new Uint8Array(Math.min(65_536, vm.getNumber(n))))),
  )
  fn(h, "uuid", () => vm.newString(randomUUID()))
  // Intl, which QuickJS hasn't: one value formatted with this process's ICU, JSON each way.
  fn(h, "intl", (kindH, localesH, optionsH, methodH, argsH) => {
    const kind = vm.getString(kindH)
    // SAFETY: the globals send the locales as JSON they made (a string, a list or null)
    const locales = JSON.parse(vm.getString(localesH)) as string | Array<string> | null
    // SAFETY: and the options as a JSON object
    const options = JSON.parse(vm.getString(optionsH)) as Record<string, unknown>
    const method = vm.getString(methodH)

    // SAFETY: and the arguments as a JSON list, a date as { $date: ms }
    const args = (JSON.parse(vm.getString(argsH)) as Array<unknown>).map((a) =>
      a !== null && typeof a === "object" && "$date" in a ? new Date(Number(a.$date)) : a,
    )

    // SAFETY: kind names one of Intl's constructors, method one of its methods
    const Made = (
      Intl as unknown as Record<
        string,
        new (l: unknown, o: unknown) => Record<string, (...a: Array<unknown>) => unknown>
      >
    )[kind]

    if (Made === undefined) throw new TypeError(`Intl.${kind} isn't supported here`)
    let formatter: Record<string, (...a: Array<unknown>) => unknown>

    try {
      formatter = new Made(locales ?? undefined, options)
    } catch (error) {
      throw new RangeError(error instanceof Error ? error.message : String(error))
    }

    const out = formatter[method]?.(...args)

    return vm.newString(JSON.stringify(out === undefined ? null : out))
  })
  fn(h, "digest", (alg, data) => buffer(createHash(vm.getString(alg)).update(bytes(data)).digest()))
  fn(h, "hmac", (alg, key, data) =>
    buffer(createHmac(vm.getString(alg), bytes(key)).update(bytes(data)).digest()),
  )
  vm.setProp(vm.global, "__h", h)
  h.dispose()

  fn(vm.global, "__hcall", (tokenH, opH) => {
    const token = vm.getNumber(tokenH)
    const op = vm.getString(opH)
    const deferred = vm.newPromise()
    const run = box.run

    if (run === undefined || run.token !== token) {
      const refused = vm.newError("this run has ended, so its calls are refused")
      deferred.reject(refused)
      refused.dispose()
      const handle = deferred.handle.dup()
      deferred.dispose()

      return handle
    }

    const call = nextCall++
    box.calls.set(call, { token, deferred })
    post({ t: "call", run: run.id, call, op })

    return deferred.handle
  })
}

/** Evaluate `source` in a new box, as a script or (`module`) a module whose evaluation is a promise; the error's text if it fails. */
const evaluate = (box: Box, source: string, file: string, module: boolean): string | undefined => {
  const { vm } = box

  const result = slice(box, () =>
    vm.evalCode(source, file, module ? { type: "module" } : undefined),
  )

  if (result.error) {
    const text = errorText(vm, result.error)
    result.error.dispose()

    return text
  }

  const value = result.value
  const jobs = slice(box, () => box.rt.executePendingJobs())

  if (jobs.error) {
    const text = errorText(vm, jobs.error)
    jobs.error.dispose()
    value.dispose()

    return text
  }

  const state = vm.getPromiseState(value)

  if (state.type === "rejected") {
    const text = errorText(vm, state.error)
    state.error.dispose()
    value.dispose()

    return text
  }

  // a value that isn't a promise comes back as itself
  if (state.type === "fulfilled" && state.value !== value && state.value.alive)
    state.value.dispose()
  value.dispose()

  return undefined
}

/** A box for the code `codeId`: an idle one, or a new one with the code loaded; the reason as text when there can't be one. */
const boxFor = async (codeId: string, memoryMb: number): Promise<Box | string> => {
  const reused = [...idle].findLast((box) => box.code === codeId)

  if (reused !== undefined) {
    idle.delete(reused)

    return reused
  }

  const code = codes.get(codeId)

  if (code === undefined) return "the sandbox lost its code"
  const mod = await makeModule(memoryMb)
  const rt = mod.newRuntime()
  rt.setMaxStackSize(MB)
  const vm = rt.newContext()

  const box: Box = {
    code: codeId,
    mod,
    rt,
    vm,
    memoryMb,
    calls: new Map(),
    timers: new Map(),
    run: undefined,
    sliceAt: 0,
    inSlice: false,
    broken: false,
    freed: 0,
  }

  alive += 1
  made += 1
  living.add(box)
  counted()
  // Code that runs while the box loads (a module's top level) has no run to count to: it gets 10 s.
  rt.setInterruptHandler(() => {
    const run = box.run

    if (run === undefined) return box.inSlice && performance.now() - box.sliceAt > 10_000

    return (
      run.stopped !== undefined ||
      (box.inSlice && run.cpu + (performance.now() - box.sliceAt) > run.cpuMs)
    )
  })
  rt.setModuleLoader(
    (name) => {
      if (name === "node:async_hooks") return ASYNC_HOOKS
      const text = code.modules[name.replace(/^\/app\//, "")]

      return text === undefined ? { error: new Error(`Cannot find module '${name}'`) } : text
    },
    (base, requested) =>
      requested.startsWith("node:")
        ? requested
        : new URL(requested, `file://${base.startsWith("/") ? base : `/app/${base}`}`).pathname,
  )
  install(box)

  const problem =
    evaluate(box, GLOBALS, "globals.js", false) ??
    evaluate(box, serve(code.main), "/app/.serve.js", true)

  if (problem === undefined) return box
  dispose(box)

  return problem
}

const start = async (message: Extract<ToWorker, { t: "run" }>) => {
  const box = await boxFor(message.id, message.memoryMb)

  if (typeof box === "string") return post({ t: "done", run: message.run, ok: false, payload: box })

  const run: Run = {
    id: message.run,
    token: nextToken++,
    box,
    cpuMs: message.cpuMs,
    cpu: 0,
    stopped: undefined,
    answer: undefined,
    done: false,
  }

  box.run = run
  runs.set(run.id, run)
  const { vm } = box
  const begin = vm.getProp(vm.global, "__start")
  const token = vm.newNumber(run.token)
  const method = vm.newString(message.method)
  const args = vm.newString(message.args)
  const called = slice(box, () => vm.callFunction(begin, vm.undefined, token, method, args))
  begin.dispose()
  token.dispose()
  method.dispose()
  args.dispose()

  if (called.error) {
    const text = errorText(vm, called.error)
    called.error.dispose()

    return fail(run, text)
  }

  run.answer = called.value
  pump(run)
}

const handle = (message: ToWorker) => {
  switch (message.t) {
    case "code": {
      codes.set(message.id, message.code)

      return
    }

    case "run": {
      void start(message).catch((error: unknown) => {
        const text = `the sandbox failed: ${error instanceof Error ? error.message : String(error)}`
        const run = runs.get(message.run)

        if (run === undefined) post({ t: "done", run: message.run, ok: false, payload: text })
        else finish(run, false, text, true)
      })

      return
    }

    case "reply": {
      const run = runs.get(message.run)
      const held = run?.box.calls.get(message.call)

      if (run === undefined || held === undefined) return
      run.box.calls.delete(message.call)
      const text = run.box.vm.newString(message.text)
      held.deferred.resolve(text)
      text.dispose()
      held.deferred.dispose()
      pump(run)

      return
    }

    case "stop": {
      const run = runs.get(message.run)

      if (run === undefined) return
      run.stopped = message.why
      finish(run, false, message.why, true)
    }
  }
}

/** What was last reported, so a process at rest sends nothing. */
let reported = ""

/**
 * The process's CPU time, peak memory and its boxes' WASM memory, for the platform's metrics (sandbox.ts). Confined, it can read
 * its own rusage (getrusage) but not /proc: process.memoryUsage() fails here (Landlock refuses /proc/self/statm).
 */
const usage = () => {
  const { userCPUTime, systemCPUTime, maxRSS } = process.resourceUsage()
  let wasmBytes = 0

  for (const box of living) wasmBytes += box.mod.getWasmMemory().buffer.byteLength

  const message: FromWorker = {
    t: "usage",
    cpuMs: Math.round((userCPUTime + systemCPUTime) / 1000),
    peakKb: maxRSS,
    wasmBytes,
  }

  const text = JSON.stringify(message)

  if (text !== reported) post(message)

  reported = text
}

setInterval(usage, 5_000)

// Each set of code's idle boxes past KEEP_WARM that have been idle WARM_MS are dropped, longest idle first.
setInterval(() => {
  const now = Date.now()

  const counts = new Map<string, number>()

  for (const box of [...idle].toReversed()) {
    const count = (counts.get(box.code) ?? 0) + 1
    counts.set(box.code, count)

    if (count > KEEP_WARM && now - box.freed > WARM_MS) dispose(box)
  }
}, 5_000)

// Everything this process will read is loaded first (a box made and dropped loads QuickJS's own module), then it confines itself.
const warm = await makeModule(16)

warm.newContext().dispose()

let confined: string

try {
  confined = confine()
} catch (error) {
  process.stderr.write(
    `the sandbox couldn't confine itself: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(78)
}

let buffer = ""

process.stdin.setEncoding("utf8")

process.stdin.on("data", (chunk: string) => {
  buffer += chunk

  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at)

    buffer = buffer.slice(at + 1)

    if (line === "") continue

    // SAFETY: the platform writes these lines (sandbox.ts), one ToWorker each
    const message = JSON.parse(line) as ToWorker

    handle(message)
  }
})

// The platform gone, this goes too.
process.stdin.on("end", () => process.exit(0))

post({ t: "ready", confined })
