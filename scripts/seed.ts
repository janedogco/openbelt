// .dev/dev.json). --url is the workspace's URL as people open it; --via is the
// the real one (it takes no token). --fakes <origin> names one already running instead (one on another
// machine). --one-workspace: the
// target has only its own workspace, so there's no second workspace to seed.
/* oxlint-disable no-await-in-loop -- the seed's steps run in order: each reads what the last one changed */
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Option, Schema } from "effect"
import { appOrigin } from "../packages/platform/src/hosts.ts"
import {
  MY_PRS,
  MY_PRS_REDESIGN,
  PET_SHOP,
  PLAIN,
  POKEDEX,
  REPO_QA,
  SHIP_IT,
  prDigest,
} from "./seed/apps.ts"
import type { SeedApp } from "./seed/apps.ts"
import { CATALOG } from "./seed/catalog.ts"
import {
  SCALE_ASKS,
  SCALE_CALLS,
  SCALE_CONNECTIONS,
  SCALE_GROUPS,
  SCALE_OWN,
  SCALE_PEOPLE,
  type ScaleGroup,
} from "./seed/scale.ts"
import { connect, type Json, type McpSession } from "./verify/drive/mcp.ts"

const ROOT = resolve(import.meta.dir, "..")

const { values, positionals } = parseArgs({
  options: {
    run: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    "admin-token": { type: "string" },
    via: { type: "string" },
    fakes: { type: "string" },
    "one-workspace": { type: "boolean" },
    quiet: { type: "boolean" },
  },
  allowPositionals: true,
})

const [command = "seed", stateName] = positionals

const fail = (message: string): never => {
  console.error(`seed: ${message}`)

  return process.exit(2)
}

const say = (line: string) => {
  if (values.quiet !== true) console.log(line)
}

const Instance = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      url: Schema.String,
      adminToken: Schema.String,
      mcp: Schema.Struct({ token: Schema.String }),
    }),
  ),
)

const DevFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      url: Schema.String,
      via: Schema.String,
      token: Schema.String,
      adminToken: Schema.String,
    }),
  ),
)

type Target = {
  readonly url: string
  readonly via: string | undefined
  readonly token: string
  readonly admin: string
  readonly dir: string
}

const DEV_FILE = join(ROOT, ".dev/dev.json")

const target = (): Target => {
  if (values.run !== undefined) {
    const file = join(values.run, "instance.json")

    if (!existsSync(file))
      fail(`no ${file}: launch one with bun scripts/verify/launch.ts --run ${values.run}`)

    const instance = Option.getOrElse(Instance(readFileSync(file, "utf8")), () =>
      fail(`${file} isn't what scripts/verify/launch.ts writes`),
    )

    return {
      url: instance.url,
      via: values.via,
      token: instance.mcp.token,
      admin: instance.adminToken,
      dir: join(resolve(values.run), "seed"),
    }
  }

  const url = values.url ?? process.env.OPENBELT_MCP_URL?.replace(/\/mcp$/, "")

  if (url !== undefined) {
    const token = values.token ?? process.env.OPENBELT_TOKEN ?? fail("--url needs --token (yours)")

    const admin =
      values["admin-token"] ??
      process.env.OPENBELT_ADMIN_TOKEN ??
      fail(
        "--url needs --admin-token: the platform's OPENBELT_ADMIN_TOKEN, which mints the seeded people's tokens",
      )

    const { host } = new URL(url)

    return {
      url: url.replace(/\/$/, ""),
      via: values.via?.replace(/\/$/, ""),
      token,
      admin,
      dir: join(ROOT, ".verify/seed", host.replace(/[^a-z0-9.-]/gi, "_")),
    }
  }

  if (!existsSync(DEV_FILE))
    fail(
      "which OpenBelt? Start bun run dev in this checkout (it writes .dev/dev.json), or pass --run <dir>, or --url <workspace url> --token <yours> --admin-token <the platform's>",
    )

  const dev = Option.getOrElse(DevFile(readFileSync(DEV_FILE, "utf8")), () =>
    fail(`${DEV_FILE} isn't what bun run dev writes: start it again`),
  )

  return {
    url: dev.url,
    via: dev.via,
    token: dev.token,
    admin: dev.adminToken,
    dir: join(ROOT, ".dev/seed"),
  }
}

const named =
  values.run !== undefined ||
  values.url !== undefined ||
  process.env.OPENBELT_MCP_URL !== undefined ||
  existsSync(DEV_FILE)

const TARGET = command === "as" && stateName === undefined && !named ? undefined : target()

const send = (url: string, init: RequestInit = {}) => {
  const via = TARGET?.via

  if (via === undefined) return fetch(url, init)

  const to = new URL(url)
  const headers = new Headers(init.headers)

  headers.set("host", to.host)
  headers.set("x-forwarded-proto", to.protocol.replace(":", ""))

  return fetch(`${via}${to.pathname}${to.search}`, { ...init, headers })
}

const Refusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String, code: Schema.String })),
)

const JsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const call = async (
  url: string,
  path: string,
  bearer: string,
  body?: Json,
  ok: ReadonlyArray<number> = [200],
) => {
  const response = await send(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${bearer}` },
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).catch((e: Error) => fail(`no answer from ${url}${path} (${e.message}): is OpenBelt running?`))

  const text = await response.text()

  if (!ok.includes(response.status)) {
    const refusal = Option.getOrUndefined(Refusal(text))

    fail(
      `${path}: ${response.status} ${refusal === undefined ? text.slice(0, 400) : `${refusal.code}: ${refusal.error}`}`,
    )
  }

  return Option.getOrElse(JsonBody(text), () => null)
}

type Person = {
  readonly email: string
  readonly name: string
  readonly role: "admin" | "member"
  readonly status: "active" | "invited" | "removed"
  readonly groups: ReadonlyArray<Group>
  readonly github: boolean
  readonly allowed: ReadonlyArray<string>
  readonly tokens: ReadonlyArray<{ readonly label: string; readonly days?: number }>
}

type Group = "eng" | "contractors" | "support" | ScaleGroup

const GROUPS: ReadonlyArray<Group> = ["eng", "contractors", "support", ...SCALE_GROUPS]

const ADA = "ada@acme.test"

const PEOPLE: ReadonlyArray<Person> = [
  {
    email: ADA,
    name: "Ada Lovelace",
    role: "admin",
    status: "active",
    groups: [],
    github: true,
    allowed: [],
    tokens: [],
  },
  {
    email: "alice@acme.test",
    name: "Alice Chen",
    role: "member",
    status: "active",
    groups: ["eng"],
    github: true,
    allowed: ["my-prs", "pr-digest"],
    tokens: [],
  },
  {
    email: "bob@acme.test",
    name: "Bob Okafor",
    role: "member",
    status: "active",
    groups: ["eng"],
    github: true,
    allowed: ["my-prs"],
    tokens: [
      { label: "CI deploys", days: 90 },
      { label: "Old laptop", days: 1 },
    ],
  },
  {
    email: "carol@acme.test",
    name: "Carol Diaz",
    role: "member",
    status: "active",
    groups: ["contractors"],
    github: true,
    allowed: [],
    tokens: [],
  },
  {
    email: "dave@acme.test",
    name: "Dave Kim",
    role: "member",
    status: "invited",
    groups: [],
    github: false,
    allowed: [],
    tokens: [],
  },
  {
    email: "erin@acme.test",
    name: "Erin Walsh",
    role: "member",
    status: "removed",
    groups: [],
    github: false,
    allowed: [],
    tokens: [],
  },
  ...SCALE_PEOPLE.map((p): Person => ({
    email: p.email,
    name: p.name,
    role: "member",
    status: "active",
    groups: p.groups,
    github: false,
    allowed: [],
    tokens: [],
  })),
]

const OTHER_WORKSPACE = "globex"

const YOUR_TOKENS = [
  { label: "Claude Code on my laptop", days: 30 },
  { label: "Weekly report script" },
] as const

const githubToken = (email: string) =>
  `tok-gh-${(email.split("@")[0] ?? "x")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 38)}`

const asPerson = (email: string, name: string) => ({
  "tailscale-user-login": email,
  "tailscale-user-name": name,
})

const PeopleList = Schema.decodeUnknownSync(
  Schema.Struct({
    joining: Schema.String,
    people: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        email: Schema.String,
        name: Schema.String,
        role: Schema.String,
        status: Schema.String,
        groups: Schema.Array(Schema.String),
      }),
    ),
  }),
)

const TokenList = Schema.decodeUnknownSync(
  Schema.Struct({
    tokens: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        person: Schema.Struct({ email: Schema.String }),
        label: Schema.String,
        expires: Schema.NullOr(Schema.String),
      }),
    ),
  }),
)

const Minted = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String, id: Schema.String }))

const WhoAmI = Schema.decodeUnknownSync(
  Schema.Struct({
    person: Schema.Struct({ email: Schema.String, name: Schema.String, role: Schema.String }),
  }),
)

const ConnectionList = Schema.decodeUnknownSync(
  Schema.Struct({
    connections: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        url: Schema.String,
        credential: Schema.String,
        workspaceToken: Schema.String,
        everyone: Schema.String,
        groups: Schema.Record(Schema.String, Schema.String),
        people: Schema.Record(Schema.String, Schema.String),
        disabled: Schema.Array(Schema.String),
        markedRead: Schema.Array(Schema.String),
        tools: Schema.Array(Schema.Struct({ name: Schema.String })),
        problem: Schema.NullOr(Schema.String),
      }),
    ),
  }),
)

const MyConnections = Schema.decodeUnknownSync(
  Schema.Struct({
    connections: Schema.Array(
      Schema.Struct({ connection: Schema.String, yourToken: Schema.String }),
    ),
  }),
)

const Apps = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ app: Schema.String, owner: Schema.String }))),
)

const Calls = Schema.decodeUnknownSync(
  Schema.Struct({
    calls: Schema.Array(Schema.Struct({ outcome: Schema.String, person: Schema.String })),
  }),
)

const Warnings = Schema.decodeUnknownOption(
  Schema.Struct({ warnings: Schema.optional(Schema.Array(Schema.String)) }),
)

const Viewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(Schema.Struct({ email: Schema.String }))),
)

const Started = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
)

const Held = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, url: Schema.String })),
)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

const answers = (url: string) =>
  fetch(new URL("/", url), { signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  )

const github = async (dir: string) => {
  const file = join(dir, "dummy.json")

  const held = existsSync(file)
    ? Option.getOrUndefined(Held(readFileSync(file, "utf8")))
    : undefined

  if (held !== undefined && alive(held.pid) && (await answers(held.url))) return held.url

  const port = held === undefined ? "0" : new URL(held.url).port
  const log = join(dir, "dummy.log")

  rmSync(log, { force: true })

  // no lifeline: the seeded workspace's provider has to keep serving after seed exits
  const child = Bun.spawn(
    ["bun", join(ROOT, "scripts/verify/drive/dummy-mcp.ts"), "--github", "--port", port],
    { stdout: openSync(log, "a"), stderr: openSync(log, "a"), stdin: "ignore", detached: true },
  )

  child.unref()

  const deadline = Date.now() + 10_000

  while (Date.now() < deadline) {
    const started = Started((readFileSync(log, "utf8").split("\n")[0] ?? "").trim())

    if (Option.isSome(started)) {
      writeFileSync(file, JSON.stringify({ pid: child.pid, url: started.value.url }))

      return started.value.url
    }

    await Bun.sleep(100)
  }

  return fail(
    `the fake GitHub didn't start (port ${port} taken? another seed's?): ${readFileSync(log, "utf8").slice(0, 400)}`,
  )
}

const stopGithub = (dir: string) => {
  const file = join(dir, "dummy.json")

  const held = existsSync(file)
    ? Option.getOrUndefined(Held(readFileSync(file, "utf8")))
    : undefined

  if (held !== undefined && alive(held.pid)) process.kill(held.pid, "SIGTERM")

  rmSync(file, { force: true })

  return held
}

const run = async (t: Target) => {
  mkdirSync(t.dir, { recursive: true })

  const workspace = new URL(t.url).hostname.split(".")[0] ?? "acme"
  const otherUrl = t.url.replace(`//${workspace}.`, `//${OTHER_WORKSPACE}.`)
  const temporary: Array<{ url: string; token: string; id: string }> = []

  const mint = async (email: string, url = t.url) => {
    const made = Minted(await call(url, "/_admin/tokens", t.admin, { email, days: 1 }))

    temporary.push({ url, token: made.token, id: made.id })

    return made
  }

  await call(t.url, "/_admin/workspace-admins", t.admin, { email: ADA })

  const ada = await mint(ADA)
  const me = WhoAmI(await call(t.url, "/_me/whoami", t.token)).person

  const admin = (path: string, body?: Json | string, ok?: ReadonlyArray<number>) =>
    call(t.url, path, ada.token, body, ok)

  const probe = await send(`${t.url}/_me`, { headers: asPerson(ADA, "Ada Lovelace") }).then((r) =>
    r.text(),
  )

  if (Option.getOrUndefined(Viewer(probe))?.email !== ADA)
    fail(
      `${t.via ?? t.url} doesn't take the front door's headers as sent (a request as ${ADA} came back as ${probe.slice(0, 120)}): a front door is in the way. Pass the platform's own address too: --via http://127.0.0.1:<port>`,
    )

  const nameOf = (email: string) =>
    email === me.email ? me.name : (PEOPLE.find((p) => p.email === email)?.name ?? email)

  const visit = (email: string) =>
    send(`${t.url}/`, { headers: asPerson(email, nameOf(email)) }).then((r) => r.text())

  const settingsPage = async (email: string, section: string, query = "") => {
    const path = section === "connections" ? "/_connections" : `/_settings/${section}`

    const html = await send(`${t.url}${path}${query}`, {
      headers: asPerson(email, nameOf(email)),
    }).then((r) => r.text())

    return { html, form: /name="form" value="([^"]+)"/.exec(html)?.[1] ?? "" }
  }

  const settingsDo = async (
    email: string,
    action: string,
    fields: Readonly<Record<string, string>>,
  ) => {
    const { form } = await settingsPage(email, "agents")

    const response = await send(`${t.url}/_settings/${action}`, {
      method: "POST",
      headers: {
        ...asPerson(email, nameOf(email)),
        origin: t.url,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ ...fields, form }),
      redirect: "manual",
    })

    const html = await response.text()

    if (response.status >= 400)
      fail(
        `${email}'s settings refused ${action}: ${/<p class="lead">([^<]*)/.exec(html)?.[1] ?? response.status}`,
      )

    return html
  }

  const tokens = new Map<string, string>([[me.email, t.token]])

  const tokenOf = async (email: string) => {
    const held = tokens.get(email)

    if (held !== undefined) return held

    const made = (await mint(email)).token

    tokens.set(email, made)

    return made
  }

  const sessions = new Map<string, McpSession>()

  const agent = async (email: string) => {
    const open = sessions.get(email)

    if (open !== undefined) return open

    const made = await connect(`${t.url}/mcp`, await tokenOf(email))

    sessions.set(email, made)

    return made
  }

  const people = async () => PeopleList(await admin("/_workspace/people")).people

  const leftovers = TokenList(await admin("/_workspace/tokens")).tokens.filter(
    (k) =>
      k.label === "made by the platform admin" &&
      k.person.email !== me.email &&
      PEOPLE.some((p) => p.email === k.person.email) &&
      k.id !== ada.id,
  )

  for (const k of leftovers) await admin("/_workspace/tokens/revoke", { id: k.id })

  const finish = async () => {
    for (const { url, token, id } of temporary.toReversed())
      await call(url, "/_me/tokens/revoke", token, { id }, [200, 400, 401])
  }

  return {
    workspace,
    otherUrl,
    me,
    admin,
    mint,
    visit,
    nameOf,
    settingsPage,
    settingsDo,
    agent,
    tokenOf,
    people,
    finish,
    target: t,
  }
}

