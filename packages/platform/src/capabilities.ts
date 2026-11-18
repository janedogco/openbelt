import * as Runtime from "./runtime/index.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { Json, SecretDeclared } from "./model.ts"
import { byteString, fromByteString, redactor, SECRET_LENGTH, Unchecked } from "./redaction.ts"
import { saysWho } from "./session.ts"
import { lookedUp, type Reach, type sealing, urlProblem } from "./upstream.ts"

export const OUTBOUND_LIMITS = {
  requests: 50,
  responseBytes: 1_000_000,
  /** A request may carry a file a function read (files.ts FILE_READ_BYTES). */
  requestBytes: 10 * 1024 * 1024,
  ms: 10_000,
} as const

const newNonce = () => crypto.getRandomValues(new Uint8Array(16)).toHex()

const RECENT_NONCES = 10_000

export const nonceBook = () => {
  const live = new Set<string>()
  const ended = new Set<string>()

  return {
    issue: () => {
      const nonce = newNonce()

      live.add(nonce)

      return nonce
    },
    end: (nonce: string) => {
      live.delete(nonce)
      ended.add(nonce)

      for (const old of ended) {
        if (ended.size <= RECENT_NONCES) break

        ended.delete(old)
      }
    },
    whose: (nonce: string): "live" | "ended" | undefined =>
      live.has(nonce) ? "live" : ended.has(nonce) ? "ended" : undefined,
  }
}

export type Nonces = Pick<ReturnType<typeof nonceBook>, "whose">

const placeholders = (nonce: string) =>
  new RegExp(
    String.raw`\{\{secret:([A-Za-z0-9_]+):(?:${nonce})\}\}|%7[Bb]%7[Bb]secret(?::|%3[Aa])([A-Za-z0-9_]+)(?::|%3[Aa])(?:${nonce})%7[Dd]%7[Dd]`,
    "g",
  )

const noncesIn = (text: string, known: (nonce: string) => boolean) => {
  const found = new Set<string>()

  for (const [digits] of text.matchAll(/[0-9a-f]{32,}/gi)) {
    const lower = digits.toLowerCase()

    for (let at = 0; at + 32 <= lower.length; at += 1) {
      const nonce = lower.slice(at, at + 32)

      if (known(nonce)) found.add(nonce)
    }
  }

  return found
}

const noncesAsWritten = (nonces: Iterable<string>) =>
  new RegExp(String.raw`(?::|%3a|%253a|\\u003a)?(?:${[...nonces].join("|")})`, "gi")

export const forget = (text: string, nonces: Nonces) => {
  const found = noncesIn(text, (n) => nonces.whose(n) !== undefined)

  return found.size === 0 ? text : text.replaceAll(noncesAsWritten(found), "")
}

export const forgetJson = (json: Json, nonces: Nonces): Json => {
  const walk = (v: Json): Json => {
    if (Predicate.isString(v)) return forget(v, nonces)

    if (v === null || Predicate.isNumber(v) || Predicate.isBoolean(v)) return v

    if (Array.isArray(v)) return v.map(walk)

    return Object.fromEntries(Object.entries(v).map(([k, x]) => [forget(k, nonces), walk(x)]))
  }

  return walk(json)
}

