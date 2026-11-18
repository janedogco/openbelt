import { assertWorkspaceSettings } from "../packages/platform/src/runtime/workspace-upgrade.ts"
// `bun run dev`: the platform from this checkout with live reload (bun --watch): its data stays between runs in this checkout's
// namespace in ~/.openbelt/data (OPENBELT_DATA). Once it answers, prints an API token and how to reach it.
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { Option, Schema } from "effect"
import { certificatesOf, describeDomain, domainOf, SETUP, tailnetAddress } from "./domain.ts"
import { openFrontDoor } from "./frontdoor.ts"
import { sweep } from "./sweep.ts"
import { tidy } from "./tidy.ts"
import { servedTo, tailscale } from "./tailscale.ts"
import { killTree, nameWorkspaceAdmin, mintToken } from "./verify/drive/processes.ts"

assertWorkspaceSettings(process.env)

const ROOT = resolve(import.meta.dir, "..")

const ADMIN = process.env.OPENBELT_ADMIN_TOKEN ?? randomBytes(24).toString("hex")

/** This checkout's local files (never committed): the dev server's address and secrets key. */
const DEV_DIR = join(ROOT, ".dev")

const secretsKey = () => {
  const file = join(DEV_DIR, "secrets-key")

  if (!existsSync(file)) {
    mkdirSync(DEV_DIR, { recursive: true })
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 })
  }

  return readFileSync(file, "utf8").trim()
}

const fail = (message: string): never => {
  console.error(`bun run dev: ${message}`)

  return process.exit(1)
}

const domain = domainOf(fail)

if (domain !== undefined)
  for (const line of describeDomain(domain)) console.log(`bun run dev: ${line}`)

const { host, login, name } =
  domain !== undefined || Bun.which("tailscale") !== null
    ? tailscale(fail)
    : { host: "", login: `${userInfo().username}@localhost`, name: "" }

for (const line of [...sweep(), ...tidy()]) console.log(`bun run dev: ${line}`)

const git = (...args: ReadonlyArray<string>) =>
  Bun.spawnSync(["git", ...args], { cwd: ROOT })
    .stdout.toString()
    .trim()

const linked = git("rev-parse", "--git-dir") !== git("rev-parse", "--git-common-dir")

const free = (port: number, address = "127.0.0.1") =>
  new Promise<boolean>((done) => {
    const server = createServer()

    server.once("error", () => done(false))
    server.listen(port, address, () => server.close(() => done(true)))
  })

const slotOf = (path: string) => {
  let h = 2_166_136_261

  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16_777_619) >>> 0

  return h % 50
}

const portsOf = async () => {
  if (process.env.OPENBELT_PORT !== undefined || process.env.OPENBELT_DEV_HTTPS_PORT !== undefined)
    return {
      port: Number(process.env.OPENBELT_PORT ?? 1337),
      https: Number(process.env.OPENBELT_DEV_HTTPS_PORT ?? 8445),
    }

  if (!linked) return { port: 1337, https: 8445 }

  const start = slotOf(ROOT)

  for (let i = 0; i < 50; i++) {
    const slot = (start + i) % 50

    // oxlint-disable-next-line no-await-in-loop -- one slot at a time, in order
    if ((await free(1340 + slot)) && (await free(2340 + slot)))
      return { port: 1340 + slot, https: 8450 + slot }
  }

  return fail("no free pair of ports in 1340-1389 / 8450-8499: stop another bun run dev")
}

const { port: PORT, https: HTTPS_PORT } = await portsOf()

const target = `http://127.0.0.1:${PORT}`

const INNER = PORT + 1000

if (!(await free(PORT))) fail(`port ${PORT} is in use: stop what holds it, or set OPENBELT_PORT`)

if (!(await free(INNER))) fail(`port ${INNER} (the platform's, behind the door) is in use`)

if (host !== "" && servedTo(host, HTTPS_PORT) === target)
  Bun.spawnSync(["tailscale", "serve", `--https=${HTTPS_PORT}`, "off"])

const address = domain === undefined ? "" : tailnetAddress()

if (domain !== undefined && !(await free(HTTPS_PORT, address)))
  fail(
    `port ${HTTPS_PORT} on ${address} is in use (tailscale serve, or another bun run dev): free it, or set OPENBELT_DEV_HTTPS_PORT`,
  )

/** This checkout's data: its own namespace, named from its folder so a worktree keeps its own. */
const namespace = `dev-${slotOf(ROOT)}-${
  ROOT.split("/")
    .at(-1)
    ?.replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase() ?? "openbelt"
}`

