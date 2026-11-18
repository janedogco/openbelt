import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import pkg from "../package.json" with { type: "json" }
import type * as Catalog from "../packages/platform/src/providers.ts"
import { indexSource, providerFiles } from "./providers.ts"
import { STARTERS } from "../packages/platform/src/starters.ts"

const ROOT = resolve(import.meta.dir, "..")

const PLATFORM = "packages/platform/src/"

const problems: Array<string> = []

// Each once: mid-merge, git lists a conflicted file once per side.
const files = [
  ...new Set(
    Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
    })
      .stdout.toString()
      .split("\n"),
  ),
].filter((f) => f !== "" && existsSync(join(ROOT, f)))

const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

for (const file of files.filter((f) => f.startsWith(".github/") && /\.ya?ml$/.test(f))) {
  const source = read(file)

  for (const [, action] of source.matchAll(/\buses:\s*([^\s#]+)/g)) {
    if (action !== undefined && !action.startsWith("./") && !/@[a-f0-9]{40}$/.test(action))
      problems.push(
        `${file}: pin ${action} to a full upstream commit SHA, keeping its version in a comment.`,
      )
  }

  for (const [, body] of source.matchAll(
    /uses: actions\/upload-artifact@[^\n]+\n([\s\S]*?)(?=\n      -|\n  [a-z]|$)/g,
  )) {
    if (!/^\s+path: \.verify\/ci-evidence\/\s*$/m.test(body ?? ""))
      problems.push(
        `${file}: upload only .verify/ci-evidence/ from scripts/ci-evidence.ts; raw verification evidence contains credentials.`,
      )
  }
}

const NO_UNIT_TESTS =
  "unit tests aren't allowed. Prove behavior against a real instance instead (scripts/verify/checks/)."

const TEST_RUNNER =
  /\bfrom\s+["'](bun:test|node:test|vitest|@vitest\/[^"']+|jest|@jest\/[^"']+|mocha|ava|tap|uvu)["']|\brequire\(["'](bun:test|node:test|vitest|jest|mocha)["']\)/

const TEST_PACKAGES = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "tap",
  "uvu",
  "ts-jest",
  "@types/jest",
  "@types/mocha",
])

for (const f of files) {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)__tests__\//.test(f)) {
    problems.push(`${f}: ${NO_UNIT_TESTS}`)
  } else if (/\.[cm]?[jt]sx?$/.test(f) && f !== "scripts/guard.ts" && TEST_RUNNER.test(read(f))) {
    problems.push(`${f}: imports a test runner; ${NO_UNIT_TESTS}`)
  }
}

for (const f of files.filter((name) => name === "package.json" || name.endsWith("/package.json"))) {
  const manifest = read(f)

  for (const name of TEST_PACKAGES)
    if (manifest.includes(`"${name}":`)) problems.push(`${f}: depends on ${name}; ${NO_UNIT_TESTS}`)

  if (/"test"\s*:/.test(manifest)) problems.push(`${f}: has a "test" script; ${NO_UNIT_TESTS}`)
}

for (const file of files.filter((f) => /^(?:\.agents|\.claude|docs\/agents)\//.test(f)))
  problems.push(
    `${file}: OpenBelt is public and keeps no agent skills or agent notes; keep them outside the repo.`,
  )

// 3. Bun is pinned: the scripts and the platform run on it.
if (Bun.version !== pkg.engines.bun) {
  problems.push(
    `running Bun ${Bun.version}, but package.json pins ${pkg.engines.bun}, the Bun the scripts and the platform are proved on. Run 'bun run setup:check' for the fix.`,
  )
}

const docSlugs = new Set(
  readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3)),
)

