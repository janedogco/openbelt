// Which webmail a sign-in code went to, so the code page can open it: Gmail or Outlook, by the address's domain, or else by the
// domain's MX record (Google Workspace, Microsoft 365). A domain behind a mail filter, another provider, or a lookup slower than
// LOOKUP_MS gets no button; the page is the same without one.
import { resolveMx } from "node:dns/promises"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

export type Inbox = "gmail" | "outlook" | "outlook-work"

const LOOKUP_MS = 300

const KNOWN = new Map<string, Inbox>([
  ["gmail.com", "gmail"],
  ["googlemail.com", "gmail"],
  ["outlook.com", "outlook"],
  ["hotmail.com", "outlook"],
  ["live.com", "outlook"],
  ["msn.com", "outlook"],
])

const byMx = (host: string): Inbox | null =>
  /(^|\.)(google\.com|googlemail\.com)$/.test(host)
    ? "gmail"
    : host.endsWith(".olc.protection.outlook.com")
      ? "outlook"
      : host.endsWith(".mail.protection.outlook.com")
        ? "outlook-work"
        : null

/** The webmail `email` reads in, or null when it isn't Gmail or Outlook, or the lookup doesn't answer within LOOKUP_MS. */
export const inboxOf = Effect.fn("inbox.of")(function* (email: string) {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase()
  const known = KNOWN.get(domain)

  if (known !== undefined) return known

  const records = yield* Effect.tryPromise(() => resolveMx(domain)).pipe(
    Effect.timeoutOption(LOOKUP_MS),
    Effect.map(Option.getOrElse(() => [])),
    Effect.orElseSucceed(() => []),
  )

  const first = records.toSorted((a, b) => a.priority - b.priority)[0]

  return first === undefined ? null : byMx(first.exchange.toLowerCase().replace(/\.$/, ""))
})

/**
 * Where the button opens. Gmail opens the newest code emails, spam included, with the code in their subject; on the browser's first
 * Google account (`u/0`), since naming the account in the link loses the search, or errors, when it isn't signed in. Outlook has no
 * search link that holds through its sign-in, so its inbox.
 */
export const inboxLink = (inbox: Inbox) =>
  inbox === "gmail"
    ? {
        name: "Gmail",
        href: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent('subject:"OpenBelt code" newer_than:1d in:anywhere')}`,
      }
    : {
        name: "Outlook",
        href:
          inbox === "outlook"
            ? "https://outlook.live.com/mail/0/"
            : "https://outlook.cloud.microsoft/mail/",
      }
