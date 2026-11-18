import { connectionLabel, toolLabel } from "./home.ts"
import type { ConnectLink, CredentialOwner, Level, RunsAs, ToolBinding } from "./model.ts"
import { connectUrl } from "./signins/context.ts"

export const RANK: Readonly<Record<Level, number>> = { none: 0, read: 1, all: 2 }

export const lower = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b)

const BELONGS: Readonly<Record<CredentialOwner, string>> = {
  none: "nobody",
  workspace: "the workspace",
  person: "each person",
  both: "the workspace or each person",
}

export type Layer = "call" | "workspace" | "own"

export type Step = { readonly layer: Layer; readonly text: string; readonly said: string }

export type Own = {
  readonly level: "read" | "none" | undefined
  readonly off: ReadonlySet<string>
}

export const NO_OWN: Own = { level: undefined, off: new Set() }

export type Policy = {
  readonly everyone: Level
  readonly groups: ReadonlyMap<string, Level>
  readonly people: ReadonlyMap<string, Level>
  readonly disabled: ReadonlySet<string>
  readonly read: ReadonlySet<string>
}

export type Facts = {
  readonly connection: string
  readonly credential: CredentialOwner
  readonly policy: Policy
  readonly tools: ReadonlyMap<string, boolean>
  readonly workspaceToken: boolean
  readonly signIn: {
    readonly kind: "token" | "oauth"
    readonly workspaceBroken: string | undefined
    readonly ownBroken: string | undefined
  }
  readonly person: {
    readonly id: string
    readonly email: string
    readonly name: string
    readonly groups: ReadonlyArray<string>
    readonly removed: boolean
    readonly ownToken: boolean
    readonly admin: boolean
    readonly own: Own
  }
  readonly admins: ReadonlyArray<string>
  readonly origin: string
}

export type Setting =
  | "removed"
  | "tool"
  | "disabled"
  | "level"
  | "own"
  | "credential"
  | "as"
  | "binding"
  | "signed_out"
  | "test_person"
  | "token"
  | "consent"

export type Decision =
  | {
      readonly allowed: true
      readonly runsAs: RunsAs
      readonly steps: ReadonlyArray<Step>
    }
  | {
      readonly allowed: false
      readonly setting: Setting
      readonly message: string
      readonly connect?: ConnectLink
      readonly steps: ReadonlyArray<Step>
    }

const stepLines = (steps: ReadonlyArray<Step>) => steps.map((s) => `${s.layer}: ${s.text}`)

export const shownDecision = (decision: Decision) =>
  decision.allowed
    ? { allowed: true, runsAs: decision.runsAs, steps: stepLines(decision.steps) }
    : {
        allowed: false,
        setting: decision.setting,
        message: decision.message,
        steps: stepLines(decision.steps),
      }

export const takesWorkspace = (credential: CredentialOwner) =>
  credential === "workspace" || credential === "both"

export const takesMine = (credential: CredentialOwner) =>
  credential === "person" || credential === "both"

export const askAdmins = (facts: Facts, what: string, command: string) => {
  const { admins } = facts

  if (facts.person.admin)
    return `You're one of the workspace's admins, so you can ${what}: ${command}`

  return admins.length === 0
    ? `The workspace has no admins yet to ${what}: whoever runs this OpenBelt names one (POST /_admin/workspace-admins).`
    : `Ask ${admins.join(" or ")} (${admins.length === 1 ? "the workspace's admin" : "the workspace's admins"}) to ${what}.`
}

export const connectLink = (origin: string, connection: string) =>
  connectUrl(origin, connection, "mine")

export const setTokenHint = (connection: string, origin: string, kind: "token" | "oauth") =>
  kind === "oauth"
    ? `Connect yours: open ${connectLink(origin, connection)} and sign in to ${connectionLabel(connection)} there (an agent sends its person this link; nobody pastes a token).`
    : `In a terminal (never paste a token into a chat with an agent): bun run workspace connections token ${connection} --mine, which reads it from stdin; or curl -X POST ${origin}/_me/connections/${connection}/token -H "Authorization: Bearer $OPENBELT_TOKEN" --data-binary @- , then paste the token and press Ctrl-D.`