type Run = Awaited<ReturnType<typeof run>>

const seedPeople = async (r: Run) => {
  for (const p of PEOPLE) {
    const found = (await r.people()).find((x) => x.email === p.email)

    if (p.status === "removed") {
      if (found?.status === "removed") continue

      if (found === undefined)
        await r.admin("/_workspace/people/invite", { email: p.email, name: p.name })

      await r.visit(p.email)
      await r.admin("/_workspace/people/remove", { person: p.email })
      continue
    }

    if (found === undefined || found.status === "removed")
      await r.admin("/_workspace/people/invite", { email: p.email, name: p.name, role: p.role })
    else if (found.role !== p.role)
      await r.admin("/_workspace/people/role", { person: p.email, role: p.role })

    if (p.status === "active") await r.visit(p.email)
  }
}

const seedGroups = async (r: Run, yours: ReadonlyArray<Group>) => {
  const now = await r.people()

  for (const g of GROUPS) {
    await r.admin("/_workspace/groups/create", { name: g })

    const wanted = new Set([
      ...PEOPLE.flatMap((p) => (p.groups.includes(g) ? [p.email] : [])),
      ...(yours.includes(g) ? [r.me.email] : []),
    ])

    for (const p of now) {
      const seeded = p.email === r.me.email || PEOPLE.some((x) => x.email === p.email)
      const has = p.groups.includes(g)

      if (wanted.has(p.email) && !has)
        await r.admin("/_workspace/groups/add", { group: g, person: p.email })
      else if (seeded && !wanted.has(p.email) && has)
        await r.admin("/_workspace/groups/remove", { group: g, person: p.email })
    }
  }
}

