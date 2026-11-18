// The base host (no workspace in its name) under OPENBELT_SIGNIN=email: where someone without a workspace starts. A person sees the
// marketing pages (www/) and Start building; an agent reads /auth.md and adds one MCP address for every workspace. Either signs in
// here with an email code (the base host's own sessions, apex.ts) and is asked which workspace: one they're in or invited to, or a
// new one they make (its first admin, invite-only). An agent's codes and tokens then carry their workspace (<workspace>~<token>), so this
// host's /mcp and /_oauth/token pass each to that workspace's own (oauth.ts, mcp.ts), which decide as they would on the workspace's host.
import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import ApexDO, {
  APEX,
  workspaceNameFor,
  workspaceNameProblem,
  slugOf,
  workDomainOf,
} from "./apex.ts"
import { cappedBody } from "./app.ts"
import {
  basicOf,
  bearer,
  byteRange,
  clientAddress,
  decodeAuthorize,
  fieldsOf,
  htmlOf,
  isString,
  json,
  markdown,
  WORKSPACE_PAGE,
  sameHost,
  wantsMarkdown,
  withOAuthCors,
} from "./http.ts"
import { type Json, type Workspace, WorkspaceId, WorkspaceName, type Viewer } from "./model.ts"
import { idOfNewWorkspace } from "./workspace-names.ts"
import { type AuthorizeRequest, challengeHeader, DEVICE_GRANT, metadataOf } from "./oauth.ts"
import { deviceRoute } from "./device.ts"
import WorkspaceDO from "./workspace.ts"
import type { sessions } from "./session.ts"
import {
  claimPage,
  type Membership,
  type WorkspacePick,
  workspacePickPage,
  outcomePage,
  refusedPage,
  signInPage,
} from "./settings.ts"
import { GOOGLE } from "./google.ts"
import { TRIALS, TRIALS_PER_HOUR, trialName } from "./trials.ts"
import { authMd, homeMd, llmsTxt, startMd, tellYourHuman, wwwFile } from "./welcome.ts"
import { agentOfUserAgent, funnel, keepSource } from "./funnel.ts"
import { agentOf, clientNameIn } from "./tool-calls.ts"

type Answer = HttpServerResponse.HttpServerResponse

/** What the gateway lends this host: who is viewing, its sign-in pages and MCP, and whether a workspace exists. */
type BaseDeps = {
  readonly session: ReturnType<typeof sessions>
  readonly viewerOf: (
    inPreview: boolean,
    onHost: string,
  ) => Effect.Effect<
    { readonly viewer: Viewer | null; readonly session: string | null },
    never,
    HttpServerRequest
  >
  readonly signIn: (url: URL, trace: string) => Effect.Effect<Answer, unknown, HttpServerRequest>
  readonly mcp: (
    workspace: Workspace,
    workspaceOrigin: string,
    url: URL,
    trace: string,
    token: string,
  ) => Effect.Effect<Answer, unknown, HttpServerRequest>
  readonly workspaceExists: (workspace: Workspace) => Effect.Effect<boolean>
  /** The workspace a name is for (workspace-names.ts): an old name gives the renamed workspace, a name never used a workspace made under it. */
  readonly workspaceNamed: (name: WorkspaceName) => Effect.Effect<Workspace>
  /** A workspace's own host, from a request to this one (same scheme and port). */
  readonly workspaceOrigin: (url: URL, workspace: Workspace) => string
}

/** The base host's sign-in pages: email and code, and signing out (no links an admin made: those are a workspace's). */
const SIGN_IN = /^\/(_signin(\/(code|google|google\/callback|google\/other))?|_signout)$/

const OAUTH =
  /^\/(_oauth\/(authorize|token|register|revoke|device|device_authorization)|\.well-known\/oauth-(protected-resource(\/mcp)?|authorization-server))$/

/** A token or code this host gave out: the workspace it was made in (its id), then that workspace's own (`acme~pra_...`). */
const WORKSPACE_TOKEN = /^([a-z0-9][a-z0-9-]{0,62})~(pr[acr]_[A-Za-z0-9_-]+)$/

const decodeName = Schema.decodeUnknownOption(WorkspaceName)

const workspaceToken = (presented: string) => {
  const m = WORKSPACE_TOKEN.exec(presented)
  const label = m === null ? undefined : Option.getOrUndefined(decodeName(m[1]))

  return m === null || label === undefined ? undefined : { label, token: m[2] ?? "" }
}

const decodeWorkspaces = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ workspace: WorkspaceId, name: WorkspaceName })),
)

/** ApexDO's rows (a workspace's id and current name, as RPC sends them: unchecked) as workspaces. */
const workspacesOfRows = (
  rows: ReadonlyArray<{ readonly workspace: string; readonly name: string }>,
) => decodeWorkspaces(rows).map((r): Workspace => ({ id: r.workspace, name: r.name }))

const oauthJson = (body: Readonly<Record<string, Json>>, status = 200) =>
  withOAuthCors(
    HttpServerResponse.jsonUnsafe(body, {
      status,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    }),
  )

