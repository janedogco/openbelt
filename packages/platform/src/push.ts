// Notifications: the devices each person turned them on for, on the workspace host, and the Web Push that reaches them.
// A device's subscription is its browser's push service address (FCM, Apple, Mozilla, Windows) and the keys only it can read with;
// the workspace signs each push with its own VAPID key (RFC 8292) and encrypts it for the device (RFC 8291, aes128gcm).
// Each push is a declarative one (WebKit's Declarative Web Push): Safari shows it by itself, other browsers through /_pwa/sw.js.
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Refused } from "./model.ts"
import { exchange, firstWords } from "./outbound.ts"
import type { sealing } from "./upstream.ts"

type Sealer = Effect.Success<ReturnType<typeof sealing>>

/** A browser's subscription as `PushSubscription.toJSON()` gives it. */
export const PushSubscription = Schema.Struct({
  endpoint: Schema.String,
  keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String }),
})

export type PushSubscription = typeof PushSubscription.Type

/** A person's answer to one app's notifications, from its frame: Allow or the switch on (true), Not now or the switch off (false). */
export const AppAnswer = Schema.Struct({ on: Schema.NullOr(Schema.Boolean) })

/** What an app sends: a title, a line under it, and the page of the app a tap opens. */
export type PushMessage = {
  readonly title: string
  readonly body: string
  /** The page a tap opens, on the workspace host: `/<app>/<path>`. */
  readonly navigate: string
}

/** The push services browsers subscribe through. Any other host is refused: a subscription is a URL OpenBelt will POST to. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^web\.push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
]

/** A person's devices: a new one past this drops their oldest. */
const MAX_DEVICES = 10

/** How long a push service keeps a push for a device that is off. */
const TTL_SECONDS = 86_400

const SEND_MS = 10_000

const KEY = "push:vapid"

const encoder = new TextEncoder()

const b64url = (bytes: Uint8Array) => bytes.toBase64({ alphabet: "base64url", omitPadding: true })

const fromB64url = (text: string) => Uint8Array.fromBase64(text, { alphabet: "base64url" })

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
      bytes * 8,
    ),
  )

/** RFC 8291: `plain` sealed for the device's key, one record. */
const encrypt = async (plain: Uint8Array, device: PushSubscription) => {
  const uaPublic = fromB64url(device.keys.p256dh)

  const ours = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])

  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ours.publicKey))

  const theirs = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, ours.privateKey, 256),
  )

  const ikm = await hkdf(
    fromB64url(device.keys.auth),
    shared,
    concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic),
    32,
  )

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12)

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]),
      concat(plain, new Uint8Array([2])),
    ),
  )

  const header = new Uint8Array(21)

  header.set(salt)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = asPublic.length

  return concat(header, asPublic, sealed)
}

/** Why `endpoint` can't be a device's address, or undefined. */
const endpointProblem = (endpoint: string) => {
  if (!URL.canParse(endpoint)) return "the subscription's endpoint isn't a URL"

  const url = new URL(endpoint)

  return url.protocol === "https:" && PUSH_HOSTS.some((host) => host.test(url.hostname))
    ? undefined
    : `${url.host} isn't a browser's push service`
}

const keyProblem = (device: PushSubscription) => {
  try {
    return fromB64url(device.keys.p256dh).length === 65 &&
      fromB64url(device.keys.auth).length === 16
      ? undefined
      : "the subscription's keys aren't a P-256 key and a 16-byte secret"
  } catch {
    return "the subscription's keys aren't base64url"
  }
}

/** What a send reached: the devices each push service took it for, the people with at least one, and why the rest failed. */
type Sent = {
  readonly devices: number
  readonly failed: number
  readonly reached: ReadonlyArray<string>
  readonly why: ReadonlyArray<string>
}

const NOTHING_SENT: Sent = { devices: 0, failed: 0, reached: [], why: [] }

/**
 * Where a person stands with one app's notifications: `on` (they allowed it), `off` (they said no, or turned it off), `asked` (the
 * app tried to notify them and they haven't answered: the app's page asks them), or `none` (the app never tried).
 */
const AppState = Schema.Literals(["on", "off", "asked"])

type AppNotifications = typeof AppState.Type | "none"

const appStateOf = Schema.decodeUnknownOption(AppState)