const LOOKALIKE =
  /(?:\{|%7b|%257b|\\u007b)\s*(?:\{|%7b|%257b|\\u007b)\s*secret\s*(?::|%3a|%253a|\\u003a)/i

const asComponent = (value: string) =>
  encodeURIComponent(value.toWellFormed()).replaceAll(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const asForm = (value: string) => asComponent(value).replaceAll("%20", "+")

const asJsonString = (value: string) => JSON.stringify(value).slice(1, -1)

type BodyKind = "form" | "json" | "other"

const bodyKindOf = (headers: ReadonlyArray<readonly [string, string]>): BodyKind => {
  const type = (headers.findLast(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase()

  if (type === "application/x-www-form-urlencoded") return "form"

  return type === "application/json" || type?.endsWith("+json") === true ? "json" : "other"
}

const inJsonString = (text: string, at: ReadonlyArray<number>) => {
  const inside = new Set<number>()
  let open = false
  let i = 0

  for (const target of at) {
    while (i < target) {
      const c = text.charCodeAt(i)

      if (open && c === 0x5c) i += 2
      else {
        if (c === 0x22) open = !open
        i += 1
      }
    }

    if (open && i === target) inside.add(target)
  }

  return inside
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const stringsOf = (text: string, kind: "form" | "json") => {
  if (kind === "form") return [...new URLSearchParams(text)].flat()

  const decoded = decodeJsonText(text)

  if (Option.isNone(decoded)) return undefined

  const out: Array<string> = []

  const walk = (v: Json): void => {
    if (Predicate.isString(v)) out.push(v)
    else if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v !== null && !Predicate.isNumber(v) && !Predicate.isBoolean(v))
      for (const [k, x] of Object.entries(v)) {
        out.push(k)
        walk(x)
      }
  }

  walk(decoded.value)

  return out
}

const utf8Bytes = (text: string) => byteString(new TextEncoder().encode(text))

const countOf = (text: string, part: string) => (part === "" ? 0 : text.split(part).length - 1)

const placeholdersIn = (text: string, nonce: string) =>
  [...text.matchAll(placeholders(nonce))].map((m) => m[1] ?? m[2] ?? "")

const setSecretCommand = (app: string, name: string, origin: string) =>
  `bun run workspace secrets set ${app} ${name} --url ${origin} (it reads the value from stdin)`

export const howToSet = (app: string, name: string, origin: string) =>
  `set it with the set_secret tool: set_secret({ app: "${app}", name: "${name}", value: "..." }) (agents can set or replace a secret, never read it), or in a terminal: ${setSecretCommand(app, name, origin)}`

type RunSecrets = {
  readonly declared: ReadonlyMap<string, SecretDeclared>
  readonly values: ReadonlyMap<string, string>
  readonly problems: ReadonlyMap<string, string>
}

type Policy = {
  readonly app: string
  readonly origin: string
  readonly network: ReadonlyArray<string>
  readonly secrets: RunSecrets
  readonly reach: Reach
  readonly preview: { readonly env: string; readonly live: boolean } | null
  readonly nonce: string
  readonly nonces: Nonces
}

const readsOnly = (method: string) => ["GET", "HEAD"].includes(method.toUpperCase())

type Sent = {
  readonly url: string
  readonly method: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | null
}

type Fetched = {
  readonly status: number
  readonly statusText: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

type Outcome =
  | { readonly ok: true; readonly reply: Fetched; readonly line: string; readonly effect: boolean }
  | {
      readonly ok: false
      readonly error: string
      readonly line: string
      readonly effect: boolean
    }

const replaceAll = (text: string, value: string, by: string) =>
  value === "" ? text : text.split(value).join(by)

export const scrub = (text: string, values: ReadonlyMap<string, string>) => {
  let out = text

  for (const [name, value] of [...values].toSorted(([, a], [, b]) => b.length - a.length))
    if (value.length >= 4) out = replaceAll(out, value, `[secret ${name}]`)

  return out
}

export const scrubJson = (json: Json, values: ReadonlyMap<string, string>): Json => {
  if (values.size === 0) return json

  const walk = (v: Json): Json => {
    if (Predicate.isString(v)) return scrub(v, values)

    if (Predicate.isNumber(v)) {
      const shown = scrub(String(v), values)

      return shown === String(v) ? v : shown
    }

    if (v === null || Predicate.isBoolean(v)) return v

    if (Array.isArray(v)) return v.map(walk)

    return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k, values), walk(x)]))
  }

  return walk(json)
}

const readCapped = async (response: Response, max: number) => {
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read a chunk at a time
    const { done, value } = await reader.read()

    if (done) break

    size += value.byteLength

    if (size > max) {
      // oxlint-disable-next-line no-await-in-loop -- it ends the loop
      await reader.cancel()

      return undefined
    }

    chunks.push(value)
  }

  const out = new Uint8Array(size)
  let at = 0

  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }

  return out
}

const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * A function's fetch, as a span (`fetch <host>`, openbelt.outbound "function", the status) and a count in the outbound metrics. It is
 * sent by `fetch` itself, not Effect's HttpClient: the secrets' checks are byte for byte, and the answer is read raw.
 */
export const outbound = Effect.fnUntraced(function* (sent: Sent, policy: Policy, fn: string) {
  const host = URL.canParse(sent.url) ? new URL(sent.url).host : "?"
  const started = Date.now()

  return yield* Effect.gen(function* () {
    const listed =
      URL.canParse(sent.url) &&
      urlProblem(sent.url, policy.reach, "fetch") === undefined &&
      policy.network.includes(host)

    const pointsInside = listed ? yield* lookedUp(sent.url) : undefined
    const outcome = yield* send(sent, policy, fn, pointsInside)
    const status = outcome.ok ? `${Math.floor(outcome.reply.status / 100)}xx` : "refused"

    yield* Effect.annotateCurrentSpan({ "openbelt.status": status })
    yield* Runtime.recordOutbound("function", status, Date.now() - started)

    return outcome
  }).pipe(
    Effect.withSpan(`fetch ${host}`, {
      kind: "client",
      attributes: { "openbelt.outbound": "function", "openbelt.host": host },
    }),
  )
})