for (const slug of docSlugs) {
  const file = `docs/${slug}.md`

  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    problems.push(`${file}: page names are kebab-case (they become URLs).`)
  }

  const text = read(file)
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ""

  for (const key of ["title", "description"]) {
    if (!new RegExp(`^${key}: \\S`, "m").test(front)) {
      problems.push(
        `${file}: missing "${key}:" in frontmatter. It's what agents see in the docs index.`,
      )
    }
  }

  for (const m of text.matchAll(/\]\((?:\.\/|\/docs\/)([a-z0-9-]+)\.md(?:#[^)]*)?\)/g)) {
    if (!docSlugs.has(m[1] ?? ""))
      problems.push(`${file}: links to ${m[1]}.md, which doesn't exist.`)
  }
}

for (const f of files) {
  if (
    f.startsWith("tools/") ||
    f.startsWith("www/") ||
    f === "scripts/guard.ts" ||
    f === "GLOSSARY.md" ||
    f === "bun.lock" ||
    f === "packages/platform/storage.json"
  ) {
    continue
  }

  if (!/\.(md|ts|tsx|js|html|css|json|ya?ml)$/.test(f)) continue

  for (const [i, line] of read(f).split("\n").entries()) {
    const named = line
      .replace(/"sites?"/g, "")
      .replace(/\bmarketing sites?\b/gi, "")
      .replace(
        /\b(?:same|cross)-?site\b|\bclear-site-data\b|\bsec-fetch-site\b|\bog:site_name\b/gi,
        "",
      )

    if (
      /(?<![A-Za-z])[Ss]ites?(?![a-z])|(?<=[a-z])Sites?(?![a-z])|\bSITES?\b|(?<![\w.])\/s\/[\w<$]/.test(
        named,
      )
    ) {
      problems.push(
        `${f}:${i + 1}: say "app", not "site", in prose and names (deploy_app, AppDO, appPath, /a/<app>/, db.app): OpenBelt's word for what people build.`,
      )
    }
  }
}

for (const f of files) {
  if (f.startsWith("tools/") || f === "scripts/guard.ts") {
    continue
  }

  if (!/\.(md|ts|tsx|js|html)$/.test(f)) continue

  for (const [i, line] of read(f).split("\n").entries()) {
    if (/[—“”‘’]/.test(line)) {
      problems.push(
        `${f}:${i + 1}: no em dashes or curly quotes: they read as machine-written, and curly quotes break copied JSON and shell. Use a comma, period or parentheses, and straight quotes.`,
      )
    }
  }
}

const genFunction =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:const\s+(\w+)\s*=|(\w+):)\s*(?:<[^=\n]*>)?\((?:[^()]|\([^()]*\))*\)\s*(?::[^=\n]*)?=>\s*Effect\.gen\(/g

for (const f of files) {
  if (!f.startsWith(PLATFORM) || !f.endsWith(".ts")) continue

  const text = read(f)

  for (const match of text.matchAll(genFunction)) {
    const line = text.slice(0, match.index).split("\n").length + 1

    problems.push(
      `${f}:${line}: ${match[1] ?? match[2]} returns Effect.gen: write it as Effect.fn("Name.method")(function* (…) {…}) (Effect.fnUntraced on hot paths).`,
    )
  }
}

for (const f of files) {
  if (!f.startsWith("scripts/verify/checks/") || !f.endsWith(".ts")) continue

  if (!read(f).includes("check(")) {
    problems.push(
      `${f}: a checks file records what it proves with ctx.check(name, ok, detail); a check that records nothing proves nothing.`,
    )
  }
}

const refusal =
  /new (?:Refused|Denied|Missing|Conflict)\b|\b(?:missing|checkSeq|sized|conflict|allow)\(/

const refusable = new Set(
  ["app.ts", "workspace.ts", "data.ts", "versions.ts"].flatMap((file) => {
    const text = read(`${PLATFORM}${file}`)
    const ends = [...text.matchAll(/Effect\.fn(?:Untraced)?\(/g)].map((m) => m.index)

    const starts = [
      ...text.matchAll(/Effect\.fn\("(?:AppDO|WorkspaceDO|Dataset|Versions)\.(\w+)"\)/g),
    ]

    return starts.flatMap((m) => {
      const body = text.slice(m.index, ends.find((end) => end > m.index) ?? text.length)

      return refusal.test(body) ? [m[1] ?? ""] : []
    })
  }),
)

const mcpSource = read(`${PLATFORM}mcp.ts`)

for (const m of mcpSource.matchAll(/(?:getByName\([^)]*\)|workspace\(\)|\btarget)\.(\w+)\(/g)) {
  const method = m[1] ?? ""
  const before = mcpSource.slice(mcpSource.lastIndexOf("yield*", m.index), m.index)

  if (refusable.has(method) && !before.includes("remote(")) {
    const line = mcpSource.slice(0, m.index).split("\n").length

    problems.push(
      `${PLATFORM}mcp.ts:${line}: .${method}(...) can be refused, so call it through remote(...): RPC drops the Refused class and the agent would get an internal error instead of the message.`,
    )
  }
}

const ERRISH = String.raw`(?:\b(?:message|error|err|why|reason|cause|failure)\b|\.message\(\)|\.text\(\))`

const errorWording = [
  new RegExp(
    String.raw`${ERRISH}\)?\s*\??\.(?:includes|startsWith|endsWith|match|matchAll|search|indexOf)\(`,
    "g",
  ),
  new RegExp(
    String.raw`(?:\/[gimsuy]*|\b[A-Z][A-Z0-9_]*)\.(?:test|exec)\([^)]*${ERRISH}[^)]*\)`,
    "g",
  ),
]

for (const f of files) {
  if (!f.startsWith(PLATFORM) || !f.endsWith(".ts")) continue

  const text = read(f)
  const lines = text.split("\n")

  for (const pattern of errorWording) {
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split("\n").length

      if (/\/\/ wording: \S/.test(`${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`)) continue

      problems.push(
        `${f}:${line}: "${m[0]}" reads meaning out of an error's wording, which breaks silently when the wording changes. Branch on a field instead: the body's code, rule or seq (model.ts ErrorCode), or an Error's name; add one where it's missing. Text a browser or library writes with no such field: say so in a "// wording: why" comment.`,
      )
    }
  }
}

// 18. Stored data is found by name: a Durable Object class (its objects' files are named after it) and
// each SQLite table. Renaming one in code reads an empty new one and leaves the data behind.
// packages/platform/storage.json lists the names in use,
const STORAGE = "packages/platform/storage.json"

const storage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      objects: Schema.Array(Schema.String),
      tables: Schema.Array(Schema.String),
      moved: Schema.Array(
        Schema.Struct({ name: Schema.String, to: Schema.String, why: Schema.String }),
      ),
      dropped: Schema.Array(Schema.Struct({ name: Schema.String, why: Schema.String })),
    }),
  ),
)(read(STORAGE))

