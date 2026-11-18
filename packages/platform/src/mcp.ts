import * as Runtime from "./runtime/index.ts"
import { outside as offTurn } from "./runtime/events.ts"
import SERVER_ICON from "../../../brand/logo/tile-light.svg" with { type: "text" }
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { fromWeb, HttpServerRequest } from "effect/http/HttpServerRequest"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Struct from "effect/Struct"
import { AGENT_CHARS, Fields, forAgent, keepFields } from "./answers.ts"
import { queryWords, wordsIn } from "./words.ts"
import { Checker, type Person } from "./check.ts"
import { type JsonSchema, member, unreadNote } from "./contracts.ts"
import type { Called } from "./connections.ts"
import { openExecute, type WorkspaceOp } from "./execute.ts"
import { FUNCTION_LIMITS, thrown } from "./functions.ts"
import {
  appOfArgs,
  type CallOnWire,
  idOf,
  callsIn,
  DIDNT_RUN,
  runFailed,
  agentOf,
  clientIn,
  clientNameIn,
  type Judged,
  judge,
  keptArgs,
  sessionLost,
  settleBody,
  withTrace,
} from "./tool-calls.ts"
import { personRate } from "./rate.ts"
import { UPLOADS } from "./files.ts"
import { openManagement } from "./management.ts"
import {
  CALL_DESCRIPTION,
  CALL_INPUT,
  LISTS_EVERY_TOOL,
  callProblem,
  isToolsList,
  listedOnly,
  operationsFor,
  unknownOperation,
  mcpNameOf,
  unwrapCall,
} from "./two-tools.ts"
import { PAGE_NAMES, guideFor } from "./guide.ts"
import { appOfHost, appOrigin, appUrl, frameUrl, hostProblem, inWorkspace } from "./hosts.ts"
import {
  type Actor,
  type BatchWrite,
  CheckReport,
  CheckStep,
  Collection,
  type Conflict,
  ConnectLink,
  ConnectionView,
  Deployed,
  Doc,
  DocId,
  DocPage,
  type Denied,
  envNameProblem,
  envProblem,
  PersonName,
  FileContent,
  FunctionName,
  type Json,
  NetworkHost,
  RunView,
  SecretName,
  LineRange,
  LogLine,
  type Missing,
  newTrace as mintTrace,
  WorkspaceId,
  WorkspaceName,
  Refused,
  AppEdit,
  AppFile,
  AppInfo,
  type AppConfig,
  PublicView,
  AppName,
  appNameProblem,
  TEST_PEOPLE_LIVE,
  testEmail,
  testName,
  type Webhook,
  type Writer,
  WhoAmI,
  ManagementAnswer,
  type ErrorCode,
  decodeAgentApps,
  mayUseApp,
  notInApps,
} from "./model.ts"
import WorkspaceDO from "./workspace.ts"
import ApexDO, { APEX, slugOf, workspaceNameProblem } from "./apex.ts"
import { idOfNewWorkspace } from "./workspace-names.ts"
import { parseSkillUri, SCHEME, SKILL_FILE, type SkillEntry, type SkillFile } from "./skills.ts"
import { SECRET_LENGTH } from "./redaction.ts"
import { type RuleOp, signedOutWarnings } from "./rules.ts"
import { AUDIENCE_HEADER, PUBLIC_HOST, publicUrl, reachesOf } from "./public.ts"
import { outsideHeaders, SIGNIN, type SignIn } from "./session.ts"
import { textOf } from "./upstream.ts"
import { MAX_LIMIT } from "./data.ts"
import AppDO, { joinHint } from "./app.ts"
import { flowProblem, label, stepProblem } from "./steps.ts"
import { positive } from "./runtime/settings.ts"
import { STARTERS } from "./starters.ts"

const DEPLOYS_PER_HOUR = positive("OPENBELT_DEPLOYS_PER_HOUR", 300)

const DEPLOYS_KEY = "deploys:recent"

/** A tool's trace id, findable by drive trace and /_admin/trace whether or not the tool logs anything under it. */
const newTrace = () => Runtime.tracedHere(mintTrace())

const reachOf = (origin: string, signIn: SignIn) => {
  const workspace = URL.canParse(origin) ? new URL(origin).hostname : origin
  const host = `${workspace}/<app>`

  if (signIn === "tailscale")
    return `Anyone on the tailnet can open it at ${host}, each signed in as their Tailscale login (db.me() is them; a tagged device is signed out and writes as anonymous). Nobody off the tailnet can reach it.`

  if (signIn === "email")
    return `Whoever signs in to ${workspace} with an email code (a member, or anyone not removed when its joining is open) can open it at ${host}, signed in as themselves (db.me() is them). Anyone else is sent to sign in.`

  return `Anyone who can reach ${host} can open it, and nobody is signed in here: db.me() is null and pages write as anonymous.`
}

const Reach = Schema.String.annotate({
  description:
    "Who can open the URL: this computer only (local dev), or anyone who reaches the workspace's host",
})

const Traced = <S extends Schema.Struct.Fields>(fields: S) =>
  Schema.Struct({
    ...fields,
    trace: Schema.String.annotate({
      description: "This call's trace id: app_logs with trace shows what it did",
    }),
  })

const WhoAmITool = Tool.make("whoami", {
  description:
    "Who this token is in the workspace: the person (id, email, name, role, status), their groups, the workspace, how people join it (open or invite), and its admins. What your writes are stamped with.",
  success: Traced(WhoAmI.fields),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const FeedbackSubmit = Tool.make("feedback_submit", {
  description:
    "Tell OpenBelt's team about a problem you hit here: a bug, something OpenBelt can't do yet, or docs, a schema or a refusal that misled you. Say what you were trying to do and what happened instead; don't propose a fix. Your recent calls go with it, so don't paste them. Leave out the workspace's data and secrets. One report per problem.",
  parameters: Schema.Struct({
    category: Schema.Literals(["bug", "not_possible", "confusing", "other"]).annotate({
      description:
        "bug: OpenBelt did something wrong; not_possible: it can't do what the task needs; confusing: docs, a schema or a refusal misled you",
    }),
    summary: Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "One line, no workspace data",
    }),
    goal: Schema.String.check(Schema.isMaxLength(1000)).annotate({
      description: "What the person you're helping wanted",
    }),
    details: Schema.String.check(Schema.isMaxLength(4000)).annotate({
      description: "What you did, what happened, what you expected",
    }),
    tool: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))).annotate({
      description: "The operation involved, e.g. deploy_app",
    }),
  }),
  success: Traced({ id: Schema.String, message: Schema.String }),
  failure: Refused,
})

const Docs = Tool.make("docs", {
  description:
    "How to build and deploy an app or manage workspace settings, a page at a time. With no arguments, the index: each page with a line on what it covers and its sections. page returns one page; page and section one section of it. Read apps and sdk before your first deploy; workspace covers people, groups, connections and personal settings.",
  parameters: Schema.Struct({
    page: Schema.optionalKey(Schema.Literals(PAGE_NAMES)).annotate({
      description: "One page of the index, whole",
    }),
    section: Schema.optionalKey(Schema.String).annotate({
      description:
        'One section of page, by its heading as the index lists it (or its start), e.g. "Limits"',
    }),
  }),
  success: Schema.String,
  failure: Refused,
}).annotate(Tool.Readonly, true)

const SkillsTool = Tool.make("skills", {
  description:
    "The workspace's skills (Agent Skills: a SKILL.md of instructions and the files it refers to). Every app has one OpenBelt writes, skill://<app>/SKILL.md, on how to use its data and functions; an app can ship more in skills/<name>/ (docs page apps, Skills). With no uri, lists them; with uri, reads that SKILL.md or one of its files. MCP clients that support skills load the same ones themselves.",
  parameters: Schema.Struct({
    uri: Schema.optionalKey(Schema.String).annotate({
      description:
        'A skill\'s SKILL.md or one of its files, e.g. "skill://expenses/SKILL.md" or "skill://expenses/file-expense/references/policy.md"',
    }),
    cursor: Schema.optionalKey(Schema.String).annotate({
      description: "The next page of the list, from the last one's end",
    }),
  }),
  success: Traced({
    skills: Schema.Array(
      Schema.Struct({
        uri: Schema.String,
        name: Schema.String,
        description: Schema.String,
        files: Schema.Number,
      }),
    ).annotate({ description: "The listed skills (empty when you read one)" }),
    next: Schema.NullOr(Schema.String).annotate({
      description: "The cursor for the next page of the list, or null",
    }),
    file: Schema.NullOr(
      Schema.Struct({
        uri: Schema.String,
        mimeType: Schema.String,
        text: Schema.NullOr(Schema.String).annotate({ description: "The file, when it's text" }),
        base64: Schema.NullOr(Schema.String).annotate({
          description: "The file's bytes, when it isn't text",
        }),
        files: Schema.Array(Schema.String).annotate({
          description: "For a SKILL.md, its skill's other files: read each by its uri",
        }),
      }),
    ).annotate({ description: "The file read (null when listing)" }),
    note: Schema.String,
  }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const EnvParam = Schema.Union([Schema.String, Schema.Boolean])

const Preview = Schema.optionalKey(EnvParam).annotate({
  description:
    "A preview environment's name, e.g. \"triage\": that environment's data (which only its pages see) instead of the live data. The app must be deployed into it.",
})

const As = Schema.optionalKey(PersonName).annotate({
  description:
    'A test person, e.g. "alice": write as alice@<app>.test, as from her browser (author is hers, and the app\'s rules apply). Only with preview: "<env>".',
})

const DeployApp = Tool.make("deploy_app", {
  description:
    'Publish an app\'s files as a new version; the first deploy creates the app (its name is then yours). Without preview it goes live at once; with preview: "<env>" it goes into that preview environment, over its own data, and promote_app takes it live. To change an app, read it with app_files, then send edits ({ path, find, replace }) with base_version. The result has the URL, who can open it (reach), the public URL and what anyone reaches there when openbelt.json has "public" (public), and, for edits, a diff. If anything is wrong nothing deploys, and the refusal says what to fix.',
  parameters: Schema.Struct({
    app: AppName,
    files: Schema.optionalKey(Schema.Array(AppFile)).annotate({
      description:
        "Whole files: the whole app, or with edits or keep_others only new or rewritten files. Leave it out with keep_others: true to deploy the app as it is (into a preview environment).",
    }),
    edits: Schema.optionalKey(Schema.Array(AppEdit)).annotate({
      description:
        'Changes to base_version\'s text files, applied in order (a later edit sees the earlier ones), e.g. [{ path: "app.js", find: "const title = \'Standup\'", replace: "const title = \'Daily standup\'" }]. Any edits make the deploy a patch; one bad edit refuses them all.',
    }),
    preview: Schema.optionalKey(EnvParam).annotate({
      description:
        "A preview environment's name: 1-40 lowercase letters, digits and dashes, named after the change (\"triage\"). Don't go live; deploy into that environment (made on first use) and return its previewUrl. Put every app the change touches in the same one. A patch without base_version goes on the version already there.",
    }),
    seed: Schema.optionalKey(Schema.Literal("live")).annotate({
      description:
        "With preview: copy this app's newest 5000 live documents into the environment, once, while its data there is empty. Default: it starts empty.",
    }),
    note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))).annotate({
      description:
        "With preview: what the environment is for, shown in app_info and to anyone else who deploys into it, so teammates know whose work it is",
    }),
    base_version: Schema.optionalKey(Schema.String).annotate({
      description:
        "The version your edits and files start from: from app_files, app_info, or your last deploy_app (a preview's too). Default: the live version, or with preview, the app's version in that environment once it's deployed there (so fixes pile up). A deploy that would undo someone else's newer change is refused, and nothing changes.",
    }),
    keep_others: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "true: a patch. Files you don't send stay as they are in base_version (by default the live version, or with preview the app's version in that environment). Default false: the new version is exactly files.",
    }),
    delete: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: "With edits or keep_others: true, paths to remove",
    }),
    description: Schema.optionalKey(Schema.String).annotate({
      description:
        "One line for the workspace's app list (an openbelt.json description, when the app has one, wins)",
    }),
  }),
  success: Traced({
    ...Deployed.fields,
    url: Schema.String.annotate({
      description:
        "Where people open it: the app in the workspace's frame, in a browser. Give this link to people, with a page's path after it (url + \"/about.html\")",
    }),
    host: Schema.String.annotate({
      description:
        "The app's own host, where its pages and data are served: for curl or fetch, not for people (url is theirs). url answers anything but a browser with a 302 here, signed in or not; to see a page as a person does, use check_app (never make the app public to test it)",
    }),
    reach: Reach,
    public: PublicView,
  }),
  failure: Refused,
})

const PromoteApp = Tool.make("promote_app", {
  description:
    "Make versions live. { apps: [...], env }: each app goes live with the version it runs in that preview environment, all or none (every app is checked first, and if one fails the others are put back). It's refused if an app's live version changed since its environment version was made, saying who and when. { app, version }: one version, e.g. an earlier one to roll back to (app_info lists the last 20). Open pages reload. It never copies data: live apps keep their live data.",
  parameters: Schema.Struct({
    apps: Schema.optionalKey(Schema.Array(AppName).check(Schema.isMinLength(1))).annotate({
      description: "With env: the apps to take live together",
    }),
    env: Schema.optionalKey(Schema.String).annotate({
      description: "The preview environment whose versions go live",
    }),
    app: Schema.optionalKey(AppName).annotate({ description: "With version: one app" }),
    version: Schema.optionalKey(Schema.String),
  }),
  success: Traced({
    reach: Reach,
    promoted: Schema.Array(
      Schema.Struct({
        app: Schema.String,
        url: Schema.String,
        version: Schema.String,
        previous: Schema.NullOr(Schema.String).annotate({
          description: "The version that was live before: promote it to undo this",
        }),
      }),
    ),
  }),
  failure: Refused,
})

const AppDelete = Tool.make("app_delete", {
  description:
    "Delete an app for good: every version, its data, files, functions' runs and logs, its preview environments and the connections allowed to it. Its link 404s at once, its open pages reload, and a new app can take the name. There is no undo: ask the person first, naming the app, unless they asked for this delete. Only the app's owner or a workspace admin may.",
  parameters: Schema.Struct({
    app: AppName,
    confirm: Schema.String.annotate({
      description: "The app's name again, to confirm",
    }),
  }),
  success: Traced({
    deleted: Schema.String.annotate({ description: "The app's name, now free" }),
  }),
  failure: Refused,
})

const StarterList = Tool.make("starter_list", {
  description:
    "The starter apps you can add to the workspace: tested apps, each live in a second with its first data and a skill of its own. One for each pick docs page start offers (messages, journal, tasks, sketch), pulse, a live view of the others, and cut, a video editor. starter_add adds one.",
  parameters: Tool.EmptyParams,
  success: Traced({
    starters: Schema.Array(
      Schema.Struct({
        starter: Schema.String,
        description: Schema.String,
        added: Schema.NullOr(Schema.String).annotate({
          description: "The app it already is in this workspace, or null",
        }),
      }),
    ),
  }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const StarterAdd = Tool.make("starter_add", {
  description:
    "Add a starter app (starter_list) to the workspace as yours: a tested app with its first data and a skill, live at once. When someone picks one of docs page start's picks, add it instead of building it, then change it like any app (app_files, then deploy_app with edits). Adding the same starter again changes nothing.",
  parameters: Schema.Struct({
    starter: Schema.String.annotate({ description: 'A starter\'s name, e.g. "tasks"' }),
    app: Schema.optionalKey(AppName).annotate({
      description:
        "The app's name, if not the starter's (when the workspace already has one by that name)",
    }),
  }),
  success: Traced({
    app: Schema.String,
    url: Schema.String,
    added: Schema.Boolean.annotate({
      description: "false: it was already in the workspace, and nothing changed",
    }),
    next: Schema.String,
  }),
  failure: Refused,
})

const PreviewReset = Tool.make("preview_reset", {
  description:
    "Delete a preview environment's data on every app in it (or only app's), to start a test over. The versions there stay; live data is untouched; open pages in the environment reload. An environment with no deploys or writes for 7 days is deleted by itself.",
  parameters: Schema.Struct({
    env: Schema.String,
    app: Schema.optionalKey(AppName).annotate({ description: "Only this app's data there" }),
  }),
  success: Traced({
    env: Schema.String,
    apps: Schema.Array(Schema.Struct({ app: Schema.String, deleted: Schema.Number })),
    deleted: Schema.Number,
  }),
  failure: Refused,
})

const AppInfoTool = Tool.make("app_info", {
  description:
    "An app's URL (and public: its URL for anyone, or null), owner, live version and files (unreadable: null, or why this OpenBelt can't read its openbelt.json; pages and functions then stop until it's deployed again), the last 20 versions, usage, its live collections (about, docs, lastWrite, writable, rules, a sample document), its functions (kind, signature, schemas, own tool, triggers: schedule, webhook, data:<op>:<collection>, and last run), what they may reach (network, secrets and whether each is set, uses), webhooks (URL, verify, secret yet?), runs booked with ctx.later, schedules (next, last) and the preview environments it's in (version, previewUrl, note, other apps, collections there).",
  parameters: Schema.Struct({ app: AppName }),
  success: Traced(AppInfo.fields),
  failure: Refused,
}).annotate(Tool.Readonly, true)

/** How many apps one page of app_list holds by default, and at most. */
const APP_LIST_DEFAULT = 20

const APP_LIST_MAX = 50

const AppListTool = Tool.make("app_list", {
  description: `Every app in the workspace, a page at a time: name, URL, description, owner and last update, with total (how many match) and nextOffset (null on the last page). owner (an email, or "me") lists the apps one person made; sort is updated (default, newest first), created or name; limit 1-${APP_LIST_MAX}, default ${APP_LIST_DEFAULT}. To find an app for a job, search({ query }) instead.`,
  parameters: Schema.Struct({
    owner: Schema.optionalKey(
      Schema.String.annotate({
        description: 'Only the apps this person made: their email, or "me"',
      }),
    ),
    sort: Schema.optionalKey(
      Schema.Literals(["updated", "created", "name"]).annotate({
        description: "updated (default, newest first), created or name",
      }),
    ),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: APP_LIST_MAX })).annotate({
        description: `1-${APP_LIST_MAX}, default ${APP_LIST_DEFAULT}`,
      }),
    ),
    offset: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "The nextOffset the previous page gave",
      }),
    ),
  }),
  success: Traced({
    apps: Schema.Array(
      Schema.Struct({
        app: Schema.String,
        url: Schema.String,
        description: Schema.String,
        owner: Schema.String,
        updated: Schema.String,
      }),
    ),
    total: Schema.Number,
    nextOffset: Schema.NullOr(Schema.Number),
  }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const AppFiles = Tool.make("app_files", {
  description:
    'A version\'s source files with their contents (default: the live version), and that version to pass to deploy_app as base_version. Read it before changing an app. Text comes back as content, binary files as base64. One result carries about 400 KB of content in all: files past that are listed with omitted (ask for them by path). For just the part you\'ll edit, pass around (text to look for) or lines ("40-80"): text files then come back as excerpts ({ from, to, text }) instead of content, and files without a match are left out. E.g. app_files({ app, paths: ["app.js"], around: "function render", context: 20 }).',
  parameters: Schema.Struct({
    app: AppName,
    version: Schema.optionalKey(
      Schema.String.annotate({ description: "Any of the last 20 versions, e.g. a preview's" }),
    ),
    paths: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ description: "Only these files (default: all)" }),
    ),
    around: Schema.optionalKey(
      Schema.NonEmptyString.annotate({
        description:
          "Return only the places this text occurs (exact, case-sensitive), with context lines either side",
      }),
    ),
    context: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })).annotate({
        description: "Lines either side of each around match, 0-200 (default 10)",
      }),
    ),
    lines: Schema.optionalKey(LineRange),
  }),
  success: Traced({
    app: Schema.String,
    version: Schema.String,
    files: Schema.Array(FileContent),
  }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const DEPLOY_DIFF = 4000

const DIFF_PAGE = 16_000

const appDiffCall = (
  app: string,
  from: string | null,
  to: string,
  paths: ReadonlyArray<string> | undefined,
  offset: number,
) =>
  `app_diff({ app: "${app}", from: "${from ?? ""}", to: "${to}"${paths === undefined ? "" : `, paths: ${JSON.stringify(paths)}`}, offset: ${offset} })`

const diffPage = (text: string, offset: number, size: number, more: (next: number) => string) => {
  const window = text.slice(offset, offset + size)
  const end = offset + size >= text.length ? text.length : offset + size
  const lineEnd = window.lastIndexOf("\n")
  const next = end === text.length ? null : lineEnd > size / 2 ? offset + lineEnd + 1 : end
  const shown = next === null ? text.slice(offset) : text.slice(offset, next)

  return {
    text:
      next === null
        ? shown
        : `${shown}${shown.endsWith("\n") ? "" : "\n"}... (cut at ${next} of ${text.length} characters: ${more(next)} shows the rest)`,
    next,
  }
}

const LIST_DEFAULT = 50

/** As many as a function's or execute's list takes; LIST_BYTES still keeps a page small. */
const LIST_MAX = MAX_LIMIT

const LIST_BYTES = 100_000

const CollectionList = Tool.make("collection_list", {
  description: `Read an app's documents in one collection, newest first (by when they were created): the same data its pages read with db.collection(name).list(). Returns { docs, cursor }: up to limit documents (1-${LIST_MAX}, default ${LIST_DEFAULT}), fewer past about 100 KB. While cursor isn't null, pass it as cursor for the next page. preview: "<env>" reads that preview environment's data.`,
  parameters: Schema.Struct({
    app: AppName,
    collection: Collection,
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIST_MAX })).annotate({
        description: `1-${LIST_MAX}, default ${LIST_DEFAULT}`,
      }),
    ),
    cursor: Schema.optionalKey(
      Schema.String.annotate({ description: "The cursor from the previous page, as is" }),
    ),
    preview: Preview,
  }),
  success: Traced(DocPage.fields),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const BYPASS =
  "MCP writes bypass rules unless `as` is given (a live collection whose rules let nobody write it is refused: call its app's function)"