type Wanted = {
  readonly name: string
  readonly url: string
  readonly credential: "none" | "workspace" | "person" | "both"
  readonly everyone: "none" | "read" | "all"
  readonly groups: Readonly<Record<string, string>>
  readonly people: Readonly<Record<string, string>>
  readonly disabled: ReadonlyArray<string>
  readonly markedRead: ReadonlyArray<string>
  readonly workspaceToken?: string
}

const DEEPWIKI = "https://mcp.deepwiki.com/mcp"

const wantedConnections = (githubUrl: string): ReadonlyArray<Wanted> => [
  {
    name: "github",
    url: githubUrl,
    credential: "person",
    everyone: "read",
    groups: { contractors: "none" },
    people: { "bob@acme.test": "all" },
    disabled: ["merge_pull_request"],
    markedRead: [],
  },
  {
    name: "deepwiki",
    url: DEEPWIKI,
    credential: "none",
    everyone: "read",
    groups: { eng: "all" },
    people: {},
    disabled: [],
    markedRead: ["ask_wiki_question"],
  },
  {
    name: "linear",
    url: githubUrl.replace(/\/mcp$/, "/expired/mcp"),
    credential: "workspace",
    everyone: "read",
    groups: {},
    people: {},
    disabled: [],
    markedRead: [],
    workspaceToken: "tok-linear-expired",
  },
  ...SCALE_CONNECTIONS.map((c): Wanted => {
    const wanted: Wanted = {
      name: c.name,
      url: githubUrl.replace(/\/mcp$/, `/catalog/${c.name}/mcp`),
      credential: c.credential,
      everyone: c.everyone,
      groups: c.groups,
      people: c.people,
      disabled: c.disabled,
      markedRead: [],
    }

    return c.credential === "person"
      ? wanted
      : { ...wanted, workspaceToken: `tok-workspace-${c.name}` }
  }),
]

const seedConnections = async (r: Run) => {
  const githubUrl =
    values.fakes === undefined
      ? await github(r.target.dir)
      : `${values.fakes.replace(/\/$/, "")}/mcp`

  for (const w of wantedConnections(githubUrl)) {
    const listed = async () =>
      ConnectionList(await r.admin("/_workspace/connections")).connections.find(
        (c) => c.name === w.name,
      )

    let c = await listed()

    if (c !== undefined && (c.url !== w.url || c.credential !== w.credential)) {
      await r.admin("/_workspace/connections/remove", { name: w.name })
      c = undefined
    }

    if (c === undefined)
      await r.admin("/_workspace/connections/add", {
        name: w.name,
        url: w.url,
        credential: w.credential,
        everyone: w.everyone,
      })

    if (w.workspaceToken !== undefined && (await listed())?.workspaceToken !== "set")
      await r.admin(
        `/_workspace/connections/${w.name}/token`,
        { token: w.workspaceToken },
        [200, 400, 502],
      )

    if (w.credential === "person" && (await listed())?.tools.length === 0) {
      if (w.name === "github") await setGithub(r, ADA, true)
      else await r.admin(`/_me/connections/${w.name}/token`, { token: "tok-ada" })

      await r.admin("/_workspace/connections/refresh", { name: w.name })
    }

    c = (await listed()) ?? fail(`the connection ${w.name} didn't stick`)

    const level = (who: string, to: string) =>
      r.admin("/_workspace/access", { connection: w.name, who, level: to })

    if (c.everyone !== w.everyone) await level("everyone", w.everyone)

    for (const [g, l] of Object.entries(w.groups))
      if (c.groups[g] !== l) await level(`group:${g}`, l)

    for (const g of Object.keys(c.groups))
      if (w.groups[g] === undefined) await level(`group:${g}`, "unset")

    for (const [p, l] of Object.entries(w.people))
      if (c.people[p] !== l) await level(`person:${p}`, l)

    for (const p of Object.keys(c.people))
      if (w.people[p] === undefined) await level(`person:${p}`, "unset")

    const tool = (name: string, change: string) =>
      r.admin("/_workspace/access/tool", { connection: w.name, tool: name, change })

    const has = new Set(c.tools.map((x) => x.name))

    for (const x of w.disabled) if (has.has(x) && !c.disabled.includes(x)) await tool(x, "disable")

    for (const x of c.disabled) if (!w.disabled.includes(x)) await tool(x, "enable")

    for (const x of w.markedRead) if (has.has(x) && !c.markedRead.includes(x)) await tool(x, "read")

    for (const x of c.markedRead) if (!w.markedRead.includes(x)) await tool(x, "unread")
  }

  return githubUrl
}

const WANTED_APIS = [
  { add: { provider: "petstore" }, groups: { eng: "all" } },
  { add: { provider: "pokeapi" }, groups: {} },
  { add: { provider: "countries" }, groups: {} },
  {
    add: {
      name: "github-api",
      kind: "openapi",
      spec: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
      credential: "person",
      everyone: "read",
      tags: ["repos", "users"],
    },
    groups: {},
  },
] as const