const platformFiles = files.filter((f) => f.startsWith(PLATFORM) && f.endsWith(".ts"))

const tablesIn = (f: string) => {
  const text = read(f)

  return [...text.matchAll(/CREATE TABLE IF NOT EXISTS (?:(\w+)|\$\{(\w+)\})/g)].map((m) => {
    if (m[1] !== undefined) return m[1]

    const variable = m[2] ?? ""

    const prefix = new RegExp(String.raw`const ${variable} = ` + "`" + String.raw`(\w+)\$\{`).exec(
      text,
    )?.[1]

    if (prefix === undefined)
      problems.push(
        `${f}: a table is named from \${${variable}}, which the guard can't read: build it in this file as const ${variable} = \`<prefix>_\${...}\`, so ${STORAGE} can list "<prefix>_*".`,
      )

    return `${prefix ?? "?"}*`
  })
}

const inCode = {
  objects: new Set(
    platformFiles.flatMap((f) =>
      [...read(f).matchAll(/DurableObject\(\s*"(\w+)"/g)].map((m) => m[1] ?? ""),
    ),
  ),
  tables: new Set(platformFiles.flatMap(tablesIn)),
}

const droppedNames = new Set(storage.dropped.map((d) => d.name))

const movedTo = new Map(storage.moved.map((m) => [m.name, m.to]))

for (const moved of storage.moved) {
  if (![...storage.tables, ...storage.objects].includes(moved.to))
    problems.push(
      `${STORAGE}: "${moved.name}" moved to "${moved.to}", which isn't in "tables" or "objects": the data it moved to is held there, so list it.`,
    )

  if ([...storage.tables, ...storage.objects].includes(moved.name))
    problems.push(
      `${STORAGE}: "${moved.name}" is in "tables" or "objects" and "moved": its data moved to "${moved.to}", so take it out of "tables".`,
    )
}

for (const kind of ["objects", "tables"] as const) {
  const what = kind === "objects" ? "Durable Object class" : "table"

  for (const name of storage[kind]) {
    if (!inCode[kind].has(name)) {
      problems.push(
        `${STORAGE}: the ${what} "${name}" holds data, and no code in ${PLATFORM} uses it any more, so that data is stranded at the next upgrade. Keep its name (rename the TypeScript, not the storage), or move the data on startup (ALTER TABLE ${name} RENAME TO ..., or copy it over, once) and list it in "moved" with where to and how, or, to drop it on purpose, move "${name}" to "dropped" with why.`,
      )
    }
  }

  for (const name of inCode[kind]) {
    if (!storage[kind].includes(name)) {
      problems.push(
        `${PLATFORM}: the ${what} "${name}" isn't in ${STORAGE}. ${droppedNames.has(name) ? `It was dropped on purpose ("dropped"), so reusing it would bring back old data under a new meaning: pick another name.` : movedTo.has(name) ? `Its data moved to "${movedTo.get(name) ?? ""}" ("moved"), and an old instance that still has it moves it again on startup: pick another name.` : `Add it to "${kind}": the names there hold data, and renaming one later loses it.`}`,
      )
    }
  }
}

const PROVIDERS = "packages/platform/providers"

const PROVIDERS_README = `${PROVIDERS}/README.md`

let catalog: typeof Catalog | undefined

try {
  catalog = await import("../packages/platform/src/providers.ts")
} catch (e) {
  problems.push(e instanceof Error ? e.message : String(e))
}

const publicProblem = (url: string) => {
  if (!URL.canParse(url)) return "isn't a URL"

  const { protocol, hostname } = new URL(url)

  if (protocol !== "https:") return "isn't https"

  return !hostname.includes(".") ||
    /^[\d.]+$|:|^\[/.test(hostname) ||
    /(^|\.)(localhost|local|internal|test|example|invalid|ts\.net|openbelt\.(?:ai|app|com|dev|page))$/.test(
      hostname,
    )
    ? `is ${hostname}, not a public host`
    : undefined
}

const CHANGES =
  /(^|[^a-z])(write|manage|admin|delete|modify|send|compose|full|repo)([^a-z]|$)|^https:\/\/mail\.google\.com\/?$|^https:\/\/www\.googleapis\.com\/auth\/(?!.*\.readonly$)/i

if (read(`${PROVIDERS}/index.ts`) !== indexSource(providerFiles()))
  problems.push(
    `${PROVIDERS}/index.ts doesn't match the provider files in ${PROVIDERS}: run bun run providers index (it writes index.ts from the folder; don't edit it by hand).`,
  )

if (catalog !== undefined) {
  const byUrl = new Map<string, string>()
  const byIssuer = new Map<string, { id: string; quirks: string }>()

  catalog.CATALOG.forEach((p, i) => {
    const path = catalog.FILE_NAMES[i] ?? "?"
    const file = `${PROVIDERS}/${path}.json`
    const [family = "", entry = ""] = path.split("/")

    if (p.id !== family && p.id !== `${family}-${entry}`)
      problems.push(
        `${file}: its id is "${p.id}": an entry's id is its family's folder name ("${family}", for the family's one entry or its MCP server) or <family>-<entry> ("${family}-${entry}"). Set one of those, or move the file to the folder its id names, then bun run providers index.`,
      )

    const urls = [
      ["url", p.url],
      ["docs", p.docs],
      ...(p.signIn === "oauth" ? [["issuer", p.issuer]] : []),
      ...(p.signIn === "oauth" && p.registration.kind === "admin"
        ? [["registration.registerAt", p.registration.registerAt]]
        : []),
      ...(p.signIn === "token" ? [["tokenAt", p.tokenAt]] : []),
      ...(p.signIn !== "token" && p.api?.spec !== undefined ? [["api.spec", p.api.spec]] : []),
    ]

    for (const [key = "", url = ""] of urls) {
      const why = publicProblem(url)

      if (why !== undefined)
        problems.push(
          `${file}: "${key}" ${why}. A shipped provider points only at https on a public host; a test server goes in a check (scripts/verify/checks/catalog.ts adds one by URL with "provider" for its defaults).`,
        )
    }

    const server = p.url.replace(/\/+$/, "")
    const twin = byUrl.get(server)

    if (twin !== undefined)
      problems.push(
        `${file}: its url is ${twin}'s too: one server is one provider. Keep one file (a second name for the same server is the admin's: bun run workspace connections add <name> --provider ${twin}).`,
      )
    else byUrl.set(server, p.id)

    if (p.signIn !== "oauth") return

    if (p.level === "read")
      for (const scope of p.scopes.filter((s) => CHANGES.test(s)))
        problems.push(
          `${file}: its level is "read", but the scope "${scope}" can change things. Ask only for scopes that read (the server's read or readonly ones), or set "level": "all" if people should change things by default.`,
        )

    const issuer = p.issuer.replace(/\/+$/, "")
    const quirks = JSON.stringify(catalog.quirksOf(p.id))
    const same = byIssuer.get(issuer)

    if (same !== undefined && same.quirks !== quirks)
      problems.push(
        `${file}: it signs in at ${issuer} like ${same.id}, but its quirks (or measured refreshRotates) differ, and a sign-in server has one set of quirks: make them the same in both files (${PROVIDERS_README}).`,
      )
    else byIssuer.set(issuer, { id: p.id, quirks })
  })
}

for (const [, copied] of read("Dockerfile").matchAll(/^COPY (scripts\/\S+\.ts) /gm)) {
  for (const [, name] of read(copied ?? "").matchAll(/^import [^;]*?from "([^"]+)"/gm)) {
    if (name !== undefined && !name.startsWith(".") && !/^(node|bun):/.test(name) && name !== "bun")
      problems.push(
        `${copied}: imports "${name}", and the image (Dockerfile) installs packages only where packages/platform resolves them, so this script can't load there (a container once failed to start for it). Import it through packages/platform/src (scripts/data.ts imports runtime/localdb.ts), or take what it needs from there.`,
      )
  }
}

// Every bun script one of ours starts gets a lifeline (packages/platform/src/runtime/lifeline.ts): stdin piped, and the script
// calls exitWithParent(), so it ends with its parent however the parent ends. Or the line before says why it mustn't:
// `// no lifeline: <why>`. And Chrome is driven over a pipe, never a port. Both because a parent that dies hard runs no cleanup:
// 240 headless Chromes and 15 test MCP servers were found running days after the runs that started them.
const LIFELINE = "packages/platform/src/runtime/lifeline.ts"

/** The text of the call whose "(" is at `open`, through its ")" (strings and comments skipped). */
const callAt = (text: string, open: number) => {
  let depth = 0

  for (let at = open; at < text.length; at++) {
    const c = text[at]

    if (c === '"' || c === "'" || c === "`") {
      for (at++; at < text.length && text[at] !== c; at++) if (text[at] === "\\") at++
    } else if (c === "/" && text[at + 1] === "/") {
      at = text.indexOf("\n", at)

      if (at === -1) break
    } else if (c === "(") depth++
    else if (c === ")" && --depth === 0) return text.slice(open, at + 1)
  }

  return text.slice(open)
}

const sourceFiles = files.filter(
  (f) => (f.startsWith("scripts/") || f.startsWith(PLATFORM)) && f.endsWith(".ts"),
)

for (const f of sourceFiles) {
  const text = read(f)

  for (const m of text.matchAll(
    /\b(?:Bun\.spawn|spawn)(\()\s*\[\s*(?:"bun"|process\.execPath)\s*,\s*([^,\]\n]+)/g,
  )) {
    const at = m.index + m[0].indexOf("(")
    const line = text.slice(0, at).split("\n").length
    const before = text.slice(0, at).split("\n").slice(-3).join("\n")
    const call = callAt(text, at)
    const script = (m[2] ?? "").trim()
    const where = `${f}:${line}`

    // bun's own commands (install, x, run): not a script of ours
    if (/^"(?:install|add|x|run|--version)"/.test(script)) continue

    if (before.includes("// no lifeline:")) continue

    // "pipe", or a choice that can be "pipe" (one that may outlive this process says when: dummy-mcp.ts's outlive)
    if (!/\bstdin:[^,\n]*"pipe"/.test(call)) {
      problems.push(
        `${where} starts a bun script with no lifeline: when this process dies hard (SIGKILL, a crash, a killed verify run), it runs on. Spawn it with stdin: "pipe" and call exitWithParent() at its top (${LIFELINE}); if it must outlive this process, say why on the line before: // no lifeline: <why>.`,
      )
      continue
    }

    if (script === '"-e"') {
      if (!call.includes('process.stdin.on("end"'))
        problems.push(
          `${where} runs inline code (bun -e) with stdin piped but never ends on it: add process.stdin.on("end", () => process.exit(0)); process.stdin.resume(); process.stdin.unref() to the code.`,
        )
      continue
    }

    const target =
      script === "import.meta.path"
        ? f
        : (() => {
            const tail = /"([^"]+\.ts)"/.exec(call)?.[1]?.replace(/^(?:\.\.?\/)+/, "")

            return tail === undefined ? undefined : sourceFiles.find((g) => g.endsWith(tail))
          })()

    if (target === undefined)
      problems.push(
        `${where} pipes stdin to a bun script the guard can't find from the call: name its file in a string literal ("scripts/x.ts", or join(import.meta.dir, "x.ts")), so it can check that file calls exitWithParent().`,
      )
    else if (!read(target).includes("exitWithParent("))
      problems.push(
        `${where} pipes stdin to ${target}, which never calls exitWithParent() (${LIFELINE}): call it at its top, so it ends when ${f} does.`,
      )
  }

  if (f !== "scripts/guard.ts" && text.includes('"--remote-debugging-port'))
    problems.push(
      `${f} starts Chrome with --remote-debugging-port: use --remote-debugging-pipe, so Chrome quits when this process ends however it ends (${LIFELINE}).`,
    )
}

