import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { Option, Schema } from "effect"

const { values, positionals } = parseArgs({
  options: {
    run: { type: "string" },
    as: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    "admin-token": { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    label: { type: "string" },
    days: { type: "string" },
    workspace: { type: "boolean" },
    mine: { type: "boolean" },
    clear: { type: "boolean" },
    "from-env": { type: "string" },
    credential: { type: "string" },
    everyone: { type: "string" },
    "sign-in": { type: "string" },
    scopes: { type: "string" },
    scope: { type: "string" },
    "authorize-params": { type: "string" },
    "client-id": { type: "string" },
    provider: { type: "string" },
    kind: { type: "string" },
    spec: { type: "string" },
    auth: { type: "string" },
    tags: { type: "string" },
    connection: { type: "string" },
    tool: { type: "string" },
    outcome: { type: "string" },
    person: { type: "string" },
    limit: { type: "string" },
    with: { type: "string" },
    app: { type: "string" },
    json: { type: "boolean" },
  },
  allowPositionals: true,
})

const [noun = "", verb, ...args] = positionals

const USAGE = `usage: bun run workspace <command> (--run <dir> [--as <email>] | --url <workspace url> --token <token> | nothing: this checkout's bun run dev)
  whoami
  signin-link <email>   (OPENBELT_SIGNIN=email: a link that signs them in, once, within 15 minutes; --admin-token, or the launched instance's)
  people list | invite <email> [--name N] [--role admin|member] | remove <email|id> | role <email|id> <admin|member>
  groups list | create <name> | delete <name> | add <group> <email|id> | remove <group> <email|id>
  tokens list [--workspace] | create [--label L] [--days N] | revoke <id> [--workspace]
  joining [open|invite]
  rename <new name>   (the workspace's admins: its address changes; its old names keep reaching it)
  scim | scim token [--label L] | scim revoke <id>
  admins add <email>   (--admin-token, or the launched instance's)
  connections list [--mine] | show <name> | add <id> (from the catalog) | add <name> [<url>] --provider <id>
  connections add <name> <url> --credential none|workspace|person|both [--everyone none|read|all] [--sign-in oauth|token] [--scopes "a b"]
  connections add <name> [<base url>] --kind openapi|graphql --spec <url> --credential none|workspace|person|both [--auth bearer|basic|header:<n>|query:<n>] [--tags a,b|*]
  connections remove <name> | refresh <name> | token <name> --workspace|--mine [--from-env VAR] [--clear]   (token from stdin)
  connections connect <name> --workspace|--mine   (a server that signs in with OAuth: prints the link to open)
  connections renew <name> --workspace|--mine | client <name> --client-id ID [--from-env VAR]   (secret from stdin)
  connections icon <name> <image file> | icon <name> --clear   (PNG, JPEG, GIF, WebP or SVG, up to 64 KB)
  access <name> [everyone|group:<g>|person:<email> none|read|all|unset] | access <name> disable|enable|read|unread <tool>
  explain <email> <name>.<tool> [--with workspace|me | --app A]
  activity [--connection N | --tool T] [--person P] [--app A] [--outcome O] [--limit N] [--json]
    (agents' calls to OpenBelt's tools, and calls to connections' tools; --connection shows only those, --tool only OpenBelt's)
  secrets set <app> <NAME> [--from-env VAR]   (the value from stdin)`

const fail = (message: string): never => {
  console.error(`workspace: ${message}`)

  return process.exit(2)
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

const Dev = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ via: Schema.String, token: Schema.String, adminToken: Schema.String }),
  ),
)

const Minted = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
)

