// An app's skills (Agent Skills, https://agentskills.io): skills/<name>/SKILL.md and the files beside it, in the app's own files, and
// one OpenBelt writes for every app, on how to use it. Served over MCP's Skills extension (io.modelcontextprotocol/skills) as
// skill://<app>/<name>/SKILL.md and skill://<app>/SKILL.md: skills/list and skills/get give each one's manifest (every file's URI,
// SHA-256 and size, from the version's own hashes), resources/read its files (mcp.ts answers them).
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as YAML from "yaml"
import type { CollectionSummary, FunctionSummary, Json } from "./model.ts"

const SKILLS = "skills"

export const SKILL_FILE = "SKILL.md"

export const SCHEME = "skill://"

/** What a host must take (the extension's limits): more files or bytes than this in one skill is refused at deploy. */
const SKILL_LIMITS = { files: 512, bytes: 16 * 1024 * 1024, description: 1024 } as const

const SkillResource = Schema.Struct({
  uri: Schema.String,
  digest: Schema.String,
  size: Schema.Number,
})

/** A skill as skills/list and skills/get give it: its SKILL.md's URI, its frontmatter as written, and every file it has. */
const SkillEntry = Schema.Struct({
  uri: Schema.String,
  frontmatter: Schema.suspend(() => Frontmatter),
  resources: Schema.Array(SkillResource),
})

export type SkillEntry = typeof SkillEntry.Type

/** What an app tells others of its own skills: the directory and search show them. */
export type SkillSummary = { readonly name: string; readonly about: string }

/** A file of a skill, as resources/read gives it: text, or base64 for bytes that aren't. */
export type SkillFile =
  | { readonly uri: string; readonly mimeType: string; readonly text: string }
  | { readonly uri: string; readonly mimeType: string; readonly blob: string }

export const skillUri = (app: string, path: string) => `${SCHEME}${app}/${path}`

/** The skill OpenBelt writes about an app: skill://<app>/SKILL.md, named as the app is. */
const appSkillUri = (app: string) => skillUri(app, SKILL_FILE)

/**
 * Where a skill:// URI points: the app, and the file there. "SKILL.md" is the app's own skill (OpenBelt's); "<name>/<path>" is
 * skills/<name>/<path> in the app's live version.
 */
export const parseSkillUri = (uri: string) => {
  if (!uri.startsWith(SCHEME)) return undefined

  const [app, ...rest] = uri.slice(SCHEME.length).split("/")

  if (app === undefined || app === "" || rest.length === 0) return undefined

  if (rest.some((part) => part === "" || part === "." || part === "..")) return undefined

  return { app, path: rest.join("/") }
}

/** The app file a skill path (after skill://<app>/) names, or undefined for the app's own skill. */
export const filePathOf = (path: string) => (path === SKILL_FILE ? undefined : `${SKILLS}/${path}`)

const digestOf = (hash: string) => `sha256:${hash}`

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const nameProblem = (name: string) =>
  NAME.test(name) && !name.includes("--")
    ? undefined
    : `"${name}" isn't a skill name: use 1-64 lowercase letters, digits and single dashes, starting and ending with a letter or digit (e.g. "file-expense"), the same as its folder skills/<name>/`

/** A SKILL.md's frontmatter: the Agent Skills fields OpenBelt checks, and any others as written (served unchanged). */
const Frontmatter = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    license: Schema.optionalKey(Schema.String),
    compatibility: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    "allowed-tools": Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)

export type Frontmatter = typeof Frontmatter.Type

const decodeFields = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))

const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

const textOf = Schema.decodeUnknownOption(Schema.String)

const metadataOf = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String))