const child = Bun.spawn(["bun", "--watch", join(ROOT, "packages/platform/src/server.ts")], {
  cwd: ROOT,
  stdin: "pipe",
  env: {
    ...process.env,
    OPENBELT_NAMESPACE: namespace,
    OPENBELT_PORT: String(INNER),
    OPENBELT_DOOR_PORT: String(PORT),
    OPENBELT_ADMIN_TOKEN: ADMIN,
    OPENBELT_SECRETS_KEY: process.env.OPENBELT_SECRETS_KEY ?? secretsKey(),
    OPENBELT_ALLOW_LOCAL_CONNECTIONS: "1",
    OPENBELT_SIGNIN: "email",
    // Uploads (files.ts UPLOADS) are on here, off on prod until they're ready.
    OPENBELT_UPLOADS: process.env.OPENBELT_UPLOADS ?? "on",
    OPENBELT_HOST: domain?.domain ?? "localhost",
    OPENBELT_HTTPS_PORT: String(HTTPS_PORT),
  },
  stdio: ["inherit", "pipe", "pipe"],
})

// The server's output goes to this terminal and to .dev/logs/dev.log, where bun run drive reads a trace's lines from.
mkdirSync(join(DEV_DIR, "logs"), { recursive: true })

const devLog = join(DEV_DIR, "logs", "dev.log")

writeFileSync(devLog, "")

const Said = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      at: Schema.String,
      level: Schema.String,
      msg: Schema.String,
      trace: Schema.optionalKey(Schema.String),
      cause: Schema.optionalKey(Schema.String),
    }),
  ),
)

/** A JSON log line as a person reads it in this terminal (the file keeps the JSON): time, level, message, trace, cause. */
const readable = (line: string) =>
  Option.match(Said(line), {
    onNone: () => line,
    onSome: (l) =>
      `${new Date(l.at).toTimeString().slice(0, 8)} ${l.level.padEnd(5)} ${l.msg}${l.trace === undefined ? "" : `  (trace ${l.trace})`}${l.cause === undefined ? "" : `\n${l.cause}`}`,
  })

const tee = async (from: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
  const decoder = new TextDecoder()
  let partial = ""

  for await (const chunk of from) {
    appendFileSync(devLog, chunk)

    const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n")

    partial = lines.pop() ?? ""

    for (const line of lines) to.write(`${readable(line)}\n`)
  }
}

void tee(child.stdout, process.stdout)

void tee(child.stderr, process.stderr)

const door = openFrontDoor({
  listeners: [
    { address: "127.0.0.1", port: PORT, certificates: [], owner: { login, name } },
    ...(domain === undefined
      ? []
      : [
          {
            address,
            identity: process.argv.includes("--email")
              ? ("email" as const)
              : ("tailscale" as const),
            port: HTTPS_PORT,
            certificates: certificatesOf(
              domain,
              host,
              join(homedir(), ".config", "openbelt", "certs"),
            ),
          },
        ]),
  ],
  to: INNER,
})

// Ctrl-C reaches the server already; stopped from outside (a closed terminal, kill, timeout),
// stop it and everything it started too, or its sandboxes live on and keep the port.
/** What bun run seed reads to find this dev server (never committed: .dev/ is ignored). */
const DEV_FILE = join(DEV_DIR, "dev.json")

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void door.stop()
    rmSync(DEV_FILE, { force: true })
    killTree(child.pid)
    process.exit(1)
  })
}

const token = await mintToken(`http://acme.localhost:${PORT}`, ADMIN, login, 60_000)

if (
  token !== undefined &&
  (await nameWorkspaceAdmin(`http://acme.localhost:${PORT}`, ADMIN, login))
) {
  const url =
    domain === undefined
      ? `http://acme.localhost:${PORT}`
      : `https://acme.${domain.domain}:${HTTPS_PORT}`

  mkdirSync(DEV_DIR, { recursive: true })
  writeFileSync(
    DEV_FILE,
    JSON.stringify({
      url,
      via: `http://127.0.0.1:${INNER}`,
      token,
      adminToken: ADMIN,
      login,
    }),
    { mode: 0o600 },
  )

  const tailnet =
    domain === undefined
      ? `not on it yet. ${SETUP}`
      : `https://acme.${domain.domain}:${HTTPS_PORT}, ${process.argv.includes("--email") ? "email sign-in" : "everyone there as their own Tailscale login"}`

  console.log(`
  OpenBelt is running (workspace "acme"; each app on its own host, <app>--acme.<host>):
  Here:       http://acme.localhost:${PORT}, as you (${login}), no sign-in
  Tailnet:    ${tailnet}
  Signed out: http://acme.localhost:${INNER}, no door in front: sign in with an email code (in .dev/logs/dev.log), or as anyone: bun run workspace signin-link <email>
  MCP:   ${url}/mcp  as ${login}
  Token: ${token}

  Sign in:     claude mcp add --transport http openbelt ${url}/mcp, then /mcp in Claude Code (OAuth: no token)
  pi:          OPENBELT_TOKEN=${token} pi mcp add openbelt --url ${url}/mcp --bearer-token-env-var OPENBELT_TOKEN
  Claude Code: claude mcp add --transport http openbelt ${url}/mcp --header "Authorization: Bearer ${token}"
  Or just:     bun run try:pi
  Your workspace:    bun run workspace people list --url ${url} --token ${token}  (you're its admin)
  To QA it:    bun run seed, then bun run qa <state>  (docs/qa.md)
`)
}

const code = await child.exited

void door.stop()

rmSync(DEV_FILE, { force: true })

process.exit(code)
