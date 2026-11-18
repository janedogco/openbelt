import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

type Json = Schema.Json

const RULE_OPS = ["read", "create", "update", "delete"] as const

export type RuleOp = (typeof RULE_OPS)[number]

const MAX_GETS = 2

export type RuleDoc = {
  readonly id: string
  readonly author: string
  readonly updatedBy: string
  readonly data: Json
}

const DOC_FIELDS = ["id", "author", "updatedBy", "data"] as const

type Node =
  | { readonly kind: "value"; readonly value: Json }
  | { readonly kind: "me" | "signedIn" | "id" | "doc" | "newDoc" }
  | { readonly kind: "get"; readonly collection: string; readonly id: Node }
  | { readonly kind: "field"; readonly of: Node; readonly name: string }
  | { readonly kind: "not"; readonly of: Node }
  | { readonly kind: "&&" | "||"; readonly left: Node; readonly right: Node }
  | { readonly kind: "==" | "!=" | "+"; readonly left: Node; readonly right: Node }

type Holds = "doc" | "data" | "plain"

type Token = { readonly start: number; readonly end: number } & (
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "string"; readonly text: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "op"; readonly text: string }
)

const VOCABULARY =
  "anyone, nobody, signedIn, me, id, doc, newDoc, get('collection', id), 'text', numbers, true, false, null, with == != && || ! + and ( )"

const COLLECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

class RuleError extends Error {
  constructor(readonly problem: string) {
    super(problem)
  }
}

const TOKEN =
  /\s+|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|'([^']*)'|"([^"]*)"|(==|!=|&&|\|\||[!+().,])/y

const tokenize = (source: string) => {
  const tokens: Array<Token> = []
  const next = new RegExp(TOKEN)

  while (next.lastIndex < source.length) {
    const start = next.lastIndex
    const match = next.exec(source)

    if (match === null) {
      const rest = source.slice(start)

      throw new RuleError(
        rest.startsWith("'") || rest.startsWith('"')
          ? `the text starting ${rest.slice(0, 20)} isn't closed`
          : rest.startsWith("=")
            ? "compare with == (one = is not a comparison)"
            : `"${rest.slice(0, 10)}" isn't part of a rule: use ${VOCABULARY}`,
      )
    }

    const [, name, number, single, double, op] = match
    const end = next.lastIndex
    const text = single ?? double

    if (name !== undefined) tokens.push({ kind: "name", text: name, start, end })
    else if (number !== undefined)
      tokens.push({ kind: "number", value: Number(number), start, end })
    else if (text !== undefined) tokens.push({ kind: "string", text, start, end })
    else if (op !== undefined) tokens.push({ kind: "op", text: op, start, end })
  }

  return tokens
}

const tokenText = (token: Token) => {
  switch (token.kind) {
    case "string":
      return JSON.stringify(token.text)
    case "number":
      return String(token.value)
    default:
      return token.text
  }
}

type Parsed = { readonly node: Node; readonly holds: Holds }

