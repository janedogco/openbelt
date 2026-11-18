import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Webhook } from "./model.ts"
import type { sealing } from "./upstream.ts"

export type HookCheck =
  | {
      readonly kind: "hmac"
      readonly header: string
      readonly prefix: string
      readonly encoding: "hex" | "base64"
    }
  | { readonly kind: "stripe"; readonly header: string }
  | { readonly kind: "token" }
  | { readonly kind: "none" }

export const checkOf = (hook: Webhook): HookCheck => {
  switch (hook.verify) {
    case "hmac-sha256":
      return {
        kind: "hmac",
        header: hook.header ?? "X-Signature",
        prefix: hook.prefix ?? "sha256=",
        encoding: hook.encoding ?? "hex",
      }
    case "github":
      return {
        kind: "hmac",
        header: "X-Hub-Signature-256",
        prefix: "sha256=",
        encoding: "hex",
      }
    case "stripe":
      return { kind: "stripe", header: "Stripe-Signature" }
    case "token":
      return { kind: "token" }
    default:
      return { kind: "none" }
  }
}

export const headerOf = (check: HookCheck) =>
  check.kind === "hmac" || check.kind === "stripe" ? check.header : null

const newSecret = () =>
  `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("")}`

const keyOf = (fn: string, env: string | undefined) =>
  env === undefined ? `hook:${fn}` : `hook@${env}:${fn}`

const Kept = Schema.Struct({ sealed: Schema.String, at: Schema.String })

const decodeKept = Schema.decodeUnknownOption(Kept)

type Sealer = Effect.Success<ReturnType<typeof sealing>>

export const openHookSecrets = (kv: DurableObjectStorage["kv"], sealer: Sealer, owner: string) => {
  const bound = (key: string) => `${owner}:${key}`

  return {
    get: Effect.fnUntraced(function* (fn: string, env: string | undefined) {
      const key = keyOf(fn, env)
      const kept = decodeKept(kv.get(key))

      if (Option.isNone(kept)) return undefined

      const secret = yield* sealer.open(kept.value.sealed, bound(key))

      return secret === undefined ? undefined : { secret, at: kept.value.at }
    }),

    make: Effect.fnUntraced(function* (fn: string, env: string | undefined) {
      const key = keyOf(fn, env)
      const made = { secret: newSecret(), at: new Date().toISOString() }

      kv.put(key, { sealed: yield* sealer.seal(made.secret, bound(key)), at: made.at })

      return made
    }),

    dropEnv: (env: string) => {
      for (const [key] of kv.list({ prefix: `hook@${env}:` })) kv.delete(key)
    },
  }
}

const hmac = async (secret: string, bytes: Uint8Array<ArrayBuffer>) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes))
}

/** `prefix` then `bytes`: Stripe signs "<t>.<raw body>". */
const after = (prefix: string, bytes: Uint8Array) => {
  const head = new TextEncoder().encode(prefix)
  const joined = new Uint8Array(head.length + bytes.length)

  joined.set(head)
  joined.set(bytes, head.length)

  return joined
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

const same = (a: string, b: string) => {
  let diff = a.length ^ b.length

  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)

  return diff === 0
}

/** Stripe's tolerance for a signature's timestamp. */
const STRIPE_SECONDS = 300

export const deliveryProblem = async (
  check: HookCheck,
  secret: string | undefined,
  raw: Uint8Array<ArrayBuffer>,
  header: (name: string) => string | undefined,
  token: string | undefined,
): Promise<string | undefined> => {
  if (check.kind === "none") return undefined

  if (secret === undefined)
    return "this webhook has no secret yet, so no delivery can be checked: the app's agent makes one with webhook_secret"

  if (check.kind === "token")
    return token !== undefined && same(token, secret)
      ? undefined
      : "the URL's token isn't this webhook's: use the URL webhook_secret shows"

  const sent = header(check.header)

  if (sent === undefined || sent === "")
    return `there's no ${check.header} header: deliveries are signed (HMAC-SHA256 of the raw body with the webhook's secret)`

  if (check.kind === "stripe") {
    const parts = new Map<string, Array<string>>()

    for (const part of sent.split(",")) {
      const [k = "", v = ""] = part.trim().split("=", 2)

      parts.set(k, [...(parts.get(k) ?? []), v])
    }

    const t = parts.get("t")?.[0]
    const v1 = parts.get("v1") ?? []

    if (t === undefined || v1.length === 0)
      return `${check.header} isn't t=<timestamp>,v1=<signature>`

    if (Math.abs(Date.now() / 1000 - Number(t)) > STRIPE_SECONDS)
      return `${check.header}'s timestamp is more than ${STRIPE_SECONDS}s from now`

    const want = hex(await hmac(secret, after(`${t}.`, raw)))

    return v1.some((sig) => same(sig, want))
      ? undefined
      : `${check.header} doesn't match the body: sign "<t>.<raw body>" with the webhook's secret`
  }

  if (!sent.startsWith(check.prefix))
    return `${check.header} doesn't start with "${check.prefix}": send ${check.header}: ${check.prefix}<${check.encoding} HMAC-SHA256 of the raw body>`

  const mac = await hmac(secret, raw)
  const want = check.encoding === "hex" ? hex(mac) : base64(mac)
  const got = sent.slice(check.prefix.length).trim()

  return same(check.encoding === "hex" ? got.toLowerCase() : got, want)
    ? undefined
    : `${check.header} doesn't match the body: it's the ${check.encoding} HMAC-SHA256 of the raw body, as sent, with the webhook's secret`
}

/** Headers a function never sees from a delivery: cookies, credentials, OpenBelt's and a proxy's own. */
const HIDDEN =
  /^(cookie|authorization|proxy-authorization|cf-|x-openbelt-|x-forwarded-|cdn-loop|x-real-ip)/i

export const shownHeaders = (headers: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined || HIDDEN.test(name) ? [] : [[name.toLowerCase(), value]],
    ),
  )

export const signedAs = async (
  check: HookCheck,
  secret: string,
  raw: Uint8Array<ArrayBuffer>,
  how: "good" | "bad" | "none",
): Promise<{ readonly headers: Record<string, string>; readonly token: string | undefined }> => {
  if (how === "none" || check.kind === "none") return { headers: {}, token: undefined }

  const key = how === "good" ? secret : `${secret}-wrong`

  if (check.kind === "token") return { headers: {}, token: key }

  if (check.kind === "stripe") {
    const t = Math.floor(Date.now() / 1000)

    return {
      headers: { [check.header]: `t=${t},v1=${hex(await hmac(key, after(`${t}.`, raw)))}` },
      token: undefined,
    }
  }

  const mac = await hmac(key, raw)

  return {
    headers: {
      [check.header]: `${check.prefix}${check.encoding === "hex" ? hex(mac) : base64(mac)}`,
    },
    token: undefined,
  }
}
