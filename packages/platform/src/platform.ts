// One platform process: the gateway answering HTTP, and the Durable Objects this process owns (runtime/actor.ts). Started by the
// supervisor (server.ts, runtime/supervisor.ts) with OPENBELT_PROCESS set, it serves once every platform process is ready.
import * as Effect from "effect/Effect"
import Gateway from "./gateway.ts"
import * as Runtime from "./runtime/index.ts"
import type { StartMessage } from "./runtime/supervisor.ts"

/** Resolves when the supervisor says every platform process is ready (each knows the others' internal ports). */
const go = Promise.withResolvers<void>()

if (process.send === undefined) go.resolve()
else
  process.on("message", (message: StartMessage) => {
    // The supervisor's own messages are the only ones on this channel (sandbox.ts takes its sbx- ones).
    if (message.t === "go") go.resolve()
  })

await Runtime.startExport()

// A stray rejection (a sandbox that ended under a run, an actor that slept) is logged, not the end of the platform.
process.on("unhandledRejection", (reason) => {
  Runtime.say("error", "unhandled rejection", {
    cause: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  })
})

Runtime.yieldOnFetch()

const port = Runtime.port("OPENBELT_PORT", 1337)

Runtime.captureConsole()

const namespace = Runtime.text("OPENBELT_NAMESPACE", "openbelt")

const host = await Runtime.startHost({ namespace })

// A file store it can't write to (a wrong key, a missing bucket) stops the platform here, saying which, not each upload later.
const unusable = await Runtime.checkFileStore()

if (unusable !== undefined) {
  Runtime.say("error", unusable)
  process.exit(1)
}

Runtime.sweepStoreEvery()

process.send?.({ t: "ready" } satisfies StartMessage)

await go.promise

const worker = await Effect.runPromise(Runtime.observed(Gateway))

Runtime.stopOnSignals(Runtime.serve({ port, host, worker }))

const runtime =
  process.versions.bun === undefined ? `node ${process.version}` : `bun ${process.versions.bun}`

Runtime.say("info", `OpenBelt is up on :${port} (${runtime}, namespace ${namespace})`, {
  port,
  namespace,
})
