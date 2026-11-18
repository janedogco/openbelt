import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { dataLimits, dataDiskFree } from "./runtime/files.ts"
import { recordRefused } from "./runtime/metrics.ts"
import { sizeOf } from "./files.ts"
import { unifiedDiff } from "./diff.ts"
import { applyEdits, clipDiff, CUT_NOTE, type EditTarget, excerpts } from "./edits.ts"
import { connectionsNamedIn, hostsFetchedIn, secretsNamedIn } from "./capabilities.ts"
import { member } from "./contracts.ts"
import { functionPath } from "./functions.ts"
import { skillProblems } from "./skills.ts"
import type { FileContent, LogLine, AppEdit, AppFile, VersionEntry } from "./model.ts"
import { CONFIG_LIMITS, contractOf, Refused, AppConfig, PublicBlock, secretsOf } from "./model.ts"
import { publicProblems } from "./public.ts"

const KEEP = 20

const MAX_FILE = 1_000_000

const MAX_EXPORT = 400_000

const MAX_FILE_DIFF = 3000

const MAX_DIFF = 10_000

type Entry = { readonly hash: string; readonly size: number }

type Files = ReadonlyMap<string, Entry>

type Version = {
  readonly version: string
  readonly kind: VersionEntry["kind"]
  readonly anchor: string | null
  readonly deployedAt: string
  readonly deployedBy: string
  readonly promotedAt: string | null
  readonly promotedBy: string | null
  readonly files: Files
}

type Row = {
  version: string
  files: string
  kind: string
  anchor: string | null
  deployed_at: string
  deployed_by: string
  promoted_at: string | null
  promoted_by: string | null
}

const COLUMNS = "version, files, kind, anchor, deployed_at, deployed_by, promoted_at, promoted_by"

const FileList = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ path: Schema.String, hash: Schema.String, size: Schema.Number })),
)

const decodeFiles = Schema.decodeUnknownSync(FileList)

const encodeFiles = Schema.encodeSync(FileList)

/**
 * A version's files, decoded once per stored list: every page and data request reads the live version, and decoding its list each
 * time (JSON and its schema) was about 2% of a platform's CPU under load. The list is a pure function of the stored text, and the
 * map is read-only, so one decoded copy is shared.
 */
const filesSeen = new Map<string, Files>()

const FILES_KEPT = 512

const filesOf = (text: string): Files => {
  const seen = filesSeen.get(text)

  if (seen !== undefined) return seen

  const files: Files = new Map(
    decodeFiles(text).map((f) => [f.path, { hash: f.hash, size: f.size }]),
  )

  if (filesSeen.size >= FILES_KEPT) filesSeen.delete(filesSeen.keys().next().value ?? "")

  filesSeen.set(text, files)

  return files
}

/**
 * Files' bytes by hash, for this process: a page, a function's code and openbelt.json were read from the object's database on every
 * request (a write's live queries read 8 a request). A blob's hash is of its bytes, so a kept copy is never stale, and one copy serves
 * every object that lists it (an object only asks for hashes its own versions list). Bounded by bytes, oldest first out; callers
 * read the bytes, never change them.
 */
const bodies = new Map<string, Uint8Array>()

const BODY_BYTES = 64 * 1024 * 1024

let bodyBytes = 0

const keepBody = (hash: string, bytes: Uint8Array) => {
  if (bytes.byteLength > BODY_BYTES / 64 || bodies.has(hash)) return

  bodies.set(hash, bytes)
  bodyBytes += bytes.byteLength

  for (const [oldest, kept] of bodies) {
    if (bodyBytes <= BODY_BYTES) break

    bodies.delete(oldest)
    bodyBytes -= kept.byteLength
  }
}

const toVersion = (row: Row): Version => ({
  version: row.version,
  kind: row.kind === "patch" ? "patch" : "full",
  anchor: row.anchor,
  deployedAt: row.deployed_at,
  deployedBy: row.deployed_by,
  promotedAt: row.promoted_at,
  promotedBy: row.promoted_by,
  files: filesOf(row.files),
})

const anchorOf = (v: Version) => (v.promotedAt === null ? v.anchor : v.version)

const differing = (a: Files, b: Files) => {
  const paths = new Set([...a.keys(), ...b.keys()])
  const out: Array<string> = []

  for (const path of paths) if (a.get(path)?.hash !== b.get(path)?.hash) out.push(path)

  return out.toSorted()
}

const sha256 = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).pipe(
    Effect.map((digest) => new Uint8Array(digest).toHex()),
  )

const versionOf = (files: Files) =>
  sha256(
    new TextEncoder().encode(
      JSON.stringify([...files.keys()].toSorted().map((path) => [path, files.get(path)?.hash])),
    ),
  ).pipe(Effect.map((hash) => hash.slice(0, 12)))

const CONFIG = "openbelt.json"

const decodeConfig = Schema.decodeUnknownResult(Schema.fromJsonString(AppConfig))

const CONFIG_EXAMPLE = `{"description": "one line about the app", "collections": {"expenses": "one doc per expense: {payer, cents, for: [names]}"}, "writable": ["expenses"]}`

const MAX_CONFIG_DEPTH = 32

const depthOf = (text: string) => {
  let depth = 0
  let deepest = 0
  let inString = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (inString) {
      if (c === "\\") i += 1
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === "{" || c === "[") deepest = Math.max(deepest, ++depth)
    else if (c === "}" || c === "]") depth -= 1
  }

  return deepest
}

const decodeObjectOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const decodePublic = Schema.decodeUnknownResult(PublicBlock)

const PUBLIC_EXAMPLE = `"public": {"collections": {"scores": ["read", "create"]}, "functions": {"play": {"secrets": [], "uses": []}}}`

/** openbelt.json "public" alone, so a mistake there is told in its own words rather than as the whole file's shape. */
const publicBlockProblem = (text: string) => {
  const object = decodeObjectOf(text)

  if (Option.isNone(object) || !Object.hasOwn(object.value, "public")) return undefined

  return Result.match(decodePublic(object.value["public"], { onExcessProperty: "error" }), {
    onSuccess: () => undefined,
    onFailure: (e) =>
      `openbelt.json "public" isn't valid: ${e.message.replaceAll("Expected no excess property", "unknown key").replaceAll(/\s*\n\s*/g, " ")}. Its shape is ${PUBLIC_EXAMPLE}: each collection with the ops anyone may do there ("read", "create", "update", "delete"), each function with the secrets and connections ("uses") it may use when anyone calls it, [] for none. "public": {} makes only the app's files public (docs({ page: "apps", section: "Public apps" }))`,
  })
}

const parseWhole = (text: string, publicProblem: string | undefined) =>
  publicProblem !== undefined
    ? Result.fail(publicProblem)
    : depthOf(text) > MAX_CONFIG_DEPTH
      ? Result.fail(
          `openbelt.json nests ${depthOf(text)} levels deep, more than the ${MAX_CONFIG_DEPTH} it may: a function's input or output schema rarely needs more than a few. Flatten it, or describe the deep part as {"type": "object"}`,
        )
      : Result.mapError(
          decodeConfig(text, { onExcessProperty: "error" }),
          (e) =>
            `openbelt.json isn't valid: ${e.message.replaceAll("Expected no excess property", "unknown key").replaceAll(/\s*\n\s*/g, " ")}. All of it is optional; its shape is ${CONFIG_EXAMPLE} (collections: what a document in each holds; writable: collections other apps' pages may write to; rules: who may read, create, update and delete in each collection, all four when it has any, e.g. "rules": {"polls": {"read": "anyone", "create": "signedIn", "update": "doc.author == me", "delete": "doc.author == me"}}, see docs({ page: "rules" }); tools: the connection tools its pages call with tools.call, and whose credential each runs with, e.g. "tools": {"linear.list_issues": "viewer", "deepwiki.ask_wiki_question": "workspace"}; functions: each server function, functions/<name>.js, with a line on what it does, its input and result, e.g. "functions": {"vote": "records the caller's vote. input: {option}; returns {counts}"}; schedules: functions the live version runs on a cron, e.g. "schedules": {"digest": {"cron": "0 9 * * 1-5", "timezone": "America/Denver"}}; webhooks: functions outside systems POST to, e.g. "webhooks": {"build": {"verify": "hmac-sha256"}}; triggers: functions run after a change to a collection, e.g. "triggers": {"notify": {"on": "add:members"}}; secrets: API keys its functions send, set with set_secret, e.g. "secrets": {"MAPS_API_KEY": "the maps service's key"} or {"MAPS_API_KEY": {"for": "the maps service's key", "hosts": ["api.example.com"]}}; network: the hosts its functions may fetch, e.g. "network": ["api.example.com", "localhost:4599"]; uses: the workspace's connections its functions call, e.g. "uses": {"deepwiki": "answers questions about a repo"}; card: what a link preview shows to someone not signed in, "private" (the default: the workspace only) or "public" (the app's own card: its name, description and a look at its page); color: the colour of its link preview card, e.g. "color": "#2563eb"; public: the app for anyone on the public host, with what they may reach, e.g. ${PUBLIC_EXAMPLE}; a function's entry can also be {"description": "...", "kind": "query", "internal": true, "input": {JSON Schema}, "output": {JSON Schema}}, where internal: true lets only the app's own code run it). Limits: description up to ${CONFIG_LIMITS.description} characters, each collection's line up to ${CONFIG_LIMITS.collection}, each function's up to ${CONFIG_LIMITS.function}; collection names are 1-40 lowercase letters, digits, "_" and "-".`,
        )

const parseConfig = (text: string) => parseWhole(text, publicBlockProblem(text))

const KNOWN_KEYS = new Set(Object.keys(AppConfig.fields))

const decodeObject = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const decodeKnown = Schema.decodeUnknownResult(AppConfig)

export type StoredConfig =
  | {
      readonly kind: "read"
      readonly config: AppConfig
      readonly skipped: ReadonlyArray<string>
    }
  | { readonly kind: "unreadable"; readonly problem: string }

const readConfig = (text: string, version: string): StoredConfig => {
  const unreadable = (why: string): StoredConfig => ({
    kind: "unreadable",
    problem: `the openbelt.json of version ${version} isn't one this OpenBelt can read (${why.replaceAll(/\s*\n\s*/g, " ")}), probably written by a later OpenBelt: until the app is deployed again, its rules refuse every page read and write, and its functions don't run. Deploy it again (deploy_app); this OpenBelt says what in openbelt.json it doesn't take`,
  })

  return Result.match(decodeObject(text), {
    onFailure: (e) => unreadable(e.message),
    onSuccess: (object) =>
      Result.match(
        decodeKnown(
          Object.fromEntries(Object.entries(object).filter(([key]) => KNOWN_KEYS.has(key))),
          { onExcessProperty: "error" },
        ),
        {
          onFailure: (e) => unreadable(e.message),
          onSuccess: (config): StoredConfig => ({
            kind: "read",
            config,
            skipped: Object.keys(object).filter((key) => !KNOWN_KEYS.has(key)),
          }),
        },
      ),
  })
}

