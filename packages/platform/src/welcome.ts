// What OpenBelt tells someone who isn't in yet: an AI agent reads /auth.md (or a host's home asked for as markdown), a person sees
// the marketing pages (www/). A workspace's host describes that workspace; the base host (no workspace in its name, under email sign-in) all
// of OpenBelt.
import { readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import firstToolMd from "../../../docs/start.md" with { type: "text" }
import { allSections } from "./docs.ts"
import * as Runtime from "./runtime/index.ts"

/** "Build me ... on OpenBelt": what "on OpenBelt" means, so an agent deploys instead of serving on a port of its own machine. */
const onOpenBelt = (origin: string, workspace: string | null) =>
  `"On OpenBelt" or "on ${new URL(origin).host}" means: deploy the app to OpenBelt${workspace === null ? "" : ` in the workspace ${workspace}`} (it hosts it, with data and realtime), not serve it on a port of this machine.`

/** claude.ai's Add custom connector dialog with the name and address filled in (checked 2026-11-17). */
const claudeConnectorLink = (mcp: string) =>
  `https://claude.ai/customize/connectors?${new URLSearchParams({ modal: "add-custom-connector", connectorName: "OpenBelt", connectorUrl: mcp }).toString()}`

const clients = (
  mcp: string,
) => `- Claude Code: \`claude mcp add --transport http openbelt ${mcp}\`, then \`/mcp\`, openbelt, Authenticate
- Codex: \`codex mcp add openbelt --url ${mcp}\`, then \`codex mcp login openbelt\`
- Claude (claude.ai, the desktop or phone app): you can't add it yourself, so give the person these steps and wait: "Open ${claudeConnectorLink(mcp)} and click Continue, then Add, then Connect. Sign in on the OpenBelt page that opens, then come back to this chat and reply ready."
- ChatGPT: you can't add it yourself, so give the person these steps and wait: "Open https://chatgpt.com/plugins, click Add, then Add custom MCP server. Name: OpenBelt. Server URL: ${mcp}. Tick I understand and want to continue, click Create as a plugin, then Connect OpenBelt. Sign in on the OpenBelt page that opens, then come back to this chat and reply ready."`

/** A workspace host's /auth.md, and its home asked for as markdown: connect to this workspace. */
export const workspaceAuthMd = (
  workspace: string,
  workspaceOrigin: string,
) => `# OpenBelt: the workspace ${workspace}, for an AI agent

${onOpenBelt(workspaceOrigin, workspace)}

Add the MCP server \`${workspaceOrigin}/mcp\` (Streamable HTTP, no headers). Your client gets a 401 that
points it at OAuth and opens a browser page: tell the person you're helping to sign in there and click Continue.
Then every tool works, as them, in ${workspace}.

${clients(`${workspaceOrigin}/mcp`)}
- The CLI: \`curl -fsSL ${workspaceOrigin}/install | sh\` (it signs in and adds OpenBelt to the agents it finds)

A client that can't sign in sends \`Authorization: Bearer <token>\` instead, with a token the person you're helping
makes at ${workspaceOrigin}/_settings/agents.

Start with the \`docs\` tool; \`deploy_app\` publishes an app and returns its URL.
`

/** What an agent with no credential is told to tell the person it works for (an MCP client with OAuth starts it by itself). */
export const tellYourHuman = (origin: string, where: string) =>
  `OpenBelt needs the person you work for to sign in before you can use ${where}. Tell them: "To connect me to OpenBelt, a browser page will open (in Claude Code: run /mcp, pick openbelt, then Authenticate). Sign in there and click Continue; then come back here." An MCP client with OAuth starts this by itself (${origin}/.well-known/oauth-protected-resource/mcp). How to get in, for an agent: ${origin}/auth.md`

/** The base host's /auth.md (under email sign-in): one MCP address for every workspace; with trials on, a trial workspace as well. */
export const authMd = (origin: string, trials: boolean) => `# OpenBelt, for an AI agent

${onOpenBelt(origin, null)}

OpenBelt hosts small web apps (static files plus a data and realtime SDK) for a team; agents build
them over MCP. Everything lives in an **workspace**: a team's apps, data, people and connections.
${trials ? "There are two ways in; pick by whether the person you're helping is at the keyboard now.\n\n## A. They're here (your MCP client does OAuth)\n" : ""}
Add the MCP server \`${origin}/mcp\` (Streamable HTTP, no headers). Your client gets a 401 that
points it at OAuth and opens a browser page. Tell the person you're helping: "An OpenBelt page opens: sign in with
your email (a code is mailed to you), pick your workspace or name a new one, and click Continue."
Then every tool works, as them, in that workspace.

${clients(`${origin}/mcp`)}
- The CLI: \`curl -fsSL ${origin}/install | sh\` (it signs in and adds OpenBelt to the agents it finds)

If your client can't add an MCP server by itself, give the person you're helping the steps for it
above and wait. They can also start in the browser: ${origin}/_start.
${trials ? trialSection(origin) : ""}
Start with the \`docs\` tool; \`deploy_app\` publishes an app and returns its URL.
`

/** The base host's /start.md: what an agent a person sent here from the home page's Copy prompt does first. Every section of
 * docs/start.md (the docs tool's start page), so a connected agent asked for a first tool does the same, with how to connect
 * after the pick. `google`: the sign-in page offers Continue with Google (google.ts), so the person needn't wait for a code. */
export const startMd = (origin: string, google: boolean) => {
  const [title = "", ...rest] = allSections(firstToolMd)
  const said = title.split("\n").slice(1).join("\n").trim()

  const signIn = google
    ? "click Continue, then Continue with Google (or sign in with your email)"
    : "click Continue, then sign in with your email (a code is mailed to you)"

  if (!rest.some((s) => s.startsWith("## Offer a pick\n")))
    throw new Error(
      'welcome.ts: docs/start.md has no "## Offer a pick" for /start.md to connect after',
    )

  const connect = `## Connect

Skip this if the \`docs\` tool works.

1. If you run on the person's own computer and can run shell commands, install the \`openbelt\` CLI:
   run \`curl -fsSL ${origin}/install | sh -s -- -y\`. If it says it's connected, go on to your pick. If it
   ends with a code, tell the person, with that code: "A page opened. Check that it shows <code>,
   ${signIn}." Then run \`~/.local/bin/openbelt login --wait\` in this turn, with a 10-minute
   timeout: it returns once they've signed in. Don't end your turn while it runs, or it may be
   stopped. It also adds OpenBelt to this agent as an MCP server, signed in.
   This is best effort: if any part fails, go on to step 3.
   A chat app (Claude, ChatGPT) runs commands in a cloud sandbox, not on the person's computer: skip
   to step 3.
2. If the CLI is signed in but the \`docs\` tool still isn't here (most agents only see a new MCP
   server after a restart), don't wait for one: use the CLI. Each command is one of the MCP tools:
   \`openbelt docs apps\`, \`openbelt app deploy <folder>\`, \`openbelt app check <app>\`,
   \`openbelt call <tool> '<json>'\` for any tool; \`openbelt --help\` lists them. Run each as
   \`~/.local/bin/openbelt <command>\` on its own, with nothing before it (no variables, \`cd\` or
   \`&&\`), so the person can allow each kind once instead of every call.
3. Otherwise add the MCP server \`${origin}/mcp\` (Streamable HTTP, OAuth). The same sign-in page
   opens.

${clients(`${origin}/mcp`)}
- Anything else: ${origin}/auth.md`

  return `# Getting started with OpenBelt

You were sent here to help someone get started. ${said}

Offer the pick first; after they reply, connect if the \`docs\` tool isn't there yet, then add or build their pick.

${rest.flatMap((s) => (s.startsWith("## Offer a pick\n") ? [s, connect] : [s])).join("\n\n")}
`
}

/** The trial way in, for /auth.md when OPENBELT_TRIALS=on (trials.ts). */
const trialSection = (origin: string) => `
## B. Build now, they claim it later (no browser, no account)

Start a **trial workspace**, once per person. Never call it from a script you re-run.

    mkdir -p .openbelt && curl -s -X POST ${origin}/_trial > .openbelt/trial.json && cat .openbelt/trial.json

Save that JSON to \`./.openbelt/trial.json\` before anything else: it holds the only copy of the token
and the claim link (\`workspace\`, \`mcp_url\`, \`token\`, \`claim_url\`, \`expires_at\`). Keep
\`token\` secret: it's an admin's API token for that workspace. A trial workspace is invite-only until it's
claimed, and its apps open only in \`check_app\` (your test browser). Unclaimed, it stops working
after a day. At most 5 trials an hour from one address: reuse the one you have.

If /_trial answers 429: send the person you're helping ${origin}/_start (start in the browser) and stop.

Add \`mcp_url\` as an MCP server with the header \`Authorization: Bearer <token>\`, or, if you can't
add one mid-session, speak MCP over HTTP yourself: POST JSON-RPC \`initialize\` to it, keep the
\`mcp-session-id\` response header, and send it on every later call.

When you're done, tell the person you're helping: "The app opens once you claim it at <claim_url>: open that,
sign in with your email, and the workspace is yours." They become its admin, your token keeps working
(now as them), and it no longer expires.
`

/** The base host's /llms.txt. */
export const llmsTxt = (origin: string, trials: boolean) => `# OpenBelt

> An app store for you and your agents: agents build a team's small web apps over MCP, OpenBelt hosts
> them with data and realtime built in, live the moment they deploy.

## For agents

- [start.md](${origin}/start.md): someone sent you here to get started; build their first tool with them
- [auth.md](${origin}/auth.md): how to get in (add the MCP server; the person you're helping signs in${trials ? "; or a trial workspace they claim later" : ""})
- MCP server: ${origin}/mcp (Streamable HTTP, OAuth)
- [CLI](${origin}/install): \`curl -fsSL ${origin}/install | sh\`

## For people

- [OpenBelt](${origin}/): what it is
- [Start building](${origin}/_start): sign in with your email and create your workspace
`

/** The base host's home asked for as markdown (an agent fetching the page it was pointed at). */
export const homeMd = (origin: string, trials: boolean) => `# OpenBelt

An app store for you and your agents. Your agents build apps for your team over MCP, and OpenBelt
hosts them, with data and realtime built in, live the moment they deploy. Inside a workspace every app
is open to everyone in it and can use the others' data; workspaces never see each other.

## If you're an AI agent

Read ${origin}/auth.md. In short: add the MCP server \`${origin}/mcp\` and let the person you're helping sign in${trials ? `, or \`curl -X POST ${origin}/_trial\` for a trial workspace they claim later` : ""}.

