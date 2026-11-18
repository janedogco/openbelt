import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }

const ROOT = resolve(import.meta.dir, "..")

type Row = { name: string; ok: boolean; detail: string; fix?: string }

const rows: Array<Row> = []

const run = (cmd: ReadonlyArray<string>) => {
  try {
    const p = Bun.spawnSync([...cmd], { cwd: ROOT })

    return { code: p.exitCode, out: (p.stdout.toString() + p.stderr.toString()).trim() }
  } catch (e) {
    return { code: -1, out: String(e) }
  }
}

rows.push({
  name: "bun version",
  ok: Bun.version === pkg.engines.bun,
  detail: `running ${Bun.version}, pinned ${pkg.engines.bun}`,
  fix: `install Bun ${pkg.engines.bun}: curl -fsSL https://bun.sh/install | bash -s "bun-v${pkg.engines.bun}"`,
})

const ab = run([join(ROOT, "node_modules/.bin/agent-browser"), "--version"])

rows.push({
  name: "agent-browser (pinned)",
  ok: ab.code === 0 && ab.out.includes(pkg.devDependencies["agent-browser"]),
  detail: ab.out.split("\n")[0] ?? "",
  fix: "bun install && bun x agent-browser install   (downloads Chrome for Testing)",
})

const chrome = [
  process.env["OPENBELT_CHROME_PATH"] ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((path) => path !== "" && existsSync(path))

rows.push({
  name: "Chrome (check_app's browser)",
  ok: chrome !== undefined,
  detail: chrome ?? "none found",
  fix: "install Google Chrome or Chromium, or set OPENBELT_CHROME_PATH to its executable",
})

const gitleaks = run(["gitleaks", "version"])

rows.push({
  name: "gitleaks (pre-commit and check)",
  ok: gitleaks.code === 0,
  detail: gitleaks.code === 0 ? gitleaks.out : "not found",
  fix: "brew install gitleaks",
})

// Ask git: in a worktree, .git is a file and the hooks live in the main checkout.
const hooks = resolve(ROOT, run(["git", "rev-parse", "--git-path", "hooks"]).out)

rows.push({
  name: "git hooks installed",
  ok: existsSync(join(hooks, "pre-commit")) && existsSync(join(hooks, "pre-push")),
  detail: `${hooks}: pre-commit, pre-push`,
  fix: "bun x lefthook install",
})

for (const r of rows) {
  console.log(
    `${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}${r.ok || r.fix === undefined ? "" : `\n    fix: ${r.fix}`}`,
  )
}

process.exit(rows.every((r) => r.ok) ? 0 : 1)