const failedInside = (
  sent: Sent,
  policy: Policy,
  fn: string,
  handed: boolean,
  error: Error,
): Outcome => {
  const method = sent.method.toUpperCase()
  const host = URL.canParse(sent.url) ? new URL(sent.url).host : "?"
  const effect = handed && !readsOnly(method)

  return {
    ok: false,
    error:
      error instanceof Unchecked
        ? `fetch ${method} ${host}: it was sent, but ${error.message}, so OpenBelt withheld the answer`
        : `fetch ${method} ${host}: OpenBelt failed ${handed ? "reading its answer" : "sending it"}${effect ? " (it was sent)" : ""}; app_logs has the detail`,
    line: `function ${fn}: fetch ${method} ${host} failed inside OpenBelt${handed ? " after it was sent" : ""}: ${detailOf(`${error}`, policy.secrets.values)}`,
    effect,
  }
}

export const detailOf = (error: string, values: ReadonlyMap<string, string>) => {
  try {
    return redactor(values).text(scrub(error, values)).slice(0, 300)
  } catch {
    return "(withheld: it couldn't be checked for secrets)"
  }
}

export const carriedIn = (
  values: ReadonlyMap<string, string>,
  parts: ReadonlyArray<string | Uint8Array>,
  among: (name: string) => boolean,
):
  | { readonly kind: "secret"; readonly name: string }
  | { readonly kind: "unchecked" }
  | undefined => {
  const scan = redactor(values)

  try {
    for (const part of parts) {
      const [name] = scan.holds(part, among)

      if (name !== undefined) return { kind: "secret", name }
    }
  } catch (error) {
    if (error instanceof Unchecked) return { kind: "unchecked" }

    throw error
  }

  return undefined
}

export const carriedMessage = (
  app: string,
  carried: NonNullable<ReturnType<typeof carriedIn>>,
  to: string,
) =>
  carried.kind === "unchecked"
    ? `OpenBelt couldn't check it for ${app}'s secrets in time (it holds much of one), so it didn't send it`
    : `it holds the value of ${app}'s secret ${carried.name} (as it is, escaped or encoded), which isn't for ${to}, so OpenBelt didn't send it: a secret's value goes only to the hosts it's pinned to, filled in from secrets.${carried.name}`

const send = (sent: Sent, policy: Policy, fn: string, pointsInside: string | undefined) =>
  Effect.promise(() => {
    const handed = { sent: false }

    return attempt(sent, policy, fn, pointsInside, handed).catch((error: Error) =>
      failedInside(sent, policy, fn, handed.sent, error),
    )
  })