const MAX_BATCH = 500

const Email = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254))

const KeepAuthor = {
  author: Schema.optionalKey(Email).annotate({
    description:
      'For moving data: keeps who wrote it, e.g. "bob@acme.com" as the author (by default, you). Not with as.',
  }),
  updatedBy: Schema.optionalKey(Email).annotate({
    description: "For moving data: who last wrote it (by default, you). Not with as.",
  }),
}

const IfSeq = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
  description:
    "Write only while the document's seq is still this one (refused if it changed since); 0: only if there's no such document yet (create only)",
})

const NewId = Schema.optionalKey(DocId).annotate({
  description:
    "Create it with this id (refused if there's one already; collection_update changes one). By default, a new random id",
})

const AddDoc = Schema.Struct({ id: NewId, data: Schema.Json, ...KeepAuthor })

const MergeData = Schema.Json.annotate({
  description: "The fields to merge in, or the whole document with replace: true",
})

const UpdateDoc = Schema.Struct({
  id: DocId,
  data: MergeData,
  replace: Schema.optionalKey(Schema.Boolean),
  ifSeq: IfSeq,
  ...KeepAuthor,
})

const Batch = <S extends Schema.Top>(item: S, description: string) =>
  Schema.optionalKey(
    Schema.Array(item).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BATCH)),
  ).annotate({ description })

const Written = Traced({
  ...Doc.mapFields(Struct.map(Schema.optionalKey)).fields,
  written: Schema.optionalKey(Schema.Number).annotate({ description: "A batch: how many" }),
  docs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, seq: Schema.Number })),
  ).annotate({ description: "A batch: each document's id and seq, in order" }),
})

const CollectionAdd = Tool.make("collection_add", {
  description: `Add JSON documents to an app's collection, like db.collection(name).add(data): one (data) or up to ${MAX_BATCH} (docs: [{ data }, ...]) in one go, all or none. For imports and seed data, send groups of 100 rather than one call per document; earlier groups remain if a later one fails. id picks a new document's id. Open pages subscribed to it see them at once. Test data goes in a preview environment (preview: "<env>"), where only its pages see it. ${BYPASS}: as: "alice" adds as that test person there, to seed data from several people. For moving data, author keeps who wrote it.`,
  parameters: Schema.Struct({
    app: AppName,
    collection: Collection,
    id: NewId,
    data: Schema.optionalKey(Schema.Json).annotate({ description: "One document" }),
    docs: Batch(AddDoc, `Up to ${MAX_BATCH} documents, written together: all or none`),
    ...KeepAuthor,
    preview: Preview,
    as: As,
  }),
  success: Written,
  failure: Refused,
})

const CollectionUpdate = Tool.make("collection_update", {
  description: `Change documents by id, as pages do with update(id, patch): data's fields are merged in (shallow). With replace: true, data replaces it whole, creating it if there's none, like set(id, data). ifSeq: 0 writes only if there's no such document yet. One (id, data) or up to ${MAX_BATCH} (docs: [{ id, data, replace?, ifSeq? }]) in one go, all or none; every refused document is listed. Open pages see changes at once. preview: "<env>" changes that environment's data. ${BYPASS}: as: "bob" writes as that test person. For moving data, author and updatedBy keep who wrote it.`,
  parameters: Schema.Struct({
    app: AppName,
    collection: Collection,
    id: Schema.optionalKey(DocId),
    data: Schema.optionalKey(MergeData),
    replace: Schema.optionalKey(Schema.Boolean),
    ifSeq: IfSeq,
    docs: Batch(UpdateDoc, `Up to ${MAX_BATCH} changes, written together: all or none`),
    ...KeepAuthor,
    preview: Preview,
    as: As,
  }),
  success: Written,
  failure: Refused,
})

const CollectionDelete = Tool.make("collection_delete", {
  description: `Delete one document by id, or with all: true every document in the collection (to clear test data). Open pages see each delete at once. Returns how many were deleted. preview: "<env>" deletes from that environment's data. ${BYPASS}: as: "bob" deletes as that test person.`,
  parameters: Schema.Struct({
    app: AppName,
    collection: Collection,
    id: Schema.optionalKey(DocId),
    all: Schema.optionalKey(
      Schema.Literal(true).annotate({ description: "Delete every document in the collection" }),
    ),
    preview: Preview,
    as: As,
  }),
  success: Traced({ deleted: Schema.Number }),
  failure: Refused,
})

const AppDiff = Tool.make("app_diff", {
  description: `What changed between two of an app's versions, as a unified diff, ${DIFF_PAGE / 1000} KB a page: e.g. the rest of a deploy_app diff that was cut (its last line gives this call). Lines past 400 characters are cut around the change, marked ⟪… N chars⟫.`,
  parameters: Schema.Struct({
    app: AppName,
    from: Schema.String.annotate({ description: "The earlier version, e.g. your base_version" }),
    to: Schema.optionalKey(Schema.String).annotate({
      description: "The later version (default: the live one)",
    }),
    paths: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description: "Only these files (default: every file that differs)",
    }),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
      description: "Where in the diff to start, in characters: the next value from the last page",
    }),
  }),
  success: Traced({
    app: Schema.String,
    from: Schema.String,
    to: Schema.String,
    changed: Schema.Array(Schema.String).annotate({
      description: "Every path that differs between the two versions",
    }),
    diff: Schema.String,
    total: Schema.Number.annotate({ description: "The whole diff's length in characters" }),
    next: Schema.NullOr(Schema.Number).annotate({
      description: "offset for the next page; null at the end",
    }),
  }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const AppLogs = Tool.make("app_logs", {
  description:
    "An app's log, newest first: deploys, promotions, data writes (in an environment they say preview <env>), 404s, and errors from people's browsers (uncaught errors, rejections, console.error, failed SDK calls). Pass a trace id from any tool result to see only what that call did.",
  parameters: Schema.Struct({
    app: AppName,
    trace: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  }),
  success: Traced({ lines: Schema.Array(LogLine) }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const MAX_PEOPLE = 5

const CheckApp = Tool.make("check_app", {
  description:
    'Open an app\'s page in a real headless browser, run steps (a whole flow in one call), and report what a person would see: each step ok or FAILED with why, JS and console errors with stacks at your files\' line:column, failed requests, dialogs, the visible text, and the controls with their values. Assert with expect steps (status: 403 for a refused write). Every check starts signed out, with empty storage; in a preview environment, people: ["alice", "bob"] signs in test people, each in a browser of their own, and a step\'s as picks whose. Pass readonly: true on a live app. docs({ page: "debugging" }) has every action, with an example.',
  parameters: Schema.Struct({
    app: AppName,
    path: Schema.optionalKey(Schema.String).annotate({
      description: 'A page inside the app, default its first page; e.g. "admin.html?tab=2"',
    }),
    preview: Schema.optionalKey(EnvParam).annotate({
      description:
        "A preview environment to check the app in (at its previewUrl, over the environment's data). Default: the live app.",
    }),
    steps: Schema.optionalKey(Schema.Array(CheckStep).check(Schema.isMaxLength(40))).annotate({
      description: "Up to 40 actions to run in order after the page loads",
    }),
    people: Schema.optionalKey(
      Schema.Array(
        Schema.Union([
          PersonName,
          Schema.Struct({
            name: PersonName,
            groups: Schema.Array(Schema.String).check(Schema.isMaxLength(10)),
          }),
        ]),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PEOPLE)),
    ).annotate({
      description: `With preview only. Up to ${MAX_PEOPLE} test people, e.g. ["alice", "bob"]: each gets a browser of their own, signed in as <name>@<app>.test, with the page open before step 1. Pages stay open, so an expect as bob sees what alice just did. To test a group gate, give one groups: [{ "name": "ed", "groups": ["editors"] }, "viv"]: the app's functions see them in caller.groups (only groups you're in, unless you own every app in the preview or are a workspace admin; their connection calls are judged as you, with the workspace's token). Default: the people steps name in as.`,
    }),
    as: Schema.optionalKey(PersonName).annotate({
      description: 'One test person for the whole check: as: "alice" is people: ["alice"]',
    }),
    width: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 320, maximum: 1600 })).annotate({
        description: "Viewport width in px: default 1024, 390 for a phone",
      }),
    ),
    screenshot: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Take a JPEG of the page after the steps (default false): an image over MCP; the openbelt CLI saves it and prints its path as screenshot",
    }),
    readonly: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Send no writes: the page's saves get a 423 (code check_readonly) and are listed in blocked, so data stays as it was; its functions run but may only read (a write, a later, a fetch other than GET or HEAD gets the same 423), so a page that loads data with one works. Use it to check a live app people are using.",
    }),
  }),
  success: Traced({ app: Schema.String, ...CheckReport.fields }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

/** check_app is registered by hand (checkAppTool): its result carries an image, which toolkits can't. */
/** The workspace a call is in (the gateway sends both, x-openbelt-workspace and x-openbelt-workspace-name): its id keys objects, its name is shown. */
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)

const decodeWorkspaceName = Schema.decodeUnknownSync(WorkspaceName)

const checkAppInput = Schema.decodeUnknownSync(McpSchema.ToolJson)(
  Schema.toJsonSchemaDocument(CheckApp.parametersSchema).schema,
)

const checkAppOutput = Schema.decodeUnknownSync(McpSchema.ToolOutputJson)(
  Schema.toJsonSchemaDocument(CheckApp.successSchema).schema,
)

const decodeCheckApp = Schema.decodeUnknownEffect(CheckApp.parametersSchema)

const encodeCheckApp = Schema.encodeSync(CheckApp.successSchema)

const refusedCheck = (
  message: string,
  trace: string,
  params: typeof CheckApp.parametersSchema.Type | undefined,
) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: `${message} (trace ${trace})` }],
    structuredContent: encodeCheckApp({
      app: params?.app ?? "",
      url: "",
      status: null,
      title: "",
      errors: [message],
      console: [],
      dialogs: [],
      failedRequests: [],
      denied: [],
      expectedDenials: [],
      blocked: [],
      refusedTools: [],
      steps: (params?.steps ?? []).map((step) => `not run: ${label(step)}`),
      text: "",
      controls: [],
      incomplete: `nothing ran: ${message}`,
      ms: 0,
      trace,
    }),
  })

const SEARCH_OUTPUT = Schema.decodeUnknownSync(McpSchema.ToolOutputJson)(
  Schema.toJsonSchemaDocument(
    Schema.Struct({
      operations: Schema.Array(Schema.Json),
      apps: Schema.Array(Schema.Json),
      connections: Schema.Array(Schema.Json),
      notAdded: Schema.Array(Schema.Json),
      starters: Schema.Array(Schema.Json),
      note: Schema.String,
    }),
  ).schema,
)

const SEARCH_INPUT = Schema.decodeUnknownSync(McpSchema.ToolJson)({
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        'A few words for the task ("deploy an app", "set a secret", "expense reports", "pokemon"); "" lists every operation',
    },
  },
  required: ["query"],
})

/** app_picture is registered by hand (appPictureTool): its result carries an image, which toolkits can't. */
const AppPicture = Schema.Struct({
  app: AppName,
  theme: Schema.optionalKey(
    Schema.Literals(["light", "dark"]).annotate({
      description: "light (default) or dark: the picture of the app in that theme",
    }),
  ),
})

const APP_PICTURE_DESCRIPTION =
  "The picture of an app's first page that the workspace's home page shows on its card (WebP, 1920×1200), as an image, with when it was taken and of which version. It is taken a few seconds after a version goes live and again at most every 5 minutes while its live data changes. picture: null when none is taken yet: one is then booked, so ask again in a minute. To see a page in a browser now, check_app with screenshot: true."

const appPictureInput = Schema.decodeUnknownSync(McpSchema.ToolJson)(
  Schema.toJsonSchemaDocument(AppPicture).schema,
)

const AppPictureResult = Schema.Struct({
  app: Schema.String,
  picture: Schema.NullOr(
    Schema.Struct({
      theme: Schema.Literals(["light", "dark"]),
      version: Schema.String,
      taken: Schema.String,
    }),
  ),
  trace: Schema.String,
})

const appPictureOutput = Schema.decodeUnknownSync(McpSchema.ToolOutputJson)(
  Schema.toJsonSchemaDocument(AppPictureResult).schema,
)

const decodeAppPicture = Schema.decodeUnknownEffect(AppPicture, { onExcessProperty: "error" })

const encodeAppPicture = Schema.encodeSync(AppPictureResult)

/** How many of your newest apps skills/list lists the own skill of. */
const OWN_SKILL_APPS = 20

/** How many apps code mode's workspace.search and describe list: the best matches, or the ones updated most recently. */
const CATALOG_APPS = 10

/** A path in code mode, as JavaScript reaches it: `workspace.apps["hourly-joke"].fn.create_joke` (contracts.ts member). */
const codePath = (root: string, ...names: ReadonlyArray<string>) =>
  `${root}${names.map(member).join("")}`

/** A connection's tool (`<connection>.<tool>`, the tool's name may have dots of its own) as a path under `root`. */
const toolPath = (root: string, qualified: string) => {
  const dot = qualified.indexOf(".")

  return codePath(root, qualified.slice(0, dot), qualified.slice(dot + 1))
}

/**
 * The names in a path describe is given, in either form: as it prints them (apps["hourly-joke"].fn.create_joke) or dotted
 * (apps.hourly-joke.fn.create_joke), with or without workspace. in front.
 */
const pathNames = (path: string) => {
  const names = [...path.matchAll(/\[\s*(["'])(.*?)\1\s*\]|[^.[\]\s]+/g)].map((m) => m[2] ?? m[0])

  return names[0] === "workspace" ? names.slice(1) : names
}

const LISTED_MAX = 25

const FOUND = 5

/** How many environments a refusal for one that doesn't exist names. */
const ENVS_NAMED = 10

/** How many of a found app's functions search shows (the ones matching first), each with its input schema and its call. */
const FOUND_FUNCTIONS = 4

const TOOLS_LISTED = 60

const ConnectionsTool = Tool.make("connections", {
  description:
    "Search first: before building an app, connections({ search: \"pokemon\" }) (what it's about: its data or service) lists the few connections that match, with their tools, and what OpenBelt's catalog could add. Connections are the MCP servers and HTTP or GraphQL APIs the workspace's admins added, as you see them: whose token each uses, your level (none, read or all) and why, each tool usable or not. connections({ connection }) gives one's tools' input schemas; connection_call runs a tool. One that signs in with OAuth gives connect.url to send the person. Never ask anyone for a token: they set their own (setYourToken says how).",
  parameters: Schema.Struct({
    connection: Schema.optionalKey(Schema.String).annotate({
      description: "One connection's name: just it, with each tool's input schema",
    }),
    search: Schema.optionalKey(Schema.String).annotate({
      description:
        'Words for what you need ("pokemon", "weather forecast", "list repos for a user"). Without connection: the few connections that match best, each with its matching tools (connection, plus search, gives their input schemas). With connection: only its tools that match, best first, with their input schemas',
    }),
  }),
  success: Traced({
    connections: Schema.Array(ConnectionView),
    notAdded: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          provider: Schema.String,
          name: Schema.String,
          about: Schema.String,
          signIn: Schema.String,
        }),
      ),
    ).annotate({
      description:
        "OpenBelt's catalog entries this workspace hasn't added that match the search: use connection_add if available to you; otherwise ask a workspace admin to add one. Don't make up its data",
    }),
    note: Schema.String,
  }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const ConnectionCall = Tool.make("connection_call", {
  description:
    'Call a tool of one of the workspace\'s connections, e.g. connection_call({ tool: "deepwiki.ask_wiki_question", input: { repoName: "facebook/react", question: "How does Suspense work?" } }). The result is the server\'s own content (isError when its tool failed), then a line with the outcome, ms and trace. A tool you can\'t use is refused before it reaches the server, saying which setting refused it and who can change it. Some servers take 10-60s.',
  parameters: Schema.Struct({
    tool: Schema.String.annotate({ description: "<connection>.<tool>, as connections lists it" }),
    input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)).annotate({
      description: "The tool's arguments, as its input schema says (connections({ connection }))",
    }),
    as: Schema.optionalKey(Schema.Literals(["workspace", "me"])).annotate({
      description:
        "Whose token: the workspace's or your own. Needed only when the connection has both; connections says",
    }),
    fields: Schema.optionalKey(Fields),
  }),
  success: Schema.Struct({
    tool: Schema.String,
    outcome: Schema.Literals(["ok", "tool_error", "refused", "failed"]).annotate({
      description:
        "ok; tool_error: the server ran it and said it failed; refused: OpenBelt didn't send it (a setting, the text says which); failed: the server didn't answer or refused OpenBelt",
    }),
    runsAs: Schema.String.annotate({
      description: "Whose token it ran with: workspace, me, none, or -",
    }),
    text: Schema.String.annotate({ description: "The result's text, or why it didn't run" }),
    structured: Schema.NullOr(Schema.Json).annotate({
      description: "The server's own structuredContent, when it sent one",
    }),
    connect: Schema.optionalKey(ConnectLink).annotate({
      description:
        "When a person connecting fixes it (not connected, a sign-in that stopped working, a scope the tool needs, an admin's setup first): the link to send them, and why",
    }),
    ms: Schema.Number,
    trace: Schema.String.annotate({ description: "app_logs with trace finds the call's line" }),
  }),
})

const connectionCallInput = Schema.decodeUnknownSync(McpSchema.ToolJson)(
  Schema.toJsonSchemaDocument(ConnectionCall.parametersSchema).schema,
)

const connectionCallOutput = Schema.decodeUnknownSync(McpSchema.ToolOutputJson)(
  Schema.toJsonSchemaDocument(ConnectionCall.successSchema).schema,
)

const decodeConnectionCall = Schema.decodeUnknownEffect(ConnectionCall.parametersSchema)

const encodeConnectionCall = Schema.encodeSync(ConnectionCall.successSchema)

const decodeBlock = Schema.decodeUnknownOption(McpSchema.ContentBlock)

const calledResult = (tool: string, called: Called, trace: string) => {
  if (called.kind === "not_run") {
    const said = {
      tool,
      outcome: called.outcome,
      runsAs: "-",
      text: called.message,
      structured: null,
      ms: called.ms,
      trace,
    }

    return new McpSchema.CallToolResult({
      isError: true,
      content: [
        {
          type: "text",
          text: `${called.outcome === "refused" ? "Refused by OpenBelt" : "The server failed"}: ${called.message} (trace ${trace})`,
        },
      ],
      structuredContent: encodeConnectionCall(
        called.connect === undefined ? said : { ...said, connect: called.connect },
      ),
    })
  }

  const { result } = called

  return new McpSchema.CallToolResult({
    isError: result.isError ?? false,
    content: [
      ...result.content.map((block) => {
        const decoded = Option.getOrElse(decodeBlock(block), (): McpSchema.ContentBlock => ({
          type: "text",
          text: JSON.stringify(block),
        }))

        return decoded.type === "text" && decoded.text.length > AGENT_CHARS
          ? { type: "text" as const, text: forAgent(decoded.text) }
          : decoded
      }),
      {
        type: "text",
        text: `(openbelt: ${tool} ${called.outcome} in ${called.ms}ms as ${called.runsAs}, trace ${trace})`,
      },
    ],
    structuredContent: encodeConnectionCall({
      tool,
      outcome: called.outcome,
      runsAs: called.runsAs,
      text: forAgent(textOf(result)),
      structured: result.structuredContent ?? null,
      ms: called.ms,
      trace,
    }),
  })
}

const CallFunction = Tool.make("call_function", {
  description:
    'Run an app\'s function as you (search finds one by what it does, with its input schema). input is the JSON its signature takes (search, app_info); input that doesn\'t fit its schema is refused before it runs. The result is what it returns, with console lines, run id and attempts, and a note naming input keys it never read. key makes a retry safe (replayed: true). inputs: [...] starts one run per input at the same moment, to test contention. as: "schedule" | "webhook" | "data" | "later" runs it as that trigger would (caller null), to prove one without waiting. preview: "<env>" runs the version there, on its data.',
  parameters: Schema.Struct({
    app: AppName,
    function: FunctionName,
    input: Schema.optionalKey(Schema.Json).annotate({
      description:
        'Its input, any JSON value (default null), as its openbelt.json line describes. With as "schedule": default the schedule\'s input; "webhook": the delivery\'s body; "data": { collection, id } (the change is made from the document as it is now; op, doc, before to set them)',
    }),
    as: Schema.optionalKey(Schema.Literals(["schedule", "webhook", "data", "later"])).annotate({
      description:
        "Run it as this trigger would, by hand: caller null, via the trigger, its ctx (ctx.schedule for a schedule) and input shape; recorded as run by you, its connection calls judged as you. A webhook run this way skips the signature check (curl the hook's URL to test that). Only the app's owner or a workspace admin may, live or in a preview (its functions have the real secrets there too)",
    }),
    key: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    ).annotate({
      description:
        "An idempotency key: a run with this key that went ok in the last 24h is answered from its result instead of running again (replayed: true); the same key with a different input is refused",
    }),
    inputs: Schema.optionalKey(
      Schema.Array(
        Schema.Union([
          Schema.Record(Schema.String, Schema.Json),
          Schema.Array(Schema.Json),
          Schema.String,
          Schema.Finite,
          Schema.Boolean,
          Schema.Null,
        ]),
      ).check(Schema.isMinLength(2), Schema.isMaxLength(20)),
    ).annotate({
      description:
        "2-20 inputs, instead of input: one run each, all started at once (they really overlap, as calls from many people would), to test a function under contention. result is { ok, failed } and runs has each outcome, in order. Not with key or as.",
    }),
    preview: Preview,
  }),
  success: Traced({
    app: Schema.String,
    function: Schema.String,
    version: Schema.String.annotate({ description: "The version whose function ran" }),
    result: Schema.Json.annotate({ description: "What the function returned" }),
    run: Schema.String.annotate({ description: "The run's id: function_runs shows its record" }),
    attempts: Schema.Number.annotate({
      description: "1, or more when what it read changed before it committed and it ran again",
    }),
    replayed: Schema.Boolean.annotate({
      description: "Answered from an earlier run with the same key: it didn't run again",
    }),
    ms: Schema.Number,
    calls: Schema.Number.annotate({ description: "db calls it made" }),
    logs: Schema.Array(
      Schema.Struct({ level: Schema.Literals(["info", "warn", "error"]), text: Schema.String }),
    ).annotate({ description: "What it wrote with console.log, warn and error" }),
    runs: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          ok: Schema.Boolean,
          result: Schema.optionalKey(Schema.Json),
          kind: Schema.optionalKey(Schema.String),
          error: Schema.optionalKey(Schema.String),
          attempts: Schema.Number,
          run: Schema.String,
        }),
      ),
    ).annotate({ description: "With inputs: each run's outcome, in the order of inputs" }),
    note: Schema.optionalKey(Schema.String).annotate({
      description:
        "Keys its input had that the function never read (a misspelt key changes nothing), and the keys it reads",
    }),
  }),
  failure: Refused,
})

