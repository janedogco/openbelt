// bun run cli:dist: this machine's openbelt CLI, built release and put where the platform hands it out (cli/dist,
// runtime/cli.ts), so a checkout's /install and openbelt update serve what it has. The image builds every platform's
// itself (the Dockerfile's cli stage).
import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { cargoEnv, checkoutFlags, cliDist, hostTarget, releaseBuild } from "./cargo.ts"

const ROOT = resolve(import.meta.dir, "..")

if (hostTarget === undefined) {
  console.error(`cli:dist: no openbelt build is named for ${process.platform}-${process.arch}`)
  process.exit(1)
}

const built = Bun.spawnSync(
  [
    "cargo",
    "rustc",
    "--release",
    "--quiet",
    "--bin",
    "openbelt",
    "--manifest-path",
    join(ROOT, "cli/Cargo.toml"),
    "--",
    ...checkoutFlags(ROOT),
  ],
  { stdout: "inherit", stderr: "inherit", env: cargoEnv() },
)

if (built.exitCode !== 0) process.exit(built.exitCode)

const to = cliDist(ROOT)

mkdirSync(dirname(to), { recursive: true })

copyFileSync(releaseBuild(ROOT), to)

console.log(`cli:dist: ${to}`)
