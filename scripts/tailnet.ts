// OpenBelt on this Mac for your tailnet: `bun run tailnet up [ref]` runs a release of this repo as launchd services.
//   up [ref] [--drop]   start it, or move it to ref (default main): tried on a copy of the data first, then switched
//   rollback [--data]   back to the version before the last up (--data: and the data as it was before it)
//   status | token [email]
//   logs [--follow]     its log's last 50 lines (--follow: keep following)
//   down                stop the services (the front door too); the data stays
//   <name>-data/data/      the data: apps, documents, tokens (every Durable Object's SQLite file, under the namespace <name>)
// Secrets, ports and the domain: ~/.config/openbelt/<name>.env. Two launchd services: the platform
// (packages/platform/src/server.ts on 127.0.0.1:INNER_PORT, from the current release) and the front door: HTTPS on this Mac's
// tailnet address (HTTPS_PORT), and plain HTTP on 127.0.0.1:OPENBELT_PORT for this script's own calls (nobody is signed in there).
// The platform owns the data, so a snapshot or a copy is taken with it stopped, or tried by a second platform on a copy.
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { homedir, platform, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Option, Schema } from "effect"
import type { Inventory } from "../packages/platform/src/model.ts"
import {
  certificatesOf,
  describeDomain,
  type Domain,
  domainOf,
  SETUP,
  tailnetAddress,
} from "./domain.ts"
import type { Listener } from "./frontdoor.ts"
import {
  callbacksLostGoing,
  described,
  droppedSince,
  fileAt,
  inventoryOf,
  lostBetween,
  unexcused,
} from "./inventory.ts"
import { servedPorts, tailscale as tailscaleOf } from "./tailscale.ts"
import { killTree, mintToken } from "./verify/drive/processes.ts"

const ROOT = resolve(import.meta.dir, "..")

const NAME = process.env.OPENBELT_TAILNET ?? "tailnet"

const SHARE = join(homedir(), ".local", "share", "openbelt")

const CLONE = join(SHARE, NAME)

const RELEASES = join(SHARE, `${NAME}-releases`)

const DATA = join(SHARE, `${NAME}-data`)

/** The data: each object's SQLite file (OPENBELT_DATA). */
const DATA_DIR = join(DATA, "data")

/** Where a release from before kept the data: the Rivet engine's directory. */
const ENGINE_DIR = join(DATA, "engine")

/** The instance's namespace in its data. */
const NAMESPACE = NAME

const SNAPSHOTS = join(SHARE, `${NAME}-snapshots`)

const STATE = join(SHARE, `${NAME}-state.json`)

const FRONT = join(SHARE, `${NAME}-front.js`)

const FRONT_CONFIG = join(SHARE, `${NAME}-front.json`)

const UPDATING = join(SHARE, `${NAME}-updating.html`)

const ENV_FILE = join(homedir(), ".config", "openbelt", `${NAME}.env`)

const LABEL = `com.openbelt.${NAME}`

const FRONT_LABEL = `${LABEL}.front`

/** A release from before ran the Rivet engine as its own service: stopped with the platform's, if it is loaded. */
const ENGINE_LABEL = `${LABEL}.engine`

const LOG = join(homedir(), "Library", "Logs", `openbelt-${NAME}.log`)

const FRONT_LOG = join(homedir(), "Library", "Logs", `openbelt-${NAME}-front.log`)

const DOMAIN = `gui/${process.getuid?.() ?? 0}`

const STORAGE = "packages/platform/storage.json"

const KEEP_SNAPSHOTS = 5

const args = process.argv.slice(2)

const [command = ""] = args

const rest = args.slice(1).filter((a) => !a.startsWith("--"))

const flag = (name: string) => args.includes(`--${name}`)

let recover: (() => void) | undefined

/** Says what went wrong and exits; a declaration, so TypeScript narrows after a call. */
function fail(message: string): never {
  console.error(`tailnet ${command}: ${message}`)

  const putBack = recover

  recover = undefined

  if (putBack !== undefined) {
    console.error("putting the version before back...")
    putBack()
  }

  return process.exit(1)
}

