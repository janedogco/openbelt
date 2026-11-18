import type { Page, Request } from "playwright-core"

import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type CheckStep, KEYS, MODIFIERS } from "./model.ts"
import { selectorProblem } from "./selectors.ts"

export const LOAD_TIMEOUT_MS = 15_000

const RETRY_MS = 3000

const EVAL_MS = 5000

const MAX_RESULT = 1500

const POLL_MS = 100

export class Problem extends Error {}

export const reason = (cause: unknown) =>
  cause instanceof Problem
    ? cause.message
    : ((cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? "")

export const within = async <A>(ms: number, what: string, run: () => Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined

  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Problem(`${what} took longer than ${seconds(ms)}`)), ms)
  })

  try {
    return await Promise.race([run(), late])
  } catch (cause) {
    throw cause instanceof Problem ? cause : new Problem(reason(cause))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How long a page must make no new request, with none in flight, to count as settled after a step: a click's fetch starts within
 * a few ms of the click. Before the page is read (an eval, or the report at the end) the wait is longer: a page that navigates
 * a moment after a step (a timer, a redirect) would take the page away mid-read, and a request it makes a moment later belongs
 * in the report. Actions and expects wait for a new page by themselves.
 */
const QUIET_MS = { step: 50, read: 200 } as const

export const settle = (page: Page, before: keyof typeof QUIET_MS = "step") =>
  new Promise<void>((resolve) => {
    const active = new Set<Request>()
    let idle: ReturnType<typeof setTimeout>

    const done = () => {
      clearTimeout(idle)
      clearTimeout(limit)
      page.off("request", started)
      page.off("requestfinished", finished)
      page.off("requestfailed", finished)
      resolve()
    }

    const quiet = () => {
      clearTimeout(idle)

      if (active.size === 0) idle = setTimeout(done, QUIET_MS[before])
    }

    const started = (request: Request) => {
      active.add(request)
      quiet()
    }

    const finished = (request: Request) => {
      active.delete(request)
      quiet()
    }

    const limit = setTimeout(done, 2000)
    page.on("request", started)
    page.on("requestfinished", finished)
    page.on("requestfailed", finished)
    quiet()
  })

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const seconds = (ms: number) => `${ms / 1000}s`

const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… (cut at ${max} of ${text.length} characters)` : text

/** Whether a chord's key is a letter or digit, which the browser names by the character itself. */
const isCharKey = (key: string): boolean => /^[A-Za-z0-9]$/.test(key)

const chordOf = (value: string) => {
  const parts = value === "+" ? ["+"] : value.split("+")
  const key = parts.at(-1) ?? ""
  const modifiers = parts.slice(0, -1).map((part) => MODIFIERS.find((m) => m === part))
  const named = KEYS.find((k) => k === key)

  const char = parts.length === 1 ? key.length === 1 : isCharKey(key)

  if (modifiers.some((m) => m === undefined) || (!char && named === undefined)) return undefined

  return { modifiers: modifiers.filter((m) => m !== undefined), named, key }
}

const OWNERS = {
  to: ["drag"],
  state: ["wait"],
  text: ["expect"],
  textIncludes: ["expect"],
  count: ["expect"],
  visible: ["expect"],
  checked: ["expect"],
  attr: ["expect"],
  script: ["eval"],
  status: ["expect"],
  path: ["expect"],
} as const

const ON_ELEMENTS = [
  "text",
  "textIncludes",
  "value",
  "count",
  "visible",
  "checked",
  "attr",
] as const

const NEEDS_SELECTOR = new Set([
  "click",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "hover",
  "drag",
  "expect",
  "upload",
])

const REQUIRES = [
  ["fill", "value", 'what the field should hold ("" empties it)'],
  ["type", "value", "the text to type"],
  ["select", "value", "the option's value or label"],
  ["drag", "to", "a selector for where to drop it"],
  ["upload", "value", 'the file names to choose, like "photo.png" or "a.pdf:20MB,b.jpg"'],
] as const

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

const FILLED = [
  "selector",
  "value",
  "to",
  "text",
  "textIncludes",
  "script",
  "assert",
  "path",
] as const

const usedBy = (step: CheckStep) =>
  [...FILLED.map((field) => step[field]), step.attr?.value].flatMap((text) =>
    text === undefined ? [] : [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""),
  )

export const stepProblem = (step: CheckStep, index: number) => {
  const which = `step ${index + 1} (${step.action})`
  const { action, value } = step
  const selector = step.selector?.replaceAll(PLACEHOLDER, "x")

  for (const [field, owners] of Object.entries(OWNERS)) {
    if (field in step && !owners.some((owner) => owner === action)) {
      return `${which}: ${field} is for ${owners.join(", ")} steps${owners.some((o) => o === "expect") ? `; to assert it, add { action: "expect", selector, ${field} }` : ""}`
    }
  }

  if (step.save !== undefined && action !== "eval" && action !== "expect" && action !== "wait") {
    return `${which}: save is for eval (keeps what the script returns), expect and wait (keep the element's text) steps`
  }

  if (step.save !== undefined && action === "wait" && step.selector === undefined) {
    return `${which}: save on a wait needs selector, the element whose text to keep`
  }

  for (const given of [selector, step.to?.replaceAll(PLACEHOLDER, "x")]) {
    const problem = given === undefined ? undefined : selectorProblem(given)

    if (problem !== undefined) {
      return `${which}: ${problem}. A selector is CSS, as document.querySelectorAll takes it, or text=Label.`
    }
  }

  if (step.path !== undefined && step.status === undefined) {
    return `${which}: path is for an expect with status, the request it's about: add status, e.g. 403`
  }

  if (step.status !== undefined) {
    const mixed = [...ON_ELEMENTS, "selector", "save"].find((field) => field in step)

    if (mixed !== undefined) {
      return `${which}: status checks the page's last data request, not an element: put ${mixed} in an expect step of its own`
    }

    return undefined
  }

  if (NEEDS_SELECTOR.has(action) && selector === undefined) {
    return `${which} needs selector: a CSS selector, or text=Label`
  }

  const required = REQUIRES.find(([owner]) => owner === action)

  if (required !== undefined && step[required[1]] === undefined) {
    return `${which} needs ${required[1]}: ${required[2]}`
  }

  if (
    action === "scroll" &&
    (selector === undefined ? value !== "top" && value !== "bottom" : value !== undefined)
  ) {
    return `${which} needs selector (scroll it into view) or value: "top" or "bottom", not both`
  }

  if (action === "press" && chordOf(value ?? "") === undefined) {
    return `${which} needs value: one of ${KEYS.join(", ")}, or a single character, optionally after modifiers (${MODIFIERS.join(", ")}) joined with +, like "Shift+Enter" or "Control+a"`
  }

  if (action === "goto" && (value === undefined || /^[a-z]+:|^\/\//i.test(value))) {
    return `${which} needs value: a path inside the app, like "admin.html" or "" for its first page, or another app's page in a preview environment ("/a/<app>/_preview/<env>/")`
  }

  if (action === "wait" && step.state !== undefined && selector === undefined) {
    return `${which}: state needs selector, the element to wait for`
  }

  if (
    action === "wait" &&
    selector === undefined &&
    step.ms === undefined &&
    step.assert === undefined
  ) {
    return `${which} needs selector (wait until it's visible, or in state), assert (until it's true) or ms (wait that long)`
  }

  if (
    action === "expect" &&
    step.text === undefined &&
    step.textIncludes === undefined &&
    value === undefined &&
    step.count === undefined &&
    step.visible === undefined &&
    step.checked === undefined &&
    step.attr === undefined
  ) {
    return `${which} needs something to expect: text, textIncludes, value, count, visible, checked or attr; or status (and no selector) for the page's last data request`
  }

  if (action === "eval" && (step.script ?? "").trim() === "") {
    return `${which} needs script: the body of an async function to run in the page, e.g. "return document.title"`
  }

  return undefined
}

export const flowProblem = (steps: ReadonlyArray<CheckStep>, people: ReadonlyArray<string>) => {
  const saved = new Set<string>()

  for (const [index, step] of steps.entries()) {
    const which = `step ${index + 1} (${step.action})`
    const unknown = usedBy(step).find((name) => !saved.has(name))

    if (unknown !== undefined) {
      return `${which} uses {{${unknown}}}, but no step before it saves ${unknown}: add save: "${unknown}" to an earlier eval, expect or wait step`
    }

    if (step.as !== undefined && !people.includes(step.as)) {
      return `${which} has as: "${step.as}", which isn't one of people (${people.join(", ")}): add it to people`
    }

    if (step.save !== undefined) saved.add(step.save)
  }

  return undefined
}

type FilledStep = { -readonly [K in keyof CheckStep]: CheckStep[K] }

export const fillSaved = (step: CheckStep, saved: ReadonlyMap<string, string>): CheckStep => {
  const fill = (text: string) =>
    text.replaceAll(PLACEHOLDER, (whole, name: string) => saved.get(name) ?? whole)

  const filled: FilledStep = { ...step }

  for (const field of FILLED) {
    const text = step[field]

    if (text !== undefined) filled[field] = fill(text)
  }

  if (step.attr !== undefined) {
    filled.attr = { name: step.attr.name, value: fill(step.attr.value) }
  }

  return filled
}

const OTHER_IN_ENV = /^\/a\/[a-z0-9-]+\/_preview\/[a-z0-9-]+\//

const gotoUrl = (root: string, value: string) => {
  const current = new URL(root)

  const scoped =
    current.pathname !== "/" &&
    (value === current.pathname.slice(0, -1) || value.startsWith(current.pathname))

  return OTHER_IN_ENV.test(value) || scoped
    ? new URL(value, root).toString()
    : root + value.replace(/^\//, "")
}

const json = (value: string | number | boolean) => JSON.stringify(value)

export const label = (step: CheckStep) => {
  const named = (name: string, value: string | number | boolean | undefined) =>
    value === undefined ? undefined : `${name}=${json(value)}`

  return [
    step.action,
    step.selector,
    step.value === undefined
      ? undefined
      : step.action === "expect"
        ? `value=${json(step.value)}`
        : json(step.value),
    step.to === undefined ? undefined : `to ${step.to}`,
    step.state,
    named("text", step.text),
    named("textIncludes", step.textIncludes),
    named("count", step.count),
    named("visible", step.visible),
    named("checked", step.checked),
    step.attr === undefined ? undefined : `attr ${step.attr.name}=${json(step.attr.value)}`,
    named("status", step.status),
    named("path", step.path),
    step.script === undefined ? undefined : short(step.script.trim().replace(/\s+/g, " "), 80),
    step.assert === undefined ? undefined : `(assert ${short(step.assert.trim(), 80)})`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
}

const PAGE_LIB = `
  const clean = (s) => String(s == null ? "" : s).trim().replace(/\\s+/g, " ")
  const shown = (el) => {
    if (el.getClientRects().length === 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== "hidden" && style.opacity !== "0"
  }
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"])
  const find = (selector) => {
    if (!selector.startsWith("text=")) return [...document.querySelectorAll(selector)]
    const label = clean(selector.slice(5))
    const has = (el) => !SKIP.has(el.tagName) && (clean(el.textContent).includes(label) ||
      (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit") && clean(el.value).includes(label)))
    return [...document.querySelectorAll("body *")].filter((el) => has(el) && ![...el.children].some(has))
  }
  const pick = (all) => all.find(shown) || all[0] || null
  const field = (el) => el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA"
  const box = (el) => el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")
  const describe = (el) => el === null ? null : {
    tag: el.tagName.toLowerCase(),
    visible: shown(el),
    text: clean(el instanceof HTMLElement ? el.innerText : el.textContent).slice(0, 500),
    value: field(el) ? String(el.value) : null,
    checked: box(el) ? el.checked : null,
  }
`

const inPage = (body: string) => `(() => {${PAGE_LIB}\n${body}\n})()`

const pageAnswer = <A>(schema: Schema.Codec<A, A>) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))

  return (raw: string) =>
    Option.getOrThrowWith(decode(raw), () => new Problem("the page's answer couldn't be read"))
}