const seedApis = async (r: Run) => {
  const have = new Set(
    ConnectionList(await r.admin("/_workspace/connections")).connections.map((c) => c.name),
  )

  for (const { add, groups } of WANTED_APIS) {
    const name = "provider" in add ? add.provider : add.name

    if (have.has(name)) continue

    // A public API that's down (Petstore answers 502 at times) leaves it out, not the rest of the
    const answer = await r.admin("/_workspace/connections/add", add, [200, 400, 502, 504])

    const added = Option.isSome(
      Schema.decodeUnknownOption(
        Schema.Struct({ connection: Schema.Struct({ name: Schema.String }) }),
      )(answer),
    )

    const down = /couldn't fetch|answered HTTP 5\d\d|didn't answer/.test(JSON.stringify(answer))

    if (!added && !down)
      fail(`seed: adding ${name} was refused: ${JSON.stringify(answer).slice(0, 400)}`)

    if (!added) {
      say(`seed: left out ${name}: its API didn't answer (run bun run seed again to add it)`)
      continue
    }

    for (const [g, level] of Object.entries(groups))
      await r.admin("/_workspace/access", { connection: name, who: `group:${g}`, level })
  }
}

const deploy = async (r: Run, app: SeedApp, preview?: string) => {
  const apps = Apps(
    await send(`${r.target.url}/_apps`, { headers: asPerson(ADA, "Ada Lovelace") }).then((x) =>
      x.text(),
    ),
  )

  const by =
    apps.find((a) => a.app === app.app)?.owner ??
    PEOPLE.find((p) => p.email.startsWith(`${app.by}@`))?.email ??
    ADA

  const files = app.files.map((f) => ({ path: f.path, content: f.content }))
  const agent = await r.agent(by)

  const result =
    preview === undefined
      ? await agent.call("deploy_app", { app: app.app, files })
      : await agent.call("deploy_app", { app: app.app, files, preview })

  if (result.isError) fail(`deploying ${app.app}: ${result.text.slice(0, 400)}`)

  return Option.match(Warnings(result.structured), {
    onNone: () => [],
    onSome: (w) => w.warnings ?? [],
  })
}

const seedApps = async (r: Run) => {
  const warned: Array<string> = []

  for (const app of [MY_PRS, prDigest(true), REPO_QA, SHIP_IT, POKEDEX, PET_SHOP, ...PLAIN]) {
    warned.push(...(await deploy(r, app)).map((w) => `${app.app}: ${w}`))
  }

  await deploy(r, MY_PRS_REDESIGN, "redesign")

  return warned
}

const setGithub = async (r: Run, email: string, on: boolean) => {
  const token = await r.tokenOf(email)
  const { connections } = MyConnections(await call(r.target.url, "/_me/connections", token))
  const set = connections.find((c) => c.connection === "github")?.yourToken === "set"

  if (on && !set)
    await call(r.target.url, "/_me/connections/github/token", token, {
      token: githubToken(email),
    })
  else if (!on && set) await call(r.target.url, "/_me/connections/github/token/clear", token, {})
}

const setAllowed = async (r: Run, email: string, app: string, on: boolean) => {
  const { html } = await r.settingsPage(email, "connections", `?connect=github&app=${app}`)
  const allowed = html.includes(`data-consent="${app}/github"`)

  const tools = /action="\/_settings\/allow"[\s\S]*?name="tools:github" value="([^"]*)"/.exec(
    html,
  )?.[1]

  if (on && tools !== undefined)
    await r.settingsDo(email, "allow", { app, connection: "github", "tools:github": tools })
  else if (on && !allowed)
    fail(`${email} can't allow ${app}: their settings show no Allow (is their GitHub set?)`)
  else if (!on && allowed) await r.settingsDo(email, "revoke", { app, connection: "github" })
}

const setTokens = async (
  r: Run,
  email: string,
  wanted: ReadonlyArray<{ readonly label: string; readonly days?: number }>,
  labels: ReadonlyArray<string>,
) => {
  const theirs = TokenList(await r.admin("/_workspace/tokens")).tokens.filter(
    (k) => k.person.email === email,
  )

  for (const w of wanted)
    if (!theirs.some((k) => k.label === w.label))
      await r.settingsDo(email, "tokens/create", {
        label: w.label,
        days: w.days === undefined ? "" : String(w.days),
      })

  for (const k of theirs)
    if (labels.includes(k.label) && !wanted.some((w) => w.label === k.label))
      await r.settingsDo(email, "tokens/revoke", { id: k.id })
}

const seedPeopleState = async (r: Run) => {
  for (const p of PEOPLE.filter((x) => x.status === "active" && x.email !== r.me.email)) {
    await setGithub(r, p.email, p.github)

    for (const app of ["my-prs", "pr-digest"])
      await setAllowed(r, p.email, app, p.allowed.includes(app))

    await setTokens(
      r,
      p.email,
      p.tokens,
      p.tokens.map((k) => k.label),
    )
  }
}

