import type { Excerpt, AppEdit } from "./model.ts"

export type EditTarget =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" }
  | { readonly kind: "missing"; readonly files: ReadonlyArray<string> }

const LONG = 400

const WINDOW = 300

const SHOWN = 160

const marker = (chars: number) => `⟪… ${chars} chars⟫`

export const CUT_NOTE = `(lines past ${LONG} characters show a window around the change; ⟪… N chars⟫ stands for the N characters left out. app_files without around or lines has the whole line. Never copy the marker into a find.)`

const windowed = (line: string, at: number) => {
  if (line.length <= LONG) return line

  const start = Math.max(0, Math.min(at - 100, line.length - WINDOW))
  const end = Math.min(line.length, start + WINDOW)
  const before = start > 0 ? marker(start) : ""
  const after = end < line.length ? marker(line.length - end) : ""

  return `${before}${line.slice(start, end)}${after}`
}

const clip = (line: string) => (line.length > SHOWN ? `${line.slice(0, SHOWN)}…` : line)

const occurrences = (text: string, needle: string) => {
  const at: Array<number> = []
  let i = text.indexOf(needle)

  while (i !== -1) {
    at.push(i)
    i = text.indexOf(needle, i + 1)
  }

  return at
}

const lineAt = (text: string, index: number) => {
  let line = 1

  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++

  return line
}

const columnAt = (text: string, index: number) => index - text.lastIndexOf("\n", index - 1)

const looseMatch = (text: string, find: string) => {
  const squashedFind = find.replace(/\s+/g, " ").trim()

  if (squashedFind === "") return -1

  let squashed = ""
  const origin: Array<number> = []

  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text.charAt(i))

    if (space && squashed.endsWith(" ")) continue

    squashed += space ? " " : text.charAt(i)
    origin.push(i)
  }

  const at = squashed.indexOf(squashedFind)

  return at === -1 ? -1 : (origin[at] ?? -1)
}

const bigrams = (s: string) => {
  const out = new Map<string, number>()

  for (let i = 0; i < s.length - 1; i++) {
    const pair = s.slice(i, i + 2)

    out.set(pair, (out.get(pair) ?? 0) + 1)
  }

  return out
}

const similarity = (a: Map<string, number>, b: string) => {
  const other = bigrams(b)
  let common = 0
  let total = 0

  for (const n of a.values()) total += n

  for (const [pair, n] of other) {
    total += n
    common += Math.min(n, a.get(pair) ?? 0)
  }

  return total === 0 ? 0 : (2 * common) / total
}

const longestPrefix = (text: string, find: string) => {
  let low = 0
  let high = find.length

  while (low < high) {
    const mid = Math.ceil((low + high) / 2)

    if (text.includes(find.slice(0, mid))) low = mid
    else high = mid - 1
  }

  return low
}

