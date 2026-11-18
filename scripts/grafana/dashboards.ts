// OpenBelt's Grafana dashboards, as code (the Grafana Foundation SDK). `bun run grafana build` writes them to deploy/grafana/dashboards/,
// which the server's Grafana (deploy/compose.front.yaml) and compose's telemetry profile load at start and every 30 s. Edits made
// in Grafana's UI can't be saved: change them here. The metrics are runtime/metrics.ts's; every stage is told apart by
// deployment_environment_name (scripts/deploy.ts names it), each platform process by instance.
import * as common from "@grafana/grafana-foundation-sdk/common"
import {
  DashboardBuilder,
  DashboardCursorSync,
  FieldColorBuilder,
  FieldColorModeId,
  QueryVariableBuilder,
  RowBuilder,
  ThresholdsConfigBuilder,
  ThresholdsMode,
  VariableRefresh,
} from "@grafana/grafana-foundation-sdk/dashboard"
import { DataqueryBuilder as LokiQuery } from "@grafana/grafana-foundation-sdk/loki"
import { PanelBuilder as LogsPanel } from "@grafana/grafana-foundation-sdk/logs"
import { DataqueryBuilder as PromQuery } from "@grafana/grafana-foundation-sdk/prometheus"
import { PanelBuilder as StatPanel } from "@grafana/grafana-foundation-sdk/stat"
import { PanelBuilder as TablePanel } from "@grafana/grafana-foundation-sdk/table"
import {
  SearchTableType,
  DataqueryBuilder as TempoQuery,
} from "@grafana/grafana-foundation-sdk/tempo"
import { PanelBuilder as TimeSeriesPanel } from "@grafana/grafana-foundation-sdk/timeseries"

// The data sources grafana/otel-lgtm provisions.
const PROMETHEUS: common.DataSourceRef = { type: "prometheus", uid: "prometheus" }

const LOKI: common.DataSourceRef = { type: "loki", uid: "loki" }

const TEMPO: common.DataSourceRef = { type: "tempo", uid: "tempo" }

/** The stage the dashboard shows: prod. */
const STAGE = 'deployment_environment_name=~"$stage"'

/** Green below each step's value, then its colour. */
const steps = (...at: ReadonlyArray<readonly [number, string]>) =>
  new ThresholdsConfigBuilder()
    .mode(ThresholdsMode.Absolute)
    .steps([{ value: null, color: "green" }, ...at.map(([value, color]) => ({ value, color }))])

const prom = (expr: string, legend: string) =>
  new PromQuery().datasource(PROMETHEUS).expr(expr).legendFormat(legend)

const rate = (metric: string, by = "") =>
  `sum${by === "" ? "" : ` by (${by})`} (rate(${metric}{${STAGE}}[$__rate_interval]))`

/**
 * A counter of the machine's sandbox pool, which every platform process and the supervisor report whole (the pool lives in the
 * supervisor): the same count under several instances, so one of them, not their sum.
 */
const poolRate = (metric: string) => `max(rate(${metric}{${STAGE}}[$__rate_interval]))`

const quantile = (q: number, histogram: string, by = "") =>
  `histogram_quantile(${q}, sum by (le${by === "" ? "" : `, ${by}`}) (rate(${histogram}_bucket{${STAGE}}[$__rate_interval])))`

const timeseries = (title: string, description: string, unit: string) =>
  new TimeSeriesPanel()
    .title(title)
    .description(description)
    .datasource(PROMETHEUS)
    .unit(unit)
    .min(0)
    .fillOpacity(12)
    .lineWidth(1)
    .height(8)
    .span(8)

const stat = (title: string, description: string, unit: string, expr: string) =>
  new StatPanel()
    .title(title)
    .description(description)
    .datasource(PROMETHEUS)
    .unit(unit)
    .height(4)
    .span(4)
    .withTarget(prom(expr, title).instant())

/** Traces of the stage matching `filter` (TraceQL, inside the braces), newest first. */
const traces = (title: string, description: string, filter: string) =>
  new TablePanel()
    .title(title)
    .description(description)
    .datasource(TEMPO)
    .height(9)
    .span(12)
    .withTarget(
      new TempoQuery()
        .datasource(TEMPO)
        .queryType("traceql")
        .query(`{resource.deployment.environment.name=~"$stage" && ${filter}}`)
        .limit(20)
        .tableType(SearchTableType.Traces),
    )

