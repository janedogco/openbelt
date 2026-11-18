import * as Effect from "effect/Effect"
import connectionsMd from "../../../docs/connections.md" with { type: "text" }
import debuggingMd from "../../../docs/debugging.md" with { type: "text" }
import functionsMd from "../../../docs/functions.md" with { type: "text" }
import rulesMd from "../../../docs/rules.md" with { type: "text" }
import sdkMd from "../../../docs/sdk.md" with { type: "text" }
import startMd from "../../../docs/start.md" with { type: "text" }
import appsMd from "../../../docs/apps.md" with { type: "text" }
import codeMd from "../../../docs/code.md" with { type: "text" }
import viewersMd from "../../../docs/viewers.md" with { type: "text" }
import workspaceMd from "../../../docs/workspace.md" with { type: "text" }
import { allSections, section } from "./docs.ts"
import { Refused } from "./model.ts"

const INSTRUCTIONS =
  'OpenBelt builds and runs small web apps for a workspace (pages, data, functions, connections to other services). Two tools: search({ query }) finds the operations for a task, each with its input schema, and the workspace\'s apps and connections that match; call({ tool, args }) runs one operation. An operation named in docs or a refusal (deploy_app, check_app, app_info…) is run with call. Personal settings and workspace policy are separate; every call checks your current permissions. For an app: search existing apps and connections, then read the docs pages apps and sdk (call({ tool: "docs", args: { page: "apps" } })) before deploying. Use preview data for browser writes; check_app proves the result. For an app anyone opens without signing in: docs page apps, section Public apps. For management: read docs page workspace only when needed. Never ask for credentials in chat. For a trial, return its claim_url. When OpenBelt fails you (a bug, something it can\'t do, docs or a refusal that misled you), report it once with call({ tool: "feedback_submit", args: { category: "bug" | "not_possible" | "confusing" | "other", summary, goal, details } }) and carry on.'

export const PAGE_NAMES = [
  "start",
  "apps",
  "sdk",
  "functions",
  "code",
  "rules",
  "viewers",
  "debugging",
  "connections",
  "workspace",
] as const

type PageName = (typeof PAGE_NAMES)[number]

const page = (markdown: string, sections: ReadonlyArray<string>) => ({
  about: /^description: (.*)$/m.exec(markdown)?.[1] ?? "",
  sections,
})

/**
 * What the sdk page says about uploads beyond its "## Files" section, each left out when uploads are off (files.ts UPLOADS). Each
 * must be in the page: a docs edit that changes one fails here, at start, instead of telling agents about uploads they can't use.
 */
const UPLOAD_MENTIONS = [
  "files people upload (files.put, a url for <img>), ",
  "- files: `file_too_large` (413), `workspace_storage_full` (507), `disk_low` (507, the server's disk is\n  nearly full), `busy` (503, retried by the SDK), `storage` (502, the file store failed).\n",
  "no such document, app, environment or file.",
] as const

const withoutUploads = (text: string) =>
  UPLOAD_MENTIONS.reduce(
    (left, mention) =>
      mention.startsWith("no such")
        ? left.replace(mention, "no such document, app or environment.")
        : left.replace(mention, ""),
    text,
  )

for (const mention of UPLOAD_MENTIONS)
  if (!sdkMd.includes(mention))
    throw new Error(
      `guide.ts: docs/sdk.md no longer says ${JSON.stringify(mention.slice(0, 60))}: update UPLOAD_MENTIONS`,
    )

/** The functions page's ctx.files, left out with uploads off: it reads only files people upload. Like UPLOAD_MENTIONS, checked at start. */
const CTX_FILES = /^- `files`: the app's own uploaded files[^]*?(?=^- )/m

if (!CTX_FILES.test(functionsMd))
  throw new Error(
    "guide.ts: docs/functions.md no longer has its `files` bullet in ctx: update CTX_FILES",
  )

const pagesFor = (uploads: boolean): Record<PageName, ReturnType<typeof page>> => {
  if (uploads) return PAGES

  const sdk = PAGES.sdk
  const functions = PAGES.functions

  return {
    ...PAGES,
    functions: {
      ...functions,
      sections: functions.sections.map((text) => text.replace(CTX_FILES, "")),
    },
    sdk: {
      about: withoutUploads(sdk.about),
      sections: sdk.sections.filter((text) => !text.startsWith("## Files\n")).map(withoutUploads),
    },
  }
}

