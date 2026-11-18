import type { EventsQuery, EventsData, WorkspaceEvent } from "./events.ts"
import * as Runtime from "./runtime/index.ts"
import { objectFileId } from "./runtime/object-id.ts"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Match from "effect/Match"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  type WhoHas,
  type AccountData,
  type AdminAction,
  adminSaid,
  type Ask,
  type Asked,
  doneNotice,
  type AsksData,
  isAdminAction,
  type Notice,
  type WorkspaceData,
  refusedNotice,
  type SettingsAction,
} from "./settings.ts"
import {
  type CallingApp,
  type Directory,
  type FunctionRunner,
  type Listing,
  openConnections,
  type PageWho,
} from "./connections.ts"
import { SignInReturn } from "./signins/index.ts"
import { openToolCalls } from "./tool-calls.ts"
import { secretValueProblem } from "./capabilities.ts"
import { connectionLabel } from "./home.ts"
import {
  AgentApps,
  type AppTools,
  CredentialOwner,
  type Environment,
  type ErrorCode,
  type Json,
  WorkspaceId,
  WorkspaceName,
  type Person,
  type PersonId,
  type RunAuthority,
  Refused,
  secretNameProblem,
  decodeAgentApps,
  LIMITED_CANT_MANAGE,
  mayUseApp,
  notInApps,
  type AppRecord,
  type PanelAccess,
  privateApp,
  type StoredView,
  type Viewer,
} from "./model.ts"
import { ACCESS_PREFIX, type AuthorizeRequest, type ClientRow, openOAuth } from "./oauth.ts"
import ApexDO, { APEX, MAX_WORKSPACE_NAMES } from "./apex.ts"
import { type Admission, type Member, openPeople, refusalOf, type TokenCheck } from "./people.ts"
import { endSessionsOf, openLogin } from "./login.ts"
import { openJoinAsks } from "./joins.ts"
import { APP_SEPARATOR, appUrl, hostProblem, MAX_LABEL } from "./hosts.ts"
import { STARTER_WRITER, STARTERS } from "./starters.ts"
import { openTrial, shutUntilClaimed } from "./trials.ts"
import { keepFields } from "./answers.ts"
import { REACH, sealing, textOf } from "./upstream.ts"
import { openPush, type PushMessage, type PushSubscription } from "./push.ts"
import { openHosts, SIGNIN } from "./session.ts"
import AppDO from "./app.ts"
import { type DirectoryEntry, type Listed, openDirectory, type PageAsk } from "./directory.ts"

type Row = { name: string; id: string; owner: string; created: string; description: string }

const EVERYONE = 1000

/** How often the directory asks an app made before it for its entry (WorkspaceDO.fill). */
const FILL_EVERY_MS = 2000

const APPS = "SELECT name, id, owner, created, description FROM apps"

const RUNS_AS = {
  me: "their own token",
  workspace: "the workspace's token",
  none: "no token",
} as const

type EnvRow = { name: string; note: string; touched: number; touched_by: string; apps: string }

const ENVIRONMENTS = `SELECT e.name, e.note, e.touched, e.touched_by,
  COALESCE((SELECT json_group_array(name) FROM (SELECT a.name FROM environment_apps m
    JOIN apps a ON a.id = m.app_id WHERE m.env = e.name ORDER BY a.name)), '[]') AS apps
  FROM environments e`

const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const failed = (message: string) => ({
  ok: false as const,
  connection: null,
  back: "",
  allowed: false,
  message,
})

const allowAfterSignIn = (back: string, connection: string) => {
  if (!back.startsWith("/_connections?")) return undefined

  const query = new URLSearchParams(back.slice("/_connections?".length))
  const app = query.get("app")
  const tools = query.get("tools")
  const env = query.get("env")

  if (query.get("next") !== "allow" || query.get("connect") !== connection) return undefined

  if (app === null || app === "" || tools === null) return undefined

  return {
    app,
    env: env === null || env === "" ? undefined : env,
    tools: tools.split(",").filter((t) => t !== ""),
  }
}

const decodeRename = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ to: Schema.String })),
)

const decodeWorkspaceName = Schema.decodeUnknownOption(WorkspaceName)

const toEnvironment = (row: EnvRow): Environment => ({
  env: row.name,
  note: row.note,
  apps: decodeNames(row.apps),
  lastWrite: new Date(row.touched).toISOString(),
  by: row.touched_by,
})

/** Whether `person` owns the app or administers the workspace: who may always open it and change who can view it. */
const manages = (
  person: { readonly id: string; readonly email: string; readonly role: string },
  record: { readonly owner: string; readonly ownedBy: string | null },
) =>
  person.role === "admin" ||
  (record.ownedBy === null ? person.email === record.owner : person.id === record.ownedBy)