/** Why a field OpenBelt checks isn't what the Agent Skills spec asks, or undefined. */
const fieldProblem = (folder: string, front: Record<string, Json>) => {
  const name = textOf(front["name"])
  const description = Option.getOrElse(textOf(front["description"]), () => "")
  const compatibility = front["compatibility"]

  if (Option.isNone(name)) return `its frontmatter needs name: ${folder}`

  if (name.value !== folder)
    return `its name is "${name.value}" but its folder is skills/${folder}/: a skill's name is its folder's, so rename one to match`

  if (description.trim() === "")
    return "its frontmatter needs description: what the skill does and when to use it"

  const length = Array.from(new Intl.Segmenter().segment(description)).length

  if (length > SKILL_LIMITS.description)
    return `its description is ${length} characters; at most ${SKILL_LIMITS.description} (move the rest into the body)`

  if (
    compatibility !== undefined &&
    Option.getOrElse(textOf(compatibility), () => "x".repeat(501)).length > 500
  )
    return "compatibility must be text of at most 500 characters"

  if (front["license"] !== undefined && Option.isNone(textOf(front["license"])))
    return "license must be text"

  if (front["allowed-tools"] !== undefined && Option.isNone(textOf(front["allowed-tools"])))
    return 'allowed-tools must be one line of tool names separated by spaces, e.g. "Read Bash(git:*)"'

  if (front["metadata"] !== undefined && Option.isNone(metadataOf(front["metadata"])))
    return 'metadata must map names to text, e.g. metadata: { version: "1.0" }'

  return undefined
}

/**
 * The frontmatter at the top of a SKILL.md in skills/<folder>/ (for OpenBelt's own skill, the app's name), or why it isn't a valid
 * Agent Skill's.
 */
const frontmatterOf = (folder: string, text: string): Result.Result<Frontmatter, string> => {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)

  if (lines[0]?.trimEnd() !== "---")
    return Result.fail(
      'it must start with YAML frontmatter: a line "---", then "name: <name>" and "description: <what it does and when to use it>", then "---"',
    )

  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---")

  if (end === -1)
    return Result.fail('its frontmatter never ends: close it with a line "---" after its fields')

  const parsed = Result.try({
    try: (): Json =>
      JSON.parse(
        JSON.stringify(YAML.parse(lines.slice(1, end).join("\n"), { schema: "failsafe" }) ?? null),
      ),
    catch: (error) =>
      `its frontmatter isn't YAML OpenBelt can read (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); quote a value with ": " in it`,
  })

  return Result.flatMap(parsed, (json) =>
    Result.flatMap(
      Result.mapError(
        decodeFields(json),
        () =>
          "its frontmatter must be YAML fields (name: ..., description: ...), not a list or a value",
      ),
      (fields) => {
        const problem = fieldProblem(folder, fields)

        return problem === undefined
          ? Result.fromOption(decodeFrontmatter(fields), () => "its frontmatter isn't valid")
          : Result.fail(problem)
      },
    ),
  )
}

type Listed = { readonly hash: string; readonly size: number }

/** The skills a version's files hold: each folder under skills/, and its files (path after skills/<name>/). */
export const foldersOf = (files: ReadonlyMap<string, Listed>) => {
  const folders = new Map<string, Map<string, Listed>>()
  const loose: Array<string> = []

  for (const [path, entry] of files) {
    if (!path.startsWith(`${SKILLS}/`)) continue

    const [folder, ...rest] = path.slice(SKILLS.length + 1).split("/")

    if (folder === undefined || rest.length === 0) {
      loose.push(path)
      continue
    }

    const inside = folders.get(folder) ?? new Map<string, Listed>()

    inside.set(rest.join("/"), entry)
    folders.set(folder, inside)
  }

  return { folders, loose }
}

/**
 * Why a version's skills can't be served, each with what to change: deploy refuses the version on any. `read` gives a file's text
 * (undefined: not text).
 */
export const skillProblems = Effect.fnUntraced(function* <E, R>(
  app: string,
  files: ReadonlyMap<string, Listed>,
  read: (path: string) => Effect.Effect<string | undefined, E, R>,
) {
  const { folders, loose } = foldersOf(files)
  const problems: Array<string> = []

  for (const path of loose)
    problems.push(
      `"${path}": a file in skills/ belongs to a skill, in its own folder skills/<name>/ beside its SKILL.md`,
    )

  for (const [folder, inside] of folders) {
    const at = `skills/${folder}/${SKILL_FILE}`
    const named = nameProblem(folder)

    if (named !== undefined) {
      problems.push(`skills/${folder}/: ${named}`)
      continue
    }

    if (folder === app) {
      problems.push(
        `skills/${folder}/: a skill can't be named as its app: OpenBelt serves skill://${app}/SKILL.md, the app's own skill on how to use it, by that name. Name it for what it does, e.g. skills/${app}-report/`,
      )
      continue
    }

    if (inside.size > SKILL_LIMITS.files)
      problems.push(
        `skills/${folder}/ has ${inside.size} files; a skill has at most ${SKILL_LIMITS.files}`,
      )

    const bytes = [...inside.values()].reduce((sum, f) => sum + f.size, 0)

    if (bytes > SKILL_LIMITS.bytes)
      problems.push(`skills/${folder}/ holds ${bytes} bytes; a skill holds at most 16 MiB`)

    if (!inside.has(SKILL_FILE)) {
      problems.push(
        `skills/${folder}/ has no ${SKILL_FILE}: a skill is a folder with a SKILL.md (frontmatter name: ${folder} and description, then its instructions) and the files it refers to`,
      )
      continue
    }

    const text = yield* read(at)

    if (text === undefined) {
      problems.push(`${at} isn't UTF-8 text`)
      continue
    }

    const problem = Result.match(frontmatterOf(folder, text), {
      onSuccess: () => undefined,
      onFailure: (why) => why,
    })

    if (problem !== undefined) problems.push(`${at}: ${problem}`)
  }

  return problems
})

