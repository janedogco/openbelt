// The base host's own object (one for the platform): what the base host needs that no one workspace can answer. Under email sign-in
// the base host is where someone without a workspace starts (base.ts): they sign in there (login.ts, its own sessions), an agent's
// MCP client registers and signs in there (oauth.ts: the clients, and the sign-ins waiting on its consent page), and the
// consent page asks which workspace. So it keeps which workspaces each email is in (each workspace sends its people as they're added, workspace.ts),
// the workspaces made there (by whom, for which work domain, so a colleague can ask to join), and how many trial workspaces each address
// started (trials.ts). And the workspace directory: the names of workspaces that were renamed (below, and workspace-names.ts).
import * as Runtime from "./runtime/index.ts"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Theme, type ThemeChange } from "./model.ts"
import { loginKey, openLogin } from "./login.ts"
import { isWorkspaceName, WorkspaceId, type WorkspaceName, PersonId, type Viewer } from "./model.ts"
import { type AuthorizeRequest, openOAuth } from "./oauth.ts"
import { MAILER, sendCode } from "./mail.ts"
import { authorizeLink, emailFromGoogle, endpointsOf, GOOGLE } from "./google.ts"
import { REACH } from "./upstream.ts"

/** How many feedback reports one workspace may send in 24 hours. */
const FEEDBACK_PER_DAY = 20

type FeedbackReport = {
  readonly workspace: string
  readonly person: string
  readonly category: string
  readonly summary: string
  readonly goal: string
  readonly details: string
  readonly tool: string
  /** The reporter's latest tool_calls rows, as JSON. */
  readonly calls: string
}

/** The one ApexDO's name. */
export const APEX = "openbelt"

const DIRECTORY_VERSION = "workspace-directory:version"

/** How many names a workspace may hold (its id, its old names, its current one): each is reserved for good, so they're few. */
export const MAX_WORKSPACE_NAMES = 10

/** Mail services anyone can sign up to: an address there says nothing about who someone works with. */
const PERSONAL_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "fastmail.com",
  "hey.com",
  "gmx.com",
  "mail.com",
])

/** The company an email is at (its domain), or null for personal mail: colleagues are people at the same work domain. */
export const workDomainOf = (email: string) => {
  const domain = (email.split("@")[1] ?? "").toLowerCase()

  return domain === "" || PERSONAL_MAIL.has(domain) ? null : domain
}

/** Text as a workspace name: lowercase letters, digits and single dashes, at most 40 characters. */
export const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

/** A workspace name for someone's first workspace: their company's (acme.com: acme), or with personal mail, their own (ada.lovelace@gmail.com: ada-lovelace). */
export const workspaceNameFor = (email: string) => {
  const domain = workDomainOf(email)
  const local = (email.split("@")[0] ?? "").split("+")[0] ?? ""
  const company = domain === null ? "" : (domain.split(".").slice(0, -1).at(-1) ?? "")

  return slugOf(company === "" ? local : company) || "my-workspace"
}

/** Why `typed` can't name a new workspace (as `name`, its slug), or undefined when it can. */
export const workspaceNameProblem = (typed: string, name: string) =>
  isWorkspaceName(name)
    ? undefined
    : `"${typed}" can't be a workspace name: use lowercase letters, digits and single dashes, like acme or acme-labs.`

/** The person id the base host's sign-ins are kept under: the same for an email every time, unlike a workspace's (people.ts). */
const personOf = (email: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.toLowerCase())),
  ).pipe(
    Effect.map((digest) =>
      Schema.decodeUnknownSync(PersonId)(`p_${new Uint8Array(digest).toHex().slice(0, 16)}`),
    ),
  )

