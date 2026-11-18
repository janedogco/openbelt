// A handful of numbers about the platform, for a dashboard or an alert: requests, function runs, requests to the outside, how long
// objects make their callers wait, and the sandbox's processes and boxes. Effect's metrics: /_admin/metrics answers with them
// in Prometheus' text format, and with OTEL_EXPORTER_OTLP_ENDPOINT set they also go to that backend
// (observe.ts). Labels stay few and bounded (a status class, an outcome, a kind): never a workspace, app, host or path.
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import { PrometheusMetrics } from "effect/observability"

const SECONDS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]

const requests = Metric.counter("openbelt_http_requests_total", {
  description: "HTTP requests the platform answered, by status class",
})

const requestSeconds = Metric.histogram("openbelt_http_request_seconds", {
  description: "How long the platform took to answer a request",
  boundaries: SECONDS,
})

const runs = Metric.counter("openbelt_function_runs_total", {
  description:
    "Function runs, by outcome (ok, error) and what started them (page, agent, call, schedule, webhook, ...)",
})

const runSeconds = Metric.histogram("openbelt_function_run_seconds", {
  description: "How long a function run took",
  boundaries: SECONDS,
})

const toolCalls = Metric.counter("openbelt_mcp_tool_calls_total", {
  description:
    "Calls agents made to OpenBelt's own MCP tools, by tool (a name not OpenBelt's: unknown) and outcome (ok, failed, refused, invalid, defect)",
})

const toolCallSeconds = Metric.histogram("openbelt_mcp_tool_call_seconds", {
  description: "How long OpenBelt took to answer a call to one of its MCP tools",
  boundaries: SECONDS,
})

const outbound = Metric.counter("openbelt_outbound_requests_total", {
  description:
    "Requests OpenBelt and functions sent outside, by kind (mcp, oauth, api, client-document, function) and outcome (a status class, timeout, unreachable, refused)",
})

const outboundSeconds = Metric.histogram("openbelt_outbound_request_seconds", {
  description: "How long a request to the outside took to answer",
  boundaries: SECONDS,
})

const turnWait = Metric.histogram("openbelt_object_turn_wait_seconds", {
  description:
    "How long an event waited for its object's turn (an object runs one event at a time)",
  boundaries: SECONDS,
})

const sandboxProcesses = Metric.gauge("openbelt_sandbox_processes", {
  description: "Sandbox processes running (a few per workspace with functions in use)",
})

const sandboxBoxes = Metric.gauge("openbelt_sandbox_boxes", {
  description:
    "Boxes (a QuickJS instance each, one run at a time) the sandbox processes hold, busy or idle",
})

const sandboxCpu = Metric.counter("openbelt_sandbox_cpu_seconds_total", {
  description:
    "CPU time the sandbox processes used (user and system), ended ones too: functions' and execute's work",
})

const sandboxWasm = Metric.gauge("openbelt_sandbox_wasm_bytes", {
  description:
    "Memory the sandbox processes' boxes hold (each box's WASM memory, busy or idle): most of what the sandboxes take",
})

const sandboxPeak = Metric.gauge("openbelt_sandbox_process_peak_bytes", {
  description: "The most memory any running sandbox process has held (its peak resident set)",
})

const openRequests = Metric.gauge("openbelt_http_requests_open", {
  description:
    "Requests this platform has under way, streams still open (an MCP session's, a page's events) among them",
})

const openSockets = Metric.gauge("openbelt_http_websockets_open", {
  description: "WebSockets open to the platform (pages' live queries and sockets)",
})

const shedRequests = Metric.counter("openbelt_http_shed_total", {
  description:
    "Requests refused with a 503 because the platform was too busy to serve them in time (admission.ts)",
})

const refusals = Metric.counter("openbelt_refused_total", {
  description: "Requests refused by storage and rate limits",
})

const commits = Metric.counter("openbelt_object_commits_total", {
  description:
    "Durable commits of objects' writes: under load, several events' writes share one (the output gate)",
})

const boxesMade = Metric.counter("openbelt_sandbox_boxes_made_total", {
  description: "Sandbox boxes made: a burst that finds its boxes warm makes none",
})

const processesEnded = Metric.counter("openbelt_sandbox_processes_ended_total", {
  description:
    "Sandbox processes ended, by why (idle; stuck: a run that didn't stop when told; failed: the process itself failed)",
})

const fileUploads = Metric.counter("openbelt_file_uploads_total", {
  description:
    "Files uploaded to apps, by outcome (stored; too_large, workspace_full, disk_low, busy: refused before the bytes; cut_off; store_error)",
})

const fileBytes = Metric.counter("openbelt_file_bytes_total", {
  description:
    "Bytes of apps' files moved through the gateway, by direction (in: uploads stored; out: downloads answered)",
})

const fileUploadSeconds = Metric.histogram("openbelt_file_upload_seconds", {
  description: "How long a stored upload took, from its first byte to its record",
  boundaries: [0.05, 0.25, 1, 5, 15, 60, 300],
})

const filesInFlight = Metric.gauge("openbelt_file_uploads_in_flight", {
  description: "Uploads this process is streaming to the file store now",
})

const filesSwept = Metric.counter("openbelt_files_swept_total", {
  description:
    "Files deleted as unused: no document of their app named them for OPENBELT_FILES_ORPHAN_HOURS after upload",
})