/** A skill's manifest entry: its SKILL.md first, then its other files by path. */
export const entryOf = (
  app: string,
  folder: string,
  inside: ReadonlyMap<string, Listed>,
  frontmatter: Frontmatter,
): SkillEntry => ({
  uri: skillUri(app, `${folder}/${SKILL_FILE}`),
  frontmatter,
  resources: [...inside]
    .toSorted(([a], [b]) => (a === SKILL_FILE ? -1 : b === SKILL_FILE ? 1 : a.localeCompare(b)))
    .map(([path, f]) => ({
      uri: skillUri(app, `${folder}/${path}`),
      digest: digestOf(f.hash),
      size: f.size,
    })),
})

const firstLine = (text: string) => text.split("\n")[0] ?? ""

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

const yamlString = (text: string) => JSON.stringify(text)

/** Rules that let nobody do what they guard. */
const CLOSED = new Set(["nobody", "false"])

/** Whether a collection's rules let no page or agent write it: only the app's functions do. */
const closed = (c: CollectionSummary) =>
  c.rules !== null &&
  [c.rules.create, c.rules.update, c.rules.delete].every((rule) => CLOSED.has(rule.trim()))

export type AppFacts = {
  readonly app: string
  readonly url: string
  readonly description: string
  readonly collections: ReadonlyArray<CollectionSummary>
  readonly functions: ReadonlyArray<FunctionSummary>
  readonly uses: ReadonlyArray<string>
  readonly skills: ReadonlyArray<SkillSummary>
}