if (!/^[a-z][a-z0-9-]{0,30}$/.test(NAME))
  fail(`OPENBELT_TAILNET is "${NAME}": use lowercase letters, digits and dashes`)

const must = (cmd: ReadonlyArray<string>, cwd = ROOT) => {
  const p = Bun.spawnSync([...cmd], { cwd, stdin: "ignore" })

  if (p.exitCode !== 0) fail(`${cmd.join(" ")} failed: ${p.stderr.toString().trim()}`)

  return p.stdout.toString().trim()
}

const gitIn = (repo: string, ...cmd: ReadonlyArray<string>) => {
  const p = Bun.spawnSync(["git", ...cmd], { cwd: repo, stdin: "ignore" })

  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined
}

const short = (sha: string) => sha.slice(0, 7)

const tailscale = () => tailscaleOf(fail)

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const Env = Schema.decodeUnknownSync(
  Schema.Struct({
    OPENBELT_ADMIN_TOKEN: Schema.String,
    OPENBELT_SESSION_SECRET: Schema.String,
    OPENBELT_SECRETS_KEY: Schema.String,
    OPENBELT_PORT: Schema.NumberFromString,
    INNER_PORT: Schema.NumberFromString,
    HTTPS_PORT: Schema.NumberFromString,
    OPENBELT_DEV_DOMAIN: Schema.optional(Schema.String),
    OPENBELT_DEV_CERT: Schema.optional(Schema.String),
    OPENBELT_DEV_KEY: Schema.optional(Schema.String),
  }),
)

type Env = ReturnType<typeof Env>

const envLines = () =>
  existsSync(ENV_FILE)
    ? Object.fromEntries(
        readFileSync(ENV_FILE, "utf8")
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
    : {}

const readEnv = () => Env(envLines())

const domainIn = (env: Env): Domain =>
  env.OPENBELT_DEV_DOMAIN === undefined
    ? fail(`there's no domain for the tailnet yet. ${SETUP} Then run bun run tailnet up.`)
    : {
        domain: env.OPENBELT_DEV_DOMAIN,
        cert: env.OPENBELT_DEV_CERT ?? "",
        key: env.OPENBELT_DEV_KEY ?? "",
        from: ENV_FILE.replace(homedir(), "~"),
      }

const urlOf = (env: Env) => `https://acme.${domainIn(env).domain}:${env.HTTPS_PORT}`

const taken = (port: number) =>
  new Promise<boolean>((done) => {
    const probe = createServer()

    probe.once("error", () => done(true))
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(false)))
  })

const freeFrom = async (from: number, avoid: ReadonlyArray<number> = []) => {
  let port = from

  // oxlint-disable-next-line no-await-in-loop -- one port at a time, in order
  while (avoid.includes(port) || (await taken(port))) port++

  return port
}