export const levelOf = (
  policy: Policy,
  person: Pick<Facts["person"], "id" | "email" | "groups">,
) => {
  const own = policy.people.get(person.id)

  if (own !== undefined) return { level: own, from: `person:${person.email}` }

  const set = person.groups.flatMap((g) => {
    const level = policy.groups.get(g)

    return level === undefined ? [] : [{ group: g, level }]
  })

  if (set.length === 0) return { level: policy.everyone, from: "everyone" }

  const lowest = set.reduce((low, g) => (RANK[g.level] < RANK[low.level] ? g : low))

  return { level: lowest.level, from: `group:${lowest.group}` }
}

const levelSaid = (
  policy: Policy,
  person: Pick<Facts["person"], "id" | "groups">,
  from: string,
) => {
  if (from.startsWith("person:")) return "an exception set for them"

  if (from === "everyone")
    return person.groups.length === 0
      ? "everyone's level (they're in no group)"
      : "everyone's level (no group of theirs has one)"

  const set = person.groups.flatMap((g) => {
    const level = policy.groups.get(g)

    return level === undefined ? [] : [`${g} ${level}`]
  })

  return `the ${from.slice("group:".length)} group${set.length > 1 ? ` (the lowest of ${set.join(", ")})` : ""}`
}

export const isRead = (facts: Pick<Facts, "tools" | "policy">, tool: string) =>
  facts.tools.get(tool) === true || facts.policy.read.has(tool)

const ownPage = (facts: Facts) => `${facts.origin}/_connections/${facts.connection}`

const whoSaid = (facts: Facts) => facts.person.name.trim().split(/\s+/)[0] || facts.person.email

const fromSaid = (from: string) =>
  from.startsWith("person:")
    ? "from an exception set for them"
    : from === "everyone"
      ? "from everyone"
      : `from the ${from.slice("group:".length)} group`

const accountSaid = (facts: Facts) => (facts.signIn.kind === "oauth" ? "sign-in" : "token")