const overview = new DashboardBuilder("OpenBelt")
  .uid("openbelt-overview")
  .description(
    "One stage of OpenBelt: requests, function runs, calls outside, the runtime, and its warnings, errors and slow traces.",
  )
  .tags(["openbelt"])
  .editable()
  .refresh("30s")
  .time({ from: "now-1h", to: "now" })
  .timezone("browser")
  .tooltip(DashboardCursorSync.Crosshair)
  .withVariable(
    new QueryVariableBuilder("stage")
      .label("Stage")
      .description("Which stage: prod")
      .datasource(PROMETHEUS)
      .query("label_values(openbelt_http_requests_total, deployment_environment_name)")
      .refresh(VariableRefresh.OnTimeRangeChanged)
      .current({ text: "prod", value: "prod" }),
  )

  .withRow(new RowBuilder("At a glance"))
  .withPanel(
    stat(
      "Requests / s",
      "Every request the platform answered, the last 5 minutes",
      "reqps",
      `sum(rate(openbelt_http_requests_total{${STAGE}}[5m]))`,
    ),
  )
  .withPanel(
    stat(
      "Server errors",
      "Share of requests answered 5xx, the last 5 minutes",
      "percentunit",
      `sum(rate(openbelt_http_requests_total{${STAGE}, status="5xx"}[5m])) / sum(rate(openbelt_http_requests_total{${STAGE}}[5m])) or vector(0)`,
    ).thresholds(steps([0.01, "orange"], [0.05, "red"])),
  )
  .withPanel(
    stat(
      "p95 answer time",
      "95% of requests were answered within this, the last 5 minutes",
      "s",
      `histogram_quantile(0.95, sum by (le) (rate(openbelt_http_request_seconds_bucket{${STAGE}}[5m])))`,
    ).thresholds(steps([0.5, "orange"], [2, "red"])),
  )
  .withPanel(
    stat(
      "Function runs / s",
      "Function runs started by pages, agents, schedules, webhooks and other functions",
      "ops",
      `sum(rate(openbelt_function_runs_total{${STAGE}}[5m]))`,
    ),
  )
  .withPanel(
    stat(
      "Failed runs",
      "Function runs that ended in an error, the last hour",
      "short",
      `round(sum(increase(openbelt_function_runs_total{${STAGE}, outcome="error"}[1h]))) or vector(0)`,
    ).thresholds(steps([1, "orange"])),
  )
  .withPanel(
    new StatPanel()
      .title("Serving")
      .description("The commit the stage runs (OPENBELT_COMMIT)")
      .datasource(PROMETHEUS)
      .height(4)
      .span(4)
      .textMode(common.BigValueTextMode.Name)
      .displayName("${__field.labels.service_version}")
      .colorScheme(new FieldColorBuilder().mode(FieldColorModeId.Fixed).fixedColor("text"))
      .withTarget(
        prom(
          `label_replace(max by (service_version) (openbelt_http_requests_total{${STAGE}}), "service_version", "not set", "service_version", "")`,
          "{{service_version}}",
        ).instant(),
      ),
  )

  .withRow(new RowBuilder("Requests"))
  .withPanel(
    timeseries("Requests by status", "Requests answered per second, by status class", "reqps")
      .withTarget(prom(rate("openbelt_http_requests_total", "status"), "{{status}}"))
      .withTarget(prom(rate("openbelt_http_shed_total"), "shed (busy, 503)")),
  )
  .withPanel(
    timeseries("Answer time", "How long the platform took to answer a request", "s")
      .withTarget(prom(quantile(0.5, "openbelt_http_request_seconds"), "p50"))
      .withTarget(prom(quantile(0.95, "openbelt_http_request_seconds"), "p95"))
      .withTarget(prom(quantile(0.99, "openbelt_http_request_seconds"), "p99")),
  )
  .withPanel(
    timeseries(
      "Waiting for an object's turn",
      "How long an event waited for its object (an object runs one event at a time): long waits mean one object is a bottleneck",
      "s",
    )
      .withTarget(prom(quantile(0.95, "openbelt_object_turn_wait_seconds"), "p95"))
      .withTarget(prom(quantile(0.99, "openbelt_object_turn_wait_seconds"), "p99")),
  )
  .withPanel(
    timeseries(
      "Open requests and sockets",
      "Requests under way (MCP sessions' and pages' open streams among them) and WebSockets open, all processes: a climb that doesn't come back down is requests or streams left open",
      "short",
    )
      .span(24)
      .height(6)
      .withTarget(prom(`sum(openbelt_http_requests_open_ratio{${STAGE}})`, "requests"))
      .withTarget(prom(`sum(openbelt_http_websockets_open_ratio{${STAGE}})`, "websockets")),
  )

  .withRow(new RowBuilder("Agents' tool calls"))
  .withPanel(
    timeseries(
      "Tool calls by tool",
      "Calls agents made to OpenBelt's own MCP tools, per second, by tool",
      "ops",
    ).withTarget(prom(rate("openbelt_mcp_tool_calls_total", "tool"), "{{tool}}")),
  )
  .withPanel(
    timeseries(
      "Tool calls that weren't ok",
      "Per second, by tool and outcome: failed (the agent's code threw), refused (the tool said no, and why), invalid (arguments that don't fit, a tool that doesn't exist), defect (OpenBelt failed inside)",
      "ops",
    ).withTarget(
      prom(
        `sum by (tool, outcome) (rate(openbelt_mcp_tool_calls_total{${STAGE}, outcome!="ok"}[$__rate_interval]))`,
        "{{tool}} {{outcome}}",
      ),
    ),
  )
  .withPanel(
    timeseries("Tool call time", "p95 time to answer a tool call, by tool", "s").withTarget(
      prom(quantile(0.95, "openbelt_mcp_tool_call_seconds", "tool"), "{{tool}}"),
    ),
  )
  .withPanel(
    timeseries(
      "Tool error share",
      "Share of each tool's calls that weren't ok: a tool agents keep getting refused or invalid on needs a clearer description or error",
      "percentunit",
    )
      .span(12)
      .max(1)
      .withTarget(
        prom(
          `sum by (tool) (rate(openbelt_mcp_tool_calls_total{${STAGE}, outcome!="ok"}[$__rate_interval])) / sum by (tool) (rate(openbelt_mcp_tool_calls_total{${STAGE}}[$__rate_interval]))`,
          "{{tool}}",
        ),
      ),
  )
  .withPanel(
    traces(
      "Tool calls OpenBelt failed",
      "Tool calls that ended in a defect: open one for the whole call",
      'span.openbelt.outcome =~ ".*defect.*"',
    ),
  )

  .withRow(new RowBuilder("Functions"))
  .withPanel(
    timeseries(
      "Runs by what started them",
      "Function runs per second, by what started them (page, agent, call, schedule, webhook)",
      "ops",
    ).withTarget(prom(rate("openbelt_function_runs_total", "via"), "{{via}}")),
  )
  .withPanel(
    timeseries("Failed runs", "Function runs that ended in an error, per second", "ops")
      .withTarget(
        prom(
          `sum by (via) (rate(openbelt_function_runs_total{${STAGE}, outcome="error"}[$__rate_interval]))`,
          "{{via}}",
        ),
      )
      .colorScheme(new FieldColorBuilder().mode(FieldColorModeId.Fixed).fixedColor("red")),
  )
  .withPanel(
    timeseries("Run time", "How long a function run took", "s")
      .withTarget(prom(quantile(0.5, "openbelt_function_run_seconds"), "p50"))
      .withTarget(prom(quantile(0.95, "openbelt_function_run_seconds"), "p95")),
  )

  .withRow(new RowBuilder("Calls outside"))
  .withPanel(
    timeseries(
      "Calls outside by outcome",
      "Requests OpenBelt and functions sent outside (MCP servers, OAuth, APIs, functions' fetch), by kind and outcome",
      "reqps",
    )
      .span(12)
      .withTarget(
        prom(rate("openbelt_outbound_requests_total", "kind, outcome"), "{{kind}} {{outcome}}"),
      ),
  )
  .withPanel(
    timeseries("Outside answer time", "p95 time for a request outside to answer, by kind", "s")
      .span(12)
      .withTarget(prom(quantile(0.95, "openbelt_outbound_request_seconds", "kind"), "{{kind}}")),
  )

  .withRow(new RowBuilder("Sandboxes and storage"))
  .withPanel(
    timeseries(
      "Sandbox processes and boxes",
      "Function sandboxes running (a few per workspace with functions in use) and the QuickJS boxes they hold",
      "short",
    )
      .withTarget(prom(`max(openbelt_sandbox_processes_ratio{${STAGE}})`, "processes"))
      .withTarget(prom(`max(openbelt_sandbox_boxes_ratio{${STAGE}})`, "boxes")),
  )
  .withPanel(
    timeseries(
      "Boxes made and processes ended",
      "Boxes made (a warm burst makes none) and sandbox processes ended, by why (idle, stuck, failed)",
      "ops",
    )
      .withTarget(prom(poolRate("openbelt_sandbox_boxes_made_total"), "boxes made"))
      .withTarget(prom(rate("openbelt_sandbox_processes_ended_total", "why"), "ended: {{why}}")),
  )
  .withPanel(
    timeseries(
      "Sandbox CPU",
      "CPU the sandbox processes use, in cores (1 = one core busy): functions' and execute's work. A run may use 10 s of CPU",
      "short",
    ).withTarget(prom(poolRate("openbelt_sandbox_cpu_seconds_total"), "cores")),
  )
  .withPanel(
    timeseries(
      "Sandbox memory",
      "The boxes' WASM memory, all sandbox processes (most of what they hold), and the most any one process has held",
      "bytes",
    )
      .withTarget(prom(`max(openbelt_sandbox_wasm_bytes_ratio{${STAGE}})`, "boxes' memory"))
      .withTarget(
        prom(`max(openbelt_sandbox_process_peak_bytes_ratio{${STAGE}})`, "largest process's peak"),
      ),
  )
  .withPanel(
    new TablePanel()
      .title("Sandbox CPU by workspace")
      .description(
        "CPU seconds each workspace's sandbox processes used, counted as each process ends (idle 10 minutes, stuck or failed): the line 'sandbox: a process for <workspace> used ...'",
      )
      .datasource(LOKI)
      .unit("s")
      .height(8)
      .span(8)
      // An instant query is one table already (a row per workspace): its columns named, most CPU first.
      .withTransformation({
        id: "organize",
        options: {
          excludeByName: { Time: true },
          renameByName: { workspace: "Workspace", "Value #A": "CPU" },
        },
      })
      .sortBy([new common.TableSortByFieldStateBuilder().displayName("CPU").desc(true)])
      .withTarget(
        new LokiQuery()
          .datasource(LOKI)
          .expr(
            'topk(10, sum by (workspace) (sum_over_time({deployment_environment_name=~"$stage"} |= "of CPU, at most" | unwrap cpu_seconds [$__range])))',
          )
          .legendFormat("{{workspace}}")
          .instant(true),
      ),
  )
  .withPanel(
    timeseries(
      "Commits",
      "Durable commits of objects' writes per second: under load several events share one",
      "ops",
    ).withTarget(prom(rate("openbelt_object_commits_total"), "commits")),
  )

  .withRow(new RowBuilder("Logs"))
  .withPanel(
    new TimeSeriesPanel()
      .title("Log lines by level")
      .datasource(LOKI)
      .height(7)
      .span(24)
      .drawStyle(common.GraphDrawStyle.Bars)
      .fillOpacity(60)
      .stacking(new common.StackingConfigBuilder().mode(common.StackingMode.Normal))
      .withTarget(
        new LokiQuery()
          .datasource(LOKI)
          .expr(
            'sum by (detected_level) (count_over_time({deployment_environment_name=~"$stage"} [$__auto]))',
          )
          .legendFormat("{{detected_level}}"),
      ),
  )
  .withPanel(
    new LogsPanel()
      .title("Warnings and errors")
      .description(
        "The stage's warn and error lines, newest first; a line's trace links to it in Tempo",
      )
      .datasource(LOKI)
      .height(12)
      .span(24)
      .showTime(true)
      .wrapLogMessage(true)
      .enableLogDetails(true)
      .sortOrder(common.LogsSortOrder.Descending)
      .withTarget(
        new LokiQuery()
          .datasource(LOKI)
          .expr('{deployment_environment_name=~"$stage"} | detected_level=~"warn|error"')
          .maxLines(200),
      ),
  )

  .withRow(new RowBuilder("Traces"))
  .withPanel(
    traces(
      "Failed",
      "Traces with a span that failed: open one for the whole request, across the objects it crossed",
      "status = error",
    ),
  )
  .withPanel(
    traces(
      "Slow",
      "Requests that took more than half a second",
      "duration > 500ms && nestedSetParent < 0",
    ),
  )

/** Every dashboard, by file name under deploy/grafana/dashboards/. */
export const dashboards = { "openbelt-overview.json": overview.build() }