const FunctionRuns = Tool.make("function_runs", {
  description:
    "An app's function runs, newest first, whatever started them (page, app:<name>, agent, schedule, webhook, data, later): who, version, input, attempts, writes, outcome, error kind and message (a webhook refused for its signature too), the last console lines and the trace for app_logs. Use it to see that a schedule, webhook or trigger ran and what it did.",
  parameters: Schema.Struct({
    app: AppName,
    function: Schema.optionalKey(FunctionName),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    failed: Schema.optionalKey(Schema.Boolean.annotate({ description: "Only runs that failed" })),
    trace: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Only the runs of one trace (a call's trace: it and the runs it started with ctx.call)",
      }),
    ),
  }),
  success: Traced({ runs: Schema.Array(RunView) }),
  failure: Refused,
}).annotate(Tool.Readonly, true)

const WebhookSecret = Tool.make("webhook_secret", {
  description:
    "A webhook's URL and secret (openbelt.json \"webhooks\", once deployed), how a delivery is signed, and a curl that sends a signed test one (webhook_test does it for you). The secret is made the first time you ask and shown only then: give it to the sender, never put it in a page or the app's files. rotate: true makes a new one; the old one stops at once. preview: \"<env>\" gives that environment's own URL and secret (a preview's never works on live). Only the app's owner or a workspace admin.",
  parameters: Schema.Struct({
    app: AppName,
    function: FunctionName,
    rotate: Schema.optionalKey(Schema.Boolean),
    preview: Preview,
  }),
  success: Traced({
    url: Schema.String,
    verify: Schema.String,
    header: Schema.NullOr(Schema.String),
    secret: Schema.NullOr(Schema.String).annotate({
      description: "The secret, shown once (null: it was shown when made; rotate for a new one)",
    }),
    made: Schema.NullOr(Schema.String),
    signing: Schema.String.annotate({ description: "How a sender signs a delivery" }),
    test: Schema.String.annotate({ description: "A curl that sends a signed test delivery" }),
  }),
  failure: Refused,
})

const SetSecret = Tool.make("set_secret", {
  description:
    'Store a secret an app\'s functions send (an API key) with the value the person gave you (not from a file). List it in openbelt.json "secrets" ({ "MAPS_API_KEY": "what it\'s for" }), its API\'s host in "network"; code writes ctx.secrets.MAPS_API_KEY, a placeholder filled in on the way out (give a JSON or form body its content-type, or it goes in as it is). The value is sealed: never shown again or in a page or another app; it goes only to the hosts it was set for (hosts), one value for live and previews. An echo of it is redacted only as sent, JSON- or URL-encoded (not base64): pin it to hosts that don\'t return what they\'re sent. value: null removes it. Only the app\'s owner or a workspace admin.',
  parameters: Schema.Struct({
    app: AppName,
    name: SecretName,
    value: Schema.NullOr(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SECRET_LENGTH.max)),
    ).annotate({
      description: `The secret exactly as issued (${SECRET_LENGTH.min} to ${SECRET_LENGTH.max} characters, no whitespace at either end), or null to remove it`,
    }),
    hosts: Schema.optionalKey(Schema.Array(NetworkHost)).annotate({
      description:
        'The only hosts it may be sent to, e.g. ["api.example.com"]. Default: where the live openbelt.json sends it now (its "hosts", else "network"); an openbelt.json deployed later that sends it anywhere else stops it until it\'s set again',
    }),
  }),
  success: Traced({
    app: Schema.String,
    name: Schema.String,
    set: Schema.Boolean,
    at: Schema.NullOr(Schema.String),
    about: Schema.NullOr(Schema.String).annotate({
      description:
        'Its line in the live openbelt.json "secrets" (null: not listed there yet, so functions can\'t read it)',
    }),
    hosts: Schema.NullOr(Schema.Array(Schema.String)).annotate({
      description: "The only hosts it may go to (null: removed)",
    }),
    note: Schema.String,
  }),
  failure: Refused,
})

const WebhookTest = Tool.make("webhook_test", {
  description:
    'Send a webhook a test delivery exactly as an outside sender would, through the same signature checks and run (no shell needed): sign: "good" signs body with the webhook\'s secret, "bad" with a wrong one, "none" sends no signature. The reply is the status (200, or 401 before any code runs) and body the sender would get, and the run\'s id for function_runs. preview: "<env>" delivers to the webhook there (its own secret, that environment\'s data). Only the app\'s owner or a workspace admin, live or in a preview.',
  parameters: Schema.Struct({
    app: AppName,
    function: FunctionName,
    body: Schema.Json.annotate({ description: "The delivery's JSON body" }),
    sign: Schema.optionalKey(Schema.Literals(["good", "bad", "none"])).annotate({
      description: "Default good",
    }),
    preview: Preview,
  }),
  success: Traced({
    status: Schema.Number,
    body: Schema.Json,
    run: Schema.NullOr(Schema.String),
    replayed: Schema.Boolean,
    sent: Schema.Array(Schema.String).annotate({ description: "The headers it sent" }),
  }),
  failure: Refused,
})

const Execute = Tool.make("execute", {
  description: `Run JavaScript on OpenBelt as you, with the workspace in reach as workspace: every app's functions (await workspace.apps.<app>.fn.<name>(input)), data (workspace.apps.<app>.collection("<name>").list(), get, add, set, update, delete) and the workspace's connections (workspace.connections.<c>.<tool>({ ... })). Find names with await workspace.search("...") and workspace.describe("<path>"). Send a body that awaits and returns what you want back. Promise.all runs calls at once (to test contention); fetch reaches the workspace's own app hosts as an outside sender would (to test a webhook). Returns { result, logs, error: { kind, message, line }, calls }.`,
  parameters: Schema.Struct({
    code: Schema.String.annotate({
      description:
        'The code: a body like `const { docs } = await workspace.apps.todo.collection("items").list(); return docs.length`, or async () => { ... }',
    }),
    input: Schema.optionalKey(Schema.Json).annotate({
      description: "Any JSON, which the code reads as input",
    }),
    preview: Preview,
  }),
  success: Traced({
    ok: Schema.Boolean,
    result: Schema.Json.annotate({ description: "What the code returned (null when it failed)" }),
    logs: Schema.Array(Schema.String).annotate({ description: "Its console lines" }),
    error: Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literals(["syntax", "runtime", "timeout", "limit", "sandbox"]),
        message: Schema.String,
        line: Schema.NullOr(Schema.Number).annotate({
          description: "The line of your code, when known",
        }),
      }),
    ),
    calls: Schema.Array(
      Schema.Struct({ call: Schema.String, ms: Schema.Number, ok: Schema.Boolean }),
    ).annotate({
      description: "The workspace calls it made, in order",
    }),
    note: Schema.NullOr(Schema.String),
    ms: Schema.Number,
  }),
  failure: Refused,
})

const PreviewSideEffects = Tool.make("preview_side_effects", {
  description:
    "Whether a preview environment's functions send what changes things outside OpenBelt (a fetch other than GET or HEAD, a connection tool not marked read-only). By default they don't: each is checked, logged and answered { previewed: true, ... }, since the preview's data is test data but those servers are real. send: true sends them for real (an email, a filed issue) for every app in the environment, until another app joins it or it expires; send: false previews again. Only when the person you work for asks, and tell them; only a person who owns every app in it, or a workspace admin.",
  parameters: Schema.Struct({
    env: Schema.String.annotate({ description: "The preview environment" }),
    send: Schema.Boolean.annotate({
      description:
        "true: send outside effects for real from this environment; false: preview them (the default)",
    }),
  }),
  success: Traced({
    env: Schema.String,
    send: Schema.Boolean,
    note: Schema.String,
  }),
  failure: Refused,
})

/**
 * How the openbelt CLI (cli/) says a tool: each command line (`data add <app>/<collection> [data]`:
 * `<x>` a required argument, `[x]` an optional one, `<a>/<b>` and `<a>.<b>` two in one word,
 * `[x...]` the rest of the words) and a one-line summary. The CLI builds its commands and help from
 * these and the input schema; a tool with none has no command of its own (`openbelt call` reaches it).
 */
const cli = (...commands: ReadonlyArray<readonly [usage: string, summary: string]>) => ({
  "openbelt/cli": commands.map(([usage, summary]) => ({ usage, summary })),
})

const Tools = Toolkit.make(
  Docs.annotate(Tool.Meta, cli(["docs [page] [section]", "How OpenBelt works, a page at a time"])),
  SkillsTool.annotate(
    Tool.Meta,
    cli(["skills [uri]", "The workspace's skills, or one skill's text"]),
  ),
  WhoAmITool.annotate(
    Tool.Meta,
    cli(["whoami", "Who you are in the workspace: role, groups, how people join"]),
  ),
  ConnectionsTool.annotate(
    Tool.Meta,
    cli(
      [
        "connection list [search...]",
        "The services the workspace connects to, which you can use and why",
      ],
      [
        "connection info <connection>",
        "One connection: its tools, their inputs, whether you're connected",
      ],
    ),
  ),
  DeployApp.annotate(
    Tool.Meta,
    cli([
      "app deploy [dir]",
      "Deploy a folder as an app (its name: the folder's, or --app); prints its URL",
    ]),
  ),
  PromoteApp.annotate(
    Tool.Meta,
    cli(["app promote <apps> <env>", "Make a preview environment's versions live"]),
  ),
  AppDelete.annotate(
    Tool.Meta,
    cli(["app delete <app>", "Delete an app for good (--confirm takes its name again)"]),
  ),
  PreviewReset.annotate(
    Tool.Meta,
    cli(["app reset <env>", "Delete a preview environment's data, to start a test over"]),
  ),
  StarterList.annotate(
    Tool.Meta,
    cli(["starter list", "The starter apps you can add, and which are already here"]),
  ),
  StarterAdd.annotate(
    Tool.Meta,
    cli(["starter add <starter>", "Add a starter app to the workspace, as yours (--app names it)"]),
  ),
  AppListTool.annotate(
    Tool.Meta,
    cli(["app list", "Every app in the workspace, newest first, a page at a time"]),
  ),
  AppInfoTool.annotate(
    Tool.Meta,
    cli(["app info <app>", "One app in full: URL, versions, collections, functions, schedules"]),
  ),
  AppFiles.annotate(
    Tool.Meta,
    cli(["app pull <app> [dir]", "An app's files into a folder (default: the live version)"]),
  ),
  AppDiff.annotate(
    Tool.Meta,
    cli(["app diff <app> <from> [to]", "What changed between two of an app's versions"]),
  ),
  CollectionList.annotate(
    Tool.Meta,
    cli([
      "data list <app>/<collection>",
      "An app's documents in one collection, newest first (--all: every page)",
    ]),
  ),
  CollectionAdd.annotate(
    Tool.Meta,
    cli(["data add <app>/<collection> [data]", "Add a document (a JSON array adds several)"]),
  ),
  CollectionUpdate.annotate(
    Tool.Meta,
    cli([
      "data update <app>/<collection> [id] [data]",
      "Change a document, or many: a JSON array of { id, data } (or on stdin)",
    ]),
  ),
  CollectionDelete.annotate(
    Tool.Meta,
    cli(["data delete <app>/<collection> [id]", "Delete a document (or every one, with --all)"]),
  ),
  CallFunction.annotate(
    Tool.Meta,
    cli(["fn run <app>.<function> [input]", "Run an app's function as you"]),
  ),
  FunctionRuns.annotate(
    Tool.Meta,
    cli(["fn runs <app> [function]", "An app's function runs and their results, newest first"]),
  ),
  WebhookSecret.annotate(
    Tool.Meta,
    cli(["fn webhook-secret <app>.<function>", "A webhook's URL and secret, for the sender"]),
  ),
  WebhookTest.annotate(
    Tool.Meta,
    cli(["fn webhook-test <app>.<function> <body>", "Send a webhook a test delivery"]),
  ),
  SetSecret.annotate(
    Tool.Meta,
    cli([
      "app secret <app> <name> [value]",
      "Set a secret an app's functions send (the value from stdin when left out)",
    ]),
  ),
  PreviewSideEffects.annotate(
    Tool.Meta,
    cli([
      "app side-effects <env> <send>",
      "Let a preview environment's functions send for real, or not",
    ]),
  ),
  // A shell already chains commands (data list --all | jq | data update), so execute has no
  // command of its own: openbelt call execute reaches it.
  Execute.annotate(Tool.Meta, cli()),
  AppLogs.annotate(Tool.Meta, cli(["app logs <app>", "An app's log, newest first"])),
  FeedbackSubmit.annotate(
    Tool.Meta,
    cli([
      "feedback <category> <summary...>",
      "Tell OpenBelt's team about a problem: bug, not_possible, confusing or other (--goal, --details)",
    ]),
  ),
)

/** OpenBelt's own tools, each its own label on openbelt_mcp_tool_calls_total (any other name a client sends counts as "unknown"). */
const TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(Tools.tools),
  CheckApp.name,
  ConnectionCall.name,
  "search",
  "call",
])

/** How many workspaces one person may make with workspace_create in an hour (counted by ApexDO, with those made in the browser). */
const WORKSPACES_PER_HOUR = 5

const SESSION = "mcp-session-id"

const MCP_NAME = "mcp-name"

export const UNKNOWN_SESSION = "x-openbelt-unknown-session"

type SavedSession = { readonly id: string; readonly initialize: string }

const KEEP_SESSIONS = 50

const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })

const Initialize = Schema.fromJsonString(Schema.Struct({ method: Schema.Literal("initialize") }))

const decodeInitialize = Schema.decodeUnknownOption(Initialize)

const isInitialize = (body: string) => Option.isSome(decodeInitialize(body))

const requestIdOf = (body: string) =>
  Option.match(
    Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]) })),
    )(body),
    { onNone: () => null, onSome: ({ id }) => id },
  )

type Resumed = Data.TaggedEnum<{
  Resumed: { readonly session: string }
  Lost: { readonly reason: string; readonly unknown: boolean }
}>

const Resumed = Data.taggedEnum<Resumed>()

/**
 * The reply to a request on a session that can't be resumed: 404, which tells an MCP client to
 * start a new session (the spec), with a JSON-RPC error that says so for anyone reading it.
 * -32001 is the code the MCP SDKs use for "session not found".
 */
const lostSession = (body: string, session: string, reason: string, trace: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: requestIdOf(body),
      error: {
        code: -32001,
        message: `MCP session ${session} can't be resumed: ${reason}. Start a new session: send initialize again without the mcp-session-id header (MCP clients do this on a 404). Trace ${trace}.`,
        data: { session, reason, trace },
      },
    },
    { status: 404 },
  )

/** Read a response's body to the end, so the request scope it holds closes. */
const drain = (response: HttpServerResponse.HttpServerResponse) =>
  Predicate.isTagged(response.body, "Stream")
    ? Effect.orDie(Stream.runDrain(response.body.stream))
    : Effect.void

const writer = (user: string): Writer => ({ author: user, name: user })

const actorOf = (user: string, person: Writer | undefined): Actor =>
  person === undefined
    ? { writer: writer(user), rules: "bypass", testFor: null }
    : { writer: person, rules: "apply", testFor: user }

const testPeopleIn = (app: string, env: string | undefined, people: ReadonlyArray<string>) =>
  people.length === 0 || env !== undefined
    ? Effect.void
    : Effect.fail(
        new Refused({
          message: `${people.map((name) => testEmail(name, app)).join(", ")} ${people.length === 1 ? "is a test person" : "are test people"}, and ${TEST_PEOPLE_LIVE} (deploy_app({ app: "${app}", preview: "<env>", keep_others: true }) puts the live version there), then pass the same preview here.`,
        }),
      )

const isName = Schema.is(PersonName)

const peopleOf = (params: typeof CheckApp.parametersSchema.Type) => {
  const named = (params.steps ?? []).flatMap((step) => (step.as === undefined ? [] : [step.as]))

  return (
    params.people?.map((p) => (isName(p) ? p : p.name)) ??
    (params.as === undefined ? [...new Set(named)] : [params.as])
  )
}

const groupsOf = (params: typeof CheckApp.parametersSchema.Type) =>
  new Map((params.people ?? []).flatMap((p) => (isName(p) ? [] : [[p.name, p.groups] as const])))

const envOf = (preview: string | boolean | undefined) => {
  if (preview === undefined || preview === false) return Effect.succeed(undefined)

  if (preview === true) {
    return Effect.fail(
      new Refused({
        message:
          'preview takes a preview environment\'s name, not true: preview: "triage", named after the change. deploy_app({ app, preview: "triage", files }) deploys into it (made on first use, with its own data); put every app the change touches in the same one, then promote_app({ apps: [...], env: "triage" }).',
      }),
    )
  }

  const problem = envProblem(preview)

  return problem === undefined
    ? Effect.succeed(preview)
    : Effect.fail(new Refused({ message: problem }))
}

/**
 * A call into another Durable Object. Its Refused, Denied, Missing or Conflict arrives as a plain
 * {_tag, message} (RPC drops the class), so it's made a Refused for the tool's result: the message
 * says what to do.
 */
const remote = <A, R>(effect: Effect.Effect<A, Refused | Denied | Missing | Conflict, R>) =>
  effect.pipe(
    Effect.catchTags({
      Refused: (e) => Effect.fail(new Refused({ message: e.message })),
      Denied: (e) => Effect.fail(new Refused({ message: `${e.message} (403): ${e.hint}` })),
      Missing: (e) => Effect.fail(new Refused({ message: e.message })),
      Conflict: (e) => Effect.fail(new Refused({ message: e.message })),
    }),
  )