const seedEvents = async (r: Run) => {
  const { calls } = Calls(await r.admin("/_workspace/activity", { limit: 50 }))

  if (calls.length >= 10) return calls.length

  const agentCall = async (email: string, tool: string, input: Json = {}) =>
    (await r.agent(email)).call("connection_call", { tool, input })

  await agentCall("alice@acme.test", "github.list_pull_requests", { state: "open" })
  await agentCall("alice@acme.test", "github.create_pull_request", { repo: "acme/web", title: "x" })
  await agentCall("alice@acme.test", "github.merge_pull_request", { repo: "acme/web", number: 412 })
  await agentCall("bob@acme.test", "github.create_pull_request", {
    repo: "acme/infra",
    title: "Pin the runner image",
  })
  await agentCall("carol@acme.test", "github.get_me")
  await agentCall("carol@acme.test", "deepwiki.read_wiki_structure", {
    repoName: "UsefulSoftwareCo/executor",
  })
  await agentCall("bob@acme.test", "deepwiki.read_wiki_structure", {
    repoName: "UsefulSoftwareCo/executor",
  })
  await (
    await r.agent("alice@acme.test")
  ).call("connection_call", {
    tool: "pokeapi.pokemon_retrieve",
    input: { id: "pikachu" },
    fields: ["name", "types.type.name"],
  })
  await agentCall("bob@acme.test", "countries.continent", {
    code: "EU",
    select: "name countries { name capital }",
  })
  await agentCall("carol@acme.test", "petstore.addPet", {
    body: { id: 4242, name: "Nope", photoUrls: [] },
  })

  const page = (email: string | null, tool: string, input: Json = {}) => {
    const origin = appOrigin(r.target.url, "my-prs")

    const headers = new Headers({
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
    })

    if (email !== null)
      for (const [k, v] of Object.entries(asPerson(email, r.nameOf(email)))) headers.set(k, v)

    return send(`${origin}/_tools/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool, input }),
    }).then((x) => x.text())
  }

  await page("alice@acme.test", "github.list_pull_requests", { state: "all" })
  await page("bob@acme.test", "github.list_pull_requests", { state: "all" })
  await page("carol@acme.test", "github.list_pull_requests", { state: "all" })
  await page(null, "github.list_pull_requests", { state: "all" })

  return Calls(await r.admin("/_workspace/activity", { limit: 50 })).calls.length
}

const uses = (groups: ReadonlyArray<string>, c: (typeof SCALE_CONNECTIONS)[number]) =>
  c.everyone !== "none" || groups.some((g) => (c.groups[g] ?? "none") !== "none")

const seedScale = async (r: Run) => {
  for (const p of SCALE_PEOPLE.filter((x) => x.tokens)) {
    const token = await r.tokenOf(p.email)
    const { connections } = MyConnections(await call(r.target.url, "/_me/connections", token))

    for (const c of SCALE_CONNECTIONS.filter(
      (x) => x.credential !== "workspace" && uses(p.groups, x),
    ))
      if (connections.find((v) => v.connection === c.name)?.yourToken !== "set")
        await call(r.target.url, `/_me/connections/${c.name}/token`, token, {
          token: `tok-${p.email.split("@")[0] ?? "x"}`,
        })
  }

  for (const [email, connection, level, off] of SCALE_OWN) {
    const token = await r.tokenOf(email)

    await call(r.target.url, `/_me/connections/${connection}/own`, token, { level })

    for (const tool of CATALOG.get(connection)?.map(([t]) => t) ?? [])
      await call(r.target.url, `/_me/connections/${connection}/own/tool`, token, {
        tool,
        on: !off.includes(tool),
      })
  }

  for (const [email, connection, note] of SCALE_ASKS)
    await call(
      r.target.url,
      `/_me/connections/${connection}/ask`,
      await r.tokenOf(email),
      { note },
      [200, 400],
    )

  const { calls } = Calls(await r.admin("/_workspace/activity", { limit: 100 }))
  const [first = ""] = SCALE_CALLS[0] ?? []

  if (!calls.some((c) => c.person === first))
    for (const [email, tool] of SCALE_CALLS)
      await (await r.agent(email)).call("connection_call", { tool, input: {} })

  return { asks: SCALE_ASKS.length, own: SCALE_OWN.length }
}

const seedOtherWorkspace = async (r: Run) => {
  await call(r.otherUrl, "/_admin/workspace-admins", r.target.admin, { email: ADA })

  const theirs = await r.mint(ADA, r.otherUrl)

  await call(r.otherUrl, "/_workspace/joining", theirs.token, { joining: "invite" })
  await call(r.otherUrl, "/_workspace/people/invite", theirs.token, {
    email: "alice@acme.test",
    name: "Alice Chen",
  })

  const { people } = PeopleList(await call(r.otherUrl, "/_workspace/people", theirs.token))

  return people.some((p) => p.email === r.me.email && p.status !== "removed")
}

const ScimStatus = Schema.decodeUnknownSync(
  Schema.Struct({
    tokens: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        revoked: Schema.NullOr(Schema.String),
      }),
    ),
  }),
)

const KeptScim = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String, id: Schema.String })),
)

const DIRECTORY_REQUESTS: ReadonlyArray<readonly [method: string, path: string, body?: Json]> = [
  ["GET", "/ServiceProviderConfig"],
  ["GET", `/Users?filter=${encodeURIComponent('userName eq "alice@acme.test"')}`],
  ["GET", `/Users?filter=${encodeURIComponent('userName eq "bob@acme.test"')}`],
  [
    "POST",
    "/Users",
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "frank", active: true },
  ],
  ["GET", `/Users?filter=${encodeURIComponent('userName eq "carol@acme.test"')}`],
]

const seedDirectory = async (r: Run) => {
  const file = join(r.target.dir, "scim.json")

  const kept = existsSync(file)
    ? Option.getOrUndefined(KeptScim(readFileSync(file, "utf8")))
    : undefined

  const live = ScimStatus(await r.admin("/_workspace/scim")).tokens.filter(
    (k) => k.revoked === null,
  )

  const okta = kept?.id ?? live.find((k) => k.label === "Okta")?.id

  for (const k of live) if (k.id !== okta) await r.admin("/_workspace/scim/revoke", { id: k.id })

  if (okta !== undefined && live.some((k) => k.id === okta)) return

  const made = Minted(await r.admin("/_workspace/scim/token", { label: "Okta" }))

  writeFileSync(file, JSON.stringify(made))

  for (const [method, path, body] of DIRECTORY_REQUESTS)
    await send(`${r.target.url}/scim/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${made.token}`, "content-type": "application/scim+json" },
      body: body === undefined ? null : JSON.stringify(body),
    }).then((x) => x.text())
}

type You = {
  readonly role: "admin" | "member"
  readonly groups: ReadonlyArray<Group>
  readonly github: boolean
  readonly allowed: boolean
  readonly tokens: boolean
}

type State = {
  readonly about: string
  readonly look: (b: Urls) => ReadonlyArray<readonly [url: string, what: string]>
  readonly you?: You
  readonly also?: (r: Run) => Promise<void>
}

type Urls = {
  readonly workspace: string
  readonly app: (name: string) => string
  readonly other: string
}

const ADMIN: You = { role: "admin", groups: ["eng"], github: true, allowed: true, tokens: true }

const CONNECTED: You = {
  role: "member",
  groups: ["eng"],
  github: true,
  allowed: true,
  tokens: true,
}

const STATES = {
  reset: {
    about:
      "the seeded default (bun run seed): you're an admin in eng, GitHub connected, my-prs allowed",
    you: ADMIN,
    look: (b) => [
      [
        `${b.workspace}/`,
        "the gallery: apps with pictures, Recently updated, the sidebar (folds with [); your menu at the foot",
      ],
      [`${b.app("my-prs")}/`, "your pull requests (made up, by the fake GitHub)"],
      [`${b.app("my-prs")}/_preview/redesign/`, "my-prs in the preview environment redesign"],
    ],
  },
  fresh: {
    about: "a member in no group: no GitHub token, no apps allowed, no tokens but the one you had",
    you: { role: "member", groups: [], github: false, allowed: false, tokens: false },
    look: (b) => [
      [`${b.app("my-prs")}/`, "Connect GitHub, and OpenBelt's sheet asking for your token"],
      [`${b.workspace}/_connections`, "GitHub without your token; no apps allowed"],
      [`${b.workspace}/_settings/agents`, "your one token; make another (shown once)"],
      [`${b.workspace}/_settings/events`, "admins only: a 403 naming which admins to ask"],
    ],
  },
  "needs-consent": {
    about: "a member in eng with a GitHub token, who hasn't allowed my-prs yet",
    you: { ...CONNECTED, allowed: false },
    look: (b) => [
      [`${b.app("my-prs")}/`, "OpenBelt's sheet: my-prs wants to use your GitHub"],
      [
        `${b.workspace}/_connections?connect=github&app=my-prs`,
        "exactly the tools it asks for, and Allow",
      ],
    ],
  },
  connected: {
    about: "a member in eng with a GitHub token who allowed my-prs: it lists your pull requests",
    you: CONNECTED,
    look: (b) => [
      [`${b.app("my-prs")}/`, "your pull requests; Ask DeepWiki runs as the workspace"],
      [`${b.workspace}/_connections`, "my-prs under the apps you allowed (Revoke)"],
      [`${b.workspace}/_settings/agents`, "your tokens, with labels and when each expires"],
    ],
  },
  contractor: {
    about: "a member in contractors, where GitHub is off; your token and consent stay",
    you: { ...CONNECTED, groups: ["contractors"] },
    look: (b) => [
      [`${b.app("my-prs")}/`, "GitHub is off for you here, naming the admins to ask"],
      [
        `${b.workspace}/_connections/github`,
        "GitHub: not given to you (contractors), with Ask for read only",
      ],
    ],
  },
  admin: {
    about:
      "a workspace admin (Settings has People, Groups and Events); nothing else is seeded again",
    you: ADMIN,
    look: (b) => [
      [
        `${b.workspace}/_settings/people`,
        "everyone, invite, roles; open Bob for his GitHub exception",
      ],
      [
        `${b.workspace}/_settings/groups`,
        "eng, contractors and support, what each can use in a line",
      ],
      [
        `${b.workspace}/_settings/groups/contractors`,
        "GitHub off for contractors, with Carol's result under it",
      ],
      [`${b.workspace}/_settings/groups/support`, "a group with nobody in it yet"],
      [
        `${b.workspace}/_settings/events`,
        "every agent's and app's call; open a refused one for why",
      ],
      [
        `${b.workspace}/_settings/events/requests`,
        "asks for more, grouped, each with the change that answers most",
      ],
      [
        `${b.workspace}/_settings/events?person=carol%40acme.test&tool=github.get_me`,
        "Carol's GitHub get_me calls, filtered by person and tool",
      ],
      [
        `${b.workspace}/_connections/github`,
        "who has access to GitHub: everyone, groups, exceptions",
      ],
      [`${b.workspace}/_connections`, "Linear's refresh failed: its token expired"],
      [`${b.app("ship-it")}/`, "merging is off: a disabled tool (its deploy warned)"],
    ],
  },
  "asks-again": {
    about: "you allowed pr-digest, then a deploy gave it one more GitHub tool: it asks again",
    you: CONNECTED,
    also: async (r) => {
      await setAllowed(r, r.me.email, "pr-digest", false)
      await deploy(r, prDigest(false))
      await setAllowed(r, r.me.email, "pr-digest", true)
      await deploy(r, prDigest(true))
    },
    look: (b) => [
      [`${b.app("pr-digest")}/`, "OpenBelt's sheet again: it asks for get_me too"],
      [`${b.workspace}/_connections?connect=github&app=pr-digest`, "the tools it asks for now"],
    ],
  },
  "invited-only-workspace": {
    about: `${OTHER_WORKSPACE}, another workspace: invite-only, and you aren't invited (acme stays as it was)`,
    look: (b) => [[`${b.other}/`, `not a member of ${OTHER_WORKSPACE}: which admin to ask (Ada)`]],
  },
} satisfies Readonly<Record<string, State>>

const printLook = (lines: ReadonlyArray<readonly [string, string]>, indent: string) => {
  const width = Math.min(70, Math.max(...lines.map(([url]) => url.length)))

  for (const [url, what] of lines) console.log(`${indent}${url.padEnd(width)}  ${what}`)
}

const setYou = async (r: Run, you: You) => {
  if (r.me.email === ADA && you.role !== "admin")
    fail(
      `you are ${ADA}, the seeded admin, and this state makes you a ${you.role}: seed as someone else`,
    )

  const found = (await r.people()).find((p) => p.email === r.me.email)

  if (found?.role !== you.role)
    await r.admin("/_workspace/people/role", { person: r.me.email, role: you.role })

  await seedGroups(
    r,
    you.groups.filter((g) => g !== "contractors"),
  )
  await setGithub(r, r.me.email, you.github)

  for (const app of ["my-prs", "pr-digest"])
    await setAllowed(r, r.me.email, app, you.github && you.allowed)

  await seedGroups(r, you.groups)
  await setTokens(
    r,
    r.me.email,
    you.tokens ? YOUR_TOKENS : [],
    YOUR_TOKENS.map((k) => k.label),
  )
}

const urlsOf = (t: Target): Urls => {
  const other = new URL(t.url)

  other.hostname = other.hostname.replace(/^[^.]+/, OTHER_WORKSPACE)

  return { workspace: t.url, app: (name) => appOrigin(t.url, name), other: other.origin }
}

const stateFile = (t: Target) => join(t.dir, "state.json")

const CurrentState = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ state: Schema.String })),
)