const Seen = Schema.Struct({
  tag: Schema.String,
  visible: Schema.Boolean,
  text: Schema.String,
  value: Schema.NullOr(Schema.String),
  checked: Schema.NullOr(Schema.Boolean),
})

type Seen = typeof Seen.Type

const Found = Schema.Struct({
  count: Schema.Number,
  shown: Schema.Number,
  element: Schema.NullOr(Seen),
  matchesText: Schema.Boolean,
  includesText: Schema.Boolean,
  attr: Schema.NullOr(Schema.String),
})

type Found = typeof Found.Type

const Invalid = Schema.Struct({ invalid: Schema.String })

const decodeProbe = pageAnswer(Schema.Union([Invalid, Found]))

const probe = async (
  page: Page,
  selector: string,
  attr?: string,
  want: Pick<CheckStep, "text" | "textIncludes"> = {},
) => {
  const raw = await within(5000, "looking at the page", () =>
    page.evaluate(
      inPage(`
        let all
        try { all = find(${json(selector)}) } catch (e) { return JSON.stringify({ invalid: String(e && e.message || e) }) }
        const el = pick(all)
        const attr = ${json(attr ?? "")}
        const text = el === null ? "" : clean(el instanceof HTMLElement ? el.innerText : el.textContent)
        return JSON.stringify({
          count: all.length,
          shown: all.filter(shown).length,
          element: describe(el),
          matchesText: text === ${json(want.text?.trim().replace(/\s+/g, " ") ?? "")},
          includesText: text.includes(${json(want.textIncludes ?? "")}),
          attr: el !== null && attr !== "" ? el.getAttribute(attr) : null,
        })
      `),
    ),
  )

  const probed = decodeProbe(String(raw))

  if ("invalid" in probed) {
    throw new Problem(
      `${selector} isn't a selector Chrome takes (${probed.invalid}); a selector is CSS, or text=Label`,
    )
  }

  return probed
}