const parse = (source: string, op: RuleOp) => {
  const tokens = tokenize(source)
  let at = 0
  const gets = new Set<string>()

  const peek = () => tokens[at]

  const isOp = (text: string) => {
    const token = peek()

    return token?.kind === "op" && token.text === text
  }

  const expect = (text: string, after: string) => {
    if (!isOp(text)) throw new RuleError(`expected ${text} after ${after}`)

    at += 1
  }

  const binary = (
    ops: ReadonlyArray<"==" | "!=" | "&&" | "||" | "+">,
    next: () => Parsed,
    once: boolean,
  ): Parsed => {
    let left = next()

    for (;;) {
      const found = ops.find((o) => isOp(o))

      if (found === undefined) return left

      at += 1

      const right = next()

      left = { node: { kind: found, left: left.node, right: right.node }, holds: "plain" }

      if (once && ops.some((o) => isOp(o))) {
        throw new RuleError(`chain comparisons with &&: a == b && b == c, not a == b == c`)
      }
    }
  }

  const primary = (): Parsed => {
    const token = peek()

    if (token === undefined) throw new RuleError("the rule ends too soon")

    at += 1

    if (token.kind === "string")
      return { node: { kind: "value", value: token.text }, holds: "plain" }

    if (token.kind === "number") {
      return { node: { kind: "value", value: token.value }, holds: "plain" }
    }

    if (token.kind === "op") {
      if (token.text !== "(") throw new RuleError(`unexpected ${token.text}: use ${VOCABULARY}`)

      const inner = or()

      expect(")", "(...")

      return inner
    }

    switch (token.text) {
      case "anyone":
      case "true":
        return { node: { kind: "value", value: true }, holds: "plain" }
      case "nobody":
      case "false":
        return { node: { kind: "value", value: false }, holds: "plain" }
      case "null":
        return { node: { kind: "value", value: null }, holds: "plain" }
      case "me":
        return { node: { kind: "me" }, holds: "plain" }
      case "signedIn":
        return { node: { kind: "signedIn" }, holds: "plain" }
      case "id":
        return { node: { kind: "id" }, holds: "plain" }
      case "doc":
        if (op === "create") {
          throw new RuleError(
            "a create rule has no doc (nothing is stored yet): use newDoc, the document being created",
          )
        }

        return { node: { kind: "doc" }, holds: "doc" }
      case "newDoc":
        if (op === "read" || op === "delete") {
          throw new RuleError(
            `a ${op} rule has no newDoc (nothing is written): use doc, the stored document`,
          )
        }

        return { node: { kind: "newDoc" }, holds: "doc" }
      case "get": {
        expect("(", "get")

        const collection = peek()

        if (collection?.kind !== "string" || !COLLECTION_NAME.test(collection.text)) {
          throw new RuleError(
            "get's first argument is a collection name in quotes: get('polls', newDoc.data.poll)",
          )
        }

        at += 1
        expect(",", `get('${collection.text}'`)

        const from = at
        const id = or()

        gets.add(`${collection.text}(${tokens.slice(from, at).map(tokenText).join(" ")}`)

        if (gets.size > MAX_GETS) {
          throw new RuleError(
            `a rule makes at most ${MAX_GETS} get() lookups (the same get('collection', id) twice counts once)`,
          )
        }

        expect(")", `get('${collection.text}', ...`)

        return { node: { kind: "get", collection: collection.text, id: id.node }, holds: "doc" }
      }

      default:
        throw new RuleError(`"${token.text}" isn't a name rules know: use ${VOCABULARY}`)
    }
  }

  const member = (): Parsed => {
    let left = primary()

    while (isOp(".")) {
      at += 1

      const name = peek()

      if (name?.kind !== "name") throw new RuleError("expected a field name after .")

      at += 1

      if (left.holds === "plain") {
        throw new RuleError(
          `.${name.text} reads a field of doc, newDoc or get(...), not of another value`,
        )
      }

      if (left.holds === "doc" && !DOC_FIELDS.some((f) => f === name.text)) {
        throw new RuleError(
          `a document has .id, .author, .updatedBy and .data; its fields are under .data: .data.${name.text}`,
        )
      }

      left = {
        node: { kind: "field", of: left.node, name: name.text },
        holds: left.holds === "doc" && name.text !== "data" ? "plain" : "data",
      }
    }

    return left
  }

  const unary = (): Parsed => {
    if (!isOp("!")) return member()

    at += 1

    return { node: { kind: "not", of: unary().node }, holds: "plain" }
  }

  const sum = () => binary(["+"], unary, false)
  const equality = () => binary(["==", "!="], sum, true)
  const and = () => binary(["&&"], equality, false)
  const or = (): Parsed => binary(["||"], and, false)

  const tree = or()
  const left = peek()

  if (left !== undefined) {
    throw new RuleError(
      `unexpected ${left.kind === "number" ? left.value : left.text}: join conditions with && or ||`,
    )
  }

  return tree.node
}

export const ruleProblem = (op: RuleOp, source: string) => {
  try {
    parse(source, op)

    return undefined
  } catch (error) {
    if (error instanceof RuleError) return `rule ${op} "${source}": ${error.problem}`

    throw error
  }
}

const walk = (node: Node, visit: (node: Node) => void) => {
  visit(node)

  switch (node.kind) {
    case "get":
      return walk(node.id, visit)
    case "field":
    case "not":
      return walk(node.of, visit)
    case "==":
    case "!=":
    case "&&":
    case "||":
    case "+":
      walk(node.left, visit)

      return walk(node.right, visit)
  }
}

const usesViewer = (op: RuleOp, source: string) => {
  let uses = false

  walk(parse(source, op), (node) => {
    if (
      node.kind === "me" ||
      node.kind === "signedIn" ||
      (node.kind === "field" && (node.name === "author" || node.name === "updatedBy"))
    ) {
      uses = true
    }
  })

  return uses
}

export type RuleSet = { readonly [op in RuleOp]: string }

const SUGGESTED: RuleSet = {
  read: "anyone",
  create: "signedIn",
  update: "doc.author == me",
  delete: "doc.author == me",
}

