const levelOf = (line: string) => /^(#{1,6}) /.exec(line)?.[1]?.length ?? 0

export const section = (markdown: string, heading: string) => {
  const lines = markdown.split("\n")
  const start = lines.indexOf(heading)

  if (start === -1) throw new Error(`docs section "${heading}" is missing`)

  const level = levelOf(heading)
  const stop = level === 1 ? 6 : level
  let fenced = false

  const end = lines.findIndex((line, i) => {
    if (i <= start) return false

    if (line.startsWith("```")) fenced = !fenced

    const at = levelOf(line)

    return !fenced && at > 0 && at <= stop
  })

  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trim()
}

/** The page's title section and each of its "## " sections, in order: every one of them, so a section added later is never left out. */
export const allSections = (markdown: string) => {
  let fenced = false

  return markdown
    .split("\n")
    .filter((line) => {
      if (line.startsWith("```")) fenced = !fenced

      return !fenced && (levelOf(line) === 1 || levelOf(line) === 2)
    })
    .map((heading) => section(markdown, heading))
}