const PAGES: Record<PageName, ReturnType<typeof page>> = {
  start: page(startMd, allSections(startMd)),
  apps: page(appsMd, [
    section(appsMd, "# Apps"),
    section(appsMd, "## Deploying"),
    section(appsMd, "## Files and names"),
    section(appsMd, "## In the frame"),
    section(appsMd, "## Preview environments"),
    section(appsMd, "## Changing an existing app"),
    section(appsMd, "## openbelt.json: describe your data"),
    section(appsMd, "## Public apps: anyone opens them on the public host"),
    section(appsMd, "## Skills"),
  ]),
  sdk: page(sdkMd, [
    section(sdkMd, "# SDK"),
    section(sdkMd, "## Documents"),
    section(sdkMd, "## Importing documents over MCP"),
    section(sdkMd, "## Using another app's data"),
    section(sdkMd, "## Files"),
    section(sdkMd, "## Connections: tools.call"),
    section(sdkMd, "## Theme"),
    section(sdkMd, "## Errors"),
  ]),
  functions: page(functionsMd, [
    section(functionsMd, "# Functions"),
    section(functionsMd, "## Writing one: a file and a line in openbelt.json"),
    section(functionsMd, "## ctx: what a function gets"),
    section(functionsMd, "## A run is all or nothing"),
    section(functionsMd, "## Queries: read-only, and live on pages"),
    section(functionsMd, "## Contracts: input and output schemas"),
    section(functionsMd, "## Calling one: pages, other apps and agents"),
    section(functionsMd, "## Secrets, network and connections: the outside world"),
    section(functionsMd, "## Schedules, webhooks, triggers and later: runs nobody calls"),
    section(functionsMd, "## Testing without waiting"),
    section(functionsMd, "## Limits"),
  ]),
  code: page(codeMd, [
    section(codeMd, "# Code"),
    section(codeMd, "## What workspace has"),
    section(codeMd, "## Limits"),
  ]),
  rules: page(rulesMd, [
    section(rulesMd, "# Who can change what"),
    section(rulesMd, "## The vocabulary"),
    section(rulesMd, "## Denials"),
  ]),
  viewers: page(viewersMd, [
    section(viewersMd, "# Who is viewing"),
    section(viewersMd, "## Test as several people"),
  ]),
  debugging: page(debuggingMd, [section(debuggingMd, "## Check your work")]),
  connections: page(connectionsMd, [
    section(connectionsMd, "# Connections"),
    section(connectionsMd, "## Whose token"),
    section(connectionsMd, "## Who may use what"),
    section(connectionsMd, "## In apps"),
    section(connectionsMd, "## Google's APIs"),
  ]),
  workspace: page(workspaceMd, [
    section(workspaceMd, "# Manage a workspace"),
    section(workspaceMd, "## Find operations"),
    section(workspaceMd, "## People and groups"),
    section(workspaceMd, "## Connections and access"),
    section(workspaceMd, "## Tokens, consent and agent sign-outs"),
  ]),
}

const headingOf = (text: string) => (text.split("\n", 1)[0] ?? "").replace(/^#+\s*/, "")

const norm = (text: string) =>
  text
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")

/** The instructions and the docs tool as an agent on this OpenBelt reads them: uploads in them only when they're on. */
const build = (uploads: boolean) => {
  const pages = pagesFor(uploads)

  const index = [
    INSTRUCTIONS,
    "",
    'OpenBelt\'s docs, a page at a time: docs({ page: "apps" }) returns that page, docs({ page: "functions", section: "Limits" }) one section of it. Before your first deploy_app, read apps and sdk.',
    "",
    ...PAGE_NAMES.map((name) => {
      const [title = "", ...rest] = pages[name].sections.map(headingOf)
      const listed = rest.length === 0 ? "" : `\n  Sections: ${rest.join("; ")}`

      return `- ${name} (${title}): ${pages[name].about}${listed}`
    }),
  ].join("\n")

  const docsFor = (asked: { readonly page?: PageName; readonly section?: string }) => {
    if (asked.section === undefined)
      return Effect.succeed(
        asked.page === undefined ? index : pages[asked.page].sections.join("\n\n"),
      )

    const among = asked.page === undefined ? PAGE_NAMES : [asked.page]
    const all = among.flatMap((name) => pages[name].sections.map((text) => ({ name, text })))
    const wanted = norm(asked.section)
    const exact = all.filter((s) => norm(headingOf(s.text)) === wanted)

    const found =
      exact.length > 0 ? exact : all.filter((s) => norm(headingOf(s.text)).startsWith(wanted))

    const [only] = found

    if (found.length === 1 && only !== undefined) return Effect.succeed(only.text)

    const named = (found.length > 1 ? found : all).map((s) => `${s.name}: "${headingOf(s.text)}"`)

    const what =
      found.length > 1
        ? `several sections start "${asked.section}"`
        : `there's no section "${asked.section}"${asked.page === undefined ? "" : ` in ${asked.page}`}`

    return Effect.fail(
      new Refused({
        message: `${what}. Pass one of these as section, with its page: ${named.join(", ")}. docs() with no arguments is the index.`,
      }),
    )
  }

  return { instructions: INSTRUCTIONS, docsFor }
}

const GUIDES = { on: build(true), off: build(false) }

/** What agents read on this OpenBelt: OPENBELT_UPLOADS on or off (files.ts). */
export const guideFor = (uploads: boolean) => GUIDES[uploads ? "on" : "off"]
