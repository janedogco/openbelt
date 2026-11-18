// Trial workspaces (OPENBELT_TRIALS=on, under email sign-in; off by default): an agent with no account starts one on the base host
// (POST /_trial, base.ts) and builds in it with the API token it gets, as a placeholder admin; the person it works for claims it
// at the claim link (on the base host, signed in), and becomes that admin: the same person (people.ts takeOver), so the token
// goes on working, as them. Until then the workspace is invite-only, its apps open only in check_app, it gets no TLS certificate
// (gateway.ts /_tls/ask), and the token stops after a day. Not for a public host yet: trials want a domain of their own and
// limits that hold across machines; the one here is per address, counted on the base host's object (apex.ts).
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { WorkspaceName, PersonId, Refused, type Viewer } from "./model.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"

/** Whether agents may start trial workspaces (OPENBELT_TRIALS=on|off). */
export const TRIALS = Config.Literals(["on", "off"], "OPENBELT_TRIALS").pipe(
  Config.withDefault("off" as const),
)

/** How long an unclaimed trial's token works. */
const TRIAL_DAYS = 1

/** How many trials one address may start in an hour (apex.ts counts them). */
export const TRIALS_PER_HOUR = 5

/** A trial's name: t- and six letters or digits that don't read alike. */
export const trialName = () => {
  const letters = "abcdefghjkmnpqrstvwxyz23456789"

  return Schema.decodeSync(WorkspaceName)(
    `t-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => letters[b % letters.length]).join("")}`,
  )
}

const Trial = Schema.Struct({
  person: PersonId,
  /** The claim code's hash: the code itself is only in the claim link. */
  code: Schema.String,
  expires: Schema.String,
  claimed: Schema.NullOr(Schema.Struct({ email: Schema.String, at: Schema.String })),
})

const decodeTrial = Schema.decodeUnknownOption(Trial)

/** Why nobody may be let in to this workspace yet, when it's a trial nobody has claimed (people.ts refuses invites and joining). */
export const shutUntilClaimed = (storage: DurableObjectStorage) => {
  const trial = Option.getOrNull(decodeTrial(storage.kv.get("trial")))

  return trial !== null && trial.claimed === null
    ? "this workspace is a trial until someone claims it: nobody can be invited, and joining stays invite-only, until the person the agent works for claims it with the claim_url"
    : undefined
}

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => new Uint8Array(digest).toHex()),
  )

export const openTrial = (
  storage: DurableObjectStorage,
  people: {
    readonly placeholder: (
      email: string,
      name: string,
      days: number,
    ) => Effect.Effect<
      { readonly person: { readonly id: PersonId }; readonly token: string },
      Refused
    >
    readonly takeOver: (placeholder: PersonId, viewer: Viewer) => Effect.Effect<void>
  },
) => {
  const { kv } = storage

  const read = () => Option.getOrNull(decodeTrial(kv.get("trial")))

  return {
    /** This workspace as a trial: its placeholder admin's token and the claim code (shown once, in the claim link). */
    start: Effect.fnUntraced(function* (workspace: string) {
      if (kv.get("trial") !== undefined)
        return yield* new Refused({ message: `${workspace} is already a trial workspace` })

      const made = yield* people.placeholder(`agent@${workspace}.trial`, "Trial agent", TRIAL_DAYS)
      const code = crypto.getRandomValues(new Uint8Array(16)).toHex()
      const expires = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString()

      kv.put("trial", {
        person: made.person.id,
        code: yield* sha256(code),
        expires,
        claimed: null,
      } satisfies typeof Trial.Encoded)

      return { token: made.token, code, expires }
    }),

    /** Whether this workspace is a trial nobody has claimed yet. */
    unclaimed: () => Effect.sync(() => read()?.claimed === null),

    /** `viewer` claims it with the code from the link: theirs now, unless it's someone else's already, or too late. */
    claim: Effect.fnUntraced(function* (code: string, viewer: Viewer) {
      const trial = read()

      if (trial === null || (yield* sha256(code)) !== trial.code) return { kind: "wrong" as const }

      if (trial.claimed !== null)
        return trial.claimed.email === viewer.email
          ? { kind: "claimed" as const }
          : { kind: "taken" as const }

      if (trial.expires <= new Date().toISOString()) return { kind: "expired" as const }

      yield* storage.transaction(
        Effect.gen(function* () {
          yield* people.takeOver(trial.person, viewer)

          kv.put("trial", {
            ...trial,
            claimed: { email: viewer.email, at: new Date().toISOString() },
          } satisfies typeof Trial.Encoded)
        }),
      )

      return { kind: "claimed" as const }
    }),
  }
}