const ensureEnv = async (domain: Domain | undefined) => {
  const known = envLines()
  const add: Record<string, string> = {}

  if (known["OPENBELT_SECRETS_KEY"] === undefined)
    add["OPENBELT_SECRETS_KEY"] = randomBytes(32).toString("hex")

  if (domain !== undefined) {
    if (known["OPENBELT_DEV_DOMAIN"] !== domain.domain) add["OPENBELT_DEV_DOMAIN"] = domain.domain

    if (known["OPENBELT_DEV_CERT"] !== domain.cert) add["OPENBELT_DEV_CERT"] = domain.cert

    if (known["OPENBELT_DEV_KEY"] !== domain.key) add["OPENBELT_DEV_KEY"] = domain.key
  }

  if (known["OPENBELT_ADMIN_TOKEN"] === undefined)
    add["OPENBELT_ADMIN_TOKEN"] = randomBytes(24).toString("hex")

  if (known["OPENBELT_SESSION_SECRET"] === undefined)
    add["OPENBELT_SESSION_SECRET"] = randomBytes(32).toString("hex")

  const port = Number(known["OPENBELT_PORT"] ?? (await freeFrom(1440)))

  if (known["OPENBELT_PORT"] === undefined) add["OPENBELT_PORT"] = String(port)

  if (known["INNER_PORT"] === undefined) add["INNER_PORT"] = String(await freeFrom(port + 1))

  if (known["HTTPS_PORT"] === undefined) {
    const served = servedPorts()
    let https = 8444

    while (served.has(https)) https++

    add["HTTPS_PORT"] = String(https)
  }

  if (Object.keys(add).length > 0) {
    mkdirSync(dirname(ENV_FILE), { recursive: true })
    writeFileSync(
      ENV_FILE,
      `${Object.entries({ ...known, ...add })
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    )
  }

  return readEnv()
}

const front = (env: Env) => `http://127.0.0.1:${env.OPENBELT_PORT}`

const inner = (env: Env) => `http://127.0.0.1:${env.INNER_PORT}`

const State = Schema.Struct({
  current: Schema.NullOr(Schema.String),
  previous: Schema.NullOr(Schema.String),
})

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State))

const readState = (): typeof State.Type =>
  Option.getOrElse(decodeState(existsSync(STATE) ? readFileSync(STATE, "utf8") : ""), () => ({
    current: null,
    previous: null,
  }))

const writeState = (state: typeof State.Type) =>
  writeFileSync(STATE, JSON.stringify(state, null, 2))

const releaseDir = (sha: string) => join(RELEASES, sha)

const refuseLostCallbacks = (from: string, to: string, instead: string) => {
  const lacking = callbacksLostGoing(CLONE, from, to)

  if (lacking.length > 0)
    fail(
      `${short(to)} doesn't run or drain the alarm jobs ${lacking.map((n) => `"${n}"`).join(", ")}, which ${short(from)} books and can be pending here: they'd be retried every 30s forever. Nothing changed. ${instead}`,
    )
}

const READY = ".openbelt-release"

const ensureRelease = (sha: string) => {
  const dir = releaseDir(sha)

  if (existsSync(join(dir, READY))) return dir

  if (existsSync(dir)) {
    gitIn(CLONE, "worktree", "remove", "--force", dir)
    rmSync(dir, { recursive: true, force: true })
  }

  mkdirSync(RELEASES, { recursive: true })
  must(["git", "worktree", "add", "--detach", "--quiet", dir, sha], CLONE)
  must(["bun", "install", "--frozen-lockfile"], dir)
  writeFileSync(join(dir, READY), `${sha}\n`)

  return dir
}

const pruneReleases = (keep: ReadonlyArray<string | null>) => {
  if (!existsSync(RELEASES)) return

  for (const sha of readdirSync(RELEASES)) {
    if (keep.includes(sha)) continue

    gitIn(CLONE, "worktree", "remove", "--force", releaseDir(sha))
    rmSync(releaseDir(sha), { recursive: true, force: true })
  }

  gitIn(CLONE, "worktree", "prune")
}

const snapshot = (from: string | null, to: string, keep?: string) => {
  if (!existsSync(DATA_DIR)) return undefined

  const dir = join(
    SNAPSHOTS,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${from === null ? "none" : short(from)}-${short(to)}`,
  )

  mkdirSync(dir, { recursive: true })
  must(["cp", "-c", "-R", DATA_DIR, join(dir, "data")])

  const all = readdirSync(SNAPSHOTS).toSorted()

  for (const old of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS)))
    if (join(SNAPSHOTS, old) !== keep)
      rmSync(join(SNAPSHOTS, old), { recursive: true, force: true })

  return dir
}

/** Puts a snapshot back as the data (the platform stopped): copied in full before the data goes. */
const restore = (dir: string) => {
  const incoming = join(DATA, ".data-restoring")

  mkdirSync(DATA, { recursive: true })
  rmSync(incoming, { recursive: true, force: true })
  must(["cp", "-c", "-R", join(dir, "data"), incoming])
  rmSync(DATA_DIR, { recursive: true, force: true })
  renameSync(incoming, DATA_DIR)
}

const runsReleases = (release: string) =>
  [
    join("scripts", "frontdoor.ts"),
    join("packages", "platform", "src", "server.ts"),
    join("packages", "platform", "src", "runtime", "localdb.ts"),
    STORAGE,
  ].every((file) => existsSync(join(release, file)))

/** Seconds launchd lets a service stop before it kills it (the default is 20; the platform stops within 22). */
const EXIT_TIMEOUT = 60

const loaded = (label: string) =>
  Bun.spawnSync(["launchctl", "print", `${DOMAIN}/${label}`]).exitCode === 0

/**
 * Stop a service and wait until launchd has let it go: bootout returns while it is still
 * stopping its tree, and loading it again before then fails. A service has EXIT_TIMEOUT seconds
 * after SIGTERM before launchd kills it (its plist), and this waits a little longer.
 */
const unload = (label: string) => {
  if (!loaded(label)) return

  Bun.spawnSync(["launchctl", "bootout", `${DOMAIN}/${label}`])

  const deadline = Date.now() + (EXIT_TIMEOUT + 15) * 1000

  while (loaded(label) && Date.now() < deadline) Bun.sleepSync(200)

  if (loaded(label))
    fail(
      `launchd didn't stop ${label} within ${EXIT_TIMEOUT + 15}s: launchctl print ${DOMAIN}/${label}`,
    )
}

const plistPath = (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`)

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")

/**
 * A launchd service, started at login and restarted if it stops; loaded fresh. `extra` is its
 * environment beyond PATH (the platform's secrets: the plist is readable only by you).
 */
const load = (
  label: string,
  program: ReadonlyArray<string>,
  cwd: string,
  log: string,
  extra: Readonly<Record<string, string>> = {},
) => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    ${program.map((a) => `<string>${xml(a)}</string>`).join("")}
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>OPENBELT_TAILNET</key><string>${NAME}</string>
    ${Object.entries(extra)
      .map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`)
      .join("\n    ")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>${EXIT_TIMEOUT}</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`

  mkdirSync(dirname(plistPath(label)), { recursive: true })
  writeFileSync(plistPath(label), plist, { mode: 0o600 })
  chmodSync(plistPath(label), 0o600)
  unload(label)
  must(["launchctl", "bootstrap", DOMAIN, plistPath(label)])
}

/** The environment of the platform from the release at `root`, listening on `port`, on the data at `data`. */
const platformEnv = (root: string, env: Env, port: number, data: string) => ({
  OPENBELT_NAMESPACE: NAMESPACE,
  OPENBELT_DATA: data,
  OPENBELT_PORT: String(port),
  OPENBELT_ADMIN_TOKEN: env.OPENBELT_ADMIN_TOKEN,
  OPENBELT_SESSION_SECRET: env.OPENBELT_SESSION_SECRET,
  OPENBELT_SECRETS_KEY: env.OPENBELT_SECRETS_KEY,
  OPENBELT_SIGNIN: "tailscale",
  // Apps' hosts are beside its workspaces': <app>--acme.<domain>.
  OPENBELT_HOST: domainIn(env).domain,
  OPENBELT_COMMIT: gitIn(root, "rev-parse", "--short=7", "HEAD") ?? "",
})

/** What runs the platform from the release at `root`. */
const platformProgram = (root: string) => [
  process.execPath,
  join(root, "packages", "platform", "src", "server.ts"),
]

/** The platform's service from the release, on the data. */
const loadStack = (release: string) => {
  const env = readEnv()

  mkdirSync(DATA_DIR, { recursive: true })
  load(
    LABEL,
    platformProgram(release),
    DATA,
    LOG,
    platformEnv(release, env, env.INNER_PORT, DATA_DIR),
  )
}

/** Stops the platform (and a release from before's engine): nothing writes the data after this. */
const unloadStack = () => {
  unload(LABEL)
  unload(ENGINE_LABEL)
}

const frontConfig = (env: Env) => {
  const { host } = tailscale()
  const domain = domainIn(env)

  for (const line of describeDomain(domain)) console.log(line)

  const certificates = certificatesOf(domain, host, join(dirname(ENV_FILE), "certs"))

  const listeners: ReadonlyArray<Listener> = [
    { address: tailnetAddress(), port: env.HTTPS_PORT, certificates },
    { address: "127.0.0.1", port: env.OPENBELT_PORT, certificates: [] },
  ]

  const version = createHash("sha256")
    .update(certificates.map((c) => readFileSync(c.cert, "utf8")).join("\n"))
    .digest("hex")
    .slice(0, 16)

  return `${JSON.stringify({ listeners, to: env.INNER_PORT, updating: UPDATING, version }, null, 2)}\n`
}

const ensureFront = (release: string, env: Env) => {
  const bundled = join(release, ".openbelt-front.js")

  must(
    [
      process.execPath,
      "build",
      join(release, "scripts", "frontdoor.ts"),
      "--target=bun",
      "--outfile",
      bundled,
    ],
    release,
  )

  const source = readFileSync(bundled, "utf8")
  const config = frontConfig(env)

  const same =
    existsSync(FRONT) &&
    readFileSync(FRONT, "utf8") === source &&
    existsSync(FRONT_CONFIG) &&
    readFileSync(FRONT_CONFIG, "utf8") === config

  if (same && loaded(FRONT_LABEL)) return

  if (servedPorts().has(env.HTTPS_PORT))
    must(["tailscale", "serve", `--https=${env.HTTPS_PORT}`, "off"])

  writeFileSync(FRONT, source)
  writeFileSync(FRONT_CONFIG, config)
  load(FRONT_LABEL, [process.execPath, FRONT, FRONT_CONFIG], SHARE, FRONT_LOG)
}

const writeUpdatingPage = (release: string) => {
  const css = ["tokens.css", "base.css", "components.css", "logo.css"]
    .map((f) => readFileSync(join(release, "brand", "css", f), "utf8"))
    .join("\n")

  const logo = readFileSync(join(release, "brand", "logo", "openbelt.svg"), "utf8")

  writeFileSync(
    UPDATING,
    `<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>OpenBelt is updating</title>
<style>${css}
body { min-height: 100vh; display: grid; place-items: center; }
.empty .brand-logo { --logo-size: 24px; color: var(--openbelt-color-primary); margin: 0 auto var(--openbelt-space-md); }
.empty h1 { font: var(--openbelt-type-h4); color: var(--openbelt-color-primary); }
</style>
</head>
<body>
<main class="empty">${logo.replace("<svg ", '<svg class="brand-logo" ')}<h1>Updating</h1><p>A new version is starting. This page reloads by itself.</p></main>
</body>
</html>
`,
  )
}

const Health = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ commit: Schema.String })),
)

const runs = async (url: string) =>
  Option.getOrUndefined(
    Health(
      await fetch(`${url}/_health`, { signal: AbortSignal.timeout(2000) }).then(
        (r) => (r.ok ? r.text() : ""),
        () => "",
      ),
    ),
  )?.commit

/**
 * Waits up to `ms` for the platform at `url` to answer, running `sha` when given; gives up at
 * once when `gone` says the process behind it ended.
 */
const answers = async (
  url: string,
  ms: number,
  sha?: string,
  gone: () => boolean = () => false,
) => {
  const deadline = Date.now() + ms

  while (Date.now() < deadline && !gone()) {
    // oxlint-disable-next-line no-await-in-loop -- polling until it answers
    const commit = await runs(url)

    if (commit !== undefined && (sha === undefined || commit === short(sha))) return true

    // oxlint-disable-next-line no-await-in-loop -- polling until it answers
    await sleep(250)
  }

  return false
}

const spawnLogged = (
  cmd: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  out: (text: string) => void,
) => {
  const child = Bun.spawn([...cmd], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let ended = false

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()

    for await (const chunk of stream) out(decoder.decode(chunk, { stream: true }))
  }

  void Promise.all([pump(child.stdout), pump(child.stderr), child.exited]).finally(() => {
    ended = true
  })

  return { pid: child.pid, ended: () => ended }
}

const tryOnCopy = async (release: string, env: Env) => {
  const dir = mkdtempSync(join(tmpdir(), `openbelt-${NAME}-try-`))
  const log: Array<string> = []
  const pids: Array<number> = []
  let started = false
  let held: Option.Option<Inventory> = Option.none()

  try {
    const copy = join(dir, "data")

    if (existsSync(DATA_DIR)) must(["cp", "-c", "-R", DATA_DIR, copy])

    const port = await freeFrom(20_000 + Math.floor(Math.random() * 20_000))
    const out = (text: string) => log.push(text)

    const server = spawnLogged(
      platformProgram(release),
      dir,
      platformEnv(release, env, port, copy),
      out,
    )

    pids.push(server.pid)

    const url = `http://127.0.0.1:${port}`

    started = await answers(url, 120_000, undefined, server.ended)

    if (started) held = await inventoryOf(url, env.OPENBELT_ADMIN_TOKEN)
  } finally {
    for (const pid of pids) killTree(pid)
    rmSync(dir, { recursive: true, force: true })
  }

  // The last lines, with a stack trace's frames cut to the first two.
  const lines = log.join("").trim().split("\n")

  const shown = lines.filter(
    (line, i) => !/^\s+at /.test(line) || !/^\s+at /.test(lines[i - 2] ?? ""),
  )

  return { started, held, log: shown.slice(-20).join("\n") }
}