type Outcome<A> = { readonly done: A } | { readonly not: string }

const DONE = { done: undefined }

const poll = async <A>(
  ms: number,
  stop: AbortSignal,
  attempt: () => Outcome<A> | Promise<Outcome<A>>,
) => {
  const deadline = Date.now() + ms

  for (;;) {
    if (stop.aborted) throw new Problem("the check stopped")

    const outcome = await attempt()

    if ("done" in outcome) return outcome.done

    if (Date.now() >= deadline) throw new Problem(`${outcome.not} (after ${seconds(ms)})`)

    await sleep(POLL_MS)
  }
}

const matches = (found: Found) =>
  found.count === 0
    ? "nothing matches"
    : `${found.count} match${found.count === 1 ? "" : "es"}, ${found.shown === 0 ? "none" : found.shown} shown`

const visibleOne = async (page: Page, selector: string, ms: number, stop: AbortSignal) => {
  await poll(ms, stop, async () => {
    const found = await probe(page, selector)

    if (found.shown > 0) return DONE

    return {
      not:
        found.count === 0
          ? `nothing matches ${selector}`
          : `nothing visible matches ${selector}: ${matches(found)}`,
    }
  })

  const handle = await within(5000, "finding the element", () =>
    page.evaluateHandle(inPage(`return find(${json(selector)}).find(shown) || null`)),
  )

  const element = handle.asElement()

  if (element === null) throw new Problem(`${selector} disappeared before the step could use it`)

  return element
}

const quote = (text: string) => json(short(text, 200))

const unmet = (step: CheckStep, found: Found) => {
  const misses: Array<string> = []
  const element = found.element

  if (step.count !== undefined && found.count !== step.count) {
    misses.push(`count ${step.count}, found ${found.count}`)
  }

  if (step.visible === false && (element === null || !element.visible)) {
  } else if (step.visible !== undefined && element?.visible !== step.visible) {
    misses.push(
      element === null
        ? "visible, found nothing matching"
        : step.visible
          ? "visible, found it hidden"
          : "hidden, found it visible",
    )
  }

  const about = (want: string, got: (seen: Seen) => string | undefined) => {
    if (element === null) {
      misses.push(`${want}, found nothing matching`)

      return
    }

    const miss = got(element)

    if (miss !== undefined) misses.push(`${want}, found ${miss}`)
  }

  const { text, textIncludes, value, checked, attr } = step

  if (text !== undefined) {
    const want = text.trim().replace(/\s+/g, " ")

    about(`text ${quote(want)}`, (seen) => (found.matchesText ? undefined : quote(seen.text)))
  }

  if (textIncludes !== undefined) {
    about(`text including ${quote(textIncludes)}`, (seen) =>
      found.includesText ? undefined : quote(seen.text),
    )
  }

  if (value !== undefined && step.action === "expect") {
    about(`value ${quote(value)}`, (seen) =>
      seen.value === value
        ? undefined
        : seen.value === null
          ? `a <${seen.tag}>, which has no value`
          : quote(seen.value),
    )
  }

  if (checked !== undefined) {
    about(checked ? "checked" : "unchecked", (seen) =>
      seen.checked === checked
        ? undefined
        : seen.checked === null
          ? `a <${seen.tag}>, not a checkbox or radio`
          : seen.checked
            ? "it checked"
            : "it unchecked",
    )
  }

  if (attr !== undefined) {
    about(`${attr.name}=${quote(attr.value)}`, () =>
      found.attr === attr.value
        ? undefined
        : found.attr === null
          ? `no ${attr.name} attribute`
          : `${attr.name}=${quote(found.attr)}`,
    )
  }

  return misses
}

