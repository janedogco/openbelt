import * as Predicate from "effect/Predicate"

export const SECRET_LENGTH = { min: 8, max: 4000 } as const

export const byteString = (bytes: Uint8Array) => {
  const units = new Uint16Array(bytes.length)

  units.set(bytes)

  return new TextDecoder("utf-16le").decode(units)
}

export const fromByteString = (text: string) => {
  const out = new Uint8Array(text.length)

  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)

  return out
}

const SHORT = new Map([
  ['"', 0x22],
  ["\\", 0x5c],
  ["/", 0x2f],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
])

const hexAt = (text: string, at: number, digits: number) => {
  if (at + digits > text.length) return -1

  let n = 0

  for (let i = at; i < at + digits; i++) {
    const c = text.charCodeAt(i)

    const d =
      c >= 0x30 && c <= 0x39
        ? c - 0x30
        : c >= 0x61 && c <= 0x66
          ? c - 0x57
          : c >= 0x41 && c <= 0x46
            ? c - 0x37
            : -1

    if (d < 0) return -1

    n = n * 16 + d
  }

  return n
}

type View = {
  readonly text: string
  readonly start: (k: number) => number
  readonly end: (k: number) => number
}

type Reading = "json" | "percent" | "form"

const LOOKED: Record<Reading, ReadonlyArray<"\\" | "%" | "+">> = {
  json: ["\\"],
  percent: ["%"],
  form: ["%", "+"],
}

const READINGS: ReadonlyArray<Reading> = ["json", "percent", "form"]

const CHANGED: Record<Reading, string> = { json: "\\", percent: "%", form: "+" }

const changes = (text: string, reading: Reading) => text.includes(CHANGED[reading])

const utf8Of = (unit: number) => {
  if (unit < 0x80) return String.fromCharCode(unit)

  if (unit < 0x800) return String.fromCharCode(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f))

  if (unit < 0x10000)
    return String.fromCharCode(
      0xe0 | (unit >> 12),
      0x80 | ((unit >> 6) & 0x3f),
      0x80 | (unit & 0x3f),
    )

  return String.fromCharCode(
    0xf0 | (unit >> 18),
    0x80 | ((unit >> 12) & 0x3f),
    0x80 | ((unit >> 6) & 0x3f),
    0x80 | (unit & 0x3f),
  )
}

const surrogateAt = (text: string, at: number) => {
  const b1 = text.charCodeAt(at + 1)
  const b2 = text.charCodeAt(at + 2)

  return text.charCodeAt(at) === 0xed && b1 >= 0xa0 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf
    ? 0xd000 | ((b1 & 0x3f) << 6) | (b2 & 0x3f)
    : -1
}

const escapeAt = (
  text: string,
  at: number,
): { readonly bytes: string; readonly end: number } | undefined => {
  const c = text.charCodeAt(at)

  if (c === 0x2b) return { bytes: " ", end: at + 1 }

  if (c === 0x25) {
    const byte = hexAt(text, at + 1, 2)

    return byte < 0 ? undefined : { bytes: String.fromCharCode(byte), end: at + 3 }
  }

  if (text.charCodeAt(at + 1) === 0x75) {
    let unit = hexAt(text, at + 2, 4)

    if (unit < 0) return undefined

    let end = at + 6

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.startsWith("\\u", end) ? hexAt(text, end + 2, 4) : surrogateAt(text, end)

      if (low >= 0xdc00 && low <= 0xdfff) {
        unit = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
        end += text.startsWith("\\u", end) ? 6 : 3
      }
    }

    return { bytes: utf8Of(unit), end }
  }

  const short = SHORT.get(text.charAt(at + 1))

  return short === undefined ? undefined : { bytes: String.fromCharCode(short), end: at + 2 }
}