export const judgeTool = (facts: Facts, tool: string): Decision => {
  const name = `${facts.connection}.${tool}`
  const steps: Array<Step> = []
  const workspace = (text: string, said: string) => steps.push({ layer: "workspace", text, said })
  const who = whoSaid(facts)
  const label = connectionLabel(facts.connection)
  const called = toolLabel(tool)

  const refuse = (
    setting: Setting,
    message: string,
    said: string,
    layer: Layer = "workspace",
  ): Decision => {
    steps.push({ layer, text: `refused (${setting}): ${message}`, said })

    return { allowed: false, setting, message, steps }
  }

  if (facts.person.removed) {
    return refuse(
      "removed",
      `${facts.person.email} was removed from the workspace, so they can't use any tool. ${askAdmins(facts, "invite them again", `bun run workspace people invite ${facts.person.email}`)}`,
      `${who} was removed from the workspace`,
    )
  }

  if (!facts.tools.has(tool)) {
    const known = [...facts.tools.keys()].toSorted()

    const empty =
      facts.signIn.kind === "oauth"
        ? `its tools are listed once someone connects it, and nobody has yet. ${takesMine(facts.credential) ? setTokenHint(facts.connection, facts.origin, "oauth") : askAdmins(facts, "connect it for the workspace", `open ${connectUrl(facts.origin, facts.connection, "workspace")}`)}`
        : `its tool list is empty. ${askAdmins(facts, "refresh it", `bun run workspace connections refresh ${facts.connection}`)}`

    const message = `${facts.connection} has no tool "${tool}"${known.length === 0 ? ` (${empty})` : `: it has ${known.slice(0, 30).join(", ")}${known.length > 30 ? ", ..." : ""}`}`

    if (known.length === 0 && facts.signIn.kind === "oauth") {
      steps.push({
        layer: "workspace",
        text: `refused (tool): ${message}`,
        said: `Nobody has connected ${label} yet, so its tools aren't listed`,
      })

      return {
        allowed: false,
        setting: "tool",
        message,
        connect: {
          url: connectUrl(
            facts.origin,
            facts.connection,
            takesMine(facts.credential) ? "mine" : "workspace",
          ),
          why: "not_connected",
        },
        steps,
      }
    }

    return refuse("tool", message, `${label} has no tool called ${called}`)
  }

  workspace(
    `${name} is one of ${facts.connection}'s ${facts.tools.size} tools`,
    `${called} is one of ${label}'s ${facts.tools.size} tools`,
  )

  if (facts.policy.disabled.has(tool)) {
    return refuse(
      "disabled",
      `${name} is turned off for everyone on this workspace. ${askAdmins(facts, "turn it back on", `bun run workspace access ${facts.connection} enable ${tool}`)}`,
      `An admin turned ${called} off for everyone`,
    )
  }

  workspace(`${name} isn't turned off for everyone`, `${called} is on for the workspace`)

  const { level, from } = levelOf(facts.policy, facts.person)
  const said = levelSaid(facts.policy, facts.person, from)

  const change = (to: "read" | "all") => {
    const input = JSON.stringify({
      connection: facts.connection,
      who: `person:${facts.person.email}`,
      level: to,
    })

    if (facts.person.admin)
      return `Grant ${to} to ${facts.person.email} only with connection_access_set(${input}). Other people's access stays unchanged.`

    const request = JSON.stringify({ connection: facts.connection, want: to })

    return `${askAdmins(facts, `grant ${to} to ${facts.person.email} only`, `connection_access_set(${input})`)} ${facts.person.email} can ask with connection_access_request(${request}); a request does not grant access.`
  }

  const need = isRead(facts, tool) ? "read" : "all"

  if (level === "none") {
    return refuse(
      "level",
      `${facts.person.email}'s level on ${facts.connection} is none, from ${said}, so they can't use its tools. ${change(need)}`,
      `${who} gets nothing on ${label}, ${fromSaid(from)}`,
    )
  }

  if (level === "read" && need === "all") {
    return refuse(
      "level",
      `${facts.person.email}'s level on ${facts.connection} is read, from ${said}, and ${name} changes things: it isn't read-only (an MCP server's tool marked readOnlyHint, or an API's GET or GraphQL query) and no admin marked it read. ${change("all")}`,
      `${who} gets read only on ${label}, ${fromSaid(from)}, and ${called} changes things`,
    )
  }

  workspace(
    `${facts.person.email}'s level on ${facts.connection} is ${level}, from ${said}${level === "all" ? "" : `, and ${name} only reads${facts.tools.get(tool) === true ? "" : " (an admin marked it read)"}`}`,
    level === "all"
      ? `${who} gets every tool on ${label}, ${fromSaid(from)}`
      : `${who} gets read only on ${label}, ${fromSaid(from)}, and ${called} only reads`,
  )

  const mine = facts.person.own
  const theirs = `Only ${facts.person.email} can change that: connection_preferences_set({ connection: "${facts.connection}", level: "all" }) restores their workspace allowance, and connection_tool_preferences_set({ connection: "${facts.connection}", tool: "${tool}", on: true }) turns their tool back on. Their Connections page: ${ownPage(facts)}`

  if (mine.level === "none")
    return refuse(
      "own",
      `${facts.person.email} turned ${facts.connection} off for themselves. ${theirs}`,
      `${who} turned ${label} off for themselves`,
      "own",
    )

  if (mine.level === "read" && !isRead(facts, tool))
    return refuse(
      "own",
      `${facts.person.email} chose read only on ${facts.connection} for themselves, and ${name} changes things. ${theirs}`,
      `${who} chose read only on ${label} for themselves, and ${called} changes things`,
      "own",
    )

  if (mine.off.has(tool))
    return refuse(
      "own",
      `${facts.person.email} turned off ${name} for themselves. ${theirs}`,
      `${who} turned ${called} off for themselves`,
      "own",
    )

  const chose = mine.level !== undefined || mine.off.size > 0

  steps.push({
    layer: "own",
    text: chose
      ? `${facts.person.email}'s own settings on ${facts.connection} leave ${name} on`
      : `${facts.person.email} hasn't chosen less for themselves`,
    said: chose
      ? `${who}'s own settings leave ${called} on`
      : `${who} hasn't turned anything off for themselves`,
  })

  return { allowed: true, runsAs: "none", steps }
}

