import { mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { cargoEnv, checkoutFlags } from "./cargo.ts"
import { tidy } from "./tidy.ts"

const ROOT = join(import.meta.dir, "..")

const LOGS = join(ROOT, ".verify", "logs")

const MAX_LINES = 40

type Stage = {
  readonly name: string
  readonly cmd: ReadonlyArray<string>
  readonly fix?: string
}

const STAGES: ReadonlyArray<Stage> = [
  {
    name: "secrets",
    cmd: ["bun", "scripts/secrets.ts"],
    fix: "take the key out of the working tree and every affected commit (rotate it if it was shared); a made-up fixture goes in .gitleaks.toml",
  },
  { name: "format", cmd: ["bun", "x", "oxfmt", "--check"], fix: "bun run fix" },
  {
    name: "lint",
    cmd: ["bun", "x", "oxlint", "--type-aware", "--format", "agent"],
    fix: "bun run fix (handles some; the rest are by hand)",
  },
  { name: "typecheck", cmd: ["bun", "x", "tsc", "-b", "--force", "--pretty", "false"] },
  { name: "guard", cmd: ["bun", "scripts/guard.ts"] },
  { name: "grafana", cmd: ["bun", "scripts/grafana.ts", "check"], fix: "bun run grafana build" },
  {
    name: "cli format",
    cmd: ["cargo", "fmt", "--manifest-path", "cli/Cargo.toml", "--check"],
    fix: "cargo fmt --manifest-path cli/Cargo.toml",
  },
  {
    name: "cli lint",
    cmd: [
      "cargo",
      "clippy",
      "--manifest-path",
      "cli/Cargo.toml",
      "--quiet",
      "--",
      "-D",
      "warnings",
      ...checkoutFlags(ROOT),
    ],
  },
  {
    name: "brand",
    cmd: ["bun", "scripts/brand.ts", "check"],
    fix: "bun run brand sync (brand/AGENTS.md)",
  },
  {
    name: "deadcode",
    cmd: ["bun", "x", "fallow", "dead-code", "--quiet", "--fail-on-issues"],
    fix: "delete what's unused (see AGENTS.md: No dead code)",
  },
]

const clean = (output: string) => {
  const seen = new Set<string>()

  return stripVTControlCharacters(output)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !/\bWARN\b.*cache/i.test(line))
    .filter((line) => {
      if (seen.has(line)) return false

      seen.add(line)

      return true
    })
}

mkdirSync(LOGS, { recursive: true })

for (const line of tidy()) console.log(`check: ${line}`)

for (const stage of STAGES) {
  const started = Date.now()

  const proc = Bun.spawnSync([...stage.cmd], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: cargoEnv(),
  })

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const output = proc.stdout.toString() + proc.stderr.toString()

  if (proc.exitCode === 0) {
    console.log(`✓ ${stage.name} (${seconds}s)`)
    continue
  }

  const log = join(LOGS, `${stage.name}.log`)
  const lines = clean(output)

  writeFileSync(log, output)
  console.log(`✗ ${stage.name} (exit ${proc.exitCode}, ${seconds}s)`)
  console.log(lines.slice(0, MAX_LINES).join("\n"))

  if (lines.length > MAX_LINES) console.log(`… ${lines.length - MAX_LINES} more lines`)

  console.log(`full log: ${relative(ROOT, log)}`)

  if (stage.fix !== undefined) console.log(`fix: ${stage.fix}`)

  process.exit(1)
}