const decode = (text: string, reading: Reading): View => {
  const parts: Array<string> = []
  const marks: Array<number> = []
  const next = { "\\": -1, "%": -1, "+": -1 }
  const looked = LOOKED[reading]
  let made = 0
  let last = 0
  let i = 0

  for (;;) {
    let at = -1

    for (const c of looked) {
      if (next[c] < i && next[c] !== -2) next[c] = text.indexOf(c, i)

      if (next[c] === -1) next[c] = -2

      if (next[c] >= 0 && (at < 0 || next[c] < at)) at = next[c]
    }

    if (at < 0) break

    let escape = escapeAt(text, at)

    if (escape === undefined) {
      i = at + 1
      continue
    }

    const high = at - 3 >= last ? surrogateAt(text, at - 3) : -1
    const low = escape.bytes.length === 3 ? surrogateAt(escape.bytes, 0) : -1

    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      escape = {
        bytes: utf8Of(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00)),
        end: escape.end,
      }
      at -= 3
    }

    if (at > last) parts.push(text.slice(last, at))

    made += at - last
    parts.push(escape.bytes)
    marks.push(made, escape.bytes.length, at, escape.end)
    made += escape.bytes.length
    last = escape.end
    i = escape.end
  }

  parts.push(text.slice(last))

  const m = Int32Array.from(marks)
  const count = m.length / 4

  const markOf = (k: number) => {
    let lo = 0
    let hi = count - 1
    let found = -1

    while (lo <= hi) {
      const mid = (lo + hi) >> 1

      if ((m[mid * 4] ?? 0) <= k) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }

    return found
  }

  const span = (k: number) => {
    const at = markOf(k)

    if (at < 0) return [k, k + 1] as const

    const placed = m[at * 4] ?? 0
    const length = m[at * 4 + 1] ?? 0
    const to = m[at * 4 + 3] ?? 0

    if (k < placed + length) return [m[at * 4 + 2] ?? 0, to] as const

    const from = to + (k - placed - length)

    return [from, from + 1] as const
  }

  return { text: parts.join(""), start: (k) => span(k)[0], end: (k) => span(k)[1] }
}

const onto = (base: View, next: View): View => ({
  text: next.text,
  start: (k) => base.start(next.start(k)),
  end: (k) => base.end(next.end(k) - 1),
})

const eachView = (body: string, search: (view: View) => void) => {
  const searched = new Set<string>()

  const read = (base: View, reading: Reading) => {
    if (!changes(base.text, reading)) return undefined

    const view = onto(base, decode(base.text, reading))

    if (!searched.has(view.text)) {
      searched.add(view.text)
      search(view)
    }

    return view
  }

  const raw: View = { text: body, start: (k) => k, end: (k) => k + 1 }

  searched.add(body)
  search(raw)

  for (const first of READINGS) {
    const once = read(raw, first)

    if (once !== undefined) for (const then of READINGS) read(once, then)
  }
}

type Prepared = {
  readonly name: string
  readonly placeholder: string
  readonly form: Form
}

type Form = {
  readonly text: string
  readonly tails: ReadonlyArray<string>
  readonly anchor: string
  readonly at: number
}

const ANCHOR = 32

export class Unchecked extends Error {
  constructor() {
    super("the answer would take too long to check for the app's secrets")
  }
}

const formOf = (p: string): Form => {
  const border = new Int32Array(p.length)

  for (let i = 1, k = 0; i < p.length; i++) {
    while (k > 0 && p.charCodeAt(i) !== p.charCodeAt(k)) k = border[k - 1] ?? 0

    if (p.charCodeAt(i) === p.charCodeAt(k)) k += 1

    border[i] = k
  }

  const tails: Array<string> = []

  for (let b = border[p.length - 1] ?? 0; b > 0; b = border[b - 1] ?? 0) tails.push(p.slice(b))

  const at = p.length <= ANCHOR ? 0 : Math.floor((p.length - ANCHOR) / 2)

  return { text: p, tails, anchor: p.slice(at, at + ANCHOR), at }
}

const prepare = (name: string, value: string): Prepared => ({
  name,
  placeholder: `{{secret:${name}}}`,
  form: formOf(byteString(new TextEncoder().encode(value))),
})

const tailAt = (text: string, at: number, tail: string, budget: { left: number }) => {
  let i = 0

  while (i < tail.length && text.charCodeAt(at + i) === tail.charCodeAt(i)) i += 1

  budget.left -= i + 1

  return i === tail.length
}

