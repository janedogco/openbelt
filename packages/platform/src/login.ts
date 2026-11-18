// Browser sign-in: the base host verifies email codes; workspaces keep their own sessions, linked to that browser sign-in.
// One-time tickets carry identity between hosts, with each workspace checking access independently.
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import type { DurableObjectStorage, SqlValue } from "./runtime/index.ts"
import type { PersonId, Viewer } from "./model.ts"

/** How long a code works, how many wrong guesses it takes, and how soon another may be sent to the same address. */
const CODE_MS = 10 * 60_000

const CODE_TRIES = 5

const RESEND_MS = 30_000

const CODES_PER_HOUR = 10

/** A session lasts this long from signing in; every host it reached (the workspace's, each app's) ends with it. */
const LOGIN_MS = 30 * 86_400_000

/** A sign-in link an admin made works this long, once; a handoff to an app's host, a minute. */
const LINK_MS = 15 * 60_000

const HANDOFF_MS = 60_000

export const loginKey = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => new Uint8Array(digest).toHex()),
  )

const secret = () =>
  crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true })

/** Six digits, each as likely as the next (a draw over 4,294,000,000 is drawn again). */
const sixDigits = () => {
  for (;;) {
    const [n = 0] = crypto.getRandomValues(new Uint32Array(1))

    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0")
  }
}

/** Any failure is "wrong", whatever the reason (no code, expired, used up, mistyped): telling them apart says who may sign in. */
type Finished =
  | { readonly kind: "signed_in"; readonly session: string; readonly until: number }
  | { readonly kind: "wrong" }

type Redeemed =
  | { readonly kind: "signed_in"; readonly session: string; readonly until: number }
  | { readonly kind: "gone" }

/** A Google sign-in under way (google.ts): where it goes on to, and the nonce and PKCE verifier Google's answer is checked with. */
type GooglePending = {
  readonly next: string
  readonly attempt: string
  readonly allow: boolean
  readonly nonce: string
  readonly verifier: string
  /** The email in the sign-in form when Continue with Google was pressed: Google's answer for another one is asked about first. */
  readonly hint: string | null
}

type GoogleRow = {
  next: string
  attempt: string
  allow: number
  nonce: string
  verifier: string
  hint: string | null
  expires: number
}

/** Where a sign-in goes on to once it's done. */
type Went = { readonly next: string; readonly attempt: string; readonly allow: boolean }

/** A Google sign-in started here is good for 10 minutes, once. */
const GOOGLE_MS = 10 * 60_000

type CodeRow = {
  hash: string
  expires: number
  tries: number
  sent: number
  window: number
  in_window: number
}

/** A removed person's sessions end at once (invited again, they sign in again). */
export const endSessionsOf = (storage: DurableObjectStorage, person: PersonId) =>
  storage.sql.exec(
    "DELETE FROM login_sessions WHERE email = (SELECT email FROM people WHERE id = ?)",
    person,
  )

/**
 * Who may sign in with an email code at all (OPENBELT_SIGNIN_ALLOW): addresses and @domains, separated by commas or spaces
 * ("ada@acme.com, @acme.com"). Unset or empty, anyone may, as joining allows. A private instance or a soft launch lists its few people; the
 * rest are told what anyone is told and sent nothing.
 */
const SIGNIN_ALLOW = Config.String("OPENBELT_SIGNIN_ALLOW").pipe(
  Config.withDefault(""),
  Config.map((given) =>
    given
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  ),
)

/** Whether `email` is on the list (an exact address, or one at a listed @domain); an empty list allows everyone. */
const allowedBy = (list: ReadonlyArray<string>, email: string) => {
  const address = email.toLowerCase()

  return (
    list.length === 0 ||
    list.some((entry) => (entry.startsWith("@") ? address.endsWith(entry) : address === entry))
  )
}