const fileStoreErrors = Metric.counter("openbelt_file_store_errors_total", {
  description: "Calls to the file store (disk or S3) that failed, by operation",
})

/** Record from code that isn't an Effect (the runtime's Promise side): the registry is the process's, whichever run updates it. */
const now = (effect: Effect.Effect<void>) => Effect.runSync(effect)

const classOf = (status: number) => `${Math.floor(status / 100)}xx`

export const recordRequest = (status: number, ms: number) =>
  now(
    Effect.all(
      [
        Metric.update(Metric.withAttributes(requests, { status: classOf(status) }), 1),
        Metric.update(requestSeconds, ms / 1000),
      ],
      { discard: true },
    ),
  )

export const recordRun = (outcome: "ok" | "error", via: string, ms: number) =>
  Effect.all(
    [
      Metric.update(Metric.withAttributes(runs, { outcome, via }), 1),
      Metric.update(runSeconds, ms / 1000),
    ],
    { discard: true },
  )

export const recordToolCall = (tool: string, outcome: string, ms: number) =>
  Effect.all(
    [
      Metric.update(Metric.withAttributes(toolCalls, { tool, outcome }), 1),
      Metric.update(Metric.withAttributes(toolCallSeconds, { tool }), ms / 1000),
    ],
    { discard: true },
  )

export const recordOutbound = (kind: string, outcome: string, ms: number) =>
  Effect.all(
    [
      Metric.update(Metric.withAttributes(outbound, { kind, outcome }), 1),
      Metric.update(Metric.withAttributes(outboundSeconds, { kind }), ms / 1000),
    ],
    { discard: true },
  )

export const recordTurnWait = (ms: number) => now(Metric.update(turnWait, ms / 1000))

export const recordSandbox = (pool: {
  readonly processes: number
  readonly boxes: number
  readonly wasmBytes: number
  readonly peakBytes: number
}) =>
  now(
    Effect.all(
      [
        Metric.update(sandboxProcesses, pool.processes),
        Metric.update(sandboxBoxes, pool.boxes),
        Metric.update(sandboxWasm, pool.wasmBytes),
        Metric.update(sandboxPeak, pool.peakBytes),
      ],
      { discard: true },
    ),
  )

export const recordSandboxCpu = (seconds: number) => now(Metric.update(sandboxCpu, seconds))

export const recordOpen = (underWay: number, sockets: number) =>
  now(
    Effect.all([Metric.update(openRequests, underWay), Metric.update(openSockets, sockets)], {
      discard: true,
    }),
  )

export const recordCommit = () => now(Metric.update(commits, 1))

export const recordShed = () => now(Metric.update(shedRequests, 1))

export const recordBoxesMade = (count: number) => now(Metric.update(boxesMade, count))

export const recordProcessEnded = (why: "idle" | "stuck" | "failed") =>
  now(Metric.update(Metric.withAttributes(processesEnded, { why }), 1))

/** Every metric of this process, in Prometheus' text format. */
export const prometheusText = PrometheusMetrics.format()

/**
 * Several processes' Prometheus text as one, for /_admin/metrics with OPENBELT_PROCESSES > 1: each sample added up across them, but
 * the sandbox pool's, which every process reports whole for the machine (the supervisor sends each the pool's totals), taken once.
 * Lines keep the first text's order; a sample only another process has follows.
 */
export const mergeMetrics = (texts: ReadonlyArray<string>): string => {
  if (texts.length <= 1) return texts[0] ?? ""

  const order: Array<string> = []
  const values = new Map<string, number>()

  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || line.trim() === "") {
        if (!values.has(line)) {
          values.set(line, Number.NaN)
          order.push(line)
        }

        continue
      }

      const at = line.lastIndexOf(" ")
      const key = line.slice(0, at)
      const value = Number(line.slice(at + 1))
      const had = values.get(key)

      if (had === undefined) {
        values.set(key, value)
        order.push(key)
      } else
        values.set(key, key.startsWith("openbelt_sandbox_") ? Math.max(had, value) : had + value)
    }
  }

  return order
    .map((key) => {
      const value = values.get(key) ?? Number.NaN

      return Number.isNaN(value) ? key : `${key} ${value}`
    })
    .join("\n")
}

export const recordFileUpload = (outcome: string, bytes: number, ms: number) =>
  now(
    Effect.all(
      [
        Metric.update(Metric.withAttributes(fileUploads, { outcome }), 1),
        ...(outcome === "stored"
          ? [
              Metric.update(Metric.withAttributes(fileBytes, { direction: "in" }), bytes),
              Metric.update(fileUploadSeconds, ms / 1000),
            ]
          : []),
      ],
      { discard: true },
    ),
  )

export const recordFileDownload = (bytes: number) =>
  now(Metric.update(Metric.withAttributes(fileBytes, { direction: "out" }), bytes))

export const recordFilesInFlight = (n: number) => now(Metric.update(filesInFlight, n))

export const recordFileStoreError = (op: string) =>
  now(Metric.update(Metric.withAttributes(fileStoreErrors, { op }), 1))

export const recordFilesSwept = (n: number) => now(Metric.update(filesSwept, n))

export const recordRefused = (why: "storage" | "rate", what: string) =>
  now(Metric.update(Metric.withAttributes(refusals, { why, what }), 1))
