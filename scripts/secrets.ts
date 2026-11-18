import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..")

const snapshot = mkdtempSync(join(tmpdir(), "openbelt-secrets-"))

const flags = [
  "--config",
  join(ROOT, ".gitleaks.toml"),
  "--redact",
  "--verbose",
  "--no-banner",
  "--ignore-gitleaks-allow",
]

const scan = (args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["gitleaks", ...args, ...flags], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  })

  if (result.exitCode !== 0)
    throw new Error("Secret scan failed; remove the credential and rotate it if it was shared.")
}

try {
  scan(["git", "--log-opts=HEAD --remotes=origin --tags", ROOT])

  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT },
  )

  if (listed.exitCode !== 0) throw new Error("git ls-files failed; cannot scan the working tree.")

  for (const file of new Set(listed.stdout.toString().split("\0").filter(Boolean))) {
    const source = join(ROOT, file)

    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue

    const target = join(snapshot, file)

    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }

  scan(["dir", snapshot])
} finally {
  rmSync(snapshot, { recursive: true, force: true })
}