export const judgeCredential = (facts: Facts, as: "workspace" | "me" | undefined): Decision => {
  const { connection, credential } = facts
  const steps: Array<Step> = []
  const who = whoSaid(facts)
  const label = connectionLabel(connection)
  const account = accountSaid(facts)

  const refuse = (
    setting: Setting,
    message: string,
    said: string,
    layer: Layer,
    connect?: ConnectLink,
  ): Decision => {
    steps.push({ layer, text: `refused (${setting}): ${message}`, said })

    return connect === undefined
      ? { allowed: false, setting, message, steps }
      : { allowed: false, setting, message, connect, steps }
  }

  const run = (runsAs: RunsAs, why: string): Decision => {
    steps.push({
      layer: runsAs === "me" ? "own" : "workspace",
      text: why,
      said:
        credential !== "both"
          ? ""
          : runsAs === "me"
            ? `It runs with ${who}'s own ${account}`
            : `It runs with the workspace's ${account}`,
    })

    return { allowed: true, runsAs, steps }
  }

  const workspace = takesWorkspace(credential)
  const mine = takesMine(credential)
  const workspaceSet = workspace && facts.workspaceToken
  const mineSet = mine && facts.person.ownToken

  const has = [
    ...(workspace ? [`the workspace's is ${facts.workspaceToken ? "connected" : "missing"}`] : []),
    ...(mine ? [`${who}'s is ${facts.person.ownToken ? "connected" : "missing"}`] : []),
  ].join(", and ")

  steps.push({
    layer: "workspace",
    text:
      credential === "none"
        ? `${connection} takes no token`
        : `${connection} runs with ${BELONGS[credential]}'s token: ${[...(workspace ? [`the workspace's is ${facts.workspaceToken ? "set" : "missing"}`] : []), ...(mine ? [`${facts.person.email}'s own is ${facts.person.ownToken ? "set" : "missing"}`] : [])].join(", ")}`,
    said:
      credential === "none"
        ? `${label} takes no sign-in`
        : `${label} runs with ${BELONGS[credential]}'s own ${account}: ${has}`,
  })

  const { kind, workspaceBroken, ownBroken } = facts.signIn

  const workspaceHint =
    kind === "oauth"
      ? askAdmins(
          facts,
          workspaceBroken === undefined
            ? "connect it for the workspace"
            : "reconnect it for the workspace",
          `open ${connectUrl(facts.origin, connection, "workspace")}`,
        )
      : askAdmins(
          facts,
          "set it",
          `bun run workspace connections token ${connection} --workspace (it reads the token from stdin)`,
        )

  const noWorkspaceToken = () =>
    refuse(
      "credential",
      workspaceBroken !== undefined
        ? `the workspace's sign-in to ${connection} stopped working (${workspaceBroken}), so it needs connecting again. ${workspaceHint}`
        : kind === "oauth"
          ? `${connection} isn't connected for the workspace yet. ${workspaceHint}`
          : `${connection} has no workspace token yet. ${workspaceHint}`,
      workspaceBroken !== undefined
        ? `The workspace's ${label} sign-in stopped working`
        : kind === "oauth"
          ? `${label} isn't connected for the workspace yet`
          : `${label} has no workspace token yet`,
      "workspace",
      kind === "oauth"
        ? {
            url: connectUrl(facts.origin, connection, "workspace"),
            why: workspaceBroken === undefined ? "not_connected" : "reconnect",
          }
        : undefined,
    )

  const ownHint = setTokenHint(connection, facts.origin, kind)

  const ownConnect: ConnectLink | undefined =
    kind === "oauth"
      ? {
          url: connectUrl(facts.origin, connection, "mine"),
          why: ownBroken === undefined ? "not_connected" : "reconnect",
        }
      : undefined

  const noOwnToken = () =>
    refuse(
      "credential",
      ownBroken !== undefined
        ? `${facts.person.email}'s sign-in to ${connection} stopped working (${ownBroken}), so ${facts.person.email} connects it again. ${ownHint}`
        : kind === "oauth"
          ? `${facts.person.email} hasn't connected ${connection}. ${ownHint}`
          : `${facts.person.email} has no token of their own for ${connection}. Set yours: ${ownHint}`,
      ownBroken !== undefined
        ? `${who}'s ${label} sign-in stopped working`
        : kind === "oauth"
          ? `${who} hasn't connected ${label}`
          : `${who} has no ${label} token of their own`,
      "own",
      ownConnect,
    )

  if (credential === "none") return run("none", "runs with no token")

  if (as === "workspace") {
    if (!workspace)
      return refuse(
        "as",
        `${connection} takes each person's own token, not the workspace's: leave as out, or as: "me"`,
        `The call asked for the workspace's ${account}, and ${label} takes only each person's own`,
        "call",
      )

    return workspaceSet
      ? run("workspace", 'as: "workspace": runs with the workspace\'s token')
      : noWorkspaceToken()
  }

  if (as === "me") {
    if (!mine)
      return refuse(
        "as",
        `${connection} takes only the workspace's token, not people's own: leave as out, or as: "workspace"`,
        `The call asked for ${who}'s own ${account}, and ${label} takes only the workspace's`,
        "call",
      )

    return mineSet
      ? run("me", `as: "me": runs with ${facts.person.email}'s own token`)
      : noOwnToken()
  }

  if (workspaceSet && mineSet) {
    return refuse(
      "as",
      `${connection} has both the workspace's token and ${facts.person.email}'s own, so say which: as: "workspace" (the workspace's) or as: "me" (yours)`,
      `${label} has the workspace's ${account} and ${who}'s own, and the call didn't say which`,
      "call",
    )
  }

  if (workspaceSet)
    return run("workspace", "runs with the workspace's token (the only one there is)")

  if (mineSet)
    return run("me", `runs with ${facts.person.email}'s own token (the only one there is)`)

  if (credential === "workspace") return noWorkspaceToken()

  if (credential === "person") return noOwnToken()

  return refuse(
    "credential",
    kind === "oauth"
      ? `${connection} isn't connected for the workspace, and ${facts.person.email} hasn't connected their own. ${ownHint} ${workspaceHint}`
      : `${connection} has neither the workspace's token nor ${facts.person.email}'s own. Set yours: ${ownHint} ${workspaceHint}`,
    `${label} isn't connected for the workspace, and ${who} hasn't connected their own`,
    "own",
    ownConnect,
  )
}