const attempt = async (
  sent: Sent,
  policy: Policy,
  fn: string,
  pointsInside: string | undefined,
  handed: { sent: boolean },
): Promise<Outcome> => {
  const started = Date.now()
  const { secrets, app, origin } = policy
  const method = sent.method.toUpperCase()

  if (!URL.canParse(sent.url)) {
    return {
      ok: false,
      error: `fetch: ${urlProblem(sent.url, policy.reach, "fetch")}`,
      line: `function ${fn}: fetch ${method} refused: not a URL`,
      effect: false,
    }
  }

  const url = new URL(sent.url)
  const where = `${url.host}${url.pathname}`
  const shown = `${method} ${where}${url.search === "" ? "" : "?…"}`

  const refuse = (error: string, why: string): Outcome => ({
    ok: false,
    error,
    line: `function ${fn}: fetch ${shown} refused (${why})`,
    effect: false,
  })

  const sentEffect = !readsOnly(method)

  const notPublic = urlProblem(sent.url, policy.reach, "fetch")

  if (notPublic !== undefined) return refuse(`fetch ${url.host}: ${notPublic}`, "not a public host")

  const listed = policy.network.includes(url.host)

  if (!listed) {
    return refuse(
      `fetch ${method} ${url.host}: ${app}'s openbelt.json "network" ${policy.network.length === 0 ? "lists no hosts" : `lists ${policy.network.join(", ")}`}, not "${url.host}", so its functions can't reach it. To allow it, add it and deploy: "network": [${[...policy.network, url.host].map((h) => JSON.stringify(h)).join(", ")}] (a host with a port, like "localhost:4599", allows only that port)`,
      "not in network",
    )
  }

  if (pointsInside !== undefined)
    return refuse(`fetch ${url.host}: ${pointsInside}`, "resolves to a private address")

  const body = sent.body === null ? null : Uint8Array.fromBase64(sent.body)

  if (body !== null && body.byteLength > OUTBOUND_LIMITS.requestBytes)
    return refuse(
      `fetch ${url.host}: its body is ${body.byteLength} bytes, over the limit of ${OUTBOUND_LIMITS.requestBytes}`,
      "body too big",
    )

  const rawBody = body === null ? "" : byteString(body)
  const { nonce } = policy
  const PLACEHOLDER = placeholders(nonce)

  const badName = sent.headers.find(
    ([k]) =>
      LOOKALIKE.test(k) ||
      noncesIn(k, (n) => n === nonce || policy.nonces.whose(n) !== undefined).size > 0,
  )

  if (badName !== undefined)
    return refuse(
      `fetch ${url.host}: a header's name holds a secret's placeholder, which OpenBelt fills in only in a header's value, the URL or the body, so it didn't send it: put secrets.NAME in the value ({ authorization: "Bearer " + secrets.NAME })`,
      "a placeholder in a header's name",
    )

  const texts = [sent.url, ...sent.headers.flat(), rawBody]

  const foreign = new Map(
    texts.flatMap((t) =>
      [...noncesIn(t, (n) => n !== nonce && policy.nonces.whose(n) !== undefined)].map(
        (n) => [n, policy.nonces.whose(n)] as const,
      ),
    ),
  )

  if (foreign.size > 0) {
    const theirs = placeholders([...foreign.keys()].join("|"))
    const [secret] = texts.flatMap((t) => [...t.matchAll(theirs)].map((m) => m[1] ?? m[2] ?? ""))
    const what = secret === undefined ? "a secret's placeholder" : `secrets.${secret}`
    const read = secret === undefined ? "secrets.NAME" : `secrets.${secret}`
    const earlier = [...foreign.values()].includes("ended")

    return refuse(
      `fetch ${url.host}: ${what} was read in ${earlier ? "an earlier run (kept in module scope?)" : "another run of this app that's going on now (kept in module scope?)"}, so OpenBelt didn't send it: read ${read} inside the run that sends the request`,
      earlier ? "an earlier run's placeholder" : "another run's placeholder",
    )
  }

  const named = new Set(texts.flatMap((t) => placeholdersIn(t, nonce)))
  const unfilled = texts.map((t) => t.replaceAll(PLACEHOLDER, ""))

  if (unfilled.some((t) => t.toLowerCase().includes(nonce)))
    return refuse(
      `fetch ${url.host}: it carries a secret's placeholder in a form OpenBelt doesn't fill in (it fills secrets.NAME as it is, or encoded once, as encodeURIComponent, URLSearchParams or a URL encode it; not encoded twice, \\u-escaped or in another case), so OpenBelt didn't send it: put secrets.NAME where the value goes`,
      "a placeholder it doesn't fill",
    )

  const lookalike = unfilled.some((t) => LOOKALIKE.test(t))

  for (const name of named) {
    const declared = secrets.declared.get(name)

    if (declared === undefined) {
      return refuse(
        `fetch ${url.host}: secrets.${name} isn't one of ${app}'s secrets: declare it in openbelt.json "secrets": {"${name}": "what it's for"}, deploy, then ${howToSet(app, name, origin)}`,
        `secret ${name} not declared`,
      )
    }

    const problem = secrets.problems.get(name)

    if (problem !== undefined)
      return refuse(`fetch ${url.host}: ${problem}`, `secret ${name} can't be sent now`)

    if (!secrets.values.has(name)) {
      return refuse(
        `fetch ${url.host}: ${app}'s secret ${name} isn't set yet, so OpenBelt didn't send the request: ${howToSet(app, name, origin)}`,
        `secret ${name} not set`,
      )
    }

    const hosts = declared.hosts ?? policy.network

    if (!hosts.includes(url.host)) {
      return refuse(
        `fetch ${url.host}: ${app}'s secret ${name} may only be sent to ${hosts.join(", ")} (openbelt.json "secrets"."${name}".hosts), not ${url.host}, so OpenBelt didn't send it. If ${url.host} should get it, add it to its hosts and deploy`,
        `secret ${name} not for this host`,
      )
    }
  }

  const mayGoHere = (name: string) => {
    const declared = secrets.declared.get(name)

    return (
      declared !== undefined &&
      !secrets.problems.has(name) &&
      (declared.hosts ?? policy.network).includes(url.host)
    )
  }

  const carried = carriedIn(
    secrets.values,
    [sent.url, url.href, ...sent.headers.flat(), body ?? ""],
    (n) => !mayGoHere(n),
  )

  if (carried !== undefined)
    return refuse(
      `fetch ${url.host}: ${carriedMessage(app, carried, url.host)}`,
      carried.kind === "unchecked"
        ? "too slow to check for secrets"
        : `holds secret ${carried.name}'s value, not for this host`,
    )

  if (policy.preview !== null && !policy.preview.live && !readsOnly(method)) {
    const stub = {
      previewed: true,
      method,
      url: `${url.origin}${url.pathname}`,
      note: `not sent: this run is in preview environment ${policy.preview.env}, and a ${method} changes things on ${url.host}, which is the real one. Live, it's sent. To test the real call, test it live, or a person lets this environment's functions send for real (preview_side_effects).`,
    }

    return {
      ok: true,
      effect: false,
      reply: {
        status: 200,
        statusText: "OK (previewed)",
        headers: [
          ["content-type", "application/json"],
          ["x-openbelt-previewed", "1"],
        ],
        body: new TextEncoder().encode(JSON.stringify(stub)).toBase64(),
      },
      line: `function ${fn}: fetch ${shown} not sent (preview ${policy.preview.env}: it isn't read-only; answered { previewed: true })`,
    }
  }

  const valueOf = (a: string | undefined, b: string | undefined) =>
    secrets.values.get(a ?? b ?? "") ?? ""

  const fill = (text: string, literal: (value: string) => string) =>
    text.replaceAll(PLACEHOLDER, (_, a: string | undefined, b: string | undefined) =>
      a === undefined ? asComponent(valueOf(a, b)) : literal(valueOf(a, b)),
    )

  const filled = named.size > 0
  const target = filled ? fill(sent.url, asComponent) : sent.url
  const parsed = URL.canParse(target) ? new URL(target) : undefined

  if (
    filled &&
    (parsed === undefined ||
      parsed.host !== url.host ||
      parsed.protocol !== url.protocol ||
      placeholdersIn(sent.url, nonce).some(
        (name, _, all) =>
          countOf(parsed.href, asComponent(secrets.values.get(name) ?? "")) <
          all.filter((n) => n === name).length,
      ))
  )
    return refuse(
      `fetch ${url.host}: a secret filled into its URL (percent-encoded, as a part of a URL is) wouldn't reach ${url.host} as it is (parsed, the URL changes it), so OpenBelt didn't send it: put the secret in a header (authorization: "Bearer " + secrets.NAME) or the body`,
      "the URL changes a secret filled into it",
    )

  const headers = new Headers()

  for (const [k, v] of sent.headers) {
    if (saysWho(k) || ["accept-encoding", "host"].includes(k.toLowerCase())) continue

    try {
      headers.append(k, filled ? fill(v, (value) => value) : v)
    } catch {
      return refuse(
        `fetch ${url.host}: its header ${k.slice(0, 60)} isn't a valid header value${filled && placeholdersIn(v, nonce).length > 0 ? " with its secret filled in (a header value can't hold a line break or a NUL character)" : ""}, so OpenBelt didn't send it`,
        `header ${k.slice(0, 60)} not valid`,
      )
    }
  }

  headers.set("accept-encoding", DECODED.join(", "))

  const inBody = [...rawBody.matchAll(PLACEHOLDER)]
  const kind = bodyKindOf(sent.headers)

  const inString = inJsonString(rawBody, kind === "json" ? inBody.map((m) => m.index) : [])

  if (kind === "json" && inBody.some((m) => !inString.has(m.index)))
    return refuse(
      `fetch ${url.host}: its JSON body has a secret outside a string (or right after a \\ in one), where OpenBelt can't fill it in as JSON, so it didn't send it: put it in one (JSON.stringify({ key: secrets.NAME }))`,
      "a secret outside a JSON string",
    )

  if (
    kind === "form" &&
    inBody.some((m) => /%[0-9A-Fa-f]?$/.test(rawBody.slice(Math.max(0, m.index - 2), m.index)))
  )
    return refuse(
      `fetch ${url.host}: its form body has a secret right after a % that isn't an escape, which the host would read with the secret's first characters as one, so OpenBelt didn't send it: send a form (new URLSearchParams({ key: secrets.NAME })), which encodes the %`,
      "a secret after a % in a form",
    )

  const filledBody =
    inBody.length === 0
      ? rawBody
      : fill(rawBody, (value) =>
          kind === "form"
            ? asForm(value)
            : utf8Bytes(kind === "json" ? asJsonString(value) : value),
        )

  if (inBody.length > 0 && kind !== "other") {
    const text = decodeUtf8(fromByteString(filledBody))
    const decoded = text === undefined ? undefined : stringsOf(text, kind)
    const wanted = new Map<string, number>()

    for (const m of inBody) {
      const value = secrets.values.get(m[1] ?? m[2] ?? "") ?? ""
      const as = kind === "json" && m[1] === undefined ? asComponent(value) : value

      wanted.set(as, (wanted.get(as) ?? 0) + 1)
    }

    if (
      decoded === undefined ||
      [...wanted].some(([as, times]) => decoded.reduce((n, d) => n + countOf(d, as), 0) < times)
    )
      return refuse(
        `fetch ${url.host}: a secret filled into its ${kind === "form" ? "form" : "JSON"} body wouldn't reach ${url.host} as it is (decoded as ${kind === "form" ? "a form" : "JSON"}, the body doesn't hold it), so OpenBelt didn't send it: send a body that is ${kind === "form" ? "a form (new URLSearchParams({ key: secrets.NAME }))" : "JSON (JSON.stringify({ key: secrets.NAME }))"}`,
        `the ${kind} body changes a secret filled into it`,
      )
  }

  const outBody = body === null ? null : inBody.length === 0 ? body : fromByteString(filledBody)

  let response: Response

  handed.sent = true

  try {
    response = await fetch(parsed?.href ?? target, {
      method,
      headers,
      body: outBody === null || method === "GET" || method === "HEAD" ? null : outBody,
      redirect: "manual",
      signal: AbortSignal.timeout(OUTBOUND_LIMITS.ms),
    })
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")

    return {
      ok: false,
      error: timedOut
        ? `fetch ${method} ${url.host}: no answer within ${OUTBOUND_LIMITS.ms / 1000}s`
        : `fetch ${method} ${url.host} failed: no answer (it couldn't connect, or the connection broke)${sentEffect ? "; it may have been sent" : ""}. app_logs has the runtime's error`,
      line: `function ${fn}: fetch ${shown} failed after ${Date.now() - started}ms: ${timedOut ? "timeout" : detailOf(String(error), secrets.values)}`,
      effect: sentEffect,
    }
  }

  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase() ?? "identity"

  if (encoding !== "identity" && !DECODED.some((e) => e === encoding)) {
    await response.body?.cancel()

    return {
      ok: false,
      error: `fetch ${method} ${url.host}: it answered with Content-Encoding ${encoding.slice(0, 40)}, which OpenBelt doesn't decode (it asks for ${DECODED.join(" or ")}, or none), so the answer was refused. Ask the server for an uncompressed answer`,
      line: `function ${fn}: fetch ${shown} → ${response.status} in ${Date.now() - started}ms, Content-Encoding ${encoding.slice(0, 40)}: refused`,
      effect: sentEffect,
    }
  }

  const bytes = await readCapped(response, OUTBOUND_LIMITS.responseBytes)
  const ms = Date.now() - started

  if (bytes === undefined) {
    return {
      ok: false,
      error: `fetch ${method} ${url.host}: its answer is over ${OUTBOUND_LIMITS.responseBytes / 1_000_000} MB, the most a function may read; ask for less`,
      line: `function ${fn}: fetch ${shown} → ${response.status} in ${ms}ms, over ${OUTBOUND_LIMITS.responseBytes} bytes: refused`,
      effect: sentEffect,
    }
  }

  const used = [...named].filter((n) => secrets.values.has(n))
  const redact = redactor(secrets.values)
  const shownBody = redact.bytes(bytes)
  const statusText = redact.text(response.statusText)
  let redacted = shownBody !== bytes || statusText !== response.statusText
  const replyHeaders: Array<readonly [string, string]> = []

  for (const [k, v] of response.headers) {
    const name = redact.text(k)
    const clean = redact.text(v)

    if (clean !== v || name !== k) redacted = true

    if (k !== "content-length") replyHeaders.push([name, clean])
  }

  return {
    ok: true,
    effect: sentEffect,
    reply: {
      status: response.status,
      statusText,
      headers: replyHeaders,
      body: shownBody.toBase64(),
    },
    line: `function ${fn}: fetch ${shown} → ${response.status} in ${ms}ms, ${bytes.byteLength} bytes${used.length === 0 ? "" : `, with secret ${used.join(", ")}`}${lookalike ? `, ${UNFILLED}` : ""}${redacted ? " (echoed secret redacted)" : ""}${redirectNote(response, url, policy.network, redact.text)}`,
  }
}