/** What the workspace picker's form chose: a workspace to go on in, or a problem to show the page again with. */
type Decided =
  | { readonly kind: "workspace"; readonly workspace: Workspace }
  | { readonly kind: "again"; readonly problem: string; readonly name: string | null }
  | {
      readonly kind: "asked"
      readonly workspace: Workspace
      readonly admins: ReadonlyArray<string>
    }

/** Who has to invite someone who asked to join: the workspace's admins, by name. */
const whoInvites = (asked: {
  readonly workspace: Workspace
  readonly admins: ReadonlyArray<string>
}) =>
  asked.admins.length === 0 ? `an admin of ${asked.workspace.name}` : asked.admins.join(" or ")

const refusedHere = (title: string, message: string, trace: string, status: number) =>
  htmlOf(refusedPage(title, message, trace), { status, headers: WORKSPACE_PAGE })

const go = (location: string) =>
  HttpServerResponse.redirect(location, { status: 303, headers: { "cache-control": "no-store" } })

/** An agent's sign-in link on this host (/_oauth/authorize) as the request it makes, or none when it's malformed. */
export const authorizeRequestOf = (url: URL) =>
  Option.map(decodeAuthorize(Object.fromEntries(url.searchParams)), (q): AuthorizeRequest => ({
    responseType: q.response_type ?? "",
    clientId: q.client_id ?? "",
    redirectUri: q.redirect_uri ?? "",
    state: q.state,
    scope: q.scope,
    challenge: q.code_challenge ?? "",
    challengeMethod: q.code_challenge_method ?? "",
    resource:
      q.resource === undefined
        ? undefined
        : { url: q.resource, ours: q.resource.replace(/\/$/, "") === `${url.origin}/mcp` },
  }))

/** Whether two sign-in links ask for the same thing: the one someone allowed while signing in, and the one they came back to. */
const sameRequest = (a: AuthorizeRequest, b: AuthorizeRequest) =>
  a.responseType === b.responseType &&
  a.clientId === b.clientId &&
  a.redirectUri === b.redirectUri &&
  a.state === b.state &&
  a.scope === b.scope &&
  a.challenge === b.challenge &&
  a.challengeMethod === b.challengeMethod &&
  a.resource?.url === b.resource?.url

/** The sign-in pages' query parameter that says the agent was allowed there (its handle, apex.ts oauthPend). */
export const ALLOWED_PARAM = "allowed"

/** An agent's sign-in back to it: the answer's parameters, its state, and who answered (RFC 9207). */
const backTo = (
  asked: AuthorizeRequest,
  origin: string,
  params: Readonly<Record<string, string>>,
) => {
  const to = new URL(asked.redirectUri)

  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v)

  if (asked.state !== undefined) to.searchParams.set("state", asked.state)

  to.searchParams.set("iss", origin)

  return go(to.toString())
}

