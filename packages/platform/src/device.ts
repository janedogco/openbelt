// The device sign-in page (RFC 8628's verification URI, /_oauth/device), on a workspace's host and on the base host: the person
// checks the code their terminal shows and goes on to the consent page any agent's sign-in uses, whose answer comes back here for the
// client to pick up on its next poll. The sign-ins themselves are oauth.ts's (deviceStart, deviceFind, deviceDone).
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { htmlOf, WORKSPACE_PAGE } from "./http.ts"
import { devicePage, outcomePage } from "./settings.ts"

type Found = { readonly client: string; readonly userCode: string; readonly authorize: string }

/** The object that keeps this host's device sign-ins: the workspace's, or the base host's. */
export type DeviceSignIns = {
  readonly find: (typed: string, issuer: string) => Effect.Effect<Found | undefined, unknown>
  readonly done: (
    state: string,
    outcome: { readonly code: string } | { readonly refused: string },
  ) => Effect.Effect<boolean, unknown>
}

const page = (html: string, status = 200) => htmlOf(html, { status, headers: WORKSPACE_PAGE })

export const deviceRoute = Effect.fnUntraced(function* (url: URL, signIns: DeviceSignIns) {
  const request = yield* HttpServerRequest

  if (request.method !== "GET" && request.method !== "HEAD")
    return HttpServerResponse.text("GET this page.\n", { status: 405 })

  const q = url.searchParams
  const state = q.get("state")

  // The consent page's answer: a code (the client trades it next), or why there is none.
  if (state !== null) {
    const code = q.get("code")
    const refused = q.get("error_description") ?? q.get("error") ?? "the sign-in didn't finish"
    const kept = yield* signIns.done(state, code === null ? { refused } : { code })

    return page(
      outcomePage(
        kept && code !== null
          ? {
              ok: true,
              title: "You're signed in",
              message: "Close this tab and go back to your terminal or your agent.",
            }
          : {
              ok: false,
              title: "Sign-in didn't finish",
              message: kept
                ? "Go back to your terminal and try again."
                : "This code was used or ran out. Go back to your terminal and sign in again.",
            },
      ),
      kept ? 200 : 400,
    )
  }

  const typed = q.get("user_code")
  const found = typed === null ? undefined : yield* signIns.find(typed, url.origin)

  return page(
    devicePage(
      found === undefined
        ? {
            kind: "enter",
            problem:
              typed === null ? null : "That code is wrong, used or ran out. Check your terminal.",
          }
        : { kind: "confirm", ...found },
    ),
  )
})