export const fromLaterOpenBelt = (stored: StoredConfig) =>
  stored.kind === "unreadable" || stored.skipped.length > 0

export const settingsOf = (stored: StoredConfig): AppConfig =>
  stored.kind === "read" ? stored.config : {}

const configProblem = (bytes: Uint8Array) =>
  Result.match(parseConfig(asText(bytes) ?? ""), {
    onSuccess: () => undefined,
    onFailure: (problem) => problem,
  })

const fromBase64 = (text: string) => {
  try {
    return Uint8Array.fromBase64(text)
  } catch {
    return undefined
  }
}

const asText = (bytes: Uint8Array) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)

    return text.includes("\u0000") ? undefined : text
  } catch {
    return undefined
  }
}

const pathProblem = (path: string) => {
  const parts = path.split("/")

  if (path.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) {
    return `"${path}": use a relative path inside the app, like "index.html" or "css/app.css"`
  }

  if (parts.some((part) => part.startsWith("_"))) {
    return `"${path}": names starting with "_" are reserved by the platform (the app's /_db, /_ws, /_log, /_shot and /_preview routes)`
  }

  if (parts.length > 1 && parts[0] === "a") {
    return `"${path}": the folder "a" is reserved by the platform: /a/<app>/ on an app's host is another app's data (db.app); put these files in another folder`
  }

  return undefined
}

type Hooks = {
  readonly checkStorage: (trace: string) => Effect.Effect<void, Refused>
  /** The app's name: a skill can't take it (its own skill, OpenBelt's, has it). */
  readonly name: () => string
  readonly log: (level: LogLine["level"], trace: string, message: string) => Effect.Effect<void>
  readonly wentLive: (version: string) => Effect.Effect<void>
  readonly pinned: () => Effect.Effect<ReadonlyArray<string>>
  readonly vet: (
    functions: ReadonlyArray<{
      readonly name: string
      readonly hash: string
      readonly code: string
    }>,
  ) => Effect.Effect<ReadonlyMap<string, string>>
}

type Review = {
  readonly from: string | null
  readonly paths: ReadonlyArray<string>
  readonly text: string
}

type Part = {
  readonly lines: string | undefined
  readonly around: string | undefined
  readonly context: number
}

export type DeployRequest = {
  readonly files: ReadonlyArray<AppFile> | undefined
  readonly keepOthers: boolean
  readonly remove: ReadonlyArray<string>
  readonly edits: ReadonlyArray<AppEdit>
  readonly base: string | undefined
  readonly env: string | undefined
  readonly by: string
  readonly trace: string
}