const currentState = (t: Target) =>
  existsSync(stateFile(t))
    ? Option.getOrUndefined(
        Option.map(CurrentState(readFileSync(stateFile(t), "utf8")), (s) => s.state),
      )
    : undefined

const printStates = (t: Target | undefined, urls: Urls | undefined) => {
  const now = t === undefined ? undefined : currentState(t)

  console.log("States (bun run qa <state>; seed first: bun run seed):")

  for (const [name, s] of Object.entries(STATES)) {
    console.log(`  ${name === now ? "*" : " "} ${name.padEnd(17)} ${s.about}`)

    if (urls !== undefined) printLook(s.look(urls), "      ")
  }
}

const seed = async (t: Target) => {
  const r = await run(t)

  try {
    say(`seed: ${t.url} as ${r.me.email}${t.via === undefined ? "" : ` (through ${t.via})`}`)
    await seedPeople(r)
    await seedGroups(r, ADMIN.groups)

    const githubUrl = await seedConnections(r)

    await seedApis(r)

    say(
      `seed: people, groups, connections (GitHub is fake, at ${githubUrl}; petstore, pokeapi, countries and github-api are real APIs)`,
    )

    const warned = await seedApps(r)

    await seedPeopleState(r)
    await setYou(r, ADMIN)

    const calls = await seedEvents(r)
    const scale = await seedScale(r)

    say(
      `seed: the workspace at scale: ${SCALE_PEOPLE.length} more people, ${SCALE_CONNECTIONS.length} more connections, ${scale.own} own choices, ${scale.asks} asks for more`,
    )

    await seedDirectory(r)

    const inOther = values["one-workspace"] === true ? false : await seedOtherWorkspace(r)
    const everyone = await r.people()
    const { connections } = ConnectionList(await r.admin("/_workspace/connections"))

    writeFileSync(stateFile(t), JSON.stringify({ state: "reset" }))

    say(
      `seed: ${everyone.length} people (${everyone.filter((p) => p.status === "invited").length} invited, ${everyone.filter((p) => p.status === "removed").length} removed), ${GROUPS.length} groups, ${connections.length} connections (${connections
        .filter((c) => c.problem !== null)
        .map((c) => `${c.name} broken`)
        .join(
          ", ",
        )}), ${3 + 1 + PLAIN.length} apps and my-prs in the preview redesign, ${calls} calls in Events`,
    )

    for (const w of warned) say(`seed: deploy warned, on purpose: ${w.slice(0, 160)}`)

    if (inOther)
      say(
        `seed: you're already a member of ${OTHER_WORKSPACE}, so invited-only-workspace won't show its page to you`,
      )

    const urls = urlsOf(t)

    const local =
      t.via === undefined ? undefined : `http://${r.workspace}.localhost:${new URL(t.via).port}/`

    say(
      `\nYou're in reset.${local === undefined ? "" : ` Signed out, on this machine: ${local}`}\n`,
    )

    if (values.quiet !== true) printStates(t, urls)
  } finally {
    await r.finish()
  }
}