const expect = (page: Page, step: CheckStep, selector: string, ms: number, stop: AbortSignal) =>
  poll(ms, stop, async () => {
    const misses = unmet(step, await probe(page, selector, step.attr?.name, step))

    return misses.length === 0 ? DONE : { not: `expected ${misses.join("; ")} for ${selector}` }
  })

const waitFor = (
  page: Page,
  selector: string,
  state: NonNullable<CheckStep["state"]>,
  ms: number,
  stop: AbortSignal,
) =>
  poll(ms, stop, async () => {
    const found = await probe(page, selector)

    const reached = {
      visible: found.shown > 0,
      hidden: found.shown === 0,
      attached: found.count > 0,
      detached: found.count === 0,
    }[state]

    return reached ? DONE : { not: `${selector} isn't ${state}: ${matches(found)}` }
  })

const choose = (selector: string, wanted: string) =>
  inPage(`
    const el = find(${json(selector)}).find(shown)
    const wanted = ${json(wanted)}
    if (!el) return ${json(`${selector} disappeared before the step could use it`)}
    if (el.tagName !== "SELECT") return "it's a <" + el.tagName.toLowerCase() + ">, not a <select>"
    if (el.disabled) return "the <select> is disabled"
    const options = [...el.options]
    const option = options.find((o) => o.value === wanted) || options.find((o) => clean(o.label) === clean(wanted))
    if (!option) {
      const listed = options.map((o) => clean(o.label) === o.value ? JSON.stringify(o.value) : JSON.stringify(o.value) + " (" + clean(o.label) + ")")
      return "no option has value or label " + JSON.stringify(wanted) + "; its options are " + listed.join(", ")
    }
    if (option.disabled) return "the option " + JSON.stringify(option.value) + " is disabled"
    el.focus()
    el.value = option.value
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return ""
  `)

const Filled = pageAnswer(
  Schema.Union([
    Schema.Struct({ problem: Schema.String }),
    Schema.Struct({ value: Schema.String, type: Schema.String }),
  ]),
)

const FORMATS = new Map([
  ["date", '"YYYY-MM-DD", like "2026-10-26"'],
  ["time", '"HH:MM" (24-hour), like "09:30"'],
  ["datetime-local", '"YYYY-MM-DDTHH:MM", like "2026-10-26T09:30"'],
  ["month", '"YYYY-MM", like "2026-10"'],
  ["week", '"YYYY-Www", like "2026-W43"'],
  ["color", 'a lowercase hex color "#rrggbb", like "#ff8800"'],
  ["range", "a number between its min and max (and on its step)"],
  ["number", "a number (and within its min, max and step)"],
])

/**
 * Set a field's value the way a script does, then tell the page: the native value setter (which
 * frameworks watch), then input and change. No keys are pressed, so an Enter-to-submit handler
 * doesn't fire and a date input gets the whole date. A contenteditable gets the text inserted.
 */
const fillSource = (selector: string, wanted: string) =>
  inPage(`
    const el = find(${json(selector)}).find(shown)
    const wanted = ${json(wanted)}
    const out = (o) => JSON.stringify(o)
    if (!el) return out({ problem: ${json(`${selector} disappeared before the step could use it`)} })
    const tag = el.tagName.toLowerCase()
    if (el.isContentEditable) {
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      if (wanted === "") document.execCommand("delete")
      else document.execCommand("insertText", false, wanted)
      return out({ value: el.innerText.replace(/\\n$/, ""), type: "contenteditable" })
    }
    if (tag === "select") return out({ problem: "it's a <select>: use the select action, with value its option's value or label" })
    if (tag !== "input" && tag !== "textarea") return out({ problem: "it's a <" + tag + ">, not a field (input, textarea or contenteditable); point selector at the field itself" })
    if (box(el)) return out({ problem: "it's a " + el.type + ": use the check or uncheck action" })
    if (el.type === "file") return out({ problem: "it's a file input: use the upload action, with value the file names to choose (\\"photo.png\\")" })
    if (el.disabled) return out({ problem: "the field is disabled" })
    if (el.readOnly) return out({ problem: "the field is read-only" })
    el.focus()
    const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, wanted)
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: wanted }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return out({ value: String(el.value), type: tag === "input" ? el.type : tag })
  `)

const fill = async (
  page: Page,
  selector: string,
  wanted: string,
  ms: number,
  stop: AbortSignal,
) => {
  await visibleOne(page, selector, ms, stop)

  const raw = await within(5000, "filling the field", () =>
    page.evaluate(fillSource(selector, wanted)),
  )

  const filled = Filled(String(raw))

  if ("problem" in filled) throw new Problem(filled.problem)

  if (filled.value === wanted) return ""

  const format = FORMATS.get(filled.type)

  throw new Problem(
    `the field holds ${quote(filled.value)} after the fill, not ${quote(wanted)}: ${
      format === undefined
        ? "the page changed it as it came in (an input or change handler), or the field doesn't take it (maxlength, pattern)"
        : `a ${filled.type} input takes ${format}, and drops a value in any other form`
    }`,
  )
}

const Uploaded = pageAnswer(
  Schema.Union([
    Schema.Struct({ chose: Schema.Array(Schema.String) }),
    Schema.Struct({ problem: Schema.String }),
  ]),
)

/**
 * Choose files for a file input as a person does: each made in the page to fit its name (a real image for an image's
 * extension, a one-page PDF, text, else random bytes), set on the input with a DataTransfer, then input and change. The input
 * may be hidden: a styled "Choose files" button usually covers one.
 */
