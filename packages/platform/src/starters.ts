// The starter apps people add to their workspace (packages/platform/starters/<name>/), with starter_add or the Apps page's Add: one
// for each pick docs/start.md offers, Pulse over them, and Cut, a video editor. Each folder is an app as deploy_app takes it, plus files deploy never takes
// (it refuses a path that starts with "_"): _seed.json, the documents it starts with ({ "<collection>": [{ id?, data }] }, oldest
// first), _next.md, the next steps starter_add tells an agent to offer once the person has its link (docs/start.md), and its gallery
// picture made ahead (_picture.webp, _picture-dark.webp), with _picture.json naming the files and data it
// shows (bun run starters:pictures makes them), so a new starter's card has its picture at once instead of after a browser's.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { AppFile, BatchWrite, Writer } from "./model.ts"

const ROOT = fileURLToPath(new URL("../starters/", import.meta.url))

const SEED = "_seed.json"

const NEXT = "_next.md"

/** A starter's picture made ahead, light and dark, and what it shows. */
export const PICTURE = { light: "_picture.webp", dark: "_picture-dark.webp", of: "_picture.json" }

/** Starters whose page depends on the rest of the workspace (pulse reads the others), so no picture made ahead is true of it. */
const UNPICTURED = new Set(["pulse"])

/** Who wrote a starter's documents: OpenBelt, not the person whose workspace it is. */
export const STARTER_WRITER: Writer = { author: "OpenBelt", name: "OpenBelt" }

/** The order starters are offered in: docs/start.md's picks, then Pulse; any other starter after them, by name. */
const ORDER = ["messages", "journal", "tasks", "sketch", "pulse"]

const About = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      description: Schema.String,
      color: Schema.String,
      collections: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      functions: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Union([
            Schema.String,
            Schema.Struct({
              description: Schema.String,
              internal: Schema.optionalKey(Schema.Boolean),
            }),
          ]),
        ),
      ),
      schedules: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Struct({ cron: Schema.String })),
      ),
    }),
  ),
)

const Seed = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Struct({ id: Schema.optionalKey(Schema.String), data: Schema.Json })),
)

const Pictured = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ hash: Schema.String })),
)

export type Starter = {
  readonly name: string
  /** Its openbelt.json description: what it's for, in one line. */
  readonly description: string
  /** Its openbelt.json color: its gallery card's tint, kept with its picture made ahead. */
  readonly color: string
  /** Its icon.svg: a small illustration on a tile of its colour, on the Apps page and as the app's own tab icon. */
  readonly icon: string
  readonly files: ReadonlyArray<AppFile>
  /** Each collection's first documents, as the writes that make them. */
  readonly seed: ReadonlyArray<{
    readonly collection: string
    readonly writes: ReadonlyArray<BatchWrite>
  }>
  /** The next steps to offer once the person has its link, from its _next.md: a numbered pick, sent as it is. */
  readonly next: string | null
  /** What's inside it, for its page on the Apps page's Starters tab: read from its openbelt.json, skills and prompt. */
  readonly inside: Inside
  /** What its picture must show: a hash of its files and _seed.json. */
  readonly hash: string
  /**
   * Its picture made ahead, when there is one of these files and data (else a browser takes one, as for any app): current, or none
   * (unpictured, like pulse), missing or stale, which `bun run check` refuses.
   */
  readonly picture:
    | { readonly kind: "current"; readonly light: Uint8Array; readonly dark: Uint8Array }
    | { readonly kind: "unpictured" | "missing" | "stale" }
}

/** What a starter's page lists: its data, what agents get, what runs by itself, and the prompt that built it. */
export type Inside = {
  /** Each collection, with the fields its openbelt.json names. */
  readonly data: ReadonlyArray<{ readonly name: string; readonly fields: ReadonlyArray<string> }>
  /** Its skills and the functions anyone may call, each with the first sentence of what it does. */
  readonly agents: ReadonlyArray<{ readonly name: string; readonly about: string }>
  /** Its schedules: when, and what the function does. */
  readonly runs: ReadonlyArray<{ readonly when: string; readonly about: string }>
  /** The prompt its page's Prompt button shows. */
  readonly prompt: string | null
}

const firstSentence = (text: string) => /^.*?[.!?](?=\s|$)/s.exec(text.trim())?.[0] ?? text.trim()

/** The field names in a collection's description: "one doc per task: { title, done (bool), … }" gives title, done, … */
const fieldsOf = (description: string) => {
  const open = description.indexOf("{")
  const close = description.lastIndexOf("}")

  if (open === -1 || close < open) return []

  const fields: Array<string> = []
  let depth = 0
  let part = ""

  for (const char of description.slice(open + 1, close)) {
    if (char === "(" || char === "{" || char === "[") depth++

    if (char === ")" || char === "}" || char === "]") depth--

    if (char === "," && depth === 0) {
      fields.push(part)
      part = ""
    } else part += char
  }

  return [...fields, part].flatMap((f) => /^\s*([A-Za-z_]\w*)/.exec(f)?.[1] ?? [])
}

