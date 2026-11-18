// The email OpenBelt sends: a sign-in code. Through Cloudflare Email Sending when OPENBELT_MAIL_TOKEN is set (a token with Email
// Sending: Edit, for OPENBELT_MAIL_ACCOUNT), from OPENBELT_MAIL_FROM (default hello@ the base host, so it moves with the base
// host); without one, only into the log, which is where bun run dev and verify read codes. OPENBELT_MAIL_API is Cloudflare's API
// unless a check points it at a stand-in.
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { exchange, textUpTo } from "./outbound.ts"

const TIMEOUT_MS = 10_000

const MOST_BYTES = 64 * 1024

type Mailer =
  | { readonly kind: "log" }
  | {
      readonly kind: "cloudflare"
      readonly token: Redacted.Redacted
      readonly account: string
      readonly from: string
      readonly api: string
    }

export const MAILER = Config.all({
  token: Config.Redacted("OPENBELT_MAIL_TOKEN").pipe(Config.option),
  account: Config.String("OPENBELT_MAIL_ACCOUNT").pipe(Config.withDefault("")),
  from: Config.String("OPENBELT_MAIL_FROM").pipe(Config.withDefault("")),
  base: Config.String("OPENBELT_BASE_HOST").pipe(Config.withDefault("")),
  host: Config.String("OPENBELT_HOST").pipe(Config.withDefault("localhost")),
  api: Config.String("OPENBELT_MAIL_API").pipe(
    Config.withDefault("https://api.cloudflare.com/client/v4"),
  ),
}).pipe(
  Config.map(({ token, account, from, base, host, api }): Mailer => {
    if (Option.isNone(token) || Redacted.value(token.value) === "") return { kind: "log" }

    if (account === "")
      throw new Error(
        "OPENBELT_MAIL_TOKEN is set but OPENBELT_MAIL_ACCOUNT isn't: set it to the Cloudflare account the token sends for",
      )

    return {
      kind: "cloudflare",
      token: token.value,
      account,
      from: from === "" ? `hello@${base === "" ? host : base}` : from,
      api,
    }
  }),
)

/** Cloudflare's answer to a send: who it went to, or why it didn't. */
const Sent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      success: Schema.Boolean,
      errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
      result: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            delivered: Schema.optional(Schema.Array(Schema.String)),
            queued: Schema.optional(Schema.Array(Schema.String)),
            permanent_bounces: Schema.optional(Schema.Array(Schema.String)),
            suppressed_recipients: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      ),
    }),
  ),
)

/** What became of a code: sent (or queued), or why not, for the log. The page says the same either way. */
type Outcome =
  | { readonly kind: "sent" }
  | { readonly kind: "logged" }
  | { readonly kind: "failed"; readonly why: string }

const codeMail = (where: string, code: string) => ({
  subject: `${code} is your OpenBelt code`,
  text: `Your code to sign in to ${where} is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email: nobody can sign in without the code.\n`,
  html: `<p>Your code to sign in to ${where} is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px;margin:16px 0">${code}</p><p>It works for 10 minutes. If you didn't ask for it, ignore this email: nobody can sign in without the code.</p>`,
})

/**
 * A sign-in code for `email` to sign in to `where` (a workspace's name, or OpenBelt). With no mailer, the log line carries the code (the
 * only way to read it); with one, the log says it was sent and never shows the code.
 */
export const sendCode = Effect.fn("mail.sendCode")(function* (
  mailer: Mailer,
  email: string,
  where: string,
  code: string,
) {
  if (mailer.kind === "log") {
    yield* Effect.logInfo(
      `sign-in: mail to ${email} (no email service is set up, so it is only in this log): your code for ${where} is ${code}`,
    )

    return { kind: "logged" } satisfies Outcome
  }

  const mail = codeMail(where, code)

  const outcome: Outcome = yield* exchange(
    {
      kind: "mail",
      method: "POST",
      url: `${mailer.api}/accounts/${mailer.account}/email/sending/send`,
      headers: {
        authorization: `Bearer ${Redacted.value(mailer.token)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: { address: mailer.from, name: "OpenBelt" },
        reply_to: mailer.from,
        to: email,
        ...mail,
      }),
      timeoutMs: TIMEOUT_MS,
    },
    (answer) =>
      textUpTo(answer, MOST_BYTES).pipe(
        Effect.map((text): Outcome => {
          const sent = Sent(text ?? "")

          if (Option.isNone(sent))
            return { kind: "failed", why: `${answer.status}, an answer it couldn't read` }

          const { success, errors, result } = sent.value
          const went = [...(result?.delivered ?? []), ...(result?.queued ?? [])]

          if (success && went.length > 0) return { kind: "sent" }

          const bounced = [
            ...(result?.permanent_bounces ?? []),
            ...(result?.suppressed_recipients ?? []),
          ]

          return {
            kind: "failed",
            why:
              bounced.length > 0
                ? `Cloudflare answered that it bounced: the address bounced before or is suppressed, or ${mailer.from.split("@")[1] ?? mailer.from} isn't onboarded to Email Sending (each base host's domain is its own sender)`
                : `${answer.status} ${(errors ?? []).map((e) => e.message).join("; ") || "no reason given"}`,
          }
        }),
      ),
  ).pipe(
    Effect.catchTag("OutboundFailed", (error) =>
      Effect.succeed<Outcome>({ kind: "failed", why: error.detail }),
    ),
  )

  yield* outcome.kind === "sent"
    ? Effect.logInfo(`sign-in: mail to ${email}: a code for ${where} was sent from ${mailer.from}`)
    : Effect.logWarning(
        `sign-in: mail to ${email}: the code for ${where} wasn't sent (${outcome.kind === "failed" ? outcome.why : ""}): they can ask for another in 30 s`,
      )

  return outcome
})