const uploadSource = (selector: string, names: string) => `(async () => {${PAGE_LIB}
  const out = (o) => JSON.stringify(o)
  const el = find(${json(selector)})[0]
  if (!el) return out({ problem: ${json(`nothing matches ${selector}`)} })
  if (el.tagName.toLowerCase() !== "input" || el.type !== "file") return out({ problem: "it's a <" + el.tagName.toLowerCase() + (el.type ? " type=" + el.type : "") + ">, not a file input: point selector at the <input type=file> itself, even when a label or button covers it" })
  if (el.disabled) return out({ problem: "the file input is disabled" })
  const wanted = ${json(names)}.split(",").map((n) => n.trim()).filter(Boolean)
  if (wanted.length > 1 && !el.multiple) return out({ problem: "the input takes one file (no multiple attribute), and value names " + wanted.length })
  const units = { b: 1, kb: 1024, mb: 1024 * 1024 }
  const files = []
  for (const one of wanted) {
    const [, name, amount, unit] = /^(.+?)(?::(\\d+(?:\\.\\d+)?)\\s*(b|kb|mb))?$/i.exec(one) ?? [, one]
    const size = amount === undefined ? 0 : Math.round(Number(amount) * units[unit.toLowerCase()])
    if (size > 200 * 1024 * 1024) return out({ problem: one + ": files made for a check go up to 200MB" })
    const ext = (name.split(".").pop() ?? "").toLowerCase()
    const image = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext]
    let parts
    let type
    if (image) {
      const canvas = document.createElement("canvas")
      canvas.width = 320
      canvas.height = 240
      const g = canvas.getContext("2d")
      g.fillStyle = "#" + (Math.random() * 0xffffff | 0).toString(16).padStart(6, "0")
      g.fillRect(0, 0, 320, 240)
      g.fillStyle = "#fff"
      g.font = "24px sans-serif"
      g.fillText(name, 16, 128)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, image === "image/gif" ? "image/png" : image))
      parts = [blob]
      type = image
    } else if (ext === "pdf") {
      const text = "BT /F1 24 Tf 72 720 Td (" + name.replace(/[()\\\\]/g, "") + ") Tj ET"
      const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", "<< /Length " + text.length + " >>\\nstream\\n" + text + "\\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
      let pdf = "%PDF-1.4\\n"
      const at = []
      objects.forEach((o, i) => { at.push(pdf.length); pdf += (i + 1) + " 0 obj\\n" + o + "\\nendobj\\n" })
      const xref = pdf.length
      pdf += "xref\\n0 " + (objects.length + 1) + "\\n0000000000 65535 f \\n" + at.map((n) => String(n).padStart(10, "0") + " 00000 n \\n").join("") + "trailer\\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\\nstartxref\\n" + xref + "\\n%%EOF\\n"
      parts = [pdf]
      type = "application/pdf"
    } else if (["txt", "csv", "md"].includes(ext)) {
      parts = [ext === "csv" ? "name,amount\\nada,12.50\\n" : "A file for a check: " + name + "\\n"]
      type = { txt: "text/plain", csv: "text/csv", md: "text/markdown" }[ext]
    } else {
      parts = [crypto.getRandomValues(new Uint8Array(Math.min(size || 1024, 65536)))]
      type = ""
    }
    let made = new Blob(parts).size
    while (made < size) {
      const pad = new Uint8Array(Math.min(size - made, 8 * 1024 * 1024))
      parts.push(pad)
      made += pad.length
    }
    files.push(new File(parts, name, { type }))
  }
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  el.files = transfer.files
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return out({ chose: files.map((f) => f.name + " (" + (f.type || "no type") + ", " + f.size + " bytes)") })
})()`

/** Put the caret after a field's text (some inputs, like date, have no caret: left as they are). */
const caretToEnd = (selector: string) =>
  inPage(`
    const el = find(${json(selector)}).find(shown)
    try { if (el && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length) } catch {}
    return ""
  `)

const boxState = (selector: string) =>
  inPage(`
    const el = pick(find(${json(selector)}))
    if (!el) return ${json(`nothing matches ${selector}`)}
    const input = el.tagName === "LABEL" ? el.control : el
    if (!input || !box(input)) return "it's a <" + el.tagName.toLowerCase() + ">, not a checkbox, radio or its label"
    return (input.checked ? "on" : "off") + ":" + input.type
  `)

const boxTarget = (selector: string) =>
  inPage(`
    const el = pick(find(${json(selector)}))
    const input = el.tagName === "LABEL" ? el.control : el
    if (shown(el)) return el
    if (shown(input)) return input
    return [...(input.labels || [])].find(shown) || null
  `)

const toggle = async (
  page: Page,
  selector: string,
  want: "on" | "off",
  ms: number,
  stop: AbortSignal,
) => {
  const state = async () =>
    String(await within(5000, "reading the box", () => page.evaluate(boxState(selector))))

  await waitFor(page, selector, "attached", ms, stop)

  const before = await state()

  if (!before.startsWith("on:") && !before.startsWith("off:")) throw new Problem(before)

  if (before.startsWith(`${want}:`)) return ` (already ${want === "on" ? "checked" : "unchecked"})`

  if (before === "on:radio") {
    throw new Problem(
      "a radio unchecks only when another in its group is checked: check that one instead",
    )
  }

  const target = await within(5000, "finding what to click", () =>
    page.evaluateHandle(boxTarget(selector)),
  )

  const element = target.asElement()

  if (element === null) {
    throw new Problem("the box and its labels are all hidden, so a person couldn't click it")
  }

  await within(5000, "the click", () => element.click())
  await poll(1000, stop, async () =>
    (await state()).startsWith(`${want}:`)
      ? DONE
      : {
          not: `clicked it, but it's still ${want === "on" ? "unchecked" : "checked"}: is it disabled, or does the page undo it?`,
        },
  )

  return ""
}

const DragPlan = pageAnswer(
  Schema.Union([
    Schema.Struct({ problem: Schema.String }),
    Schema.Struct({ far: Schema.Literal(true) }),
    Schema.Struct({
      from: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
      to: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
      draggable: Schema.Boolean,
    }),
  ]),
)