/** A daily cron in words ("0 3 * * *": every day at 3:00); any other as it is. */
const whenOf = (cron: string) => {
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron.trim())

  return daily === null
    ? `On the schedule ${cron}`
    : `Every day at ${daily[2]}:${(daily[1] ?? "0").padStart(2, "0")}`
}

const insideOf = (
  dir: string,
  about: ReturnType<typeof About>,
  paths: ReadonlyArray<string>,
): Inside => {
  const functions = Object.entries(about.functions ?? {}).map(([name, f]) =>
    Schema.is(Schema.String)(f)
      ? { name, about: f, internal: false }
      : { name, about: f.description, internal: f.internal === true },
  )

  const skills = paths
    .filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
    .flatMap((path) => {
      const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, path), "utf8"))?.[1] ?? ""
      const said = /^description:\s*"?(.*?)"?\s*$/m.exec(head)?.[1]

      return said === undefined
        ? []
        : [{ name: path.split("/")[1] ?? "", about: firstSentence(said) }]
    })

  const page = paths.includes("index.html") ? readFileSync(join(dir, "index.html"), "utf8") : ""
  const prompt = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(page)?.[1]?.trim()

  return {
    data: Object.entries(about.collections ?? {}).map(([name, said]) => ({
      name,
      fields: fieldsOf(said),
    })),
    agents: [
      ...skills,
      ...functions
        .filter((f) => !f.internal)
        .map((f) => ({ name: f.name, about: firstSentence(f.about) })),
    ],
    runs: Object.entries(about.schedules ?? {}).map(([fn, { cron }]) => ({
      when: whenOf(cron),
      about: firstSentence(functions.find((f) => f.name === fn)?.about ?? fn),
    })),
    prompt:
      prompt === undefined || prompt === ""
        ? null
        : prompt
            .replaceAll("&lt;", "<")
            .replaceAll("&gt;", ">")
            .replaceAll("&quot;", '"')
            .replaceAll("&#39;", "'")
            .replaceAll("&amp;", "&"),
  }
}

const filesIn = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .toSorted()

const pictureOf = (name: string, dir: string, hash: string): Starter["picture"] => {
  if (UNPICTURED.has(name)) return { kind: "unpictured" }

  const at = (file: string) => join(dir, file)

  if (![PICTURE.light, PICTURE.dark, PICTURE.of].every((file) => existsSync(at(file))))
    return { kind: "missing" }

  const of = Pictured(readFileSync(at(PICTURE.of), "utf8"))

  if (Option.isNone(of) || of.value.hash !== hash) return { kind: "stale" }

  return {
    kind: "current",
    light: new Uint8Array(readFileSync(at(PICTURE.light))),
    dark: new Uint8Array(readFileSync(at(PICTURE.dark))),
  }
}

const starterAt = (name: string): Starter => {
  const dir = join(ROOT, name)
  const paths = filesIn(dir)
  const shown = paths.filter((path) => !path.startsWith("_") || path === SEED)
  const sha = createHash("sha256")

  for (const path of shown)
    sha
      .update(path)
      .update("\0")
      .update(readFileSync(join(dir, path)))

  const hash = sha.digest("hex")

  const seed = paths.includes(SEED)
    ? Schema.decodeUnknownSync(Seed)(JSON.parse(readFileSync(join(dir, SEED), "utf8")))
    : {}

  const about = About(readFileSync(join(dir, "openbelt.json"), "utf8"))

  return {
    name,
    description: about.description,
    color: about.color,
    inside: insideOf(dir, about, paths),
    next: paths.includes(NEXT) ? readFileSync(join(dir, NEXT), "utf8").trim() : null,
    icon: readFileSync(join(dir, "icon.svg"), "utf8").trim(),
    files: paths
      .filter((path) => !path.startsWith("_"))
      .map((path) => ({ path, content: readFileSync(join(dir, path), "utf8") })),
    seed: Object.entries(seed).map(([collection, docs]) => ({
      collection,
      writes: docs.map((doc): BatchWrite =>
        doc.id === undefined
          ? { op: "add", data: doc.data }
          : { op: "set", id: doc.id, data: doc.data },
      ),
    })),
    hash,
    picture: pictureOf(name, dir, hash),
  }
}

/** Every starter, read once when the platform starts: a broken _seed.json stops it there, not when someone adds it. */
export const STARTERS: ReadonlyArray<Starter> = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => starterAt(entry.name))
  .toSorted(
    (a, b) =>
      (ORDER.indexOf(a.name) + 1 || ORDER.length + 1) -
        (ORDER.indexOf(b.name) + 1 || ORDER.length + 1) || a.name.localeCompare(b.name),
  )