class WorkspaceObject extends Runtime.DurableObject(
  "WorkspaceDO",
  Effect.gen(function* () {
    const state = yield* Runtime.DurableObjectState
    const appDOs = yield* AppDO
    const apex = (yield* ApexDO).getByName(APEX)

    const idleMs =
      (yield* Config.Number("OPENBELT_PREVIEW_TTL_SECONDS").pipe(
        Config.withDefault(7 * 86_400),
        Effect.orDie,
      )) * 1000

    const secretsKey = yield* Config.Redacted("OPENBELT_SECRETS_KEY").pipe(Effect.orDie)

    const reach = yield* REACH.pipe(Effect.orDie)

    const accessMs =
      (yield* Config.Number("OPENBELT_OAUTH_ACCESS_TTL_SECONDS").pipe(
        Config.withDefault(30 * 86_400),
        Effect.orDie,
      )) * 1000

    const outside = openHosts(yield* SIGNIN.pipe(Effect.orDie))

    return Effect.gen(function* () {
      const { sql } = state.storage

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS apps (
        name TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, created TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '')`)

      const [ownerPerson] = yield* (yield* sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pragma_table_info('apps') WHERE name = 'owner_person'",
      )).toArray()

      if (ownerPerson?.n === 0) yield* sql.exec("ALTER TABLE apps ADD COLUMN owner_person TEXT")

      // The apps an app's pages may read across (/a/<app>/): those of the agent limited to some apps that deployed it last; null
      // (every app) when its last deploy came from an agent with every app.
      const [reachColumn] = yield* (yield* sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pragma_table_info('apps') WHERE name = 'reach'",
      )).toArray()

      if (reachColumn?.n === 0) yield* sql.exec("ALTER TABLE apps ADD COLUMN reach TEXT")

      // Who can view each app (StoredView): every member until its owner makes it private. It replaced "panel", which said only
      // who saw the app's panel while every member opened the app itself.
      const columns = new Set(
        (yield* (yield* sql.exec<{ name: string }>(
          "SELECT name FROM pragma_table_info('apps')",
        )).toArray()).map((c) => c.name),
      )

      if (!columns.has("view"))
        yield* sql.exec("ALTER TABLE apps ADD COLUMN view TEXT NOT NULL DEFAULT 'workspace'")

      if (columns.has("panel")) yield* sql.exec("ALTER TABLE apps DROP COLUMN panel")

      // Each app's files' bytes (stored and being uploaded), so an upload checks the workspace's total in one turn of this object.
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS file_usage (
        app_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`)

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS data_usage (
        app_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`)

      const filesUsed = Effect.fnUntraced(function* () {
        const [row] = yield* (yield* sql.exec<{ n: number | null }>(
          "SELECT SUM(bytes) AS n FROM file_usage",
        )).toArray()

        return row?.n ?? 0
      })

      const appDirectory = yield* openDirectory(state.storage)

      /**
       * Fill the directory in for apps made before it, without waking them all: first index every app's name and description from
       * the workspace's own table (no app woken), then ask one app at a time for its entry, slowly. Each app asked stays awake for its idle
       * time (10 minutes), so one every 2 seconds keeps at most about 300 awake for it; an app that wakes for anything else sends
       * its entry at once (app.ts), so the ones in use are filled in first.
       */
      const fill: () => Effect.Effect<void> = Effect.fn("WorkspaceDO.fill")(function* () {
        const unindexed = yield* appDirectory.unindexed(500)

        yield* Effect.forEach(unindexed, (id) => appDirectory.reindex(id), { discard: true })

        const [id] = yield* appDirectory.unentered(1)

        const sent =
          id === undefined
            ? false
            : yield* appDOs
                .getByName(id)
                .entry()
                .pipe(
                  Effect.flatMap((entry) => appDirectory.put(id, entry)),
                  Effect.as(true),
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `directory: app ${id} didn't send its entry; asked again later`,
                      cause,
                    ).pipe(Effect.as(false)),
                  ),
                )

        if (id === undefined && unindexed.length === 0) return

        // More names to index: soon. An app asked: the next in 2 seconds. One that refused: a minute.
        const wait = unindexed.length > 0 ? 100 : sent ? FILL_EVERY_MS : 60_000

        yield* fillJob.schedule("next", { at: Date.now() + wait, payload: {} }).pipe(Effect.orDie)
      })

      const fillNow = (): Effect.Effect<void> => fill()
      const fillJob = yield* Runtime.makeCallback("directory_fill", fillNow)

      if (
        (yield* appDirectory.unentered(1)).length > 0 ||
        (yield* appDirectory.unindexed(1)).length > 0
      )
        yield* fillJob.schedule("next", { at: Date.now() + 1000, payload: {} }).pipe(Effect.orDie)

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS environments (
        name TEXT PRIMARY KEY, note TEXT NOT NULL, touched INTEGER NOT NULL, touched_by TEXT NOT NULL)`)
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS environment_apps (
        env TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (env, app_id))`)

      const environment = Effect.fn("WorkspaceDO.environment")(function* (env: string) {
        const [row] = yield* (yield* sql.exec<EnvRow>(
          `${ENVIRONMENTS} WHERE e.name = ?`,
          env,
        )).toArray()

        return row === undefined ? null : toEnvironment(row)
      })

      const touch = Effect.fnUntraced(function* (env: string, by: string) {
        yield* sql.exec(
          "UPDATE environments SET touched = ?, touched_by = ? WHERE name = ?",
          Date.now(),
          by,
          env,
        )
      })

      /**
       * Book the expiry job for when the environment used longest ago would expire. A durable
       * callback, not the alarm itself: once an object registers callbacks, its one alarm is
       * the jobs', which moves or deletes one set by hand.
       */
      const schedule = Effect.fnUntraced(function* () {
        const [row] = yield* (yield* sql.exec<{ oldest: number | null }>(
          "SELECT MIN(touched) AS oldest FROM environments",
        )).toArray()

        if (row?.oldest !== null && row?.oldest !== undefined) {
          yield* expiryJob
            .schedule("previews", { at: Math.max(Date.now(), row.oldest + idleMs), payload: {} })
            .pipe(Effect.orDie)
        }
      })

      const expire: () => Effect.Effect<void> = Effect.fn("WorkspaceDO.expire")(function* () {
        const idle = yield* (yield* sql.exec<{ name: string }>(
          "SELECT name FROM environments WHERE touched <= ?",
          Date.now() - idleMs,
        )).toArray()

        for (const { name } of idle) {
          const members = yield* (yield* sql.exec<{ app_id: string }>(
            "SELECT app_id FROM environment_apps WHERE env = ?",
            name,
          )).toArray()

          const why = `expired: no deploys or writes in preview ${name} for ${Math.round(idleMs / 1000)} seconds`

          yield* Effect.forEach(members, (m) => appDOs.getByName(m.app_id).dropEnv(name, why, "-"))
          yield* sql.exec("DELETE FROM environment_apps WHERE env = ?", name)
          yield* sql.exec("DELETE FROM environments WHERE name = ?", name)
          state.storage.kv.delete(`preview-live:${name}`)
          yield* Effect.logInfo(`preview environment ${name} ${why}`)
        }

        yield* schedule()
      })

      const expireNow = (): Effect.Effect<void> => expire()
      const expiryJob = yield* Runtime.makeCallback("preview_expiry", expireNow)

      yield* schedule()

      const app = Effect.fn("WorkspaceDO.app")(function* (name: string) {
        const [row] = yield* (yield* sql.exec<Row>(`${APPS} WHERE name = ?`, name)).toArray()

        return row ?? null
      })

      /**
       * Names claimed for a first deploy that hasn't landed: how many deploy_app calls are on it, and whether one landed. When the
       * last of them settles and none landed (each was refused), the name is given back, so a refused first deploy leaves no app.
       * Held in memory: after a restart in between, the name stays claimed, as every claim did before.
       */
      const firsts = new Map<string, { id: string; deploying: number; landed: boolean }>()

      /** Whether app `name` is private and `person` neither owns it nor administers the workspace, so they may not open it. */
      const hiddenFrom = Effect.fn("WorkspaceDO.hiddenFrom")(function* (
        name: string,
        person: { readonly id: string; readonly email: string; readonly role: string },
      ) {
        const [row] = yield* (yield* sql.exec<{
          owner: string
          owner_person: string | null
          view: string
        }>("SELECT owner, owner_person, view FROM apps WHERE name = ?", name)).toArray()

        return (
          row !== undefined &&
          row.view === "private" &&
          !manages(person, { owner: row.owner, ownedBy: row.owner_person })
        )
      })

      /**
       * The app `name`, who can view it (as the workspace keeps it) and what `viewer` may do with its panel in the frame: manage it
       * (its owner, a workspace admin), see its link and who can view it (a member who may open it), or nothing. Null when there's
       * no such app.
       */
      const panelOf = Effect.fn("WorkspaceDO.panelOf")(function* (
        name: string,
        viewer: Viewer | null,
      ) {
        const [row] = yield* (yield* sql.exec<Row & { owner_person: string | null; view: string }>(
          "SELECT name, id, owner, created, description, owner_person, view FROM apps WHERE name = ?",
          name,
        )).toArray()

        if (row === undefined) return null

        const { owner_person: ownedBy, view: kept, ...record } = row
        const view: StoredView = kept === "private" ? "private" : "workspace"
        const admission = viewer === null ? null : yield* people.admit(viewer)
        const person = admission?.kind === "member" ? admission.person : null

        const access: PanelAccess =
          person === null
            ? "none"
            : manages(person, { owner: record.owner, ownedBy })
              ? "manage"
              : view === "workspace"
                ? "view"
                : "none"

        return { record, view, access }
      })

      const describe = Effect.fn("WorkspaceDO.describe")(function* (
        name: string,
        description: string,
      ) {
        yield* sql.exec("UPDATE apps SET description = ? WHERE name = ?", description, name)

        const row = yield* app(name)

        if (row !== null) yield* appDirectory.reindex(row.id)
      })

      const { kv } = state.storage

      const previewLive = (env: string) =>
        kv.get<{ readonly by: string; readonly at: string }>(`preview-live:${env}`) ?? null

      const push = yield* openPush(state.storage, yield* sealing(Redacted.value(secretsKey)))

      const disconnect = Effect.fnUntraced(function* (
        email: string,
        ids: ReadonlyArray<string>,
        why: string,
        kind: "removed" | "regrouped" | "signed_out",
      ) {
        if (kind === "removed") yield* push.forget(email)

        const closed = yield* Effect.forEach(
          ids,
          (id) => appDOs.getByName(id).disconnect(email, why, kind),
          { concurrency: 8 },
        )

        return closed.reduce((sum, n) => sum + n, 0)
      })

      const toolCalls = yield* openToolCalls(state.storage)

      const connections = yield* openConnections(
        state.storage,
        Redacted.value(secretsKey),
        reach,
        outside,
        toolCalls,
      )

      const oauth = yield* openOAuth(state.storage, reach, accessMs, Redacted.value(secretsKey))

      const forget = Effect.fnUntraced(function* (person: PersonId, by: string) {
        yield* oauth.signOutPerson(person, `the person was removed from the workspace by ${by}`)
        yield* endSessionsOf(state.storage, person)

        return yield* connections.forgetPerson(person)
      })

      /**
       * The base host's index of who is in which workspace (apex.ts) hears of each person added here, as a job (at least once, booked in
       * the transaction that adds them); "*" sends everyone, once, for a workspace that had people before the index did.
       */
      const sendListed = Effect.fn("WorkspaceDO.sendListed")(function* (payload: string) {
        const workspace = state.id.toString()

        if (payload !== "*") {
          yield* apex.listed(workspace, [payload])

          return
        }

        const everyone = yield* (yield* sql.exec<{ email: string }>(
          "SELECT email FROM people ORDER BY email",
        )).toArray()

        for (let at = 0; at < everyone.length; at += 500)
          yield* apex.listed(
            workspace,
            everyone.slice(at, at + 500).map((p) => p.email),
          )

        state.storage.kv.put("apex_listed", true)
      })

      const listJob = yield* Runtime.makeCallback("apex_listed", sendListed)

      const listed = (email: string) =>
        listJob.schedule(`email:${email}`, { after: 0, payload: email }).pipe(Effect.orDie)

      const people = yield* openPeople(
        state.storage,
        disconnect,
        forget,
        connections.forgetGroup,
        listed,
        () => shutUntilClaimed(state.storage),
      )

      if (state.storage.kv.get("apex_listed") !== true)
        yield* listJob.schedule("all", { after: "1 second", payload: "*" }).pipe(Effect.orDie)

      const login = yield* openLogin(state.storage, people)

      const trial = openTrial(state.storage, people)

      const joinAsks = yield* openJoinAsks(state.storage, {
        known: (email) => Effect.map(people.standing(email), (s) => s.status !== "none"),
      })

      const oauthPerson = Effect.fnUntraced(function* (
        workspace: WorkspaceName,
        viewer: Viewer | null,
        client: string,
      ) {
        const admission = yield* people.admit(viewer)

        if (admission.kind !== "member")
          return {
            kind: "refused" as const,
            message:
              refusalOf(workspace, admission) ??
              `nobody is signed in here (the front door, Tailscale, didn't say who you are), so there's nobody for ${client} to act as. Open this link from a device signed in to ${workspace}.`,
          }

        return { kind: "person" as const, person: admission.person }
      })

      /** Who signs the agent in; a refusal of a device sign-in also ends it, so the terminal waiting on it says why. */
      const agentPerson = (
        workspace: WorkspaceName,
        viewer: Viewer | null,
        asked: AuthorizeRequest,
        checked: { readonly client: { readonly name: string }; readonly userCode: string | null },
      ) =>
        oauthPerson(workspace, viewer, checked.client.name).pipe(
          Effect.tap((who) =>
            who.kind === "refused" && checked.userCode !== null
              ? oauth.deviceDone(asked.state ?? "", { refused: who.message })
              : Effect.void,
          ),
        )

      const allowAgent = Effect.fnUntraced(function* (
        asked: AuthorizeRequest,
        issuer: string,
        person: { readonly id: PersonId; readonly email: string },
        checked: {
          readonly client: { readonly id: string; readonly name: string }
          readonly userCode: string | null
        },
        how: string,
        deviceElsewhere?: string,
      ) {
        const done = yield* oauth.authorize(asked, issuer, person.id, deviceElsewhere)

        if (done.kind === "consent") return yield* Effect.die("oauth: allowed, but no code made")

        yield* Effect.logInfo(
          `oauth: ${person.email} ${how}: ${checked.client.name} (${checked.client.id}) back to ${asked.redirectUri}`,
        )

        return done
      })

      const checkToken = Effect.fnUntraced(function* (token: string) {
        if (!token.startsWith(ACCESS_PREFIX)) return yield* people.checkToken(token)

        const access = yield* oauth.check(token)

        if (access.kind === "valid")
          return yield* people.signedIn(access.person, access.client, access.grant, access.apps)

        if (access.kind === "expired")
          return { kind: "access_expired", expired: access.expired } satisfies TokenCheck

        return access
      })

      const callingApp = Effect.fnUntraced(function* (name: string, env: string | undefined) {
        const record = yield* app(name)

        if (record === null) {
          return yield* new Refused({
            message: `there's no app "${name}" in this workspace: search({ query }) finds the ones that exist`,
          })
        }

        const tools = yield* appDOs.getByName(record.id).tools(env)

        if (tools === null) {
          return yield* new Refused({
            message:
              env === undefined
                ? `"${name}" has no live version yet`
                : `"${name}" isn't deployed into preview environment "${env}"`,
          })
        }

        const calling: CallingApp = { id: record.id, name, tools, env }

        return calling
      })

      const directory: Directory = {
        find: people.find,
        group: people.group,
        admins: people.admins,
        app: callingApp,
        everyone: () => people.active(EVERYONE),
      }

      const pageWho = Effect.fnUntraced(function* (
        viewer: Viewer | null,
        test: string | null,
        checkedBy: string | null,
      ) {
        const seen: PageWho | { readonly kind: "refused"; readonly admission: Admission } =
          yield* Effect.gen(function* () {
            if (checkedBy !== null) {
              const by = yield* people.find(checkedBy).pipe(Effect.orElseSucceed(() => null))

              if (by === null || by.status === "removed")
                return {
                  kind: "refused" as const,
                  admission: { kind: "signed_out" as const, admins: yield* people.admins() },
                }

              return test === null
                ? { kind: "signed_out" as const, by }
                : { kind: "test_person" as const, email: test, by }
            }

            const admission = yield* people.admit(viewer)

            if (admission.kind === "member")
              return { kind: "person" as const, person: yield* people.find(admission.person.id) }

            if (admission.kind === "anonymous") return { kind: "signed_out" as const }

            return { kind: "refused" as const, admission }
          })

        return seen
      })

      const CONNECTION_ROUTES =
        /^(?:workspace\/(?:connections|access|explain|activity)|me\/connections)(?:\/|$)/

      const refusalOfAnswer = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))

      const Renamed = Schema.decodeUnknownOption(
        Schema.Struct({ workspace: Schema.String, from: Schema.String }),
      )

      const AddedConnection = Schema.decodeUnknownOption(
        Schema.Struct({
          connection: Schema.Struct({ name: Schema.String, credential: CredentialOwner }),
          listed: Schema.Struct({ waiting: Schema.optional(Schema.String) }),
        }),
      )

      const results = Effect.fnUntraced(function* () {
        const everyone = yield* people.active(EVERYONE)
        const levels = yield* connections.levels(everyone)

        return {
          everyone,
          levels,
          flat: new Map(
            levels.flatMap((c) =>
              Object.entries(c.result).map(
                ([id, r]) => [`${id} ${c.connection}`, r.level] as const,
              ),
            ),
          ),
        }
      })

      /** Who gets each connection, for its page: everyone's level, then each group and exception that sets one. */
      const whoHas = Effect.fnUntraced(function* () {
        const { everyone, levels } = yield* results()
        const groups = yield* people.groups()
        const size = new Map(groups.map((g) => [g.name, g.members.length]))

        return Object.fromEntries(
          levels.map((l) => {
            const who: WhoHas = {
              everyone: l.everyone,
              groups: Object.entries(l.groups).map(([name, level]) => ({
                name,
                members: size.get(name) ?? 0,
                level,
              })),
              people: Object.entries(l.people).flatMap(([id, level]) => {
                const p = everyone.find((e) => e.id === id)

                return p === undefined ? [] : [{ email: p.email, name: p.name, level }]
              }),
              unset: {
                groups: groups.flatMap((g) => (g.name in l.groups ? [] : [g.name])),
                people: everyone.flatMap((p) =>
                  p.id in l.people ? [] : [{ email: p.email, name: p.name }],
                ),
              },
            }

            return [l.connection, who] as const
          }),
        )
      })

      /**
       * The published apps (openbelt.json "public") whose public name, <app>--<workspace>, would be over a DNS label's 63 characters under
       * the name `to`: only an app whose own name is long enough is asked whether it is published.
       */
      /** Why apps here couldn't have a host if the workspace were called `to` (`<app>--<to>` passes a DNS label's 63 characters). */
      const hostsTooLong = Effect.fnUntraced(function* (to: string) {
        const long = yield* (yield* sql.exec<{ name: string }>(
          "SELECT name FROM apps WHERE length(name) > ?",
          MAX_LABEL - APP_SEPARATOR.length - to.length,
        )).toArray()

        return long.flatMap((row) => hostProblem(row.name, to) ?? [])
      })

      /**
       * Rename the workspace, for its admins: its name changes in the directory (ApexDO.renameWorkspace, one transaction), and nothing here
       * does. Its id, objects, tokens and data stay as they are, and its old names keep reaching it. Asked again once done, it
       * answers the same.
       */
      const rename = Effect.fnUntraced(function* (
        workspace: WorkspaceName,
        caller: Member,
        method: string,
        text: string,
        trace: string,
      ) {
        const fail = (status: number, code: ErrorCode, error: string) => ({
          status,
          body: { error, code, trace },
        })

        if (method !== "POST")
          return fail(405, "method", 'POST /_workspace/rename {"to": "<new name>"}')

        if (caller.role !== "admin") {
          const admins = yield* people.admins()

          return fail(
            403,
            "not_admin",
            admins.length === 0
              ? `renaming ${workspace} is for its admins, and it has none yet: whoever runs this OpenBelt names one (POST /_admin/workspace-admins)`
              : `renaming ${workspace} is for its admins (${admins.join(", ")}), and ${caller.email} is a member: ask one of them`,
          )
        }

        const unclaimed = shutUntilClaimed(state.storage)

        if (unclaimed !== undefined)
          return fail(403, "not_allowed", `${unclaimed}. Its name stays ${workspace} until then`)

        const asked = Option.getOrUndefined(decodeRename(text))

        if (asked === undefined) return fail(400, "invalid", 'send JSON like {"to": "acme-labs"}')

        const to = Option.getOrUndefined(decodeWorkspaceName(asked.to.trim().toLowerCase()))

        if (to === undefined)
          return fail(
            400,
            "invalid",
            `"${asked.to}" can't be a workspace name: use lowercase letters, digits and single dashes, at most 40, like acme-labs`,
          )

        const tooLong = yield* hostsTooLong(to)

        if (tooLong.length > 0)
          return fail(
            409,
            "conflict",
            `${workspace} can't become ${to}: ${tooLong.join("; ")}. Nothing was renamed`,
          )

        const done = yield* apex.renameWorkspace(
          Schema.decodeUnknownSync(WorkspaceId)(state.id.toString()),
          to,
        )

        if (done.kind === "taken")
          return fail(
            409,
            "conflict",
            `${to} is another workspace's name, now or before (a workspace keeps its old names): pick another`,
          )

        if (done.kind === "full")
          return fail(
            409,
            "conflict",
            `${workspace} has had ${done.names} names, the most a workspace keeps (${MAX_WORKSPACE_NAMES}: each stays reserved for it): rename it to one of its old names instead`,
          )

        if (done.changed)
          yield* Effect.logInfo(`${caller.email} renamed the workspace ${done.from} → ${to}`).pipe(
            Effect.annotateLogs({ trace, workspace: state.id.toString() }),
          )

        return {
          status: 200,
          body: { workspace: to, from: done.from, renamed: done.changed, trace },
        }
      })

      /**
       * An admin's or a person's route (/_workspace/..., /_me/...), from a token or a settings page. `within`: the apps the calling
       * agent is limited to (null for every app, and for a settings page); a limited one is no admin here.
       */
      const act = Effect.fnUntraced(function* (
        workspace: WorkspaceName,
        origin: string,
        who: Member,
        route: string,
        method: string,
        text: string,
        trace: string,
        within: AgentApps,
      ) {
        const caller: Member = within === null ? who : { ...who, role: "member" }

        if (route === "workspace/rename")
          return yield* rename(workspace, caller, method, text, trace)

        const done = (body: Readonly<Record<string, Json>>) => ({
          status: 200,
          body: { ...body, trace },
        })

        if (route === "workspace/join-requests" && method === "GET") {
          if (caller.role !== "admin")
            return {
              status: 403,
              body: {
                error: "listing join requests requires a workspace admin",
                code: "not_admin",
                trace,
              },
            }

          return done({ requests: yield* joinAsks.pending() })
        }

        if (route === "me/signins" && method === "GET")
          return done({ signins: yield* oauth.signedIn(caller.id) })

        if (route === "me/signins/apps" && method === "POST") {
          if (within !== null) return yield* new Refused({ message: LIMITED_CANT_MANAGE })

          const asked = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ id: Schema.String, apps: AgentApps })),
          )(text).pipe(
            Effect.mapError(
              () =>
                new Refused({
                  message:
                    'send {"id":"<sign-in id>","apps":["<app>"]} (or "apps": null for every app): agent_signins lists your signed-in agents',
                }),
            ),
          )

          if ((yield* oauth.setApps(caller.id, asked.id, asked.apps)) === 0)
            return yield* new Refused({
              message: `there's no agent sign-in "${asked.id}" of yours: agent_signins lists them`,
            })

          return done({ id: asked.id, apps: asked.apps })
        }

        if (route === "me/signins/revoke" && method === "POST") {
          if (within !== null) return yield* new Refused({ message: LIMITED_CANT_MANAGE })

          const asked = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
          )(text).pipe(
            Effect.mapError(
              () =>
                new Refused({
                  message: 'send {"id":"<sign-in id>"}: agent_signins lists your signed-in agents',
                }),
            ),
          )

          const revoked = yield* oauth.signOut(caller.id, asked.id, `${caller.email} signed it out`)

          if (!revoked)
            return yield* new Refused({
              message: `there's no agent sign-in "${asked.id}" of yours: agent_signins lists them`,
            })

          yield* Effect.logInfo(`${caller.email} signed out agent ${asked.id}`).pipe(
            Effect.annotateLogs({ trace, workspace }),
          )

          return done({ revoked: asked.id })
        }

        if (route === "me/consents" && method === "GET") {
          const names = new Map(
            (yield* (yield* sql.exec<Row>(APPS)).toArray()).map((r) => [r.id, r.name]),
          )

          return done({
            consents: (yield* connections.consents(caller.id)).map((c) => ({
              app: names.get(c.app) ?? c.app,
              connection: c.connection,
              tools: c.tools,
              granted: c.granted,
            })),
            requests: (yield* connections.asks(caller.id)).map((a) => ({
              app: names.get(a.app) ?? a.app,
              connection: a.connection,
              asked: a.asked,
            })),
          })
        }

        if (/^me\/consents\/(grant|revoke|dismiss)$/.test(route) && method === "POST") {
          const asked = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                app: Schema.String,
                connection: Schema.String,
                tools: Schema.optionalKey(Schema.Array(Schema.String)),
                preview: Schema.optionalKey(Schema.String),
              }),
            ),
          )(text).pipe(
            Effect.mapError(
              () =>
                new Refused({
                  message: 'send {"app":"<app>","connection":"<connection>","tools":["<tool>"]}',
                }),
            ),
          )

          if (!mayUseApp(within, asked.app))
            return yield* new Refused({ message: notInApps(within ?? [], asked.app) })

          const calling = yield* callingApp(asked.app, asked.preview)
          const person = yield* people.find(caller.id)
          let tools: ReadonlyArray<string> = []

          if (route === "me/consents/grant") {
            if (asked.tools === undefined || asked.tools.length === 0)
              return yield* new Refused({
                message:
                  "connection_consent_grant needs the explicit tools you allow: app_info shows the app's tool bindings",
              })
            tools = yield* connections.grant(person, calling, asked.connection, asked.tools)
          } else if (route === "me/consents/revoke") {
            yield* connections.revokeConsent(person, calling.id, asked.connection)
          } else {
            yield* connections.dismissAsk(person, calling.id, asked.connection)
          }

          const line = `${route.split("/")[2]} ${calling.name}'s consent for ${asked.connection}`
          yield* Effect.logInfo(`${caller.email}: ${line}`).pipe(
            Effect.annotateLogs({ trace, workspace }),
          )
          yield* appDOs.getByName(calling.id).note("info", trace, `${caller.email}: ${line}`)

          return done({ app: calling.name, connection: asked.connection, tools, changed: true })
        }

        return CONNECTION_ROUTES.test(route)
          ? yield* connections
              .act(workspace, origin, caller, route, method, text, trace, directory)
              .pipe(Effect.annotateLogs({ trace }))
          : yield* people.act(workspace, origin, caller, route, method, text, trace, within)
      })

      const adminAction = Effect.fnUntraced(function* (
        workspace: WorkspaceName,
        caller: Person,
        action: AdminAction,
        fields: Readonly<Record<string, string>>,
        trace: string,
        origin: string,
      ) {
        const field = (name: string) => fields[name] ?? ""

        const route = Match.value(action).pipe(
          Match.when(
            "connections/client",
            () => `workspace/connections/${field("connection")}/client`,
          ),
          Match.when("connections/icon", () => `workspace/connections/${field("connection")}/icon`),
          Match.when(
            "connections/icon/clear",
            () => `workspace/connections/${field("connection")}/icon/clear`,
          ),
          Match.orElse(() => `workspace/${action}`),
        )

        const body = Match.value(action).pipe(
          Match.when("people/invite", () => ({
            email: field("email"),
            role: field("role") || "member",
          })),
          Match.when(Match.is("people/remove"), () => ({ person: field("person") })),
          Match.when("people/role", () => ({ person: field("person"), role: field("role") })),
          Match.when("joining", () => ({ joining: field("joining") })),
          Match.when("rename", () => ({ to: field("name") })),
          Match.when("scim/token", () => ({ label: field("label") })),
          Match.when("scim/revoke", () => ({ id: field("id") })),
          Match.when(Match.is("groups/create", "groups/delete"), () => ({ name: field("name") })),
          Match.when(Match.is("groups/add", "groups/remove"), () => ({
            group: field("group"),
            person: field("person"),
          })),
          Match.when("access", () => ({
            connection: field("connection"),
            who: field("who"),
            level: field("level") || "unset",
          })),
          Match.when("access/tool", () => ({
            connection: field("connection"),
            tool: field("tool"),
            change: field("change") || "enable",
          })),
          Match.when(Match.is("access/asks/grant", "access/asks/close"), () =>
            field("person") === ""
              ? {
                  connection: field("connection"),
                  want: field("want"),
                  people: field("people"),
                }
              : { connection: field("connection"), want: field("want"), person: field("person") },
          ),
          Match.when("connections/client", () =>
            field("secret") === ""
              ? { clientId: field("clientId") }
              : { clientId: field("clientId"), secret: field("secret") },
          ),
          Match.when("connections/icon", () => ({
            connection: field("connection"),
            type: field("type"),
            base64: field("base64"),
          })),
          Match.when("connections/icon/clear", () => ({ connection: field("connection") })),
          Match.when("connections/add", () =>
            Object.fromEntries(
              ["provider", "name", "url", "credential", "everyone"].flatMap((key) =>
                field(key) === "" ? [] : [[key, field(key)]],
              ),
            ),
          ),
          Match.exhaustive,
        )

        const before = yield* results()
        const text = JSON.stringify(body)

        const answer = yield* act(workspace, origin, caller, route, "POST", text, trace, null)

        if (answer.status !== 200)
          return refusedNotice(
            Option.match(refusalOfAnswer(answer.body), {
              onNone: () => "it was refused",
              onSome: (r) => r.error,
            }),
          )

        const renamed = action === "rename" ? Renamed(answer.body) : Option.none()

        // Renamed: the page goes on at the workspace's new host (its old one sends pages there anyway).
        if (Option.isSome(renamed)) {
          const there = new URL(origin)
          const [first, ...rest] = there.hostname.split(".")

          if (first === workspace) there.hostname = [renamed.value.workspace, ...rest].join(".")

          return {
            ...doneNotice(adminSaid(action, body, answer.body, renamed.value.workspace)),
            go: `${there.origin}/_settings/people`,
          }
        }

        const added = action === "connections/add" ? AddedConnection(answer.body) : Option.none()

        if (Option.isSome(added) && field("clientId") !== "") {
          const named = added.value.connection.name

          const saved = yield* connections
            .act(
              workspace,
              origin,
              caller,
              `workspace/connections/${named}/client`,
              "POST",
              JSON.stringify(
                field("secret") === ""
                  ? { clientId: field("clientId") }
                  : { clientId: field("clientId"), secret: field("secret") },
              ),
              trace,
              directory,
            )
            .pipe(Effect.annotateLogs({ trace }))

          if (saved.status !== 200)
            return refusedNotice(
              `${connectionLabel(named)} is added, but its app wasn't saved: ${Option.match(refusalOfAnswer(saved.body), { onNone: () => "it was refused", onSome: (r) => r.error })}. Set it with bun run workspace connections client ${named} --client-id <id> < secret.txt`,
            )
        }

        if (
          Option.isSome(added) &&
          added.value.connection.credential !== "person" &&
          added.value.listed.waiting !== undefined
        )
          return {
            ...doneNotice(adminSaid(action, body, answer.body, workspace)),
            go: `/_connections/${added.value.connection.name}`,
          }

        const after = yield* results()
        const name = (id: string) => after.everyone.find((p) => p.id === id)?.email ?? id

        const changed = [...after.flat].flatMap(([key, level]) => {
          const was = before.flat.get(key)

          if (was === undefined || was === level) return []

          const [id = "", connection = ""] = key.split(" ")

          return [`${name(id)} on ${connectionLabel(connection)} ${was} → ${level}`]
        })

        const said = adminSaid(action, body, answer.body, workspace)

        if (action === "scim/token") {
          const token = Schema.decodeUnknownOption(
            Schema.Struct({ token: Schema.String, id: Schema.String }),
          )(answer.body)

          if (Option.isSome(token))
            return {
              ok: true,
              message: said,
              made: { kind: "scim" as const, ...token.value, expires: null },
            } satisfies Notice
        }

        return doneNotice(
          changed.length === 0
            ? said
            : `${said} That changes ${changed.length <= 4 ? changed.join(", ") : `${changed.slice(0, 4).join(", ")} and ${changed.length - 4} more`}.`,
        )
      })

      const claimApp = Effect.fn("WorkspaceDO.claim")(function* (
        name: string,
        user: string,
        person: string,
        description: string | undefined,
        by: AgentApps,
        deploying = false,
      ) {
        const existing = yield* app(name)

        if (existing !== null && existing.owner !== user) {
          const taken = yield* Effect.forEach([2, 3, 4, 5, 6, 7, 8, 9], (n) =>
            app(`${name}-${n}`).pipe(Effect.map((s) => (s === null ? `${name}-${n}` : undefined))),
          )

          const free = taken.find((n) => n !== undefined)

          return yield* new Refused({
            message: `the app "${name}" belongs to ${existing.owner}, so you can't deploy over it. Pick another name${free === undefined ? "" : `, like "${free}"`}, or ask ${existing.owner} to deploy it.`,
          })
        }

        if (existing !== null) {
          yield* sql.exec(
            "UPDATE apps SET reach = ? WHERE name = ?",
            by === null ? null : JSON.stringify(by),
            name,
          )

          const first = deploying ? firsts.get(name) : undefined
          const joined = first !== undefined && first.id === existing.id

          if (joined) first.deploying += 1

          if (description !== undefined) yield* describe(name, description)

          return {
            ...existing,
            description: description ?? existing.description,
            first: joined,
          }
        }

        const record: AppRecord = {
          name,
          id: crypto.randomUUID(),
          owner: user,
          created: new Date().toISOString(),
          description: description ?? "",
        }

        yield* sql.exec(
          "INSERT INTO apps (name, id, owner, owner_person, created, description, reach) VALUES (?, ?, ?, ?, ?, ?, ?)",
          record.name,
          record.id,
          record.owner,
          person,
          record.created,
          record.description,
          by === null ? null : JSON.stringify(by),
        )
        yield* appDirectory.put(record.id, {
          updated: null,
          shot: null,
          tools: [],
          functions: [],
          collections: [],
        })

        if (deploying) firsts.set(name, { id: record.id, deploying: 1, landed: false })

        return { ...record, first: deploying }
      })

      /** A first deploy claim made has ended: `landed` unless it was refused. The last to end, with none landed, gives the name back. */
      const settleApp = Effect.fn("WorkspaceDO.settle")(function* (
        name: string,
        id: string,
        landed: boolean,
      ) {
        const first = firsts.get(name)

        if (first === undefined || first.id !== id) return

        first.deploying -= 1
        first.landed ||= landed

        if (first.deploying > 0) return

        firsts.delete(name)

        if (first.landed) return

        yield* state.storage.transaction(
          Effect.gen(function* () {
            yield* sql.exec("DELETE FROM apps WHERE name = ? AND id = ?", name, id)
            yield* sql.exec("DELETE FROM directory WHERE app_id = ?", id)
            yield* appDirectory.reindex(id)
          }),
        )
      })

      /** Which starter each app came from (addStarter), by the app's id. */
      const startersOf = () => kv.get<Readonly<Record<string, string>>>("starters") ?? {}

      /**
       * Adds `starter` (starters.ts) as the app `name`, owned by `owner`, with the documents it starts with, written as OpenBelt.
       * Asked again for the same starter under the same name, it adds nothing and says so; any other app by that name refuses it.
       */
      /**
       * Each starter added here: the app it was added as (named otherwise when added so) and its owner, who with an admin may
       * remove it. A starter added twice (as tasks, then tasks-2) is its first app.
       */
      const startersHere = Effect.fn("WorkspaceDO.startersHere")(function* () {
        const from = startersOf()

        const apps = yield* (yield* sql.exec<{ name: string; id: string; owner: string }>(
          "SELECT name, id, owner FROM apps ORDER BY created DESC",
        )).toArray()

        return Object.fromEntries(
          apps.flatMap((a) =>
            from[a.id] === undefined
              ? []
              : [[from[a.id], { app: a.name, owner: a.owner }] as const],
          ),
        )
      })

      /**
       * Each starter whose name an app not from it already has: that app, as the directory lists it, and the first free name to
       * add the starter as instead (journal-2, journal-3…).
       */
      const startersTaken = Effect.fn("WorkspaceDO.startersTaken")(function* () {
        const from = startersOf()
        const taken: Record<string, { readonly app: Listed; readonly free: string }> = {}

        for (const starter of STARTERS) {
          const there = yield* app(starter.name)

          if (there === null || from[there.id] === starter.name) continue

          const entry = yield* appDirectory.listed(there.id)
          let n = 2

          while ((yield* app(`${starter.name}-${n}`)) !== null) n++

          if (entry !== null) taken[starter.name] = { app: entry, free: `${starter.name}-${n}` }
        }

        return taken
      })

      const addStarter = Effect.fn("WorkspaceDO.addStarter")(function* (
        starterName: string,
        name: string,
        owner: { readonly email: string; readonly person: string },
        origin: string,
        trace: string,
      ) {
        const starter = STARTERS.find((s) => s.name === starterName)

        if (starter === undefined)
          return yield* new Refused({
            message: `there's no starter "${starterName}": starter_list lists them (${STARTERS.map((s) => s.name).join(", ")})`,
          })

        const existing = yield* app(name)

        if (existing !== null) {
          if (existing.owner === owner.email && startersOf()[existing.id] === starter.name)
            return { added: false }

          return yield* new Refused({
            message: `there's already an app "${name}" (${existing.owner}'s), so the ${starter.name} starter wasn't added: add it under another name, starter_add({ starter: "${starter.name}", app: "${name}-2" })`,
          })
        }

        const workspace = Schema.decodeUnknownSync(WorkspaceId)(state.id.toString())
        const record = yield* claimApp(name, owner.email, owner.person, undefined, null, true)
        const target = appDOs.getByName(record.id)

        yield* target
          .deploy(
            name,
            {
              files: starter.files,
              keepOthers: false,
              remove: [],
              edits: [],
              base: undefined,
              env: undefined,
              by: owner.email,
              trace,
            },
            false,
            { workspace, origin },
          )
          .pipe(
            Effect.onExit((exit) =>
              record.first ? settleApp(name, record.id, Exit.isSuccess(exit)) : Effect.void,
            ),
          )

        kv.put("starters", { ...startersOf(), [record.id]: starter.name })

        const { description } = yield* target.config()

        if (description !== undefined) yield* describe(name, description)

        yield* Effect.forEach(
          starter.seed,
          ({ collection, writes }) =>
            target.writeMany(
              undefined,
              collection,
              writes,
              { writer: STARTER_WRITER, rules: "bypass", testFor: null },
              trace,
            ),
          { discard: true },
        )

        yield* target.starterPicture(starter.name, appUrl(origin, name))
        yield* Effect.logInfo(
          `added the ${starter.name} starter as ${name} for ${owner.email}`,
        ).pipe(Effect.annotateLogs({ trace, workspace }))

        return { added: true }
      })

      return {
        environment,

        /** The key a browser subscribes to the workspace's notifications with. */
        pushKey: Effect.fn("WorkspaceDO.pushKey")(function* () {
          return yield* push.key()
        }),

        /** `viewer` takes notifications on this device (a member only), or not any more (`device` null), or asks whether it does. */
        pushDevice: Effect.fn("WorkspaceDO.pushDevice")(function* (
          viewer: Viewer,
          action: "subscribe" | "unsubscribe" | "status",
          device: PushSubscription,
        ) {
          const admission = yield* people.admit(viewer)

          if (admission.kind !== "member")
            return yield* new Refused({ message: "only the workspace's people take notifications" })

          const { email } = admission.person

          if (action === "subscribe") yield* push.subscribe(email, device)

          if (action === "unsubscribe") yield* push.unsubscribe(email, device.endpoint)

          return { on: yield* push.subscribed(email, device.endpoint) }
        }),

        /**
         * An app's notification to `to` (the workspace's people, by email), on each device they turned notifications on for. Someone
         * not in the workspace is refused, so an app learns nothing it couldn't from the people list.
         */
        notify: Effect.fn("WorkspaceDO.notify")(function* (
          appName: string,
          to: ReadonlyArray<string>,
          message: PushMessage,
          subject: string,
        ) {
          const emails = [...new Set(to.map((email) => email.trim().toLowerCase()))]

          for (const email of emails) {
            const standing = yield* people.standing(email)

            if (standing.status !== "active")
              return yield* new Refused({
                message: `${email} isn't one of the workspace's people: notify sends only to them`,
              })
          }

          const record = yield* app(appName)

          if (record === null) return yield* new Refused({ message: `there's no app "${appName}"` })

          const { on, not } = yield* push.allowed(record.id, emails)

          return { ...(yield* push.send(on, message, subject)), notOptedIn: not }
        }),

        /** Where `viewer` stands with app `name`'s notifications; with `on`, their answer first (Allow, Not now, the panel's switch). */
        pushApp: Effect.fn("WorkspaceDO.pushApp")(function* (
          viewer: Viewer,
          name: string,
          on: boolean | null,
        ) {
          const admission = yield* people.admit(viewer)

          if (admission.kind !== "member")
            return yield* new Refused({ message: "only the workspace's people take notifications" })

          const found = yield* panelOf(name, viewer)

          if (found === null || found.access === "none")
            return yield* new Refused({ message: `there's no app "${name}"` })

          const { email } = admission.person

          if (on !== null) yield* push.answer(email, found.record.id, on)

          return { state: yield* push.appState(email, found.record.id) }
        }),

        environments: Effect.fn("WorkspaceDO.environments")(function* (appId?: string) {
          const rows = yield* (yield* appId === undefined
            ? sql.exec<EnvRow>(`${ENVIRONMENTS} ORDER BY e.touched DESC`)
            : sql.exec<EnvRow>(
                `${ENVIRONMENTS} WHERE e.name IN (SELECT env FROM environment_apps WHERE app_id = ?) ORDER BY e.touched DESC`,
                appId,
              )).toArray()

          return rows.map(toEnvironment)
        }),

        join: Effect.fn("WorkspaceDO.join")(function* (
          env: string,
          appId: string,
          by: string,
          note: string | undefined,
        ) {
          const [member] = yield* (yield* sql.exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM environment_apps WHERE env = ? AND app_id = ?",
            env,
            appId,
          )).toArray()

          if ((member?.n ?? 0) === 0 && previewLive(env) !== null) {
            kv.delete(`preview-live:${env}`)
            yield* Effect.logInfo(
              `preview environment ${env}: outside effects previewed again, as ${by} deployed another app into it`,
            )
          }

          yield* sql.exec(
            `INSERT INTO environments (name, note, touched, touched_by) VALUES (?, ?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET note = COALESCE(?, note), touched = excluded.touched,
               touched_by = excluded.touched_by`,
            env,
            note ?? "",
            Date.now(),
            by,
            note ?? null,
          )
          yield* sql.exec(
            "INSERT OR IGNORE INTO environment_apps (env, app_id) VALUES (?, ?)",
            env,
            appId,
          )

          yield* schedule()

          return yield* environment(env)
        }),

        touch: Effect.fn("WorkspaceDO.touch")(touch),

        /** An app the public host may show: none in a trial nobody has claimed (trials.ts), whose apps open only in check_app. */
        publicApp: Effect.fn("WorkspaceDO.publicApp")(function* (name: string) {
          if (shutUntilClaimed(state.storage) !== undefined) return null

          return yield* app(name)
        }),

        panelOf,

        /** What an app's panel shows besides the app itself: its owner's name and its colour from the directory. */
        panelAbout: Effect.fn("WorkspaceDO.panelAbout")(function* (id: string, owner: string) {
          const person = yield* people.find(owner).pipe(Effect.orElseSucceed(() => null))
          const entry = yield* appDirectory.listed(id)

          return {
            ownerName: person?.name ?? null,
            color: entry?.color ?? null,
          }
        }),

        /** Who can view app `name` in the workspace: only its owner or a workspace admin may change it. */
        setView: Effect.fn("WorkspaceDO.setView")(function* (
          name: string,
          viewer: Viewer,
          view: StoredView,
        ) {
          const found = yield* panelOf(name, viewer)

          if (found === null) return yield* new Refused({ message: `there's no app "${name}"` })

          if (found.access !== "manage")
            return yield* new Refused({
              message: `only the owner of "${name}" (${found.record.owner}) or a workspace admin may change who can view it`,
            })

          yield* sql.exec("UPDATE apps SET view = ? WHERE name = ?", view, name)

          return found
        }),

        /**
         * Delete an app, asked by its owner or a workspace admin: first everything the workspace keeps about it (so it 404s at
         * once and a new app can take the name with nothing left over), then the app's own storage (its files, data, pages, jobs).
         * Activity logs (connection and tool calls) stay, as the workspace's history.
         */
        deleteApp: Effect.fn("WorkspaceDO.deleteApp")(function* (
          name: string,
          viewer: Viewer,
          trace: string,
        ) {
          const found = yield* panelOf(name, viewer)

          if (found === null) return yield* new Refused({ message: `there's no app "${name}"` })

          if (found.access !== "manage")
            return yield* new Refused({
              message: `only the owner of "${name}" (${found.record.owner}) or a workspace admin may delete it`,
            })

          const id = found.record.id

          const envs = yield* (yield* sql.exec<{ env: string }>(
            "SELECT env FROM environment_apps WHERE app_id = ?",
            id,
          )).toArray()

          yield* state.storage.transaction(
            Effect.gen(function* () {
              yield* sql.exec("DELETE FROM apps WHERE id = ?", id)
              yield* sql.exec("DELETE FROM file_usage WHERE app_id = ?", id)
              yield* sql.exec("DELETE FROM data_usage WHERE app_id = ?", id)
              yield* sql.exec("DELETE FROM environment_apps WHERE app_id = ?", id)
              yield* sql.exec("DELETE FROM visits WHERE app = ?", id)
              yield* sql.exec("DELETE FROM app_consents WHERE app = ?", id)
              yield* sql.exec("DELETE FROM app_asks WHERE app = ?", id)
              yield* sql.exec("DELETE FROM directory WHERE app_id = ?", id)

              // A preview environment with no app left in it goes too, as an expired one does.
              for (const { env } of envs) {
                const [left] = yield* (yield* sql.exec<{ n: number }>(
                  "SELECT COUNT(*) AS n FROM environment_apps WHERE env = ?",
                  env,
                )).toArray()

                if ((left?.n ?? 0) === 0) {
                  yield* sql.exec("DELETE FROM environments WHERE name = ?", env)
                  state.storage.kv.delete(`preview-live:${env}`)
                }
              }

              // The apps allowed to frame others are kept by name: a new app with this name doesn't inherit it.
              const embed = people.embedding()

              if (embed.includes(name))
                state.storage.kv.put("embed", JSON.stringify(embed.filter((n) => n !== name)))
            }),
          )

          yield* appDirectory.reindex(id)

          // The record goes first, so nothing routes to the app while it empties its storage: no page, data or function call
          // reaches it, and a second delete is told there's no such app.
          yield* appDOs.getByName(id).destroy(trace)

          // Out of memory too, so nothing it cached outlives it; its next wake (if any) finds an empty file.
          yield* Effect.promise(() => Runtime.sleepActor(objectFileId("AppDO", id)))

          yield* Effect.logInfo(`app ${name} (${id}) deleted by ${viewer.email}`).pipe(
            Effect.annotateLogs({ trace }),
          )

          return { name, id }
        }),

        route: Effect.fn("WorkspaceDO.route")(function* (
          name: string,
          env: string | undefined,
          writer: string | undefined,
          viewer: Viewer | null,
          checked: boolean,
        ) {
          const admission = checked ? { kind: "anonymous" as const } : yield* people.admit(viewer)

          if (admission.kind !== "member" && admission.kind !== "anonymous")
            return { admission, record: null, envMissing: false, inEnv: false, hidden: false }

          const record = yield* app(name)

          const hidden =
            record !== null &&
            admission.kind === "member" &&
            (yield* hiddenFrom(name, admission.person))

          if (record !== null && admission.kind === "member") {
            const person = admission.person.id
            const id = record.id

            yield* Effect.addFinalizer(() =>
              people
                .visited(person, id)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("route: a visit wasn't saved", cause),
                  ),
                ),
            )
          }

          if (record === null || env === undefined)
            return { admission, record, envMissing: false, inEnv: false, hidden }

          const [found] = yield* (yield* sql.exec<{ member: number }>(
            "SELECT EXISTS (SELECT 1 FROM environment_apps WHERE env = ? AND app_id = ?) AS member FROM environments WHERE name = ?",
            env,
            record.id,
            env,
          )).toArray()

          if (found === undefined)
            return { admission, record, envMissing: true, inEnv: false, hidden }

          if (writer !== undefined && found.member === 1) yield* touch(env, writer)

          return { admission, record, envMissing: false, inEnv: found.member === 1, hidden }
        }),

        alarm: () => expire(),

        admit: Effect.fn("WorkspaceDO.admit")(people.admit),

        loginViewer: Effect.fn("WorkspaceDO.loginViewer")(function* (session: string) {
          const parent = yield* login.parent(session)

          if (parent !== null && !(yield* apex.browserActive(parent))) return null

          return yield* login.viewer(session)
        }),

        loginParent: Effect.fn("WorkspaceDO.loginParent")(login.parent),

        loginEndParent: Effect.fn("WorkspaceDO.loginEndParent")(function* (parent: string) {
          for (const email of yield* login.endParent(parent))
            yield* people.closePages(email, "they signed out")
        }),

        loginSignOut: Effect.fn("WorkspaceDO.loginSignOut")(function* (session: string) {
          const email = yield* login.signOut(session)

          if (email !== null) yield* people.closePages(email, "they signed out")

          return email
        }),

        /** The apps that may frame this workspace's other apps (the gateway's frame-ancestors). */
        embedding: Effect.fn("WorkspaceDO.embedding")(() => Effect.sync(people.embedding)),

        loginLink: Effect.fn("WorkspaceDO.loginLink")(login.link),

        loginLinkFor: Effect.fn("WorkspaceDO.loginLinkFor")(login.linkFor),

        loginRedeemLink: Effect.fn("WorkspaceDO.loginRedeemLink")(login.redeemLink),

        loginHandoff: Effect.fn("WorkspaceDO.loginHandoff")(login.handoff),

        loginRedeemHandoff: Effect.fn("WorkspaceDO.loginRedeemHandoff")(login.redeemHandoff),

        loginCarry: Effect.fn("WorkspaceDO.loginCarry")(login.carry),

        loginRedeemCarry: Effect.fn("WorkspaceDO.loginRedeemCarry")(login.redeemCarry),

        checkToken: Effect.fn("WorkspaceDO.checkToken")(checkToken),

        oauthRegister: Effect.fn("WorkspaceDO.oauthRegister")(oauth.register),

        oauthAuthorize: Effect.fn("WorkspaceDO.oauthAuthorize")(function* (
          workspace: WorkspaceName,
          asked: AuthorizeRequest,
          issuer: string,
          viewer: Viewer | null,
          navigated: boolean,
        ) {
          const checked = yield* oauth.authorize(asked, issuer, undefined)

          if (checked.kind !== "consent") return checked

          const who = yield* agentPerson(workspace, viewer, asked, checked)

          if (who.kind === "refused") return who

          const person = who.person

          // A device sign-in always asks: its code is the person's only check that the sign-in is the one in their terminal.
          if (
            navigated &&
            checked.userCode === null &&
            (yield* oauth.remembered(person.id, checked.client.id, asked.redirectUri))
          )
            return yield* allowAgent(asked, issuer, person, checked, "allowed before")

          return {
            ...checked,
            person: { email: person.email, name: person.name },
            handle: yield* oauth.pend(person.id, asked),
          }
        }),

        oauthDecide: Effect.fn("WorkspaceDO.oauthDecide")(function* (
          workspace: WorkspaceName,
          handle: string,
          issuer: string,
          viewer: Viewer | null,
          decision: "allow" | "deny",
        ) {
          const pending = yield* oauth.take(handle)

          if (pending === undefined)
            return {
              kind: "page" as const,
              title: "This sign-in page was used",
              message:
                "Each sign-in page answers once, within 10 minutes: start again from your agent.",
            }

          const checked = yield* oauth.authorize(pending.asked, issuer, undefined)

          if (checked.kind !== "consent") return checked

          const who = yield* agentPerson(workspace, viewer, pending.asked, checked)

          if (who.kind === "refused") return who

          if (who.person.id !== pending.person)
            return {
              kind: "page" as const,
              title: "Not your sign-in page",
              message: `This page asked someone else, not ${who.person.email}: start again from your agent.`,
            }

          if (decision === "deny")
            return { kind: "redirect" as const, location: oauth.denied(pending.asked, issuer) }

          if (checked.userCode === null)
            yield* oauth.remember(who.person.id, checked.client.id, pending.asked.redirectUri)

          return yield* allowAgent(pending.asked, issuer, who.person, checked, "allowed")
        }),

        oauthToken: Effect.fn("WorkspaceDO.oauthToken")(function* (
          form: Readonly<Record<string, string>>,
          basic: { readonly id: string; readonly secret: string } | undefined,
          issuer: string,
        ) {
          return yield* oauth.token(form, basic, people.isActive, issuer)
        }),

        oauthRevoke: Effect.fn("WorkspaceDO.oauthRevoke")(oauth.revoke),

        oauthDeviceStart: Effect.fn("WorkspaceDO.oauthDeviceStart")(oauth.deviceStart),

        oauthDeviceFind: Effect.fn("WorkspaceDO.oauthDeviceFind")(oauth.deviceFind),

        oauthDeviceDone: Effect.fn("WorkspaceDO.oauthDeviceDone")(oauth.deviceDone),

        /** Where someone stands here, for the base host's consent page (people.ts standing). */
        standing: Effect.fn("WorkspaceDO.standing")(people.standing),

        /** Someone at the work domain of whoever made this workspace asks to be let in (joins.ts): its admins, to say who decides. */
        askToJoin: Effect.fn("WorkspaceDO.askToJoin")(function* (email: string) {
          yield* joinAsks.ask(email)
          yield* Effect.logInfo(`people: ${email} asked to join`)

          return yield* people.admins()
        }),

        /** This workspace as a trial an agent started (trials.ts): its placeholder admin's token, and the claim code. */
        trialStart: Effect.fn("WorkspaceDO.trialStart")(trial.start),

        /** Whether this is a trial nobody has claimed: its apps open to nobody yet, and it gets no certificate. */
        trialUnclaimed: Effect.fn("WorkspaceDO.trialUnclaimed")(trial.unclaimed),

        trialClaim: Effect.fn("WorkspaceDO.trialClaim")(trial.claim),

        /** Someone made this workspace at the base host: they're its first admin (people.ts found). */
        found: Effect.fn("WorkspaceDO.found")(people.found),

        /**
         * An agent's sign-in at the base host that chose this workspace: the client it registered there is kept here, and the code is this
         * workspace's, for `viewer` if they're let in (an invite is accepted by it), so the token is too.
         */
        oauthIssue: Effect.fn("WorkspaceDO.oauthIssue")(function* (
          workspace: WorkspaceName,
          asked: AuthorizeRequest,
          issuer: string,
          viewer: Viewer,
          client: ClientRow | null,
          /** A device sign-in's user code, when the base host found one waiting there (it keeps those, not this workspace). */
          deviceElsewhere: string | null,
        ) {
          if (client !== null) yield* oauth.adopt(client)

          const elsewhere = deviceElsewhere ?? undefined
          const checked = yield* oauth.authorize(asked, issuer, undefined, elsewhere)

          if (checked.kind !== "consent") return checked

          const who = yield* agentPerson(workspace, viewer, asked, checked)

          if (who.kind === "refused") return who

          return yield* allowAgent(
            asked,
            issuer,
            who.person,
            checked,
            "allowed at the base host",
            elsewhere,
          )
        }),

        tokenFor: Effect.fn("WorkspaceDO.tokenFor")(people.tokenFor),

        makeAdmin: Effect.fn("WorkspaceDO.makeAdmin")(people.makeAdmin),

        whoami: Effect.fn("WorkspaceDO.whoami")(people.whoami),

        scim: Effect.fn("WorkspaceDO.scim")(function* (
          workspace: WorkspaceName,
          token: string,
          method: string,
          path: string,
          search: string,
          text: string,
          trace: string,
          origin: string,
        ) {
          return yield* people.scim(
            workspace,
            token,
            method,
            path,
            new URLSearchParams(search),
            text,
            trace,
            origin,
          )
        }),

        api: Effect.fn("WorkspaceDO.api")(function* (
          workspace: WorkspaceName,
          token: string,
          route: string,
          method: string,
          text: string,
          trace: string,
          origin: string,
        ) {
          const check = yield* checkToken(token)

          if (check.kind !== "valid") return { check, answer: null }

          const secretRoute = /^me\/apps\/([^/]+)\/secrets\/([^/]+)$/.exec(route)

          if (secretRoute !== null) {
            const [, appName = "", secret = ""] = secretRoute

            const fail = (status: number, code: ErrorCode, error: string) => ({
              check,
              answer: { status, body: { error, code, trace } },
            })

            if (method !== "POST")
              return fail(
                405,
                "method",
                "POST /_me/apps/<app>/secrets/<NAME> with the value as the body",
              )

            if (!mayUseApp(check.apps, appName))
              return fail(403, "not_allowed", notInApps(check.apps ?? [], appName))

            const record = yield* app(appName)

            if (record === null)
              return fail(
                404,
                "missing",
                `there's no app "${appName}" in ${workspace}: search({ query }) finds the ones that exist`,
              )

            const problem = secretNameProblem(secret)
            const value = text.trim()

            if (problem !== undefined) return fail(400, "invalid", problem)

            const tooShortOrLong = secretValueProblem(value)

            if (tooShortOrLong !== undefined) return fail(400, "invalid", tooShortOrLong)

            if (record.owner !== check.person.email && check.person.role !== "admin")
              return fail(
                403,
                "not_admin",
                `only ${record.owner} (who owns ${appName}) or a workspace admin (${(yield* people.admins()).join(", ")}) may set its secrets: ask one of them`,
              )

            const said = yield* Effect.result(
              appDOs.getByName(record.id).setSecret(secret, value, check.person.email, trace),
            )

            if (Result.isFailure(said)) return fail(400, "invalid", said.failure.message)

            return {
              check,
              answer: {
                status: 200,
                body: { app: appName, name: secret, ...said.success, trace },
              },
            }
          }

          return {
            check,
            answer: yield* act(
              workspace,
              origin,
              check.person,
              route,
              method,
              text,
              trace,
              check.apps,
            ).pipe(
              Effect.catchTag("Refused", (cause) =>
                Effect.succeed({
                  status: 400,
                  body: { error: cause.message, code: "invalid" as const, trace },
                }),
              ),
            ),
          }
        }),

        management: Effect.fn("WorkspaceDO.management")(function* (
          workspace: WorkspaceName,
          person: string,
          route: string,
          method: "GET" | "POST",
          text: string,
          trace: string,
          origin: string,
          within: AgentApps,
        ) {
          const caller = yield* people.find(person)

          if (caller.status === "removed")
            return yield* new Refused({
              message: `${caller.email} was removed from ${workspace}: ask its admins to invite them again`,
            })

          return yield* act(workspace, origin, caller, route, method, text, trace, within)
        }),

        toolOnlyReads: Effect.fn("WorkspaceDO.toolOnlyReads")(function* (qualified: string) {
          return yield* connections.onlyReads(qualified)
        }),

        functionTool: Effect.fn("WorkspaceDO.functionTool")(function* (
          name: string,
          env: string | undefined,
          authority: RunAuthority,
          via: string,
          connection: string,
          tool: string,
          input: Json,
          as: "workspace" | "me" | undefined,
          trace: string,
          origin: string,
        ) {
          const record = yield* app(name)

          if (record === null)
            return {
              ok: false as const,
              error: `there's no app "${name}" in this workspace`,
              sent: false,
            }

          const qualified = `${connection}.${tool}`

          const found = (email: string, why: string) =>
            Effect.mapError(
              directory.find(email),
              (e) =>
                `${qualified}: ${why} ${email} isn't one of the workspace's people (${e.message})`,
            )

          const runner = yield* Effect.result(
            Match.value(authority).pipe(
              Match.discriminatorsExhaustive("kind")({
                person: (p) =>
                  p.testFor === null
                    ? Effect.map(found(p.email, "the run's person"), (person): FunctionRunner => ({
                        kind: "person",
                        person,
                        present: p.present,
                      }))
                    : Effect.map(
                        found(p.testFor, "the person who ran the check,"),
                        (person): FunctionRunner => ({ kind: "test", person, test: p.email }),
                      ),
                signed_out: () => Effect.succeed<FunctionRunner>({ kind: "signed_out" }),
                public: () => Effect.succeed<FunctionRunner>({ kind: "signed_out" }),
                nobody: () =>
                  Effect.map(
                    found(
                      record.owner,
                      `a run no person started is held to its app's owner's level, and ${name}'s owner`,
                    ),
                    (owner): FunctionRunner => ({ kind: "nobody", owner }),
                  ),
              }),
            ),
          )

          if (Result.isFailure(runner))
            return {
              ok: false as const,
              error: `${runner.failure}, so it can't act as them`,
              sent: false,
            }

          const calling: CallingApp = { id: record.id, name, tools: {}, env }

          const called = yield* connections
            .callForFunction(
              runner.success,
              via,
              calling,
              connection,
              tool,
              input,
              as,
              trace,
              directory,
              origin,
              { preview: env === undefined ? null : { env, live: previewLive(env) !== null } },
            )
            .pipe(Effect.annotateLogs({ trace }))

          if (called.kind === "previewed")
            return {
              ok: true as const,
              text: called.message,
              structured: {
                previewed: true,
                tool: called.tool,
                input: called.input,
                note: called.message,
              },
              isError: false,
              runsAs: "-",
              ms: called.ms,
              readOnly: false,
              previewed: true,
            }

          if (called.kind !== "ran")
            return {
              ok: false as const,
              error: called.message,
              sent: called.kind === "failed" && !called.readOnly,
            }

          return {
            ok: true as const,
            text: textOf(called.result),
            structured: called.result.structuredContent ?? null,
            isError: called.result.isError ?? false,
            runsAs: RUNS_AS[called.runsAs],
            ms: called.ms,
            readOnly: called.readOnly,
            previewed: false,
          }
        }),

        previewLive: (env: string) => Effect.sync(() => previewLive(env) !== null),

        setPreviewLive: Effect.fn("WorkspaceDO.setPreviewLive")(function* (
          env: string,
          on: boolean,
          by: string,
        ) {
          if (on) kv.put(`preview-live:${env}`, { by, at: new Date().toISOString() })
          else kv.delete(`preview-live:${env}`)

          yield* Effect.logInfo(
            `preview environment ${env}: outside effects ${on ? "sent for real" : "previewed"}, set by ${by}`,
          )

          return previewLive(env)
        }),

        catalogFor: Effect.fn("WorkspaceDO.catalogFor")(function* (query: string, limit: number) {
          return yield* connections.notAdded(query, limit)
        }),

        connectionCount: Effect.fn("WorkspaceDO.connectionCount")(function* () {
          return yield* connections.count()
        }),

        findConnections: Effect.fn("WorkspaceDO.findConnections")(function* (
          person: string,
          origin: string,
          query: string,
          limit: number,
        ) {
          return yield* connections.find(
            yield* people.find(person),
            directory,
            origin,
            query,
            limit,
          )
        }),

        connections: Effect.fn("WorkspaceDO.connections")(function* (
          person: string,
          origin: string,
          only: string | undefined,
          listing?: Listing,
        ) {
          return yield* connections.view(
            yield* people.find(person),
            directory,
            origin,
            only,
            listing,
          )
        }),

        connectionCall: Effect.fn("WorkspaceDO.connectionCall")(function* (
          person: string,
          tool: string,
          input: Json,
          as: "workspace" | "me" | undefined,
          trace: string,
          origin: string,
        ) {
          return yield* connections
            .call(
              yield* people.find(person).pipe(Effect.orDie),
              tool,
              input,
              as,
              trace,
              directory,
              origin,
            )
            .pipe(Effect.annotateLogs({ trace }))
        }),

        pageTools: Effect.fn("WorkspaceDO.pageTools")(function* (
          workspace: WorkspaceName,
          name: string,
          env: string | undefined,
          viewer: Viewer | null,
          test: string | null,
          checkedBy: string | null,
          call: {
            readonly tool: string
            readonly input: Json
            readonly fields: ReadonlyArray<string> | undefined
          } | null,
          trace: string,
          origin: string,
          readonly: boolean,
        ) {
          const answer = (status: number, body: Readonly<Record<string, Json>>) => ({
            status,
            body: { ...body, trace },
          })

          const fail = (status: number, code: ErrorCode, error: string, fix: string) =>
            answer(status, { error, code, fix })

          const who = yield* pageWho(viewer, test, checkedBy)

          if (who.kind === "refused")
            return fail(
              403,
              "not_member",
              refusalOf(workspace, who.admission) ?? "",
              "Ask the workspace's admins to let you in",
            )

          if (who.kind === "person" && who.person !== null && (yield* hiddenFrom(name, who.person)))
            return fail(403, "private", privateApp(name, workspace), "Ask its owner to share it")

          const found = yield* Effect.result(callingApp(name, env))

          if (Result.isFailure(found))
            return fail(404, "missing", found.failure.message, "Deploy the app first")

          const calling = found.success
          const record = appDOs.getByName(calling.id)

          if (call === null) {
            const tools = yield* connections.listForApp(who, calling, directory, origin)

            return answer(200, { tools })
          }

          if (readonly && !(yield* connections.onlyReads(call.tool)))
            return fail(
              423,
              "check_readonly",
              `check_app is read-only (readonly: true), and ${call.tool} changes things (it isn't a read-only tool), so it wasn't sent`,
              "To check a call that changes things, run check_app with readonly: false, or in a preview environment",
            )

          const called = yield* connections
            .callForApp(who, calling, call.tool, call.input, trace, directory, origin)
            .pipe(Effect.annotateLogs({ trace }))

          const by = Match.value(who).pipe(
            Match.discriminatorsExhaustive("kind")({
              person: (p) => p.person.email,
              test_person: (t) => `${t.email} (a test person)`,
              signed_out: () => "a signed-out visitor",
            }),
          )

          if (called.kind === "refused") {
            yield* record.note(
              "warn",
              trace,
              `tools.call ${call.tool} refused for ${by} (${called.setting}): ${called.message}`,
            )

            const refusal = {
              error: called.message,
              code: called.code,
              fix: called.fix,
              setting: called.setting,
              tool: call.tool,
            }

            return answer(403, called.url === undefined ? refusal : { ...refusal, url: called.url })
          }

          if (called.kind === "failed") {
            yield* record.note(
              "error",
              trace,
              `tools.call ${call.tool} failed for ${by} after ${called.ms}ms: ${called.message}`,
            )

            return fail(
              502,
              "upstream_failed",
              `${call.tool}'s server didn't answer: ${called.message}`,
              "Try again; if it keeps failing, the connection's server may be down (the workspace's admins can check)",
            )
          }

          const runsAs = RUNS_AS[called.runsAs]

          yield* record.note(
            called.outcome === "ok" ? "info" : "warn",
            trace,
            `tools.call ${call.tool} ${called.outcome} in ${called.ms}ms for ${by}, with ${runsAs}${call.fields === undefined ? "" : `, fields ${call.fields.join(", ").slice(0, 200)}`}`,
          )

          const result = keepFields(called.result, call.fields)

          return answer(200, {
            tool: call.tool,
            outcome: called.outcome,
            runsAs: called.runsAs,
            ms: called.ms,
            content: result.content,
            structuredContent: result.structuredContent ?? null,
            isError: result.isError ?? false,
            text: textOf(result),
          })
        }),

        account: Effect.fn("WorkspaceDO.account")(function* (
          workspace: WorkspaceName,
          viewer: Viewer | null,
          ask: Ask | null,
          origin: string,
        ) {
          const who = yield* pageWho(viewer, null, null)

          if (who.kind === "refused")
            return {
              kind: "refused" as const,
              message: refusalOf(workspace, who.admission) ?? null,
            }

          if (who.kind !== "person") return { kind: "refused" as const, message: null }

          const person = who.person
          const views = yield* connections.view(person, directory, origin, undefined)

          const names = new Map(
            (yield* (yield* sql.exec<Row>(APPS)).toArray()).map((r) => [r.id, r.name]),
          )

          const consents = (yield* connections.consents(person.id)).map((c) => ({
            app: names.get(c.app) ?? "(an app since deleted)",
            connection: c.connection,
            tools: c.tools,
            granted: c.granted,
          }))

          // The connection asked about, and every account the app's openbelt.json binds to "viewer": its review page shows them all.
          const asking: { readonly asked: Asked | null; readonly accounts: ReadonlyArray<Asked> } =
            ask === null
              ? { asked: null, accounts: [] }
              : yield* Effect.gen(function* () {
                  const unasked = (problem: string) => ({
                    asked: { ...ask, problem, tools: [], consented: false },
                    accounts: [],
                  })

                  const calling = yield* Effect.result(callingApp(ask.app, ask.env))

                  if (Result.isFailure(calling)) return unasked(calling.failure.message)

                  const bound = calling.success

                  if (!views.some((v) => v.connection === ask.connection))
                    return unasked(`there's no connection "${ask.connection}" in ${workspace}`)

                  if (connections.viewerTools(bound.tools, ask.connection).length === 0)
                    return unasked(
                      `${ask.app} doesn't ask to use your ${ask.connection}: its openbelt.json binds none of its tools to "viewer"`,
                    )

                  const account = Effect.fnUntraced(function* (connection: string) {
                    const offered = views.find((v) => v.connection === connection)?.tools ?? []
                    const tools = connections.viewerTools(bound.tools, connection)
                    const granted = yield* connections.consentOf(person.id, bound.id, connection)

                    const shown: Asked = {
                      ...ask,
                      connection,
                      problem: null,
                      tools: tools.map((t) => ({
                        tool: `${connection}.${t}`,
                        description:
                          offered.find((v) => v.tool === `${connection}.${t}`)?.description ?? "",
                      })),
                      consented: granted !== undefined && tools.every((t) => granted.includes(t)),
                    }

                    return shown
                  })

                  const named = [
                    ...new Set(
                      Object.entries(bound.tools).flatMap(([qualified, binding]) =>
                        binding === "viewer" ? [qualified.split(".")[0] ?? ""] : [],
                      ),
                    ),
                  ].filter((name) => views.some((v) => v.connection === name))

                  const accounts = yield* Effect.forEach(named, account)

                  return {
                    asked:
                      accounts.find((a) => a.connection === ask.connection) ??
                      (yield* account(ask.connection)),
                    accounts,
                  }
                })

          const asks = (yield* connections.asks(person.id)).flatMap((a) => {
            const name = names.get(a.app)
            const view = views.find((v) => v.connection === a.connection)

            return name === undefined || view === undefined || view.level === "none"
              ? []
              : [{ app: name, connection: a.connection, asked: a.asked }]
          })

          const page: AccountData = {
            person: { email: person.email, name: person.name, role: person.role },
            connections: views,
            consents,
            asks,
            tokens: yield* people.tokensOf(person.id),
            signedIn: yield* oauth.signedIn(person.id),
            apps: (yield* appDirectory.page({
              q: "",
              sort: "name",
              offset: 0,
              limit: AGENT_APPS_LISTED,
            })).apps.map((a) => ({ name: a.name, owner: a.owner })),
            ask: asking.asked,
            accounts: asking.accounts,
            admins: yield* people.admins(),
            icons: yield* connections.icons(),
            whoHas: person.role === "admin" ? yield* whoHas() : {},
          }

          return { kind: "page" as const, page }
        }),

        connectionIcon: Effect.fn("WorkspaceDO.connectionIcon")(function* (
          viewer: Viewer | null,
          connection: string,
        ) {
          const who = yield* pageWho(viewer, null, null)

          return who.kind === "person" ? yield* connections.icon(connection) : undefined
        }),

        clientDocumented: Effect.fn("WorkspaceDO.clientDocumented")(function* (
          origin: string,
          registration: string,
        ) {
          return yield* connections.documents(origin, registration)
        }),

        signInReturned: Effect.fn("WorkspaceDO.signInReturned")(function* (
          workspace: WorkspaceName,
          viewer: Viewer | null,
          query: Readonly<Record<string, string>>,
          trace: string,
          origin: string,
          arrived: string,
        ) {
          const who = yield* pageWho(viewer, null, null)

          if (who.kind !== "person")
            return failed(
              `nobody is signed in to ${workspace} here, so there's no one to connect it for: open the sign-in link in a browser signed in to the workspace`,
            )

          const answer = Schema.decodeUnknownOption(SignInReturn)(query)

          if (Option.isNone(answer))
            return failed(
              "this isn't a sign-in coming back from a connection's server (it has no state): start with Connect on Connections",
            )

          const done = yield* Effect.result(
            connections
              .finishSignIn(who.person, answer.value, origin, arrived)
              .pipe(Effect.annotateLogs({ trace })),
          )

          if (Result.isFailure(done)) {
            yield* Effect.logInfo(
              `${who.person.email}: a sign-in didn't finish: ${done.failure.message}`,
            ).pipe(Effect.annotateLogs({ trace, workspace }))

            return failed(done.failure.message)
          }

          const { connection, back } = done.success
          const then = allowAfterSignIn(back, connection)

          if (then === undefined)
            return {
              ok: true as const,
              connection,
              back,
              allowed: false,
              message: done.success.message,
            }

          const allowed = yield* Effect.result(
            Effect.gen(function* () {
              const calling = yield* callingApp(then.app, then.env)
              const granted = yield* connections.grant(who.person, calling, connection, then.tools)
              const line = `allowed ${calling.name} to use their ${connection} token for ${granted.join(", ")}`

              yield* Effect.logInfo(`${workspace}: ${who.person.email} ${line} (settings)`).pipe(
                Effect.annotateLogs({ trace, workspace }),
              )
              yield* appDOs.getByName(calling.id).note("info", trace, `${who.person.email} ${line}`)
            }),
          )

          if (Result.isFailure(allowed))
            yield* Effect.logInfo(
              `${who.person.email}: connected ${connection}, but ${then.app} wasn't allowed: ${allowed.failure.message}`,
            ).pipe(Effect.annotateLogs({ trace, workspace }))

          const left = new URL(back, origin)

          left.searchParams.delete("next")
          left.searchParams.delete("tools")

          return {
            ok: true as const,
            connection,
            back: `${left.pathname}${left.search}`,
            allowed: Result.isSuccess(allowed),
            message: done.success.message,
          }
        }),

        accountAction: Effect.fn("WorkspaceDO.accountAction")(function* (
          workspace: WorkspaceName,
          viewer: Viewer | null,
          action: SettingsAction,
          fields: Readonly<Record<string, string>>,
          trace: string,
          origin: string,
        ) {
          const who = yield* pageWho(viewer, null, null)

          if (who.kind !== "person")
            return refusedNotice("nobody signed in here, so there's no account to change")

          const person = who.person

          if (isAdminAction(action))
            return yield* adminAction(workspace, person, action, fields, trace, origin)
          const field = (name: string) => fields[name] ?? ""
          const connection = field("connection")

          const log = (line: string) =>
            Effect.logInfo(`${workspace}: ${person.email} ${line} (settings)`).pipe(
              Effect.annotateLogs({ trace, workspace }),
            )

          const run: Effect.Effect<Notice, Refused> = Match.value(action).pipe(
            Match.when("token", () =>
              Effect.as(
                connections.setOwnToken(person, connection, field("token"), log, origin),
                doneNotice(`Your ${connectionLabel(connection)} token is set.`),
              ),
            ),
            Match.when("token/clear", () =>
              Effect.as(
                connections.setOwnToken(person, connection, undefined, log, origin),
                doneNotice(`Your ${connectionLabel(connection)} token is removed.`),
              ),
            ),
            Match.when("connect", () =>
              Effect.map(
                connections.startSignIn(
                  person,
                  connection,
                  field("whose") === "workspace" ? "workspace" : "me",
                  origin,
                  field("here"),
                  field("scope")
                    .split(/[\s,]+/)
                    .filter((s) => s !== ""),
                ),
                (started): Notice => ({ ...doneNotice("Signing in"), go: started.url }),
              ),
            ),
            Match.when("disconnect", () =>
              Effect.as(
                connections.disconnect(
                  person,
                  connection,
                  field("whose") === "workspace" ? "workspace" : "me",
                  log,
                  origin,
                ),
                doneNotice(
                  field("whose") === "workspace"
                    ? `${connectionLabel(connection)} is disconnected for the workspace.`
                    : `Your ${connectionLabel(connection)} is disconnected.`,
                ),
              ),
            ),
            Match.when("allow", () =>
              Effect.gen(function* () {
                const env = field("env")
                const calling = yield* callingApp(field("app"), env === "" ? undefined : env)

                // One Allow for every account on the app's review page: "connection" lists them, "tools:<connection>" each one's tools.
                const named = connection.split(",").filter((c) => c !== "")

                if (named.length === 0)
                  return refusedNotice("name the connections to allow (connection=github,linear)")

                const allowed = yield* Effect.forEach(named, (name) =>
                  Effect.gen(function* () {
                    const seen = field(`tools:${name}`)
                      .split(",")
                      .filter((t) => t !== "")

                    const granted = yield* connections.grant(person, calling, name, seen)
                    const line = `allowed ${calling.name} to use their ${name} token for ${granted.join(", ")}`

                    yield* log(line)
                    yield* appDOs
                      .getByName(calling.id)
                      .note("info", trace, `${person.email} ${line}`)

                    return `${connectionLabel(name)} for ${granted.join(", ")}`
                  }),
                )

                const labels =
                  allowed.length === 1
                    ? (allowed[0] ?? "")
                    : `${allowed.slice(0, -1).join(", ")} and ${allowed.at(-1) ?? ""}`

                return doneNotice(
                  `${calling.name} may use your ${labels} when you use it yourself: on its page, or through your agent.`,
                )
              }),
            ),
            Match.when("revoke", () =>
              Effect.gen(function* () {
                const record = yield* app(field("app"))

                if (record === null)
                  return refusedNotice(`there's no app "${field("app")}" in ${workspace}`)

                const gone = yield* connections.revokeConsent(person, record.id, connection)

                if (!gone)
                  return refusedNotice(
                    `${record.name} wasn't allowed your ${connectionLabel(connection)}`,
                  )

                const line = `took back ${record.name}'s use of their ${connection} token`

                yield* log(line)
                yield* appDOs.getByName(record.id).note("info", trace, `${person.email} ${line}`)

                return doneNotice(
                  `${record.name} can't use your ${connectionLabel(connection)} anymore.`,
                )
              }),
            ),
            Match.when("asks/dismiss", () =>
              Effect.gen(function* () {
                const record = yield* app(field("app"))

                if (record === null)
                  return refusedNotice(`there's no app "${field("app")}" in ${workspace}`)

                // Not now on an app's card: every account it asked for ("connection" lists them).
                const named = connection.split(",").filter((c) => c !== "")

                yield* Effect.forEach(named, (name) =>
                  Effect.andThen(
                    connections.dismissAsk(person, record.id, name),
                    log(`said not now to ${record.name}'s ask for their ${name}`),
                  ),
                )

                return doneNotice(
                  `Not now: ${record.name} asks again the next time its page needs your ${named.map((n) => connectionLabel(n)).join(" or ")}.`,
                )
              }),
            ),
            Match.when("mine/level", () =>
              Effect.gen(function* () {
                const level = Schema.decodeUnknownOption(Schema.Literals(["all", "read", "none"]))(
                  field("level"),
                )

                if (Option.isNone(level))
                  return refusedNotice("choose all, read or none for yourself")

                yield* connections.setOwn(person, connection, { level: level.value }, log)

                const label = connectionLabel(connection)

                return doneNotice(
                  Match.value(level.value).pipe(
                    Match.when("all", () => `${label}: everything your workspace gives you.`),
                    Match.when("read", () => `${label}: only the tools that read, for you.`),
                    Match.when(
                      "none",
                      () => `${label} is off for you. Turn it back on here any time.`,
                    ),
                    Match.exhaustive,
                  ),
                )
              }),
            ),
            Match.when("mine/tool", () =>
              Effect.gen(function* () {
                const on = field("on") === "true"

                yield* connections.setOwn(person, connection, { tool: field("tool"), on }, log)

                return doneNotice(`${connection}.${field("tool")} is ${on ? "on" : "off"} for you.`)
              }),
            ),
            Match.when("mine/ask", () =>
              Effect.gen(function* () {
                const want = Schema.decodeUnknownOption(Schema.Literals(["read", "all"]))(
                  field("want"),
                )

                const asked = yield* connections.askMore(
                  person,
                  connection,
                  Option.getOrUndefined(want),
                  field("note"),
                  directory,
                  origin,
                  log,
                )

                const admins = yield* people.admins()

                return doneNotice(
                  `Asked for ${asked.asked} on ${connectionLabel(connection)}. ${admins.length === 0 ? "The workspace's admins see" : `${admins.join(" and ")} ${admins.length === 1 ? "sees" : "see"}`} it on Access.`,
                )
              }),
            ),
            Match.when("mine/unask", () =>
              Effect.gen(function* () {
                yield* connections.unask(person, connection, log)

                return doneNotice(`Took back your ask for more on ${connectionLabel(connection)}.`)
              }),
            ),
            Match.when("tokens/create", () =>
              Effect.gen(function* () {
                const days = field("days") === "" ? undefined : Number(field("days"))
                const label = field("label").slice(0, 60)

                if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 365))
                  return yield* new Refused({ message: "a token lasts 1 to 365 days, or never" })

                const made = yield* people.makeToken(person, days, label)

                yield* log(`made a token (${made.id})`)

                const notice: Notice = {
                  ok: true,
                  message: "Your new token. Copy it now: it's shown once.",
                  made: { kind: "api", token: made.token, id: made.id, expires: made.expires },
                }

                return notice
              }),
            ),
            Match.when("tokens/revoke", () =>
              Effect.gen(function* () {
                yield* people.revokeToken(person, field("id"))
                yield* log(`revoked their token ${field("id")}`)

                return doneNotice(`Token ${field("id")} is revoked.`)
              }),
            ),
            Match.when("tokens/apps", () =>
              Effect.gen(function* () {
                const apps = yield* appsField(field("apps"))

                yield* people.setTokenApps(person.id, field("id"), apps)
                yield* log(
                  `set token ${field("id")}'s apps to ${apps === null ? "every app" : apps.join(", ") || "none"}`,
                )

                return doneNotice(appsNotice(apps))
              }),
            ),
            Match.when("signins/apps", () =>
              Effect.gen(function* () {
                const apps = yield* appsField(field("apps"))

                if ((yield* oauth.setApps(person.id, field("id"), apps)) === 0)
                  return yield* new Refused({
                    message: `there's no agent "${field("id")}" signed in as you: reload the page to see the ones there are`,
                  })

                yield* log(
                  `set sign-in ${field("id")}'s apps to ${apps === null ? "every app" : apps.join(", ") || "none"}`,
                )

                return doneNotice(appsNotice(apps))
              }),
            ),
            Match.when("signins/revoke", () =>
              Effect.gen(function* () {
                const name = field("name")

                const out = yield* oauth.signOut(
                  person.id,
                  field("id"),
                  `${person.email} signed it out in Settings`,
                )

                if (!out)
                  return yield* new Refused({
                    message: `there's no agent "${field("id")}" signed in as you: reload the page to see the ones there are`,
                  })

                yield* log(`signed out the agent ${field("id")} (${name})`)

                return doneNotice(
                  `Signed out ${name === "" ? field("id") : name}: its next request is refused.`,
                )
              }),
            ),
            Match.exhaustive,
          )

          return yield* run.pipe(
            Effect.catchTag("Refused", (e) => Effect.succeed(refusedNotice(e.message))),
          )
        }),

        workspacePage: Effect.fn("WorkspaceDO.workspacePage")(function* (
          viewer: Viewer | null,
          origin: string,
        ) {
          const who = yield* pageWho(viewer, null, null)
          const admins = yield* people.admins()

          if (who.kind !== "person" || who.person.role !== "admin")
            return { kind: "refused" as const, admins }

          const { everyone, levels } = yield* results()
          const statuses = yield* connections.statuses(origin)

          const page: WorkspaceData = {
            me: who.person.id,
            joining: people.joining(),
            asks: yield* joinAsks.pending(),
            scim: yield* people.scimStatus(10),
            people: everyone,
            groups: yield* people.groups(),
            connections: yield* Effect.forEach(levels, (l) =>
              Effect.map(
                Effect.orDie(Effect.fromNullishOr(statuses.get(l.connection))),
                (status) => ({ ...l, status }),
              ),
            ),
            registered: yield* connections.appsAt(),
            icons: yield* connections.icons(),
          }

          return { kind: "page" as const, page }
        }),

        eventsPage: Effect.fn("WorkspaceDO.eventsPage")(function* (
          viewer: Viewer | null,
          asked: EventsQuery,
        ) {
          const who = yield* pageWho(viewer, null, null)

          if (who.kind !== "person" || who.person.role !== "admin")
            return { kind: "refused" as const, admins: yield* people.admins() }

          const tools = yield* toolCalls.list({
            person: undefined,
            app: undefined,
            tool: undefined,
            outcome: undefined,
            limit: 5000,
          })

          const calls = yield* connections.activity(undefined, undefined, undefined, 500)

          const all: ReadonlyArray<WorkspaceEvent> = [
            ...tools.map((call) => ({ ...call, source: "tools" as const })),
            ...calls.map((call) => ({
              source: "connections" as const,
              at: new Date(call.at).toISOString(),
              tool: `${call.connection}.${call.tool}`,
              person: call.person,
              client: call.runs_as,
              app: call.app,
              trace: call.trace,
              outcome: call.outcome,
              ms: call.ms,
              args: "",
              error: call.why,
            })),
          ]

          const q = asked.q.toLowerCase()

          const filtered = all
            .filter(
              (event) =>
                (asked.source === "all" || event.source === asked.source) &&
                (asked.person === "" || event.person === asked.person) &&
                (asked.tool === "" || event.tool === asked.tool) &&
                (asked.app === "" || event.app === asked.app) &&
                (asked.outcome === "all" ||
                  (asked.outcome === "errors"
                    ? !["ok", "refused"].includes(event.outcome)
                    : event.outcome === asked.outcome)) &&
                [event.tool, event.person, event.client, event.app, event.trace].some((value) =>
                  value.toLowerCase().includes(q),
                ),
            )
            .toSorted((a, b) => b.at.localeCompare(a.at))

          const page = Math.min(asked.page, Math.max(0, Math.ceil(filtered.length / 50) - 1))

          const data: EventsData = {
            shown: { ...asked, page },
            events: filtered.slice(page * 50, (page + 1) * 50),
            total: filtered.length,
            retained: all.length,
            people: [...new Set(all.map((event) => event.person))],
            tools: [...new Set(all.map((event) => event.tool))],
            apps: [...new Set(all.map((event) => event.app))],
          }

          return { kind: "page" as const, page: data }
        }),

        asksPage: Effect.fn("WorkspaceDO.asksPage")(function* (viewer: Viewer | null) {
          const who = yield* pageWho(viewer, null, null)
          const admins = yield* people.admins()

          if (who.kind !== "person" || who.person.role !== "admin")
            return { kind: "refused" as const, admins }

          const page: AsksData = {
            groups: yield* connections.askGroups(yield* people.active(EVERYONE)),
          }

          return { kind: "page" as const, page }
        }),

        toolWarnings: Effect.fn("WorkspaceDO.toolWarnings")(function* (tools: AppTools) {
          return yield* connections.warnings(tools)
        }),

        apps: Effect.fn("WorkspaceDO.apps")(function* () {
          return yield* (yield* sql.exec<Row>(`${APPS} ORDER BY name`)).toArray()
        }),

        /** An app's entry in the workspace's directory, sent by the app itself (app.ts); none for a deleted app's id. */
        list: Effect.fn("WorkspaceDO.list")(function* (appId: string, entry: DirectoryEntry) {
          const [known] = yield* (yield* sql.exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM apps WHERE id = ?",
            appId,
          )).toArray()

          if ((known?.n ?? 0) > 0) yield* appDirectory.put(appId, entry)
        }),

        /** A page of the home page's gallery, and for an admin viewing it (`viewer`), who asked to join (joins.ts). */
        gallery: Effect.fn("WorkspaceDO.gallery")(function* (
          ask: PageAsk,
          shelf: number,
          viewer: string | null,
        ) {
          const page = yield* appDirectory.page(ask)
          const admin = viewer !== null && (yield* people.standing(viewer)).admin

          return {
            ...page,
            admin,
            asks: admin ? yield* joinAsks.pending() : [],
            recent: yield* appDirectory.recent(
              shelf,
              new Date(Date.now() - 7 * 86_400_000).toISOString(),
            ),
            jump: viewer === null ? [] : yield* appDirectory.openedBy(viewer, JUMP_BACK_IN),
            // The starters added here, for the Apps page's Starters tab and Just updated: in this call, not one more.
            starters: viewer === null ? {} : yield* startersHere(),
            taken: viewer === null ? {} : yield* startersTaken(),
          }
        }),

        /** That `person` (an email) opened one of an app's pages, sent by the app itself (app.ts): Jump back in. */
        appOpened: appDirectory.opened,

        findApps: appDirectory.find,
        appUsed: appDirectory.used,
        /** McpDO's record of one call to OpenBelt's own tools (tool-calls.ts). */
        toolCalled: toolCalls.record,
        /** The `limit` latest calls `person` made to OpenBelt's own tools, newest first: what feedback_submit keeps with a report. */
        recentToolCalls: (person: string, limit: number) =>
          toolCalls.list({ person, app: undefined, tool: undefined, outcome: undefined, limit }),
        /** The `limit` apps updated most recently, then the ones the directory has no time for (in preview only, or not entered yet). */
        recentApps: Effect.fn("WorkspaceDO.recentApps")(function* (limit: number) {
          const { apps } = yield* appDirectory.page({
            q: "",
            sort: "updated",
            offset: 0,
            limit,
          })

          return apps
        }),
        ownApps: appDirectory.ownedBy,
        /** A page of the workspace's apps for an agent: matching `q`, made by `owner`, in `sort` order, with how many there are. */
        appsPage: appDirectory.page,
        skilledApps: appDirectory.skilled,

        /** Whether anyone made this workspace: it has people (the first admin, a token's) or apps. A made-up name has neither. */
        inUse: Effect.fn("WorkspaceDO.inUse")(function* () {
          const [row] = yield* (yield* sql.exec<{ used: number }>(
            "SELECT EXISTS (SELECT 1 FROM people) OR EXISTS (SELECT 1 FROM apps) AS used",
          )).toArray()

          return row?.used === 1
        }),

        tokens: Effect.fn("WorkspaceDO.tokens")(function* () {
          const [row] = yield* (yield* sql.exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM api_tokens",
          )).toArray()

          return row?.n ?? 0
        }),

        app,
        describe,

        /** Room for `bytes` more of `appId`'s files, taken at once (so two uploads can't both fit in the last of it), or the workspace's use. */
        filesReserve: Effect.fn("WorkspaceDO.filesReserve")(function* (
          appId: string,
          bytes: number,
          limit: number,
        ) {
          const used = yield* filesUsed()

          if (limit > 0 && used + bytes > limit) return { ok: false as const, used }

          yield* sql.exec(
            "INSERT INTO file_usage (app_id, bytes) VALUES (?, ?) ON CONFLICT (app_id) DO UPDATE SET bytes = bytes + excluded.bytes",
            appId,
            bytes,
          )

          return { ok: true as const, used: used + bytes }
        }),

        dataReserve: Effect.fn("WorkspaceDO.dataReserve")(function* (
          appId: string,
          bytes: number,
          limit: number,
        ) {
          const [row] = yield* sql
            .exec<{ total: number; previous: number }>(
              "SELECT COALESCE(SUM(bytes), 0) AS total, COALESCE(MAX(CASE WHEN app_id = ? THEN bytes ELSE 0 END), 0) AS previous FROM data_usage",
              appId,
            )
            .pipe(Effect.flatMap((rows) => rows.toArray()))

          const total = (row?.total ?? 0) - (row?.previous ?? 0) + bytes

          if (limit > 0 && total > limit && bytes > (row?.previous ?? 0))
            return { ok: false, total }
          yield* sql.exec(
            "INSERT INTO data_usage (app_id, bytes) VALUES (?, ?) ON CONFLICT (app_id) DO UPDATE SET bytes = excluded.bytes",
            appId,
            bytes,
          )

          return { ok: true, total }
        }),

        dataUsage: Effect.fn("WorkspaceDO.dataUsage")(function* (appId: string, bytes: number) {
          yield* sql.exec(
            "INSERT INTO data_usage (app_id, bytes) VALUES (?, ?) ON CONFLICT (app_id) DO UPDATE SET bytes = excluded.bytes",
            appId,
            bytes,
          )

          const [row] = yield* (yield* sql.exec<{ n: number | null }>(
            "SELECT SUM(bytes) AS n FROM data_usage",
          )).toArray()

          return row?.n ?? 0
        }),

        /** `bytes` of `appId`'s files given back: an upload that didn't finish, or files deleted. */
        filesRelease: Effect.fn("WorkspaceDO.filesRelease")(function* (
          appId: string,
          bytes: number,
        ) {
          yield* sql.exec(
            "UPDATE file_usage SET bytes = MAX(0, bytes - ?) WHERE app_id = ?",
            bytes,
            appId,
          )
        }),

        /** Each app's files' bytes, most first, with the app's name. */
        filesUsage: Effect.fn("WorkspaceDO.filesUsage")(function* () {
          return yield* (yield* sql.exec<{ app: string; bytes: number }>(
            "SELECT COALESCE(apps.name, file_usage.app_id) AS app, file_usage.bytes AS bytes FROM file_usage LEFT JOIN apps ON apps.id = file_usage.app_id WHERE file_usage.bytes > 0 ORDER BY file_usage.bytes DESC",
          )).toArray()
        }),

        /** The apps `name`'s pages may read across: null for every app. */
        reachOf: Effect.fn("WorkspaceDO.reachOf")(function* (name: string) {
          const [row] = yield* (yield* sql.exec<{ reach: string | null }>(
            "SELECT reach FROM apps WHERE name = ?",
            name,
          )).toArray()

          return decodeAgentApps(row?.reach ?? null)
        }),

        /**
         * `name` for `user`: theirs already, or made theirs now. With `deploying` (deploy_app), `first` says this call is a first
         * deploy, its own or one at once with another: it must `settle`, so a refused one gives the name back.
         */
        claim: claimApp,

        /** A first deploy claim made has ended: `landed` unless it was refused. The last to end, with none landed, gives the name back. */
        settle: settleApp,

        addStarter,

        /** The apps here that are starters, by starter: { tasks: { app: "tasks", owner } }. */
        startersAdded: startersHere,
      }
    })
  }),
) {}

/** WorkspaceDO, reached only by a workspace's id (WorkspaceId): a stub asked for by a name is a type error. */
/** How many apps the home page's Jump back in shows: the ones the viewer opened last. */
const JUMP_BACK_IN = 6

/** How many apps the Agents page's picker lists (searched in the page). */
const AGENT_APPS_LISTED = 5000

/** The picker's apps field: "*" for every app, else the apps' names, a line each. */
const appsField = (text: string) =>
  text.trim() === "*"
    ? Effect.succeed<AgentApps>(null)
    : Schema.decodeUnknownEffect(AgentApps)(
        text
          .split("\n")
          .map((n) => n.trim())
          .filter((n) => n !== ""),
      ).pipe(
        Effect.mapError(
          () =>
            new Refused({
              message: "those aren't the apps' names: reload the page and pick again",
            }),
        ),
      )

const appsNotice = (apps: AgentApps) =>
  apps === null
    ? "It can use every app."
    : apps.length === 0
      ? "It can use no apps."
      : `It can use ${apps.length === 1 ? apps[0] : `${apps.length} apps`} and nothing else.`

export default Runtime.keyedBy<WorkspaceId>()(WorkspaceObject)