const findAll = (
  text: string,
  form: Form,
  budget: { left: number },
  found: (start: number, end: number) => void,
) => {
  let from = 0

  for (;;) {
    const hit = text.indexOf(form.anchor, from + form.at)

    if (hit < 0) return

    const start = hit - form.at

    budget.left -= form.text.length

    if (budget.left < 0) throw new Unchecked()

    if (!text.startsWith(form.text, start)) {
      from = start + 1
      continue
    }

    let end = start + form.text.length

    for (;;) {
      const tail = form.tails.find((t) => tailAt(text, end, t, budget))

      if (budget.left < 0) throw new Unchecked()

      if (tail === undefined) break

      end += tail.length
    }

    found(start, end)
    from = end
  }
}

export type Redactor = {
  readonly text: (text: string) => string
  readonly bytes: (bytes: Uint8Array) => Uint8Array
  readonly holds: (
    part: string | Uint8Array,
    among: (name: string) => boolean,
  ) => ReadonlyArray<string>
}

const COMPARISONS = 1_000_000

const redactView = (body: string, secrets: ReadonlyArray<Prepared>) => {
  const spans: Array<{ start: number; end: number; by: string }> = []
  const budget = { left: COMPARISONS }

  eachView(body, (view) => {
    budget.left += 16 * view.text.length

    for (const s of secrets) {
      findAll(view.text, s.form, budget, (start, end) =>
        spans.push({
          start: view.start(start),
          end: view.end(end - 1),
          by: s.placeholder,
        }),
      )
    }
  })

  const [first, ...rest] = spans.toSorted((x, y) => x.start - y.start || y.end - x.end)

  if (first === undefined) return body

  let out = ""
  let at = 0
  let open = { ...first }

  for (const span of rest) {
    if (span.start < open.end) {
      open.end = Math.max(open.end, span.end)
      continue
    }

    out += body.slice(at, open.start) + open.by
    at = open.end
    open = { ...span }
  }

  return out + body.slice(at, open.start) + open.by + body.slice(open.end)
}

const foundIn = (body: string, secrets: ReadonlyArray<Prepared>) => {
  const found = new Set<string>()
  const budget = { left: COMPARISONS }

  eachView(body, (view) => {
    budget.left += 16 * view.text.length

    for (const s of secrets)
      if (!found.has(s.name)) findAll(view.text, s.form, budget, () => found.add(s.name))
  })

  return found
}

const highBytes = (text: string) => {
  let high = false

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)

    if (c > 0xff) return false

    if (c > 0x7f) high = true
  }

  return high
}

const made = new WeakMap<ReadonlyMap<string, string>, Redactor>()

export const redactor = (values: ReadonlyMap<string, string>): Redactor => {
  const known = made.get(values)

  if (known !== undefined) return known

  const secrets = [...values].flatMap(([name, value]) =>
    value.length >= SECRET_LENGTH.min ? [prepare(name, value)] : [],
  )

  const bytes = (body: Uint8Array) => {
    if (secrets.length === 0) return body

    const view = byteString(body)
    const clean = redactView(view, secrets)

    return clean === view ? body : fromByteString(clean)
  }

  const text = (t: string) => {
    if (secrets.length === 0) return t

    const utf8 = new TextEncoder().encode(t)
    const asUtf8 = bytes(utf8)
    const once = asUtf8 === utf8 ? t : new TextDecoder().decode(asUtf8)

    return highBytes(once) ? redactView(once, secrets) : once
  }

  const holds = (part: string | Uint8Array, among: (name: string) => boolean) => {
    const wanted = secrets.filter((s) => among(s.name))

    if (wanted.length === 0) return []

    const utf8 = Predicate.isString(part) ? new TextEncoder().encode(part) : part
    const found = foundIn(byteString(utf8), wanted)

    if (Predicate.isString(part) && highBytes(part))
      for (const name of foundIn(part, wanted)) found.add(name)

    return [...found]
  }

  const ready = { text, bytes, holds }

  made.set(values, ready)

  return ready
}