## If you're a person

Paste into your agent: "Read ${origin}/start.md, then help me build a tool". Or start in your
browser: ${origin}/_start.
`

/** The marketing pages: www/ in the repository (and the image), beside packages/. */
const WWW = join(import.meta.dir, "../../../www")

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".woff2", "font/woff2"],
  [".ico", "image/x-icon"],
  [".json", "application/json"],
])

/** The marketing pages served at a path without .html. */
const PAGES = new Map([
  ["/", "index.html"],
  ["/privacy", "privacy.html"],
])

/** A path inside www/ that stays inside it: letters, digits, dashes, dots and slashes, no "..". */
const WWW_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/

/**
 * Cloudflare Web Analytics on the marketing pages (OPENBELT_WEB_ANALYTICS, its token: 32 hex digits): its beacon, cookieless,
 * on each of www/'s HTML pages. Never on sign-in, a workspace's pages or an app's: what a person does there is theirs (the sign-up
 * funnel counts sign-in from the server's own lines, funnel.ts).
 */
const ANALYTICS = (() => {
  const token = Runtime.text("OPENBELT_WEB_ANALYTICS", "")

  if (token !== "" && !/^[0-9a-f]{32}$/.test(token))
    throw new Error(
      `the setting OPENBELT_WEB_ANALYTICS isn't a Cloudflare Web Analytics token (32 hex digits)`,
    )

  return token === ""
    ? ""
    : `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${token}"}'></script>\n  `
})()

