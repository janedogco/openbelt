const MAX_CELLS = 1_000_000

const CONTEXT = 3

type Op = { readonly kind: " " | "-" | "+"; readonly line: string }

const linesOf = (text: string) =>
  text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n")

const middle = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<Op> => {
  const n = a.length
  const m = b.length

  if (n * m > MAX_CELLS) {
    return [
      ...a.map((line): Op => ({ kind: "-", line })),
      ...b.map((line): Op => ({ kind: "+", line })),
    ]
  }

  const lcs = new Uint32Array((n + 1) * (m + 1))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j] ?? 0, lcs[i * (m + 1) + j + 1] ?? 0)
    }
  }

  const ops: Array<Op> = []
  let i = 0
  let j = 0

  while (i < n || j < m) {
    const left = a[i]
    const right = b[j]

    if (i < n && j < m && left === right && left !== undefined) {
      ops.push({ kind: " ", line: left })
      i++
      j++
    } else if (
      i < n &&
      left !== undefined &&
      (j >= m || (lcs[(i + 1) * (m + 1) + j] ?? 0) >= (lcs[i * (m + 1) + j + 1] ?? 0))
    ) {
      ops.push({ kind: "-", line: left })
      i++
    } else if (right !== undefined) {
      ops.push({ kind: "+", line: right })
      j++
    }
  }

  return ops
}

const script = (before: string, after: string): Array<Op> => {
  const a = linesOf(before)
  const b = linesOf(after)
  let start = 0

  while (start < a.length && start < b.length && a[start] === b[start]) start++

  let end = 0

  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++
  }

  const kept = (lines: ReadonlyArray<string>) => lines.map((line): Op => ({ kind: " ", line }))

  return [
    ...kept(a.slice(0, start)),
    ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...kept(a.slice(a.length - end)),
  ]
}

export const unifiedDiff = (
  labels: { readonly before: string; readonly after: string },
  before: string,
  after: string,
  max: number,
) => {
  const ops = script(before, after)
  const changed: Array<number> = []

  for (const [index, op] of ops.entries()) {
    if (op.kind !== " ") changed.push(index)
  }

  if (changed.length === 0) return ""

  const out = [`--- ${labels.before}`, `+++ ${labels.after}`]
  let k = 0

  while (k < changed.length) {
    const first = changed[k] ?? 0
    let last = first

    while (k + 1 < changed.length && (changed[k + 1] ?? 0) - last <= 2 * CONTEXT) {
      k++
      last = changed[k] ?? last
    }

    k++

    const from = Math.max(0, first - CONTEXT)
    const to = Math.min(ops.length, last + CONTEXT + 1)
    const hunk = ops.slice(from, to)
    let oldLine = 1
    let newLine = 1

    for (const op of ops.slice(0, from)) {
      if (op.kind !== "+") oldLine++

      if (op.kind !== "-") newLine++
    }

    const oldCount = hunk.reduce((sum, op) => sum + (op.kind === "+" ? 0 : 1), 0)
    const newCount = hunk.reduce((sum, op) => sum + (op.kind === "-" ? 0 : 1), 0)

    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`)

    for (const op of hunk) out.push(`${op.kind}${op.line}`)
  }

  const text = out.join("\n")

  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n... (${text.length - max} more characters of diff left out)`
}