const DragSeen = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      start: Schema.Boolean,
      handled: Schema.Boolean,
      moved: Schema.Boolean,
      changes: Schema.Number,
    }),
  ),
)

const planDrag = (from: string, to: string) =>
  inPage(`
    const out = (o) => JSON.stringify(o)
    const src = find(${json(from)}).find(shown)
    const dst = find(${json(to)}).find(shown)
    if (!src || !dst) return out({ problem: "the element or where to drop it disappeared" })
    const CONTROL = "button, select, input, textarea, a[href], label, [contenteditable], [role=button]"
    const name = (el) => "<" + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length > 0 ? "." + [...el.classList].slice(0, 2).join(".") : "") + ">"
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
    const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    const covers = new Set()
    const grabPoint = () => {
      const a = src.getBoundingClientRect()
      const at = [0.5, 0.25, 0.75, 0.1, 0.9]
      for (const fy of at) {
        for (const fx of at) {
          const x = clamp(a.left + a.width * fx, 1, innerWidth - 1)
          const y = clamp(a.top + a.height * fy, 1, innerHeight - 1)
          const hit = document.elementFromPoint(x, y)
          if (!hit) continue
          if (!src.contains(hit)) { covers.add(name(hit) + " (on top of it)"); continue }
          const control = hit.closest(CONTROL)
          if (control && control !== src && src.contains(control)) { covers.add(name(control)); continue }
          return { x, y }
        }
      }
      return null
    }
    src.scrollIntoView({ block: "center", inline: "center" })
    if (!grabPoint()) {
      return out({ problem: "there's nowhere to grab " + ${json(from)} + ": every point of it is a control inside it or something over it (" + [...covers].join(", ") + "). Drag by a part of it that isn't a control (a handle, its text), or close what covers it" })
    }
    dst.scrollIntoView({ block: "nearest", inline: "nearest" })
    const draggable = !!src.closest("[draggable=true]")
    const grab = inView(src.getBoundingClientRect()) ? grabPoint() : null
    const b = dst.getBoundingClientRect()
    if (!grab && !draggable) {
      return out({ problem: ${json(from)} + " and " + ${json(to)} + " don't fit on the screen together (" + innerWidth + "x" + innerHeight + "), so a hand couldn't drag one onto the other; check at a wider width, or drag to something nearer" })
    }
    const drop = { x: clamp(b.left + b.width / 2, 1, innerWidth - 1), y: clamp(b.top + Math.min(b.height / 2, 40), 1, innerHeight - 1) }
    const seen = { start: false, handled: false, changes: 0, el: src, parent: src.parentElement, index: src.parentElement ? [...src.parentElement.children].indexOf(src) : -1 }
    seen.observer = new MutationObserver((records) => { seen.changes += records.length })
    seen.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    window.__openbeltCheckDrag = seen
    document.addEventListener("dragstart", () => { seen.start = true }, { capture: true, once: true })
    document.addEventListener("drop", (e) => { setTimeout(() => { if (e.defaultPrevented) seen.handled = true }) }, { capture: true, once: true })
    return out(grab ? { from: grab, to: drop, draggable } : { far: true })
  `)

const DRAG_SEEN = `(() => {
  const seen = window.__openbeltCheckDrag
  if (!seen) return JSON.stringify({ start: false, handled: false, moved: false, changes: 0 })
  seen.observer.disconnect()
  const parent = seen.el.parentElement
  const moved = !seen.el.isConnected || parent !== seen.parent || (parent ? [...parent.children].indexOf(seen.el) : -1) !== seen.index
  return JSON.stringify({ start: seen.start, handled: seen.handled, moved, changes: seen.changes })
})()`

const html5Drag = (from: string, to: string) =>
  inPage(`
    const src = find(${json(from)}).find(shown)
    const dst = find(${json(to)}).find(shown)
    if (!src || !dst) return "the element or where to drop it disappeared"
    const a = src.getBoundingClientRect()
    const b = dst.getBoundingClientRect()
    const x = b.left + b.width / 2
    const y = b.top + Math.min(b.height / 2, 40)
    const under = document.elementFromPoint(x, y)
    const at = under !== null && dst.contains(under) ? under : dst
    const dataTransfer = new DataTransfer()
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer, clientX: x, clientY: y }
    src.dispatchEvent(new DragEvent("dragstart", { ...init, clientX: a.left + a.width / 2, clientY: a.top + a.height / 2 }))
    src.dispatchEvent(new DragEvent("drag", init))
    at.dispatchEvent(new DragEvent("dragenter", init))
    at.dispatchEvent(new DragEvent("dragover", init))
    at.dispatchEvent(new DragEvent("drop", init))
    src.dispatchEvent(new DragEvent("dragend", init))
    return ""
  `)

const NOTHING_MOVED = " (warning: nothing moved in the DOM; follow with expect)"

const drag = async (page: Page, from: string, to: string, ms: number, stop: AbortSignal) => {
  await visibleOne(page, from, ms, stop)
  await visibleOne(page, to, ms, stop)

  const raw = await within(5000, "getting the drag ready", () => page.evaluate(planDrag(from, to)))
  const plan = DragPlan(String(raw))

  if ("problem" in plan) throw new Problem(plan.problem)

  if ("from" in plan) {
    const { from: start, to: end } = plan

    await within(10_000, "the drag", async () => {
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      // A few pixels first: drag code waits for the pointer to move past a threshold.
      await page.mouse.move(start.x + 6, start.y + 6, { steps: 3 })
      await page.mouse.move(end.x, end.y, { steps: 12 })
      await page.mouse.up()
    })
  }

  const started = await within(5000, "reading the drag", () =>
    page.evaluate("String(!!(window.__openbeltCheckDrag && window.__openbeltCheckDrag.start))"),
  )

  let how = ""

  if (String(started) !== "true" && ("far" in plan || plan.draggable)) {
    const problem = String(await within(5000, "the drag", () => page.evaluate(html5Drag(from, to))))

    if (problem !== "") throw new Problem(problem)

    how = " (HTML5 drag events)"
  }

  await settle(page)

  const seen = Option.getOrElse(
    DragSeen(String(await within(5000, "reading the drag", () => page.evaluate(DRAG_SEEN)))),
    () => ({ start: false, handled: false, moved: false, changes: 0 }),
  )

  return seen.moved || seen.handled || seen.changes > 0 ? how : `${how}${NOTHING_MOVED}`
}