export const unstatedOps = (
  rules: Readonly<Record<string, { readonly [op in RuleOp]?: string }>>,
) => {
  const problems: Array<string> = []

  for (const [key, set] of Object.entries(rules)) {
    const missing = RULE_OPS.filter((op) => set[op] === undefined)

    if (missing.length === 0) continue

    const add = missing.map((op) => `"${op}": "${SUGGESTED[op]}"`).join(", ")

    problems.push(
      `rules.${key} is missing ${missing.join(", ")}: add ${add} (or "anyone" / "nobody")`,
    )
  }

  return problems.length === 0
    ? undefined
    : `${problems.join("; ")}. A collection with rules states all four: read, create, update and delete`
}

export const matchKey = <A>(entries: Readonly<Record<string, A>>, collection: string) => {
  const own = entries[collection]

  if (own !== undefined) return { key: collection, value: own }

  let best: { readonly key: string; readonly value: A } | undefined

  for (const [key, value] of Object.entries(entries)) {
    if (!key.endsWith("*") || !collection.startsWith(key.slice(0, -1))) continue

    if (best === undefined || key.length > best.key.length) best = { key, value }
  }

  return best
}

const asRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

const fieldOf = (value: Json, name: string): Json =>
  Option.match(asRecord(value), {
    onNone: () => null,
    onSome: (fields) => fields[name] ?? null,
  })

const truthy = (value: Json) => value !== null && value !== false && value !== 0 && value !== ""

const same = (a: Json, b: Json) => a === b || JSON.stringify(a) === JSON.stringify(b)

const plus = (a: Json, b: Json): Json => {
  if (Predicate.isNumber(a) && Predicate.isNumber(b)) return a + b

  const text = (v: Json) => (Predicate.isString(v) || Predicate.isNumber(v) ? String(v) : undefined)
  const left = text(a)
  const right = text(b)

  return left === undefined || right === undefined ? null : left + right
}

const asJson = (doc: RuleDoc | null): Json =>
  doc === null ? null : { id: doc.id, author: doc.author, updatedBy: doc.updatedBy, data: doc.data }

type RuleContext<R> = {
  readonly me: string | null
  readonly id: string
  readonly doc: RuleDoc | null
  readonly newDoc: RuleDoc | null
  readonly lookup: (collection: string, id: string) => Effect.Effect<RuleDoc | null, never, R>
}

const evaluate = <R>(node: Node, ctx: RuleContext<R>): Effect.Effect<Json, never, R> => {
  switch (node.kind) {
    case "value":
      return Effect.succeed(node.value)
    case "me":
      return Effect.succeed(ctx.me)
    case "signedIn":
      return Effect.succeed(ctx.me !== null)
    case "id":
      return Effect.succeed(ctx.id)
    case "doc":
      return Effect.succeed(asJson(ctx.doc))
    case "newDoc":
      return Effect.succeed(asJson(ctx.newDoc))
    case "field":
      return Effect.map(evaluate(node.of, ctx), (value) => fieldOf(value, node.name))
    case "not":
      return Effect.map(evaluate(node.of, ctx), (value) => !truthy(value))
    case "get":
      return Effect.flatMap(evaluate(node.id, ctx), (id) =>
        Predicate.isString(id) || Predicate.isNumber(id)
          ? Effect.map(ctx.lookup(node.collection, String(id)), asJson)
          : Effect.succeed(null),
      )
    case "&&":
      return Effect.flatMap(evaluate(node.left, ctx), (left) =>
        truthy(left) ? Effect.map(evaluate(node.right, ctx), truthy) : Effect.succeed(false),
      )
    case "||":
      return Effect.flatMap(evaluate(node.left, ctx), (left) =>
        truthy(left) ? Effect.succeed(true) : Effect.map(evaluate(node.right, ctx), truthy),
      )
  }

  const { kind, left, right } = node

  return Effect.map(Effect.all([evaluate(left, ctx), evaluate(right, ctx)]), ([a, b]) =>
    kind === "+" ? plus(a, b) : same(a, b) === (kind === "=="),
  )
}

type Denial = {
  readonly rule: string
  readonly failed: string
  readonly chain: boolean
}

export const UNREADABLE = "openbelt.json"

export const unreadableDenial = (problem: string): Denial => ({
  rule: UNREADABLE,
  failed: problem,
  chain: false,
})

/** What a page on the public host is refused for when openbelt.json "public" doesn't list it, whatever the collection's rules say. */
export const PUBLIC_RULE = 'openbelt.json "public"'

export const publicDenial = (failed: string): Denial => ({
  rule: PUBLIC_RULE,
  failed,
  chain: false,
})