export const decide = (
  facts: Facts,
  tool: string,
  as: "workspace" | "me" | undefined,
): Decision => {
  const judged = judgeTool(facts, tool)

  if (!judged.allowed) return judged

  const credential = judgeCredential(facts, as)

  return { ...credential, steps: [...judged.steps, ...credential.steps] }
}

export type PageViewer = "person" | "signed_out" | "test_person"

export type AppSide = {
  readonly app: string
  readonly binding: ToolBinding | undefined
  readonly viewer: PageViewer
  readonly consented: boolean
}

export const decideForApp = (facts: Facts, tool: string, side: AppSide): Decision => {
  const name = `${facts.connection}.${tool}`
  const steps: Array<Step> = []
  const who = whoSaid(facts)
  const label = connectionLabel(facts.connection)
  const called = toolLabel(tool)

  const refuse = (
    setting: Setting,
    message: string,
    said: string,
    before: ReadonlyArray<Step> = [],
    layer: Layer = "call",
  ) => ({
    allowed: false as const,
    setting,
    message,
    steps: [...steps, ...before, { layer, text: `refused (${setting}): ${message}`, said }],
  })

  if (side.binding === undefined) {
    return refuse(
      "binding",
      `${side.app} doesn't list ${name} in its openbelt.json "tools", so its pages can't call it. Its author adds "tools": {"${name}": "workspace"} (or "viewer", to run as whoever is viewing) and deploys.`,
      `${side.app} doesn't ask for ${called}`,
    )
  }

  steps.push({
    layer: "call",
    text: `${side.app}'s openbelt.json binds ${name} to ${side.binding}`,
    said: `${side.app} asks for ${called} ${side.binding === "viewer" ? "as the person viewing" : "as the workspace"}`,
  })

  const { credential, connection } = facts

  if (side.viewer === "signed_out" && (credential !== "none" || side.binding === "viewer")) {
    return refuse(
      "signed_out",
      `nobody is signed in on this page, and ${name} ${side.binding === "viewer" ? "runs as whoever is viewing" : `runs with ${connection}'s token`}, which only the workspace's people get. Open the page signed in (through the workspace's front door: Tailscale).`,
      `Nobody is signed in on the page, and only the workspace's people can use ${label}`,
    )
  }

  if (side.viewer === "test_person" && side.binding === "viewer") {
    return refuse(
      "test_person",
      `${facts.person.email} is a check_app test person, and test people have no personal tokens, so ${name}, bound to "viewer", can't run as them. Expect this refusal in the check, or bind the tool to "workspace" to test its calls.`,
      `${who} is a test person, with no ${label} account of their own`,
    )
  }

  if (
    side.binding === "viewer" &&
    facts.signIn.kind === "oauth" &&
    facts.tools.size === 0 &&
    takesMine(credential) &&
    !facts.person.removed &&
    !facts.person.ownToken
  )
    return refuse(
      "token",
      `${name} runs as whoever is viewing, with their own ${connectionLabel(connection)} sign-in, and ${facts.person.email} hasn't connected theirs (nobody has yet, so its tools aren't listed). Connect yours: ${connectLink(facts.origin, connection)}`,
      `${who} hasn't connected ${label}`,
      [],
      "own",
    )

  const judged = judgeTool(facts, tool)

  if (!judged.allowed) return { ...judged, steps: [...steps, ...judged.steps] }

  steps.push(...judged.steps)

  if (credential === "none") {
    steps.push({
      layer: "workspace",
      text: `${connection} takes no token: runs with none`,
      said: `${label} takes no sign-in`,
    })

    return { allowed: true, runsAs: "none", steps }
  }

  if (side.binding === "workspace") {
    if (credential === "person") {
      return refuse(
        "binding",
        `${side.app} binds ${name} to "workspace", but ${connection} takes each person's own token, not the workspace's: bind it to "viewer" in openbelt.json.`,
        `${side.app} asks for ${called} as the workspace, and ${label} takes only each person's own`,
      )
    }

    const workspace = judgeCredential(facts, "workspace")

    return workspace.allowed
      ? { ...workspace, steps: [...steps, ...workspace.steps] }
      : refuse(
          workspace.setting,
          workspace.message,
          workspace.steps.at(-1)?.said ?? "",
          workspace.steps.slice(0, -1),
          "workspace",
        )
  }

  if (credential === "workspace") {
    return refuse(
      "binding",
      `${side.app} binds ${name} to "viewer", but ${connection} takes only the workspace's token, not people's own: bind it to "workspace" in openbelt.json.`,
      `${side.app} asks for ${called} as the person viewing, and ${label} takes only the workspace's`,
    )
  }

  const mine = judgeCredential(facts, "me")

  if (!mine.allowed) {
    return mine.setting === "credential"
      ? refuse(
          "token",
          facts.signIn.ownBroken !== undefined
            ? `${name} runs as whoever is viewing, with their own ${connectionLabel(connection)} sign-in, and ${facts.person.email}'s stopped working (${facts.signIn.ownBroken}). Connect it again: ${connectLink(facts.origin, connection)}`
            : facts.signIn.kind === "oauth"
              ? `${name} runs as whoever is viewing, with their own ${connectionLabel(connection)} sign-in, and ${facts.person.email} hasn't connected theirs. Connect yours: ${connectLink(facts.origin, connection)}`
              : `${name} runs as whoever is viewing, with their own ${connectionLabel(connection)} token, and ${facts.person.email} hasn't set one. Set yours on Connections: ${facts.origin}/_connections/${connection}`,
          facts.signIn.ownBroken !== undefined
            ? `${who}'s ${label} sign-in stopped working`
            : facts.signIn.kind === "oauth"
              ? `${who} hasn't connected ${label}`
              : `${who} hasn't set a ${label} token`,
          mine.steps.slice(0, -1),
          "own",
        )
      : refuse(mine.setting, mine.message, mine.steps.at(-1)?.said ?? "", mine.steps.slice(0, -1))
  }

  steps.push(...mine.steps)

  if (!side.consented) {
    return refuse(
      "consent",
      `${facts.person.email} hasn't allowed ${side.app} to use their ${connectionLabel(connection)} ${facts.signIn.kind === "oauth" ? "sign-in" : "token"} for the tools it asks for. Allow it on Connections, which lists them: ${facts.origin}/_connections/${connection}`,
      `${who} hasn't allowed ${side.app} to use their ${label}`,
      [],
      "own",
    )
  }

  steps.push({
    layer: "own",
    text: `${facts.person.email} allowed ${side.app} to use their ${connection} token for ${name}`,
    said: `${who} allowed ${side.app} to use their ${label}`,
  })

  return { allowed: true, runsAs: "me", steps }
}