const target = async () => {
  if (values.run !== undefined) {
    const file = join(values.run, "instance.json")

    if (!existsSync(file))
      fail(`no ${file}: launch one with bun scripts/verify/launch.ts --run ${values.run}`)

    const instance = Option.getOrElse(Instance(readFileSync(file, "utf8")), () =>
      fail(`${file} isn't what scripts/verify/launch.ts writes`),
    )

    if (values.as === undefined)
      return { url: instance.url, token: instance.mcp.token, admin: instance.adminToken }

    const minted = await fetch(`${instance.url}/_admin/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${instance.adminToken}` },
      body: JSON.stringify({ email: values.as, days: 1, label: "bun run workspace --as" }),
    }).then((r) => r.text())

    const token = Option.getOrElse(Minted(minted), () =>
      fail(`no token for ${values.as}: ${minted}`),
    )

    return { url: instance.url, token: token.token, admin: instance.adminToken }
  }

  const url = values.url ?? (process.env.OPENBELT_MCP_URL ?? "").replace(/\/mcp$/, "")
  const token = values.token ?? process.env.OPENBELT_TOKEN ?? ""
  const devFile = join(import.meta.dir, "..", ".dev", "dev.json")

  // Nothing named: this checkout's bun run dev, at its port with no door in front (a sign-in link opened there signs in as whoever it names).
  if (url === "" && token === "" && existsSync(devFile)) {
    const dev = Option.getOrElse(Dev(readFileSync(devFile, "utf8")), () =>
      fail(`${devFile} isn't what bun run dev writes: start it again`),
    )

    return {
      url: `http://acme.localhost:${new URL(dev.via).port}`,
      token: dev.token,
      admin: values["admin-token"] ?? dev.adminToken,
    }
  }

  if (url === "" || (token === "" && noun !== "admins" && noun !== "signin-link"))
    fail(
      "which OpenBelt? --run <dir> (a launched instance), or --url <workspace url> --token <token>, or OPENBELT_MCP_URL and OPENBELT_TOKEN",
    )

  return { url: url.replace(/\/$/, ""), token, admin: values["admin-token"] ?? "" }
}

let resolved: ReturnType<typeof target> | undefined

const once = () => (resolved ??= target())

const Answer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

const Refusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ error: Schema.String, code: Schema.String, trace: Schema.String }),
  ),
)

type Body = Readonly<Record<string, Schema.Json>>

