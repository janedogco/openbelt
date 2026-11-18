const FILLER = new Set([
  "a",
  "an",
  "the",
  "for",
  "by",
  "of",
  "to",
  "and",
  "or",
  "in",
  "on",
  "with",
  "my",
  "our",
  "all",
  "its",
  "it",
  "is",
  "be",
  "that",
  "this",
  "from",
  "app",
  "build",
  "make",
  "page",
  "openbelt",
  "team",
  "staff",
  "office",
  "people",
  "company",
  "everyone",
  "someone",
  "simple",
  "tool",
  "show",
  "see",
  "use",
])

const singular = (word: string) =>
  word.length > 4 && word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word

export const wordsIn = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .flatMap((w) => (w.length > 1 ? [singular(w)] : []))

export const queryWords = (query: string) => {
  const words = [...new Set(wordsIn(query))]
  const meant = words.filter((w) => !FILLER.has(w))

  return meant.length === 0 ? words : meant
}

export type Searched<T> = {
  readonly item: T
  readonly said: ReadonlySet<string>
  readonly names: ReadonlySet<string>
  readonly lines: ReadonlySet<string>
}

const RARE_IN = 20

/** How much a document holds a word: 3 in its own name or description, 2 in a field's name, 1 in a field's first line, 0 not. */
export type Weight = 0 | 1 | 2 | 3

const weightIn = <T>(d: Searched<T>, w: string): Weight =>
  d.said.has(w) ? 3 : d.names.has(w) ? 2 : d.lines.has(w) ? 1 : 0

/** What a candidate needs to be found: a rare word (a search for the few that fit), or any word (code mode's workspace.search). */
export type Needs = "rare" | "any"

/**
 * The best of `candidates` for `words`: rarer words count more, by how many of all `total` documents hold each (`holding`). A
 * candidate needs a rare word in its name, description or a field's name, or a word almost no one has in a field's line, or a
 * `boost` and every word (the expenses app everyone uses is found by "expense" though thousands of apps hold it; one boosted
 * app holding only "planning" isn't found by "weather planning"); then the ones scoring at least half the best. Its score is its words' times its `boost`, so a boosted
 * candidate holding one word of three still ranks below one holding all three. `candidates` may be only the documents that hold some word
 * (an index's), as long as `holding` and `total` count all of them.
 */
export const rankWeighted = <T>(
  candidates: ReadonlyArray<{
    readonly item: T
    readonly weight: (w: string) => Weight
    readonly boost?: number
  }>,
  words: ReadonlyArray<string>,
  holding: (w: string) => number,
  total: number,
  limit: number,
  needs: Needs = "rare",
) => {
  const idf = new Map(words.map((w) => [w, 1 + Math.log((total + 1) / (holding(w) + 1))] as const))

  const rare = Math.max(2, Math.ceil(total / RARE_IN))

  const scored = candidates.flatMap((d) => {
    const boost = d.boost ?? 1

    const found =
      needs === "any" ||
      (boost > 1 && words.every((w) => d.weight(w) > 0)) ||
      words.some((w) => {
        const n = holding(w)
        const weight = d.weight(w)

        return (n <= rare && weight >= 2) || (n <= 2 && weight >= 1)
      })

    const score = boost * words.reduce((n, w) => n + (idf.get(w) ?? 0) * d.weight(w), 0)

    return found && score > 0 ? [{ item: d.item, score }] : []
  })

  const sorted = scored.toSorted((a, b) => b.score - a.score)
  const top = sorted[0]?.score ?? 0

  return sorted.filter((m) => m.score * 2 >= top).slice(0, limit)
}

export const rank = <T>(
  docs: ReadonlyArray<Searched<T>>,
  words: ReadonlyArray<string>,
  limit: number,
) => {
  const having = new Map(
    words.map((w) => [w, docs.filter((d) => weightIn(d, w) > 0).length] as const),
  )

  return rankWeighted(
    docs.map((d) => ({ item: d.item, weight: (w: string) => weightIn(d, w) })),
    words,
    (w) => having.get(w) ?? 0,
    docs.length,
    limit,
  )
}