const commands = (env: Env, user: string, token: string) => {
  const url = `${urlOf(env)}/mcp`
  const auth = `Bearer ${token}`

  return `MCP for ${user}: ${url}

Claude Code: claude mcp add --transport http openbelt ${url} --header "Authorization: ${auth}"
Codex:       codex -c 'mcp_servers.openbelt.url="${url}"' -c 'mcp_servers.openbelt.http_headers={Authorization="${auth}"}'
pi:          pi mcp add openbelt --url ${url} --header "Authorization=${auth}"`
}

const mint = async (env: Env, user: string) =>
  (await mintToken(front(env), env.OPENBELT_ADMIN_TOKEN, user, 60_000)) ??
  fail(`it didn't answer on ${front(env)} within a minute: read ${LOG}`)

const changes = (from: string, to: string) => {
  const lines = (gitIn(CLONE, "log", "--oneline", "--no-decorate", `${from}..${to}`) ?? "")
    .split("\n")
    .filter((l) => l !== "")

  return `${lines.length} commit${lines.length === 1 ? "" : "s"}${
    lines.length === 0
      ? ""
      : `:\n${lines
          .slice(0, 15)
          .map((l) => `  ${l}`)
          .join("\n")}${lines.length > 15 ? "\n  ..." : ""}`
  }`
}

