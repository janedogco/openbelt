// A CDN in front of the public host (docs/running.md, "Public apps behind a CDN"): a public app's files other than its pages are kept at the
// edge for EDGE_SECONDS (CDN-Cache-Control; browsers still ask each time, by Cache-Control), and each time the app goes live its public
// name is purged, so a deploy shows at once. The purge is Cloudflare's (purge_cache by host) when OPENBELT_CDN_TOKEN and
// OPENBELT_CDN_ZONE are set; without them, nothing is purged and a file can be up to EDGE_SECONDS old. OPENBELT_CDN_API is Cloudflare's API
// unless a check points it at a stand-in.
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type { HttpServerResponse } from "effect/http"
import { exchange, firstWords } from "./outbound.ts"

/** How long the edge keeps a public file: the longest a file there can be older than the live version when a purge fails. */
export const EDGE_SECONDS = 60

const TIMEOUT_MS = 5_000

export type Purger =
  | { readonly kind: "off" }
  | {
      readonly kind: "cloudflare"
      readonly token: Redacted.Redacted
      readonly zone: string
      readonly api: string
    }

export const PURGER = Config.all({
  token: Config.Redacted("OPENBELT_CDN_TOKEN").pipe(Config.option),
  zone: Config.String("OPENBELT_CDN_ZONE").pipe(Config.withDefault("")),
  api: Config.String("OPENBELT_CDN_API").pipe(
    Config.withDefault("https://api.cloudflare.com/client/v4"),
  ),
}).pipe(
  Config.map(({ token, zone, api }): Purger => {
    if (Option.isNone(token) || Redacted.value(token.value) === "") return { kind: "off" }

    if (zone === "")
      throw new Error(
        "OPENBELT_CDN_TOKEN is set but OPENBELT_CDN_ZONE isn't: set it to the Cloudflare zone id of OPENBELT_PUBLIC_HOST",
      )

    return { kind: "cloudflare", token: token.value, zone, api }
  }),
)

/**
 * A public file the edge may keep: an answer of 200 to a GET or HEAD for one of the app's own files (not /_...), and not a page, whose
 * answer depends on who asks (a link previewer gets the card, a page open is counted, an old name moves).
 */
export const edgeKept = (
  method: string,
  below: string,
  response: HttpServerResponse.HttpServerResponse,
) =>
  (method === "GET" || method === "HEAD") &&
  response.status === 200 &&
  !below.startsWith("_") &&
  !(response.headers["content-type"] ?? "").startsWith("text/html")

/** Every copy the edge keeps of `host`'s files dropped. Never fails: a purge that doesn't take leaves files at most EDGE_SECONDS old. */
export const purgeHost = Effect.fn("cdn.purgeHost")(function* (purger: Purger, host: string) {
  if (purger.kind === "off") return

  const refused = yield* exchange(
    {
      kind: "cdn",
      method: "POST",
      url: `${purger.api}/zones/${purger.zone}/purge_cache`,
      headers: {
        authorization: `Bearer ${Redacted.value(purger.token)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hosts: [host] }),
      timeoutMs: TIMEOUT_MS,
    },
    (answer) =>
      answer.status === 200
        ? Effect.succeed(undefined)
        : Effect.map(firstWords(answer), (words) => `${answer.status}: ${words}`),
  ).pipe(Effect.catch((error) => Effect.succeed(String(error))))

  if (refused !== undefined)
    yield* Effect.logWarning(
      `cdn: the purge of ${host} didn't take (its files at the edge are at most ${EDGE_SECONDS} s old): ${refused}`,
    )
})