const legacyWordsAllowed = new Set([
  "scripts/guard.ts",
  "GLOSSARY.md",
  "packages/platform/storage.json",
  "packages/platform/src/runtime/workspace-upgrade.ts",
  "scripts/verify/checks/workspace-upgrade.ts",
])

for (const file of files) {
  if (
    legacyWordsAllowed.has(file) ||
    file.includes("/vendor/") ||
    !/\.(?:ts|rs|md|json|ya?ml|html)$/.test(file)
  )
    continue

  const text = read(file)
    .replaceAll(/https?:[^\s<>"'`]+/g, "")
    .replaceAll(/read:org|org:read|organizations:read/g, "")

  const words =
    `${file}\n${text}`.match(/[A-Z]+(?=[A-Z][a-z]|[^A-Za-z]|$)|[A-Z]?[a-z]+|[A-Z]+/g) ?? []

  if (
    words.some((word) =>
      ["org", "orgs", "organization", "organizations"].includes(word.toLowerCase()),
    )
  )
    problems.push(
      `${file}: use workspace terminology in first-party code, contracts, and prose; legacy names belong only in the workspace migration, and upstream identifiers keep their provider's spelling.`,
    )
}

for (const file of files.filter(
  (f) => f.startsWith(PLATFORM) && f.endsWith(".ts") && f !== `${PLATFORM}theme.ts`,
)) {
  if (/localStorage\.(?:getItem|setItem|removeItem)\(["']openbelt-theme["']/.test(read(file)))
    problems.push(
      `${file}: use THEME_SCRIPT from theme.ts and the person's shared preference; only theme.ts may read legacy browser theme storage during migration.`,
    )
}

// Helper text: the small print under headings, rows and fields. Past eight words it is usually a
// sentence that explains what the page already shows (brand/WRITING.md: say each thing once; a
// footnote belongs in the docs). COPY_KEPT holds the longer ones kept on purpose (errors, setup
// steps, consent, empty states); it only shrinks.
const COPY_WORDS = 8

const COPY_KEPT = new Set<string>([
  "${escape(p.name)} is already added as ${escape(p.id)}. Add it again under another name, for a second account or workspace.",
  "${escape(workspace)} has no group of that name: it may have been deleted.",
  "Ask your agent to call an OpenBelt tool, then refresh.",
  "Claude Code and pi sign in only over https or to localhost, so here they need a token.",
  "Disconnect to stop agents and apps using it at once.",
  "Give the app this URL as its callback (redirect) URL.",
  "Go back to your agent; you can close this tab.",
  "It uses the ${escape(maker)} OAuth app your workspace already set up.",
  "Nobody can connect ${escape(label)} until an admin registers an OAuth app at ${escape(maker)}.",
  "None yet. Make one for each agent you use, so you can revoke one alone.",
  "None yet. Make one for your directory, then paste it there with the base URL.",
  "None yet. When an app asks to use one of your connections, you allow it here.",
  "Nothing set: it gets the workspace default on every connection.",
  "Once per workspace. You can also do it later, on its page.",
  "Paste both into your directory's provisioning settings. OpenBelt shows the token once.",
  "Paste it here, never into a chat with an agent.",
  "Replace its client ID and secret, after rotating them at ${escape(maker)}",
  "Signed in as ${escape(c.email)}. Your agent made this workspace and its apps; claimed, it's yours: you're its admin, its apps open for you and whoever you invite, and the agent goes on working, as you.",
  "Signed in as ${escape(c.person.email)}. Your apps, data and connections live in it; you're its first admin, and others join when you invite them.",
  "There are no connections yet, so nothing to set.",
  "They're in once they open ${escape(workspace)}, signed in as that email.",
  "Your access to ${escape(label)} is off, so ${app} can",
  "Your directory decides who's in it; you decide what it can use.",
  "Your own account, or the workspace's while you have none.",
])

const copyWords = (text: string) =>
  text
    .replaceAll(/\$\{[^}]*\}/g, " X ")
    .replaceAll(/<[^>]*>/g, " ")
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length

const copySeen = new Set<string>()

for (const file of files.filter((f) => f.startsWith(PLATFORM) && f.endsWith(".ts"))) {
  const source = read(file)

  const found = [
    ...[
      ...source.matchAll(
        /class=\\?"(?:[\w-]+ )*(?:small|sub|note|muted|hint|when|intro)(?: [\w-]+)*\\?">([^<'`"]*)/g,
      ),
    ].map((m) => m[1] ?? ""),
    ...[...source.matchAll(/(?<![\w.])sub\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map(
      (m) => m[2] ?? "",
    ),
  ]

  for (const text of found.flatMap((t) => (copyWords(t.trim()) > COPY_WORDS ? [t.trim()] : []))) {
    copySeen.add(text)

    if (!COPY_KEPT.has(text))
      problems.push(
        `${file}: "${text.slice(0, 80)}" is ${copyWords(text)} words of helper text. Cut it to ${COPY_WORDS} or fewer, or drop it: the page should explain itself and the docs hold the rest (brand/WRITING.md).`,
      )
  }
}

for (const text of COPY_KEPT)
  if (!copySeen.has(text))
    problems.push(
      `scripts/guard.ts: COPY_KEPT has "${text.slice(0, 80)}", which no page has any more: remove it.`,
    )

// The workspace host serves an app's page at /<app>, after its own routes. So each of those routes' first segment starts
// with _, has a dot, or is a reserved app name: otherwise an app of that name could never be opened. New routes start with _.
const { RESERVED_APP_NAMES } = await import("../packages/platform/src/model.ts")

/** The first path segments a regex literal starting `/^\/` matches, as plain lowercase names (none for `_x`, `x\.y`, `[^/]+`). */
const firstSegments = (pattern: string) => {
  const open = pattern.startsWith("(?:") ? 3 : pattern.startsWith("(") ? 1 : 0
  const alternatives: Array<string> = []

  if (open === 0) alternatives.push(pattern)
  else {
    let depth = 0
    let start = open

    for (let i = open; i < pattern.length; i++) {
      const c = pattern[i]

      if (c === "\\") i++
      else if (c === "(") depth++
      else if (c === ")" && depth-- === 0) {
        alternatives.push(pattern.slice(start, i))
        break
      } else if (c === "|" && depth === 0) {
        alternatives.push(pattern.slice(start, i))
        start = i + 1
      }
    }
  }

  return alternatives.flatMap((alt) => {
    const name = /^[a-z0-9][a-z0-9-]*/.exec(alt)?.[0]

    return name === undefined || alt.slice(name.length).startsWith("\\.") ? [] : [name]
  })
}

for (const file of [`${PLATFORM}gateway.ts`, `${PLATFORM}cli-dist.ts`]) {
  const text = read(file)

  const named = [
    ...[
      ...text.matchAll(
        /(?:path|pathname)\s*(?:===|\.startsWith\()\s*"\/([a-z0-9][a-z0-9-]*)(?=[/"])/g,
      ),
    ].map((m) => m[1] ?? ""),
    ...[...text.matchAll(/\/\^\\\/(\S+)/g)].flatMap((m) => firstSegments(m[1] ?? "")),
  ]

  for (const name of new Set(named))
    if (!RESERVED_APP_NAMES.has(name))
      problems.push(
        `${file}: the route /${name} on the workspace host would hide an app named "${name}" (its page is /<app>). Start the route with _, or add "${name}" to RESERVED_APP_NAMES in ${PLATFORM}model.ts.`,
      )
}

// A starter's gallery picture made ahead must show its files and data as they are (starters.ts): one of older ones would be shown
// for a starter that looks otherwise, so the platform ignores it, and it's made again here.
for (const starter of STARTERS)
  if (starter.picture.kind === "missing" || starter.picture.kind === "stale")
    problems.push(
      `packages/platform/starters/${starter.name}: its gallery picture is ${starter.picture.kind === "missing" ? "missing" : "of other files or data than it has now"}: run bun run starters:pictures and commit what it writes.`,
    )

if (problems.length > 0) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"))
  process.exit(1)
}