const switchBack = async (env: Env, sha: string, data: string | undefined) => {
  unloadStack()

  if (data !== undefined) restore(data)

  loadStack(ensureRelease(sha))

  return answers(inner(env), 120_000, sha)
}

const up = async () => {
  if (platform() !== "darwin") fail("it runs as launchd services, so macOS only for now")

  const { host, login } = tailscale()
  const env = await ensureEnv(domainOf(fail))
  const ref = rest[0] ?? "main"

  const url = urlOf(env)

  if (!existsSync(CLONE)) {
    mkdirSync(dirname(CLONE), { recursive: true })
    must(["git", "clone", "--quiet", "--no-checkout", ROOT, CLONE])
  }

  must(["git", "fetch", "--quiet", "--tags", "origin"], CLONE)

  const target =
    gitIn(CLONE, "rev-parse", "--verify", "--quiet", `origin/${ref}^{commit}`) ??
    gitIn(CLONE, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`) ??
    fail(`"${ref}" isn't a branch, tag or commit of ${ROOT}`)

  const state = readState()
  const current = state.current
  const release = ensureRelease(target)

  if (!runsReleases(release))
    fail(
      `${short(target)} is older than this way of running OpenBelt (releases, a front door on the tailnet's domain, the platform on its own data, no engine), so it can't run here: pick a newer ref`,
    )

  if (existsSync(ENGINE_DIR) && !existsSync(DATA_DIR))
    fail(
      `the data is still in the Rivet engine's directory (${ENGINE_DIR}), which this version doesn't read: export it first (docs/running.md, "Moving off the Rivet engine"). Nothing changed.`,
    )

  writeUpdatingPage(release)

  if (current === target && (await runs(inner(env))) === short(target)) {
    ensureFront(release, env)
    console.log(`already on ${short(target)} (${gitIn(CLONE, "log", "-1", "--format=%s", target)})`)
  } else {
    console.log(
      current === null
        ? `starting ${short(target)}: ${gitIn(CLONE, "log", "-1", "--format=%s", target)}`
        : current === target
          ? `restarting ${short(target)}`
          : `${short(current)} → ${short(target)}, ${changes(current, target)}`,
    )

    const drops =
      current === null || current === target
        ? []
        : droppedSince(CLONE, current, fileAt(CLONE, target, STORAGE))

    if (drops.length > 0 && !flag("drop")) {
      fail(`${short(target)} drops data on purpose:
${drops.map((d) => `  ${d.name}: ${d.why}`).join("\n")}
Nothing changed. To go ahead: bun run tailnet up ${ref} --drop (a snapshot of the data is kept; bun run tailnet rollback --data brings it back).`)
    }

    if (current !== null && current !== target)
      refuseLostCallbacks(
        current,
        target,
        `Go to a version that registers them (each a real handler or a drain in src/drains.ts).`,
      )

    let tried: Inventory | undefined

    if (current !== null) {
      const running = inner(env)
      const answering = (await runs(running)) !== undefined

      const before = answering
        ? await inventoryOf(running, env.OPENBELT_ADMIN_TOKEN)
        : Option.none()

      console.log(`trying ${short(target)} on a copy of the data...`)

      const attempt = await tryOnCopy(release, env)

      if (!attempt.started)
        fail(
          `${short(target)} didn't start on a copy of the data, so nothing changed (it still runs ${short(current)}). Its output:\n${attempt.log}`,
        )

      tried = Option.getOrUndefined(attempt.held)

      const lost =
        Option.isSome(before) && tried !== undefined ? lostBetween(before.value, tried) : []

      if (Option.isNone(before))
        console.log(
          `  (${short(current)} ${answering ? "predates /_admin/inventory" : "isn't running"}, so what the upgrade keeps can't be compared; the snapshot is the way back)`,
        )

      const accidental = unexcused(lost, drops)

      if (accidental.length > 0)
        fail(
          `${short(target)}, tried on a copy of the data, lost ${described(accidental)}. Nothing changed (it still runs ${short(current)}).`,
        )

      if (lost.length > 0) console.log(`  lost on purpose (--drop): ${described(lost)}`)
    }

    const stopped = Date.now()
    let saved: string | undefined

    recover = () => {
      if (current !== null) loadStack(ensureRelease(current))
    }

    try {
      // The platform stopped: the data is still while it's snapshotted and the new version takes it over.
      unloadStack()
      // First, so it holds requests from here on.
      ensureFront(release, env)
      saved = snapshot(current, target)
      loadStack(release)
    } catch (error) {
      fail(`switching to ${short(target)} failed: ${String(error)}`)
    }

    const came = await answers(inner(env), 120_000, target)

    recover = undefined

    const now = came ? await inventoryOf(inner(env), env.OPENBELT_ADMIN_TOKEN) : Option.none()

    const missing =
      tried === undefined || Option.isNone(now)
        ? []
        : tried.apps.filter((a) => !now.value.apps.some((n) => n.app === a.app)).map((a) => a.app)

    if (!came || missing.length > 0) {
      const why = came
        ? `came up without ${missing.join(", ")}`
        : `didn't answer within 2 minutes (bun run tailnet logs)`

      if (current === null) fail(`${short(target)} ${why}`)

      console.error(`${short(target)} ${why}: going back to ${short(current)}...`)

      const back = await switchBack(env, current, saved)

      fail(
        back
          ? `back on ${short(current)}, with the data as it was before (${saved ?? "no data yet"}).`
          : `going back to ${short(current)} didn't come up either: bun run tailnet logs. The data before this up: ${saved ?? "none"}`,
      )
    }

    writeState({ current: target, previous: current === target ? state.previous : current })
    console.log(
      `switched in ${((Date.now() - stopped) / 1000).toFixed(1)}s (requests waited meanwhile)`,
    )
  }

  const kept = readState()

  pruneReleases([kept.current, kept.previous])

  const token = await mint(env, login)

  const me = await fetch(`${url}/_me`).then(
    (r) => r.text(),
    () => "no answer",
  )

  if (!me.includes(`"email":"${login.toLowerCase()}"`))
    fail(`${url}/_me should be you (${login}), and it said: ${me.slice(0, 300)}`)

  console.log(`
OpenBelt is up for your tailnet: ${url} (you're ${login} there; each app on https://<app>--acme.${domainIn(env).domain}:${env.HTTPS_PORT}, and https://${host}:${env.HTTPS_PORT} still lands)

${commands(env, login, token)}

Upgrade it: bun run tailnet up [ref]. Undo an upgrade: bun run tailnet rollback. Stop it: bun run tailnet down. Log: bun run tailnet logs.`)
}

const rollback = async () => {
  const env = readEnv()
  const { current, previous } = readState()

  if (current === null || previous === null)
    fail("there's no earlier version to go back to (it goes back one up at a time)")

  const saved = flag("data")
    ? (existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS) : [])
        .filter((d) => d.endsWith(`-${short(previous)}-${short(current)}`))
        .toSorted()
        .at(-1)
    : undefined

  if (flag("data") && saved === undefined)
    fail(`no snapshot from the up ${short(previous)} → ${short(current)} (they're in ${SNAPSHOTS})`)

  if (!flag("data"))
    refuseLostCallbacks(
      current,
      previous,
      `bun run tailnet rollback --data also puts the data back as it was before that up (writes since are lost), or go to a version that registers them: bun run tailnet up <ref>.`,
    )

  if (!runsReleases(ensureRelease(previous)))
    fail(
      `${short(previous)} is older than this way of running OpenBelt, so rollback can't run it. The data from before the upgrade is in ${SNAPSHOTS}.`,
    )

  if (saved !== undefined) {
    unloadStack()
    snapshot(current, previous, join(SNAPSHOTS, saved))
  }

  console.log(
    `${short(current)} → ${short(previous)}${saved === undefined ? "" : `, with the data from ${saved}`}`,
  )

  const back = await switchBack(
    env,
    previous,
    saved === undefined ? undefined : join(SNAPSHOTS, saved),
  )

  if (!back) fail(`${short(previous)} didn't come up: bun run tailnet logs`)

  writeState({ current: previous, previous: current })
  console.log(`back on ${short(previous)}. bun run tailnet up goes forward again.`)
}