const nearMiss = (text: string, find: string) => {
  const loose = looseMatch(text, find)

  if (loose !== -1) {
    return `It matches only if whitespace is ignored, near line ${lineAt(text, loose)}: copy the text exactly, indentation and line breaks included.`
  }

  const wanted = find.split("\n").map((l) => l.trim())
  const absent = wanted.find((l) => l !== "" && !text.includes(l))

  if (absent === undefined) {
    return "Each of its lines is in the file, but not together like that: copy one unbroken stretch of the file."
  }

  const notes: Array<string> = []
  const prefix = longestPrefix(text, find)

  if (prefix >= 12) {
    const at = text.indexOf(find.slice(0, prefix))
    const where = `line ${lineAt(text, at)}, column ${columnAt(text, at)}`
    const theirs = JSON.stringify(text.slice(at + prefix, at + prefix + 40))
    const yours = JSON.stringify(find.slice(prefix, prefix + 40))

    notes.push(
      `Its first ${prefix} characters match at ${where}; then the file has ${theirs} where find has ${yours}.`,
    )
  }

  const target = bigrams(absent.slice(0, WINDOW))
  const ranked: Array<{ readonly n: number; readonly line: string; readonly score: number }> = []

  for (const [i, line] of text.split("\n").entries()) {
    const trimmed = line.trim()

    if (trimmed !== "") {
      ranked.push({ n: i + 1, line: trimmed, score: similarity(target, trimmed.slice(0, WINDOW)) })
    }
  }

  const closest = ranked
    .toSorted((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => `  line ${c.n}: ${clip(c.line)}`)

  if (closest.length > 0) notes.push(`The closest lines:\n${closest.join("\n")}`)

  return notes.join("\n")
}

const applyOne = (text: string, edit: AppEdit) => {
  if (edit.find === "") {
    return { problem: "find is empty; give text that occurs once in the file" }
  }

  const at = occurrences(text, edit.find)

  if (at.length === 0) {
    return { problem: `find occurs 0 times. ${nearMiss(text, edit.find)}` }
  }

  if (at.length > 1) {
    const lines = [...new Set(at.map((i) => lineAt(text, i)))]
    const more = lines.length > 10 ? ", ..." : ""

    return {
      problem: `find occurs ${at.length} times (${lines.length === 1 ? "line" : "lines"} ${lines.slice(0, 10).join(", ")}${more}); add text from around the one you mean so it occurs once`,
    }
  }

  const [start = 0] = at

  return { text: text.slice(0, start) + edit.replace + text.slice(start + edit.find.length) }
}

export const applyEdits = (edits: ReadonlyArray<AppEdit>, target: (path: string) => EditTarget) => {
  const files = new Map<string, string>()
  const problems: Array<string> = []

  for (const [i, edit] of edits.entries()) {
    const label = `edits[${i}] (${edit.path})`
    const found = target(edit.path)

    if (found.kind === "missing") {
      const listed = found.files.length > 30 ? [...found.files.slice(0, 30), "..."] : found.files

      problems.push(
        `${label}: there's no "${edit.path}" in the version you're changing (its files: ${listed.join(", ") || "none"}). A new file goes in files.`,
      )
      continue
    }

    if (found.kind === "binary") {
      problems.push(
        `${label}: "${edit.path}" isn't text, so it can't be edited; send it whole in files, as base64.`,
      )
      continue
    }

    const result = applyOne(files.get(edit.path) ?? found.text, edit)

    if (result.text === undefined) problems.push(`${label}: ${result.problem}`)
    else files.set(edit.path, result.text)
  }

  return { files, problems }
}

const split = (line: string) => ({ kind: line.charAt(0), body: line.slice(1) })

const common = (a: string, b: string) => {
  let n = 0

  while (n < a.length && n < b.length && a.charCodeAt(n) === b.charCodeAt(n)) n++

  return n
}

export const clipDiff = (diff: string) => {
  const lines = diff.split("\n")
  const out: Array<string> = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""

    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
      out.push(line)
      i++
      continue
    }

    if (!line.startsWith("-")) {
      const { kind, body } = split(line)

      out.push(`${kind}${windowed(body, 0)}`)
      i++
      continue
    }

    const removed: Array<string> = []
    const added: Array<string> = []

    while (lines[i]?.startsWith("-") === true) removed.push(split(lines[i++] ?? "").body)

    while (lines[i]?.startsWith("+") === true) added.push(split(lines[i++] ?? "").body)

    const at = removed.map((r, k) => common(r, added[k] ?? ""))

    for (const [k, r] of removed.entries()) out.push(`-${windowed(r, at[k] ?? 0)}`)

    for (const [k, a] of added.entries()) out.push(`+${windowed(a, at[k] ?? 0)}`)
  }

  return out.join("\n")
}

const MAX_PLACES = 20

export const excerpts = (
  text: string,
  options: {
    readonly lines: string | undefined
    readonly around: string | undefined
    readonly context: number
  },
) => {
  const all = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n")
  const ranges: Array<[number, number]> = []
  const places = options.around === undefined ? [] : occurrences(text, options.around)

  if (options.lines !== undefined) {
    const [a = "1", b = a] = options.lines.split("-")
    const from = Number.parseInt(a, 10)
    const to = Math.min(all.length, Number.parseInt(b, 10))

    if (from <= to) ranges.push([from, to])
  }

  for (const at of places.slice(0, MAX_PLACES)) {
    const first = lineAt(text, at)
    const last = lineAt(text, at + (options.around?.length ?? 0))

    ranges.push([
      Math.max(1, first - options.context),
      Math.min(all.length, last + options.context),
    ])
  }

  const merged: Array<[number, number]> = []

  for (const [from, to] of ranges.toSorted((x, y) => x[0] - y[0])) {
    const last = merged.at(-1)

    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }

  const shown = (line: string) => {
    const at = options.around === undefined ? -1 : line.indexOf(options.around)

    return windowed(line, Math.max(at, 0))
  }

  const found: ReadonlyArray<Excerpt> = merged.map(([from, to]) => ({
    from,
    to,
    text: all
      .slice(from - 1, to)
      .map(shown)
      .join("\n"),
  }))

  const more =
    places.length > MAX_PLACES
      ? `around occurs ${places.length} times; these are the first ${MAX_PLACES}. Pass a longer around to find the one you mean.`
      : undefined

  return { lineCount: all.length, excerpts: found, more }
}
