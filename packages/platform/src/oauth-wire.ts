import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Refused } from "./model.ts"
import type { Sending } from "./outbound.ts"

/** An issuer, resource or URL as compared: without trailing slashes (Google names its issuer with one). */
export const normalized = (url: string) => url.replace(/\/+$/, "")

export const same = (a: string, b: string) => normalized(a) === normalized(b)

/** A Bearer challenge's parameters (RFC 6750 §3, RFC 9728 §5.1), from WWW-Authenticate. */
export const bearerChallenge = (header: string | null | undefined) => {
  const param = (key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(header ?? "")?.[1]

  return {
    bearer: /^\s*bearer\b/i.test(header ?? ""),
    metadata: param("resource_metadata"),
    error: param("error"),
    scope: param("scope"),
  }
}

/**
 * A rate limit, by its words, whatever status it came with: Google's "User rate limit exceeded",
 * rate_limit_exceeded, quota, slow_down, too many requests.
 */
export const LIMITED = /rate.?limit|quota|slow_down|too many requests/i

export type Got = { readonly status: number; readonly headers: Headers; readonly text: string }

export type Fetcher = {
  readonly fetch: (
    name: string,
    url: string,
    init: Sending,
    timeoutMs?: number,
  ) => Effect.Effect<Got, Refused>
  readonly pageProblem: (url: string) => string | undefined
}

export const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
) => Schema.decodeUnknownOption(Schema.fromJsonString(schema))