export const openLogin = Effect.fn("Login.open")(function* (
  storage: DurableObjectStorage,
  people: {
    /** Whether `email` may get a code here: a member, someone invited, or anyone not removed when joining is open. */
    readonly mayJoin: (email: string) => Effect.Effect<boolean>
    readonly nameOf: (email: string) => Effect.Effect<string | null>
  },
) {
  const { sql } = storage
  const allow = yield* SIGNIN_ALLOW.pipe(Effect.orDie)

  const rows = <T extends Record<string, SqlValue>>(query: string, ...bindings: Array<SqlValue>) =>
    Effect.flatMap(sql.exec<T>(query, ...bindings), (cursor) => cursor.toArray())

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS login_codes (
    email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL,
    sent INTEGER NOT NULL, window INTEGER NOT NULL, in_window INTEGER NOT NULL)`)
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS login_sessions (
    hash TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS login_sessions_email ON login_sessions (email)")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS login_tickets (
    hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('link', 'handoff')),
    email TEXT NOT NULL, session TEXT, host TEXT, attempt TEXT, expires INTEGER NOT NULL)`)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS login_parents (
    hash TEXT PRIMARY KEY, parent TEXT NOT NULL)`)

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS login_google (
    hash TEXT PRIMARY KEY, next TEXT NOT NULL, attempt TEXT NOT NULL, allow INTEGER NOT NULL,
    nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL)`)

  const [hintColumn] = yield* rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pragma_table_info('login_google') WHERE name = 'hint'",
  )

  if (hintColumn?.n === 0) yield* sql.exec("ALTER TABLE login_google ADD COLUMN hint TEXT")

  // Google vouched for another email than the form's: the sign-in waits here for a yes (Continue as ...), once, while it's good.
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS login_google_others (
    hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT NOT NULL, attempt TEXT NOT NULL, allow INTEGER NOT NULL,
    expires INTEGER NOT NULL)`)

  const sweep = (now: number) =>
    Effect.all([
      sql.exec("DELETE FROM login_google WHERE expires < ?", now),
      sql.exec("DELETE FROM login_google_others WHERE expires < ?", now),
      sql.exec("DELETE FROM login_codes WHERE expires < ? AND window < ?", now, now - 3_600_000),
      sql.exec("DELETE FROM login_sessions WHERE expires < ?", now),
      sql.exec("DELETE FROM login_tickets WHERE expires < ?", now),
      sql.exec("DELETE FROM login_parents WHERE hash NOT IN (SELECT hash FROM login_sessions)"),
    ])

  const startSession = Effect.fnUntraced(function* (email: string, now: number) {
    const session = secret()

    yield* sql.exec(
      "INSERT INTO login_sessions (hash, email, created, expires) VALUES (?, ?, ?, ?)",
      yield* loginKey(session),
      email,
      now,
      now + LOGIN_MS,
    )

    return { kind: "signed_in" as const, session, until: now + LOGIN_MS }
  })

  return {
    /**
     * A code for `email`, given to `send`. Whoever can't sign in here, or asked again too soon, gets nothing, and the page says the
     * same as for anyone (so it doesn't tell who is a member); the log says why (`why`).
     */
    start: Effect.fnUntraced(function* (
      email: string,
      send: (code: string) => Effect.Effect<void>,
      why: (note: string) => Effect.Effect<void>,
    ) {
      const now = Date.now()

      yield* sweep(now)

      if (!allowedBy(allow, email)) {
        yield* why(`sign-in: no code sent to ${email}: OPENBELT_SIGNIN_ALLOW doesn't list it`)

        return
      }

      if (!(yield* people.mayJoin(email))) {
        yield* why(
          `sign-in: no code sent to ${email}: they can't sign in here (not invited, or removed)`,
        )

        return
      }

      const [had] = yield* rows<CodeRow>("SELECT * FROM login_codes WHERE email = ?", email)

      if (had !== undefined && now - had.sent < RESEND_MS) {
        yield* why(
          `sign-in: no new code sent to ${email}: one went ${Math.round((now - had.sent) / 1000)} s ago, and it still works`,
        )

        return
      }

      const fresh = had === undefined || now - had.window > 3_600_000
      const inWindow = fresh ? 1 : had.in_window + 1

      if (inWindow > CODES_PER_HOUR) {
        yield* why(`sign-in: no new code sent to ${email}: ${CODES_PER_HOUR} went in the last hour`)

        return
      }

      const code = sixDigits()

      yield* sql.exec(
        `INSERT INTO login_codes (email, hash, expires, tries, sent, window, in_window) VALUES (?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT (email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, tries = 0, sent = excluded.sent,
           window = excluded.window, in_window = excluded.in_window`,
        email,
        yield* loginKey(`${email}:${code}`),
        now + CODE_MS,
        now,
        fresh ? now : had.window,
        inWindow,
      )

      yield* send(code)
    }),

    /** The code typed for `email`: a session when it's the one sent and still good; each wrong one uses up a try. */
    finish: Effect.fnUntraced(function* (email: string, code: string) {
      const now = Date.now()
      const [row] = yield* rows<CodeRow>("SELECT * FROM login_codes WHERE email = ?", email)

      if (row === undefined || row.expires < now || row.tries >= CODE_TRIES)
        return { kind: "wrong" } satisfies Finished

      if ((yield* loginKey(`${email}:${code.replaceAll(/\s/g, "")}`)) !== row.hash) {
        yield* sql.exec("UPDATE login_codes SET tries = tries + 1 WHERE email = ?", email)

        return { kind: "wrong" } satisfies Finished
      }

      yield* sql.exec(
        "UPDATE login_codes SET expires = 0, tries = ? WHERE email = ?",
        CODE_TRIES,
        email,
      )

      return yield* startSession(email, now)
    }),

    /** A Google sign-in starting: the state Google is sent (and the browser keeps), with the nonce and verifier it is checked with. */
    googleStart: Effect.fnUntraced(function* (p: {
      readonly next: string
      readonly attempt: string
      readonly allow: boolean
      readonly hint: string | null
    }) {
      const now = Date.now()
      const state = secret()

      const pending: GooglePending = {
        next: p.next,
        attempt: p.attempt,
        allow: p.allow,
        hint: p.hint,
        nonce: secret(),
        verifier: secret(),
      }

      yield* sweep(now)
      yield* sql.exec(
        "INSERT INTO login_google (hash, next, attempt, allow, nonce, verifier, hint, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        yield* loginKey(state),
        pending.next,
        pending.attempt,
        pending.allow ? 1 : 0,
        pending.nonce,
        pending.verifier,
        pending.hint,
        now + GOOGLE_MS,
      )

      return { state, pending }
    }),

    /** The Google sign-in `state` names, once, while it's good. */
    googleTake: Effect.fnUntraced(function* (state: string) {
      const hash = yield* loginKey(state)
      const [row] = yield* rows<GoogleRow>("SELECT * FROM login_google WHERE hash = ?", hash)

      yield* sql.exec("DELETE FROM login_google WHERE hash = ?", hash)

      return row === undefined || row.expires < Date.now()
        ? null
        : ({
            next: row.next,
            attempt: row.attempt,
            allow: row.allow === 1,
            nonce: row.nonce,
            verifier: row.verifier,
            hint: row.hint,
          } satisfies GooglePending)
    }),

    /**
     * Google vouched for `email`, not the form's: a ticket the page that asks "continue as `email`?" carries, if they may sign in here
     * at all (the same rules as a code); null if they may not.
     */
    googleOther: Effect.fnUntraced(function* (email: string, went: Went) {
      if (!allowedBy(allow, email) || !(yield* people.mayJoin(email))) return null

      const now = Date.now()
      const ticket = secret()

      yield* sweep(now)
      yield* sql.exec(
        "INSERT INTO login_google_others (hash, email, next, attempt, allow, expires) VALUES (?, ?, ?, ?, ?, ?)",
        yield* loginKey(ticket),
        email,
        went.next,
        went.attempt,
        went.allow ? 1 : 0,
        now + GOOGLE_MS,
      )

      return ticket
    }),

    /** Continue as the email Google vouched for: a session for it, once, while the ticket is good. */
    redeemGoogleOther: Effect.fnUntraced(function* (ticket: string) {
      const now = Date.now()

      const [row] = yield* rows<{ email: string; next: string; attempt: string; allow: number }>(
        "DELETE FROM login_google_others WHERE hash = ? AND expires > ? RETURNING email, next, attempt, allow",
        yield* loginKey(ticket),
        now,
      )

      if (row === undefined || !allowedBy(allow, row.email) || !(yield* people.mayJoin(row.email)))
        return { kind: "gone" } as const

      const went: Went = { next: row.next, attempt: row.attempt, allow: row.allow === 1 }
      const started = yield* startSession(row.email, now)

      return { ...started, email: row.email, went }
    }),

    /** Someone Google vouched for: a session, if they may sign in here at all (the same rules as a code). */
    verified: Effect.fnUntraced(function* (email: string) {
      if (!allowedBy(allow, email) || !(yield* people.mayJoin(email)))
        return { kind: "wrong" } satisfies Finished

      return yield* startSession(email, Date.now())
    }),

    /** Who a session is, while it lasts: their name as the workspace knows it. */
    viewer: Effect.fnUntraced(function* (session: string) {
      const [row] = yield* rows<{ email: string }>(
        "SELECT email FROM login_sessions WHERE hash = ? AND expires > ?",
        yield* loginKey(session),
        Date.now(),
      )

      if (row === undefined) return null

      const name = yield* people.nameOf(row.email)

      return {
        email: row.email,
        name: name === null || name === "" ? (row.email.split("@")[0] ?? row.email) : name,
      } satisfies Viewer
    }),

    parent: Effect.fnUntraced(function* (session: string) {
      const [row] = yield* rows<{ parent: string }>(
        "SELECT parent FROM login_parents WHERE hash = ?",
        yield* loginKey(session),
      )

      return row?.parent ?? null
    }),

    endParent: Effect.fnUntraced(function* (parent: string) {
      const ended = yield* rows<{ email: string }>(
        "DELETE FROM login_sessions WHERE hash IN (SELECT hash FROM login_parents WHERE parent = ?) RETURNING email",
        parent,
      )

      return [...new Set(ended.map((row) => row.email))]
    }),

    /** Ends a session, and with it every host it reached. */
    signOut: Effect.fnUntraced(function* (session: string) {
      yield* sql.exec("DELETE FROM login_tickets WHERE session = ?", session)

      const [row] = yield* rows<{ email: string }>(
        "DELETE FROM login_sessions WHERE hash = ? RETURNING email",
        yield* loginKey(session),
      )

      return row?.email ?? null
    }),

    /** A one-time link that signs `email` in, for an admin to hand someone (no email service needed). */
    link: Effect.fnUntraced(function* (email: string) {
      const now = Date.now()
      const ticket = secret()

      yield* sweep(now)
      yield* sql.exec(
        "INSERT INTO login_tickets (hash, kind, email, session, host, expires) VALUES (?, 'link', ?, NULL, NULL, ?)",
        yield* loginKey(ticket),
        email,
        now + LINK_MS,
      )

      return { ticket, until: now + LINK_MS }
    }),

    /** Who a link is for, without using it up (the page that asks "sign in as ...?"). */
    linkFor: Effect.fnUntraced(function* (ticket: string) {
      const [row] = yield* rows<{ email: string }>(
        "SELECT email FROM login_tickets WHERE hash = ? AND kind = 'link' AND attempt IS NULL AND expires > ?",
        yield* loginKey(ticket),
        Date.now(),
      )

      return row?.email ?? null
    }),

    /** A link used: a session for whoever it names, once. */
    redeemLink: Effect.fnUntraced(function* (ticket: string) {
      const now = Date.now()

      const [row] = yield* rows<{ email: string }>(
        "DELETE FROM login_tickets WHERE hash = ? AND kind = 'link' AND attempt IS NULL AND expires > ? RETURNING email",
        yield* loginKey(ticket),
        now,
      )

      if (row === undefined) return { kind: "gone" } satisfies Redeemed

      if (!(yield* people.mayJoin(row.email))) return { kind: "gone" } satisfies Redeemed

      return yield* startSession(row.email, now)
    }),

    /**
     * A ticket that signs `email` in on `host` (the workspace's), carried from the base host where they signed in: good for a minute and
     * once, only in the browser that started there (`attempt`, the nonce this workspace's host gave it), and only for someone who may
     * sign in here. It's a link (kind 'link') bound to the browser, which an admin's link never is.
     */
    carry: Effect.fnUntraced(function* (
      email: string,
      host: string,
      attempt: string,
      parent: string,
    ) {
      if (attempt === "" || !(yield* people.mayJoin(email))) return null

      const now = Date.now()
      const ticket = secret()

      yield* sweep(now)
      yield* sql.exec(
        "INSERT INTO login_tickets (hash, kind, email, session, host, attempt, expires) VALUES (?, 'link', ?, ?, ?, ?, ?)",
        yield* loginKey(ticket),
        email,
        parent,
        host,
        yield* loginKey(attempt),
        now + HANDOFF_MS,
      )

      return ticket
    }),

    /** A carried sign-in arrived at `host`: a session for whoever it names, if it was made for that host and this browser, once. */
    redeemCarry: Effect.fnUntraced(function* (ticket: string, host: string, attempt: string) {
      const now = Date.now()

      const [row] = yield* rows<{ email: string; session: string | null }>(
        "DELETE FROM login_tickets WHERE hash = ? AND kind = 'link' AND host = ? AND attempt = ? AND expires > ? RETURNING email, session",
        yield* loginKey(ticket),
        host,
        yield* loginKey(attempt),
        now,
      )

      if (row === undefined || row.session === null || !(yield* people.mayJoin(row.email)))
        return { kind: "gone" } satisfies Redeemed

      const started = yield* startSession(row.email, now)
      yield* sql.exec(
        "INSERT INTO login_parents (hash, parent) VALUES (?, ?)",
        yield* loginKey(started.session),
        row.session,
      )

      return started
    }),

    /**
     * A ticket that carries `session` to `host` (an app's), good for a minute and once, and only in the browser that started there
     * (`attempt`, the nonce that host gave it): a ticket someone made for their own session can't sign another person in.
     */
    handoff: Effect.fnUntraced(function* (session: string, host: string, attempt: string) {
      const now = Date.now()

      const [row] = yield* rows<{ email: string }>(
        "SELECT email FROM login_sessions WHERE hash = ? AND expires > ?",
        yield* loginKey(session),
        now,
      )

      if (row === undefined) return null

      const ticket = secret()

      yield* sql.exec(
        "INSERT INTO login_tickets (hash, kind, email, session, host, attempt, expires) VALUES (?, 'handoff', ?, ?, ?, ?, ?)",
        yield* loginKey(ticket),
        row.email,
        session,
        host,
        yield* loginKey(attempt),
        now + HANDOFF_MS,
      )

      return ticket
    }),

    /** A handoff arrived at `host`: the session it carries, if it was made for that host and this browser, and not used yet. */
    redeemHandoff: Effect.fnUntraced(function* (ticket: string, host: string, attempt: string) {
      const now = Date.now()

      const [row] = yield* rows<{ session: string }>(
        "DELETE FROM login_tickets WHERE hash = ? AND kind = 'handoff' AND host = ? AND attempt = ? AND expires > ? RETURNING session",
        yield* loginKey(ticket),
        host,
        yield* loginKey(attempt),
        now,
      )

      if (row === undefined) return { kind: "gone" } satisfies Redeemed

      const [live] = yield* rows<{ expires: number }>(
        "SELECT expires FROM login_sessions WHERE hash = ? AND expires > ?",
        yield* loginKey(row.session),
        now,
      )

      return live === undefined
        ? ({ kind: "gone" } satisfies Redeemed)
        : ({ kind: "signed_in", session: row.session, until: live.expires } satisfies Redeemed)
    }),
  }
})