const RESULT = "__openbeltCheckResult"

const evalSource = (script: string) => `(async () => {
  const shown = (result) => {
    if (result === undefined) return "undefined"
    if (result instanceof Element) return "<" + result.tagName.toLowerCase() + "> " + JSON.stringify(String(result.innerText || result.textContent || "").trim().slice(0, 200))
    try { return JSON.stringify(result) ?? String(result) } catch { return String(result) }
  }
  let result
  try {
    result = await (async () => {\n${script}\n})()
  } catch (e) {
    const error = { message: String(e && e.message !== undefined ? e.message : e).split("\\n")[0] }
    if (e && typeof e.status === "number") error.status = e.status
    if (e && typeof e.rule === "string") error.rule = e.rule
    if (e && typeof e.code === "string") error.code = e.code
    window.${RESULT} = error
    return JSON.stringify({ threw: error })
  }
  window.${RESULT} = result
  return JSON.stringify({ returned: shown(result) })
})()`

const Evaluation = Schema.Union([
  Schema.Struct({ returned: Schema.String }),
  Schema.Struct({
    threw: Schema.Struct({
      message: Schema.String,
      status: Schema.optionalKey(Schema.Number),
      rule: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.String),
    }),
  }),
])

const Evaluated = pageAnswer(Evaluation)

type Thrown = {
  readonly message: string
  readonly status?: number
  readonly rule?: string
  readonly code?: string
}

const thrownLine = (thrown: Thrown) => {
  const said = [
    thrown.status === undefined ? undefined : `status ${thrown.status}`,
    thrown.rule === undefined ? undefined : `rule ${thrown.rule}`,
    thrown.code === undefined ? undefined : `code ${thrown.code}`,
  ].filter((part) => part !== undefined)

  return `${short(thrown.message, 300)}${said.length === 0 ? "" : ` (${said.join(", ")})`}`
}

const assertSource = (expression: string, afterEval: boolean) =>
  `(async () => {${afterEval ? ` const result = window.${RESULT};` : ""} return !!(await (\n${expression}\n)) })()`