export const deniedBy = (denial: Denial) =>
  denial.chain ? `${denial.rule} (failed: ${denial.failed})` : `${denial.rule}: ${denial.failed}`

const clausesOf = (source: string) => {
  const cuts: Array<Token> = []
  let depth = 0

  for (const token of tokenize(source)) {
    if (token.kind !== "op") continue

    if (token.text === "(") depth += 1
    else if (token.text === ")") depth -= 1
    else if (depth === 0 && token.text === "||") return [source.trim()]
    else if (depth === 0 && token.text === "&&") cuts.push(token)
  }

  const clauses: Array<string> = []
  let from = 0

  for (const cut of cuts) {
    clauses.push(source.slice(from, cut.start).trim())
    from = cut.end
  }

  clauses.push(source.slice(from).trim())

  return clauses
}

const SHOWN = 120

const brief = (clause: string) => {
  const tokens = tokenize(clause)
  let text = ""
  let from = 0
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]
    const comma = tokens[i + 3]

    const isGet =
      token?.kind === "name" && token.text === "get" && comma?.kind === "op" && comma.text === ","

    if (!isGet) {
      i += 1
      continue
    }

    let depth = 0
    let close = i + 1

    for (; close < tokens.length; close += 1) {
      const paren = tokens[close]

      if (paren?.kind === "op" && paren.text === "(") depth += 1
      else if (paren?.kind === "op" && paren.text === ")") depth -= 1

      if (depth === 0) break
    }

    const end = tokens[close]

    if (end === undefined) break

    text += `${clause.slice(from, comma.end)} ...`
    from = end.start
    i = close + 1
  }

  const flat = `${text}${clause.slice(from)}`.replaceAll(/\s+/g, " ")

  return flat.length > SHOWN ? `${flat.slice(0, SHOWN - 1)}…` : flat
}

export const judge = Effect.fnUntraced(function* <R>(
  rules: Readonly<Record<string, RuleSet>> | undefined,
  collection: string,
  op: RuleOp,
  ctx: RuleContext<R>,
) {
  const found = rules === undefined ? undefined : matchKey(rules, collection)

  if (found === undefined) return undefined

  const expression = found.value[op]
  const rule = `rules.${found.key}.${op}`

  const fetched = new Map<string, RuleDoc | null>()

  const lookup = (other: string, id: string) => {
    const key = JSON.stringify([other, id])
    const known = fetched.get(key)

    return known !== undefined
      ? Effect.succeed(known)
      : Effect.tap(ctx.lookup(other, id), (doc) => Effect.sync(() => fetched.set(key, doc)))
  }

  const clauses = Option.getOrElse(Option.liftThrowable(clausesOf)(expression), () => [expression])

  for (const clause of clauses) {
    const node = Option.liftThrowable(parse)(clause, op)

    const holds = Option.isSome(node) && truthy(yield* evaluate(node.value, { ...ctx, lookup }))

    if (!holds) {
      const shown = Option.getOrElse(Option.liftThrowable(brief)(clause), () => clause)

      const denial: Denial = { rule, failed: shown, chain: clauses.length > 1 }

      return denial
    }
  }

  return undefined
})

export const signedOutWarnings = (rules: Readonly<Record<string, RuleSet>>) => {
  const warnings: Array<string> = []

  for (const [key, set] of Object.entries(rules)) {
    for (const op of RULE_OPS) {
      const expression = set[op]

      if (expression !== undefined && usesViewer(op, expression)) {
        warnings.push(
          `rules.${key}.${op} ("${expression}") depends on who is signed in, and sign-in is off on this host: on live nobody is signed in yet, so this rule refuses everyone`,
        )
      }
    }
  }

  return warnings
}

export const aggregateReadScope = (
  rules: Readonly<Record<string, RuleSet>> | undefined,
  collection: string,
  me: string | null,
): "all" | "owner" | "none" | undefined => {
  const source = rules === undefined ? undefined : matchKey(rules, collection)?.value.read

  if (source === undefined) return "all"
  const parsed = Option.liftThrowable(parse)(source, "read")

  if (Option.isNone(parsed)) return undefined
  const node = parsed.value

  if (node.kind === "value" && (node.value === true || node.value === false))
    return node.value ? "all" : "none"

  if (node.kind === "signedIn") return me === null ? "none" : "all"

  if (node.kind === "==") {
    const owner = (field: Node, viewer: Node) =>
      field.kind === "field" &&
      field.of.kind === "doc" &&
      field.name === "author" &&
      viewer.kind === "me"

    if (owner(node.left, node.right) || owner(node.right, node.left))
      return me === null ? "none" : "owner"
  }

  return undefined
}