/** The header's Sign in and Start building, which someone signed in on this host sees as one Dashboard. */
const SIGNED_OUT_NAV =
  /<a href="\/_signin">Sign in<\/a>\s*<a class="nav-cta" href="\/_start">Start building<\/a>/

/**
 * A file of the marketing pages by its URL path, or null; index.html names the host it's served on, not openbelt.com,
 * and its header has Dashboard for someone signed in.
 */
export const wwwFile = (path: string, origin: string, signedIn: boolean) => {
  const file = PAGES.get(path) ?? path.slice(1)

  if (!WWW_PATH.test(file) || file.includes("..")) return null

  const at = join(WWW, file)

  try {
    if (!statSync(at).isFile()) return null
  } catch {
    return null
  }

  const bytes = new Uint8Array(readFileSync(at))
  const type = TYPES.get(extname(at)) ?? "application/octet-stream"

  if (extname(file) !== ".html") return { bytes, type }

  const text = new TextDecoder().decode(bytes).replace("</body>", `${ANALYTICS}</body>`)

  if (file !== "index.html") return { bytes: new TextEncoder().encode(text), type }

  const page = text
    .replaceAll("https://openbelt.com", origin)
    .replace(SIGNED_OUT_NAV, (links) =>
      signedIn ? '<a class="nav-cta" href="/_start">Dashboard</a>' : links,
    )

  return { bytes: new TextEncoder().encode(page), type }
}