const switchTo = async (t: Target, name: string) => {
  const state: State =
    Object.entries(STATES).find(([n]) => n === name)?.[1] ??
    fail(`there's no state "${name}": bun run qa lists them`)

  if (name === "reset") return seed(t)

  if (name === "invited-only-workspace" && values["one-workspace"] === true)
    fail(
      `${OTHER_WORKSPACE} is a second workspace, and this target has only its own (--one-workspace)`,
    )

  const r = await run(t)

  try {
    const ready = (await r.people()).some((p) => p.email === "alice@acme.test")

    if (!ready) fail("this OpenBelt isn't seeded: run bun run seed first")

    await seedConnections(r)

    if (state.you !== undefined) await setYou(r, state.you)

    await state.also?.(r)

    if (name === "invited-only-workspace") await seedOtherWorkspace(r)

    writeFileSync(stateFile(t), JSON.stringify({ state: name }))

    console.log(`You're in ${name}: ${state.about}.`)

    printLook(state.look(urlsOf(t)), "  ")

    console.log("Back: bun run qa reset")
  } finally {
    await r.finish()
  }
}

const t = TARGET

if (command === "seed" && t !== undefined) await seed(t)
else if (command === "stop" && t !== undefined) {
  const held = stopGithub(t.dir)

  console.log(
    held === undefined
      ? "seed: no fake GitHub of this seed's is running"
      : `seed: stopped the fake GitHub (${held.url}); GitHub calls fail until the next bun run seed`,
  )
} else if (command === "as") {
  if (stateName === undefined || t === undefined) printStates(t, undefined)
  else await switchTo(t, stateName)
} else
  fail(
    `usage: bun run seed [stop] [--run <dir> | --url <workspace url> --token <t> --admin-token <a>]; bun run qa [<state>]`,
  )