const request = async (path: string, body?: Body, bearer?: string, raw?: string) => {
  const { url, token } = await once()
  const sent = raw ?? (body === undefined ? undefined : JSON.stringify(body))

  const response = await fetch(`${url}${path}`, {
    method: sent === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${bearer ?? token}` },
    body: sent ?? null,
  }).catch((e: Error) => fail(`no answer from ${url} (${e.message})`))

  const text = await response.text()
  const answer = Option.getOrUndefined(Answer(text))

  if (!response.ok || answer === undefined) {
    const refusal = Option.getOrUndefined(Refusal(text))

    console.error(
      refusal === undefined
        ? `${response.status}: ${text.slice(0, 500)}`
        : `${response.status} ${refusal.code}: ${refusal.error} (trace ${refusal.trace})`,
    )
    process.exit(1)
  }

  return answer
}

const Person = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.String,
  status: Schema.String,
  groups: Schema.Array(Schema.String),
})

const People = Schema.decodeUnknownSync(
  Schema.Struct({ joining: Schema.String, people: Schema.Array(Person) }),
)

const Ref = Schema.Struct({ id: Schema.String, email: Schema.String })

const Groups = Schema.decodeUnknownSync(
  Schema.Struct({
    groups: Schema.Array(Schema.Struct({ name: Schema.String, members: Schema.Array(Ref) })),
  }),
)

const Scim = Schema.decodeUnknownSync(
  Schema.Struct({
    tokens: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        created: Schema.String,
        madeBy: Schema.String,
        lastUsed: Schema.NullOr(Schema.String),
        revoked: Schema.NullOr(Schema.String),
      }),
    ),
    recent: Schema.Array(
      Schema.Struct({
        at: Schema.String,
        method: Schema.String,
        path: Schema.String,
        status: Schema.Number,
        note: Schema.String,
        trace: Schema.String,
      }),
    ),
  }),
)

const Tokens = Schema.decodeUnknownSync(
  Schema.Struct({
    tokens: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        person: Ref,
        label: Schema.String,
        created: Schema.String,
        expires: Schema.NullOr(Schema.String),
      }),
    ),
  }),
)

const Connection = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  credential: Schema.String,
  workspaceToken: Schema.String,
  peopleWithTokens: Schema.Number,
  everyone: Schema.String,
  groups: Schema.Record(Schema.String, Schema.String),
  people: Schema.Record(Schema.String, Schema.String),
  disabled: Schema.Array(Schema.String),
  markedRead: Schema.Array(Schema.String),
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.String, readOnly: Schema.Boolean }),
  ),
  signIn: Schema.optional(
    Schema.Union([
      Schema.Literal("token"),
      Schema.Struct({
        oauth: Schema.Struct({
          issuer: Schema.String,
          registered: Schema.Array(Schema.String),
          scopes: Schema.Array(Schema.String),
          params: Schema.Array(Schema.String),
          noRefreshToken: Schema.Array(Schema.String),
          reconnect: Schema.Array(Schema.Struct({ who: Schema.String, why: Schema.String })),
        }),
      }),
    ]),
  ),
  refreshed: Schema.NullOr(Schema.String),
  problem: Schema.NullOr(Schema.String),
  api: Schema.optional(
    Schema.Struct({
      kind: Schema.String,
      spec: Schema.String,
      auth: Schema.String,
      tags: Schema.Array(Schema.String),
      toolTags: Schema.Record(Schema.String, Schema.Number),
    }),
  ),
})

const Described = Schema.decodeUnknownSync(Schema.Struct({ connections: Schema.Array(Connection) }))

const Shown = Schema.decodeUnknownSync(Schema.Struct({ connection: Connection }))

const Added = Schema.decodeUnknownSync(
  Schema.Struct({
    connection: Connection,
    listed: Schema.Struct({
      refreshed: Schema.Boolean,
      tools: Schema.optional(Schema.Number),
      held: Schema.optional(Schema.Array(Schema.String)),
      problem: Schema.optional(Schema.String),
      waiting: Schema.optional(Schema.String),
    }),
    tested: Schema.optional(
      Schema.Struct({ tool: Schema.String, ok: Schema.Boolean, said: Schema.String }),
    ),
  }),
)

const Started = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, for: Schema.String, note: Schema.String }),
)

const Views = Schema.decodeUnknownSync(
  Schema.Struct({
    connections: Schema.Array(
      Schema.Struct({
        connection: Schema.String,
        level: Schema.String,
        levelFrom: Schema.String,
        runsAs: Schema.String,
        setYourToken: Schema.optional(Schema.String),
        tools: Schema.Array(Schema.Struct({ usable: Schema.Boolean })),
      }),
    ),
  }),
)

const Explained = Schema.decodeUnknownSync(
  Schema.Struct({
    allowed: Schema.Boolean,
    runsAs: Schema.optional(Schema.String),
    setting: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    steps: Schema.Array(Schema.String),
  }),
)

const Activity = Schema.decodeUnknownSync(
  Schema.Struct({
    calls: Schema.Array(
      Schema.Struct({
        at: Schema.String,
        trace: Schema.String,
        person: Schema.String,
        runs_as: Schema.String,
        connection: Schema.String,
        tool: Schema.String,
        outcome: Schema.String,
        ms: Schema.Number,
        why: Schema.String,
        app: Schema.String,
      }),
    ),
    tools: Schema.Array(
      Schema.Struct({
        at: Schema.String,
        trace: Schema.String,
        person: Schema.String,
        client: Schema.String,
        tool: Schema.String,
        app: Schema.String,
        args: Schema.String,
        outcome: Schema.String,
        ms: Schema.Number,
        error: Schema.String,
      }),
    ),
  }),
)

const printConnection = (c: typeof Connection.Type) => {
  const levels = [
    `everyone ${c.everyone}`,
    ...Object.entries(c.groups).map(([g, l]) => `group:${g} ${l}`),
    ...Object.entries(c.people).map(([p, l]) => `person:${p} ${l}`),
  ]

  console.log(`${c.name}  ${c.url}`)
  console.log(
    `credential: ${c.credential}; workspace token ${c.workspaceToken}; ${c.peopleWithTokens} people have their own`,
  )
  console.log(`levels: ${levels.join(", ")}`)

  if (c.api !== undefined) {
    const tags = Object.entries(c.api.toolTags).map(([t, n]) => `${t} ${n}`)

    console.log(
      `${c.api.kind} API, spec ${c.api.spec}; token as ${c.api.auth}; tags picked: ${c.api.tags.join(", ")}`,
    )
    console.log(
      `${c.tools.length} tools: ${tags.slice(0, 20).join(", ")}${tags.length > 20 ? ", ..." : ""}`,
    )
  }

  if (c.signIn !== undefined && c.signIn !== "token") {
    const { issuer, registered, reconnect, scopes, params, noRefreshToken } = c.signIn.oauth

    console.log(
      `signs in with OAuth at ${issuer}; OpenBelt is registered ${registered.length === 0 ? "nowhere yet" : registered.join(", ")}`,
    )
    console.log(
      `asks for: ${scopes.join(" ") || "(no scope)"}${params.length === 0 ? "" : `; authorize params: ${params.join(" ")}`}`,
    )

    for (const who of noRefreshToken)
      console.log(`no refresh token: ${who} (connects again when the access token expires)`)

    for (const r of reconnect) console.log(`needs connecting again: ${r.who} (${r.why})`)
  }

  console.log(
    `refreshed ${c.refreshed?.slice(0, 16) ?? "never"}${c.problem === null ? "" : `; last refresh failed: ${c.problem}`}`,
  )
  table(
    c.tools.map((t) => [
      t.name,
      c.disabled.includes(t.name)
        ? "disabled"
        : t.readOnly
          ? "read (read-only)"
          : c.markedRead.includes(t.name)
            ? "read (marked)"
            : "all",
      t.description.slice(0, 90),
    ]),
  )
}

const MAX_ROWS = 50

const table = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const shown = rows.slice(0, MAX_ROWS)
  const widths = (shown[0] ?? []).map((_, i) => Math.max(...shown.map((r) => (r[i] ?? "").length)))

  for (const row of shown)
    console.log(
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )

  if (rows.length > MAX_ROWS) console.log(`... and ${rows.length - MAX_ROWS} more`)
}

const day = (iso: string | null) => (iso === null ? "never" : iso.slice(0, 10))

const need = (value: string | undefined, what: string) =>
  value === undefined || value === "" ? fail(`${what}\n${USAGE}`) : value

const show = (answer: Body) => console.log(JSON.stringify(answer, null, 2).slice(0, 4000))

type Invite = { email: string; name?: string; role?: string }

type NewToken = { label?: string; days?: number }

type NewConnection = {
  provider?: string
  name?: string
  url?: string
  credential?: string
  everyone?: string
  signIn?: string
  scopes?: string
  authorizeParams?: string
  kind?: string
  spec?: string
  auth?: string
  tags?: ReadonlyArray<string>
}

type ActivityFilter = {
  connection?: string
  tool?: string
  person?: string
  app?: string
  outcome?: string
  limit?: number
}

type Explain = { person: string; tool: string; as?: string; app?: string }

const explaining = () => {
  const asked: Explain = {
    person: need(verb, "explain for whom? an email"),
    tool: need(args[0], "which tool? <connection>.<tool>"),
  }

  if (values.with !== undefined) asked.as = values.with

  if (values.app !== undefined) asked.app = values.app

  return asked
}

const commands = {
  whoami: async () => show(await request("/_me/whoami")),

  "people list": async () => {
    const { joining, people } = People(await request("/_workspace/people"))

    console.log(`joining: ${joining}; ${people.length} people`)
    table(people.map((p) => [p.email, p.role, p.status, p.groups.join(",") || "-", p.id]))
  },
  "people invite": async () => {
    const invite: Invite = {
      email: need(args[0], "invite whom? an email"),
    }

    if (values.name !== undefined) invite.name = values.name

    if (values.role !== undefined) invite.role = values.role

    show(await request("/_workspace/people/invite", invite))
  },
  "people remove": async () =>
    show(await request("/_workspace/people/remove", { person: need(args[0], "remove whom?") })),
  "people role": async () =>
    show(
      await request("/_workspace/people/role", {
        person: need(args[0], "whose role?"),
        role: need(args[1], "which role? admin or member"),
      }),
    ),

  "groups list": async () => {
    const { groups } = Groups(await request("/_workspace/groups"))

    console.log(`${groups.length} groups`)
    table(
      groups.map((g) => [
        g.name,
        `${g.members.length} members`,
        g.members
          .map((m) => m.email)
          .join(", ")
          .slice(0, 200),
      ]),
    )
  },
  "groups create": async () =>
    show(await request("/_workspace/groups/create", { name: need(args[0], "which group?") })),
  "groups delete": async () =>
    show(await request("/_workspace/groups/delete", { name: need(args[0], "which group?") })),
  "groups add": async () =>
    show(
      await request("/_workspace/groups/add", {
        group: need(args[0], "which group?"),
        person: need(args[1], "add whom?"),
      }),
    ),
  "groups remove": async () =>
    show(
      await request("/_workspace/groups/remove", {
        group: need(args[0], "which group?"),
        person: need(args[1], "take whom out?"),
      }),
    ),

  "tokens list": async () => {
    const { tokens } = Tokens(
      await request(values.workspace === true ? "/_workspace/tokens" : "/_me/tokens"),
    )

    console.log(`${tokens.length} tokens`)
    table(
      tokens.map((t) => [
        t.id,
        t.person.email,
        t.label || "-",
        `made ${day(t.created)}`,
        `expires ${day(t.expires)}`,
      ]),
    )
  },
  scim: async () => {
    const { tokens, recent } = Scim(await request("/_workspace/scim"))

    console.log(`${tokens.length} SCIM tokens`)
    table(
      tokens.map((t) => [
        t.id,
        t.label || "-",
        t.revoked === null ? "works" : `revoked ${day(t.revoked)}`,
        `made ${day(t.created)} by ${t.madeBy}`,
        `last used ${t.lastUsed === null ? "never" : t.lastUsed.slice(0, 19)}`,
      ]),
    )
    console.log(`${recent.length} recent requests, newest first`)
    table(
      recent.map((r) => [
        r.at.slice(0, 19),
        `${r.method} ${r.path}`,
        String(r.status),
        r.note.slice(0, 90),
        r.trace,
      ]),
    )
  },
  "scim token": async () => {
    show(
      await request(
        "/_workspace/scim/token",
        values.label === undefined ? {} : { label: values.label },
      ),
    )
  },
  "scim revoke": async () =>
    show(
      await request("/_workspace/scim/revoke", {
        id: need(args[0], "which SCIM token? its id, from scim"),
      }),
    ),

  "tokens create": async () => {
    const made: NewToken = {}

    if (values.label !== undefined) made.label = values.label

    if (values.days !== undefined) made.days = Number(values.days)

    show(await request("/_me/tokens/create", made))
  },
  "tokens revoke": async () =>
    show(
      await request(
        values.workspace === true ? "/_workspace/tokens/revoke" : "/_me/tokens/revoke",
        {
          id: need(args[0], "which token? its id, from tokens list"),
        },
      ),
    ),

  rename: async () =>
    show(
      await request("/_workspace/rename", {
        to: need(verb, "rename to what? a name like acme-labs"),
      }),
    ),

  joining: async () =>
    show(
      verb === undefined
        ? await request("/_workspace/joining")
        : await request("/_workspace/joining", { joining: verb }),
    ),

  "signin-link": async () => {
    const { admin } = await once()

    show(
      await request(
        "/_admin/signin-links",
        { email: need(verb, "a link for whom? bun run workspace signin-link <email>") },
        need(admin, "signin-link needs the platform's --admin-token (OPENBELT_ADMIN_TOKEN)"),
      ),
    )
  },

  "admins add": async () => {
    const { admin } = await once()

    show(
      await request(
        "/_admin/workspace-admins",
        { email: need(args[0], "make whom an admin?") },
        need(admin, "admins add needs the platform's --admin-token (OPENBELT_ADMIN_TOKEN)"),
      ),
    )
  },

  "connections list": async () => {
    if (values.mine === true) {
      const { connections } = Views(await request("/_me/connections"))

      console.log(`${connections.length} connections, as you see them`)

      for (const c of connections) {
        const usable = c.tools.filter((t) => t.usable).length

        console.log(
          `${c.connection}  level ${c.level} (from ${c.levelFrom}), ${usable} of ${c.tools.length} tools usable; runs as: ${c.runsAs.slice(0, 160)}`,
        )

        if (c.setYourToken !== undefined) console.log(`  set your token: ${c.setYourToken}`)
      }

      return
    }

    const { connections } = Described(await request("/_workspace/connections"))

    console.log(`${connections.length} connections`)
    table(
      connections.map((c) => [
        c.name,
        c.credential,
        `workspace token ${c.workspaceToken}`,
        `${c.peopleWithTokens} personal`,
        `everyone ${c.everyone}`,
        `${c.tools.length} tools`,
        c.problem === null ? "ok" : `refresh failed: ${c.problem.slice(0, 80)}`,
      ]),
    )
  },
  "connections show": async () => {
    const answer = await request(`/_workspace/connections/${need(args[0], "which connection?")}`)

    if (values.json === true) return console.log(JSON.stringify(answer, null, 2))

    printConnection(Shown(answer).connection)
  },
  "connections add": async () => {
    const name = need(args[0], "add which? a catalog id, like linear, or a name and URL")
    const url = args[1]

    const api: NewConnection | undefined =
      values.kind === undefined
        ? undefined
        : {
            name,
            kind: values.kind,
            credential: need(
              values.credential,
              "whose credential? --credential none|workspace|person|both",
            ),
          }

    if (api !== undefined) {
      if (url !== undefined) api.url = url

      if (values.spec !== undefined) api.spec = values.spec

      if (values.auth !== undefined) api.auth = values.auth

      if (values.tags !== undefined) api.tags = values.tags.split(",").map((t) => t.trim())

      if (values.everyone !== undefined) api.everyone = values.everyone

      const started = Date.now()
      const answer = Added(await request("/_workspace/connections/add", api))

      printConnection(answer.connection)
      console.log(
        answer.listed.refreshed
          ? `listed ${answer.listed.tools ?? 0} tools in ${Date.now() - started}ms${(answer.listed.held ?? []).length === 0 ? "" : `; held off until an admin turns them on: ${(answer.listed.held ?? []).join(", ")}`}`
          : `couldn't list its tools yet: ${answer.listed.problem ?? ""}`,
      )

      return
    }

    const added: NewConnection =
      values.provider !== undefined
        ? { provider: values.provider, name }
        : url === undefined
          ? { provider: name }
          : {
              name,
              url,
              credential: need(
                values.credential,
                "whose credential? --credential none|workspace|person|both (or --provider <id> for the catalog's)",
              ),
            }

    if (url !== undefined) added.url = url

    if (values.credential !== undefined) added.credential = values.credential

    if (values.everyone !== undefined) added.everyone = values.everyone

    if (values["sign-in"] !== undefined) added.signIn = values["sign-in"]

    if (values.scopes !== undefined) added.scopes = values.scopes

    if (values["authorize-params"] !== undefined) added.authorizeParams = values["authorize-params"]

    if (values.spec !== undefined) added.spec = values.spec

    const answer = Added(await request("/_workspace/connections/add", added))

    printConnection(answer.connection)
    console.log(
      answer.listed.refreshed
        ? `listed ${answer.listed.tools ?? 0} tools`
        : (answer.listed.waiting ?? `couldn't list its tools yet: ${answer.listed.problem ?? ""}`),
    )

    if (answer.tested !== undefined)
      console.log(
        `test call ${answer.tested.tool}: ${answer.tested.ok ? "ok" : "FAILED"}: ${answer.tested.said}`,
      )
  },
  "connections client": async () => {
    const name = need(args[0], "whose app? a connection's name")

    const clientId = need(
      values["client-id"],
      "--client-id: the id the provider gave OpenBelt's app",
    )

    const fromEnv = values["from-env"]

    const secret =
      fromEnv !== undefined
        ? (process.env[fromEnv] ??
          fail(`--from-env ${fromEnv}: there's no ${fromEnv} in the environment`))
        : process.stdin.isTTY
          ? ""
          : await Bun.stdin.text()

    show(
      await request(
        `/_workspace/connections/${name}/client`,
        secret.trim() === "" ? { clientId } : { clientId, secret: secret.trim() },
      ),
    )
  },
  "connections icon": async () => {
    const name = need(args[0], "whose icon? a connection's name")

    if (values.clear === true) {
      show(await request(`/_workspace/connections/${name}/icon/clear`, {}))

      return
    }

    const path = need(args[1], "the image: a PNG, JPEG, GIF, WebP or SVG file, up to 64 KB")
    const file = Bun.file(path)

    if (!(await file.exists())) fail(`${path}: there's no such file`)

    show(
      await request(`/_workspace/connections/${name}/icon`, {
        type: file.type.split(";")[0] ?? "",
        base64: new Uint8Array(await file.arrayBuffer()).toBase64(),
      }),
    )
  },
  "connections renew": async () => {
    const name = need(args[0], "renew which? a connection's name")

    if ((values.workspace === true) === (values.mine === true))
      fail("say whose: --workspace (the workspace's, for admins) or --mine (your own)")

    show(
      await request(
        `/${values.workspace === true ? "_workspace" : "_me"}/connections/${name}/signin/refresh`,
        {},
      ),
    )
  },
  "connections connect": async () => {
    const name = need(args[0], "connect which? a connection's name")

    if ((values.workspace === true) === (values.mine === true))
      fail("say whose: --workspace (the workspace's, for admins) or --mine (your own)")

    const started = Started(
      await request(
        `/${values.workspace === true ? "_workspace" : "_me"}/connections/${name}/connect`,
        values.scope === undefined ? {} : { scope: values.scope },
      ),
    )

    console.log(`${started.note}\n\n${started.url}`)
  },
  "connections remove": async () =>
    show(await request("/_workspace/connections/remove", { name: need(args[0], "remove which?") })),
  "connections refresh": async () => {
    const answer = Added(
      await request("/_workspace/connections/refresh", { name: need(args[0], "refresh which?") }),
    )

    const held = answer.listed.held ?? []

    console.log(
      answer.listed.refreshed
        ? `listed ${answer.listed.tools ?? 0} tools`
        : `refresh failed, the last list is kept: ${answer.listed.problem ?? ""}`,
    )

    if (held.length > 0)
      console.log(
        `new since the last list, off until you turn each on: ${held.join(", ")} (bun run workspace access ${answer.connection.name} enable <tool>)`,
      )
  },
  "secrets set": async () => {
    const app = need(args[0], "whose secret? an app's name")

    const name = need(
      args[1],
      'which secret? its name, as the app\'s openbelt.json "secrets" declares it',
    )

    if (args.length > 2)
      fail(
        "a secret is never a command-line argument (it would land in your shell's history): pipe it in on stdin, or pass --from-env VAR",
      )

    const fromEnv = values["from-env"]

    const value =
      fromEnv === undefined
        ? process.stdin.isTTY
          ? fail(
              "the value comes from stdin or --from-env VAR, never an argument: pipe it in (pbpaste | bun run workspace secrets set ...), or set a variable and pass --from-env",
            )
          : await Bun.stdin.text()
        : (process.env[fromEnv] ??
          fail(`--from-env ${fromEnv}: there's no ${fromEnv} in the environment`))

    if (value.trim() === "") fail("no value: stdin was empty")

    show(
      await request(
        `/_me/apps/${encodeURIComponent(app)}/secrets/${encodeURIComponent(name)}`,
        undefined,
        undefined,
        value.trim(),
      ),
    )
  },

  "connections token": async () => {
    const name = need(args[0], "whose token? a connection's name")

    if (args.length > 1)
      fail(
        "a token is never a command-line argument (it would land in your shell's history): pipe it in on stdin, or pass --from-env VAR",
      )

    if ((values.workspace === true) === (values.mine === true))
      fail("say whose: --workspace (the workspace's, for admins) or --mine (your own)")

    const path = `/${values.workspace === true ? "_workspace" : "_me"}/connections/${name}/token`

    if (values.clear === true) return show(await request(`${path}/clear`, {}))

    const fromEnv = values["from-env"]

    const token =
      fromEnv === undefined
        ? process.stdin.isTTY
          ? fail(
              "the token comes from stdin or --from-env VAR, never an argument: pipe it in (pbpaste | bun run workspace connections token ...), or set a variable and pass --from-env",
            )
          : await Bun.stdin.text()
        : (process.env[fromEnv] ??
          fail(`--from-env ${fromEnv}: there's no ${fromEnv} in the environment`))

    if (token.trim() === "")
      fail(
        "no token: stdin was empty. Pipe it in (pbpaste | bun run workspace connections token ...), or pass --from-env VAR",
      )

    show(await request(path, undefined, undefined, token.trim()))
  },

  access: async () => {
    const name = need(verb, "which connection?")
    const [what, value] = args

    if (what === undefined) {
      const { connection } = Shown(await request(`/_workspace/connections/${name}`))

      return printConnection(connection)
    }

    const answer =
      what === "disable" || what === "enable" || what === "read" || what === "unread"
        ? await request("/_workspace/access/tool", {
            connection: name,
            tool: need(value, `${what} which tool?`),
            change: what,
          })
        : await request("/_workspace/access", {
            connection: name,
            who: what,
            level: need(value, "which level? none, read, all or unset"),
          })

    printConnection(Shown(answer).connection)
  },

  explain: async () => {
    const answer = Explained(await request("/_workspace/explain", explaining()))

    for (const step of answer.steps) console.log(`- ${step}`)

    console.log(
      answer.allowed
        ? `allowed: runs as ${answer.runsAs ?? ""}`
        : `refused by ${answer.setting ?? ""}: ${answer.message ?? ""}`,
    )
  },

  activity: async () => {
    const asked: ActivityFilter = {}

    if (values.connection !== undefined) asked.connection = values.connection

    if (values.person !== undefined) asked.person = values.person

    if (values.app !== undefined) asked.app = values.app

    if (values.tool !== undefined) asked.tool = values.tool

    if (values.outcome !== undefined) asked.outcome = values.outcome

    if (values.limit !== undefined) asked.limit = Number(values.limit)

    const answer = await request("/_workspace/activity", asked)

    if (values.json === true) return console.log(JSON.stringify(answer, null, 2))

    const { calls, tools } = Activity(answer)

    if (values.connection === undefined) {
      console.log(`${tools.length} calls to OpenBelt's tools, newest first`)
      table(
        tools.map((c) => [
          c.at.slice(0, 19),
          c.person,
          c.client === "" ? "-" : c.client,
          c.tool,
          c.outcome,
          `${c.ms}ms`,
          c.trace,
          c.args.slice(0, 80),
          c.error.slice(0, 80),
        ]),
      )
    }

    if (values.tool !== undefined) return

    console.log(`${calls.length} calls to connections, newest first`)
    table(
      calls.map((c) => [
        c.at.slice(0, 19),
        c.person,
        `as ${c.runs_as}`,
        `${c.connection}.${c.tool}`,
        c.outcome,
        `${c.ms}ms`,
        c.trace,
        c.app === "" ? "agent" : `app ${c.app}`,
        c.why.slice(0, 80),
      ]),
    )
  },
}

const named =
  noun === "scim"
    ? `scim${verb === undefined ? "" : ` ${verb}`}`
    : ["whoami", "joining", "rename", "access", "explain", "activity", "signin-link"].includes(noun)
      ? noun
      : `${noun} ${verb ?? ""}`

const command = Object.entries(commands).find(([name]) => name === named)?.[1]

if (command === undefined) {
  console.error(USAGE)
  process.exit(2)
}

await command()