const redirectNote = (
  response: Response,
  from: URL,
  network: ReadonlyArray<string>,
  redact: (text: string) => string,
) => {
  const location =
    response.status >= 300 && response.status < 400 ? response.headers.get("location") : null

  if (location === null || !URL.canParse(location, from.href)) return ""

  const to = new URL(location, from)
  const shown = redact(`${to.origin}${to.pathname}${to.search === "" ? "" : "?…"}`)

  return `; a redirect to ${shown}, which fetch doesn't follow: fetch it there${network.includes(to.host) ? "" : `, once openbelt.json "network" lists "${to.host}"`}`
}

const UNFILLED =
  "it held text like a secret's placeholder that isn't this run's (from data, or {{secret:NAME}} written out), sent as it is: only secrets.NAME read in the run that sends it is filled (one kept in module scope from an earlier run isn't)"

const DECODED = ["gzip", "br"] as const

export const redactAnswer = (values: ReadonlyMap<string, string>) => {
  const redact = redactor(values)

  const json = (v: Json): Json => {
    if (Predicate.isString(v)) return redact.text(v)

    if (Predicate.isNumber(v)) {
      const shown = redact.text(String(v))

      return shown === String(v) ? v : shown
    }

    if (v === null || Predicate.isBoolean(v)) return v

    if (Array.isArray(v)) return v.map(json)

    return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact.text(k), json(x)]))
  }

  return { text: redact.text, json }
}

