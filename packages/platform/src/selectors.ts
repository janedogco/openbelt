const PLAIN = new Set([
  "active",
  "active-view-transition",
  "any-link",
  "autofill",
  "checked",
  "default",
  "defined",
  "disabled",
  "empty",
  "enabled",
  "first-child",
  "first-of-type",
  "focus",
  "focus-visible",
  "focus-within",
  "fullscreen",
  "future",
  "host",
  "hover",
  "in-range",
  "indeterminate",
  "invalid",
  "last-child",
  "last-of-type",
  "link",
  "modal",
  "only-child",
  "only-of-type",
  "optional",
  "out-of-range",
  "past",
  "picture-in-picture",
  "placeholder-shown",
  "popover-open",
  "read-only",
  "read-write",
  "required",
  "root",
  "scope",
  "target",
  "user-invalid",
  "user-valid",
  "valid",
  "visited",
  "xr-overlay",
  // CSS2's pseudo-elements, which still take one colon.
  "before",
  "after",
  "first-line",
  "first-letter",
])

const OF_SELECTORS = new Set(["not", "is", "where", "-webkit-any", "host", "host-context"])

const NTH = new Set(["nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type"])

const OF_WORDS = new Set(["lang", "dir", "state"])

const FOREIGN: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [
    ["has-text", "text", "text-is", "text-matches", "contains"],
    "use text=Label for the element showing Label, or an expect step with textIncludes",
  ],
  [
    ["visible", "hidden"],
    "actions and expect already use the first visible match; to assert it, expect with visible: true",
  ],
  [
    ["nth-match", "eq", "first", "last", "gt", "lt", "even", "odd"],
    "use :nth-child(2), :first-child or :last-child, or a more specific selector",
  ],
  [
    ["near", "left-of", "right-of", "above", "below", "parent", "header", "input", "button"],
    "name the element with an id, a class or an attribute instead",
  ],
  [["selected", "checkbox", "radio"], "use :checked, or [type=checkbox]"],
]

const FOREIGN_HINT = new Map(FOREIGN.flatMap(([names, hint]) => names.map((n) => [n, hint])))

const ESCAPE = String.raw`\\(?:[0-9a-fA-F]{1,6}\s?|[^\n0-9a-fA-F])`

const IDENT = new RegExp(
  String.raw`^(?:--|-?(?:[_a-zA-Z]|[^\0-\x7f]|${ESCAPE}))(?:[\w-]|[^\0-\x7f]|${ESCAPE})*`,
)

const STRING = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/

const AN_PLUS_B = /^(?:odd|even|[+-]?\d*n(?:\s*[+-]\s*\d+)?|[+-]?\d+)/i

const ATTR_OPERATOR = /^[~|^$*]?=/

class Unreadable {
  constructor(readonly why: string) {}
}

const fail = (why: string): never => {
  throw new Unreadable(why)
}