export default class ApexDO extends Runtime.DurableObject(
  "ApexDO",
  Effect.gen(function* () {
    const state = yield* Runtime.DurableObjectState
    const secretsKey = yield* Config.Redacted("OPENBELT_SECRETS_KEY").pipe(Effect.orDie)
    const reach = yield* REACH.pipe(Effect.orDie)
    const mailer = yield* MAILER.pipe(Effect.orDie)
    const google = yield* GOOGLE.pipe(Effect.orDie)

    // The default workspace (a host with no workspace label answers as it) exists before anyone touches it: its name is never free.
    const defaultWorkspace = yield* Config.String("OPENBELT_DEFAULT_WORKSPACE").pipe(
      Config.withDefault("acme"),
      Effect.orDie,
    )

    const accessMs =
      (yield* Config.Number("OPENBELT_OAUTH_ACCESS_TTL_SECONDS").pipe(
        Config.withDefault(30 * 86_400),
        Effect.orDie,
      )) * 1000

    return Effect.gen(function* () {
      const { sql, kv } = state.storage

      const rows = <T extends Record<string, Runtime.SqlValue>>(
        query: string,
        ...bindings: Array<Runtime.SqlValue>
      ) => Effect.flatMap(sql.exec<T>(query, ...bindings), (cursor) => cursor.toArray())

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS apex_members (
        email TEXT NOT NULL, workspace TEXT NOT NULL, PRIMARY KEY (email, workspace))`)
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS apex_workspaces (
        workspace TEXT PRIMARY KEY, creator TEXT NOT NULL, domain TEXT, created TEXT NOT NULL)`)
      yield* sql.exec(
        "CREATE INDEX IF NOT EXISTS apex_workspaces_domain ON apex_workspaces (domain)",
      )
      // Agents' reports of problems they hit (feedback_submit), from every workspace, with the reporter's recent calls.
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, workspace TEXT NOT NULL, person TEXT NOT NULL,
        category TEXT NOT NULL, summary TEXT NOT NULL, goal TEXT NOT NULL, details TEXT NOT NULL, tool TEXT NOT NULL,
        calls TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open')`)
      yield* sql.exec("CREATE INDEX IF NOT EXISTS feedback_workspace ON feedback (workspace, at)")
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS trial_starts (
        who TEXT NOT NULL, at INTEGER NOT NULL)`)
      yield* sql.exec("CREATE INDEX IF NOT EXISTS trial_starts_who ON trial_starts (who, at)")
      // Sign-in codes asked for, by the address that asked: email costs money and lands in someone's inbox.
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS code_asks (
        who TEXT NOT NULL, at INTEGER NOT NULL)`)
      yield* sql.exec("CREATE INDEX IF NOT EXISTS code_asks_who ON code_asks (who, at)")
      // The workspace directory. A workspace's id is the name it was made with, and its objects are keyed by it; a rename changes only its
      // name. Every name a renamed workspace has had (its id, its old names, its current one) is in workspace_names, so nobody else takes it
      // and links to it still reach the workspace; workspace_current is its current name. A workspace never renamed has no rows: its id is its
      // name. Each process holds a copy (workspace-names.ts), re-read when DIRECTORY_VERSION says it changed.
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS workspace_names (
        name TEXT PRIMARY KEY, workspace TEXT NOT NULL)`)
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS workspace_current (
        workspace TEXT PRIMARY KEY, name TEXT NOT NULL)`)
      // Names a workspace was made under by a first visit (tailscale sign-in makes a workspace there), claimed here before its object is,
      // so a rename to the same name at the same moment can't leave a workspace nobody reaches.
      yield* sql.exec("CREATE TABLE IF NOT EXISTS workspace_ids (workspace TEXT PRIMARY KEY)")

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS browser_workspaces (
        parent TEXT NOT NULL, workspace TEXT NOT NULL, visited INTEGER NOT NULL, PRIMARY KEY (parent, workspace))`)

      // Anyone may sign in here: it only says who they are. What they may do is each workspace's to say.
      const login = yield* openLogin(state.storage, {
        mayJoin: () => Effect.succeed(true),
        nameOf: () => Effect.succeed(null),
      })

      const oauth = yield* openOAuth(state.storage, reach, accessMs, Redacted.value(secretsKey))

      /** Google's endpoints, read on the first Google sign-in (google.ts). */
      let endpoints: Effect.Success<ReturnType<typeof endpointsOf>> | undefined

      /** How many times the directory changed: a process's copy (workspace-names.ts) is re-read when it is behind. */
      const version = () => kv.get<number>(DIRECTORY_VERSION) ?? 0

      const inDirectory = Effect.fnUntraced(function* (name: string) {
        return (yield* rows("SELECT 1 FROM workspace_names WHERE name = ?", name)).length > 0
      })

      /** Whether some workspace was made under `name` (it is that workspace's id): the default workspace, made here, by a first visit, or a file. */
      const madeAs = Effect.fnUntraced(function* (name: string) {
        return (
          name === defaultWorkspace ||
          (yield* rows("SELECT 1 FROM apex_workspaces WHERE workspace = ?", name)).length > 0 ||
          (yield* rows("SELECT 1 FROM workspace_ids WHERE workspace = ?", name)).length > 0 ||
          Runtime.hasFile("WorkspaceDO", name)
        )
      })

      /** At most `limit` an hour from `who`, in `table` (who, at): this one counted when it's allowed. */
      const allowWithin = Effect.fnUntraced(function* (
        table: "trial_starts" | "code_asks",
        who: string,
        limit: number,
      ) {
        const now = Date.now()

        yield* sql.exec(`DELETE FROM ${table} WHERE at <= ?`, now - 3_600_000)

        const before = yield* rows<{ at: number }>(
          `SELECT at FROM ${table} WHERE who = ? ORDER BY at`,
          who,
        )

        if (before.length >= limit)
          return {
            ok: false as const,
            retryAfter: Math.max(1, Math.ceil(((before[0]?.at ?? now) + 3_600_000 - now) / 1000)),
          }

        yield* sql.exec(`INSERT INTO ${table} (who, at) VALUES (?, ?)`, who, now)

        return { ok: true as const, retryAfter: 0 }
      })

      const browserWorkspaces = Runtime.namespaceOf<
        { loginEndParent: (parent: string) => Effect.Effect<void> },
        WorkspaceId
      >("WorkspaceDO")

      const endBrowser = yield* Runtime.makeCallback(
        "browser_end",
        Effect.fn("ApexDO.endBrowser")(function* (parent: string) {
          const found = yield* rows<{ workspace: string }>(
            "SELECT workspace FROM browser_workspaces WHERE parent = ?",
            parent,
          )

          for (const row of found)
            yield* browserWorkspaces
              .getByName(Schema.decodeUnknownSync(WorkspaceId)(row.workspace))
              .loginEndParent(parent)
          yield* sql.exec("DELETE FROM browser_workspaces WHERE parent = ?", parent)
        }),
      )

      const visitBrowser = Effect.fnUntraced(function* (parent: string, workspace: WorkspaceId) {
        yield* sql.exec(
          `INSERT INTO browser_workspaces (parent, workspace, visited)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM login_sessions WHERE hash = ? AND expires > ?)
           ON CONFLICT (parent, workspace) DO UPDATE SET visited = excluded.visited`,
          parent,
          workspace,
          Date.now(),
          parent,
          Date.now(),
        )
      })

      const themeOf = (email: string) => {
        const saved = kv.get(`theme:${email}`)

        return saved === undefined ? null : Schema.decodeUnknownSync(Theme)(saved)
      }

      return {
        theme: (email: string) => Effect.sync(() => themeOf(email)),

        themeSet: (email: string, change: ThemeChange) =>
          Effect.sync(() => {
            const saved = themeOf(email)
            const theme = change.action === "import" && saved !== null ? saved : change.theme
            kv.put(`theme:${email}`, theme)

            return theme
          }),

        loginStart: Effect.fn("ApexDO.loginStart")(function* (
          name: string,
          email: string,
          trace: string,
        ) {
          const logged = (line: string) => Effect.logInfo(line).pipe(Effect.annotateLogs({ trace }))

          return yield* login.start(
            email,
            (code) =>
              sendCode(mailer, email, name, code).pipe(
                Effect.annotateLogs({ trace }),
                Effect.asVoid,
              ),
            logged,
          )
        }),

        loginFinish: Effect.fn("ApexDO.loginFinish")(login.finish),

        /** Google sign-in starting: the link to Google, and the state this browser keeps; null without Google sign-in (google.ts). */
        googleStart: Effect.fn("ApexDO.googleStart")(function* (p: {
          readonly origin: string
          readonly next: string
          readonly attempt: string
          readonly allow: boolean
          readonly hint: string | null
        }) {
          if (google === null) return null

          endpoints ??= yield* endpointsOf(google)

          if (endpoints === undefined) return null

          const { state: sent, pending } = yield* login.googleStart(p)

          const challenge = new Uint8Array(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)),
            ),
          ).toBase64({ alphabet: "base64url", omitPadding: true })

          return {
            state: sent,
            location: authorizeLink(endpoints, google, {
              origin: p.origin,
              state: sent,
              nonce: pending.nonce,
              challenge,
              hint: p.hint,
            }),
          }
        }),

        /**
         * Google sent someone back: the sign-in their browser started (its cookie's state, the same as Google's), the code traded for
         * their verified email, and a session for it. Where they were going either way, so a refusal goes back to that sign-in page.
         */
        googleFinish: Effect.fn("ApexDO.googleFinish")(function* (p: {
          readonly origin: string
          readonly state: string
          readonly kept: string
          readonly code: string
        }) {
          if (google === null || p.state === "" || p.state !== p.kept)
            return {
              kind: "refused" as const,
              why: "not a sign-in this browser started",
              went: null,
            }

          const taken = yield* login.googleTake(p.state)

          if (taken === null)
            return { kind: "refused" as const, why: "used, or over 10 minutes old", went: null }

          const pending = { next: taken.next, attempt: taken.attempt, allow: taken.allow }

          endpoints ??= yield* endpointsOf(google)

          if (endpoints === undefined)
            return { kind: "refused" as const, why: "Google's discovery document", went: pending }

          const said = yield* emailFromGoogle(endpoints, google, {
            origin: p.origin,
            code: p.code,
            verifier: taken.verifier,
            nonce: taken.nonce,
          })

          if (!said.ok) return { kind: "refused" as const, why: said.why, went: pending }

          // The form named one email and Google vouched for another (another account picked at Google): ask before signing that one in.
          if (taken.hint !== null && taken.hint !== said.email.toLowerCase()) {
            const ticket = yield* login.googleOther(said.email, pending)

            return ticket === null
              ? {
                  kind: "refused" as const,
                  why: `${said.email} may not sign in here`,
                  went: pending,
                }
              : {
                  kind: "other" as const,
                  email: said.email,
                  asked: taken.hint,
                  ticket,
                  went: pending,
                }
          }

          const finished = yield* login.verified(said.email)

          return finished.kind === "wrong"
            ? {
                kind: "refused" as const,
                why: `${said.email} may not sign in here`,
                went: pending,
              }
            : {
                kind: "signed_in" as const,
                email: said.email,
                went: pending,
                session: finished.session,
                until: finished.until,
              }
        }),

        /** Continue as the email Google vouched for, after the page asked (googleFinish's "other"). */
        googleOther: Effect.fn("ApexDO.googleOther")(login.redeemGoogleOther),

        loginViewer: Effect.fn("ApexDO.loginViewer")(login.viewer),

        browserActive: Effect.fn("ApexDO.browserActive")(function* (parent: string) {
          const [row] = yield* rows<{ hash: string }>(
            "SELECT hash FROM login_sessions WHERE hash = ? AND expires > ?",
            parent,
            Date.now(),
          )

          return row !== undefined
        }),

        browserVisit: Effect.fn("ApexDO.browserVisit")(function* (
          session: string,
          workspace: WorkspaceId,
        ) {
          const viewer = yield* login.viewer(session)

          if (viewer === null) return null
          const parent = yield* loginKey(session)
          yield* visitBrowser(parent, workspace)

          return parent
        }),

        browserVisitParent: Effect.fn("ApexDO.browserVisitParent")(visitBrowser),

        browserLast: Effect.fn("ApexDO.browserLast")(function* (session: string) {
          const [row] = yield* rows<{ workspace: string }>(
            "SELECT workspace FROM browser_workspaces WHERE parent = ? ORDER BY visited DESC LIMIT 1",
            yield* loginKey(session),
          )

          return row === undefined ? null : Schema.decodeUnknownSync(WorkspaceId)(row.workspace)
        }),

        browserEnd: Effect.fn("ApexDO.browserEnd")(function* (parent: string) {
          yield* state.storage.transaction(
            Effect.gen(function* () {
              yield* sql.exec("DELETE FROM login_sessions WHERE hash = ?", parent)
              yield* endBrowser.schedule(parent, { after: 0, payload: parent })
            }),
          )

          const found = yield* rows<{ workspace: string }>(
            "SELECT workspace FROM browser_workspaces WHERE parent = ?",
            parent,
          )

          return found.map((row) => Schema.decodeUnknownSync(WorkspaceId)(row.workspace))
        }),

        oauthRegister: Effect.fn("ApexDO.oauthRegister")(oauth.register),

        /** Whether an agent's sign-in link is good (its client, redirect and PKCE), before anyone is asked anything. */
        oauthCheck: Effect.fn("ApexDO.oauthCheck")(function* (
          asked: AuthorizeRequest,
          issuer: string,
        ) {
          return yield* oauth.authorize(asked, issuer, undefined)
        }),

        /** A sign-in waiting on `email`'s answer on the consent page: the handle the page's form carries. */
        oauthPend: Effect.fn("ApexDO.oauthPend")(function* (
          email: string,
          asked: AuthorizeRequest,
        ) {
          return yield* oauth.pend(yield* personOf(email), asked)
        }),

        /** The sign-in a consent page answered, once, if it was `email`'s and is under 10 minutes old. */
        oauthTake: Effect.fn("ApexDO.oauthTake")(function* (handle: string, email: string) {
          const pending = yield* oauth.take(handle)

          return pending === undefined || pending.person !== (yield* personOf(email))
            ? null
            : pending.asked
        }),

        /** A client as registered here, for the workspace a sign-in lands in to keep (oauth.ts adopt). */
        oauthClient: Effect.fn("ApexDO.oauthClient")(oauth.clientRow),

        /** Device sign-ins (`openbelt login` at the base host): started, approved and polled here; their code is a workspace's. */
        oauthDeviceStart: Effect.fn("ApexDO.oauthDeviceStart")(oauth.deviceStart),

        oauthDeviceFind: Effect.fn("ApexDO.oauthDeviceFind")(oauth.deviceFind),

        oauthDeviceDone: Effect.fn("ApexDO.oauthDeviceDone")(oauth.deviceDone),

        oauthDevicePoll: Effect.fn("ApexDO.oauthDevicePoll")(oauth.devicePoll),

        /** People a workspace has (sent by the workspace as they're added): an email is looked up here, not by asking every workspace. */
        listed: Effect.fn("ApexDO.listed")(function* (
          workspace: string,
          emails: ReadonlyArray<string>,
        ) {
          yield* state.storage.transaction(
            Effect.forEach(
              emails,
              (email) =>
                sql.exec(
                  "INSERT INTO apex_members (email, workspace) VALUES (?, ?) ON CONFLICT DO NOTHING",
                  email.toLowerCase(),
                  workspace,
                ),
              { discard: true },
            ),
          )
        }),

        /** The workspaces `email` has been in (each workspace says whether they still are): ids, and current names. */
        workspacesOf: Effect.fn("ApexDO.workspacesOf")(function* (email: string) {
          return yield* rows<{ workspace: string; name: string }>(
            `SELECT m.workspace AS workspace, COALESCE(c.name, m.workspace) AS name FROM apex_members m
             LEFT JOIN workspace_current c ON c.workspace = m.workspace WHERE m.email = ? ORDER BY name`,
            email.toLowerCase(),
          )
        }),

        /**
         * Whether `who` (an address) may start another trial workspace: at most `limit` an hour, counted here alone (one count for the
         * platform, whichever process answers). When not, how many seconds until the oldest of them leaves the hour.
         */
        trialAllow: Effect.fn("ApexDO.trialAllow")(function* (who: string, limit: number) {
          return yield* allowWithin("trial_starts", who, limit)
        }),

        /** Whether `who` (an address) may ask for another sign-in code, anywhere on this platform, this hour. */
        codeAllow: Effect.fn("ApexDO.codeAllow")(function* (who: string, limit: number) {
          return yield* allowWithin("code_asks", who, limit)
        }),

        /** The workspace directory, for a process to hold (workspace-names.ts): unchanged since `known` (its version), or all of it. */
        workspaceDirectory: Effect.fn("ApexDO.workspaceDirectory")(function* (known: number) {
          const now = version()

          if (known === now) return { kind: "same" as const }

          return {
            kind: "changed" as const,
            version: now,
            names: yield* rows<{ name: string; workspace: string }>(
              "SELECT name, workspace FROM workspace_names",
            ),
            current: yield* rows<{ workspace: string; name: string }>(
              "SELECT workspace, name FROM workspace_current",
            ),
          }
        }),

        /**
         * Rename workspace `workspace` (its id) to `to`, in one transaction: `to` becomes its current name, and every name it had stays its
         * own, reaching it, for nobody else to take. Run again once done, it is done the same (nothing changes); a crash leaves
         * all of it or none. Refused when `to` is another workspace's name, now or ever: in the directory, made here, or a workspace's file
         * (a workspace never renamed, whose name is its id).
         */
        renameWorkspace: Effect.fn("ApexDO.renameWorkspace")(function* (
          workspace: WorkspaceId,
          to: WorkspaceName,
        ) {
          return yield* state.storage.transaction(
            Effect.gen(function* () {
              const [holder] = yield* rows<{ workspace: string }>(
                "SELECT workspace FROM workspace_names WHERE name = ?",
                to,
              )

              const named: string = to

              const theirs =
                holder === undefined
                  ? named !== workspace && (yield* madeAs(to))
                  : holder.workspace !== workspace

              if (theirs) return { kind: "taken" as const }

              const [current] = yield* rows<{ name: string }>(
                "SELECT name FROM workspace_current WHERE workspace = ?",
                workspace,
              )

              const from = current?.name ?? workspace

              if (from === to) return { kind: "renamed" as const, from, changed: false }

              const held = new Set([
                workspace,
                from,
                ...(yield* rows<{ name: string }>(
                  "SELECT name FROM workspace_names WHERE workspace = ?",
                  workspace,
                )).map((r) => r.name),
              ])

              if (!held.has(to) && held.size >= MAX_WORKSPACE_NAMES)
                return { kind: "full" as const, names: held.size }

              yield* sql.exec(
                "INSERT INTO workspace_names (name, workspace) VALUES (?, ?), (?, ?), (?, ?) ON CONFLICT (name) DO NOTHING",
                workspace,
                workspace,
                from,
                workspace,
                to,
                workspace,
              )
              yield* sql.exec(
                "INSERT INTO workspace_current (workspace, name) VALUES (?, ?) ON CONFLICT (workspace) DO UPDATE SET name = excluded.name",
                workspace,
                to,
              )
              kv.put(DIRECTORY_VERSION, version() + 1)

              return { kind: "renamed" as const, from, changed: true }
            }),
          )
        }),

        /**
         * A first visit to `name` under tailscale sign-in, which makes a workspace there: the workspace it is for. A name in the directory is
         * the renamed workspace's; any other is claimed as a new workspace's id in the same event a rename checks it in, so the two can't race.
         */
        firstUse: Effect.fn("ApexDO.firstUse")(function* (name: WorkspaceName) {
          const [holder] = yield* rows<{ workspace: string; name: string }>(
            `SELECT n.workspace AS workspace, COALESCE(c.name, n.workspace) AS name FROM workspace_names n
             LEFT JOIN workspace_current c ON c.workspace = n.workspace WHERE n.name = ?`,
            name,
          )

          if (holder !== undefined) return holder

          if (!(yield* madeAs(name)))
            yield* sql.exec(
              "INSERT INTO workspace_ids (workspace) VALUES (?) ON CONFLICT DO NOTHING",
              name,
            )

          return { workspace: name, name }
        }),

        /** Workspaces made here for a work domain: where a colleague at it can ask to join. */
        madeFor: Effect.fn("ApexDO.madeFor")(function* (domain: string) {
          return yield* rows<{ workspace: string; name: string; creator: string }>(
            `SELECT o.workspace AS workspace, COALESCE(c.name, o.workspace) AS name, o.creator AS creator FROM apex_workspaces o
             LEFT JOIN workspace_current c ON c.workspace = o.workspace WHERE o.domain = ? ORDER BY o.created LIMIT 20`,
            domain,
          )
        }),

        /**
         * `workspace` for `viewer`, made here: true when the name was free or is already theirs (a retry after a step that failed), false
         * when someone else has it.
         */
        claim: Effect.fn("ApexDO.claim")(function* (workspace: WorkspaceName, viewer: Viewer) {
          if (
            workspace === defaultWorkspace ||
            (yield* inDirectory(workspace)) ||
            (yield* rows("SELECT 1 FROM workspace_ids WHERE workspace = ?", workspace)).length > 0
          )
            return false

          yield* sql.exec(
            "INSERT INTO apex_workspaces (workspace, creator, domain, created) VALUES (?, ?, ?, ?) ON CONFLICT (workspace) DO NOTHING",
            workspace,
            viewer.email,
            workDomainOf(viewer.email),
            new Date().toISOString(),
          )

          const [row] = yield* rows<{ creator: string }>(
            "SELECT creator FROM apex_workspaces WHERE workspace = ?",
            workspace,
          )

          return row?.creator === viewer.email
        }),

        /** How many workspaces `email` made here in the last hour (workspace_create allows a few). */
        madeLately: Effect.fn("ApexDO.madeLately")(function* (email: string) {
          const [row] = yield* rows<{ n: number }>(
            "SELECT COUNT(*) AS n FROM apex_workspaces WHERE creator = ? AND created > ?",
            email,
            new Date(Date.now() - 3_600_000).toISOString(),
          )

          return row?.n ?? 0
        }),

        /** Keeps one report, or refuses it when its workspace sent FEEDBACK_PER_DAY in the last 24 hours. */
        feedbackSubmit: Effect.fn("ApexDO.feedbackSubmit")(function* (report: FeedbackReport) {
          const [row] = yield* rows<{ n: number }>(
            "SELECT COUNT(*) AS n FROM feedback WHERE workspace = ? AND at > ?",
            report.workspace,
            new Date(Date.now() - 86_400_000).toISOString(),
          )

          const count = row?.n ?? 0

          if (count >= FEEDBACK_PER_DAY) return { kind: "limited" as const, count }

          const [added] = yield* rows<{ id: number }>(
            `INSERT INTO feedback (at, workspace, person, category, summary, goal, details, tool, calls)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            new Date().toISOString(),
            report.workspace,
            report.person,
            report.category,
            report.summary,
            report.goal,
            report.details,
            report.tool,
            report.calls,
          )

          return { kind: "stored" as const, id: added?.id ?? 0 }
        }),
      }
    })
  }),
) {}