const status = async () => {
  if (!existsSync(ENV_FILE)) return console.log("not set up: bun run tailnet up")

  const env = readEnv()
  const url = urlOf(env)
  const { current, previous } = readState()
  const commit = await runs(inner(env))
  const door = (await runs(url)) !== undefined

  const behind =
    current === null ? undefined : gitIn(ROOT, "rev-list", "--count", `${current}..main`)

  console.log(
    commit === undefined
      ? `down: ${loaded(LABEL) ? `the service is loaded but ${inner(env)} doesn't answer (bun run tailnet logs)` : "the service isn't loaded (bun run tailnet up)"}`
      : `up: ${url} runs ${commit}${behind === undefined || behind === "0" ? "" : `, ${behind} commit${behind === "1" ? "" : "s"} behind main (bun run tailnet up)`}${door ? "" : `, but its front door doesn't answer there (bun run tailnet logs)`}`,
  )

  if (previous !== null) console.log(`before that: ${short(previous)} (bun run tailnet rollback)`)
}

const token = async () => {
  const env = readEnv()
  const { login } = tailscale()
  const user = rest[0] ?? login

  console.log(commands(env, user, await mint(env, user)))
}

const down = () => {
  unload(FRONT_LABEL)
  unloadStack()

  console.log(`stopped. The data stays in ${DATA_DIR}; bun run tailnet up starts it again.`)
}

if (command === "up") await up()
else if (command === "rollback") await rollback()
else if (command === "status") await status()
else if (command === "token") await token()
else if (command === "down") down()
else if (command === "logs")
  Bun.spawnSync(["tail", flag("follow") ? "-f" : "-n50", LOG], {
    stdio: ["inherit", "inherit", "inherit"],
  })
else {
  console.error(
    "usage: bun run tailnet up [ref] [--drop] | rollback [--data] | status | token [email] | logs [--follow] | down",
  )
  process.exit(2)
}