const RULE_OPS_OF = {
  add: ["create"],
  set: ["create", "update"],
  update: ["update"],
  delete: ["delete"],
} as const satisfies Record<BatchWrite["op"], ReadonlyArray<RuleOp>>

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const toolValue = (structured: Json | undefined, text: string): Json =>
  structured !== undefined && structured !== null
    ? structured
    : Option.getOrElse(decodeJsonText(text), () => text)

const searchWords = (query: string) =>
  query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .flatMap((w) => (w.length > 1 ? [w.replace(/(ing|ed|es|s)$/, "") || w] : []))

const schemaJson = Schema.decodeUnknownSync(Schema.NullOr(Schema.Json))

const asThrown = Effect.mapError((e: Refused) => thrown(e.message))

const howSigned = (
  verify: Webhook["verify"],
  hook: {
    readonly header: string
    readonly prefix: string
    readonly base: string
    readonly shown: string
  },
) => {
  const { header, prefix, base, shown } = hook

  switch (verify) {
    case "none":
      return {
        signing: "Not signed: anyone may POST it (verify: none).",
        test: `curl -X POST '${base}' -H 'content-type: application/json' -d '{"test":true}'`,
      }
    case "token":
      return {
        signing: "The secret is the URL's last segment: POST to url/<secret>.",
        test: `curl -X POST '${base}/${shown}' -H 'content-type: application/json' -d '{"test":true}'`,
      }
    case "stripe":
      return {
        signing: `${header}: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the secret>`,
        test: `body='{"test":true}'; t=$(date +%s); sig=$(printf '%s' "$t.$body" | openssl dgst -sha256 -hmac '${shown}' | sed 's/^.* //'); curl -X POST '${base}' -H 'content-type: application/json' -H "${header}: t=$t,v1=$sig" -d "$body"`,
      }
    default:
      return {
        signing: `${header}: ${prefix}<hex HMAC-SHA256 of the raw body, as sent, with the secret>`,
        test: `body='{"test":true}'; sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac '${shown}' | sed 's/^.* //'); curl -X POST '${base}' -H 'content-type: application/json' -H "${header}: ${prefix}$sig" -d "$body"`,
      }
  }
}

const SKILL_PAGE = 20

const SKILL_TTL_MS = 60_000

/** A request mcp.ts answers itself: the Skills extension's methods, and resources/read of a skill:// URI. */
const decodeSkillRpc = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Number]),
      method: Schema.Literals(["skills/list", "skills/get", "resources/read"]),
      params: Schema.optionalKey(
        Schema.Struct({
          uri: Schema.optionalKey(Schema.String),
          cursor: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
)

const skillRpcOf = (body: string) =>
  Option.getOrUndefined(
    Option.filter(
      decodeSkillRpc(body),
      (rpc) => rpc.method !== "resources/read" || (rpc.params?.uri ?? "").startsWith(SCHEME),
    ),
  )

/** A result of the Skills extension: complete, and cacheable for a minute by this token alone (a workspace's skills are its own). */
type SkillResult =
  | { readonly skills: ReadonlyArray<SkillEntry>; readonly nextCursor?: string }
  | { readonly skill: SkillEntry }
  | { readonly contents: ReadonlyArray<SkillFile> }

const skillResult = (id: string | number, result: SkillResult) =>
  HttpServerResponse.jsonUnsafe({
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", ...result, ttlMs: SKILL_TTL_MS, cacheScope: "private" },
  })

const skillError = (id: string | number, code: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, error: { code, message } })

const toolError = (message: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] })