export const openVersions = Effect.fn("Versions.open")(function* (
  storage: DurableObjectStorage,
  hooks: Hooks,
) {
  const { sql, kv } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, body BLOB NOT NULL)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS versions (
    version TEXT PRIMARY KEY, files TEXT NOT NULL, kind TEXT NOT NULL, anchor TEXT,
    deployed_at TEXT NOT NULL, deployed_by TEXT NOT NULL, promoted_at TEXT, promoted_by TEXT,
    n INTEGER NOT NULL)`)

  /**
   * The versions read since the last write to the table. Every request reads its version (its openbelt.json, rules, functions) many
   * times: a data list 23 times and a write 17, each a SQL statement through the object's queue. A version's files never change (its
   * name is their hash); its other columns change only by the writes below, which forget them, as does the end of each turn that
   * writes (deploy, promote, restore), so a version a failed deploy inserted and rolled back isn't remembered.
   */
  const known = new Map<string, Version>()

  const forget = Effect.sync(() => known.clear())

  const get = Effect.fnUntraced(function* (version: string) {
    const seen = known.get(version)

    if (seen !== undefined) return seen

    const [row] = yield* (yield* sql.exec<Row>(
      `SELECT ${COLUMNS} FROM versions WHERE version = ?`,
      version,
    )).toArray()

    if (row === undefined) return undefined

    const found = toVersion(row)

    known.set(version, found)

    return found
  })

  const liveName = () => kv.get<string>("live")

  const live = Effect.fnUntraced(function* () {
    const name = liveName()

    return name === undefined ? undefined : yield* get(name)
  })

  const next = Effect.fnUntraced(function* () {
    const [row] = yield* (yield* sql.exec<{ n: number }>(
      "SELECT COALESCE(MAX(n), 0) + 1 AS n FROM versions",
    )).toArray()

    return row?.n ?? 1
  })

  const body = Effect.fnUntraced(function* (hash: string) {
    const kept = bodies.get(hash)

    if (kept !== undefined) return kept

    const [row] = yield* (yield* sql.exec<{ body: ArrayBuffer }>(
      "SELECT body FROM blobs WHERE hash = ?",
      hash,
    )).toArray()

    if (row === undefined) return undefined

    const bytes = new Uint8Array(row.body)

    keepBody(hash, bytes)

    return bytes
  })

  const fileDiff = Effect.fnUntraced(function* (
    path: string,
    before: Version | undefined,
    after: Version,
    max: number,
  ) {
    const a = before?.files.get(path)
    const b = after.files.get(path)
    const label = (v: Version | undefined) => `${path} (${v?.version ?? "no version"})`

    if (b === undefined) return `--- ${label(before)}\n(deleted in ${after.version})`

    const oldBytes = a === undefined ? new Uint8Array() : yield* body(a.hash)
    const newBytes = yield* body(b.hash)
    const oldText = oldBytes === undefined ? undefined : asText(oldBytes)
    const newText = newBytes === undefined ? undefined : asText(newBytes)

    if (oldText === undefined || newText === undefined) {
      return `${path}: binary file changed (${a?.size ?? 0} → ${b.size} bytes)`
    }

    return unifiedDiff({ before: label(before), after: label(after) }, oldText, newText, max)
  })

  const reviewDiff = Effect.fnUntraced(function* (
    before: Version | undefined,
    after: Version,
    paths: ReadonlyArray<string>,
  ) {
    const parts = yield* Effect.forEach(paths, (path) =>
      fileDiff(path, before, after, Number.POSITIVE_INFINITY),
    )

    const text = parts
      .filter((part) => part !== "")
      .map(clipDiff)
      .join("\n")

    return text.includes("⟪… ") ? `${text}\n${CUT_NOTE}` : text
  })

  const conflict = Effect.fnUntraced(function* (
    base: string,
    anchor: Version | undefined,
    current: Version,
    paths: ReadonlyArray<string>,
    patch: boolean,
    trace: string,
  ) {
    const diffs = yield* Effect.forEach(paths, (path) =>
      fileDiff(path, anchor, current, MAX_FILE_DIFF),
    )

    let shown = diffs.join("\n\n")

    if (shown.length > MAX_DIFF) shown = `${shown.slice(0, MAX_DIFF)}\n... (diff cut short)`

    const who = `${current.promotedBy ?? current.deployedBy} at ${current.promotedAt ?? current.deployedAt}`

    const what = patch
      ? `It changed files you change too: ${paths.join(", ")}.`
      : `A full deploy would undo their changes to ${paths.join(", ")}. To change only some files, send just those with keep_others: true.`

    yield* hooks.log(
      "warn",
      trace,
      `deploy refused: base_version ${base} is behind live ${current.version} (${paths.join(", ")})`,
    )

    return yield* new Refused({
      message: `the live app changed since base_version ${base}: the live version is now ${current.version}, made live by ${who}. ${what} Nothing was deployed. Read the current files with app_files, re-apply your change to them, and deploy again with base_version "${current.version}". What changed since your base:\n\n${shown}`,
    })
  })

  const prune = Effect.fnUntraced(function* () {
    yield* sql.exec(
      `DELETE FROM versions WHERE version NOT IN (SELECT version FROM versions ORDER BY n DESC LIMIT ?) AND version NOT IN (SELECT value FROM json_each(?))`,
      KEEP,
      JSON.stringify([liveName() ?? "", ...(yield* hooks.pinned())]),
    )
    yield* forget
    yield* sql.exec(
      `DELETE FROM blobs WHERE hash NOT IN (SELECT json_extract(f.value, '$.hash') FROM versions, json_each(versions.files) AS f)`,
    )
  })

  const bytesOf = Effect.fnUntraced(function* (
    files: Map<string, Entry>,
    fresh: Map<string, Uint8Array>,
    path: string,
  ) {
    const entry = files.get(path)

    if (entry === undefined) return undefined

    return fresh.get(entry.hash) ?? (yield* body(entry.hash))
  })

  const functionProblems = Effect.fnUntraced(function* (
    files: Map<string, Entry>,
    fresh: Map<string, Uint8Array>,
  ) {
    const configBytes = yield* bytesOf(files, fresh, CONFIG)
    const parsed = configBytes === undefined ? undefined : parseConfig(asText(configBytes) ?? "")

    const config = parsed === undefined ? {} : Result.getOrElse(parsed, (): AppConfig => ({}))
    const listed = Object.keys(config.functions ?? {})
    const problems: Array<string> = [...publicProblems(config)]
    const loadable: Array<{ name: string; hash: string; code: string }> = []

    for (const name of Object.keys(config.schedules ?? {})) {
      if (!listed.includes(name))
        problems.push(
          `openbelt.json schedules "${name}", which isn't one of its functions (${listed.length === 0 ? "it lists none" : listed.join(", ")}): a schedule runs a function, so list it under "functions" with its functions/${name}.js, or take it out of "schedules"`,
        )
    }

    for (const [key, what] of [
      ["webhooks", "a webhook"],
      ["triggers", "a trigger"],
    ] as const) {
      for (const name of Object.keys(config[key] ?? {})) {
        if (!listed.includes(name))
          problems.push(
            `openbelt.json ${key} has "${name}", which isn't one of its functions (${listed.length === 0 ? "it lists none" : listed.join(", ")}): ${what} runs a function of the same name, so list it under "functions" with its functions/${name}.js, or take it out of "${key}"`,
          )
      }
    }

    const network = config.network ?? []
    const declared = secretsOf(config)
    const uses = Object.keys(config.uses ?? {})

    for (const [secret, d] of declared) {
      const outside = (d.hosts ?? []).filter((h) => !network.includes(h))

      if (outside.length > 0)
        problems.push(
          `openbelt.json secrets "${secret}" may go to ${outside.join(", ")}, which "network" doesn't list: a secret only goes where a function may fetch, so add ${outside.map((h) => `"${h}"`).join(", ")} to "network"`,
        )
    }

    for (const [key, what] of [
      ["schedules", "a schedule"],
      ["webhooks", "a webhook"],
      ["triggers", "a trigger"],
    ] as const) {
      for (const name of Object.keys(config[key] ?? {})) {
        if (contractOf(config, name)?.kind === "query")
          problems.push(
            `openbelt.json ${key} has "${name}", which is a query: a query only reads, so ${what} running it changes nothing. Make it a plain function (drop "kind": "query"), or have ${what} run one that writes`,
          )
      }
    }

    for (const name of listed) {
      const path = functionPath(name)
      const entry = files.get(path)
      const bytes = yield* bytesOf(files, fresh, path)
      const code = bytes === undefined ? undefined : asText(bytes)

      if (entry === undefined || code === undefined) {
        problems.push(
          `openbelt.json lists the function "${name}", but there's no ${path}: add it, a module like export default async (input, { db, caller }) => { ... }, or take "${name}" out of "functions"`,
        )
        continue
      }

      for (const secret of secretsNamedIn(code))
        if (!declared.has(secret))
          problems.push(
            `${path} uses the secret ${secret}, which openbelt.json doesn't list: add "secrets": {"${secret}": "what it's for"}, deploy, then set its value with set_secret (docs({ page: "functions", section: "Secrets" }))`,
          )

      for (const connection of connectionsNamedIn(code))
        if (!uses.includes(connection))
          problems.push(
            `${path} calls ctx.connections${member(connection)}, which openbelt.json "uses" doesn't list: add "uses": {"${connection}": "why the app needs it"} (the connections tool lists the workspace's connections)`,
          )

      for (const host of hostsFetchedIn(code))
        if (!network.includes(host))
          problems.push(
            `${path} fetches ${host}, which openbelt.json "network" doesn't list, so the fetch would be refused: add "network": [${[...network, host].map((h) => `"${h}"`).join(", ")}]`,
          )

      const write =
        /collection\(\s*["'`][^"'`]*["'`]\s*\)\s*\.\s*(add|set|update|delete)\s*\(/.exec(code)

      if (contractOf(config, name)?.kind === "query" && write !== null)
        problems.push(
          `${path} is a query but its code has ${write[0].replaceAll(/\s/g, "")}...: a query only reads this app's data. If "${name}" writes, sends or books, make it a plain function (drop "kind": "query" from its entry in openbelt.json "functions")`,
        )

      loadable.push({ name, hash: entry.hash, code })
    }

    for (const [name, problem] of yield* hooks.vet(loadable))
      problems.push(
        `${functionPath(name)} can't run: ${problem}. A function is a module whose default export is the function: export default async (input, { db, caller }) => { ... }`,
      )

    return problems
  })

  const deploy = Effect.fn("Versions.deploy")(function* (request: DeployRequest) {
    const { remove, edits, trace } = request
    const files = request.files ?? []
    const keepOthers = request.keepOthers || edits.length > 0
    const problems: Array<string> = []
    const sent = new Map<string, Uint8Array>()

    if (request.files === undefined && !keepOthers) {
      problems.push(
        "send files (the whole app), or edits to change an existing app (read it with app_files first)",
      )
    }

    for (const file of files) {
      const problem = pathProblem(file.path)

      if (problem !== undefined) {
        problems.push(problem)
        continue
      }

      if (sent.has(file.path)) problems.push(`"${file.path}" is in files twice`)

      const bytes =
        file.base64 !== undefined
          ? fromBase64(file.base64)
          : file.content === undefined
            ? undefined
            : new TextEncoder().encode(file.content)

      if ((file.base64 === undefined) === (file.content === undefined)) {
        problems.push(
          `"${file.path}": give it content (text) or base64 (bytes), not both or neither`,
        )
      } else if (bytes === undefined) {
        problems.push(`"${file.path}": base64 isn't valid base64`)
      } else if (bytes.length > MAX_FILE) {
        problems.push(`"${file.path}" is ${bytes.length} bytes; files are limited to 1 MB`)
      } else {
        const invalid = file.path === CONFIG ? configProblem(bytes) : undefined

        if (invalid === undefined) sent.set(file.path, bytes)
        else problems.push(invalid)
      }
    }

    if (remove.length > 0 && !keepOthers) {
      problems.push(
        "delete goes with edits or keep_others: true; without them the new version is exactly files, so leave the file out instead",
      )
    }

    for (const path of new Set(edits.map((e) => e.path))) {
      const problem = pathProblem(path)

      if (problem !== undefined) problems.push(problem)

      if (sent.has(path)) {
        problems.push(
          `"${path}" is both in files and in edits: edits change base_version's file, so send the whole file or edits to it, not both`,
        )
      }

      if (remove.includes(path)) problems.push(`"${path}" is both in edits and in delete`)
    }

    for (const path of remove) {
      if (sent.has(path)) problems.push(`"${path}" is both in files and in delete`)
    }

    const current = yield* live()
    const base = request.base === undefined ? current : yield* get(request.base)

    if (request.base !== undefined && base === undefined) {
      problems.push(
        `base_version "${request.base}" isn't one of this app's versions (app_info lists the last 20); use the version app_files returned`,
      )
    }

    if (problems.length > 0) {
      yield* hooks.log("warn", trace, `deploy refused: ${problems.join("; ")}`)

      return yield* new Refused({ message: problems.join("; ") })
    }

    const texts = new Map<string, EditTarget>()

    for (const path of new Set(edits.map((e) => e.path))) {
      const entry = base?.files.get(path)
      const bytes = entry === undefined ? undefined : yield* body(entry.hash)
      const text = bytes === undefined ? undefined : asText(bytes)

      texts.set(
        path,
        bytes === undefined
          ? { kind: "missing", files: [...(base?.files.keys() ?? [])].toSorted() }
          : text === undefined
            ? { kind: "binary" }
            : { kind: "text", text },
      )
    }

    const edited = applyEdits(edits, (path) => texts.get(path) ?? { kind: "binary" })

    if (edited.problems.length > 0) {
      const of = `${edited.problems.length} of ${edits.length} edit${edits.length === 1 ? "" : "s"}`
      const at = base === undefined ? "" : ` at ${base.version}`

      yield* hooks.log("warn", trace, `deploy refused: ${of} can't be applied`)

      return yield* new Refused({
        message: `${of} can't be applied to the files${at}, so nothing was deployed:\n\n${edited.problems.join("\n\n")}\n\nFix those finds (copy the text from app_files; around: "<text>" returns just that part) and send all the edits again.`,
      })
    }

    for (const [path, text] of edited.files) {
      const bytes = new TextEncoder().encode(text)
      const invalid = path === CONFIG ? configProblem(bytes) : undefined

      if (invalid !== undefined) {
        return yield* new Refused({ message: `after your edits, ${invalid}` })
      }

      if (bytes.length > MAX_FILE) {
        return yield* new Refused({
          message: `after your edits "${path}" is ${bytes.length} bytes; files are limited to 1 MB`,
        })
      }

      sent.set(path, bytes)
    }

    const hashed = yield* Effect.forEach([...sent], ([path, bytes]) =>
      Effect.map(sha256(bytes), (hash) => ({ path, hash, bytes })),
    )

    const mine = new Map<string, Entry>(keepOthers ? (base?.files ?? []) : [])

    for (const file of hashed) mine.set(file.path, { hash: file.hash, size: file.bytes.length })

    const missing = remove.filter((path) => !mine.has(path))

    if (missing.length > 0) {
      const from =
        base === undefined
          ? "the app has no version yet"
          : `${base.version} has ${[...base.files.keys()].toSorted().join(", ")}`

      return yield* new Refused({
        message: `delete lists ${missing.map((p) => `"${p}"`).join(", ")}, which isn't a file of the version you're changing (${from})`,
      })
    }

    for (const path of remove) mine.delete(path)

    const anchorName = base === undefined ? null : anchorOf(base)
    const anchor = anchorName === null ? undefined : yield* get(anchorName)
    let result: Map<string, Entry> = mine

    if (request.base !== undefined && current !== undefined && anchorName !== current.version) {
      if (anchorName !== null && anchor === undefined) {
        return yield* new Refused({
          message: `base_version ${request.base} is older than the versions this app keeps, so what changed since can't be worked out. Read the current files with app_files and deploy with base_version "${current.version}".`,
        })
      }

      const anchorFiles: Files = anchor?.files ?? new Map()
      const theirs = differing(anchorFiles, current.files)

      if (theirs.length > 0) {
        if (!keepOthers) {
          return yield* conflict(request.base, anchor, current, theirs, false, trace)
        }

        const changed = differing(anchorFiles, mine)

        const clashes = changed.filter(
          (path) => theirs.includes(path) && mine.get(path)?.hash !== current.files.get(path)?.hash,
        )

        if (clashes.length > 0) {
          return yield* conflict(request.base, anchor, current, clashes, true, trace)
        }

        result = new Map(current.files)

        for (const path of changed) {
          const entry = mine.get(path)

          if (entry === undefined) result.delete(path)
          else result.set(path, entry)
        }
      }
    }

    if (!result.has("index.html")) {
      return yield* new Refused({
        message: 'an app needs an "index.html" at its root (the page its host serves at /)',
      })
    }

    const config = result.get(CONFIG)

    if (config !== undefined && !hashed.some((f) => f.path === CONFIG && f.hash === config.hash)) {
      const bytes = (yield* body(config.hash)) ?? new Uint8Array()
      const kept = readConfig(asText(bytes) ?? "", (base ?? current)?.version ?? "kept")

      if (kept.kind === "unreadable") {
        yield* hooks.log("warn", trace, `deploy refused: the kept openbelt.json: ${kept.problem}`)

        return yield* new Refused({
          message: `the new version would keep openbelt.json as it is, and this OpenBelt can't read it (probably a later OpenBelt wrote it, before a rollback). Send a fixed openbelt.json in files (app_files shows the one there now) and deploy again. ${configProblem(bytes) ?? kept.problem}`,
        })
      }
    }

    const sentBytes = new Map(hashed.map((file) => [file.hash, file.bytes]))

    const unrunnable = [
      ...(yield* functionProblems(result, sentBytes)),
      ...(yield* skillProblems(hooks.name(), result, (path) =>
        Effect.map(bytesOf(result, sentBytes, path), (bytes) =>
          bytes === undefined ? undefined : asText(bytes),
        ),
      )),
    ]

    if (unrunnable.length > 0) {
      yield* hooks.log("warn", trace, `deploy refused: ${unrunnable.join("; ")}`)

      return yield* new Refused({ message: `nothing was deployed: ${unrunnable.join("; ")}` })
    }

    const version = yield* versionOf(result)
    const now = new Date().toISOString()
    const preview = request.env !== undefined
    const kind: VersionEntry["kind"] = keepOthers ? "patch" : "full"

    const uploaded = yield* storage.transaction(
      Effect.gen(function* () {
        const used = Effect.flatMap(
          sql.exec<{ n: number }>("SELECT COALESCE(SUM(length(body)), 0) AS n FROM blobs"),
          (rows) => rows.toArray(),
        ).pipe(Effect.map(([row]) => row?.n ?? 0))

        const before = yield* used
        let fresh = 0

        for (const file of hashed) {
          const cursor = yield* sql.exec(
            "INSERT OR IGNORE INTO blobs (hash, body) VALUES (?, ?)",
            file.hash,
            file.bytes,
          )

          fresh += (yield* cursor.rowsWritten) > 0 ? 1 : 0
        }

        const listed = encodeFiles(
          [...result.keys()].toSorted().map((path) => ({
            path,
            hash: result.get(path)?.hash ?? "",
            size: result.get(path)?.size ?? 0,
          })),
        )

        yield* sql.exec(
          `INSERT INTO versions (${COLUMNS}, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (version) DO UPDATE SET kind = excluded.kind, anchor = excluded.anchor,
               deployed_at = excluded.deployed_at, deployed_by = excluded.deployed_by,
               promoted_at = COALESCE(excluded.promoted_at, promoted_at),
               promoted_by = COALESCE(excluded.promoted_by, promoted_by), n = excluded.n`,
          version,
          listed,
          kind,
          current?.version ?? null,
          now,
          request.by,
          preview ? null : now,
          preview ? null : request.by,
          yield* next(),
        )
        yield* forget

        if (!preview) kv.put("live", version)

        yield* prune()

        if (dataLimits.versions > 0 && (yield* used) > dataLimits.versions) {
          const protectedVersions = new Set([
            version,
            current?.version ?? "",
            ...(yield* hooks.pinned()),
          ])

          const older = yield* sql
            .exec<{ version: string }>("SELECT version FROM versions ORDER BY n")
            .pipe(Effect.flatMap((rows) => rows.toArray()))

          for (const old of older) {
            if ((yield* used) <= dataLimits.versions) break

            if (protectedVersions.has(old.version)) continue
            yield* sql.exec("DELETE FROM versions WHERE version = ?", old.version)
            yield* sql.exec(
              "DELETE FROM blobs WHERE hash NOT IN (SELECT json_extract(f.value, '$.hash') FROM versions, json_each(versions.files) AS f)",
            )
          }

          yield* forget
        }

        const after = yield* used

        if (after > before) {
          const free = yield* Effect.promise(dataDiskFree)

          const problem =
            dataLimits.versions > 0 && after > dataLimits.versions
              ? `this app's retained deploy files would hold ${sizeOf(after)}, over its ${sizeOf(dataLimits.versions)} budget (OPENBELT_VERSIONS_APP_MB). Deploy fewer or smaller files, or ask the operator to raise the budget.`
              : free === undefined || free - (after - before) < dataLimits.floor
                ? "the server cannot reserve disk space for these deploy files (OPENBELT_DATA_DISK_FLOOR_MB). Ask the operator to check disk space."
                : undefined

          if (problem !== undefined) {
            recordRefused("storage", "versions")

            return yield* new Refused({
              message: `${problem} Nothing was deployed; live and preview versions are unchanged.`,
            })
          }
        }

        yield* hooks.checkStorage(request.trace)

        return fresh
      }),
    )

    const changed = differing(base?.files ?? new Map(), result)

    const shown =
      changed.length > 10 ? `${changed.slice(0, 10).join(", ")}, ...` : changed.join(", ")

    yield* hooks.log(
      "info",
      trace,
      `${preview ? `deployed version ${version} into preview ${request.env}` : `deployed version ${version}`} (${kind}): ${result.size} files, ${uploaded} new, changed vs ${base?.version ?? "nothing"}: ${shown === "" ? "nothing" : shown}, by ${request.by}`,
    )

    if (!preview) yield* hooks.wentLive(version)

    const made = edited.files.size === 0 ? undefined : yield* get(version)
    const paths = [...edited.files.keys()].toSorted()

    const review: Review | undefined =
      made === undefined
        ? undefined
        : { from: base?.version ?? null, paths, text: yield* reviewDiff(base, made, paths) }

    return {
      review,
      version,
      live: !preview,
      previous: current?.version ?? null,
      changed,
      files: result.size,
      uploaded,
      bytes: hashed.reduce((sum, f) => sum + f.bytes.length, 0),
    }
  })

  const promote = Effect.fn("Versions.promote")(function* (
    version: string,
    by: string,
    trace: string,
  ) {
    const target = yield* get(version)

    if (target === undefined) {
      return yield* new Refused({
        message: `this app has no version "${version}". Use the version deploy_app returned; app_info lists the last 20.`,
      })
    }

    const previous = liveName() ?? null
    const now = new Date().toISOString()

    yield* sql.exec(
      "UPDATE versions SET promoted_at = ?, promoted_by = ?, n = ? WHERE version = ?",
      now,
      by,
      yield* next(),
      version,
    )
    yield* forget
    kv.put("live", version)
    yield* hooks.log(
      "info",
      trace,
      `promoted version ${version} to live (was ${previous ?? "none"}), by ${by}`,
    )
    yield* hooks.wentLive(version)

    return { version, previous }
  })

  const restore = Effect.fnUntraced(function* (previous: string | null, trace: string) {
    if (previous === null) kv.delete("live")
    else kv.put("live", previous)

    yield* hooks.log(
      "warn",
      trace,
      `put version ${previous ?? "none"} back live: the promote it was part of failed`,
    )

    if (previous !== null) yield* hooks.wentLive(previous)
  })

  const movedSince = Effect.fnUntraced(function* (version: string) {
    const target = yield* get(version)
    const current = yield* live()

    if (target === undefined || current === undefined) return undefined

    if (current.version === version || current.version === target.anchor) return undefined

    return {
      anchor: target.anchor,
      live: current.version,
      by: current.promotedBy ?? current.deployedBy,
      at: current.promotedAt ?? current.deployedAt,
    }
  })

  const history = Effect.fn("Versions.history")(function* () {
    const rows = yield* (yield* sql.exec<Row>(
      `SELECT ${COLUMNS} FROM versions ORDER BY n DESC LIMIT ?`,
      KEEP,
    )).toArray()

    return rows.map(toVersion).map((v): VersionEntry => ({
      version: v.version,
      kind: v.kind,
      by: v.deployedBy,
      deployedAt: v.deployedAt,
      promotedAt: v.promotedAt,
      files: v.files.size,
    }))
  })

  const contents = Effect.fn("Versions.contents")(function* (
    version: string | undefined,
    paths: ReadonlyArray<string> | undefined,
    part: Part | undefined,
  ) {
    const target = version === undefined ? yield* live() : yield* get(version)

    if (target === undefined) {
      return yield* new Refused({
        message:
          version === undefined
            ? "this app has no live version yet; pass version (a preview's, from deploy_app or app_info)"
            : `this app has no version "${version}"; app_info lists the last 20`,
      })
    }

    const all = [...target.files.keys()].toSorted()
    const unknown = (paths ?? []).filter((path) => !target.files.has(path))

    if (unknown.length > 0) {
      return yield* new Refused({
        message: `version ${target.version} has no ${unknown.map((p) => `"${p}"`).join(", ")}; its files are ${all.join(", ")}`,
      })
    }

    const out: Array<FileContent> = []
    let total = 0

    for (const path of paths ?? all) {
      const entry = target.files.get(path)

      if (entry === undefined) continue

      const tooMuch: FileContent = {
        path,
        size: entry.size,
        omitted: `past the ${MAX_EXPORT / 1000} KB one result carries; ask for it with paths: ["${path}"]`,
      }

      if (part === undefined && total + entry.size > MAX_EXPORT && out.length > 0) {
        out.push(tooMuch)
        continue
      }

      const bytes = (yield* body(entry.hash)) ?? new Uint8Array()
      const text = asText(bytes)

      if (part === undefined) {
        total += entry.size
        out.push(
          text === undefined
            ? { path, size: entry.size, base64: bytes.toBase64() }
            : { path, size: entry.size, content: text },
        )
        continue
      }

      if (text === undefined) {
        if (paths !== undefined) {
          out.push({
            path,
            size: entry.size,
            omitted: "not text, so it has no lines; ask without around and lines for its base64",
          })
        }

        continue
      }

      const found = excerpts(text, part)

      if (found.excerpts.length === 0 && paths === undefined) continue

      const size = found.excerpts.reduce((sum, e) => sum + e.text.length, 0)

      if (total + size > MAX_EXPORT && out.length > 0) {
        out.push(tooMuch)
        continue
      }

      const file: FileContent = {
        path,
        size: entry.size,
        lineCount: found.lineCount,
        excerpts: found.excerpts,
      }

      total += size
      out.push(found.more === undefined ? file : { ...file, omitted: found.more })
    }

    return { version: target.version, files: out }
  })

  const diff = Effect.fn("Versions.diff")(function* (
    from: string,
    to: string | undefined,
    paths: ReadonlyArray<string> | undefined,
  ) {
    const before = yield* get(from)
    const after = to === undefined ? yield* live() : yield* get(to)

    if (before === undefined || after === undefined) {
      return yield* new Refused({
        message: `this app has no version "${before === undefined ? from : (to ?? "live")}"; app_info lists the last 20 (older ones aren't kept)`,
      })
    }

    const changed = differing(before.files, after.files)
    const unknown = (paths ?? []).filter((path) => !changed.includes(path))

    if (unknown.length > 0) {
      return yield* new Refused({
        message: `${unknown.map((p) => `"${p}"`).join(", ")} didn't change from ${before.version} to ${after.version}; what changed is ${changed.join(", ") || "nothing"}`,
      })
    }

    return {
      from: before.version,
      to: after.version,
      changed,
      text: yield* reviewDiff(before, after, paths ?? changed),
    }
  })

  const configs = new Map<string, StoredConfig>()

  const config = Effect.fnUntraced(function* (version?: string) {
    const manifest = yield* version === undefined ? live() : get(version)
    const entry = manifest?.files.get(CONFIG)

    if (manifest === undefined || entry === undefined) {
      const none: StoredConfig = { kind: "read", config: {}, skipped: [] }

      return none
    }

    const cached = configs.get(entry.hash)

    if (cached !== undefined) return cached

    const bytes = yield* body(entry.hash)
    const stored = readConfig(asText(bytes ?? new Uint8Array()) ?? "", manifest.version)

    if (stored.kind === "unreadable") yield* hooks.log("error", "-", stored.problem)

    configs.set(entry.hash, stored)

    return stored
  })

  return {
    get,
    live,
    liveName,
    body,
    deploy: (request: DeployRequest) => Effect.ensuring(deploy(request), forget),
    promote: (...args: Parameters<typeof promote>) => Effect.ensuring(promote(...args), forget),
    restore: (...args: Parameters<typeof restore>) => Effect.ensuring(restore(...args), forget),
    movedSince,
    history,
    contents,
    diff,
    config,
  }
})