const remember = (answer: Answer, viewer: Viewer, workspace: Workspace) =>
  HttpServerResponse.setHeader(
    answer,
    "set-cookie",
    `__Host-openbelt_last_workspace=${encodeURIComponent(JSON.stringify({ email: viewer.email, workspace: workspace.id }))}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  )

/** A trial's claim link's path: the workspace, then its code (`/claim/t-k3x9qa~<code>`). */
const CLAIM = /^\/claim\/([a-z0-9][a-z0-9-]{0,62})~([0-9a-f]{32})$/

export const openBase = Effect.fn("Base.open")(function* (deps: BaseDeps) {
  const workspaces = yield* WorkspaceDO
  const apex = (yield* ApexDO).getByName(APEX)
  const trials = (yield* TRIALS) === "on"
  const google = (yield* GOOGLE.pipe(Effect.orDie)) !== null

  /**
   * The workspaces `email` can open (in it or invited), from the base host's index, each asked where they stand now; and the workspaces made
   * for their work domain they aren't in, where they can ask to be let in.
   */
  const choicesOf = Effect.fnUntraced(function* (email: string) {
    const candidates = workspacesOfRows(yield* apex.workspacesOf(email))

    const standings = yield* Effect.forEach(
      candidates,
      (workspace) =>
        Effect.map(workspaces.getByName(workspace.id).standing(email), (standing) => ({
          workspace,
          standing,
        })),
      { concurrency: 8 },
    )

    const open = standings.flatMap(({ workspace, standing }) => {
      const membership = Match.value(standing.status).pipe(
        Match.when("active", (): Membership => ({ kind: "in" })),
        Match.when("invited", (): Membership => ({ kind: "invited", by: standing.invitedBy })),
        Match.orElse(() => null),
      )

      return membership === null ? [] : [{ workspace, standing, membership }]
    })

    const domain = workDomainOf(email)
    const made = domain === null ? [] : yield* apex.madeFor(domain)
    const creators = new Map(made.map((o) => [o.workspace, o.creator]))

    const colleagues = workspacesOfRows(made).flatMap((workspace) =>
      candidates.some((c) => c.id === workspace.id) || domain === null
        ? []
        : [{ workspace, creator: creators.get(workspace.id) ?? "", domain }],
    )

    return { open, colleagues }
  })

  /** A name for someone's new workspace nobody has: theirs (workspaceNameFor), or with -2, -3... after it. */
  const freeName = Effect.fnUntraced(function* (base: string) {
    for (let n = 1; n < 10; n++) {
      const name = n === 1 ? base : `${base}-${n}`

      const free = Option.getOrUndefined(decodeName(name))

      if (free !== undefined && !(yield* deps.workspaceExists(yield* deps.workspaceNamed(free))))
        return name
    }

    return `${base}-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) ?? "1"}`
  })

  const pickPage = Effect.fnUntraced(function* (
    viewer: Viewer,
    asking: WorkspacePick["asking"],
    problem: string | null,
    name: string | null,
    url: URL,
  ) {
    const choices = yield* choicesOf(viewer.email)

    return htmlOf(
      workspacePickPage({
        asking,
        person: viewer,
        workspaces: choices.open.map((o) => ({
          ...o,
          origin: deps.workspaceOrigin(url, o.workspace),
        })),
        colleagues: choices.colleagues,
        name:
          name === null
            ? { kind: "suggested", value: yield* freeName(workspaceNameFor(viewer.email)) }
            : { kind: "retry", value: name },
        problem,
        formToken: yield* deps.session.formToken(viewer.email, url.host),
      }),
      { status: problem === null ? 200 : 400, headers: WORKSPACE_PAGE },
    )
  })

  /** What the workspace picker's form chose: a workspace they can open, or a new one they make now (its first admin). */
  const decide = Effect.fnUntraced(function* (
    viewer: Viewer,
    fields: Readonly<Record<string, string>>,
    trace: string,
  ) {
    const choice = fields["choice"] ?? ""

    if (choice === "create") {
      const typed = fields["name"] ?? ""
      const slug = slugOf(typed)
      const name = Option.getOrUndefined(decodeName(slug))

      if (name === undefined)
        return {
          kind: "again",
          problem: workspaceNameProblem(typed, slug) ?? `"${typed}" can't be a workspace name`,
          name: typed,
        } satisfies Decided

      const workspace = yield* deps.workspaceNamed(name)

      // A name another workspace has or had (workspace-names.ts) is that workspace's: exists, and the directory refuses the claim too (apex.ts).
      const made =
        !(yield* deps.workspaceExists(workspace)) &&
        (yield* apex.claim(name, viewer)) &&
        (yield* workspaces.getByName(idOfNewWorkspace(name)).found(viewer))

      if (!made)
        return {
          kind: "again",
          problem: `${name} is taken: pick another name.`,
          name: yield* freeName(name),
        } satisfies Decided

      yield* Effect.logInfo(`base host: ${viewer.email} made the workspace ${name}`).pipe(
        Effect.annotateLogs({ trace, workspace: workspace.id }),
      )

      yield* funnel("workspace", undefined, trace, { email: viewer.email, detail: `made ${name}` })

      return { kind: "workspace", workspace } satisfies Decided
    }

    const choices = yield* choicesOf(viewer.email)

    if (choice.startsWith("ask:")) {
      const asked = choices.colleagues.find(
        (o) => o.workspace.id === choice.slice("ask:".length),
      )?.workspace

      if (asked === undefined)
        return {
          kind: "again",
          problem: "Pick one of the workspaces shown.",
          name: null,
        } satisfies Decided

      const admins = yield* workspaces.getByName(asked.id).askToJoin(viewer.email)

      yield* Effect.logInfo(`base host: ${viewer.email} asked to join ${asked.name}`).pipe(
        Effect.annotateLogs({ trace, workspace: asked.id }),
      )

      return { kind: "asked", workspace: asked, admins } satisfies Decided
    }

    const picked = choice.startsWith("workspace:")
      ? choices.open.find((o) => o.workspace.id === choice.slice("workspace:".length))?.workspace
      : undefined

    if (picked === undefined)
      return {
        kind: "again",
        problem: "Pick one of the workspaces shown.",
        name: null,
      } satisfies Decided

    return { kind: "workspace", workspace: picked } satisfies Decided
  })

  /** A form posted to this host: from its own page (same origin), by whoever the page was made for (its form token). */
  const formOf = Effect.fnUntraced(function* (url: URL, viewer: Viewer | null) {
    const request = yield* HttpServerRequest
    const from = request.headers["origin"]

    if (
      request.headers["sec-fetch-site"] !== "same-origin" ||
      from === undefined ||
      !sameHost(from, url.origin) ||
      viewer === null
    )
      return undefined

    const body = yield* cappedBody(request, 20_000)

    if (body.kind !== "read") return undefined

    const fields = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body.bytes)))

    return fields["form"] === (yield* deps.session.formToken(viewer.email, url.host))
      ? fields
      : undefined
  })

  const authorize = Effect.fn("base.authorize")(function* (url: URL, trace: string) {
    const request = yield* HttpServerRequest
    const origin = url.origin
    const { viewer } = yield* deps.viewerOf(false, url.host)

    if (request.method === "GET") {
      if (viewer === null)
        return HttpServerResponse.redirect(
          `/_signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
          { status: 302, headers: { "cache-control": "no-store" } },
        )

      const decoded = authorizeRequestOf(url)

      if (Option.isNone(decoded))
        return refusedHere(
          "Can't sign in",
          "This sign-in link is malformed: start again from your agent.",
          trace,
          400,
        )

      const asked = decoded.value

      const checked = yield* apex.oauthCheck(asked, origin)

      if (checked.kind === "redirect") return go(checked.location)

      if (checked.kind === "page") return refusedHere(checked.title, checked.message, trace, 400)

      // Allowed on the sign-in page (Continue there was Allow): with one workspace to put the agent in, it's done without asking again.
      const allowed = url.searchParams.get(ALLOWED_PARAM)
      const was = allowed === null ? null : yield* apex.oauthTake(allowed, viewer.email)

      if (was !== null && sameRequest(was, asked)) {
        const only = yield* onlyWorkspace(viewer, trace)

        if (only !== null) return yield* issue(viewer, asked, only, origin, trace)
      }

      yield* funnel("authorize", url, trace, {
        email: viewer.email,
        agent: agentOf(checked.client.name, ""),
      })

      return yield* pickPage(
        viewer,
        {
          kind: "agent",
          client: checked.client,
          redirectHost: checked.redirectHost,
          userCode: checked.userCode,
          handle: yield* apex.oauthPend(viewer.email, asked),
        },
        null,
        null,
        url,
      )
    }

    if (request.method !== "POST")
      return refusedHere("Not here", "GET this page from your agent's sign-in link.", trace, 405)

    const fields = yield* formOf(url, viewer)

    if (fields === undefined || viewer === null)
      return refusedHere(
        "Refused",
        "This choice didn't come from OpenBelt's own page, or the page was made for someone else, so nothing was allowed. Start again from your agent.",
        trace,
        403,
      )

    const asked = yield* apex.oauthTake(fields["handle"] ?? "", viewer.email)

    if (asked === null)
      return refusedHere(
        "This sign-in page was used",
        "Each sign-in page answers once, within 10 minutes: start again from your agent.",
        trace,
        400,
      )

    if (fields["decision"] !== "allow")
      return backTo(asked, origin, {
        error: "access_denied",
        error_description: "the person didn't allow it",
      })

    const decided = yield* decide(viewer, fields, trace)

    if (decided.kind === "again") {
      const checked = yield* apex.oauthCheck(asked, origin)

      if (checked.kind !== "consent")
        return refusedHere("Can't sign in an agent", decided.problem, trace, 400)

      return yield* pickPage(
        viewer,
        {
          kind: "agent",
          client: checked.client,
          redirectHost: checked.redirectHost,
          userCode: checked.userCode,
          handle: yield* apex.oauthPend(viewer.email, asked),
        },
        decided.problem,
        decided.name,
        url,
      )
    }

    // The agent is waiting on this sign-in: end it, saying who has to let them in, so it can tell its person.
    if (decided.kind === "asked")
      return backTo(asked, origin, {
        error: "access_denied",
        error_description: `asked to join ${decided.workspace.name}: ${whoInvites(decided)} must invite ${viewer.email}, then sign in again`,
      })

    return yield* issue(viewer, asked, decided.workspace, origin, trace)
  })

  /**
   * The one workspace an agent allowed on the sign-in page goes in, with nothing to choose: the only one they're in, or, in none and
   * with no colleague's to ask to join, a new one named for them (its first admin, as Create on the picker makes it). Anything else
   * (an invite, a colleague's workspace, two of their own) is theirs to pick: null.
   */
  const onlyWorkspace = Effect.fnUntraced(function* (viewer: Viewer, trace: string) {
    const choices = yield* choicesOf(viewer.email)
    const [one, ...more] = choices.open

    if (one !== undefined)
      return one.membership.kind === "in" && more.length === 0 ? one.workspace : null

    if (choices.colleagues.length > 0) return null

    const made = yield* decide(
      viewer,
      { choice: "create", name: yield* freeName(workspaceNameFor(viewer.email)) },
      trace,
    )

    return made.kind === "workspace" ? made.workspace : null
  })

  /** The agent signed in to `workspace`, as `viewer`: its code, back to it. */
  const issue = Effect.fnUntraced(function* (
    viewer: Viewer,
    asked: AuthorizeRequest,
    workspace: Workspace,
    origin: string,
    trace: string,
  ) {
    // A device sign-in is kept here, not in the workspace: checked still waiting, its code goes to the workspace with it.
    const still = yield* apex.oauthCheck(asked, origin)

    if (still.kind !== "consent")
      return still.kind === "page"
        ? refusedHere(still.title, still.message, trace, 400)
        : go(still.location)

    const client = yield* apex.oauthClient(asked.clientId)

    const issued = yield* workspaces
      .getByName(workspace.id)
      .oauthIssue(
        workspace.name,
        { ...asked, resource: undefined },
        origin,
        viewer,
        client,
        still.userCode,
      )

    if (issued.kind === "page") return refusedHere(issued.title, issued.message, trace, 400)

    if (issued.kind === "refused") {
      if (still.userCode !== null)
        yield* apex.oauthDeviceDone(asked.state ?? "", { refused: issued.message })

      return refusedHere("Can't sign in an agent", issued.message, trace, 403)
    }

    const to = new URL(issued.location)
    const code = to.searchParams.get("code")

    // The workspace's id: a code (and the tokens it gives) still reaches the workspace after a rename.
    if (code !== null) to.searchParams.set("code", `${workspace.id}~${code}`)

    yield* Effect.logInfo(
      `base host: ${viewer.email} signed an agent in to ${workspace.name}`,
    ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

    yield* funnel("agent_signed_in", undefined, trace, {
      email: viewer.email,
      agent: agentOf(client?.name ?? "", ""),
    })

    return go(to.toString())
  })

  /** /_oauth/token, /register and /revoke: registered here; a code or token goes to the workspace it names. */
  const oauth = Effect.fn("base.oauth")(function* (url: URL, path: string, trace: string) {
    const request = yield* HttpServerRequest
    const origin = url.origin

    if (request.method === "OPTIONS")
      return withOAuthCors(HttpServerResponse.empty({ status: 204 }))

    if (path.startsWith("/.well-known/")) {
      const metadata = metadataOf(origin, "every workspace")

      return oauthJson(
        path === "/.well-known/oauth-authorization-server"
          ? metadata.server
          : {
              ...metadata.resource,
              resource_name: "OpenBelt",
              resource_documentation: `${origin}/auth.md`,
            },
      )
    }

    if (path === "/_oauth/authorize") return yield* authorize(url, trace)

    if (path === "/_oauth/device")
      return yield* deviceRoute(url, {
        find: (typed, issuer) => apex.oauthDeviceFind(typed, issuer),
        done: (state, outcome) => apex.oauthDeviceDone(state, outcome),
      })

    if (request.method !== "POST")
      return oauthJson({ error: "invalid_request", error_description: `POST ${path}` }, 405)

    const body = yield* cappedBody(request, 20_000)

    if (body.kind !== "read")
      return oauthJson(
        { error: "invalid_request", error_description: "the body is over 20 KB, or cut off" },
        400,
      )

    const text = new TextDecoder().decode(body.bytes)

    if (path === "/_oauth/register") {
      const made = yield* apex.oauthRegister(text)

      yield* Effect.logInfo(
        made.ok
          ? `base host oauth: a client registered (${made.id}, ${made.name})`
          : `base host oauth: a registration was refused: ${made.description}`,
      ).pipe(Effect.annotateLogs({ trace }))

      return made.ok
        ? oauthJson(made.body, 201)
        : oauthJson({ error: made.error, error_description: made.description }, made.status)
    }

    const form = fieldsOf(text, request.headers["content-type"])
    const basic = basicOf(request.headers["authorization"])

    if (path === "/_oauth/device_authorization") {
      const started = yield* apex.oauthDeviceStart(form, basic, origin)

      yield* Effect.logInfo(
        `base host oauth: a device sign-in ${started.status === 200 ? "started" : "was refused"}`,
      ).pipe(Effect.annotateLogs({ trace }))

      return oauthJson(started.body, started.status)
    }

    if (path === "/_oauth/revoke") {
      const named = workspaceToken(form["token"] ?? "")
      const workspace = named === undefined ? undefined : yield* deps.workspaceNamed(named.label)

      if (
        named !== undefined &&
        workspace !== undefined &&
        (yield* deps.workspaceExists(workspace))
      )
        yield* workspaces
          .getByName(workspace.id)
          .oauthRevoke(named.token, basic?.id ?? form["client_id"] ?? "")

      return withOAuthCors(HttpServerResponse.empty({ status: 200 }))
    }

    const resource = form["resource"]

    if (resource !== undefined && resource.replace(/\/$/, "") !== `${origin}/mcp`)
      return oauthJson(
        {
          error: "invalid_target",
          error_description: `${resource} isn't this host's MCP server: tokens here are for ${origin}/mcp only`,
        },
        400,
      )

    // A device code, once approved, stands for the authorization code its approval made: a workspace's, traded there as one.
    const polled =
      form["grant_type"] === DEVICE_GRANT ? yield* apex.oauthDevicePoll(form, basic) : undefined

    if (polled?.kind === "answer") return oauthJson(polled.answer.body, polled.answer.status)

    const fields =
      polled === undefined
        ? form
        : {
            ...form,
            grant_type: "authorization_code",
            code: polled.code,
            code_verifier: polled.verifier,
          }

    const refresh = fields["grant_type"] === "refresh_token"
    const named = workspaceToken((refresh ? fields["refresh_token"] : fields["code"]) ?? "")
    const workspace = named === undefined ? undefined : yield* deps.workspaceNamed(named.label)

    if (named === undefined || workspace === undefined || !(yield* deps.workspaceExists(workspace)))
      return oauthJson(
        {
          error: "invalid_grant",
          error_description: `that ${refresh ? "refresh token" : "code"} isn't one ${origin} gave out`,
        },
        400,
      )

    const answer = yield* workspaces
      .getByName(workspace.id)
      .oauthToken(
        { ...fields, ...(refresh ? { refresh_token: named.token } : { code: named.token }) },
        basic,
        origin,
      )

    yield* Effect.logInfo(
      `base host oauth: ${fields["grant_type"] ?? ""} for ${workspace.name}: ${answer.status}`,
    ).pipe(Effect.annotateLogs({ trace, workspace: workspace.id }))

    if (answer.status !== 200) return oauthJson(answer.body, answer.status)

    const withWorkspace = (value: Json | undefined) =>
      isString(value) ? `${workspace.id}~${value}` : (value ?? null)

    return oauthJson({
      ...answer.body,
      access_token: withWorkspace(answer.body["access_token"]),
      refresh_token: withWorkspace(answer.body["refresh_token"]),
    })
  })

  /** /mcp here: a token this host gave out goes to its workspace's MCP; anything else is told to sign in (and how). */
  const mcp = Effect.fn("base.mcp")(function* (url: URL, trace: string) {
    const request = yield* HttpServerRequest
    const presented = bearer(request.headers["authorization"])
    const named = presented === undefined ? undefined : workspaceToken(presented)
    const workspace = named === undefined ? undefined : yield* deps.workspaceNamed(named.label)

    if (named !== undefined && workspace !== undefined && (yield* deps.workspaceExists(workspace)))
      return yield* deps.mcp(
        workspace,
        deps.workspaceOrigin(url, workspace),
        url,
        trace,
        named.token,
      )

    if (presented === undefined) {
      const body = request.method === "POST" ? yield* cappedBody(request, 20_000) : undefined
      const client = body?.kind === "read" ? clientNameIn(new TextDecoder().decode(body.bytes)) : ""

      yield* funnel("mcp", url, trace, {
        agent: client !== "" ? client : agentOfUserAgent(request.headers["user-agent"]),
      })
    }

    const tell = `${tellYourHuman(url.origin, "OpenBelt")}. Signing in there picks the workspace, or makes one.`

    const why =
      presented === undefined
        ? undefined
        : `that token isn't one ${url.origin} gave out: an API token works only at its workspace's own /mcp (https://<workspace>.<host>/mcp, the mcp_url token_create answered with)`

    return HttpServerResponse.setHeader(
      json(
        { error: why === undefined ? tell : `${why}. ${tell}`, code: "unauthorized", trace },
        401,
      ),
      "www-authenticate",
      challengeHeader(url.origin, why),
    )
  })

  const rememberedWorkspace = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ email: Schema.String, workspace: WorkspaceId })),
  )

  /** Start building, in the browser: sign in, pick or make the workspace, and go to it. */
  const start = Effect.fn("base.start")(function* (url: URL, trace: string) {
    const request = yield* HttpServerRequest
    const { viewer, session } = yield* deps.viewerOf(false, url.host)
    const switching = url.searchParams.get("switch") === "1"

    if (request.method === "GET" && !switching) {
      const visit = yield* funnel("start", url, trace, { viewer: viewer?.email })

      if (viewer === null)
        return keepSource(
          go(`/_signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`),
          visit,
        )
    }

    if (viewer === null)
      return go(`/_signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`)

    if (request.method === "GET" && !switching) {
      const choices = yield* choicesOf(viewer.email)

      const saved = Option.getOrUndefined(
        rememberedWorkspace(request.cookies["__Host-openbelt_last_workspace"] ?? ""),
      )

      const last =
        (session === null ? null : yield* apex.browserLast(session)) ??
        (saved?.email === viewer.email ? saved.workspace : null)

      const selected =
        choices.open.find((o) => o.workspace.id === last) ??
        (choices.open.length === 1 ? choices.open[0] : undefined)

      if (selected !== undefined) {
        if (selected.standing.status === "active")
          return go(
            `${deps.workspaceOrigin(url, selected.workspace)}/?open=${encodeURIComponent(yield* deps.session.formToken(viewer.email, url.host))}`,
          )
      }
    }

    const current =
      Option.getOrNull(Schema.decodeUnknownOption(WorkspaceId)(url.searchParams.get("current"))) ??
      (session === null ? null : yield* apex.browserLast(session))

    if (request.method === "GET" || request.method === "HEAD")
      return yield* pickPage(viewer, { kind: "browser", current }, null, null, url)

    const fields = yield* formOf(url, viewer)

    if (fields === undefined)
      return refusedHere(
        "Refused",
        "This choice didn't come from OpenBelt's own page, so nothing happened. Start again from the OpenBelt page.",
        trace,
        403,
      )

    const decided = yield* decide(viewer, fields, trace)

    if (decided.kind === "again")
      return yield* pickPage(
        viewer,
        { kind: "browser", current },
        decided.problem,
        decided.name,
        url,
      )

    if (decided.kind === "asked")
      return htmlOf(
        outcomePage({
          ok: true,
          title: `Asked to join ${decided.workspace.name}`,
          message: `${whoInvites(decided)} must invite you; they see your ask on ${decided.workspace.name}'s home page. Once they have, open ${deps.workspaceOrigin(url, decided.workspace)} and sign in.`,
        }),
        { headers: WORKSPACE_PAGE },
      )

    if (session !== null) yield* apex.browserVisit(session, decided.workspace.id)

    return remember(
      go(`${deps.workspaceOrigin(url, decided.workspace)}/_signin/carry`),
      viewer,
      decided.workspace,
    )
  })

  /**
   * A workspace's host asks for this browser's sign-in here (its /_signin/carry gave the browser a nonce): a one-time ticket the workspace
   * makes for them, for that host and nonce, if they may sign in there. The workspace's host takes it at /_signin/return.
   */
  const carry = Effect.fn("base.carry")(function* (url: URL, trace: string) {
    const { viewer, session } = yield* deps.viewerOf(false, url.host)
    const asked = url.searchParams.get("workspace") ?? ""
    const name = Option.getOrUndefined(decodeName(asked))
    const attempt = url.searchParams.get("attempt") ?? ""
    const next = url.searchParams.get("next") ?? "/"

    if (viewer === null)
      return go(`/_signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`)

    const workspace = name === undefined ? undefined : yield* deps.workspaceNamed(name)

    if (workspace === undefined || !(yield* deps.workspaceExists(workspace)))
      return refusedHere(
        "No such workspace",
        `Nobody has made a workspace called ${asked} here.`,
        trace,
        404,
      )

    const there = deps.workspaceOrigin(url, workspace)

    const parent = session === null ? null : yield* apex.browserVisit(session, workspace.id)

    if (parent === null) return go(`${there}/`)

    const ticket = yield* workspaces
      .getByName(workspace.id)
      .loginCarry(viewer.email, new URL(there).host, attempt, parent)

    if (ticket === null)
      return htmlOf(
        outcomePage({
          ok: false,
          title: "You don't have access",
          message: `You're signed in as ${viewer.email}, but can't open ${workspace.name}. Ask an admin to invite you, or choose another workspace at ${url.origin}/_start?switch=1.`,
        }),
        { status: 403, headers: WORKSPACE_PAGE },
      )

    return remember(
      go(
        `${there}/_signin/return?${new URLSearchParams({ ticket, to: next, appAttempt: url.searchParams.get("appAttempt") ?? "" }).toString()}`,
      ),
      viewer,
      workspace,
    )
  })

  /** A trial workspace for an agent with no account (trials.ts): at most TRIALS_PER_HOUR an hour from one address. */
  const startTrial = Effect.fn("base.startTrial")(function* (url: URL, trace: string) {
    const request = yield* HttpServerRequest
    const origin = url.origin

    const address = clientAddress(request.headers, Option.getOrUndefined(request.remoteAddress))

    const allowed = yield* apex.trialAllow(address, TRIALS_PER_HOUR)

    if (!allowed.ok)
      return HttpServerResponse.setHeader(
        json(
          {
            error: `${TRIALS_PER_HOUR} trial workspaces an hour from one address. Reuse the trial you have (its token and claim_url, in ./.openbelt/trial.json if you saved it). Don't build somewhere else instead: send the person you're helping ${origin}/_start to start in the browser, and stop.`,
            code: "invalid",
            retry_after: allowed.retryAfter,
            start_url: `${origin}/_start`,
            trace,
          },
          429,
        ),
        "retry-after",
        String(allowed.retryAfter),
      )

    let workspace = yield* deps.workspaceNamed(trialName())

    for (let tries = 0; tries < 5 && (yield* deps.workspaceExists(workspace)); tries++)
      workspace = yield* deps.workspaceNamed(trialName())

    const made = yield* workspaces.getByName(workspace.id).trialStart(workspace.name)
    const there = deps.workspaceOrigin(url, workspace)

    yield* Effect.logInfo(`trial: ${workspace.name} started for ${address}`).pipe(
      Effect.annotateLogs({ trace, workspace: workspace.id }),
    )

    return json(
      {
        workspace: workspace.name,
        workspace_url: there,
        mcp_url: `${there}/mcp`,
        token: made.token,
        claim_url: `${origin}/claim/${workspace.id}~${made.code}`,
        expires_at: made.expires,
        next: `Add the MCP server ${there}/mcp with the header "Authorization: Bearer <token>" (or POST JSON-RPC to it with curl), build and deploy, then give the person you're helping the claim_url: they open it, sign in with their email, and the workspace (and this token) becomes theirs. Unclaimed, it stops working at expires_at.`,
        trace,
      },
      201,
    )
  })

  /** A trial's claim link, on this host so the person signs in here: the button makes the workspace theirs, then goes to it signed in. */
  const claim = Effect.fn("base.claim")(function* (
    url: URL,
    label: string,
    code: string,
    trace: string,
  ) {
    const request = yield* HttpServerRequest
    const { viewer } = yield* deps.viewerOf(false, url.host)
    const name = Option.getOrUndefined(decodeName(label))
    const workspace = name === undefined ? undefined : yield* deps.workspaceNamed(name)

    if (workspace === undefined || !(yield* deps.workspaceExists(workspace)))
      return refusedHere("No such claim link", "Check the link your agent gave you.", trace, 404)

    if (viewer === null) return go(`/_signin?next=${encodeURIComponent(url.pathname)}`)

    if (request.method !== "POST")
      return htmlOf(
        claimPage({
          workspace: workspace.name,
          email: viewer.email,
          formToken: yield* deps.session.formToken(viewer.email, url.host),
        }),
        { headers: WORKSPACE_PAGE },
      )

    if ((yield* formOf(url, viewer)) === undefined)
      return refusedHere(
        "Refused",
        "This didn't come from OpenBelt's own page, so nothing happened. Open the claim link again.",
        trace,
        403,
      )

    const done = yield* workspaces.getByName(workspace.id).trialClaim(code, viewer)

    yield* Effect.logInfo(`trial: ${viewer.email} claiming ${workspace.name}: ${done.kind}`).pipe(
      Effect.annotateLogs({ trace, workspace: workspace.id }),
    )

    return yield* Match.value(done.kind).pipe(
      Match.when("claimed", () =>
        Effect.succeed(go(`${deps.workspaceOrigin(url, workspace)}/_signin/carry`)),
      ),
      Match.when("taken", () =>
        Effect.succeed(
          refusedHere(
            "Already claimed",
            `Someone else claimed ${workspace.name} first.`,
            trace,
            409,
          ),
        ),
      ),
      Match.when("expired", () =>
        Effect.succeed(
          refusedHere(
            "This trial ended",
            "Nobody claimed it within a day. Ask your agent to start again.",
            trace,
            410,
          ),
        ),
      ),
      Match.orElse(() =>
        Effect.succeed(
          refusedHere("No such claim link", "Check the link your agent gave you.", trace, 404),
        ),
      ),
    )
  })

  /** Everything the base host answers (the gateway sends the operator's routes, the CLI and the SDK elsewhere). */
  const route = Effect.fn("base.route")(function* (url: URL, trace: string) {
    const request = yield* HttpServerRequest
    const path = url.pathname
    const origin = url.origin
    const reading = request.method === "GET" || request.method === "HEAD"

    if (path === "/mcp") return yield* mcp(url, trace)

    if (OAUTH.test(path)) return yield* oauth(url, path, trace)

    if (SIGN_IN.test(path)) return yield* deps.signIn(url, trace)

    if (path === "/_signedout" && reading)
      return htmlOf(signInPage({ step: "signed_out", workspace: "OpenBelt", door: null }), {
        headers: WORKSPACE_PAGE,
      })

    if (path === "/_start") return yield* start(url, trace)

    if (path === "/_start/carry" && request.method === "GET") return yield* carry(url, trace)

    if (trials && path === "/_trial" && request.method === "POST")
      return yield* startTrial(url, trace)

    const claiming = trials ? CLAIM.exec(path) : null

    if (claiming !== null) return yield* claim(url, claiming[1] ?? "", claiming[2] ?? "", trace)

    if (!reading) return HttpServerResponse.text("Not found.\n", { status: 404 })

    if (path === "/auth.md") return markdown(authMd(origin, trials))

    if (path === "/start.md") return markdown(startMd(origin, google))

    if (path === "/llms.txt")
      return HttpServerResponse.text(llmsTxt(origin, trials), {
        contentType: "text/plain; charset=utf-8",
        headers: { "cache-control": "no-cache" },
      })

    if (path === "/" && wantsMarkdown(request.headers["accept"]))
      return markdown(homeMd(origin, trials))

    const viewer = path === "/" ? (yield* deps.viewerOf(false, url.host)).viewer : null
    const file = wwwFile(path, origin, viewer !== null)

    if (file === null)
      return (request.headers["accept"] ?? "").includes("text/html")
        ? htmlOf(
            refusedPage("Not found", `There's no page at ${path}.`, trace, undefined, {
              href: "/",
              text: "Go to OpenBelt",
            }),
            { status: 404, headers: WORKSPACE_PAGE },
          )
        : HttpServerResponse.text("Not found.\n", { status: 404 })

    if (path === "/")
      return keepSource(
        HttpServerResponse.uint8Array(file.bytes, {
          contentType: file.type,
          headers: {
            "cache-control": "private, no-cache",
            vary: "accept, cookie",
            link: '</auth.md>; rel="alternate"; type="text/markdown"',
          },
        }),
        yield* funnel("landing", url, trace, { viewer: viewer?.email }),
      )

    // A file can be asked for in part: a video player (and a link preview playing og.mp4) reads it by ranges.
    const range = byteRange(request.headers["range"], file.bytes.length)

    const headers = {
      "cache-control": "no-cache",
      "accept-ranges": "bytes",
      etag: `"${createHash("sha256").update(file.bytes).digest("hex")}"`,
    }

    if (range === "unsatisfiable")
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...headers, "content-range": `bytes */${file.bytes.length}` },
      })

    if (range !== null)
      return HttpServerResponse.uint8Array(file.bytes.subarray(range.first, range.last + 1), {
        status: 206,
        contentType: file.type,
        headers: {
          ...headers,
          "content-range": `bytes ${range.first}-${range.last}/${file.bytes.length}`,
        },
      })

    return HttpServerResponse.uint8Array(file.bytes, { contentType: file.type, headers })
  })

  return { route }
})