const read = (source: string) => {
  let at = 0
  let hasDepth = 0

  const rest = () => source.slice(at)

  const near = () => {
    const shown = rest().slice(0, 20)

    return shown === "" ? "at the end" : `at ${JSON.stringify(shown)}`
  }

  const space = () => {
    const skipped = /^\s*/.exec(rest())?.[0].length ?? 0

    at += skipped

    return skipped > 0
  }

  const take = (pattern: RegExp) => {
    const match = pattern.exec(rest())?.[0]

    if (match !== undefined) at += match.length

    return match
  }

  const ident = (what: string) => take(IDENT) ?? fail(`expected ${what} ${near()}`)

  const balanced = () => {
    let depth = 0

    while (at < source.length) {
      const char = source[at]

      if (char === "(") depth++

      if (char === ")") {
        if (depth === 0) return

        depth--
      }

      at++
    }

    fail("a ( is never closed")
  }

  const close = (name: string) => {
    space()

    if (take(/^\)/) === undefined) fail(`:${name}( isn't closed with ) ${near()}`)
  }

  const attribute = () => {
    space()
    ident("an attribute name after [")
    space()

    if (take(ATTR_OPERATOR) !== undefined) {
      space()

      if (take(STRING) === undefined && take(IDENT) === undefined) {
        fail(`an attribute value is a word or a quoted string, ${near()}`)
      }

      space()
      take(/^[iI](?![\w-])/)
      space()
    }

    if (take(/^\]/) === undefined) fail(`expected ] ${near()}`)
  }

  const pseudoElement = () => {
    ident("a pseudo-element name after ::")

    if (take(/^\(/) !== undefined) {
      balanced()
      take(/^\)/)
    }
  }

  const pseudoClass = () => {
    const name = ident("a pseudo-class name after :").toLowerCase()
    const hint = FOREIGN_HINT.get(name)

    if (hint !== undefined) {
      fail(`:${name}${rest().startsWith("(") ? "()" : ""} is from Playwright or jQuery; ${hint}`)
    }

    const call = take(/^\(/) !== undefined

    if (!call) {
      if (!PLAIN.has(name) && !name.startsWith("-webkit-")) {
        fail(
          OF_SELECTORS.has(name) || NTH.has(name) || OF_WORDS.has(name) || name === "has"
            ? `:${name} needs ( ) with its argument`
            : `:${name} isn't a CSS pseudo-class`,
        )
      }

      return
    }

    space()

    if (name === "has" && hasDepth > 0) fail(":has() can't be inside another :has()")

    if ((name === "is" || name === "where") && rest().startsWith(")")) {
      // Forgiving: :is() with nothing in it matches nothing, and is allowed.
    } else if (OF_SELECTORS.has(name) || name === "has") {
      if (name === "has") hasDepth++

      list(name === "has", true)

      if (name === "has") hasDepth--
    } else if (NTH.has(name)) {
      if (take(AN_PLUS_B) === undefined) {
        fail(`:${name}() takes a number, odd, even or an+b like 2n+1, ${near()}`)
      }

      space()

      if (name.endsWith("child") && take(/^of\s/i) !== undefined) list(false, true)
    } else if (OF_WORDS.has(name) || name.startsWith("-webkit-")) {
      const start = at

      balanced()

      if (source.slice(start, at).trim() === "")
        fail(`:${name}() needs its argument, e.g. :lang(en)`)
    } else {
      fail(`:${name}() isn't a CSS pseudo-class`)
    }

    close(name)
  }

  const compound = () => {
    const start = at

    // A namespace prefix: any (*|) or none (|); a named one needs an @namespace a page can't have.
    take(/^\*?\|(?!=)/)

    if (take(/^\*/) === undefined) take(IDENT)

    for (;;) {
      if (take(/^#/) !== undefined)
        ident('an id after # (an id can\'t start with a digit in CSS: use [id="…"])')
      else if (take(/^\./) !== undefined) ident("a class name after .")
      else if (take(/^\[/) !== undefined) attribute()
      else if (take(/^::/) !== undefined) {
        // Chrome takes nothing after a pseudo-element in the same compound.
        pseudoElement()
        break
      } else if (take(/^:/) !== undefined) pseudoClass()
      else break
    }

    if (at === start) fail(`expected a selector ${near()}`)
  }

  const complex = (relative: boolean) => {
    space()

    if (relative && take(/^[>+~]/) !== undefined) space()

    compound()

    for (;;) {
      const spaced = space()

      if (take(/^[>+~]/) !== undefined) {
        space()
        compound()
      } else if (spaced && at < source.length && !/^[,)]/.test(rest())) {
        compound()
      } else {
        return
      }
    }
  }

  const list = (relative: boolean, nested: boolean) => {
    complex(relative)

    while (take(/^,/) !== undefined) complex(relative)

    if (!nested && at < source.length) fail(`unexpected ${near()}`)
  }

  list(false, false)
}

const PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(role|xpath|css|id|data-testid|placeholder|label|alt|title)=/, "is Playwright's"],
  [/^\(?\/\//, "is XPath"],
]

export const selectorProblem = (selector: string) => {
  if (selector.trim() === "") return "the selector is empty"

  if (selector.startsWith("text=")) {
    return selector.slice(5).trim() === ""
      ? "text= needs the text to look for, e.g. text=Save"
      : undefined
  }

  for (const [pattern, whose] of PREFIXES) {
    if (pattern.test(selector)) {
      return `${JSON.stringify(selector)} ${whose}, not CSS: use CSS like [role=button], or text=Label`
    }
  }

  if (selector.includes(">>")) {
    return `${JSON.stringify(selector)} chains with >>, which is Playwright's: in CSS, a space means inside and > means directly inside`
  }

  try {
    read(selector)

    return undefined
  } catch (error) {
    if (error instanceof Unreadable)
      return `${JSON.stringify(selector)} isn't valid CSS: ${error.why}`

    throw error
  }
}
