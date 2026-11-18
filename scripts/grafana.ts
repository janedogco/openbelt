// OpenBelt's Grafana, as code: bun run grafana <command>
//   build      write the dashboards (scripts/grafana/dashboards.ts) to deploy/grafana/dashboards/
//   check      fail when a written dashboard isn't what dashboards.ts builds (bun run check runs it)
//   traffic    a few minutes of made-up use against a running OpenBelt, so the dashboards have something to show:
//              bun run grafana traffic --url <workspace url> --token <admin token> [--minutes 10]
// docs/running.md, "Grafana on the server".
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Dashboard } from "@grafana/grafana-foundation-sdk/dashboard"
import { dashboards } from "./grafana/dashboards.ts"
import { traffic } from "./grafana/traffic.ts"

const DIR = resolve(import.meta.dir, "../deploy/grafana/dashboards")

const [command = ""] = process.argv.slice(2)

/** The dashboards written that dashboards.ts no longer builds: build removes them, check names them. */
const extras = () =>
  readdirSync(DIR).filter((file) => file.endsWith(".json") && !(file in dashboards))

const text = (dashboard: Dashboard) => `${JSON.stringify(dashboard, null, 2)}\n`

if (command === "build") {
  mkdirSync(DIR, { recursive: true })

  for (const [file, dashboard] of Object.entries(dashboards))
    writeFileSync(join(DIR, file), text(dashboard))

  for (const file of extras()) rmSync(join(DIR, file))

  console.log(`wrote ${Object.keys(dashboards).join(", ")} to deploy/grafana/dashboards/`)
} else if (command === "check") {
  const wanted = Object.entries(dashboards)

  const stale = wanted.filter(
    ([file, dashboard]) =>
      !existsSync(join(DIR, file)) || readFileSync(join(DIR, file), "utf8") !== text(dashboard),
  )

  const extra = extras()

  if (stale.length > 0 || extra.length > 0) {
    console.error(
      `deploy/grafana/dashboards/ isn't what scripts/grafana/dashboards.ts builds (${[...stale.map(([f]) => f), ...extra].join(", ")}): run bun run grafana build`,
    )
    process.exit(1)
  }
} else if (command === "traffic") {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { url: { type: "string" }, token: { type: "string" }, minutes: { type: "string" } },
  })

  if (values.url === undefined || values.token === undefined) {
    console.error(
      "usage: bun run grafana traffic --url <workspace url> --token <admin token> [--minutes 10]",
    )
    process.exit(2)
  }

  await traffic(values.url, values.token, Number(values.minutes ?? "10"))
} else {
  console.error(
    "usage: bun run grafana build | check | traffic --url <workspace url> --token <admin token> [--minutes 10]",
  )
  process.exit(2)
}