const StoredKey = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String })

export const openPush = Effect.fn("Push.open")(function* (
  storage: DurableObjectStorage,
  sealer: Sealer,
) {
  const { sql, kv } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS push_devices (
    endpoint TEXT PRIMARY KEY, email TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    created TEXT NOT NULL)`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS push_devices_email ON push_devices (email)")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS push_apps (
    email TEXT NOT NULL, app_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('on', 'off', 'asked')),
    changed TEXT NOT NULL, PRIMARY KEY (email, app_id))`)

  const appState = Effect.fnUntraced(function* (email: string, appId: string) {
    const [row] = yield* (yield* sql.exec<{ state: string }>(
      "SELECT state FROM push_apps WHERE email = ? AND app_id = ?",
      email,
      appId,
    )).toArray()

    return Option.getOrElse(appStateOf(row?.state), (): AppNotifications => "none")
  })

  /** The workspace's VAPID key, made the first time a person turns notifications on. */
  const vapid = Effect.fnUntraced(function* () {
    const stored = Schema.decodeUnknownOption(StoredKey)(kv.get(KEY))

    if (Option.isSome(stored)) {
      const jwk = yield* sealer.open(stored.value.privateKey, KEY)

      if (jwk === undefined) return yield* Effect.die("the workspace's push key can't be opened")

      const privateKey = yield* Effect.promise(() =>
        crypto.subtle.importKey(
          "jwk",
          JSON.parse(jwk),
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"],
        ),
      )

      return { publicKey: stored.value.publicKey, privateKey }
    }

    const made = yield* Effect.promise(async () => {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
      ])

      return {
        publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
        jwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
        privateKey: pair.privateKey,
      }
    })

    kv.put(KEY, { publicKey: made.publicKey, privateKey: yield* sealer.seal(made.jwk, KEY) })

    return { publicKey: made.publicKey, privateKey: made.privateKey }
  })

  const authorization = Effect.fnUntraced(function* (
    endpoint: string,
    subject: string,
    key: { readonly publicKey: string; readonly privateKey: CryptoKey },
  ) {
    const part = (value: Readonly<Record<string, string | number>>) =>
      b64url(encoder.encode(JSON.stringify(value)))

    const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: subject,
    })}`

    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        encoder.encode(unsigned),
      ),
    )

    return `vapid t=${unsigned}.${b64url(new Uint8Array(signature))}, k=${key.publicKey}`
  })

  return {
    /** The public key a browser subscribes with (`applicationServerKey`). */
    key: Effect.fnUntraced(function* () {
      return (yield* vapid()).publicKey
    }),

    /** `email` takes notifications on this device from now on. The same device again replaces its keys. */
    subscribe: Effect.fnUntraced(function* (email: string, device: PushSubscription) {
      const problem = endpointProblem(device.endpoint) ?? keyProblem(device)

      if (problem !== undefined) return yield* new Refused({ message: problem })

      return yield* storage.transaction(
        Effect.gen(function* () {
          yield* sql.exec(
            `INSERT INTO push_devices (endpoint, email, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth`,
            device.endpoint,
            email,
            device.keys.p256dh,
            device.keys.auth,
            new Date().toISOString(),
          )
          yield* sql.exec(
            `DELETE FROM push_devices WHERE email = ? AND endpoint NOT IN (
               SELECT endpoint FROM push_devices WHERE email = ? ORDER BY created DESC LIMIT ?)`,
            email,
            email,
            MAX_DEVICES,
          )
        }),
      )
    }),

    /** This device of `email`'s takes no more notifications. */
    unsubscribe: Effect.fnUntraced(function* (email: string, endpoint: string) {
      yield* sql.exec("DELETE FROM push_devices WHERE email = ? AND endpoint = ?", email, endpoint)
    }),

    /** Whether this device of `email`'s takes notifications. */
    subscribed: Effect.fnUntraced(function* (email: string, endpoint: string) {
      return (
        (yield* (yield* sql.exec(
          "SELECT 1 AS n FROM push_devices WHERE email = ? AND endpoint = ?",
          email,
          endpoint,
        )).toArray()).length > 0
      )
    }),

    /** A person's devices and answers are gone with them. */
    forget: Effect.fnUntraced(function* (email: string) {
      yield* sql.exec("DELETE FROM push_devices WHERE email = ?", email)
      yield* sql.exec("DELETE FROM push_apps WHERE email = ?", email)
    }),

    appState,

    /** `email` allows app `appId`'s notifications, or doesn't (Not now, or the panel's switch turned off). */
    answer: Effect.fnUntraced(function* (email: string, appId: string, on: boolean) {
      yield* sql.exec(
        `INSERT INTO push_apps (email, app_id, state, changed) VALUES (?, ?, ?, ?)
         ON CONFLICT (email, app_id) DO UPDATE SET state = excluded.state, changed = excluded.changed`,
        email,
        appId,
        on ? "on" : "off",
        new Date().toISOString(),
      )
    }),

    /** Of `emails`, who allowed app `appId`'s notifications. Whoever was never asked is now: the app's page asks them next time. */
    allowed: Effect.fnUntraced(function* (appId: string, emails: ReadonlyArray<string>) {
      const on: Array<string> = []
      const not: Array<string> = []

      for (const email of emails) {
        const state = yield* appState(email, appId)

        if (state === "on") on.push(email)
        else not.push(email)

        if (state === "none")
          yield* sql.exec(
            "INSERT OR IGNORE INTO push_apps (email, app_id, state, changed) VALUES (?, ?, 'asked', ?)",
            email,
            appId,
            new Date().toISOString(),
          )
      }

      return { on, not }
    }),

    /**
     * `message` to every device of each of `emails`. A device its push service says is gone (404, 410) is dropped. What reached
     * each push service, by person: a push service takes a push for a device that is off, and delivers it when it is back.
     */
    send: Effect.fnUntraced(function* (
      emails: ReadonlyArray<string>,
      message: PushMessage,
      subject: string,
    ) {
      if (emails.length === 0) return NOTHING_SENT

      const devices = yield* (yield* sql.exec<{
        endpoint: string
        email: string
        p256dh: string
        auth: string
      }>(
        `SELECT endpoint, email, p256dh, auth FROM push_devices WHERE email IN (${emails.map(() => "?").join(", ")})`,
        ...emails,
      )).toArray()

      if (devices.length === 0) return NOTHING_SENT

      const key = yield* vapid()

      const plain = encoder.encode(
        JSON.stringify({
          web_push: 8030,
          notification: { title: message.title, body: message.body, navigate: message.navigate },
        }),
      )

      const outcomes = yield* Effect.forEach(
        devices,
        (device) =>
          Effect.gen(function* () {
            const body = yield* Effect.promise(() =>
              encrypt(plain, {
                endpoint: device.endpoint,
                keys: { p256dh: device.p256dh, auth: device.auth },
              }),
            )

            const answer = yield* exchange(
              {
                kind: "push",
                url: device.endpoint,
                method: "POST",
                headers: {
                  authorization: yield* authorization(device.endpoint, subject, key),
                  "content-encoding": "aes128gcm",
                  "content-type": "application/octet-stream",
                  ttl: String(TTL_SECONDS),
                  urgency: "high",
                },
                bytes: body,
                timeoutMs: SEND_MS,
              },
              (got) =>
                got.status >= 200 && got.status < 300
                  ? Effect.succeed({ status: got.status, said: "" })
                  : Effect.map(firstWords(got), (said) => ({ status: got.status, said })),
            ).pipe(Effect.catch((e) => Effect.succeed({ status: 0, said: e.message })))

            if (answer.status === 404 || answer.status === 410)
              yield* sql.exec("DELETE FROM push_devices WHERE endpoint = ?", device.endpoint)

            return {
              email: device.email,
              ok: answer.status >= 200 && answer.status < 300,
              why: `${new URL(device.endpoint).host} answered ${answer.status === 0 ? "nothing" : answer.status}${answer.said === "" ? "" : `: ${answer.said.slice(0, 200)}`}`,
            }
          }),
        { concurrency: 8 },
      )

      return {
        devices: outcomes.filter((o) => o.ok).length,
        failed: outcomes.filter((o) => !o.ok).length,
        reached: [...new Set(outcomes.filter((o) => o.ok).map((o) => o.email))],
        why: [...new Set(outcomes.filter((o) => !o.ok).map((o) => o.why))],
      }
    }),
  }
})
