import * as Effect from "effect/Effect"
import { Refused } from "./model.ts"
import type { Fetcher, Got } from "./oauth-wire.ts"
import type { Sending } from "./outbound.ts"
import { exchange, textUpTo } from "./outbound.ts"
import { correlation, lookedUp, type Reach, urlProblem } from "./upstream.ts"

const TIMEOUT_MS = 15_000

const MOST_BYTES = 256 * 1024

export const fetcherFor = (reach: Reach): Fetcher => ({
  pageProblem: (url) => urlProblem(url, reach, "connection"),

  fetch: Effect.fnUntraced(function* (
    name: string,
    url: string,
    init: Sending,
    timeoutMs: number = TIMEOUT_MS,
  ) {
    const problem = urlProblem(url, reach, "connection") ?? (yield* lookedUp(url))

    if (problem !== undefined)
      return yield* new Refused({
        message: `${name}'s OAuth metadata points at ${url.slice(0, 200)}, which OpenBelt doesn't send to: ${problem}`,
      })

    const headers = new Headers(init.headers)

    for (const [k, v] of Object.entries(yield* correlation)) headers.set(k, v)

    const origin = new URL(url).origin

    return yield* exchange({ ...init, kind: "oauth", url, headers, timeoutMs }, (answer) =>
      textUpTo(answer, MOST_BYTES).pipe(
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.fail(
                new Refused({
                  message: `${name}'s sign-in server at ${origin} answered with more than ${MOST_BYTES / 1024} KB, which OpenBelt doesn't read`,
                }),
              )
            : Effect.succeed<Got>({ status: answer.status, headers: answer.headers, text }),
        ),
      ),
    ).pipe(
      Effect.catchTag("OutboundFailed", () =>
        Effect.fail(
          new Refused({
            message: `couldn't reach ${name}'s sign-in server at ${origin}: it didn't answer. If it's down, try again later.`,
          }),
        ),
      ),
    )
  }),
})