export default class McpDO extends Runtime.DurableObject(
  "McpDO",
  Effect.gen(function* () {
    const state = yield* Runtime.DurableObjectState
    const workspaces = yield* WorkspaceDO
    const apex = (yield* ApexDO).getByName(APEX)

    const apps = yield* AppDO

    /** An app's skills, or none when it can't say (logged): one app asleep or failing doesn't empty a list. */
    const skillsOf = (id: string, app: string) =>
      apps
        .getByName(id)
        .skills()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`skills of ${app} didn't load`, cause).pipe(
              Effect.as<ReadonlyArray<SkillEntry>>([]),
            ),
          ),
        )

    const checker = yield* Checker
    const runCode = openExecute(yield* Runtime.WorkerLoader)

    /** How long a check_app call waits for one of the machine's browsers before it is refused. */
    const CHECK_WAIT_MS = 20_000

    const checksAtOnce = yield* Config.Number("OPENBELT_CHECKS_AT_ONCE").pipe(
      Config.withDefault(4),
      Effect.orDie,
    )

    /** One workspace's share of the machine's browsers, so a busy one leaves the others theirs. */
    const checksPerWorkspace = Math.max(1, Math.floor(checksAtOnce / 2))

    const signIn = yield* SIGNIN.pipe(Effect.orDie)
    const publicHost = yield* PUBLIC_HOST.pipe(Effect.orDie)
    const uploads = (yield* UPLOADS.pipe(Effect.orDie)) === "on"
    const guide = guideFor(uploads)

    return Effect.gen(function* () {
      const { kv } = state.storage

      const caller = () => ({
        workspace: decodeWorkspaceId(kv.get("workspace")),
        workspaceName: decodeWorkspaceName(kv.get("workspaceName")),
        user: kv.get<string>("user") ?? "",
        person: kv.get<string>("person") ?? "",
        origin: kv.get<string>("origin") ?? "",
        /** The apps the calling sign-in or token may use; null for every app. */
        apps: decodeAgentApps(kv.get<string>("apps") || null),
      })

      const workspace = () => workspaces.getByName(caller().workspace)

      const mayUse = (app: string) => mayUseApp(caller().apps, app)

      const outsideApps = (app: string) =>
        new Refused({ message: notInApps(caller().apps ?? [], app) })

      let workspaceAdmin = false

      /**
       * workspace_create: a workspace made as the base host's picker makes one (base.ts decide), with the caller its first admin, and a
       * token for them there, since this connection stays on its own workspace.
       */
      const createWorkspace = Effect.fnUntraced(function* (text: string) {
        const trace = newTrace()
        const me = caller()

        if (me.apps !== null)
          return {
            status: 403,
            body: {
              error: `${notInApps(me.apps, "a new workspace")}; making workspaces is for an agent with every app`,
              code: "not_allowed" as const,
              trace,
            },
          }

        const fail = (status: number, code: ErrorCode, error: string) => ({
          status,
          body: { error, code, trace },
        })

        if (yield* remote(workspace().trialUnclaimed()))
          return fail(
            403,
            "not_allowed",
            `${me.workspaceName} is a trial nobody has claimed: give the person you're helping its claim_url first; once it's theirs, workspace_create works for them`,
          )

        const asked = Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))(
            text,
          ),
        )

        if (asked === undefined) return fail(400, "invalid", 'send {"name": "acme-labs"}')

        const slug = slugOf(asked.name)
        const name = Option.getOrUndefined(Schema.decodeUnknownOption(WorkspaceName)(slug))

        if (name === undefined)
          return fail(
            400,
            "invalid",
            workspaceNameProblem(asked.name, slug) ??
              `"${asked.name}" can't be a workspace name: use lowercase letters, digits and single dashes, like acme-labs`,
          )

        const identity = yield* remote(workspace().whoami(me.workspaceName, me.person)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WhoAmI)),
          Effect.orDie,
        )

        const viewer = { email: identity.person.email, name: identity.person.name }

        const lately = yield* apex.madeLately(viewer.email)

        if (lately >= WORKSPACES_PER_HOUR)
          return fail(
            429,
            "rate_limited",
            `${viewer.email} made ${lately} workspaces in the last hour, the most workspace_create allows: try again in an hour, or reuse one you made`,
          )

        const id = idOfNewWorkspace(name)
        const there = workspaces.getByName(id)

        const made =
          !(Runtime.hasFile("WorkspaceDO", id) && (yield* there.inUse())) &&
          (yield* apex.claim(name, viewer)) &&
          (yield* there.found(viewer))

        if (!made)
          return fail(
            409,
            "conflict",
            `${name} is another workspace's name, now or before: pick another (like ${name}-2)`,
          )

        const origin = new URL(me.origin)

        origin.hostname = [name, ...origin.hostname.split(".").slice(1)].join(".")

        const admission = yield* there.admit(viewer)

        if (admission?.kind !== "member")
          return yield* Effect.die(`${viewer.email} isn't in ${name}, which they just made`)

        const token = yield* remote(
          there.management(
            name,
            admission.person.id,
            "me/tokens/create",
            "POST",
            JSON.stringify({ label: `workspace_create from ${me.workspaceName}` }),
            trace,
            origin.origin,
            null,
          ),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ManagementAnswer)), Effect.orDie)

        yield* Effect.logInfo(`mcp: ${viewer.email} made the workspace ${name}`).pipe(
          Effect.annotateLogs({ trace, workspace: id }),
        )

        return {
          status: 201,
          body: {
            workspace: name,
            workspace_url: origin.origin,
            mcp_url: `${origin.origin}/mcp`,
            token: token.body["token"] ?? null,
            token_id: token.body["id"] ?? null,
            next: `This connection stays on ${me.workspaceName}. To work in ${name} (as ${viewer.email}), add mcp_url as an MCP server with the header "Authorization: Bearer <token>". Or POST JSON-RPC to it with that header and "Accept: application/json, text/event-stream": first {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"1"}}}, then each {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"people_invite","arguments":{...}}} with the mcp-session-id header the first answer had. The person you're helping opens workspace_url.`,
            trace,
          },
        }
      })

      const management = openManagement((route, method, body) =>
        route === "workspaces/create"
          ? createWorkspace(body)
          : remote(
              workspace().management(
                caller().workspaceName,
                caller().person,
                route,
                method,
                body,
                newTrace(),
                caller().origin,
                caller().apps,
              ),
            ).pipe(
              Effect.flatMap((answer) =>
                Schema.decodeUnknownEffect(ManagementAnswer)(answer).pipe(Effect.orDie),
              ),
            ),
      )

      const managementTools = Layer.effectDiscard(
        Effect.gen(function* () {
          const registry = yield* McpServer.McpServer

          for (const entry of management) {
            if (entry.emailSignIn && signIn !== "email") continue

            yield* registry.addTool({
              tool: entry.tool,
              annotations: entry.admin
                ? Context.make(McpSchema.EnabledWhen, () => workspaceAdmin)
                : Context.empty(),
              handle: entry.handle,
            })
          }
        }),
      ).pipe(Layer.provide(McpServer.McpServer.layer))

      /** Where people open an app (the workspace's frame); hostOf is where its page, data and webhooks are served. */
      const url = (app: string) => frameUrl(caller().origin, app)

      const hostOf = (app: string) => appOrigin(caller().origin, app)

      /** Where anyone opens an app whose live openbelt.json has "public", and what they reach there; null when it isn't public. */
      const publicOf = (app: string, config: AppConfig): typeof PublicView.Type =>
        publicHost === "" || config.public === undefined
          ? null
          : {
              url: publicUrl(caller().origin, app, caller().workspaceName, publicHost),
              reaches: reachesOf(config.public),
            }

      const deployAllowed = Effect.fnUntraced(function* () {
        const now = Date.now()

        const recent = (kv.get<ReadonlyArray<number>>(DEPLOYS_KEY) ?? []).filter(
          (at) => now - at < 3_600_000,
        )

        if (recent.length >= DEPLOYS_PER_HOUR) {
          const wait = Math.ceil(((recent[0] ?? now) + 3_600_000 - now) / 60_000)

          Runtime.recordRefused("rate", "deploys")
          yield* Effect.logWarning(
            `rate limit: ${caller().user} made ${recent.length} deploys in the last hour (OPENBELT_DEPLOYS_PER_HOUR); refused another`,
          )

          yield* new Refused({
            message: `you deployed ${recent.length} times in the last hour, the most one person may (OPENBELT_DEPLOYS_PER_HOUR): try again in ${wait} min. Batch changes into fewer deploys (deploy_app takes every changed file at once).`,
          })
        }

        kv.put(DEPLOYS_KEY, [...recent, now])
      })

      const appOf = Effect.fn("McpDO.appOf")(function* (app: string) {
        if (!mayUse(app)) return yield* outsideApps(app)

        const record = yield* workspace().app(app)

        if (record === null) {
          return yield* new Refused({
            message: `there's no app "${app}" in ${caller().workspaceName}. search({ query }) finds the ones that exist by what they do; deploy_app creates one.`,
          })
        }

        return { record, target: apps.getByName(record.id) }
      })

      /**
       * A page of the workspace's skills: on the first, the own skill of each of your 20 newest apps; then, a page at a time, the skills
       * apps ship in skills/ (the directory says which apps have any, so no other app wakes). Any app's own skill is still there
       * by its URI, skill://<app>/SKILL.md.
       */
      const listSkills = Effect.fnUntraced(function* (cursor: string | undefined) {
        const offset = cursor === undefined ? 0 : Number(cursor)

        if (!Number.isSafeInteger(offset) || offset < 0)
          return yield* new Refused({
            message: `"${cursor}" isn't a cursor this server gave: list again without one`,
          })

        const own =
          offset === 0
            ? (yield* workspace().ownApps(caller().user, OWN_SKILL_APPS)).filter((r) =>
                mayUse(r.name),
              )
            : []

        const skilled = yield* workspace().skilledApps(
          offset,
          SKILL_PAGE + 1,
          caller().apps ?? undefined,
        )

        const owned = yield* Effect.forEach(
          own,
          (r) => Effect.map(skillsOf(r.id, r.name), (entries) => entries.slice(0, 1)),
          { concurrency: 8 },
        )

        const shipped = yield* Effect.forEach(
          skilled.slice(0, SKILL_PAGE),
          (r) => Effect.map(skillsOf(r.id, r.name), (entries) => entries.slice(1)),
          { concurrency: 8 },
        )

        const seen = new Set<string>()

        const skills = [...owned.flat(), ...shipped.flat()].filter((e) =>
          seen.has(e.uri) ? false : (seen.add(e.uri), true),
        )

        return {
          skills,
          next: skilled.length > SKILL_PAGE ? String(offset + SKILL_PAGE) : undefined,
        }
      })

      const skillAt = Effect.fnUntraced(function* (uri: string) {
        const at = parseSkillUri(uri)

        if (at === undefined)
          return yield* new Refused({
            message: `"${uri}" isn't a skill's URI: they look like skill://<app>/SKILL.md or skill://<app>/<skill>/SKILL.md`,
          })

        if (!mayUse(at.app)) return yield* outsideApps(at.app)

        const record = yield* workspace().app(at.app)

        if (record === null)
          return yield* new Refused({
            message: `there's no app "${at.app}" in ${caller().workspaceName}, so no skill at ${uri}; skills lists those there are`,
          })

        return { ...at, record }
      })

      /** One skill's entry by its SKILL.md's URI (listed or not). */
      const getSkill = Effect.fnUntraced(function* (uri: string) {
        const { record } = yield* skillAt(uri)
        const found = (yield* apps.getByName(record.id).skills()).find((e) => e.uri === uri)

        if (found === undefined)
          return yield* new Refused({
            message: `${record.name} has no skill at ${uri}: app_info({ app: "${record.name}" }) lists its skills`,
          })

        return found
      })

      /** One file of a skill, by its URI. */
      const readSkill = Effect.fnUntraced(function* (uri: string) {
        const { record, path } = yield* skillAt(uri)
        const file: SkillFile | null = yield* apps.getByName(record.id).skillFile(path)

        if (file === null)
          return yield* new Refused({
            message: `${record.name} has no skill file at ${uri}: a skill's files are listed in its entry (skills/get, or the skills tool with its SKILL.md's uri)`,
          })

        return file
      })

      /** The extension's three methods, answered here: Effect's MCP server only routes the methods its protocol versions know. */
      const answerSkills = Effect.fnUntraced(function* (
        rpc: NonNullable<ReturnType<typeof skillRpcOf>>,
      ) {
        const uri = rpc.params?.uri ?? ""

        const done = yield* Match.value(rpc.method).pipe(
          Match.when("skills/list", () =>
            Effect.map(listSkills(rpc.params?.cursor), ({ skills, next }): SkillResult =>
              next === undefined ? { skills } : { skills, nextCursor: next },
            ),
          ),
          Match.when("skills/get", () =>
            Effect.map(getSkill(uri), (skill): SkillResult => ({ skill })),
          ),
          Match.when("resources/read", () =>
            Effect.map(readSkill(uri), (file): SkillResult => ({ contents: [file] })),
          ),
          Match.exhaustive,
          Effect.result,
        )

        return Result.match(done, {
          onSuccess: (result) => skillResult(rpc.id, result),
          onFailure: (e) => skillError(rpc.id, -32602, e.message),
        })
      })

      const mayManage = Effect.fnUntraced(function* (
        owners: ReadonlyArray<string>,
        what: string,
        doing: string,
      ) {
        const me = owners.includes(caller().user)
          ? undefined
          : yield* remote(workspace().whoami(caller().workspaceName, caller().person))

        if (me !== undefined && me.person.role !== "admin")
          yield* new Refused({
            message: `only ${owners.join(" or ")} (who ${owners.length === 1 ? "owns" : "own"} ${what}) or a workspace admin (${me.admins.join(", ")}) may ${doing}: ask one of them`,
          })
      })

      const testGroupsAllowed = Effect.fnUntraced(function* (
        app: string,
        owner: string,
        together: ReadonlyArray<string>,
        people: ReadonlyArray<Person>,
      ) {
        const asked = [...new Set(people.flatMap((p) => p.groups))]

        if (asked.length === 0) return

        const me = yield* remote(workspace().whoami(caller().workspaceName, caller().person))

        if (me.person.role === "admin") return

        const others = together.filter((other) => other !== app)

        const owners = yield* Effect.forEach(others, (other) =>
          Effect.map(workspace().app(other), (r) => ({ app: other, owner: r?.owner })),
        )

        const notMine = owners.filter((o) => o.owner !== caller().user).map((o) => o.app)

        if (owner === caller().user && notMine.length === 0) return

        const refused = asked.filter((group) => !me.groups.includes(group))

        if (refused.length === 0) return

        const why =
          owner !== caller().user
            ? `you don't own ${app} (${owner} does)`
            : `the preview environment also holds ${notMine.join(", ")}, which you don't own`

        yield* new Refused({
          message: `test people's groups ${refused.map((g) => `"${g}"`).join(", ")} refused: you aren't in ${refused.length === 1 ? "it" : "them"}, and ${why}. A function trusts caller.groups, and in a preview it has the real secrets and connections, so a test person is only in groups you're in yourself, unless you own every app the check reaches or are a workspace admin (${me.admins.join(", ")}). Give them groups you're in, or ask the owner or an admin to run this check`,
        })
      })

      const describe = Effect.fnUntraced(function* (app: string, id: string) {
        const { description } = yield* apps.getByName(id).config()

        if (description !== undefined) yield* workspace().describe(app, description)
      })

      /** The refusal for an environment that doesn't exist, naming the ones that do (the most recently used first). */
      const noEnvironment = Effect.fn("McpDO.noEnvironment")(function* (env: string) {
        const there = (yield* workspace().environments()).map((e) => e.env)

        const named =
          there.length === 0
            ? "it has none"
            : `it has ${there.slice(0, ENVS_NAMED).join(", ")}${there.length > ENVS_NAMED ? ` and ${there.length - ENVS_NAMED} more` : ""}`

        return new Refused({
          message: `there's no preview environment "${env}" in ${caller().workspaceName} (${named}): deploy_app with preview: "${env}" makes it`,
        })
      })

      const inEnv = Effect.fn("McpDO.inEnv")(function* (app: string, id: string, env: string) {
        const version = yield* apps.getByName(id).envVersion(env)

        if (version === undefined) {
          return yield* new Refused({
            message: `${app} isn't deployed into preview environment "${env}", so it has no data or page there (pages in "${env}" read its live data, read-only). To use it in "${env}", ${joinHint(app, env)}`,
          })
        }

        return version
      })

      const whereOf = Effect.fnUntraced(function* (
        app: string,
        id: string,
        preview: string | boolean | undefined,
      ) {
        const env = yield* envOf(preview)

        if (env !== undefined) yield* inEnv(app, id, env)

        return env
      })

      const actingAs = Effect.fnUntraced(function* (
        app: string,
        env: string | undefined,
        as: string | undefined,
      ) {
        if (as === undefined) return actorOf(caller().user, undefined)

        yield* testPeopleIn(app, env, [as])

        return actorOf(caller().user, { author: testEmail(as, app), name: testName(as) })
      })

      const writeBatch = Effect.fnUntraced(function* (
        app: string,
        collection: string,
        writes: ReadonlyArray<BatchWrite>,
        preview: string | boolean | undefined,
        as: string | undefined,
        many: boolean,
      ) {
        const trace = newTrace()
        const { record, target } = yield* appOf(app)
        const env = yield* whereOf(app, record.id, preview)
        const kept = writes.some((w) => (w.author ?? w.updatedBy) !== undefined)

        if (as !== undefined && kept) {
          return yield* new Refused({
            message: `author and updatedBy are for moving data as the workspace: they keep who wrote it. With as, the write is ${testEmail(as, app)}'s own, judged by the rules: leave them out, or drop as.`,
          })
        }

        const by = yield* actingAs(app, env, as)

        yield* ownedRefusal(target, env, as, collection, [
          ...new Set(writes.flatMap((w) => RULE_OPS_OF[w.op])),
        ])

        const written = yield* remote(target.writeMany(env, collection, writes, by, trace))

        yield* wrote(env)

        const [doc] = written

        return many || doc === undefined
          ? { written: written.length, docs: written.map((d) => ({ id: d.id, seq: d.seq })), trace }
          : { ...doc, trace }
      })

      const ownedRefusal = Effect.fnUntraced(function* (
        target: ReturnType<typeof apps.getByName>,
        env: string | undefined,
        as: string | undefined,
        collection: string,
        ops: ReadonlyArray<"create" | "update" | "delete">,
      ) {
        if (env !== undefined || as !== undefined) return

        const owned = yield* target.ownedByFunctions(collection, ops, "a direct write from MCP")

        if (owned !== undefined) yield* new Refused({ message: owned })
      })

      const usedNoted = new Set<string>()

      /** Tell the workspace's directory you ran one of `app`'s functions (once per app while this object is awake), so search ranks it. */
      const noteUse = (app: string) =>
        usedNoted.has(app)
          ? Effect.void
          : workspace()
              .appUsed(app, caller().person)
              .pipe(
                Effect.tap(() => Effect.sync(() => usedNoted.add(app))),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`use of ${app} wasn't recorded`, cause),
                ),
              )

      const callAsAgent = Effect.fnUntraced(function* (params: {
        readonly app: string
        readonly function: string
        readonly input?: Json | undefined
        readonly key?: string | undefined
        readonly as?: "schedule" | "webhook" | "data" | "later" | undefined
        readonly preview?: string | boolean | undefined
      }) {
        const trace = newTrace()
        const input = params.input ?? null
        const size = new TextEncoder().encode(JSON.stringify(input)).length

        if (size > FUNCTION_LIMITS.inputBytes) {
          return yield* new Refused({
            message: `input is ${size} bytes of JSON; a function's input is at most ${FUNCTION_LIMITS.inputBytes / 1000} KB. Send less, or have the function read it from a collection.`,
          })
        }

        const { record, target } = yield* appOf(params.app)
        const env = yield* whereOf(params.app, record.id, params.preview)
        const user = caller().user

        const { groups } = yield* remote(
          workspace().whoami(caller().workspaceName, caller().person),
        )

        if (params.as !== undefined)
          yield* mayManage([record.owner], params.app, `run its functions as "${params.as}"`)

        const ran = yield* remote(
          target.call(env, params.function, input, { email: user, name: user, groups }, trace, {
            as: params.as,
            key: params.key,
          }),
        )

        yield* wrote(env)

        if (ran.ok && env === undefined && params.as === undefined) yield* noteUse(params.app)

        if (!ran.ok) {
          const logs = ran.logs.map((l) => `${l.level}: ${l.text}`).join("\n")
          const tries = ran.attempts > 1 ? ` (${ran.attempts} attempts)` : ""

          const committed = DIDNT_RUN.has(ran.kind)
            ? "it didn't run"
            : "none of its writes were committed"

          return yield* new Refused({
            message: `${runFailed(params.function, params.app, ran.ms, tries, ran.kind)}, so ${committed}: ${ran.error}${logs === "" ? "" : `\nIts console:\n${logs}`}\n(run ${ran.run}: function_runs({ app: "${params.app}", function: "${params.function}" }) has its record, app_logs({ app: "${params.app}", trace: "${trace}" }) its log)`,
          })
        }

        const answer = {
          app: params.app,
          function: params.function,
          version: ran.version,
          result: ran.result,
          run: ran.run,
          attempts: ran.attempts,
          replayed: ran.replayed,
          ms: ran.ms,
          calls: ran.calls,
          logs: ran.logs,
          trace,
        }

        return ran.unread === undefined
          ? answer
          : { ...answer, note: unreadNote(params.function, ran.unread) }
      })

      const callConcurrently = Effect.fnUntraced(function* (params: {
        readonly app: string
        readonly function: string
        readonly inputs: ReadonlyArray<Json>
        readonly preview?: string | boolean | undefined
      }) {
        const trace = newTrace()
        const { record, target } = yield* appOf(params.app)
        const env = yield* whereOf(params.app, record.id, params.preview)
        const user = caller().user

        const { groups } = yield* remote(
          workspace().whoami(caller().workspaceName, caller().person),
        )

        const ran = yield* Effect.forEach(
          params.inputs,
          (input) =>
            remote(
              target.call(
                env,
                params.function,
                input,
                { email: user, name: user, groups },
                trace,
                {},
              ),
            ),
          { concurrency: "unbounded" },
        )

        yield* wrote(env)

        const runs = ran.map((r) =>
          r.ok
            ? { ok: true, result: r.result, attempts: r.attempts, run: r.run }
            : { ok: false, kind: r.kind, error: r.error, attempts: r.attempts, run: r.run },
        )

        const ok = runs.filter((r) => r.ok).length

        const notes = new Set(
          ran.flatMap((r) =>
            r.ok && r.unread !== undefined ? [unreadNote(params.function, r.unread)] : [],
          ),
        )

        const answer = {
          app: params.app,
          function: params.function,
          version: ran[0]?.version ?? "",
          result: { ok, failed: runs.length - ok },
          run: runs.map((r) => r.run).join(","),
          attempts: Math.max(...ran.map((r) => r.attempts)),
          replayed: false,
          runs,
          ms: Math.max(...ran.map((r) => r.ms)),
          calls: ran.reduce((n, r) => n + r.calls, 0),
          logs: ran.flatMap((r) => r.logs),
          trace,
        }

        return notes.size === 0 ? answer : { ...answer, note: [...notes].join(" ") }
      })

      const codeApp = Effect.fnUntraced(function* (name: string, env: string | undefined) {
        if (!mayUse(name))
          return yield* Effect.fail(thrown(outsideApps(name).message, 403, "not_allowed"))

        const record = yield* workspace().app(name)

        if (record === null)
          return yield* Effect.fail(
            thrown(
              `there's no app "${name}" in this workspace: await workspace.search("what you need") finds what there is`,
              404,
              "missing",
            ),
          )

        const target = apps.getByName(record.id)

        if (env !== undefined && (yield* target.envVersion(env)) === undefined)
          return yield* Effect.fail(
            thrown(
              `${name} isn't deployed into preview environment "${env}", so code there can't use it (a preview never changes live data). To use it in "${env}", ${joinHint(name, env)}`,
            ),
          )

        return target
      })

      const codeFn = Effect.fnUntraced(function* (
        op: Extract<WorkspaceOp, { op: "fn" }>,
        env: string | undefined,
        trace: string,
        notes: Set<string>,
      ) {
        const target = yield* codeApp(op.app, env)
        const user = caller().user

        const { groups } = yield* remote(
          workspace().whoami(caller().workspaceName, caller().person),
        ).pipe(asThrown)

        const ran = yield* remote(
          target.call(env, op.fn, op.input, { email: user, name: user, groups }, trace, {}),
        ).pipe(
          Effect.mapError((e) =>
            thrown(
              `${codePath("workspace.apps", op.app, "fn", op.fn)}: ${e.message}`,
              404,
              "missing",
            ),
          ),
        )

        if (!ran.ok) {
          const called = codePath("workspace.apps", op.app, "fn", op.fn)

          return yield* Effect.fail(
            Match.value(ran.kind).pipe(
              Match.when("bad_input", () =>
                thrown(`${called} refused (bad_input): ${ran.error}`, 400, "bad_input"),
              ),
              Match.when("not_callable", () =>
                thrown(`${called} refused (not_callable): ${ran.error}`, 403, "not_callable"),
              ),
              Match.orElse((kind) =>
                thrown(`${called} failed (${kind}): ${ran.error}`, 500, "function_failed"),
              ),
            ),
          )
        }

        if (env === undefined) yield* noteUse(op.app)

        if (ran.unread !== undefined)
          notes.add(unreadNote(`workspace.apps${member(op.app)}.fn${member(op.fn)}`, ran.unread))

        return ran.result
      })

      const codeData = Effect.fnUntraced(function* (
        op: Extract<WorkspaceOp, { op: "data" }>,
        env: string | undefined,
        trace: string,
      ) {
        const target = yield* codeApp(op.app, env)
        const { call } = op
        const collection = call.collection ?? ""
        const id = call.id ?? ""
        const data = call.data ?? null

        switch (call.op) {
          case "collections":
            return (yield* target.listing()).collections
          case "list":
            return yield* remote(
              target.list(env, collection, {
                limit: Math.min(Math.max(Math.trunc(call.limit ?? 50), 1), 1000),
                cursor: call.cursor ?? undefined,
              }),
            ).pipe(asThrown)
          case "get":
            return yield* target.get(env, collection, id)
          default:
            break
        }

        if (env === undefined) {
          const owned = yield* target.ownedByFunctions(
            collection,
            RULE_OPS_OF[call.op],
            "a write from execute",
          )

          if (owned !== undefined) return yield* Effect.fail(thrown(owned, 403, "denied"))
        }

        const actor = actorOf(caller().user, undefined)

        if (call.op === "delete")
          return yield* remote(target.remove(env, collection, id, actor, trace)).pipe(asThrown)

        const write: BatchWrite = Match.value(call.op).pipe(
          Match.when("add", (): BatchWrite => ({ op: "add", data })),
          Match.when("set", (): BatchWrite => ({ op: "set", id, data, ifSeq: call.ifSeq })),
          Match.orElse((): BatchWrite => ({ op: "update", id, patch: data, ifSeq: call.ifSeq })),
        )

        const [doc] = yield* remote(target.writeMany(env, collection, [write], actor, trace)).pipe(
          asThrown,
        )

        return doc ?? null
      })

      const codeTool = Effect.fnUntraced(function* (
        op: Extract<WorkspaceOp, { op: "tool" }>,
        trace: string,
      ) {
        const qualified = `${op.connection}.${op.tool}`
        const shown = codePath("workspace.connections", op.connection, op.tool)

        const called = yield* workspace().connectionCall(
          caller().person,
          qualified,
          op.input,
          undefined,
          trace,
          caller().origin,
        )

        if (called.kind === "not_run")
          return yield* Effect.fail(
            thrown(
              `${shown} ${called.outcome === "refused" ? "was refused by OpenBelt" : "failed: its server didn't answer"}: ${called.message}`,
              403,
              "not_allowed",
            ),
          )

        if (called.outcome === "tool_error")
          return yield* Effect.fail(
            thrown(
              `${shown}: the server says it failed: ${textOf(called.result)}`,
              502,
              "upstream_failed",
            ),
          )

        return toolValue(called.result.structuredContent, textOf(called.result))
      })

      const codeDescribe = Effect.fnUntraced(function* (path: string, env: string | undefined) {
        const names = pathNames(path)
        const [root = "", name = "", what = "", item = ""] = names
        const shown = root === "" ? "" : codePath(root, ...names.slice(1))

        if (root === "connections" && name !== "" && what !== "") {
          const named = names.slice(2).join(".")

          const [view] = yield* remote(
            workspace().connections(caller().person, caller().origin, name, {
              search: named,
              past: Number.POSITIVE_INFINITY,
            }),
          ).pipe(asThrown)

          const tool = view?.tools.find((t) => t.tool === `${name}.${named}`)

          if (tool !== undefined)
            return {
              path: codePath("connections", name, named),
              ...tool,
              call: `await ${codePath("workspace.connections", name, named)}({ ... })`,
            }
        }

        if (root !== "apps" || name === "") {
          const found = (yield* catalog(
            root === "connections" ? [] : yield* workspace().recentApps(CATALOG_APPS),
          )).filter(
            (e) =>
              shown !== "" &&
              (e.path === shown ||
                e.path.startsWith(`${shown}.`) ||
                e.path.startsWith(`${shown}[`)),
          )

          if (found.length === 0)
            return yield* Effect.fail(
              thrown(
                `nothing at "${path}": paths are apps.<app>, apps.<app>.fn.<name>, apps.<app>.collection.<name>, connections.<connection>.<tool>, a name that isn't an identifier in brackets (apps["my-app"].fn.<name>); await workspace.search("what you need") lists them`,
                404,
                "missing",
              ),
            )

          return found
        }

        const target = yield* codeApp(name, env)
        const { collections } = yield* target.listing()
        const functions = yield* target.functionsWithInput()

        if (what === "fn") {
          const f = functions.find((x) => x.name === item)

          if (f === undefined)
            return yield* Effect.fail(
              thrown(
                `${name} has no function "${item}": it has ${functions.map((x) => x.name).join(", ") || "none"}`,
                404,
                "missing",
              ),
            )

          return {
            path: codePath("apps", name, "fn", item),
            about: f.about,
            kind: f.kind,
            signature: f.signature,
            call: `await ${codePath("workspace.apps", name, "fn", item)}(input)`,
            input: schemaJson(f.input),
          }
        }

        if (what === "collection") {
          const c = collections.find((x) => x.name === item)

          if (c === undefined)
            return yield* Effect.fail(
              thrown(
                `${name} has no collection "${item}": it has ${collections.map((x) => x.name).join(", ") || "none"}`,
                404,
                "missing",
              ),
            )

          const [newest] = (yield* target
            .list(env, item, { limit: 1, cursor: undefined })
            .pipe(Effect.orElseSucceed(() => ({ docs: [] })))).docs

          return {
            path: codePath("apps", name, "collection", item),
            ...c,
            newest: newest === undefined ? null : newest.data,
            methods:
              "list({ limit, cursor }) → { docs: [{ id, data, seq, author, ... }], cursor }; get(id); add(data); set(id, data, { ifSeq }); update(id, patch, { ifSeq }); delete(id, { ifSeq })",
          }
        }

        return {
          path: codePath("apps", name),
          functions: functions.map((f) => ({
            name: f.name,
            about: f.about,
            kind: f.kind,
            signature: f.signature,
          })),
          collections,
        }
      })

      const codeFetch = Effect.fnUntraced(function* (
        op: Extract<WorkspaceOp, { op: "fetch" }>,
        trace: string,
      ) {
        const target = URL.canParse(op.url) ? new URL(op.url) : undefined
        const home = new URL(caller().origin)
        const name = target === undefined ? undefined : appOfHost(target.host, home.host)

        if (target === undefined || name === undefined || !inWorkspace(target, home))
          return yield* Effect.fail(
            thrown(
              `fetch in execute reaches only this workspace's app hosts (like ${appUrl(caller().origin, "<app>")}), as an outside sender would: to test a webhook or a page's call end to end. A function fetches the outside world (openbelt.json "network")`,
            ),
          )

        if (!mayUse(name))
          return yield* Effect.fail(thrown(outsideApps(name).message, 403, "not_allowed"))

        const record = yield* workspace().app(name)

        if (record === null)
          return yield* Effect.fail(
            thrown(`there's no app "${name}" in this workspace`, 404, "missing"),
          )

        const headers = outsideHeaders(op.headers)

        headers.set("x-openbelt-trace", trace)
        headers.set("x-openbelt-path", target.pathname.slice(1))
        headers.set(AUDIENCE_HEADER, "workspace")

        const sent = new Request(`http://app.internal${target.pathname}${target.search}`, {
          method: op.method,
          headers,
          body: op.method === "GET" || op.method === "HEAD" ? null : op.body,
        })

        const answered = HttpServerResponse.toWeb(
          yield* apps
            .getByName(record.id)
            .fetch(fromWeb(sent))
            .pipe(
              Effect.mapError(() =>
                thrown(`fetch ${target.host}: the app didn't answer`, 502, "internal"),
              ),
            ),
        )

        const body = yield* Effect.promise(() => answered.text())

        return {
          status: answered.status,
          statusText: answered.statusText,
          headers: Object.fromEntries(answered.headers),
          body,
        }
      })

      /** `notes` collects what the run's calls were told beside their results (execute's note). */
      const workspaceAnswer = Effect.fnUntraced(function* (
        op: WorkspaceOp,
        env: string | undefined,
        trace: string,
        notes: Set<string>,
      ) {
        const answered: Json = yield* Match.value(op).pipe(
          Match.discriminatorsExhaustive("op")({
            me: () =>
              Effect.map(
                remote(workspace().whoami(caller().workspaceName, caller().person)).pipe(asThrown),
                (me) => ({
                  email: caller().user,
                  name: me.person.name,
                  groups: [...me.groups],
                }),
              ),
            fn: (call) => codeFn(call, env, trace, notes),
            data: (call) => codeData(call, env, trace),
            tool: (call) => codeTool(call, trace),
            search: ({ query }) =>
              Effect.map(
                Effect.flatMap(
                  searchWords(query).length === 0
                    ? workspace().recentApps(CATALOG_APPS)
                    : workspace().findApps(query, CATALOG_APPS, "any"),
                  (records) => catalog(records.filter((r) => mayUse(r.name))),
                ),
                (entries) => {
                  const words = searchWords(query)

                  return entries
                    .filter(
                      (e) =>
                        words.length === 0 ||
                        words.some((w) => `${e.path} ${e.about}`.toLowerCase().includes(w)),
                    )
                    .slice(0, 30)
                },
              ),
            describe: ({ path }) => codeDescribe(path, env),
            fetch: (call) => codeFetch(call, trace),
          }),
        )

        return answered
      })

      /**
       * The few apps best matching `query`, from the workspace's directory, each with its collections and functions: yours (you made it
       * or ran its functions) and the ones many people use first, among those that match as well.
       */
      const foundApps = Effect.fnUntraced(function* (query: string, limit: number) {
        const records = (yield* workspace().findApps(query, limit, "rare", {
          owner: caller().user,
          person: caller().person,
        })).filter((r) => mayUse(r.name))

        return yield* Effect.forEach(
          records,
          (r) => Effect.map(apps.getByName(r.id).listing(), (l) => ({ r, ...l })),
          { concurrency: 8 },
        )
      })

      /**
       * What code mode's workspace.search and describe list: the apps given (those a search found, or the ones updated most recently;
       * never every app, which a workspace of thousands can't afford) and the connections.
       */
      const catalog = Effect.fnUntraced(function* (
        records: ReadonlyArray<{ readonly id: string; readonly name: string }>,
      ) {
        const listed = yield* Effect.forEach(
          records,
          (r) => Effect.map(apps.getByName(r.id).listing(), (l) => ({ r, ...l })),
          { concurrency: 8 },
        )

        const views = yield* remote(
          workspace().connections(caller().person, caller().origin, undefined),
        ).pipe(Effect.orElseSucceed(() => []))

        return [
          ...listed.flatMap(({ r, collections, functions }) => [
            ...functions.map((f) => ({
              path: codePath("apps", r.name, "fn", f.name),
              kind: f.kind,
              about: f.about,
              signature: f.signature,
              call: `await ${codePath("workspace.apps", r.name, "fn", f.name)}(input)`,
            })),
            ...collections.map((c) => ({
              path: codePath("apps", r.name, "collection", c.name),
              kind: "collection",
              about: `${c.about ?? "(not described)"}; ${c.docs} documents`,
              signature: "",
              call: `await ${codePath("workspace.apps", r.name)}.collection(${JSON.stringify(c.name)}).list({ limit: 100 })`,
            })),
          ]),
          ...views.flatMap((v) =>
            v.tools.map((t) => ({
              path: toolPath("connections", t.tool),
              kind: "tool",
              about: `${t.description ?? ""}${t.usable ? "" : ` (you can't use it: ${t.why ?? ""})`}`,
              signature: "",
              call: `await ${toolPath("workspace.connections", t.tool)}({ ... })`,
            })),
          ),
        ]
      })

      const wrote = Effect.fnUntraced(function* (env: string | undefined) {
        if (env !== undefined) yield* workspace().touch(env, caller().user)
      })

      const previewUrl = (app: string, env: string) => appUrl(caller().origin, app, env)

      /** Who can open what was just deployed: per the sign-in, or nobody yet in a trial workspace nobody has claimed (trials.ts). */
      const reach = Effect.fnUntraced(function* () {
        if (yield* workspace().trialUnclaimed())
          return `Nobody can open it yet: this is a trial workspace nobody has claimed. Once the person you're helping claims it (the claim_url /_trial gave you), they, and whoever they invite, can open it at ${new URL(caller().origin).hostname}/<app>, signed in as themselves. Until then try it with check_app.`

        return reachOf(caller().origin, signIn)
      })

      const handlers = Tools.toLayer({
        docs: (asked) => guide.docsFor(asked),

        skills: Effect.fn("tool.skills")(function* ({ uri, cursor }) {
          if (uri === undefined) {
            const { skills, next } = yield* listSkills(cursor)

            return {
              skills: skills.map((k) => ({
                uri: k.uri,
                name: k.frontmatter.name,
                description: k.frontmatter.description,
                files: k.resources.length,
              })),
              next: next ?? null,
              file: null,
              note: `${skills.length === 0 ? "None listed: no app ships a skill in skills/, and you have no apps of your own. " : "skills({ uri }) reads one. "}Every app has its own skill on how to use it, listed or not: skills({ uri: "skill://<app>/SKILL.md" }).`,
              trace: newTrace(),
            }
          }

          const read = yield* readSkill(uri)

          const entry = uri.endsWith(`/${SKILL_FILE}`)
            ? yield* getSkill(uri).pipe(Effect.option)
            : Option.none()

          const files = Option.match(entry, {
            onNone: () => [],
            onSome: (e) => e.resources.filter((r) => r.uri !== uri).map((r) => r.uri),
          })

          return {
            skills: [],
            next: null,
            file: {
              uri,
              mimeType: read.mimeType,
              text: "text" in read ? read.text : null,
              base64: "blob" in read ? read.blob : null,
              files,
            },
            note:
              files.length === 0
                ? "Follow it as written; a relative link in it is a file of the same skill (skills({ uri }) with its skill:// URI)."
                : "Follow it as written; read one of its files with skills({ uri }) when it says to.",
            trace: newTrace(),
          }
        }),

        feedback_submit: Effect.fn("tool.feedback_submit")(function* (report) {
          const me = caller()

          const calls = yield* remote(workspace().recentToolCalls(me.user, 20))

          const stored = yield* apex.feedbackSubmit({
            workspace: me.workspace,
            person: me.user,
            category: report.category,
            summary: report.summary,
            goal: report.goal,
            details: report.details,
            tool: report.tool ?? "",
            calls: JSON.stringify(calls),
          })

          if (stored.kind === "limited")
            return yield* new Refused({
              message: `this workspace sent ${stored.count} reports in the last 24 hours, the most feedback_submit takes: carry on with the task`,
            })

          return {
            id: `FB-${stored.id}`,
            message: "Received. Carry on with the task; don't wait for an answer.",
            trace: newTrace(),
          }
        }),

        whoami: Effect.fn("tool.whoami")(function* () {
          return {
            ...(yield* remote(workspace().whoami(caller().workspaceName, caller().person))),
            trace: newTrace(),
          }
        }),

        connections: Effect.fn("tool.connections")(function* ({ connection, search: asked }) {
          const search = asked?.trim() === "" ? undefined : asked

          if (search === undefined && connection === undefined) {
            const count = yield* remote(workspace().connectionCount())

            if (count > LISTED_MAX)
              return {
                connections: [],
                note: `This workspace has ${count} connections (APIs and MCP servers), too many to list here: search them by what you need, connections({ search: "weather forecast" }), which lists the few that match with their tools; connections({ connection: "<name>" }) shows one.`,
                trace: newTrace(),
              }
          }

          if (search !== undefined && connection === undefined) {
            const found = (yield* remote(
              workspace().findConnections(caller().person, caller().origin, search, FOUND),
            )).map((f) => f.view)

            const addable = yield* remote(workspace().catalogFor(search, 3))

            const said =
              found.length > 0
                ? `connections({ connection: "<name>", search: "${search.slice(0, 60).replaceAll('"', "'")}" }) gives a tool's input schema; connection_call runs it, and an app's pages call it with tools.call once openbelt.json lists it under "tools".`
                : `No connection matches "${search.slice(0, 60)}": try other words for its data or service.${addable.length === 0 ? "" : " OpenBelt's catalog has what may fit (notAdded): use connection_add if available to you; otherwise ask a workspace admin to add one."} If nothing fits, build without one.`

            return addable.length === 0
              ? { connections: found, note: said, trace: newTrace() }
              : { connections: found, notAdded: addable, note: said, trace: newTrace() }
          }

          const seen = yield* remote(
            workspace().connections(caller().person, caller().origin, connection, {
              search,
              past: TOOLS_LISTED,
            }),
          )

          return {
            connections: seen,
            note:
              seen.length === 0
                ? "The workspace has no connections yet: a workspace admin adds one in Settings, Connections (docs/connections.md)."
                : 'connection_call({ tool: "<connection>.<tool>", input }) runs a usable tool. If a connection signs in with OAuth, send the person the link in its connect; they open it and sign in. Never ask anyone for a token: for one that takes a pasted token, the person sets it themselves (setYourToken says how): never paste a token into a chat.',
            trace: newTrace(),
          }
        }),

        deploy_app: Effect.fn("tool.deploy_app")(function* (params) {
          const { app, description, base_version, keep_others, seed, note } = params
          const trace = newTrace()

          const problem = appNameProblem(app) ?? hostProblem(app, caller().workspaceName)

          if (problem !== undefined) return yield* new Refused({ message: problem })

          const env = yield* envOf(params.preview)

          if (env === undefined && (seed !== undefined || note !== undefined)) {
            return yield* new Refused({
              message: `${seed === undefined ? "note" : 'seed: "live"'} goes with preview: "<env>": it's about the preview environment you deploy into`,
            })
          }

          yield* deployAllowed()

          if (!mayUse(app)) return yield* outsideApps(app)

          const before = env === undefined ? null : yield* workspace().environment(env)

          const theirs =
            before === null
              ? []
              : (yield* Effect.forEach(before.apps, (other) =>
                  Effect.map(workspace().app(other), (r) => ({ app: other, owner: r?.owner })),
                )).filter(
                  (o): o is { app: string; owner: string } =>
                    o.owner !== undefined && o.owner !== caller().user,
                )

          const record = yield* remote(
            workspace().claim(
              app,
              caller().user,
              caller().person,
              description,
              caller().apps,
              true,
            ),
          )

          // A first deploy settles its claim: refused (a typed failure: nothing was written), the name goes back unless another
          // deploy of it at once lands. One that died or was cut off may have landed, so it keeps the name.
          const { review, ...deployed } = yield* remote(
            apps.getByName(record.id).deploy(
              app,
              {
                files: params.files,
                keepOthers: keep_others === true,
                remove: params.delete ?? [],
                edits: params.edits ?? [],
                base: base_version,
                env,
                by: caller().user,
                trace,
              },
              seed === "live",
              { workspace: caller().workspace, origin: caller().origin },
            ),
          ).pipe(
            Effect.onExit((exit) =>
              record.first
                ? workspace().settle(
                    app,
                    record.id,
                    !(
                      Exit.isFailure(exit) &&
                      Cause.hasFails(exit.cause) &&
                      !Cause.hasDies(exit.cause) &&
                      !Cause.hasInterrupts(exit.cause)
                    ),
                  )
                : Effect.void,
            ),
          )

          const diff =
            review === undefined
              ? {}
              : {
                  diff: diffPage(review.text, 0, DEPLOY_DIFF, (offset) =>
                    appDiffCall(app, review.from, deployed.version, review.paths, offset),
                  ).text,
                }

          const deployedConfig = yield* apps.getByName(record.id).config(deployed.version)
          const { rules, tools } = deployedConfig
          const unset = yield* apps.getByName(record.id).unsetSecrets(deployed.version)
          const widenedSecrets = yield* apps.getByName(record.id).widenedSecrets(deployed.version)

          const unclaimed = yield* workspace().trialUnclaimed()

          const outside =
            (deployedConfig.network ?? []).length > 0 ||
            Object.keys(deployedConfig.uses ?? {}).length > 0

          const warnings = [
            ...(env !== undefined && before !== null && theirs.length > 0
              ? [
                  `preview ${env} was already someone else's work in progress: ${theirs.map((o) => `${o.owner} deployed ${o.app}`).join(", ")} (last deploy or write ${before.lastWrite}${before.note === "" ? "" : `; the environment's note: "${before.note}"`}). If your change isn't part of theirs, deploy it into an environment of its own (a new name).`,
                ]
              : []),
            ...(signIn === "off" ? signedOutWarnings(rules ?? {}) : []),
            ...(tools === undefined ? [] : yield* remote(workspace().toolWarnings(tools))),
            ...unset.map(
              (secret) =>
                `the secret ${secret} isn't set yet, so a function that sends it is refused: set_secret({ app: "${app}", name: "${secret}", value }) with the value the person gives you (never in a file)`,
            ),
            ...widenedSecrets,
            ...(yield* apps.getByName(record.id).exposedFunctions(deployed.version)),
            ...(yield* apps.getByName(record.id).sdkMisuse(deployed.version, deployed.changed)),
            ...(env !== undefined && outside && !(yield* workspace().previewLive(env))
              ? [
                  `in preview ${env}, what its functions send that changes things outside (a fetch other than GET, a connection tool that isn't read-only) is checked and logged, then answered { previewed: true } instead of sent: the servers are the real ones. GETs and read-only tools go out as usual. Live, everything is sent.`,
                ]
              : []),
            ...(deployedConfig.public !== undefined && publicHost !== "" && unclaimed
              ? [
                  'openbelt.json has "public", but this is a trial workspace nobody has claimed, and none of its apps is public until someone claims it',
                ]
              : []),
            ...(deployedConfig.public !== undefined && publicHost === ""
              ? [
                  'openbelt.json has "public", but this OpenBelt has no public host (OPENBELT_PUBLIC_HOST), so nothing of it is public here: it opens only for the workspace',
                ]
              : []),
            ...(deployedConfig.public !== undefined && publicHost !== "" && env !== undefined
              ? [
                  `a preview is never public: openbelt.json "public" applies once this version is live (promote_app), at ${publicUrl(caller().origin, app, caller().workspaceName, publicHost)}`,
                ]
              : []),
            ...(env !== undefined && Object.keys(deployedConfig.schedules ?? {}).length > 0
              ? [
                  `schedules run only on the live version, so none runs in preview ${env}: prove one now with call_function({ app: "${app}", function, preview: "${env}", as: "schedule" })`,
                ]
              : []),
          ]

          const warned = warnings.length === 0 ? {} : { warnings }

          if (env === undefined) {
            yield* describe(app, record.id)
            yield* apps.getByName(record.id).shootSoon(appUrl(caller().origin, app))

            return {
              app,
              url: url(app),
              host: hostOf(app),
              ...deployed,
              ...diff,
              ...warned,
              reach: yield* reach(),
              public: unclaimed ? null : publicOf(app, deployedConfig),
              trace,
            }
          }

          yield* workspace().join(env, record.id, caller().user, note)

          return {
            app,
            url: url(app),
            host: hostOf(app),
            ...deployed,
            ...diff,
            ...warned,
            env,
            previewUrl: previewUrl(app, env),
            reach: yield* reach(),
            public: null,
            trace,
          }
        }),

        promote_app: Effect.fn("tool.promote_app")(function* (params) {
          const { env, version } = params
          const trace = newTrace()

          if (env === undefined) {
            if (params.app === undefined || version === undefined || params.apps !== undefined) {
              return yield* new Refused({
                message:
                  'pass { apps: ["a", "b"], env: "triage" } to take what those apps run in a preview environment live together, or { app, version } for one version (a rollback)',
              })
            }
          } else if (version !== undefined || params.app !== undefined) {
            return yield* new Refused({
              message: `with env, name the apps in apps: [...] (even one) and leave out app and version: promote_app({ apps: ["${params.app ?? "a"}"], env: "${env}" })`,
            })
          }

          const names = params.apps ?? (params.app === undefined ? [] : [params.app])

          const targets = yield* Effect.forEach(names, (app) =>
            Effect.gen(function* () {
              yield* appOf(app)

              const record = yield* remote(
                workspace().claim(app, caller().user, caller().person, undefined, caller().apps),
              )

              if (env === undefined) return { app, id: record.id, chosen: version ?? "" }

              const chosen = yield* inEnv(app, record.id, env)
              const moved = yield* apps.getByName(record.id).movedSince(chosen)

              if (moved !== undefined) {
                return yield* new Refused({
                  message: `${app}'s live version changed since its version in "${env}" (${chosen}) was made from ${moved.anchor ?? "nothing live"}: ${moved.by} made ${moved.live} live at ${moved.at}. Promoting would undo that, so nothing was promoted. Bring their change into "${env}" first: deploy_app({ app: "${app}", preview: "${env}", keep_others: true }) puts your version on top of theirs (refused with a diff if you both changed a file), then check and promote again.`,
                })
              }

              return { app, id: record.id, chosen }
            }),
          )

          const done: Array<{ readonly id: string; readonly previous: string | null }> = []

          const promoted = yield* Effect.forEach(targets, ({ app, id, chosen }) =>
            Effect.gen(function* () {
              const result = yield* remote(apps.getByName(id).promote(chosen, caller().user, trace))

              done.push({ id, previous: result.previous })
              yield* describe(app, id)
              yield* apps.getByName(id).shootSoon(appUrl(caller().origin, app))

              return { app, url: url(app), ...result }
            }),
          ).pipe(
            Effect.tapError(() =>
              Effect.forEach(done, ({ id, previous }) =>
                apps.getByName(id).restore(previous, trace),
              ),
            ),
          )

          return { promoted, reach: yield* reach(), trace }
        }),

        app_delete: Effect.fn("tool.app_delete")(function* ({ app, confirm }) {
          const trace = newTrace()

          if (confirm !== app)
            return yield* new Refused({
              message: `confirm must be the app's name: app_delete({ app: "${app}", confirm: "${app}" }). Nothing was deleted.`,
            })

          yield* appOf(app)

          const { name } = yield* remote(
            workspace().deleteApp(app, { email: caller().user, name: caller().user }, trace),
          )

          return { deleted: name, trace }
        }),

        starter_list: Effect.fn("tool.starter_list")(function* () {
          const added = yield* remote(workspace().startersAdded())

          return {
            starters: STARTERS.map((s) => ({
              starter: s.name,
              description: s.description,
              added: added[s.name]?.app ?? null,
            })),
            trace: newTrace(),
          }
        }),

        starter_add: Effect.fn("tool.starter_add")(function* ({ starter, app }) {
          const trace = newTrace()
          const name = app ?? starter
          const problem = appNameProblem(name) ?? hostProblem(name, caller().workspaceName)

          if (problem !== undefined) return yield* new Refused({ message: problem })

          yield* deployAllowed()

          if (!mayUse(name)) return yield* outsideApps(name)

          const { added } = yield* remote(
            workspace().addStarter(
              starter,
              name,
              { email: caller().user, person: caller().person },
              caller().origin,
              trace,
            ),
          )

          const offered = STARTERS.find((s) => s.name === starter)?.next ?? null

          return {
            app: name,
            url: url(name),
            added,
            next: `${
              offered === null
                ? 'Send the person the url and one line: "Ask me for any change."'
                : `Send the person the url, then these next steps, exactly:\n\n${offered}\n\nWhen they pick one, do it, then offer the next steps again.`
            } To write to it as they watch, its skill (skill://${name}/SKILL.md) says how. Change it like any app, checked before it goes live: app_files({ app: "${name}" }), deploy_app with edits and preview: "<change>", check_app there as test people (people: ["alice", "bob"]; its controls show only to people signed in), then promote_app.`,
            trace,
          }
        }),

        preview_reset: Effect.fn("tool.preview_reset")(function* ({ env, app }) {
          const trace = newTrace()
          const problem = envNameProblem(env)

          if (problem !== undefined) return yield* new Refused({ message: problem })

          const found = yield* workspace().environment(env)

          if (found === null) return yield* yield* noEnvironment(env)

          if (app !== undefined && !found.apps.includes(app)) {
            return yield* new Refused({
              message: `${app} isn't in preview environment "${env}"; its apps are ${found.apps.join(", ")}`,
            })
          }

          const reset = yield* Effect.forEach(app === undefined ? found.apps : [app], (name) =>
            Effect.gen(function* () {
              const { target } = yield* appOf(name)
              const { deleted } = yield* target.resetEnv(env, trace)

              return { app: name, deleted }
            }),
          )

          yield* wrote(env)

          return { env, apps: reset, deleted: reset.reduce((n, r) => n + r.deleted, 0), trace }
        }),

        call_function: Effect.fn("tool.call_function")(function* (params) {
          if (params.inputs === undefined) return yield* callAsAgent(params)

          if (params.input !== undefined || params.key !== undefined || params.as !== undefined)
            return yield* new Refused({
              message:
                "inputs runs the function once per input, all at the same moment: send inputs alone, without input, key or as",
            })

          return yield* callConcurrently({ ...params, inputs: params.inputs })
        }),

        function_runs: Effect.fn("tool.function_runs")(function* (params) {
          const { target } = yield* appOf(params.app)

          return {
            runs: yield* target.runs({
              fn: params.function,
              limit: params.limit ?? 20,
              failed: params.failed ?? false,
              trace: params.trace,
            }),
            trace: newTrace(),
          }
        }),

        webhook_secret: Effect.fn("tool.webhook_secret")(function* (params) {
          const trace = newTrace()
          const { record, target } = yield* appOf(params.app)
          const env = yield* whereOf(params.app, record.id, params.preview)

          yield* mayManage([record.owner], params.app, "see or make its webhooks' secrets")

          const made = yield* remote(
            target.hookSecret(params.function, params.rotate ?? false, trace, env),
          )

          const base = `${hostOf(params.app)}${env === undefined ? "" : `/_preview/${encodeURIComponent(env)}`}/_hook/${params.function}`
          const shown = made.secret ?? "<the secret>"
          const header = made.header ?? ""
          const prefix = made.prefix ?? ""

          const { signing, test } = howSigned(made.verify, { header, prefix, base, shown })

          return {
            url: made.verify === "token" && made.secret !== null ? `${base}/${made.secret}` : base,
            verify: made.verify,
            header: made.header,
            secret: made.secret,
            made: made.at,
            signing:
              made.secret === null && made.at !== null
                ? `${signing} The secret was shown when it was made (${made.at}) and isn't shown again: rotate: true makes a new one.`
                : signing,
            test,
            trace,
          }
        }),

        set_secret: Effect.fn("tool.set_secret")(function* (params) {
          const trace = newTrace()
          const { record, target } = yield* appOf(params.app)

          yield* mayManage([record.owner], params.app, "set or remove its secrets")

          const done = yield* remote(
            target.setSecret(params.name, params.value, caller().user, trace, params.hosts),
          )

          const to = done.hosts === null || done.hosts.length === 0 ? null : done.hosts.join(", ")
          const listed = done.declared.includes(params.name)

          return {
            app: params.app,
            name: params.name,
            set: done.set,
            at: done.at,
            about: done.about,
            hosts: done.hosts,
            note: !done.set
              ? `${params.name} is removed: ctx.secrets.${params.name} now throws.`
              : `${to === null ? `It goes to no host: secrets.hmac("${params.name}", text) signs with it while "network" lists none` : `Its functions send it as ctx.secrets.${params.name} (a placeholder OpenBelt fills in on the way out), only to ${to}; secrets.hmac signs with it while "network" lists no other host`}${listed ? "" : ` (the live openbelt.json doesn't list it under "secrets" yet: add it and deploy before a function reads it)`}. An openbelt.json that sends it anywhere else stops it until it's set again. It isn't shown again; set it again to change it.`,
            trace,
          }
        }),

        webhook_test: Effect.fn("tool.webhook_test")(function* (params) {
          const trace = newTrace()
          const { record, target } = yield* appOf(params.app)
          const env = yield* whereOf(params.app, record.id, params.preview)

          yield* mayManage([record.owner], params.app, "send its webhooks test deliveries")

          const got = yield* target.hookTest(
            env,
            params.function,
            params.body,
            params.sign ?? "good",
            trace,
          )

          yield* wrote(env)

          if (!got.secretSet && (params.sign ?? "good") === "good" && got.status === 401) {
            return yield* new Refused({
              message: `the webhook ${params.function} has no secret yet${env === undefined ? "" : ` in preview ${env}`}, so its delivery was refused (401): webhook_secret({ app: "${params.app}", function: "${params.function}"${env === undefined ? "" : `, preview: "${env}"`} }) makes one`,
            })
          }

          return {
            status: got.status,
            body: got.body,
            run: got.run,
            replayed: got.replayed,
            sent: got.sent,
            trace,
          }
        }),

        execute: Effect.fn("tool.execute")(function* (params) {
          const trace = newTrace()
          const env = yield* envOf(params.preview)

          const notes = new Set<string>()

          const ran = yield* runCode({
            code: params.code,
            input: params.input ?? null,
            answer: (op) => workspaceAnswer(op, env, trace, notes),
            owner: { workspace: caller().workspace, person: caller().person },
          })

          if (env !== undefined) yield* wrote(env)

          const note = [...(ran.note === null ? [] : [ran.note]), ...notes].join(" ")

          return { ...ran, note: note === "" ? null : note, trace }
        }),

        preview_side_effects: Effect.fn("tool.preview_side_effects")(function* ({ env, send }) {
          const trace = newTrace()
          const problem = envNameProblem(env)

          if (problem !== undefined) return yield* new Refused({ message: problem })

          const found = yield* workspace().environment(env)

          if (found === null) return yield* yield* noEnvironment(env)

          const outside = found.apps.find((app) => !mayUse(app))

          if (outside !== undefined) return yield* outsideApps(outside)

          const owners = yield* Effect.forEach(found.apps, (app) =>
            Effect.map(workspace().app(app), (r) => r?.owner),
          )

          const others = [...new Set(owners.filter(Predicate.isString))].filter(
            (o) => o !== caller().user,
          )

          const me =
            others.length === 0
              ? undefined
              : yield* remote(workspace().whoami(caller().workspaceName, caller().person))

          if (me !== undefined && me.person.role !== "admin")
            yield* new Refused({
              message: `only a workspace admin (${me.admins.join(", ")}), or a person who owns every app in preview environment "${env}", may let its functions send for real, and ${others.join(", ")} ${others.length === 1 ? "owns" : "own"} apps in it too: ask an admin`,
            })

          yield* workspace().setPreviewLive(env, send, caller().user)

          return {
            env,
            send,
            note: send
              ? `Functions in preview ${env} now send POSTs and connection tools that change things for real, on the real servers (set by ${caller().user}), until another app joins it (then they're previewed again) or it expires. Tell the person you work for; send: false goes back to previewing them.`
              : `Functions in preview ${env} preview what changes things outside: it's checked and logged, and answered { previewed: true }, not sent.`,
            trace,
          }
        }),

        app_list: Effect.fn("tool.app_list")(function* ({ owner: asked, sort, limit, offset }) {
          const owner = asked === "me" ? caller().user : (asked ?? "")
          const from = offset ?? 0

          const page = yield* workspace().appsPage({
            q: "",
            owner,
            sort: sort ?? "updated",
            offset: from,
            limit: limit ?? APP_LIST_DEFAULT,
            only: caller().apps,
          })

          const next = from + page.apps.length

          return {
            apps: page.apps.map((a) => ({
              app: a.name,
              url: url(a.name),
              description: a.description,
              owner: a.owner,
              updated: a.updated ?? a.created,
            })),
            total: page.total,
            nextOffset: next < page.total && page.apps.length > 0 ? next : null,
            trace: newTrace(),
          }
        }),

        app_info: Effect.fn("tool.app_info")(function* ({ app }) {
          const { record, target } = yield* appOf(app)
          const info = yield* target.info()
          const known = new Map((yield* workspace().environments(record.id)).map((e) => [e.env, e]))
          const uploaded = yield* target.filesList(undefined)

          const workspaceBytes = (yield* workspace().filesUsage()).reduce(
            (n, row) => n + row.bytes,
            0,
          )

          const answer = {
            app,
            url: url(app),
            public:
              info.version === null ? null : publicOf(app, yield* target.config(info.version)),
            owner: record.owner,
            description: record.description,
            ...info,
            webhooks: info.webhooks.map(({ path, ...hook }) => ({
              ...hook,
              url: `${hostOf(app)}/${path}`,
            })),
            environments: info.environments.map(({ env, version, collections }) => {
              const about = known.get(env)

              return {
                env,
                version,
                previewUrl: previewUrl(app, env),
                note: about?.note ?? "",
                apps: about?.apps ?? [app],
                lastWrite: about?.lastWrite ?? "",
                by: about?.by ?? "",
                collections,
              }
            }),
            trace: newTrace(),
          }

          // Uploads off (files.ts UPLOADS): an agent isn't told about them at all.
          if (!uploads) return answer

          return {
            ...answer,
            uploads: {
              count: uploaded.length,
              bytes: uploaded.reduce((n, f) => n + f.size, 0),
              workspaceBytes,
              workspaceLimit:
                Runtime.fileLimits.workspace === 0 ? null : Runtime.fileLimits.workspace,
              fileLimit: Runtime.fileLimits.file,
              recent: uploaded.slice(0, 20).map((f) => ({
                id: f.id,
                url: `${hostOf(app)}/a/${app}${f.env === "" ? "" : `/_preview/${encodeURIComponent(f.env)}`}/_files/${f.id}`,
                name: f.name,
                type: f.type,
                size: f.size,
                author: f.author,
                env: f.env === "" ? null : f.env,
                created: f.created,
              })),
            },
          }
        }),

        app_files: Effect.fn("tool.app_files")(function* (params) {
          const { app, version, paths, around, lines } = params
          const { target } = yield* appOf(app)

          const part =
            around === undefined && lines === undefined
              ? undefined
              : { around, lines, context: params.context ?? 10 }

          const read = yield* remote(target.contents(version, paths, part))

          return { app, ...read, trace: newTrace() }
        }),

        app_diff: Effect.fn("tool.app_diff")(function* ({ app, from, to, paths, offset }) {
          const { target } = yield* appOf(app)
          const found = yield* remote(target.diff(from, to, paths))
          const start = Math.min(offset ?? 0, found.text.length)

          const page = diffPage(found.text, start, DIFF_PAGE, (next) =>
            appDiffCall(app, found.from, found.to, paths, next),
          )

          return {
            app,
            from: found.from,
            to: found.to,
            changed: found.changed,
            diff: page.text,
            total: found.text.length,
            next: page.next,
            trace: newTrace(),
          }
        }),

        collection_list: Effect.fn("tool.collection_list")(function* (params) {
          const { app, collection, limit, cursor, preview } = params
          const { record, target } = yield* appOf(app)
          const env = yield* whereOf(app, record.id, preview)

          const page = yield* remote(
            target.list(env, collection, {
              limit: limit ?? LIST_DEFAULT,
              cursor,
              maxBytes: LIST_BYTES,
            }),
          )

          return { ...page, trace: newTrace() }
        }),

        collection_add: Effect.fn("tool.collection_add")(function* (params) {
          const { app, collection, data, docs, preview, as } = params

          if ((data === undefined) === (docs === undefined)) {
            return yield* new Refused({
              message:
                "pass data (one document) or docs: [{ data }, ...] (a batch), not both and not neither",
            })
          }

          if (
            docs !== undefined &&
            (params.id ?? params.author ?? params.updatedBy) !== undefined
          ) {
            return yield* new Refused({
              message: "with docs, each document carries its own id, author and updatedBy",
            })
          }

          const one = {
            id: params.id,
            data: data ?? null,
            author: params.author,
            updatedBy: params.updatedBy,
          }

          const writes = (docs ?? [one]).map((doc): BatchWrite => ({
            ...(doc.id === undefined
              ? { op: "add", data: doc.data }
              : { op: "set", id: doc.id, data: doc.data, ifSeq: 0 }),
            author: doc.author,
            updatedBy: doc.updatedBy,
          }))

          return yield* writeBatch(app, collection, writes, preview, as, docs !== undefined)
        }),

        collection_update: Effect.fn("tool.collection_update")(function* (params) {
          const { app, collection, id, data, docs, preview, as } = params
          const single = [id, data, params.replace, params.ifSeq, params.author, params.updatedBy]

          if (docs !== undefined && single.some((value) => value !== undefined)) {
            return yield* new Refused({
              message:
                "with docs, each change carries its own id, data, replace, ifSeq, author and updatedBy: leave them out at the top",
            })
          }

          if (docs === undefined && (id === undefined || data === undefined)) {
            return yield* new Refused({
              message: "pass id and data (one document), or docs: [{ id, data }, ...] (a batch)",
            })
          }

          const one = {
            id: id ?? "",
            data: data ?? null,
            replace: params.replace,
            ifSeq: params.ifSeq,
            author: params.author,
            updatedBy: params.updatedBy,
          }

          const writes = (docs ?? [one]).map((doc): BatchWrite =>
            doc.replace === true
              ? {
                  op: "set",
                  id: doc.id,
                  data: doc.data,
                  ifSeq: doc.ifSeq,
                  author: doc.author,
                  updatedBy: doc.updatedBy,
                }
              : {
                  op: "update",
                  id: doc.id,
                  patch: doc.data,
                  ifSeq: doc.ifSeq,
                  author: doc.author,
                  updatedBy: doc.updatedBy,
                },
          )

          return yield* writeBatch(app, collection, writes, preview, as, docs !== undefined)
        }),

        collection_delete: Effect.fn("tool.collection_delete")(function* (params) {
          const { app, collection, id, all, preview, as } = params
          const trace = newTrace()
          const { record, target } = yield* appOf(app)
          const env = yield* whereOf(app, record.id, preview)
          const by = yield* actingAs(app, env, as)

          yield* ownedRefusal(target, env, as, collection, ["delete"])

          if (id !== undefined && all === undefined) {
            yield* remote(target.remove(env, collection, id, by, trace))
            yield* wrote(env)

            return { deleted: 1, trace }
          }

          if (id === undefined && all === true) {
            const { deleted } = yield* remote(target.clear(env, collection, by, trace))

            yield* wrote(env)

            return { deleted, trace }
          }

          return yield* new Refused({
            message:
              "pass id to delete one document, or all: true (and no id) to delete every document in the collection",
          })
        }),
        app_logs: Effect.fn("tool.app_logs")(function* ({ app, trace, limit }) {
          const { target } = yield* appOf(app)

          return {
            lines: yield* target.logs(trace, limit ?? 100),
            trace: newTrace(),
          }
        }),
      })

      const checkApp = Effect.fn("tool.check_app")(function* (
        params: typeof CheckApp.parametersSchema.Type,
        trace: string,
      ) {
        const { app, path, preview, width, screenshot, readonly } = params
        const steps = params.steps ?? []
        const names = peopleOf(params)
        const { record } = yield* appOf(app)

        if (params.people !== undefined && params.as !== undefined) {
          return yield* new Refused({
            message: `pass people (several test people) or as (one), not both: people: ${JSON.stringify([...new Set([params.as, ...names])])}`,
          })
        }

        if (names.length > MAX_PEOPLE) {
          return yield* new Refused({
            message: `the steps name ${names.length} test people in as (${names.join(", ")}); a check signs in at most ${MAX_PEOPLE}`,
          })
        }

        if (new Set(names).size !== names.length) {
          return yield* new Refused({ message: "people has a name twice: give each person once" })
        }

        for (const [index, step] of steps.entries()) {
          const problem = stepProblem(step, index)

          if (problem !== undefined) return yield* new Refused({ message: problem })
        }

        const unfit = flowProblem(steps, names)

        if (unfit !== undefined) return yield* new Refused({ message: unfit })

        const env = yield* envOf(preview)

        yield* testPeopleIn(app, env, names)

        if (env !== undefined) yield* inEnv(app, record.id, env)

        const people = names.map((name): Person => ({
          name,
          email: testEmail(name, app),
          shown: testName(name),
          groups: groupsOf(params).get(name) ?? [],
        }))

        const together =
          env === undefined ? [] : ((yield* workspace().environment(env))?.apps ?? [])

        yield* testGroupsAllowed(app, record.owner, together, people)

        const bound = yield* apps.getByName(record.id).tools(env)
        const tools = bound !== null && Object.keys(bound).length > 0

        // At most checksAtOnce Chromes on the machine (each about 150 MB; 25 at once took a 4 GB machine to its limit), and at most
        // checksPerWorkspace of them for one workspace: a check waits up to CHECK_WAIT_MS for both, outside the object's turn so the
        // person's other calls go on meanwhile.
        const workspaceSlot = `check-${caller().workspace}`

        const free = yield* Effect.promise(() =>
          offTurn(async () => {
            let full: "workspace" | "machine" = "machine"

            for (let waited = 0; waited < CHECK_WAIT_MS; waited += 250) {
              const ours = Runtime.takeSlot(workspaceSlot, checksPerWorkspace)

              if (ours === undefined) full = "workspace"
              else {
                const machine = Runtime.takeSlot("check", checksAtOnce)

                if (machine !== undefined)
                  return {
                    slot: () => {
                      machine()
                      ours()
                    },
                    full,
                  }

                ours()
                full = "machine"
              }

              // oxlint-disable-next-line no-await-in-loop -- polling for a free browser, one look at a time
              await new Promise((resolve) => setTimeout(resolve, 250))
            }

            return { slot: undefined, full }
          }),
        )

        const slot = free.slot

        if (slot === undefined) {
          return yield* new Refused({
            message:
              free.full === "workspace"
                ? `${checksPerWorkspace} of ${caller().workspaceName}'s checks were running for ${CHECK_WAIT_MS / 1000} s: let one finish, then try check_app again.`
                : `${checksAtOnce} checks were running on this server for ${CHECK_WAIT_MS / 1000} s: try check_app again in a minute.`,
          })
        }

        const checked = yield* checker
          .check({
            by: caller().person,
            apps: caller().apps,
            root: env === undefined ? appUrl(caller().origin, app) : previewUrl(app, env),
            path: path ?? "",
            steps,
            width: width ?? 1024,
            screenshot: screenshot === true ? "report" : "none",
            blockWrites: readonly === true,
            people,
            others: together
              .filter((other) => other !== app)
              .map((other) => appOrigin(caller().origin, other)),
            trace,
            tools,
            card: null,
          })
          .pipe(Effect.ensuring(Effect.sync(slot)))

        return { result: { app, ...checked.report, trace }, image: checked.screenshot }
      })

      const checkAppTool = Layer.effectDiscard(
        Effect.gen(function* () {
          const registry = yield* McpServer.McpServer

          yield* registry.addTool({
            tool: new McpSchema.Tool({
              name: CheckApp.name,
              _meta: cli([
                "app check <app> [path]",
                "Open an app's page in a real browser and report what it shows, errors included",
              ]),
              description: Tool.getDescription(CheckApp),
              inputSchema: checkAppInput,
              outputSchema: checkAppOutput,
              annotations: { readOnlyHint: true },
            }),
            annotations: Context.empty(),
            handle: (payload) => {
              const trace = newTrace()

              return decodeCheckApp(payload ?? {}).pipe(
                Effect.mapError(
                  (e) =>
                    new Refused({
                      message: `check_app's arguments don't fit its parameters: ${e.message.replaceAll(/\s*\n\s*/g, " ")}`,
                    }),
                ),
                Effect.flatMap((params) =>
                  checkApp(params, trace).pipe(
                    Effect.map(({ result, image }) => {
                      const encoded = encodeCheckApp(result)

                      return new McpSchema.CallToolResult({
                        structuredContent: encoded,
                        content:
                          image === undefined
                            ? [{ type: "text", text: JSON.stringify(encoded) }]
                            : [
                                { type: "text", text: JSON.stringify(encoded) },
                                { type: "image", data: image, mimeType: "image/jpeg" },
                              ],
                      })
                    }),
                    Effect.catchTag("Refused", (e) =>
                      Effect.succeed(refusedCheck(e.message, trace, params)),
                    ),
                  ),
                ),
                Effect.catchTag("Refused", (e) =>
                  Effect.succeed(refusedCheck(e.message, trace, undefined)),
                ),
                Effect.catchDefect((defect) =>
                  Effect.logError(`check_app failed (trace ${trace})`, defect).pipe(
                    Effect.as(
                      refusedCheck(
                        `check_app failed inside the platform: ${String(defect).slice(0, 300)}. Try again; if it keeps failing, report trace ${trace}`,
                        trace,
                        undefined,
                      ),
                    ),
                  ),
                ),
              )
            },
          })
        }),
      ).pipe(Layer.provide(McpServer.McpServer.layer))

      const appPictureTool = Layer.effectDiscard(
        Effect.gen(function* () {
          const registry = yield* McpServer.McpServer

          yield* registry.addTool({
            tool: new McpSchema.Tool({
              name: "app_picture",
              _meta: cli([
                "app picture <app>",
                "The picture of an app the workspace's home page shows on its card",
              ]),
              description: APP_PICTURE_DESCRIPTION,
              inputSchema: appPictureInput,
              outputSchema: appPictureOutput,
              annotations: { readOnlyHint: true },
            }),
            annotations: Context.empty(),
            handle: (payload) => {
              const trace = newTrace()

              const refusal = (message: string) =>
                new McpSchema.CallToolResult({
                  isError: true,
                  content: [{ type: "text", text: `${message} (trace ${trace})` }],
                })

              return decodeAppPicture(payload ?? {}).pipe(
                Effect.mapError(
                  (e) =>
                    new Refused({
                      message: `app_picture's arguments don't fit its parameters: ${e.message.replaceAll(/\s*\n\s*/g, " ")}`,
                    }),
                ),
                Effect.flatMap(({ app, theme }) =>
                  Effect.gen(function* () {
                    const { target } = yield* appOf(app)
                    const picture = yield* remote(target.picture(theme ?? "light"))

                    const result = encodeAppPicture({
                      app,
                      picture:
                        picture === null
                          ? null
                          : { theme: picture.theme, version: picture.version, taken: picture.at },
                      trace,
                    })

                    return new McpSchema.CallToolResult({
                      structuredContent: result,
                      content:
                        picture === null
                          ? [{ type: "text", text: JSON.stringify(result) }]
                          : [
                              { type: "text", text: JSON.stringify(result) },
                              {
                                type: "image",
                                data: Uint8Array.fromBase64(picture.image),
                                mimeType: "image/webp",
                              },
                            ],
                    })
                  }),
                ),
                Effect.catchTag("Refused", (e) => Effect.succeed(refusal(e.message))),
                Effect.catchDefect((defect) =>
                  Effect.logError(`app_picture failed (trace ${trace})`, defect).pipe(
                    Effect.as(
                      refusal(
                        `app_picture failed inside the platform: ${String(defect).slice(0, 300)}. Try again; if it keeps failing, report trace ${trace}`,
                      ),
                    ),
                  ),
                ),
              )
            },
          })
        }),
      ).pipe(Layer.provide(McpServer.McpServer.layer))

      const searchTool = Layer.effectDiscard(
        Effect.gen(function* () {
          const registry = yield* McpServer.McpServer

          yield* registry.addTool({
            tool: new McpSchema.Tool({
              name: "search",
              _meta: cli([
                "search <query...>",
                "Find the operations, and the workspace's apps, functions, collections and connections, that match",
              ]),
              description:
                'Search first, for anything on OpenBelt. search({ query: "<the task or its data: deploy an app, set a secret, expense reports, pokemon>" }) gives the operations that do it (each with its input schema: run one with call({ tool, args })), the few apps the workspace already has that match (yours and the ones many people use first; each function with its input schema and the exact call_function call; collections; skills, read with call({ tool: "skills", args: { uri } })), and the few connections, and starters (ready apps; starter_add adds one). search({ query: "" }) lists every operation. Before building, use an app that fits instead of making it again; if nothing fits, build without it.',
              inputSchema: SEARCH_INPUT,
              outputSchema: SEARCH_OUTPUT,
            }),
            annotations: Context.empty(),
            handle: Effect.fn("McpDO.search")(
              function* (payload) {
                const query = Option.getOrElse(
                  Option.flatMap(Option.fromNullishOr(payload), (p) =>
                    Schema.decodeUnknownOption(Schema.Struct({ query: Schema.String }))(p),
                  ).pipe(Option.map((p) => p.query)),
                  () => "",
                )

                const words = queryWords(query)

                const matches = (text: string) => words.some((w) => new Set(wordsIn(text)).has(w))

                const request = yield* McpSchema.McpRequestContext

                const operations = operationsFor(
                  registry.tools
                    .filter((entry) => {
                      const enabled = Context.getOrUndefined(
                        entry.annotations,
                        McpSchema.EnabledWhen,
                      )

                      return (
                        enabled === undefined ||
                        enabled({
                          protocolVersion: request.protocolVersion,
                          capabilities: request.clientCapabilities,
                          clientInfo: request.clientInfo,
                        })
                      )
                    })
                    .map((entry) => entry.tool),
                  query,
                )

                const found0 = yield* foundApps(query, FOUND)

                const inputs = new Map(
                  yield* Effect.forEach(
                    found0,
                    ({ r }) =>
                      apps
                        .getByName(r.id)
                        .functionsWithInput()
                        .pipe(
                          Effect.map(
                            (fs) => [r.name, new Map(fs.map((f) => [f.name, f.input]))] as const,
                          ),
                          Effect.orElseSucceed(
                            () => [r.name, new Map<string, JsonSchema | null>()] as const,
                          ),
                        ),
                    { concurrency: 8 },
                  ),
                )

                const appsFound = found0.map(({ r, ...a }) => {
                  const callable = a.functions
                    .filter((f) => f.call !== null)
                    .toSorted(
                      (x, y) =>
                        Number(matches(`${y.name} ${y.about.split("\n")[0] ?? ""}`)) -
                        Number(matches(`${x.name} ${x.about.split("\n")[0] ?? ""}`)),
                    )

                  return {
                    app: r.name,
                    url: url(r.name),
                    description: r.description,
                    owner: r.owner,
                    uses: r.uses,
                    functions: callable.slice(0, FOUND_FUNCTIONS).map((f) => ({
                      name: f.name,
                      about: f.about.split("\n")[0] ?? "",
                      kind: f.kind,
                      input: inputs.get(r.name)?.get(f.name) ?? null,
                      call: f.call,
                    })),
                    functionCount: callable.length,
                    collections: a.collections
                      .filter((c) => matches(`${c.name} ${c.about ?? ""}`))
                      .slice(0, 3)
                      .map((c) => ({ name: c.name, about: c.about, docs: c.docs })),
                    skills: a.skills
                      .filter((k) => matches(`${k.name} ${k.about}`))
                      .slice(0, 3)
                      .map((k) => ({
                        uri: `${SCHEME}${r.name}/${k.name}/${SKILL_FILE}`,
                        about: k.about.split("\n")[0] ?? "",
                      })),
                  }
                })

                const found = yield* remote(
                  workspace().findConnections(caller().person, caller().origin, query, 5),
                ).pipe(Effect.orElseSucceed(() => []))

                const connectionsFound = found.map(({ view }) => ({
                  connection: view.connection,
                  level: view.level,
                  matchedToolCount: view.tools.length,
                  schemasExpanded: false,
                  inspect: { tool: "connections", input: { connection: view.connection } },
                  tools: view.tools.map((t) => ({
                    tool: t.tool,
                    description: t.description,
                    usable: t.usable,
                  })),
                }))

                const notAdded = yield* remote(workspace().catalogFor(query, 3)).pipe(
                  Effect.orElseSucceed(() => []),
                )

                const here = yield* remote(workspace().startersAdded())

                const starters = STARTERS.filter(
                  (st) => here[st.name] === undefined && matches(`${st.name} ${st.description}`),
                ).map((st) => ({
                  starter: st.name,
                  description: st.description,
                  add: { tool: "starter_add", input: { starter: st.name } },
                }))

                const ran =
                  'Run an operation with call({ tool, args }), args fitting its input. Run an app\'s function with its call (call_function). call({ tool: "app_info", args: { app } }) gives an app in full; call({ tool: "connections", args: { connection, search } }) a connection\'s tools\' input schemas.'

                const answer = {
                  operations,
                  apps: appsFound,
                  connections: connectionsFound,
                  notAdded,
                  starters,
                  note:
                    appsFound.length + connectionsFound.length === 0
                      ? caller().apps === null
                        ? `No app or connection in this workspace matches "${query.slice(0, 60)}": try other words; if nothing fits, build without it. ${ran}`
                        : `Nothing you may use matches "${query.slice(0, 60)}". This agent may use only ${caller().apps?.join(", ") || "no apps"}, and other apps are hidden from it: if the task needs one, tell the person you act for to add it to this agent in Settings, Agents. ${ran}`
                      : ran,
                }

                return new McpSchema.CallToolResult({
                  content: [{ type: "text", text: JSON.stringify(answer) }],
                  structuredContent: answer,
                })
              },
              Effect.catchCause((cause) =>
                Effect.logError("search failed", cause).pipe(
                  Effect.as(toolError("search failed inside the platform; try again")),
                ),
              ),
            ),
          })
        }),
      )

      // call({ tool, args }) reaches this only when answer() couldn't turn it into the operation's own tools/call (unwrapCall).
      const callTool = Layer.effectDiscard(
        Effect.gen(function* () {
          const registry = yield* McpServer.McpServer

          yield* registry.addTool({
            tool: new McpSchema.Tool({
              name: "call",
              description: CALL_DESCRIPTION,
              inputSchema: Schema.decodeUnknownSync(McpSchema.ToolJson)(CALL_INPUT),
            }),
            annotations: Context.empty(),
            handle: (payload) =>
              Effect.succeed(
                toolError(
                  callProblem(
                    Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(payload)),
                  ) ?? "call couldn't run this operation: search for it and call it again",
                ),
              ),
          })
        }),
      )

      const connectionCallTool = Layer.effectDiscard(
        Effect.gen(function* () {
          const registry = yield* McpServer.McpServer

          yield* registry.addTool({
            tool: new McpSchema.Tool({
              name: ConnectionCall.name,
              _meta: cli([
                "connection call <tool> [input]",
                "Call a connection's tool (<connection>.<tool>)",
              ]),
              description: Tool.getDescription(ConnectionCall),
              inputSchema: connectionCallInput,
              outputSchema: connectionCallOutput,
            }),
            annotations: Context.empty(),
            handle: (payload) => {
              const trace = newTrace()

              return decodeConnectionCall(payload ?? {}).pipe(
                Effect.flatMap((params) =>
                  workspace()
                    .connectionCall(
                      caller().person,
                      params.tool,
                      params.input ?? {},
                      params.as,
                      trace,
                      caller().origin,
                    )
                    .pipe(
                      Effect.map((called) =>
                        calledResult(
                          params.tool,
                          called.kind === "not_run"
                            ? called
                            : { ...called, result: keepFields(called.result, params.fields) },
                          trace,
                        ),
                      ),
                    ),
                ),
                Effect.catchTag("SchemaError", (e) =>
                  Effect.succeed(
                    calledResult(
                      "",
                      {
                        kind: "not_run",
                        outcome: "refused",
                        message: `connection_call's arguments don't fit its parameters: ${e.message.replaceAll(/\s*\n\s*/g, " ")}`,
                        connect: undefined,
                        ms: 0,
                      },
                      trace,
                    ),
                  ),
                ),
                Effect.catchDefect((defect) =>
                  Effect.logError(`connection_call failed (trace ${trace})`, defect).pipe(
                    Effect.as(
                      calledResult(
                        "",
                        {
                          kind: "not_run",
                          outcome: "failed",
                          message: `connection_call failed inside the platform. Try again; if it keeps failing, report trace ${trace}`,
                          connect: undefined,
                          ms: 0,
                        },
                        trace,
                      ),
                    ),
                  ),
                ),
              )
            },
          })
        }),
      ).pipe(Layer.provide(McpServer.McpServer.layer))

      // resources/read of a skill:// URI is answered before the server sees it (answerSkills); the template is here so the
      // server says it has resources, as the Skills extension asks, and lists where each app's own skill is.
      const skillTemplate =
        McpServer.resource`skill://${McpSchema.param("app", Schema.String)}/SKILL.md`({
          name: "app skill",
          description:
            "How to use an app: its data, its functions and its own skills (OpenBelt writes it for every app)",
          mimeType: "text/markdown",
          content: (uri) =>
            readSkill(uri).pipe(Effect.map((file) => ("text" in file ? file.text : ""))),
        })

      const server = Layer.mergeAll(
        McpServer.toolkit(Tools),
        managementTools,
        skillTemplate,
        checkAppTool,
        appPictureTool,
        connectionCallTool,
        searchTool,
        callTool,
      ).pipe(
        Layer.provide(handlers),
        Layer.provideMerge(
          McpServer.layerHttp({
            name: "openbelt",
            version: "0.2.0",
            // OpenBelt's mark for a client's list of servers, inline: a workspace host's own URLs sit
            // behind its front door, and this server is built before a request names its host.
            icons: [
              new McpSchema.Icon({
                src: `data:image/svg+xml;base64,${btoa(SERVER_ICON.trim())}`,
                mimeType: "image/svg+xml",
                sizes: ["any"],
              }),
            ],
            instructions: guide.instructions,
            extensions: { "io.modelcontextprotocol/skills": {} },
            path: "/mcp",
            // No subscriptions: an open subscriptions/listen stream kept the McpDO alive after its
            // client had gone. Function tools are synced before each tools/list and tools/call
            // instead, so a client sees new ones when it lists again.
            allowSubscriptions: false,
            protocols: [
              McpProtocol.v2026_07_28,
              McpProtocol.v2025_11_25,
              McpProtocol.v2025_06_18,
              McpProtocol.v2025_03_26,
            ],
          }),
        ),
        Layer.provideMerge(HttpRouter.layer),
      )

      const serve = yield* HttpRouter.toHttpEffect(server).pipe(Effect.orDie)

      /**
       * 2025-era sessions live in McpServer's memory, which this instance loses whenever it's
       * evicted (an idle Durable Object is, after a minute or two), and the server then answers the session with an empty 404. So each session's
       * initialize request is saved, and a session id this instance doesn't know is started again
       * from it: the client keeps its id, mapped here to the new session's.
       */
      const known = new Map<string, string>()

      const saved = () => kv.get<ReadonlyArray<SavedSession>>("mcp:sessions") ?? []

      /**
       * `body` to the MCP server as a request like `template`, on `session` when given.
       *
       * toHandled gives the request its own scope and closes it once the response is handed over,
       * and the MCP server ties a reply's queue to that scope. A reply that is still being written
       * then (a notification went out ahead of the result, so it streams as SSE) would lose its
       * queue and reach the client as an empty 200: the scope moves to the response's stream, and
       * closes when the body has been sent.
       */
      const handle = Effect.fnUntraced(function* (
        template: HttpServerRequest,
        body: string,
        session: string | undefined,
      ) {
        const headers = new Headers(template.headers)

        if (session === undefined) headers.delete(SESSION)
        else headers.set(SESSION, session)

        const name = headers.has(MCP_NAME) ? mcpNameOf(body) : undefined

        if (name !== undefined) headers.set(MCP_NAME, name)

        const request = new Request(new URL(template.url, "http://mcp.internal").href, {
          method: template.method,
          headers,
          body: template.method === "GET" || template.method === "HEAD" ? null : body,
        })

        // A rebuilt request carries its own pre-response handlers (they add the session header),
        // which toHandled applies; the response it settles on is the one to send.
        const sent: Array<HttpServerResponse.HttpServerResponse> = []

        yield* HttpEffect.toHandled(serve, (_, response) =>
          Effect.sync(() => sent.push(HttpEffect.scopeTransferToStream(response))),
        ).pipe(Effect.provideService(HttpServerRequest, fromWeb(request)))

        return sent[0] ?? HttpServerResponse.empty({ status: 500 })
      })

      const start = Effect.fnUntraced(function* (template: HttpServerRequest, id: string) {
        const session = saved().find((s) => s.id === id)

        if (session === undefined) {
          return Resumed.Lost({
            reason: `this instance has no record of it (it never issued it, or it was forgotten: only a user's newest ${KEEP_SESSIONS} sessions are kept)`,
            unknown: true,
          })
        }

        const initialized = yield* handle(template, session.initialize, undefined)

        yield* drain(initialized)

        const started = initialized.headers[SESSION]

        if (started === undefined) {
          return Resumed.Lost({
            reason: `replaying its saved initialize got ${initialized.status} and no session`,
            unknown: false,
          })
        }

        yield* drain(yield* handle(template, INITIALIZED, started))
        known.set(id, started)
        yield* Effect.logInfo(`MCP session ${id} restarted after this instance was evicted`)

        return Resumed.Resumed({ session: started })
      })

      const restarting = new Map<string, Deferred.Deferred<Resumed>>()

      const restart = Effect.fnUntraced(function* (template: HttpServerRequest, id: string) {
        const pending = restarting.get(id)

        if (pending !== undefined) return yield* Runtime.idle(Deferred.await(pending))

        const deferred = Deferred.makeUnsafe<Resumed>()

        restarting.set(id, deferred)

        yield* Deferred.into(start(template, id), deferred).pipe(
          Effect.ensuring(Effect.sync(() => restarting.delete(id))),
        )

        return yield* Deferred.await(deferred)
      })

      const resume = (template: HttpServerRequest, id: string) => {
        const session = known.get(id)

        return session === undefined
          ? restart(template, id)
          : Effect.succeed(Resumed.Resumed({ session }))
      }

      /** Each session's client ("claude-code 2.1.3"), read once from its saved initialize. */
      const clients = new Map<string, { readonly label: string; readonly name: string }>()

      /** The client a session's initialize named: with its version (label), and the name alone. */
      const sessionClient = (session: string) => {
        const cached = clients.get(session)

        if (cached !== undefined) return cached

        const initialize = saved().find((s) => s.id === session)?.initialize

        const client =
          initialize === undefined
            ? { label: "", name: "" }
            : { label: clientIn(initialize), name: clientNameIn(initialize) }

        if (initialize !== undefined) clients.set(session, client)

        return client
      }

      const clientOf = (session: string) => sessionClient(session).label

      const agentIn = (session: string) =>
        agentOf(kv.get<string>("oauthClient") ?? "", sessionClient(session).name)

      /**
       * One call to a tool, kept: the workspace's tool_calls (written after the answer, so an agent never waits on it), a log line, the
       * metric. Kept even when the workspace's record of it fails: that only logs.
       */
      const note = (
        call: CallOnWire,
        judged: Judged,
        ms: number,
        session: string,
        trace: string,
      ) => {
        const who = caller()
        const client = clientOf(session)
        const agent = agentIn(session)
        const app = appOfArgs(call.args)

        const tool =
          TOOL_NAMES.has(call.tool) || management.some((entry) => entry.tool.name === call.tool)
            ? call.tool
            : "unknown"

        const line = `tool call: ${call.tool} ${judged.outcome} in ${ms} ms by ${who.user || "nobody"}${client === "" ? "" : ` (${client})`}${judged.error === "" ? "" : `: ${judged.error.slice(0, 200)}`}`

        return Effect.all(
          [
            Runtime.recordToolCall(tool, judged.outcome, ms),
            (judged.outcome === "defect" ? Effect.logWarning(line) : Effect.logInfo(line)).pipe(
              Effect.annotateLogs({ tool: call.tool, outcome: judged.outcome, ms, agent }),
              Effect.annotateLogs(app === "" ? {} : { app }),
            ),
            Effect.forkDetach(
              workspace()
                .toolCalled({
                  at: new Date().toISOString(),
                  trace: judged.trace === "" ? trace : judged.trace,
                  person: who.user,
                  client,
                  session,
                  tool: call.tool,
                  app,
                  args: keptArgs(call.tool, call.args),
                  outcome: judged.outcome,
                  ms,
                  error: judged.error,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `the workspace's record of a ${call.tool} call failed`,
                      cause,
                    ),
                  ),
                ),
            ),
          ],
          { discard: true },
        )
      }

      /**
       * `respond`'s answer to a body with tools/call in it, each call kept (note) and each error given the trace (settleBody). A
       * call the reply never answers (the session was lost, the stream ended) is kept as invalid (a 4xx) or a defect. A streamed
       * reply's outcomes come after its span has ended, so only the span of a whole one names them.
       */
      const observed = Effect.fnUntraced(function* (
        calls: ReadonlyArray<CallOnWire>,
        session: string,
        trace: string,
        respond: Effect.Effect<HttpServerResponse.HttpServerResponse>,
      ) {
        const started = Date.now()
        const pending = new Map(calls.map((call) => [call.id, call] as const))
        const outcomes: Array<string> = []

        const settle = (answered: Json) => {
          const reply = unknownOperation(answered)
          const id = idOf(reply)
          const call = pending.get(id)

          if (call === undefined) return Effect.succeed(reply)

          pending.delete(id)

          if (sessionLost(reply)) return Effect.succeed(reply)

          const judged = judge(reply)

          outcomes.push(judged.outcome)

          return note(call, judged, Date.now() - started, session, trace).pipe(
            Effect.as(
              judged.outcome === "ok"
                ? reply
                : withTrace(reply, judged.trace === "" ? trace : judged.trace),
            ),
          )
        }

        const unanswered = (status: number) =>
          Effect.suspend(() =>
            Effect.forEach(
              [...pending.values()],
              (call) =>
                note(
                  call,
                  {
                    outcome: status >= 400 && status < 500 ? "invalid" : "defect",
                    error: `no answer to the call (HTTP ${status})`,
                    trace: "",
                  },
                  Date.now() - started,
                  session,
                  trace,
                ),
              { discard: true },
            ),
          )

        const response = yield* respond
        const body = yield* settleBody(response.body, settle, unanswered(response.status))

        yield* Effect.annotateCurrentSpan({ "openbelt.outcome": outcomes.join(",") })

        return body === response.body ? response : HttpServerResponse.setBody(response, body)
      })

      const answer = Effect.fnUntraced(function* (request: HttpServerRequest, trace: string) {
        kv.put("workspace", request.headers["x-openbelt-workspace"] ?? "")
        kv.put("workspaceName", request.headers["x-openbelt-workspace-name"] ?? "")
        kv.put("user", request.headers["x-openbelt-user"] ?? "")
        kv.put("person", request.headers["x-openbelt-person"] ?? "")
        kv.put("origin", request.headers["x-openbelt-origin"] ?? "")
        kv.put("oauthClient", decodeURIComponent(request.headers["x-openbelt-oauth-client"] ?? ""))
        kv.put("apps", decodeURIComponent(request.headers["x-openbelt-apps"] ?? ""))

        // call({ tool, args }) becomes the operation's own tools/call here, so everything below sees the operation.
        const body = unwrapCall(yield* request.text.pipe(Effect.orElseSucceed(() => "")))
        const claimed = request.headers[SESSION]
        const calls = callsIn(body)

        const identity = yield* remote(
          workspace().whoami(caller().workspaceName, caller().person),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(WhoAmI)), Effect.orDie)

        workspaceAdmin =
          identity.person.role === "admin" &&
          identity.person.status !== "removed" &&
          caller().apps === null

        // An agent's tools/list gives search and call; the openbelt CLI's, every tool (its commands come from their _meta).
        if (isToolsList(body) && sessionClient(claimed ?? "").name !== LISTS_EVERY_TOOL) {
          const listed = yield* respond(request, body, claimed, trace)

          const only = yield* settleBody(
            listed.body,
            (reply) => Effect.succeed(listedOnly(reply)),
            Effect.void,
          )

          return only === listed.body ? listed : HttpServerResponse.setBody(listed, only)
        }

        if (calls.length === 0) return yield* respond(request, body, claimed, trace)

        const tools = calls.map((c) => c.tool).join(",")

        return yield* observed(
          calls,
          claimed ?? "",
          trace,
          respond(request, body, claimed, trace),
        ).pipe(
          Effect.withSpan(`McpDO.tool ${tools}`, {
            attributes: {
              "openbelt.tool": tools,
              "openbelt.person": caller().user,
              "openbelt.client": clientOf(claimed ?? ""),
              "openbelt.agent": agentIn(claimed ?? ""),
            },
          }),
        )
      })

      const respond = Effect.fnUntraced(function* (
        request: HttpServerRequest,
        body: string,
        claimed: string | undefined,
        trace: string,
      ) {
        const skillRpc = skillRpcOf(body)

        if (skillRpc !== undefined)
          return yield* answerSkills(skillRpc).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(`${skillRpc.method} failed`, cause).pipe(
                Effect.as(
                  skillError(
                    skillRpc.id,
                    -32603,
                    `${skillRpc.method} failed inside the platform; try again (trace ${trace})`,
                  ),
                ),
              ),
            ),
          )

        if (claimed === undefined) {
          const response = yield* handle(request, body, undefined)
          const started = response.headers[SESSION]

          if (started !== undefined && isInitialize(body)) {
            known.set(started, started)
            kv.put(
              "mcp:sessions",
              [{ id: started, initialize: body }, ...saved()].slice(0, KEEP_SESSIONS),
            )
          }

          return response
        }

        return yield* Resumed.$match(yield* resume(request, claimed), {
          Lost: ({ reason, unknown }) =>
            Effect.logWarning(
              `MCP session ${claimed} can't be resumed: ${reason}; ${unknown ? "the gateway looks for it where it lived before people, else the client starts a new session" : "told the client to start a new session"}`,
            ).pipe(
              Effect.as(
                unknown
                  ? HttpServerResponse.setHeader(
                      lostSession(body, claimed, reason, trace),
                      UNKNOWN_SESSION,
                      "1",
                    )
                  : lostSession(body, claimed, reason, trace),
              ),
            ),
          Resumed: ({ session }) =>
            handle(request, body, session).pipe(
              Effect.map((response) =>
                response.headers[SESSION] === undefined
                  ? response
                  : HttpServerResponse.setHeader(response, SESSION, claimed),
              ),
            ),
        })
      })

      return {
        requestLimit: (write: boolean) => Effect.sync(() => personRate(state.storage, write)),
        savedSession: (id: string) => Effect.sync(() => saved().find((s) => s.id === id)),
        adopt: (session: SavedSession) =>
          Effect.sync(() => kv.put("mcp:sessions", [session, ...saved()].slice(0, KEEP_SESSIONS))),

        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest
          const trace = request.headers["x-openbelt-trace"] ?? ""

          return yield* answer(request, trace).pipe(Effect.annotateLogs({ trace }))
        }),
      }
    })
  }).pipe(Effect.provide(Checker.layer)),
) {}