export const hmacHex = (key: string, text: string) =>
  Effect.promise(async () => {
    const imported = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )

    const signed = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text))

    return [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("")
  })

const ctxNamesIn = (code: string, member: string, dotted: string, quoted: string) => {
  const destructured = new RegExp(`[(,]\\s*\\{[^{}()]*\\b${member}\\b[^{}()]*\\}\\s*\\)`).test(code)

  const owner = destructured
    ? `(?:[\\w$]+\\s*(?:\\?\\.|\\.)\\s*)?`
    : `[\\w$]+\\s*(?:\\?\\.|\\.)\\s*`

  const at = `(?<![\\w$.])${owner}${member}`

  return [
    ...code.matchAll(new RegExp(`${at}\\s*(?:\\?\\.|\\.)\\s*(${dotted})\\b`, "g")),
    ...code.matchAll(new RegExp(`${at}\\s*\\[\\s*["'\`](${quoted})["'\`]\\s*\\]`, "g")),
  ].map((m) => m[1] ?? "")
}

export const secretsNamedIn = (code: string) =>
  new Set([
    ...ctxNamesIn(code, "secrets", "[A-Z][A-Z0-9_]*", "[A-Z][A-Z0-9_]*"),
    ...[...code.matchAll(/\bsecrets\s*(?:\?\.|\.)\s*hmac\s*\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g)].map(
      (m) => m[1] ?? "",
    ),
  ])