/** The skill OpenBelt writes for every app: what it is, its data and functions, and how an agent or another app's page uses them. */
export const appSkill = (facts: AppFacts) => {
  const { app, url, collections, functions, skills } = facts
  const about = facts.description.trim()

  const has = [
    collections.length === 0 ? "" : `its data (${collections.map((c) => c.name).join(", ")})`,
    functions.length === 0 ? "" : `its functions (${functions.map((f) => f.name).join(", ")})`,
  ].filter((part) => part !== "")

  const description = clip(
    `Using ${app}, an app on OpenBelt${about === "" ? "" : ` (${firstLine(about).replace(/\.$/, "")})`}. Use when you read or change ${has.length === 0 ? "it" : has.join(" or call ")}, or build an app on top of it.`,
    SKILL_LIMITS.description,
  )

  const open = collections.filter((c) => !closed(c))

  const writes =
    open.length === 0
      ? `Its rules let no page or agent write ${collections.length === 1 ? "it" : "them"}: change ${collections.length === 1 ? "it" : "them"} through its functions.`
      : `An agent writes ${open.length === collections.length ? "them" : open.map((c) => `\`${c.name}\``).join(", ")}, as the rules allow, with \`collection_add\`, \`collection_update\` and \`collection_delete\`${open.length === collections.length ? "" : "; the others change only through its functions"}.`

  const data =
    collections.length === 0
      ? ["It keeps no data yet."]
      : [
          ...collections.map((c) => {
            const rules =
              c.rules === null
                ? "no rules: anyone may read and write"
                : closed(c)
                  ? `read: ${c.rules.read}; only its functions change it`
                  : `read: ${c.rules.read}, create: ${c.rules.create}, update: ${c.rules.update}, delete: ${c.rules.delete}`

            return `- \`${c.name}\`${c.about === null ? "" : `: ${c.about}`} (${rules}${c.writable ? "; other apps' pages may write it" : ""})`
          }),
          "",
          `An agent reads them with \`collection_list({ app: "${app}", collection })\`. ${writes} Another app's page reads them with \`db.app("${app}").collection(name)\`, the same API as its own \`db.collection\`, and writes only to the ones marked writable.`,
        ]

  const calls =
    functions.length === 0
      ? []
      : [
          "",
          "## Functions",
          "",
          ...functions.map(
            (f) =>
              `- \`${f.signature}\` (${f.kind}): ${firstLine(f.about)}${f.call === null ? " Only the app itself runs it." : ""}`,
          ),
          "",
          `An agent runs one with \`call_function({ app: "${app}", function, input })\` ; another app's page with \`await db.app("${app}").fn(name, input)\`. Each run is all or nothing; pass a key when a retry must not run it twice.`,
        ]

  const reaches =
    facts.uses.length === 0
      ? []
      : ["", `Its functions call the workspace's connections: ${facts.uses.join(", ")}.`]

  const own =
    skills.length === 0
      ? []
      : [
          "",
          "## Its skills",
          "",
          ...skills.map((s) => `- [${s.name}](${s.name}/SKILL.md): ${firstLine(s.about)}`),
        ]

  return [
    "---",
    `name: ${yamlString(app)}`,
    `description: ${yamlString(description)}`,
    "---",
    "",
    `# ${app}`,
    "",
    about === "" ? `An OpenBelt app, at ${url}.` : `${about}\n\nIt's at ${url}.`,
    "",
    "## Data",
    "",
    ...data,
    ...calls,
    ...reaches,
    ...own,
    "",
    "## More",
    "",
    `\`app_info({ app: "${app}" })\` gives all of it (each collection's sample document, each function's schemas and last run, schedules, webhooks, versions); \`app_files({ app: "${app}" })\` its source. Search the workspace first with \`search({ query })\` before building something it may already have.`,
    "",
  ].join("\n")
}

const sha256 = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).pipe(
    Effect.map((digest) => new Uint8Array(digest).toHex()),
  )

/** The app's own skill's entry, from its text: one file, hashed as served. */
export const appSkillEntry = Effect.fnUntraced(function* (app: string, text: string) {
  const bytes = new TextEncoder().encode(text)

  const frontmatter = Result.getOrElse(frontmatterOf(app, text), (): Frontmatter => ({
    name: app,
    description: "",
  }))

  const entry: SkillEntry = {
    uri: appSkillUri(app),
    frontmatter,
    resources: [
      { uri: appSkillUri(app), digest: digestOf(yield* sha256(bytes)), size: bytes.length },
    ],
  }

  return entry
})

const MIME_PARAMS = /;.*$/

/** A file's bytes as resources/read gives them: UTF-8 text as text, anything else as base64. */
export const skillFileOf = (uri: string, contentType: string, bytes: Uint8Array): SkillFile => {
  const mimeType = contentType.replace(MIME_PARAMS, "")

  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)

    if (!text.includes("\u0000"))
      return {
        uri,
        mimeType: mimeType === "application/octet-stream" ? "text/plain" : mimeType,
        text,
      }
  } catch {
    // not text: sent as base64 below
  }

  return { uri, mimeType, blob: bytes.toBase64() }
}

const fronts = new Map<string, Frontmatter | undefined>()

/**
 * A valid SKILL.md's frontmatter in skills/<folder>/, by the file's hash (a pure function of its bytes and folder, so a kept copy
 * is never stale), or undefined: one deployed before skills were checked can be anything.
 */
export const frontmatterByHash = Effect.fnUntraced(function* <E, R>(
  folder: string,
  hash: string,
  read: Effect.Effect<Uint8Array | undefined, E, R>,
) {
  const key = `${folder}/${hash}`

  if (fronts.has(key)) return fronts.get(key)

  const bytes = yield* read
  const text = bytes === undefined ? "" : new TextDecoder().decode(bytes)
  const front = Result.getOrUndefined(frontmatterOf(folder, text))

  if (fronts.size >= 1024) fronts.delete(fronts.keys().next().value ?? "")

  fronts.set(key, front)

  return front
})
