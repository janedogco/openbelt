import * as Schema from "effect/Schema"
import type { DurableObjectStorage } from "./runtime/index.ts"
import { positive } from "./runtime/settings.ts"

const RATE_LIMITS = {
  perMinute: positive("OPENBELT_RATE_PER_MINUTE", 3000),
  writesPerMinute: positive("OPENBELT_RATE_WRITES_PER_MINUTE", 600),
}

type Bucket = { readonly tokens: number; readonly at: number }

const buckets = new Map<string, Bucket>()

let sweptAt = Date.now()

const take = (
  key: string,
  perMinute: number,
  now: number,
  store: {
    get: (key: string) => Bucket | undefined
    set: (key: string, value: Bucket) => void
  } = buckets,
) => {
  const was = store.get(key)

  const tokens =
    was === undefined
      ? perMinute
      : Math.min(perMinute, was.tokens + ((now - was.at) * perMinute) / 60_000)

  if (tokens >= 1) {
    store.set(key, { tokens: tokens - 1, at: now })

    return 0
  }

  store.set(key, { tokens, at: now })

  return Math.max(1, Math.ceil(((1 - tokens) * 60_000) / perMinute / 1000))
}

const sweep = (now: number) => {
  if (now - sweptAt < 60_000) return

  sweptAt = now

  for (const [key, bucket] of buckets) if (now - bucket.at >= 60_000) buckets.delete(key)
}

export type OverLimit = {
  readonly which: "requests" | "writes"
  readonly limit: number
  readonly retryAfter: number
  readonly setting: string
}

const limit = (
  address: string,
  write: boolean,
  store: Parameters<typeof take>[3],
  perMinute: number,
  writesPerMinute: number,
): OverLimit | undefined => {
  const now = Date.now()

  const writesWait = write ? take(`w ${address}`, writesPerMinute, now, store) : 0

  if (writesWait > 0)
    return {
      which: "writes",
      limit: writesPerMinute,
      retryAfter: writesWait,
      setting: "OPENBELT_RATE_WRITES_PER_MINUTE",
    }

  const wait = take(`a ${address}`, perMinute, now, store)

  return wait > 0
    ? {
        which: "requests",
        limit: perMinute,
        retryAfter: wait,
        setting: "OPENBELT_RATE_PER_MINUTE",
      }
    : undefined
}

const logged = new Map<string, number>()

export const logOver = (address: string) => {
  const minute = Math.floor(Date.now() / 60_000)

  if (logged.get(address) === minute) return false

  if (logged.size > 10_000) logged.clear()
  logged.set(address, minute)

  return true
}

export const isLoopback = (address: string | undefined) =>
  address !== undefined &&
  (address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127."))

const emergency = positive("OPENBELT_RATE_IP_EMERGENCY_PER_MINUTE", 30000)

export const overLimit = (
  address: string,
  write: boolean,
  emergencyOnly = false,
): OverLimit | undefined => {
  sweep(Date.now())

  if (!emergencyOnly)
    return limit(address, write, buckets, RATE_LIMITS.perMinute, RATE_LIMITS.writesPerMinute)
  const wait = take(`emergency ${address}`, emergency, Date.now())

  return wait === 0
    ? undefined
    : {
        which: "requests",
        limit: emergency,
        retryAfter: wait,
        setting: "OPENBELT_RATE_IP_EMERGENCY_PER_MINUTE",
      }
}

const decodeBucket = Schema.decodeUnknownSync(
  Schema.Struct({ tokens: Schema.Number, at: Schema.Number }),
)

export const personRate = (storage: DurableObjectStorage, write: boolean): OverLimit | null =>
  limit(
    "person",
    write,
    {
      get: (key) => {
        const value = storage.kv.get(`rate:${key}`)

        return value === undefined ? undefined : decodeBucket(value)
      },
      set: (key, value) => storage.kv.put(`rate:${key}`, value),
    },
    RATE_LIMITS.perMinute,
    RATE_LIMITS.writesPerMinute,
  ) ?? null

/** Writes, function calls and live query runs done for anyone on the public host in one app, from every address together, per minute. */
export const PUBLIC_WRITES = positive("OPENBELT_PUBLIC_APP_WRITES_PER_MINUTE", 120)

const percent = (name: string, fallback: number) => {
  const share = positive(name, fallback)

  if (share > 100)
    throw new Error(`the setting ${name}=${share} isn't one OpenBelt can use: a percent, 1 to 100`)

  return share
}

/**
 * The share of its data cap (OPENBELT_DATA_APP_MB) past which an app takes no new or changed documents from the public host, in percent:
 * anyone on the internet can never fill an app for its members.
 */
export const PUBLIC_DATA_SHARE = percent("OPENBELT_PUBLIC_DATA_SHARE", 50)

/** The share of PUBLIC_WRITES one client address may use in one app, in percent: one visitor never takes all of it. */
export const PUBLIC_ADDRESS_SHARE = percent("OPENBELT_PUBLIC_ADDRESS_SHARE", 25)

const PUBLIC_ADDRESS_WRITES = Math.max(1, Math.floor((PUBLIC_WRITES * PUBLIC_ADDRESS_SHARE) / 100))

export type PublicOver = {
  readonly whose: "address" | "app"
  readonly limit: number
  readonly retryAfter: number
}

/**
 * One app's budget for work done for anyone on the public host (writes, function calls, live query runs): PUBLIC_WRITES a minute from
 * every address together, and PUBLIC_ADDRESS_SHARE of that from any one address. `refund` gives a charge back when its request did no work.
 * An address of undefined (a request straight to this machine's port, not through a proxy) is charged to the app alone.
 */
export const openPublicBudget = () => {
  const store = new Map<string, Bucket>()
  let swept = Date.now()

  const give = (key: string, perMinute: number) => {
    const was = store.get(key)

    if (was !== undefined)
      store.set(key, { tokens: Math.min(perMinute, was.tokens + 1), at: was.at })
  }

  const refund = (address: string | undefined) => {
    give("app", PUBLIC_WRITES)

    if (address !== undefined) give(`address ${address}`, PUBLIC_ADDRESS_WRITES)
  }

  const charge = (address: string | undefined): PublicOver | undefined => {
    const now = Date.now()

    if (now - swept >= 60_000) {
      swept = now

      for (const [key, bucket] of store) if (now - bucket.at >= 60_000) store.delete(key)
    }

    const mine =
      address === undefined ? 0 : take(`address ${address}`, PUBLIC_ADDRESS_WRITES, now, store)

    if (mine > 0) return { whose: "address", limit: PUBLIC_ADDRESS_WRITES, retryAfter: mine }

    const all = take("app", PUBLIC_WRITES, now, store)

    if (all === 0) return undefined

    if (address !== undefined) give(`address ${address}`, PUBLIC_ADDRESS_WRITES)

    return { whose: "app", limit: PUBLIC_WRITES, retryAfter: all }
  }

  return { charge, refund }
}