export const connectionsNamedIn = (code: string) =>
  new Set(ctxNamesIn(code, "connections", "[a-z][a-z0-9_]*", "[a-z][a-z0-9-]*"))

export const functionsRunIn = (code: string) =>
  new Map(
    [
      ...code.matchAll(
        /(?<![\w$.])(?:[\w$]+\s*(?:\?\.|\.)\s*)?(call|later)\s*\(\s*["'`]([a-z0-9_-]+)["'`]/g,
      ),
    ].map((m) => [m[2] ?? "", m[1] === "later" ? "ctx.later" : "ctx.call"]),
  )

export const functionsCalledIn = (text: string) =>
  new Set([...text.matchAll(/[\w$]\s*\(\s*["'`]([a-z0-9_-]+)["'`]/g)].map((m) => m[1] ?? ""))

export const hostsFetchedIn = (code: string) =>
  new Set(
    [...code.matchAll(/\bfetch\s*\(\s*["'`](https?:\/\/[^/"'`$?#\s]+)/g)].flatMap((m) => {
      const url = m[1] ?? ""

      return URL.canParse(url) ? [new URL(url).host] : []
    }),
  )

const Held = Schema.fromJsonString(
  Schema.Struct({ value: Schema.String, hosts: Schema.Array(Schema.String) }),
)

const decodeHeld = Schema.decodeUnknownOption(Held)

export type HeldSecret = { readonly value: string; readonly hosts: ReadonlyArray<string> }

export const widened = (
  app: string,
  name: string,
  held: HeldSecret,
  now: ReadonlyArray<string>,
  origin: string,
) => {
  const added = now.filter((h) => !held.hosts.includes(h))

  if (added.length === 0) return undefined

  return `${app}'s secret ${name} was set to go only to ${held.hosts.length === 0 ? "no host (secrets.hmac only)" : held.hosts.join(", ")}, and the openbelt.json deployed since sends it to ${added.join(", ")} too, so OpenBelt won't send it until a person who knows where it may go sets it again: ${howToSet(app, name, origin)}`
}

export const tooShort = (app: string, name: string, held: HeldSecret, origin: string) =>
  held.value.length >= SECRET_LENGTH.min
    ? undefined
    : `${app}'s secret ${name} is ${held.value.length} characters, shorter than the ${SECRET_LENGTH.min} a secret must be (OpenBelt couldn't tell it from ordinary text in what a host answers), so it isn't sent: a person sets the full key again: ${howToSet(app, name, origin)}`

export const secretValueProblem = (value: string) => {
  if (value.length < SECRET_LENGTH.min || value.length > SECRET_LENGTH.max)
    return `a secret's value is ${SECRET_LENGTH.min} to ${SECRET_LENGTH.max} characters, and this one is ${value.length}: OpenBelt puts each secret back as its placeholder wherever a host's answer has it, so one shorter would hide ordinary text. Set the whole key`

  if (value.includes("\uFFFD") || !value.isWellFormed())
    return "a secret's value holds U+FFFD (the replacement character) or half of a UTF-16 surrogate pair, which no issued key does: it was mangled on the way (bytes that weren't UTF-8, or a string cut inside a character). Copy the key again exactly as its service shows it, and set it"

  if (value.trim() !== value)
    return "a secret's value starts or ends with whitespace (a space, tab or line break), which a header drops when it's sent, so the host would get another key than the one set: set it without it"

  return undefined
}

export const unsignable = (
  app: string,
  name: string,
  held: HeldSecret,
  network: ReadonlyArray<string>,
) => {
  const beyond = network.filter((h) => !held.hosts.includes(h))

  if (beyond.length === 0) return undefined

  const all = [...held.hosts, ...beyond].map((h) => JSON.stringify(h)).join(", ")

  return `secrets.hmac: ${app}'s secret ${name} was set to go only to ${held.hosts.length === 0 ? "no host (secrets.hmac only)" : held.hosts.join(", ")}, and ${app}'s openbelt.json "network" lists ${beyond.join(", ")} too, where the code could send the signature, so OpenBelt won't sign with it. Take ${beyond.join(", ")} out of "network" and deploy; or, if ${beyond.length === 1 ? "that host" : "those hosts"} may have its signatures, a person sets it again pinned to them too: set_secret({ app: "${app}", name: "${name}", value: "...", hosts: [${all}] })`
}

export const openSecrets = Effect.fn("Secrets.open")(function* (
  storage: DurableObjectStorage,
  sealer: Effect.Success<ReturnType<typeof sealing>>,
  owner: string,
) {
  const { sql } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY, sealed TEXT NOT NULL, set_at TEXT NOT NULL, set_by TEXT NOT NULL)`)

  const bound = (name: string) => `secret:${owner}:${name}`

  type Row = { name: string; sealed: string; set_at: string; set_by: string }

  // Every function run reads the app's secrets (their names, then their values, to redact echoes): kept until a set or a removal,
  // which forget them before and after (a turn that fails after its write leaves nothing remembered).
  let known: ReadonlyArray<Row> | undefined

  const forgetRows = Effect.sync(() => {
    known = undefined
  })

  const rows = () =>
    known !== undefined
      ? Effect.succeed(known)
      : Effect.flatMap(sql.exec<Row>("SELECT name, sealed, set_at, set_by FROM secrets"), (c) =>
          Effect.map(c.toArray(), (all) => {
            known = all

            return all
          }),
        )

  const set = Effect.fnUntraced(function* (
    name: string,
    value: string,
    hosts: ReadonlyArray<string>,
    by: string,
  ) {
    const sealed = yield* sealer.seal(JSON.stringify({ value, hosts }), bound(name))
    const at = new Date().toISOString()
    const replaced = (yield* rows()).some((r) => r.name === name)

    yield* sql.exec(
      `INSERT INTO secrets (name, sealed, set_at, set_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, set_at = excluded.set_at, set_by = excluded.set_by`,
      name,
      sealed,
      at,
      by,
    )

    return { at, replaced }
  })

  const remove = Effect.fnUntraced(function* (name: string) {
    const had = (yield* rows()).some((r) => r.name === name)

    yield* sql.exec("DELETE FROM secrets WHERE name = ?", name)

    return had
  })

  return {
    set: (...args: Parameters<typeof set>) =>
      Effect.ensuring(Effect.andThen(forgetRows, set(...args)), forgetRows),
    remove: (name: string) => Effect.ensuring(Effect.andThen(forgetRows, remove(name)), forgetRows),
    status: Effect.fnUntraced(function* () {
      return new Map((yield* rows()).map((r) => [r.name, { at: r.set_at, by: r.set_by }] as const))
    }),
    values: Effect.fnUntraced(function* (names: Iterable<string>) {
      const wanted = new Set(names)
      const out = new Map<string, HeldSecret>()

      // Every function run asks, most for none: no read then (it was 4 statements a write, with its live queries).
      if (wanted.size === 0) return out

      for (const row of yield* rows()) {
        if (!wanted.has(row.name)) continue

        const opened = yield* sealer.open(row.sealed, bound(row.name))
        const held = opened === undefined ? undefined : decodeHeld(opened)

        if (opened !== undefined)
          out.set(
            row.name,
            held !== undefined && Option.isSome(held) ? held.value : { value: opened, hosts: [] },
          )
      }

      return out
    }),
  }
})