export const assertAfter = async (
  page: Page,
  expression: string,
  ms: number,
  afterEval: boolean,
  stop: AbortSignal,
) => {
  const limit = Math.max(ms, 1000) + 1000

  try {
    const syntax = await within(limit, "checking the assert", () =>
      page.evaluate((source) => {
        try {
          // oxlint-disable-next-line no-new, no-implied-eval -- compile in the browser without executing the assertion
          new Function(source)

          return ""
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }, `return async () => (\n${expression}\n)`),
    )

    if (syntax !== "") throw new Problem(`isn't a JS expression: SyntaxError: ${syntax}`)

    await poll(ms, stop, async () => {
      try {
        const value = await within(limit, "the assert", () =>
          page.evaluate(assertSource(expression, afterEval)),
        )

        return value === true ? DONE : { not: "was still false" }
      } catch (cause) {
        return { not: `threw: ${reason(cause)}` }
      }
    })
  } catch (cause) {
    throw new Problem(`assert ${json(short(expression.trim(), 120))} ${reason(cause)}`)
  }
}

type Actions = { readonly [A in CheckStep["action"]]: () => Promise<string> }

const savedOf = (result: string) => Option.getOrElse(decodeJsonString(result), () => result)

const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

type Ran = {
  readonly line: string
  readonly saved: string | undefined
  readonly threw: Thrown | undefined
}

export const BLOCKED_STATUS = 423

export type DataRequest = {
  readonly method: string
  readonly path: string
  readonly names: ReadonlyArray<string>
  status: number | null
  rule: string | undefined
  expected: boolean
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"])

const reaches = (request: DataRequest, path: string) => {
  const wanted = (path.split("?")[0] ?? "").replace(/\/+$/, "")

  return request.names.some((name) => name === wanted || name.startsWith(`${wanted}/`))
}

const lastRequest = (
  requests: () => ReadonlyArray<DataRequest>,
  step: CheckStep,
): Outcome<DataRequest> => {
  const path = step.path
  const matching = requests().filter((r) => path === undefined || reaches(r, path))
  const last = matching.findLast((r) => WRITES.has(r.method)) ?? matching.at(-1)
  const to = path === undefined ? "" : ` to ${path}`

  if (last === undefined) {
    return { not: `the page sent no data request${to} since this person's previous step` }
  }

  if (last.status === null) return { not: `${last.method} ${last.path} wasn't answered` }

  return { done: last }
}

const expectStatus = async (
  requests: () => ReadonlyArray<DataRequest>,
  step: CheckStep,
  wanted: number,
  stop: AbortSignal,
) => {
  const request = await poll(step.ms ?? RETRY_MS, stop, () => lastRequest(requests, step)).catch(
    (cause: Error) => {
      throw new Problem(`expected ${wanted}, but ${reason(cause)}`)
    },
  )

  const by = request.rule === undefined ? "" : ` (${request.rule})`

  const got =
    request.status === 0
      ? "no answer (the request failed)"
      : request.status === BLOCKED_STATUS
        ? `${BLOCKED_STATUS}: readonly: true blocked it before it reached OpenBelt, so no rule judged it (test rules in a preview, without readonly)`
        : `${request.status}${by}`

  if (request.status !== wanted) {
    throw new Problem(`expected ${wanted} from ${request.method} ${request.path}, got ${got}`)
  }

  request.expected = true

  return ` (${request.method} ${request.path} answered ${got})`
}

export const runStep = async (
  page: Page,
  root: string,
  step: CheckStep,
  requests: () => ReadonlyArray<DataRequest>,
  stop: AbortSignal,
): Promise<Ran> => {
  const name = step.save

  if (step.action === "expect" && step.status !== undefined) {
    const line = await expectStatus(requests, step, step.status, stop)

    return { line, saved: undefined, threw: undefined }
  }

  if (step.action === "eval") return evalStep(page, step)

  const line = await actionOf(page, root, step, stop)

  if (name === undefined) return { line, saved: undefined, threw: undefined }

  const { element } = await probe(page, step.selector ?? "")

  if (element === null)
    throw new Problem(`nothing matches ${step.selector ?? ""} to save as ${name}`)

  const saved = element.text === "" && element.value !== null ? element.value : element.text

  return { line: ` (saved as ${name}: ${json(short(saved, 200))})`, saved, threw: undefined }
}

const evalStep = async (page: Page, step: CheckStep): Promise<Ran> => {
  const name = step.save

  const raw = await within((step.ms ?? EVAL_MS) + 1000, "the script", () =>
    page.evaluate(evalSource(step.script ?? "")),
  ).catch((cause: Error) => {
    throw new Problem(`the script threw: ${reason(cause)}`)
  })

  const evaluated = Evaluated(String(raw))

  if ("threw" in evaluated) {
    const thrown = evaluated.threw

    if (name === undefined && step.assert !== undefined) {
      return { line: ` → threw: ${thrownLine(thrown)}`, saved: undefined, threw: thrown }
    }

    throw new Problem(
      `the script threw: ${thrownLine(thrown)}${
        thrown.status === undefined
          ? ""
          : `; to expect it, add assert: "result.status == ${thrown.status}" to this step, or catch it and follow with { action: "expect", status: ${thrown.status} }`
      }`,
    )
  }

  const result = evaluated.returned

  if (name === undefined)
    return { line: ` → ${short(result, MAX_RESULT)}`, saved: undefined, threw: undefined }

  if (result === "undefined") {
    throw new Problem(`the script returned nothing to save as ${name}: return the value`)
  }

  return {
    line: ` → ${short(result, MAX_RESULT)} (saved as ${name})`,
    saved: savedOf(result),
    threw: undefined,
  }
}

const actionOf = (page: Page, root: string, step: CheckStep, stop: AbortSignal) => {
  const ms = step.ms ?? RETRY_MS
  const selector = step.selector ?? ""

  const onOne = async (
    limit: number,
    what: string,
    act: (handle: Awaited<ReturnType<typeof visibleOne>>) => Promise<void>,
  ) => {
    const handle = await visibleOne(page, selector, ms, stop)

    await within(limit, what, () => act(handle))

    return ""
  }

  const actions: Actions = {
    click: () => onOne(5000, "the click", (handle) => handle.click()),
    hover: () => onOne(5000, "the hover", (handle) => handle.hover()),
    fill: () => fill(page, selector, step.value ?? "", ms, stop),
    type: () =>
      onOne(10_000, "typing", async (handle) => {
        await handle.click()
        await page.evaluate(caretToEnd(selector))
        await page.keyboard.type(step.value ?? "")
      }),
    select: async () => {
      await visibleOne(page, selector, ms, stop)

      const problem = String(
        await within(5000, "choosing the option", () =>
          page.evaluate(choose(selector, step.value ?? "")),
        ),
      )

      if (problem !== "") throw new Problem(problem)

      return ""
    },
    check: () => toggle(page, selector, "on", ms, stop),
    uncheck: () => toggle(page, selector, "off", ms, stop),
    drag: () => drag(page, selector, step.to ?? "", ms, stop),
    upload: async () => {
      const made = Uploaded(
        String(
          await within(60_000, "making and choosing the files", () =>
            page.evaluate(uploadSource(selector, step.value ?? "")),
          ),
        ),
      )

      if ("problem" in made) throw new Problem(made.problem)

      return ` → chose ${made.chose.join(", ")}`
    },
    scroll: async () => {
      if (step.selector !== undefined) {
        return onOne(5000, "scrolling", (handle) => handle.scrollIntoViewIfNeeded())
      }

      await within(5000, "scrolling", () =>
        page.evaluate(
          step.value === "top"
            ? "window.scrollTo(0, 0)"
            : "window.scrollTo(0, document.documentElement.scrollHeight)",
        ),
      )

      return ""
    },
    press: async () => {
      const chord = chordOf(step.value ?? "")

      await within(5000, "the key press", async () => {
        if (chord === undefined) return

        for (const modifier of chord.modifiers) await page.keyboard.down(modifier)

        const key = chord.named ?? (isCharKey(chord.key) ? chord.key : undefined)

        if (key === undefined || (chord.modifiers.length === 0 && chord.named === undefined)) {
          await page.keyboard.type(chord.key)
        } else {
          await page.keyboard.press(key)
        }

        for (const modifier of chord.modifiers.toReversed()) await page.keyboard.up(modifier)
      })

      return ""
    },
    wait: async () => {
      if (step.selector !== undefined) {
        await waitFor(page, selector, step.state ?? "visible", ms, stop)
      } else if (step.ms !== undefined) {
        await sleep(ms)
      }

      return ""
    },
    expect: async () => {
      await expect(page, step, selector, ms, stop)

      return ""
    },
    eval: async () => (await evalStep(page, step)).line,
    goto: async () => {
      const response = await within(LOAD_TIMEOUT_MS + 1000, "loading the page", () =>
        page.goto(gotoUrl(root, step.value ?? ""), {
          waitUntil: "load",
          timeout: LOAD_TIMEOUT_MS,
        }),
      )

      if (response !== null && response.status() >= 400) {
        throw new Problem(`the page answered ${response.status()}`)
      }

      return ""
    },
  }

  return actions[step.action]()
}
