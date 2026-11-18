import * as Runtime from "./runtime/index.ts"
import { FILE_READ_BYTES, FILE_URL_MS, fileUrlQuery, sizeOf } from "./files.ts"
import * as Config from "effect/Config"
import * as Deferred from "effect/Deferred"
import * as Exit from "effect/Exit"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import {
  carriedIn,
  carriedMessage,
  detailOf,
  forget,
  forgetJson,
  functionsCalledIn,
  functionsRunIn,
  hmacHex,
  howToSet,
  nonceBook,
  type Nonces,
  openSecrets,
  outbound,
  redactAnswer,
  scrub,
  scrubJson,
  secretValueProblem,
  tooShort,
  unsignable,
  widened,
} from "./capabilities.ts"
import { Unchecked } from "./redaction.ts"
import {
  type InputReads,
  member,
  misfit,
  Observed,
  observe,
  readPart,
  signature,
  typeOf,
  type Unread,
  unreadOf,
} from "./contracts.ts"
import {
  type Charge,
  openLive,
  type LiveRan,
  type SocketInfo,
  type Spec as LiveSpec,
  Watching,
} from "./live.ts"
import {
  checkSeq,
  type Committed,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  mergeInto,
  missing,
  type Moved,
  openDataset,
  type PlannedWrite,
  type RunReads,
  type RunWrite,
  sized,
  type Stamp,
  stampOf,
} from "./data.ts"
import {
  type Actor,
  ANONYMOUS,
  type AppConfig,
  authorityOf,
  bookedAuthority,
  type BatchWrite,
  BrowserReport,
  type AppTools,
  type Change,
  type CollectionDetail,
  type CollectionSummary,
  type Conflict,
  collectionProblem,
  contractOf,
  type FunctionContract,
  secretsOf as declaredSecrets,
  DatasetName,
  Denied,
  type ErrorCode,
  type Doc,
  docIdProblem,
  type FunctionDetail,
  FunctionName,
  type FunctionSummary,
  envDataset,
  envProblem,
  type Json,
  type LogLine,
  Missing,
  type PublicBlock,
  type PublicOp,
  newTrace,
  WorkspaceId,
  Refused,
  RunAuthority,
  type Writer,
  TRIGGERS,
  Theme,
  THEME_HEADER,
  writeAuthority,
} from "./model.ts"
import {
  type Answer,
  type Caller,
  FUNCTION_LIMITS,
  HOLD_UNREADABLE,
  functionPath,
  type Grants,
  type Op,
  type Ran,
  openFunctions,
} from "./functions.ts"
import {
  checkOf,
  deliveryProblem,
  headerOf,
  openHookSecrets,
  shownHeaders,
  signedAs,
} from "./hooks.ts"
import { hashOf, newRunId, openRuns } from "./runs.ts"
import { type Opener, openUsage } from "./usage.ts"
import type WorkspaceDO from "./workspace.ts"
import { INSERTED_HEADER, PAGE_TAGS_VERSION, withPageStyle, withReporter } from "./reporter.ts"
import { REACH, sealing } from "./upstream.ts"
import {
  aggregateReadScope,
  deniedBy,
  judge,
  matchKey,
  PUBLIC_RULE,
  publicDenial,
  type RuleDoc,
  type RuleOp,
  UNREADABLE,
  unreadableDenial,
} from "./rules.ts"
import {
  ADDRESS_HEADER,
  type Audience,
  AUDIENCE_HEADER,
  audienceOf,
  exposes,
  grantedNow,
  maskedFor,
  publicFunction,
  PUBLIC_HOST,
  publicLabel,
  publicUrl,
} from "./public.ts"
import { PURGER, purgeHost } from "./cdn.ts"
import {
  PUBLIC_ADDRESS_SHARE,
  PUBLIC_DATA_SHARE,
  PUBLIC_WRITES,
  openPublicBudget,
  type PublicOver,
} from "./rate.ts"
import { Checker } from "./check.ts"
import { openSchedules, type Wanted } from "./schedules.ts"
import { openShots } from "./shots.ts"
import { STARTERS } from "./starters.ts"
import type { DirectoryEntry } from "./directory.ts"
import { aboutOf, cardTags, nameOfSlug, type CardAsk } from "./cards.ts"
import { APP_SEPARATOR, appOrigin, appUrl, frameUrl } from "./hosts.ts"
import {
  appSkill,
  appSkillEntry,
  entryOf,
  filePathOf,
  foldersOf,
  frontmatterByHash,
  SKILL_FILE,
  type SkillEntry,
  skillFileOf,
  type SkillSummary,
  skillUri,
} from "./skills.ts"
import { openTrees, type Tree } from "./trees.ts"
import {
  type DeployRequest,
  fromLaterOpenBelt,
  openVersions,
  settingsOf,
  type StoredConfig,
} from "./versions.ts"

type LogRow = { at: string; level: string; trace: string; message: string }

const KEEP_LOGS = 500

/** The newest log lines an app's panel shows (AppDO.panel). */
const PANEL_LOGS = 40

/** Lines (and runs, runs.ts) written between trims of the table to its size. */
const TRIM_EVERY = 50

const BROWSER_LINES_PER_MINUTE = 30

const BROWSER_REPEAT_MS = 60_000

const MAX_REPORT_BYTES = 8000

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserReport))

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** An openbelt.json as written: a JSON object, its keys kept as they are when the panel changes only "public". */
const decodeOpenbeltJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

const CHECK_AGENT = /OpenBeltCheck\/([a-z0-9]{1,40})/

/** User agent tokens that aren't the browser's name: Safari says Version/26, Edge says Edg/141. */
const BROWSER_NAMES = new Map([
  ["Version", "Safari"],
  ["Edg", "Edge"],
])

const browserName = (ua: string) => {
  if (CHECK_AGENT.test(ua)) return "check"

  const match = /(Edg|Firefox|HeadlessChrome|Chrome|Version)\/(\d+)/.exec(ua)

  if (match === null) return ua.slice(0, 60) || "unknown browser"

  const name = BROWSER_NAMES.get(match[1] ?? "") ?? match[1]

  return `${name} ${match[2]}${/Mobile/.test(ua) ? " mobile" : ""}`
}

const CLASSIC_SDK =
  /<script\b(?![^>]*\btype\s*=\s*["']?module)[^>]*\bsrc\s*=\s*["']\/sdk\.js["'][^>]*>/i

const GLOBAL_SDK = /(?<![\w$.])openbelt\.(?:db|tools|env|appUrl)\b/

const SDK_BOUND = /import\s*\*\s*as\s+openbelt\b|\bopenbelt\s*=\s*(?:await\s+)?import\s*\(/

const sdkMisuseIn = (path: string, text: string): ReadonlyArray<string> => [
  ...(/\.html?$/.test(path) && CLASSIC_SDK.test(text)
    ? [
        `${path} loads /sdk.js as a classic script, so nothing in it runs: /sdk.js is a module. Import it in a module script: <script type="module">import { db } from "/sdk.js"</script> (docs({ page: "sdk" }))`,
      ]
    : []),
  ...(GLOBAL_SDK.test(text) && !SDK_BOUND.test(text)
    ? [
        `${path} calls openbelt.db (or openbelt.tools, openbelt.env), but /sdk.js defines no global openbelt: import what it uses, import { db } from "/sdk.js", in a module script (docs({ page: "sdk" }))`,
      ]
    : []),
]

const TYPES = new Map([
  ["html", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["ico", "image/x-icon"],
  ["txt", "text/plain; charset=utf-8"],
  ["md", "text/markdown; charset=utf-8"],
])

/** What an app tells others of its own skills (the directory, search). */
const skillSummaries = (entries: ReadonlyArray<SkillEntry>): Array<SkillSummary> =>
  entries.map((e) => ({ name: e.frontmatter.name, about: e.frontmatter.description }))

const contentType = (path: string) =>
  TYPES.get(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) ?? "application/octet-stream"

const LOG_LEVEL = { info: "Info", warn: "Warn", error: "Error" } as const

const level = (value: string): LogLine["level"] =>
  value === "error" || value === "warn" ? value : "info"

const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

const MISSING_HEADER = "x-openbelt-missing"

/** A list's answer: the data's seq when the read began (the SDK's watch() reads it). */
const SEQ_HEADER = "x-openbelt-seq"

/** A run that didn't start (busy, the server restarting) answers 503 with this Retry-After, in seconds. */
const RETRY_AFTER_S = 5

const failure = (status: number, code: ErrorCode, message: string, trace: string) =>
  HttpServerResponse.jsonUnsafe({ error: message, code, trace }, { status })

const takes = (query: URLSearchParams, allowed: ReadonlyArray<string>, usage: string) => {
  const unknown = [...query.keys()].filter((key) => !allowed.includes(key))

  return unknown.length === 0
    ? Effect.succeed(query)
    : Effect.fail(
        new Refused({
          message: `unknown parameter ${unknown.map((k) => `"${k}"`).join(", ")}: ${usage}`,
        }),
      )
}

const LIST_USAGE = `a list takes limit (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}) and cursor (from the previous page)`

const limitOf = (raw: string | null) => {
  if (raw === null) return Effect.succeed(DEFAULT_LIMIT)

  const limit = /^\d{1,7}$/.test(raw) ? Number(raw) : Number.NaN

  return limit >= 1 && limit <= MAX_LIMIT
    ? Effect.succeed(limit)
    : Effect.fail(
        new Refused({
          message: `limit must be a whole number from 1 to ${MAX_LIMIT}; got "${raw.slice(0, 20)}". For more, page: pass each result's cursor as cursor until it's null. To read a whole collection, use watch().`,
        }),
      )
}

const ifSeqOf = (raw: string | null) => {
  if (raw === null) return Effect.succeed(undefined)

  return /^\d{1,15}$/.test(raw)
    ? Effect.succeed(Number(raw))
    : Effect.fail(
        new Refused({
          message: `ifSeq must be the seq of the document as you read it (a whole number); got "${raw.slice(0, 20)}"`,
        }),
      )
}

const respond = <A, R>(
  trace: string,
  effect: Effect.Effect<A, Refused | Denied | Missing | Conflict, R>,
) =>
  effect.pipe(
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
    Effect.catchTags({
      Refused: (e) =>
        Effect.succeed(
          failure(e.code === "storage_full" ? 507 : 400, e.code ?? "invalid", e.message, trace),
        ),
      Denied: (e) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: e.message, code: "denied", rule: e.rule, hint: e.hint, trace },
            { status: 403 },
          ),
        ),
      Missing: (e) => Effect.succeed(failure(404, "missing", e.message, trace)),
      Conflict: (e) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: e.message, code: "conflict", seq: e.seq, trace },
            { status: 409 },
          ),
        ),
    }),
  )

/**
 * What's sent past a refused body is still read, up to this, and dropped: a reply sent while the
 * sender is still uploading resets the connection, and the sender may lose the reply with it.
 */
const DRAIN_BYTES = 16_000_000

type Body =
  | { readonly kind: "read"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "over" }
  | { readonly kind: "cut" }

export const CUT_OFF =
  "the body was cut off before all of it arrived, so nothing ran and nothing was written: send it again"

export const cappedBody = Effect.fnUntraced(function* (
  request: HttpServerRequest,
  limit: number,
): Effect.fn.Return<Body> {
  const length = request.headers["content-length"]

  if (Number(length ?? 0) > limit + DRAIN_BYTES) return { kind: "over" }

  if (request.source instanceof Request && request.source.body === null)
    return { kind: "read", bytes: new Uint8Array() }

  const chunks: Array<Uint8Array> = []
  let size = 0

  const read = yield* Stream.runForEachWhile(request.stream, (chunk) =>
    Effect.sync(() => {
      size += chunk.length

      if (size <= limit) chunks.push(chunk)

      return size <= limit + DRAIN_BYTES
    }),
  ).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

  if (size > limit) return { kind: "over" }

  if (!read || (length !== undefined && Number(length) !== size)) return { kind: "cut" }

  const bytes = new Uint8Array(size)
  let at = 0

  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }

  return { kind: "read", bytes }
})

export const drainBody = (request: HttpServerRequest) => {
  const body = request.source instanceof Request ? request.source.body : null

  if (body === null || body.locked) return Effect.void

  let size = 0

  return Stream.runForEachWhile(request.stream, (chunk) =>
    Effect.sync(() => {
      size += chunk.length

      return size <= DRAIN_BYTES
    }),
  ).pipe(Effect.ignore)
}

export const MAX_WRITE_BODY = 256_000

const bodyOf = (request: HttpServerRequest, limit: number) =>
  request.headers["x-openbelt-body"] === "over"
    ? Effect.succeed<Body>({ kind: "over" })
    : cappedBody(request, limit)

const jsonBody = Effect.fnUntraced(function* (what: string) {
  const request = yield* HttpServerRequest
  const bytes = yield* bodyOf(request, MAX_WRITE_BODY)

  if (bytes.kind === "over")
    return yield* new Refused({
      message: `the body is over ${MAX_WRITE_BODY / 1000} KB, and a document is at most 64 KB of JSON: ${what}`,
    })

  if (bytes.kind === "cut") return yield* new Refused({ message: `${CUT_OFF}: ${what}` })

  const text = new TextDecoder().decode(bytes.bytes)
  const body = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text)

  if (Option.isNone(body)) {
    return yield* new Refused({ message: `the body must be JSON: ${what}` })
  }

  return body.value
})

/** The ops a write method may be on the public host (a PUT creates a missing document, else updates it). */
const PUBLIC_WRITE_OPS: ReadonlyMap<string, ReadonlyArray<PublicOp>> = new Map([
  ["POST", ["create"]],
  ["PATCH", ["update"]],
  ["DELETE", ["delete"]],
  ["PUT", ["create", "update"]],
])

const DOC_WRITES = new Map<
  string,
  {
    readonly usage: string
    readonly body: string | undefined
    readonly write: (id: string, ifSeq: number | undefined, body: Json) => BatchWrite
  }
>([
  [
    "PUT",
    {
      usage: "set takes ifSeq (the seq you read; 0: create only)",
      body: "the document's data",
      write: (id, ifSeq, data) => ({ op: "set", id, data, ifSeq }),
    },
  ],
  [
    "PATCH",
    {
      usage: "update takes ifSeq (the seq you read)",
      body: "an object of the fields to change",
      write: (id, ifSeq, patch) => ({ op: "update", id, patch, ifSeq }),
    },
  ],
  [
    "DELETE",
    {
      usage: "delete takes ifSeq (the seq you read)",
      body: undefined,
      write: (id, ifSeq) => ({ op: "delete", id, ifSeq }),
    },
  ],
])

const SAMPLE_CHARS = 1500

const sampleOf = (data: Json): Json => {
  const text = JSON.stringify(data)

  return text.length <= SAMPLE_CHARS
    ? data
    : `${text.slice(0, SAMPLE_CHARS)}... (cut short; collection_list shows it whole)`
}

const SEED_CAP = 5000

export const joinHint = (app: string, env: string) =>
  `deploy it into "${env}" as it is: deploy_app({ app: "${app}", preview: "${env}", keep_others: true }). Then both apps use "${env}"'s data, and promote_app({ apps: [...], env: "${env}" }) takes them live together.`

const writerOf = (email: string | undefined, name: string | undefined): Writer =>
  email === undefined || email === ""
    ? ANONYMOUS
    : { author: email, name: decoded(name ?? "") || email }

/**
 * Who a request to an app's object is from, as the gateway says (it removes what a client sent): someone on the workspace host, signed in
 * or not, or anyone on the public host, who is nobody, ever. Read once per request; each route then answers the one it was given.
 */
type Asker =
  | {
      readonly audience: "workspace"
      readonly writer: Writer
      readonly groups: ReadonlyArray<string>
      readonly testFor: string | undefined
    }
  | { readonly audience: "public"; readonly address: string | undefined }

/** A page someone opens (in a tab or a frame), not a script, image or fetch: what usage.ts counts. */
/** A browser opening a page: in its tab or window, or in a frame. */
const navigates = (request: HttpServerRequest) =>
  request.method === "GET" &&
  (request.headers["sec-fetch-dest"] === "document" ||
    request.headers["sec-fetch-dest"] === "iframe")

const opensPage = (type: string, request: HttpServerRequest) =>
  type.startsWith("text/html") && navigates(request)

/**
 * The file a request for `path` gets: its own; or for a page a browser opens at a route with no file of its own (/issue/ENG-12, no dot
 * in its last part), the nearest index.html above it, so an app that routes by its path opens at any of them. `base` is the <base> its
 * relative links need from there: relative too, so it's right under /_preview/<env>/ as well, and null where none is needed.
 */
const servedAt = (path: string, has: (file: string) => boolean, navigating: boolean) => {
  const filename = path === "" || path.endsWith("/") ? `${path}index.html` : path

  if (has(filename)) return { file: filename, base: null }

  const parts = path.split("/")

  // A path with an empty part ("//evil.test/login") is no route: a browser would read it as another host.
  if (
    !navigating ||
    (parts[parts.length - 1] ?? "").includes(".") ||
    parts.slice(0, -1).includes("")
  )
    return undefined

  const depth = parts.length - 1

  for (let up = depth; up >= 0; up -= 1) {
    const file = [...parts.slice(0, up), "index.html"].join("/")

    if (has(file)) return { file, base: up === depth ? null : "../".repeat(depth - up) }
  }

  return undefined
}

/** How the app works inside (openbelt.json, skills/, functions/) is never the public host's to serve. */
const publicHides = (file: string) =>
  file === "openbelt.json" || file.startsWith("skills/") || file.startsWith("functions/")

/** The person's theme the gateway says (THEME_HEADER) for a page it serves; "system" when it says none. */
const themeOf = (request: HttpServerRequest): Theme =>
  Option.getOrElse(decodeTheme(request.headers[THEME_HEADER]), () => "system" as const)

/** Who opens a page, as usage.ts counts them: a person signed in, or anyone on the public host; nobody for a check_app test person. */
const openerOf = (asker: Asker, request: HttpServerRequest): Opener | undefined => {
  if (asker.audience === "workspace")
    return asker.testFor !== undefined || asker.writer.author === ANONYMOUS.author
      ? undefined
      : { kind: "person", email: asker.writer.author, name: asker.writer.name }

  const referrer = URL.parse(request.headers["referer"] ?? "")

  // Under the OpenBelt bar (frame.ts publicFrame) the gateway counted the visit as it served the bar, with where it came from: the
  // bar's own load of the page names the bar, at this same address, as where it came from, and isn't counted again.
  if (
    request.headers["sec-fetch-dest"] === "iframe" &&
    referrer !== null &&
    referrer.host === request.headers["host"] &&
    referrer.pathname + referrer.search === request.url
  )
    return undefined

  return publicOpener(
    asker.address,
    request.headers["user-agent"] ?? "",
    request.headers["referer"],
    request.headers["host"] ?? "",
  )
}

/** A visitor on the public host, and where they came from: "direct", the host of the page that linked here, or nothing for a page of this app. */
const publicOpener = (
  address: string | undefined,
  agent: string,
  referer: string | undefined,
  host: string,
): Opener => {
  const referrer = URL.parse(referer ?? "")

  return {
    kind: "public",
    address: address ?? "",
    agent,
    source: referrer === null ? "direct" : referrer.host === host ? undefined : referrer.hostname,
  }
}

const askerOf = (headers: Readonly<Record<string, string | undefined>>): Asker =>
  audienceOf(headers[AUDIENCE_HEADER]) === "public"
    ? { audience: "public", address: headers[ADDRESS_HEADER] }
    : {
        audience: "workspace",
        writer: writerOf(headers["x-openbelt-viewer"], headers["x-openbelt-viewer-name"]),
        groups: (headers["x-openbelt-viewer-groups"] ?? "").split(",").filter(Boolean),
        testFor: headers["x-openbelt-viewer-for"],
      }

const readerOf = (asker: Asker): Reader =>
  asker.audience === "public"
    ? { audience: "public" }
    : { audience: "workspace", me: meOf(asker.writer) }

const previewOf = (path: string) => {
  const match = /^_preview\/([^/]*)(\/.*)?$/.exec(path)

  return match === null ? undefined : { env: decoded(match[1] ?? ""), rest: match[2] }
}

const DATA_ROUTE = /^_(db|ws|log|fn|aggregates)(\/|$)/

type Target =
  | { readonly kind: "live" }
  | { readonly kind: "env"; readonly env: string; readonly version: string }
  | { readonly kind: "outside"; readonly env: string }

type Dataset = Effect.Success<ReturnType<typeof openDataset>>

type Announced = Effect.Effect<void>

const SocketTag = Schema.Struct({
  dataset: DatasetName,
  /** Absent on a socket opened before the public host: those were all the workspace host's. */
  audience: Schema.optionalKey(Schema.Literals(["workspace", "public"])),
  viewer: Schema.NullOr(Schema.String),
  name: Schema.optionalKey(Schema.String),
  groups: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.NullOr(Schema.String)),
  via: Schema.optionalKey(Schema.String),
  watching: Schema.optionalKey(Schema.Array(Watching)),
  address: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

type SocketTag = typeof SocketTag.Type

/** Who reads an app's data from a page: someone on the workspace host (`me` null when nobody is signed in), or anyone on the public host. */
type Reader =
  | { readonly audience: "workspace"; readonly me: string | null }
  | { readonly audience: "public" }

/** Whether openbelt.json "public" lets anyone read `collection` (a version this OpenBelt can't read lets nobody). */
const publicReads = (stored: StoredConfig, collection: string) =>
  stored.kind === "read" &&
  stored.config.public !== undefined &&
  exposes(stored.config.public, collection, "read")

const infoOf = (tag: SocketTag): SocketInfo => ({
  dataset: tag.dataset,
  env: tag.env ?? undefined,
  audience: tag.audience ?? "workspace",
  viewer:
    tag.audience === "public" || tag.viewer === null
      ? null
      : { email: tag.viewer, name: tag.name ?? tag.viewer, groups: tag.groups ?? [] },
  via: tag.via ?? "page",
  watching: tag.watching ?? [],
  address: tag.address ?? undefined,
})

const forgotten = (op: Op, nonces: Nonces): Op => {
  const text = (t: string) => forget(t, nonces)
  const json = (j: Json) => forgetJson(j, nonces)

  switch (op.op) {
    case "add":
      return { ...op, collection: text(op.collection), data: json(op.data) }

    case "set":
    case "update":
      return {
        ...op,
        collection: text(op.collection),
        id: text(op.id),
        data: json(op.data),
      }

    case "delete":
      return { ...op, collection: text(op.collection), id: text(op.id) }

    case "later": {
      const { input, key, at } = op
      let out = { ...op, fn: text(op.fn) }

      if (input !== undefined) out = { ...out, input: json(input) }

      if (key !== undefined) out = { ...out, key: text(key) }

      if (Predicate.isString(at)) out = { ...out, at: text(at) }

      if (Predicate.isString(op.in)) out = { ...out, in: text(op.in) }

      return out
    }

    case "call": {
      const out = { ...op, fn: text(op.fn) }

      return op.input === undefined ? out : { ...out, input: json(op.input) }
    }

    case "tool":
      return {
        ...op,
        connection: text(op.connection),
        tool: text(op.tool),
        input: json(op.input),
      }

    case "hmac":
      return { ...op, secret: text(op.secret) }

    default:
      return op
  }
}

const queryRefusal = (fn: string, tried: string) =>
  `"${fn}" is a query, and a query only reads this app's data: it can't ${tried}. Drop "kind": "query" from its openbelt.json entry to make it a function (which reads and writes, all or nothing), and keep the query for what pages watch`

const QUERY_MAY_NOT: Partial<Record<Op["op"], string>> = {
  add: "add documents",
  set: "set documents",
  update: "update documents",
  delete: "delete documents",
  later: "book a later run (ctx.later)",
  call: "call another function (ctx.call)",
  fetch: "fetch",
  tool: "call a connection (ctx.connections)",
  notify: "send a notification (ctx.notify)",
  fileUrl: "make a file url (ctx.files.url): its expiry changes with the clock",
}

/**
 * A change as pages get it: a delete says which document and when, never its last content. The rules are checked against that
 * content first, but anyone they let read it could ask for the delete again with ?since=0, long after it was gone.
 */
const toPage = (change: Change): Change =>
  change.op === "delete" ? { ...change, doc: { ...change.doc, data: null } } : change

/** What a run in a read-only check_app may not do: write, book or change anything outside. Reads, GETs and ctx.call (read-only too) run. */
const readonlyRefusal = (op: Op): string | undefined =>
  op.op === "add" || op.op === "set" || op.op === "update" || op.op === "delete"
    ? `${op.op} documents`
    : op.op === "later"
      ? "book a later run (ctx.later)"
      : op.op === "notify"
        ? "send a notification (ctx.notify)"
        : op.op === "fetch" && !["GET", "HEAD"].includes(op.method.toUpperCase())
          ? `send a ${op.method.toUpperCase()} (only GET and HEAD go out)`
          : undefined

/** Why ctx.notify(to, { title, body, path }) can't send, or undefined. */
const noticeProblem = (op: Extract<Op, { op: "notify" }>) => {
  if (op.to.length === 0 || op.to.length > 50)
    return "send to 1 to 50 of the workspace's people, by email: notify(email or [emails], { title, body, path })"

  if (op.title.trim() === "" || op.title.length > 120)
    return "a title (1-120 characters) is required: notify(email, { title, body, path })"

  if (op.body.length > 500) return "body is the line under the title, up to 500 characters"

  if (!op.path.startsWith("/") || op.path.length > 500)
    return 'path is the page of this app a tap opens, starting with "/" (like "/orders/42")'

  return undefined
}

const CHECKED_VIA = (via: string) => via !== "webhook" && via !== "data"

const MAX_CALL_DEPTH = 4

type Asked = {
  readonly env: string | undefined
  readonly collection: string
  readonly op: RuleOp
  readonly id: string
  readonly doc: Doc | null
  readonly newDoc: RuleDoc | null
}

const TRIGGER_WRITERS: ReadonlySet<string> = new Set(TRIGGERS)

const MAX_ATTEMPTS = 6

const MAX_CHAIN = 4

const MAX_LATERS = 1000

const LATER_DAYS = 30

const LATER_SOONEST_MS = 1000

type Unseen = {
  readonly by: string
  readonly docs: ReadonlySet<string>
  readonly collections: ReadonlySet<string>
}

const NONE_UNSEEN: Unseen = { by: "", docs: new Set(), collections: new Set() }

const NO_READS: RunReads = { docs: [], collections: [], everything: null }

type ByHand = "schedule" | "webhook" | "data" | "later"

type Later = {
  readonly fn: string
  readonly input: Json
  readonly at: number
  readonly key: string
  readonly booking: string
}

type LogEntry = {
  readonly level: "info" | "warn" | "error"
  readonly text: string
}

type Outcome =
  | {
      readonly ok: true
      readonly result: Json
      readonly logs: ReadonlyArray<LogEntry>
      readonly calls: number
      readonly ms: number
      readonly version: string
      readonly run: string
      readonly attempts: number
      readonly reads: number
      readonly writes: number
      readonly replayed: boolean
      readonly replayOf: string | null
      readonly effects: ReadonlyArray<string>
      readonly read?: LiveReads | undefined
      readonly clock: boolean
      readonly checked: RunReads
      readonly committed: boolean
      readonly moves: ReadonlyArray<Moved>
      /** An agent's call only: keys its input had that the function never read. */
      readonly unread?: Unread | undefined
    }
  | {
      readonly ok: false
      readonly kind: string
      readonly error: string
      readonly logs: ReadonlyArray<LogEntry>
      readonly calls: number
      readonly ms: number
      readonly version: string
      readonly run: string
      readonly attempts: number
      readonly reads: number
      readonly replayed: false
      readonly effects?: ReadonlyArray<string> | undefined
      readonly checked: RunReads
      readonly moves: ReadonlyArray<Moved>
    }

/** Why a run anyone started on the public host can't use a secret or connection: what its public function lists, or a write's nothing. */
const notListed = (fn: string | null, what: "secrets" | "uses", item: string) =>
  fn === null
    ? "this run follows a write anyone made on the public host, and those runs get no secrets or connections"
    : `this run follows a call anyone made to ${fn} on the public host, and openbelt.json "public".functions.${fn}.${what} doesn't list ${item}`

/** Whose share of the public budget a refused request or watch used up, and the setting that sets it. */
const overMessage = (over: PublicOver) =>
  over.whose === "address"
    ? `one address may make at most ${over.limit} of the ${PUBLIC_WRITES} writes, function calls and live query runs a minute this app takes from the public host (OPENBELT_PUBLIC_ADDRESS_SHARE, ${PUBLIC_ADDRESS_SHARE}%)`
    : `this app takes at most ${PUBLIC_WRITES} writes and function calls a minute from the public host (live query runs too; OPENBELT_PUBLIC_APP_WRITES_PER_MINUTE)`

const noPublicFunction = (fn: string) =>
  `there's no function "${fn.slice(0, 60)}" on the public host: openbelt.json "public".functions doesn't list it`

type RunSpec = {
  readonly env: string | undefined
  readonly fn: string
  readonly input: Json
  readonly caller: Caller | null
  readonly via: string
  readonly trace: string
  readonly key?: string | undefined
  readonly keyedOn?: Uint8Array<ArrayBuffer> | undefined
  readonly manual?: string | undefined
  readonly origin?: RunAuthority | undefined
  readonly schedule?: { scheduledFor: string; lastOkAt: string | null; manual: boolean } | undefined
  readonly enqueuedBy?: string | null | undefined
  readonly chain?: ReadonlyArray<string> | undefined
  readonly depth?: number | undefined
  readonly tree?: Tree | undefined
  readonly unseen?: Unseen | undefined
  readonly turn?: boolean | undefined
  readonly committed?: (() => void) | undefined
  readonly readonly?: boolean | undefined
  readonly expect?: "query" | undefined
}

/** The workspace's WorkspaceDO as RPC sees it: AppDO reaches it by name, not as an imported class (WorkspaceDO imports AppDO). */
type WorkspaceMethods =
  typeof WorkspaceDO extends Effect.Effect<Runtime.Namespace<infer Methods, WorkspaceId>>
    ? Methods
    : never

type WorkspaceStub = Runtime.Stub<WorkspaceMethods>

/**
 * The workspace's WorkspaceDO, which holds the connections a function calls (ctx.connections) and whether a
 * preview environment's outside effects may go out. By name, not as an imported class: WorkspaceDO
 * imports AppDO, and importing it back would be a cycle.
 */
type CardText = {
  readonly workspace: string
  readonly origin: string
  readonly config: AppConfig
  readonly description: string
}

/** How often an app tells the workspace the same person opened it again (Jump back in shows minutes, not seconds). */
const OPEN_SENT_MS = 60_000

const workspaceStub = (workspace: WorkspaceId) =>
  Runtime.namespaceOf<WorkspaceMethods, WorkspaceId>("WorkspaceDO").getByName(workspace)

type ToolCalled = Effect.Success<ReturnType<WorkspaceStub["functionTool"]>>

type LiveReads = {
  readonly docs: ReadonlyArray<{ readonly collection: string; readonly id: string }>
  readonly collections: ReadonlyArray<string>
  readonly everything: boolean
}

const Job = Schema.Struct({
  kind: Schema.Literals(["data", "later"]),
  fn: Schema.String,
  input: Schema.Json,
  key: Schema.String,
  enqueuedBy: Schema.NullOr(Schema.String),
  chain: Schema.Array(Schema.String),
  env: Schema.optionalKey(Schema.NullOr(Schema.String)),
  booking: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(RunAuthority),
  tree: Schema.optionalKey(Schema.NullOr(Schema.String)),
  heldSince: Schema.optionalKey(Schema.Number),
})

type Job = typeof Job.Type

const laterEnv = (env: string | undefined) => env ?? ""

const laterBooking = (env: string | undefined, key: string) =>
  env === undefined ? key : `preview ${env}: ${key}`

const decodeJob = Schema.decodeUnknownOption(Job)

/** A pending job's payload as it is stored (JSON text). */
const decodeJobText = Schema.decodeUnknownOption(Schema.fromJsonString(Job))

const decodeDataInput = Schema.decodeUnknownOption(
  Schema.Struct({
    collection: Schema.String,
    id: Schema.String,
    op: Schema.optionalKey(Schema.Literals(["add", "update", "delete"])),
    doc: Schema.optionalKey(Schema.Json),
    before: Schema.optionalKey(Schema.Json),
  }),
)

const matches = (on: string, op: Change["op"], collection: string) => {
  const [want = "", name = ""] = on.split(":", 2)

  if (name !== collection) return false

  return want === "write" || want === op || (want === "set" && op !== "delete")
}

const UNITS = new Map([
  ["s", 1000],
  ["m", 60_000],
  ["h", 3600_000],
  ["d", 86_400_000],
])

const inMs = (wait: string | number) => {
  if (Predicate.isNumber(wait)) return wait

  const [, count = "", unit = ""] = /^(\d+)\s*(s|m|h|d)$/.exec(wait.trim()) ?? []
  const ms = UNITS.get(unit)

  return ms === undefined ? undefined : Number(count) * ms
}

const laterAt = (op: { readonly at?: string | number; readonly in?: string | number }) => {
  const now = Date.now()
  const wait = op.in === undefined ? 0 : inMs(op.in)

  const at =
    op.at === undefined ? now + (wait ?? 0) : Predicate.isNumber(op.at) ? op.at : Date.parse(op.at)

  if (Number.isNaN(at))
    return Result.fail(
      `ctx.later's at is a Date, an ISO time or ms since 1970; "${String(op.at).slice(0, 40)}" isn't one`,
    )

  if (op.at === undefined && wait === undefined)
    return Result.fail(
      `ctx.later's in is ms, or a string like "30s", "10m", "2h", "1d"; "${String(op.in).slice(0, 40)}" isn't one`,
    )

  if (Predicate.isNumber(op.in) && op.in > 0 && op.in < LATER_SOONEST_MS)
    return Result.fail(
      `ctx.later's in is ms, and a later runs at the soonest ${LATER_SOONEST_MS / 1000}s after it's booked: ${op.in} is ${op.in}ms. Write "${op.in}s" for seconds, or ${LATER_SOONEST_MS} or more`,
    )

  if (at > now + LATER_DAYS * 86_400_000)
    return Result.fail(`ctx.later books at most ${LATER_DAYS} days ahead`)

  return Result.succeed(Math.max(at, now + LATER_SOONEST_MS))
}

const Seen = Schema.Struct({
  input: Schema.optional(Observed),
  output: Schema.optional(Observed),
  /** Its input was learned from the keys runs read: one learned before, from every key callers sent, typos too, is learned again. */
  fromReads: Schema.optional(Schema.Boolean),
})

type Seen = typeof Seen.Type

const decodeSeen = Schema.decodeUnknownOption(Seen)

const decodeWorkspaceId = Schema.decodeUnknownOption(WorkspaceId)

const NOTHING_SEEN: Seen = { input: undefined, output: undefined, fromReads: true }

const schemaJson = Schema.decodeUnknownSync(Schema.NullOr(Schema.Json))

const onsOf = (on: string | ReadonlyArray<string>) => (Predicate.isString(on) ? [on] : on)

const docKey = (collection: string, id: string) => `${collection}\u0000${id}`

const keyDataset = (env: string | undefined) => (env === undefined ? "live" : `env:${env}`)

const keyScope = (
  fn: string,
  env: string | undefined,
  caller: Caller | null,
  via: string,
  manual: string | undefined,
) => {
  const whose =
    caller !== null
      ? `person:${caller.email}`
      : manual !== undefined
        ? `by-hand:${via}:${manual}`
        : TRIGGER_WRITERS.has(via)
          ? `trigger:${via}`
          : undefined

  return whose === undefined ? undefined : `${fn}@${keyDataset(env)}#${whose}`
}

const notCallable = (config: AppConfig, app: string, fn: string) => {
  if (Object.hasOwn(config.webhooks ?? {}, fn))
    return `"${fn}" runs on its webhook's deliveries (openbelt.json "webhooks"), each checked for its signature first, so it can't be called directly: that would skip the check. To test it, webhook_test({ app: "${app}", function: "${fn}", body }) sends a signed delivery, or call_function({ app: "${app}", function: "${fn}", as: "webhook", input: <the body> }) runs it as one would`

  const trigger = Object.hasOwn(config.triggers ?? {}, fn) ? config.triggers?.[fn] : undefined

  if (trigger !== undefined)
    return `"${fn}" runs on ${onsOf(trigger.on).join(", ")} (openbelt.json "triggers"), with the change as its input, so it can't be called directly with made-up input. To test it, write the document, or call_function({ app: "${app}", function: "${fn}", as: "data", input: { collection, id } }) runs it on a document as it is now`

  if (contractOf(config, fn)?.internal === true)
    return `"${fn}" is internal (openbelt.json "functions": {"${fn}": {..., "internal": true}}): only ${app}'s own code runs it (ctx.call, ctx.later, its schedules and triggers), not a page, another app or an agent. Call the function of ${app} that calls it; to test it alone, call_function({ app: "${app}", function: "${fn}", as: "later", input }) runs it as ctx.later would (caller null). If pages should call it, drop "internal"`

  return undefined
}

const lists = (config: AppConfig, fn: string) => Object.hasOwn(config.functions ?? {}, fn)

const isFunctionName = Schema.is(FunctionName)

const meOf = (by: Writer) => (by.author === ANONYMOUS.author ? null : by.author)

export default class AppDO extends Runtime.DurableObject(
  "AppDO",
  Effect.gen(function* () {
    const state = yield* Runtime.DurableObjectState
    const checker = yield* Checker
    const loader = yield* Runtime.WorkerLoader

    const secretsKey = Redacted.value(
      yield* Config.Redacted("OPENBELT_SECRETS_KEY").pipe(Effect.orDie),
    )

    const reach = yield* REACH.pipe(Effect.orDie)

    const publicHost = yield* PUBLIC_HOST.pipe(Effect.orDie)

    const purger = yield* PURGER.pipe(Effect.orDie)

    const shotDelayMs =
      (yield* Config.Number("OPENBELT_SHOT_DELAY_SECONDS").pipe(
        Config.withDefault(10),
        Effect.orDie,
      )) * 1000

    const shotRefreshMs =
      (yield* Config.Number("OPENBELT_SHOT_REFRESH_SECONDS").pipe(
        Config.withDefault(300),
        Effect.orDie,
      )) * 1000

    // How long a page's tab may stay hidden before /sdk.js closes its socket (and opens it again once the tab is shown): an open
    // socket keeps its app in memory, about 1.8 MB, for as long as the tab is open (sdk.ts, "hidden").
    const hiddenMs =
      (yield* Config.Number("OPENBELT_HIDDEN_SOCKET_SECONDS").pipe(
        Config.withDefault(300),
        Effect.orDie,
      )) * 1000

    return Effect.gen(function* () {
      const { sql, kv } = state.storage

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL,
        trace TEXT NOT NULL, message TEXT NOT NULL)`)

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS environments (
        env TEXT PRIMARY KEY, version TEXT NOT NULL)`)

      // The app's uploaded files (files.ts holds their bytes): '' is the live app's, otherwise a preview environment's.
      yield* sql.exec(`CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, env TEXT NOT NULL, name TEXT, type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, author TEXT NOT NULL, created TEXT NOT NULL)`)

      yield* state.setWebSocketAutoResponse("ping", "pong")

      const name = () => kv.get<string>("name") ?? "?"

      /** The workspace this app is in (its id), set by its first deploy; undefined before one. */
      const workspaceId = () => Option.getOrUndefined(decodeWorkspaceId(kv.get("workspace")))

      /** A document as anyone on the public host sees it: members' emails as opaque ids (public.ts). */
      const masked = <D extends Doc>(doc: D): D =>
        maskedFor(secretsKey, workspaceId() ?? "", state.id.toString())(doc)

      let logged = 0

      /** One line in the app's own log (logs tool) and in the process's output. */
      const log = Effect.fnUntraced(function* (
        lvl: LogLine["level"],
        trace: string,
        message: string,
      ) {
        const entry: LogLine = {
          at: new Date().toISOString(),
          level: lvl,
          trace,
          app: name(),
          message,
        }

        yield* Effect.logWithLevel(LOG_LEVEL[lvl])(message).pipe(
          Effect.annotateLogs({ trace, app: entry.app }),
        )
        yield* sql.exec(
          "INSERT INTO logs (at, level, trace, message) VALUES (?, ?, ?, ?)",
          entry.at,
          entry.level,
          entry.trace,
          entry.message,
        )

        // Trimmed every TRIM_EVERY lines, not after each: the log keeps KEEP_LOGS lines and up to TRIM_EVERY more.
        if (++logged % TRIM_EVERY === 0)
          yield* sql.exec("DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?", KEEP_LOGS)
      })

      const listeners = Effect.fnUntraced(function* (dataset: DatasetName) {
        const found: Array<{
          readonly socket: Runtime.Socket
          readonly reader: Reader
        }> = []

        for (const socket of yield* state.getWebSockets()) {
          const tag = yield* socket.getAttachment(SocketTag).pipe(
            Effect.orElseSucceed((): SocketTag => ({
              dataset: "live",
              audience: "public",
              viewer: null,
            })),
          )

          if (tag.dataset === dataset)
            found.push({
              socket,
              reader:
                tag.audience === "public"
                  ? { audience: "public" }
                  : { audience: "workspace", me: tag.viewer },
            })
        }

        return found
      })

      /** The connection tools a version calls (the live one, or a preview environment's): null when there's none. */
      const toolsOf = Effect.fnUntraced(function* (env: string | undefined) {
        const version = env === undefined ? versions.liveName() : yield* envVersion(env)

        if (version === undefined) return null

        const config = settingsOf(yield* versions.config(version))

        const tools: AppTools = {
          ...config.tools,
          ...Object.fromEntries(
            Object.keys(config.uses ?? {}).map((c) => [`${c}.*`, "viewer" as const]),
          ),
        }

        return tools
      })

      /** The collections the workspace's directory was last told of: a write to another one sends the entry again. */
      const LISTED_COLLECTIONS = "directory:collections"

      // Typed here: WorkspaceDO asks for it and AppDO calls WorkspaceDO, so inferring either type would go round in a circle.
      const directoryEntry: () => Effect.Effect<DirectoryEntry> = Effect.fn("AppDO.entry")(
        function* () {
          const current = yield* versions.live()

          const collections = (yield* summaries(live)).map((c) => ({
            name: c.name,
            about: c.about,
          }))

          kv.put(
            LISTED_COLLECTIONS,
            collections.map((c) => c.name),
          )

          const shown: DirectoryEntry = {
            updated: current === undefined ? null : (current.promotedAt ?? current.deployedAt),
            shot: (yield* shots.taken()) ?? null,
            color: (yield* shots.own()) ?? null,
            tools: Object.keys((yield* toolsOf(undefined)) ?? {}),
            functions: (yield* functionsOf(undefined)).map((f) => ({
              name: f.name,
              about: f.about,
            })),
            collections,
            skills: skillSummaries(yield* ownSkills()),
          }

          return shown
        },
      )

      /** Send the workspace this app's directory entry (what the home page and search show of it), when what it shows changed. */
      const listInWorkspace: () => Effect.Effect<void> = Effect.fnUntraced(function* () {
        const workspace = workspaceId()

        if (workspace === undefined) return

        yield* workspaceStub(workspace)
          .list(state.id.toString(), yield* directoryEntry())
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("directory: the workspace didn't take this app's entry", cause),
            ),
          )
      })

      // An app made before the workspace kept a directory, or whose entry didn't reach it, sends it once it wakes for anything: the apps in
      // use are in the directory first (WorkspaceDO asks the idle ones, slowly).
      const listJob = yield* Runtime.makeCallback("directory", () =>
        kv.get(LISTED_COLLECTIONS) === undefined ? listInWorkspace() : Effect.void,
      )

      if (kv.get(LISTED_COLLECTIONS) === undefined && workspaceId() !== undefined)
        yield* listJob.schedule("list", { at: Date.now() + 2000, payload: {} }).pipe(Effect.orDie)

      /**
       * Files no document of their app names, OPENBELT_FILES_ORPHAN_HOURS after they were uploaded: a tab closed between
       * files.put and the document's write, or a document deleted without its file. Each environment's documents are read once
       * for the file ids in them (one pass, however many files), and every unnamed file older than the grace period is deleted
       * with its bytes, and its room given back to the workspace. Then it books itself again while the app has files.
       */
      const sweepFiles: () => Effect.Effect<void> = Effect.fn("AppDO.sweepFiles")(function* () {
        const workspace = workspaceId()

        if (workspace === undefined) return

        const graceMs = Runtime.fileLimits.orphanMs
        const cutoff = new Date(Date.now() - graceMs).toISOString()

        const due = yield* (yield* sql.exec<{
          id: string
          env: string
          size: number
          name: string | null
        }>(
          "SELECT id, env, size, name FROM files WHERE created <= ? ORDER BY created LIMIT 5000",
          cutoff,
        )).toArray()

        const named = new Map<string, Set<string>>()
        const FILE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

        for (const env of new Set(due.map((file) => file.env))) {
          const table = `docs_${env === "" ? "live" : envDataset(env)}`
          const ids = new Set<string>()

          const [exists] = yield* (yield* sql.exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
            table,
          )).toArray()

          if ((exists?.n ?? 0) > 0) {
            // A document names a file in its data (a field holding it, its id or its url) or as its own id (set(file.id, ...)).
            const docs = yield* (yield* sql.exec<{ id: string; data: string }>(
              `SELECT id, data FROM ${table} WHERE gone = 0`,
            )).toArray()

            for (const doc of docs)
              for (const id of [
                ...(doc.id.match(FILE_ID) ?? []),
                ...(doc.data.match(FILE_ID) ?? []),
              ])
                ids.add(id)
          }

          named.set(env, ids)
        }

        const unnamed = due.filter((file) => !(named.get(file.env)?.has(file.id) ?? false))
        const self = state.id.toString()

        for (const file of unnamed) {
          yield* sql.exec("DELETE FROM files WHERE id = ?", file.id)
          yield* Effect.tryPromise(() =>
            Runtime.fileStore.remove(`${workspace}/${self}/${file.id}`),
          ).pipe(
            Effect.tapError(() => Effect.sync(() => Runtime.recordFileStoreError("remove"))),
            Effect.ignore,
          )
          yield* log(
            "info",
            "-",
            `file deleted as unused: ${file.id}${file.name === null ? "" : ` "${file.name}"`} (${sizeOf(file.size)})${file.env === "" ? "" : ` in ${file.env}`}: no document of this app names it, ${graceMs >= 3_600_000 ? `${Math.round(graceMs / 3_600_000)} h` : `${Math.round(graceMs / 1000)} s`} or more after its upload`,
          )
        }

        if (unnamed.length > 0)
          yield* workspaceStub(workspace).filesRelease(
            self,
            unnamed.reduce((n, file) => n + file.size, 0),
          )

        Runtime.recordFilesSwept(unnamed.length)

        const [left] = yield* (yield* sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM files",
        )).toArray()

        if ((left?.n ?? 0) > 0)
          yield* filesJob
            .schedule("sweep", { after: Duration.millis(graceMs), payload: {} })
            .pipe(Effect.orDie)
      })

      const filesJob: Runtime.Callback<Record<string, never>> = yield* Runtime.makeCallback(
        "files",
        () => sweepFiles(),
        { retry: { delay: "10 minutes" } },
      )

      /** The sweep booked, unless one already is: uploads don't push it later. */
      const bookSweep = Effect.fnUntraced(function* () {
        if ((yield* filesJob.pending("sweep")).length > 0) return

        yield* filesJob
          .schedule("sweep", {
            after: Duration.millis(Runtime.fileLimits.orphanMs + 1000),
            payload: {},
          })
          .pipe(Effect.orDie)
      })

      const broadcast = Effect.fnUntraced(function* (
        dataset: DatasetName,
        message: Readonly<Record<string, Json>>,
      ) {
        const text = JSON.stringify(message)

        // A socket that closed before its close event arrived stops watching: the others still get it.
        for (const { socket } of yield* listeners(dataset))
          yield* socket.send(text).pipe(Effect.catchDefect(() => watched.closed(socket)))
      })

      const announce = Effect.fnUntraced(function* (
        env: string | undefined,
        change: Change,
        origin: RunAuthority,
      ) {
        const dataset = env === undefined ? "live" : envDataset(env)
        const out = toPage(change)
        const text = JSON.stringify({ type: "change", ...out })
        const stored = yield* configOf(env)

        const reads =
          stored.kind === "unreadable"
            ? UNREADABLE
            : matchKey(stored.config.rules ?? {}, change.doc.collection)?.value.read

        const hidden = JSON.stringify({
          type: "change",
          op: "delete",
          doc: { ...change.doc, data: null },
        })

        for (const { socket, reader } of yield* listeners(dataset)) {
          const message =
            reader.audience === "public"
              ? (yield* mayRead(env, reader, change.doc))
                ? JSON.stringify({ type: "change", ...out, doc: masked(out.doc) })
                : change.op !== "add" && publicReads(stored, change.doc.collection)
                  ? JSON.stringify({
                      type: "change",
                      op: "delete",
                      doc: { ...masked(change.doc), data: null },
                    })
                  : undefined
              : reads === undefined || (yield* mayRead(env, reader, change.doc))
                ? text
                : change.op !== "add"
                  ? hidden
                  : undefined

          // A socket that can't take it (closed before its close event arrived) stops watching:
          // the others still get theirs.
          if (message !== undefined)
            yield* socket.send(message).pipe(Effect.catchDefect(() => watched.closed(socket)))
        }

        yield* watched.changed(env, change, origin.kind === "public")
      })

      /**
       * The workspace's name as its host has it, and the app's line: what its link preview cards say. Typed here: it asks WorkspaceDO, and
       * inferring that would go round in a circle (as with directoryEntry).
       */
      const cardText: () => Effect.Effect<CardText | undefined> = Effect.fnUntraced(function* () {
        const workspace = workspaceId()
        const origin = kv.get<string>("origin") ?? ""

        if (workspace === undefined || !URL.canParse(origin)) return undefined

        const config = settingsOf(yield* versions.config())
        const record = yield* workspaceStub(workspace).app(name())

        return {
          workspace: new URL(origin).hostname.split(".")[0] ?? "",
          origin,
          config,
          description: config.description ?? record?.description ?? "",
        }
      })

      const cardAsk = Effect.fnUntraced(function* () {
        const text = yield* cardText()

        if (text === undefined) return null

        const ask: CardAsk = {
          app: name(),
          workspace: text.workspace,
          description: text.description,
          host: `${name()}${APP_SEPARATOR}${text.workspace}`,
          color:
            text.config.color === undefined
              ? null
              : { color: text.config.color.toLowerCase(), source: "config" },
        }

        return ask
      })

      const shots = yield* openShots(state.storage, {
        log,
        card: cardAsk,
        note: (trace, message) =>
          Effect.logInfo(message).pipe(Effect.annotateLogs({ trace, app: name() })),
        live: () => versions.liveName(),
        taken: () => listInWorkspace(),
        check: (target) => checker.check(target),
        delayMs: shotDelayMs,
        refreshMs: shotRefreshMs,
      })

      const live = yield* openDataset(state.storage, "live", {
        checkStorage: () => storageCommit(),
        log,
        announce: (change, origin): Announced =>
          Effect.andThen(
            Effect.andThen(announce(undefined, change, origin), shots.changed()),
            (kv.get<ReadonlyArray<string>>(LISTED_COLLECTIONS) ?? []).includes(
              change.doc.collection,
            )
              ? Effect.void
              : listInWorkspace(),
          ),
        label: "",
        committed: (changes, trace, chain, origin, tree): Announced =>
          triggered(undefined, changes, trace, chain, origin, tree),
      })

      const runs = yield* openRuns(state.storage)
      const appUsage = yield* openUsage(state.storage)

      // Opens not written yet are written as the object goes to sleep.
      yield* Effect.addFinalizer(() => appUsage.flush())

      /** When each person's open was last sent to the workspace (its Jump back in), so a busy page sends one a minute per person at most. */
      const openSent = new Map<string, number>()

      /** Someone opened one of the app's pages: counted here (usage.ts), and a person's open also told to the workspace, without waiting. */
      // Typed here: AppDO calls WorkspaceDO, whose type is inferred from AppDO's, so inferring this would go round in a circle.
      const pageOpened: (opener: Opener) => Effect.Effect<void> = Effect.fnUntraced(function* (
        opener: Opener,
      ) {
        yield* appUsage.opened(opener)

        const workspace = workspaceId()

        if (opener.kind !== "person" || workspace === undefined) return

        const now = Date.now()

        if (now - (openSent.get(opener.email) ?? 0) < OPEN_SENT_MS) return

        openSent.set(opener.email, now)

        yield* Effect.forkDetach(
          workspaceStub(workspace)
            .appOpened(state.id.toString(), opener.email, new Date(now).toISOString())
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("jump back in: the workspace didn't take this open", cause),
              ),
            ),
        )
      })

      const trees = yield* openTrees(state.storage)

      yield* sql.exec(`CREATE TABLE IF NOT EXISTS laters (
        env TEXT NOT NULL, key TEXT NOT NULL, fn TEXT NOT NULL, at INTEGER NOT NULL,
        version TEXT NOT NULL, trace TEXT NOT NULL, booking TEXT NOT NULL,
        PRIMARY KEY (env, key))`)

      const opened = new Map<string, Dataset>()

      const envData = Effect.fnUntraced(function* (env: string) {
        const known = opened.get(env)

        if (known !== undefined) return known

        const made = yield* openDataset(state.storage, envDataset(env), {
          checkStorage: () => storageCommit(),
          log,
          announce: (change, origin): Announced => announce(env, change, origin),
          label: `preview ${env} `,
          committed: (changes, trace, chain, origin, tree): Announced =>
            triggered(env, changes, trace, chain, origin, tree),
        })

        opened.set(env, made)

        return made
      })

      const dataOf = (env: string | undefined) =>
        env === undefined ? Effect.succeed(live) : envData(env)

      const envVersion = Effect.fnUntraced(function* (env: string) {
        const [row] = yield* (yield* sql.exec<{ version: string }>(
          "SELECT version FROM environments WHERE env = ?",
          env,
        )).toArray()

        return row?.version
      })

      const environments = Effect.fnUntraced(function* () {
        return yield* (yield* sql.exec<{ env: string; version: string }>(
          "SELECT env, version FROM environments ORDER BY env",
        )).toArray()
      })

      // An app whose workspace isn't known yet (it is set by the first deploy, before any code loads) is its own tenant, never a shared one.
      const functions = openFunctions(
        loader,
        state.id.toString(),
        () => workspaceId() ?? `app:${state.id.toString()}`,
      )

      const nonces = nonceBook()
      const sealer = yield* sealing(secretsKey)
      const sealed = yield* openSecrets(state.storage, sealer, state.id.toString())
      const hookSecrets = openHookSecrets(kv, sealer, state.id.toString())

      const workspaceOf = () => ({
        workspace: workspaceId(),
        origin: kv.get<string>("origin") ?? "",
      })

      const previewLive = (env: string) => {
        const { workspace } = workspaceOf()

        return workspace === undefined
          ? Effect.succeed(false)
          : workspaceStub(workspace)
              .previewLive(env)
              .pipe(Effect.orElseSucceed(() => false))
      }

      const seenOf = (fn: string) =>
        Option.getOrElse(decodeSeen(kv.get(`fn-observed:${fn}`)), () => NOTHING_SEEN)

      /** Learns a function's undeclared input (from what the run read of it) and output, and returns its input as learned. */
      const observed = (
        fn: string,
        contract: FunctionContract,
        input: Json,
        result: Json,
        read: InputReads | undefined,
      ) => {
        if (contract.input !== undefined && contract.output !== undefined) return undefined

        const before = seenOf(fn)
        const learned = before.fromReads === true ? before.input : undefined

        const next: Seen = {
          input:
            contract.input === undefined
              ? observe(learned, read === undefined ? input : readPart(input, read))
              : undefined,
          output: contract.output === undefined ? observe(before.output, result) : undefined,
          fromReads: true,
        }

        if (JSON.stringify(next) !== JSON.stringify(before)) kv.put(`fn-observed:${fn}`, next)

        return next.input
      }

      /**
       * The CDN's copies of the app's public files dropped when a version goes live (cdn.ts): one that is public, or the first after one
       * that was (its files must go too). "edge-public" says whether the last live version was.
       */
      const purgeEdge = Effect.fnUntraced(function* () {
        const origin = kv.get<string>("origin") ?? ""

        if (purger.kind === "off" || publicHost === "" || !URL.canParse(origin)) return

        const now = settingsOf(yield* versions.config()).public !== undefined
        const was = kv.get<boolean>("edge-public") === true

        if (now !== was) kv.put("edge-public", now)

        if (now || was)
          yield* purgeHost(
            purger,
            `${publicLabel(name(), new URL(origin).hostname.split(".")[0] ?? "")}.${publicHost}`,
          )
      })

      /**
       * The operator's line when a public version goes live: its address on the public host, for alerts on new public
       * pages (anyone can put one up once sign-ups are open). Not in the app's own log: it says nothing the owner didn't do.
       */
      const notePublic = Effect.fnUntraced(function* (version: string) {
        const origin = kv.get<string>("origin") ?? ""

        if (publicHost === "" || !URL.canParse(origin)) return

        if (settingsOf(yield* versions.config()).public === undefined) return

        const host = `${publicLabel(name(), new URL(origin).hostname.split(".")[0] ?? "")}.${publicHost}`

        yield* Effect.logInfo(`public app: ${host} is live at version ${version}`).pipe(
          Effect.annotateLogs({ app: name() }),
        )
      })

      const versions = yield* openVersions(state.storage, {
        checkStorage: () => storageCommit(),
        name,
        log,
        wentLive: (version): Effect.Effect<void> =>
          Effect.andThen(
            Effect.andThen(
              Effect.andThen(
                broadcast("live", { type: "reload", version }),
                watched.aggregatesChanged(undefined),
              ),
              schedules.sync(newTrace()),
            ),
            Effect.andThen(listInWorkspace(), Effect.andThen(purgeEdge(), notePublic(version))),
          ),
        pinned: () => Effect.map(environments(), (rows) => rows.map((r) => r.version)),
        vet: functions.vet,
      })

      const configOf = Effect.fnUntraced(function* (env: string | undefined) {
        const version = env === undefined ? undefined : yield* envVersion(env)

        const stored = yield* versions.config(version)

        if (stored.kind === "read")
          yield* (yield* dataOf(env)).aggregates.prune(stored.config.aggregates ?? {})

        return stored
      })

      const readAggregate = Effect.fn("App.readAggregate")(function* (
        env: string | undefined,
        aggregateName: string,
        reader: Reader,
      ) {
        const viewer = reader.audience === "public" ? null : reader.me

        if (env !== undefined && (yield* envVersion(env)) === undefined)
          return yield* new Missing({
            message: `preview environment "${env}" no longer exists; deploy the app into it again`,
          })

        const stored = yield* configOf(env)

        if (stored.kind === "unreadable") return yield* new Refused({ message: stored.problem })
        const definitions = stored.config.aggregates ?? {}

        const definition = Object.hasOwn(definitions, aggregateName)
          ? definitions[aggregateName]
          : undefined

        if (definition === undefined)
          return yield* new Missing({
            message: `aggregate "${aggregateName}" is not declared; add it to openbelt.json aggregates`,
          })

        if (reader.audience === "public" && !publicReads(stored, definition.collection))
          return yield* new Missing({
            message: `there's no aggregate "${aggregateName}" on the public host: it counts ${definition.collection}, which openbelt.json "public".collections doesn't let anyone read`,
          })

        const scope = aggregateReadScope(stored.config.rules, definition.collection, viewer)

        if (scope === undefined)
          return yield* new Refused({
            message: `aggregate "${aggregateName}" cannot evaluate this collection's read rule; use anyone, signedIn, nobody or doc.author == me, or read the source records`,
          })

        if (scope === "none")
          return {
            result: { count: 0, value: 0, approximate: false },
            collection: definition.collection,
          }
        const data = yield* dataOf(env)

        const result = yield* data.aggregates.read(
          aggregateName,
          definition,
          scope === "owner" ? viewer : null,
          () => storageCommit(),
        )

        return { result, collection: definition.collection }
      })

      const decide = Effect.fnUntraced(function* (asked: Asked, reader: Reader) {
        const { env, collection, op, id, doc, newDoc } = asked
        const data = yield* dataOf(env)
        const stored = yield* configOf(env)

        if (stored.kind === "unreadable") return unreadableDenial(stored.problem)

        const published = stored.config.public

        if (reader.audience === "public") {
          if (env !== undefined || published === undefined)
            return publicDenial(
              'this version isn\'t public: only the live version with a "public" block is',
            )

          if (!exposes(published, collection, op))
            return publicDenial(
              `it doesn't list "${op}" for ${collection} (anyone may ${Object.hasOwn(published.collections ?? {}, collection) ? (published.collections?.[collection] ?? []).join(", ") : "do nothing"} there)`,
            )
        }

        return yield* judge(stored.config.rules, collection, op, {
          me: reader.audience === "public" ? null : reader.me,
          id,
          doc,
          newDoc,
          lookup: (other, key) => data.get(other, key),
        })
      })

      const mayRead = Effect.fnUntraced(function* (
        env: string | undefined,
        reader: Reader,
        doc: Doc,
      ) {
        const asked: Asked = {
          env,
          collection: doc.collection,
          op: "read",
          id: doc.id,
          doc,
          newDoc: null,
        }

        return (yield* decide(asked, reader)) === undefined
      })

      const readable = Effect.fnUntraced(function* (
        env: string | undefined,
        reader: Reader,
        docs: ReadonlyArray<Doc>,
      ) {
        return yield* Effect.filter(docs, (doc) => mayRead(env, reader, doc))
      })

      const allow = Effect.fnUntraced(function* (
        asked: Asked & { readonly actor: Actor; readonly trace: string },
      ) {
        const { env, collection, op, id, actor, trace } = asked

        if (actor.rules === "bypass") return

        const denial = yield* decide(
          asked,
          actor.rules === "public"
            ? { audience: "public" }
            : { audience: "workspace", me: meOf(actor.writer) },
        )

        if (denial === undefined) return

        const who =
          actor.rules === "public"
            ? "anyone, on the public host"
            : (meOf(actor.writer) ?? "anonymous (nobody signed in)")

        const where = env === undefined ? "on live" : `in preview ${env}`

        yield* log(
          "info",
          trace,
          `rule denied ${op} ${collection}/${id} as ${who} ${where}: ${deniedBy(denial)}`,
        )

        yield* new Denied({
          message: `denied by ${deniedBy(denial)}`,
          rule: denial.rule,
          hint:
            denial.rule === UNREADABLE
              ? `as ${who}: deploy the app again (deploy_app) so this OpenBelt can read its openbelt.json`
              : denial.rule === PUBLIC_RULE
                ? `as ${who}: openbelt.json "public".collections lists what anyone may do in each collection; nothing else is reachable from the public host, whatever the rules say`
                : `as ${who}: openbelt.json "rules" decide who may ${op} in ${collection} (app_info shows the whole rule). Hiding a button is not security; this rule is. If this person should be allowed, change the rule.`,
        })
      })

      const plan = Effect.fnUntraced(function* (
        env: string | undefined,
        data: Dataset,
        collection: string,
        id: string,
        write: BatchWrite,
        actor: Actor,
        trace: string,
      ) {
        const before = yield* data.get(collection, id)

        if (write.op === "delete") {
          if (before === null) return yield* missing(collection, id)

          yield* allow({
            env,
            collection,
            op: "delete",
            id,
            doc: before,
            newDoc: null,
            actor,
            trace,
          })
          yield* checkSeq(collection, id, before, write.ifSeq)

          const planned: PlannedWrite = { op: "delete", id, before }

          return planned
        }

        if (write.op === "update" && before === null && write.ifSeq !== 0) {
          return yield* missing(collection, id)
        }

        const next =
          write.op === "update" ? yield* mergeInto(collection, id, before, write.patch) : write.data

        const stamp: Stamp = { by: actor.writer, author: write.author, updatedBy: write.updatedBy }

        yield* allow({
          env,
          collection,
          op: before === null ? "create" : "update",
          id,
          doc: before,
          newDoc: { id, data: next, ...stampOf(stamp, before) },
          actor,
          trace,
        })

        if (write.op !== "add") yield* checkSeq(collection, id, before, write.ifSeq)

        yield* sized(next)

        const planned: PlannedWrite = { op: "put", id, data: next, before, stamp }

        return planned
      })

      let reported = { bytes: -1, at: 0, workspace: 0 }

      const fullLogged = new Map<string, number>()

      const storageFull: (trace: string) => Effect.Effect<string | undefined> = Effect.fnUntraced(
        function* (trace: string) {
          const limits = Runtime.dataLimits
          const free = yield* Effect.promise(Runtime.dataDiskFree)

          const used = Effect.map(
            Effect.flatMap(
              sql.exec<{ n: number }>(
                "SELECT (page_count - freelist_count) * page_size AS n FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()",
              ),
              (rows) => rows.toArray(),
            ),
            ([row]) => row?.n ?? 0,
          )

          const before = yield* used

          const compacted =
            (limits.app > 0 && before >= limits.app) ||
            (limits.workspace > 0 && reported.workspace >= limits.workspace)
              ? yield* Effect.map(
                  Effect.forEach([live, ...opened.values()], (d) => d.compact()),
                  (counts) => counts.reduce((a, b) => a + b, 0),
                )
              : 0

          const bytes = compacted > 0 ? yield* used : before
          const workspace = workspaceId()

          if (compacted > 0)
            yield* log(
              "info",
              trace,
              `at its data cap: dropped ${compacted} deleted documents' last versions (${sizeOf(before)} → ${sizeOf(bytes)}); pages reconnecting from before reload`,
            )

          if (workspace !== undefined)
            reported = {
              bytes,
              at: Date.now(),
              workspace: yield* workspaceStub(workspace).dataUsage(state.id.toString(), bytes),
            }

          const full =
            free !== undefined && free < limits.floor
              ? {
                  why: "disk",
                  message: `the server's disk has ${sizeOf(free)} free, and writes stop ${sizeOf(limits.floor)} before it fills (OPENBELT_DATA_DISK_FLOOR_MB). Nothing was written; deleting still works. Ask whoever runs OpenBelt to free space.`,
                }
              : limits.app > 0 && bytes >= limits.app
                ? {
                    why: "app",
                    message: `"${name()}" holds ${sizeOf(bytes)} of data, the most an app may (${sizeOf(limits.app)}, OPENBELT_DATA_APP_MB). Nothing was written: delete documents it no longer needs (deleting always works), or keep less per document.`,
                  }
                : limits.workspace > 0 && reported.workspace >= limits.workspace
                  ? {
                      why: "workspace",
                      message: `the workspace's apps hold ${sizeOf(reported.workspace)} of data, the most a workspace may (${sizeOf(limits.workspace)}, OPENBELT_DATA_WORKSPACE_MB). Nothing was written: delete documents its apps no longer need (deleting always works).`,
                    }
                  : undefined

          if (full === undefined) return undefined

          Runtime.recordRefused("storage", full.why)

          const minute = Math.floor(Date.now() / 60_000)

          if (fullLogged.get(full.why) !== minute) {
            fullLogged.set(full.why, minute)
            yield* log(
              "warn",
              trace,
              `a write was refused (and others this minute): ${full.message}`,
            )
          }

          return full.message
        },
      )

      const storageCommit: () => Effect.Effect<void, Refused> = Effect.fnUntraced(function* () {
        const limits = Runtime.dataLimits

        const used = sql
          .exec<{ n: number }>(
            "SELECT (page_count - freelist_count) * page_size AS n FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()",
          )
          .pipe(
            Effect.flatMap((rows) => rows.toArray()),
            Effect.map(([row]) => row?.n ?? 0),
          )

        let bytes = yield* used

        if (
          (limits.app > 0 && bytes > limits.app) ||
          (limits.workspace > 0 && reported.workspace + bytes - reported.bytes > limits.workspace)
        ) {
          yield* Effect.forEach([live, ...opened.values()], (data) => data.compact())
          bytes = yield* used
        }

        const workspace = workspaceId()
        const free = yield* Effect.promise(Runtime.dataDiskFree)
        let message: string | undefined

        if (free === undefined || free < limits.floor)
          message =
            "the server cannot reserve disk space (OPENBELT_DATA_DISK_FLOOR_MB). Ask the operator to check disk space."
        else if (limits.app > 0 && bytes > limits.app)
          message = `"${name()}" would hold ${sizeOf(bytes)}, over its data cap (OPENBELT_DATA_APP_MB). Nothing was written; use a smaller batch or delete documents.`
        else if (workspace !== undefined) {
          const reserved = yield* workspaceStub(workspace).dataReserve(
            state.id.toString(),
            bytes,
            limits.workspace,
          )

          if (!reserved.ok)
            message = `the workspace's apps hold or would hold ${sizeOf(reserved.total)}, over the workspace cap (OPENBELT_DATA_WORKSPACE_MB). Nothing was written; use a smaller batch or delete documents.`
        }

        if (message !== undefined) {
          Runtime.recordRefused("storage", "commit")

          return yield* new Refused({ message, code: "storage_full" })
        }

        return undefined
      })

      const writeOne = Effect.fn("AppDO.write")(function* (
        env: string | undefined,
        collection: string,
        one: BatchWrite,
        actor: Actor,
        trace: string,
      ) {
        const data = yield* dataOf(env)
        const full = one.op === "delete" ? undefined : yield* storageFull(trace)

        if (full !== undefined) return yield* new Refused({ message: full })

        const id = one.op === "add" ? crypto.randomUUID() : one.id
        const planned = yield* plan(env, data, collection, id, one, actor, trace)

        const [doc] = yield* data.writeMany(
          collection,
          [planned],
          actor.writer,
          trace,
          writeAuthority(actor),
        )

        return doc ?? (yield* Effect.die("a write of one document wrote none"))
      })

      const writeMany = Effect.fn("AppDO.writeMany")(function* (
        env: string | undefined,
        collection: string,
        writes: ReadonlyArray<BatchWrite>,
        actor: Actor,
        trace: string,
      ) {
        const data = yield* dataOf(env)
        const full = writes.every((w) => w.op === "delete") ? undefined : yield* storageFull(trace)

        if (full !== undefined) return yield* new Refused({ message: full })

        const first = new Map<string, number>()
        const planned: Array<PlannedWrite> = []
        const problems: Array<string> = []

        for (const [i, write] of writes.entries()) {
          const id = write.op === "add" ? crypto.randomUUID() : write.id
          const which = write.op === "add" ? `docs[${i}]` : `docs[${i}] (${id})`
          const earlier = first.get(id)

          if (earlier !== undefined) {
            problems.push(
              `${which}: docs[${earlier}] has the same id; a batch writes each document once`,
            )
            continue
          }

          first.set(id, i)

          const result = yield* Effect.result(
            plan(env, data, collection, id, write, actor, trace).pipe(
              Effect.catchTags({
                Denied: (e) => Effect.fail(`${e.message} (403): ${e.hint}`),
                Refused: (e) => Effect.fail(e.message),
                Missing: (e) => Effect.fail(e.message),
                Conflict: (e) => Effect.fail(e.message),
              }),
            ),
          )

          if (Result.isSuccess(result)) planned.push(result.success)
          else problems.push(`${which}: ${result.failure}`)
        }

        if (problems.length > 0) {
          const one = writes.length === 1

          return yield* new Refused({
            message: one
              ? (problems[0] ?? "")
              : `${problems.length} of ${writes.length} documents can't be written, so none were:\n${problems.join("\n")}`,
          })
        }

        return yield* data.writeMany(
          collection,
          planned,
          actor.writer,
          trace,
          writeAuthority(actor),
        )
      })

      const clear = Effect.fn("AppDO.clear")(function* (
        env: string | undefined,
        collection: string,
        actor: Actor,
        trace: string,
      ) {
        const data = yield* dataOf(env)

        if (actor.rules === "apply") {
          let cursor: string | undefined

          do {
            const page = yield* data.list(collection, { limit: MAX_LIMIT, cursor })

            for (const doc of page.docs) {
              yield* allow({
                env,
                collection,
                op: "delete",
                id: doc.id,
                doc,
                newDoc: null,
                actor,
                trace,
              })
            }

            cursor = page.cursor ?? undefined
          } while (cursor !== undefined)
        }

        return yield* data.clear(collection, actor.writer, trace, writeAuthority(actor))
      })

      const unbookEnv: (env: string) => Effect.Effect<void> = Effect.fnUntraced(function* (
        env: string,
      ) {
        yield* runs.forgetEnv(env)

        const booked = yield* (yield* sql.exec<{ booking: string }>(
          "SELECT booking FROM laters WHERE env = ?",
          env,
        )).toArray()

        for (const one of booked) yield* job.cancel(`later:${one.booking}`).pipe(Effect.orDie)

        yield* sql.exec("DELETE FROM laters WHERE env = ?", env)

        const triggered = yield* job.pending(`data:${env}:`)

        for (const one of triggered) {
          yield* job.cancel(one.id).pipe(Effect.orDie)

          const tree = Option.flatMap(decodeJobText(one.payload), (j) =>
            Option.fromNullishOr(j.tree),
          )

          if (Option.isSome(tree)) yield* trees.settled(tree.value, one.id)
        }

        const workspace = workspaceId()

        const gone = yield* (yield* sql.exec<{ id: string; size: number }>(
          "DELETE FROM files WHERE env = ? RETURNING id, size",
          env,
        )).toArray()

        if (workspace !== undefined && gone.length > 0) {
          const self = state.id.toString()

          yield* Effect.forEach(
            gone,
            (file) =>
              Effect.tryPromise(() =>
                Runtime.fileStore.remove(`${workspace}/${self}/${file.id}`),
              ).pipe(
                Effect.tapError(() => Effect.sync(() => Runtime.recordFileStoreError("remove"))),
                Effect.ignore,
              ),
            { concurrency: 8 },
          )
          yield* workspaceStub(workspace).filesRelease(
            self,
            gone.reduce((n, f) => n + f.size, 0),
          )
          yield* log(
            "info",
            "-",
            `files of ${env} deleted with it: ${gone.length} (${sizeOf(gone.reduce((n, f) => n + f.size, 0))})`,
          )
        }
      })

      const resetEnv = Effect.fn("AppDO.resetEnv")(function* (env: string, trace: string) {
        if ((yield* envVersion(env)) === undefined) return { deleted: 0 }

        const result = yield* (yield* envData(env)).reset("preview_reset", trace)

        yield* unbookEnv(env)

        yield* watched.aggregatesChanged(env)
        yield* broadcast(envDataset(env), { type: "reload", version: null })

        return result
      })

      const dropEnv = Effect.fn("AppDO.dropEnv")(function* (
        env: string,
        why: string,
        trace: string,
      ) {
        if ((yield* envVersion(env)) === undefined) return { deleted: 0 }

        const result = yield* (yield* envData(env)).drop(why, trace)

        yield* unbookEnv(env)
        opened.delete(env)
        hookSecrets.dropEnv(env)
        yield* sql.exec("DELETE FROM environments WHERE env = ?", env)
        yield* watched.aggregatesChanged(env)
        yield* broadcast(envDataset(env), { type: "reload", version: null })

        return result
      })

      const summaries = Effect.fnUntraced(function* (data: Dataset, version?: string) {
        const config = settingsOf(yield* versions.config(version))
        const described = config.collections ?? {}
        const rules = config.rules ?? {}
        const writable = new Set(config.writable ?? [])
        const counts = new Map((yield* data.counts()).map((c) => [c.name, c]))
        const named = [...Object.keys(described), ...Object.keys(rules)]

        const names = [
          ...new Set([...counts.keys(), ...named.filter((key) => !key.endsWith("*"))]),
        ].toSorted()

        return names.map((collection): CollectionSummary => {
          const ruled = matchKey(rules, collection)

          return {
            name: collection,
            about: matchKey(described, collection)?.value ?? null,
            docs: counts.get(collection)?.docs ?? 0,
            lastWrite: counts.get(collection)?.lastWrite ?? null,
            writable: writable.has(collection),
            rules: ruled === undefined ? null : { key: ruled.key, ...ruled.value },
          }
        })
      })

      const details = Effect.fnUntraced(function* () {
        return yield* Effect.forEach(yield* summaries(live), (summary) =>
          live.list(summary.name, { limit: 1, cursor: undefined }).pipe(
            Effect.orDie,
            Effect.map(({ docs: [newest] }): CollectionDetail => ({
              ...summary,
              sample: newest === undefined ? null : sampleOf(newest.data),
            })),
          ),
        )
      })

      const info = Effect.fn("AppDO.info")(function* () {
        const current = yield* versions.live()
        const stored = yield* sealed.status()
        const read = yield* versions.config()
        const config = settingsOf(read)
        const listedSecrets = declaredSecrets(config)

        return {
          version: current?.version ?? null,
          deployedAt: current?.deployedAt ?? null,
          promotedAt: current?.promotedAt ?? null,
          files: [...(current?.files.keys() ?? [])].toSorted(),
          unreadable: read.kind === "unreadable" ? read.problem : null,
          collections: yield* details(),
          functions: yield* functionDetails(),
          webhooks: yield* Effect.forEach(Object.entries(config.webhooks ?? {}), ([fn, hook]) =>
            Effect.map(hookSecrets.get(fn, undefined), (secret) => {
              const check = checkOf(hook)

              return {
                function: fn,
                path: `_hook/${fn}`,
                verify: hook.verify,
                header: headerOf(check),
                secret:
                  check.kind === "none"
                    ? "none: anyone may POST it"
                    : secret === undefined
                      ? "none yet: webhook_secret makes it (deliveries are refused until then)"
                      : `made ${secret.at}; webhook_secret with rotate: true makes a new one`,
              }
            }),
          ),
          secrets: [...new Set([...listedSecrets.keys(), ...stored.keys()])]
            .toSorted()
            .map((n) => ({
              name: n,
              about: listedSecrets.get(n)?.for ?? null,
              hosts:
                [...(listedSecrets.get(n)?.hosts ?? [])].length === 0
                  ? null
                  : [...(listedSecrets.get(n)?.hosts ?? [])],
              set: stored.has(n),
              at: stored.get(n)?.at ?? null,
            })),
          network: [...(config.network ?? [])],
          skills: (yield* skills()).map((s) => ({
            uri: s.uri,
            name: s.frontmatter.name,
            description: s.frontmatter.description,
            files: s.resources.length,
          })),
          uses: Object.entries(config.uses ?? {}).map(([connection, why]) => ({ connection, why })),
          usage: yield* appUsage.summary(),
          later: (yield* (yield* sql.exec<{
            env: string
            fn: string
            at: number
            key: string
          }>("SELECT env, fn, at, key FROM laters ORDER BY at LIMIT 20")).toArray()).map((r) => ({
            function: r.fn,
            at: new Date(r.at).toISOString(),
            key: r.key,
            env: r.env === "" ? null : r.env,
          })),
          schedules: yield* schedules.list(),
          environments: yield* Effect.forEach(yield* environments(), ({ env, version }) =>
            Effect.map(
              Effect.flatMap(envData(env), (data) => summaries(data, version)),
              (collections) => ({ env, version, collections }),
            ),
          ),
          versions: yield* versions.history(),
        }
      })

      const writeProblem = Effect.fnUntraced(function* (target: Target, collection: string) {
        const here = name()

        if (target.kind === "outside") {
          return {
            code: "live_from_preview" as const,
            message: `"${here}" isn't deployed into preview environment "${target.env}", so pages there read its live data, read-only: a preview page never changes live data. To test writes to "${here}", ${joinHint(here, target.env)}`,
          }
        }

        const request = yield* HttpServerRequest
        const caller = request.headers["x-openbelt-caller"]
        const callerEnv = request.headers["x-openbelt-caller-env"]

        if (caller === undefined) {
          return {
            code: "not_writable" as const,
            message: `this write to "${here}" didn't come through an app's host, so OpenBelt can't tell which app's page sent it, and refused it: pages write from their own app's host (db.collection, or db.app("${here}") from another app)`,
          }
        }

        if (target.kind === "live" && callerEnv !== undefined) {
          return {
            code: "live_from_preview" as const,
            message: `a page in preview environment "${callerEnv}" never changes live data, and this is "${here}"'s live "${collection}". To test writes to "${here}", ${joinHint(here, callerEnv)}`,
          }
        }

        if (caller === here) return undefined

        const config = settingsOf(
          yield* versions.config(target.kind === "env" ? target.version : undefined),
        )

        if ((config.writable ?? []).includes(collection)) return undefined

        return {
          code: "not_writable" as const,
          message: `pages of "${caller}" can't change "${here}"'s "${collection}": another app's collections are read-only. To accept writes from other apps, "${here}" lists the collection in its openbelt.json: {"writable": ["${collection}"]}`,
        }
      })

      /** The live version's own skills (skills/<name>/ with a SKILL.md whose frontmatter names it), by name. */
      const ownSkills = Effect.fnUntraced(function* () {
        const current = yield* versions.live()

        if (current === undefined) return []

        const out: Array<SkillEntry> = []

        for (const [folder, inside] of [...foldersOf(current.files).folders].toSorted(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const md = inside.get(SKILL_FILE)

          if (md === undefined) continue

          const front = yield* frontmatterByHash(folder, md.hash, versions.body(md.hash))

          if (front !== undefined) out.push(entryOf(name(), folder, inside, front))
        }

        return out
      })

      /** The skill OpenBelt writes for this app: what it is, its data and functions, and how to use them. */
      /** The app's own skill as first written for the live version: what it says can't change between a manifest and a read. */
      const APP_SKILL = "skill:app"

      const appSkillText = Effect.fnUntraced(function* () {
        const version = (yield* versions.live())?.version ?? ""
        const kept = kv.get<{ readonly version: string; readonly text: string }>(APP_SKILL)

        if (kept?.version === version) return kept.text

        const text = yield* writeAppSkill()

        kv.put(APP_SKILL, { version, text })

        return text
      })

      const writeAppSkill = Effect.fnUntraced(function* () {
        const config = settingsOf(yield* versions.config())
        const { origin } = workspaceOf()

        return appSkill({
          app: name(),
          url: URL.canParse(origin) ? frameUrl(origin, name()) : name(),
          description: config.description ?? "",
          collections: yield* summaries(live),
          functions: yield* functionsOf(undefined),
          uses: Object.keys(config.uses ?? {}),
          skills: skillSummaries(yield* ownSkills()),
        })
      })

      /** Every skill of the live version: the app's own (OpenBelt's) first, then those in its skills/. None before it's live. */
      const skills = Effect.fnUntraced(function* () {
        if ((yield* versions.live()) === undefined) return []

        return [yield* appSkillEntry(name(), yield* appSkillText()), ...(yield* ownSkills())]
      })

      /** One file of a skill, by its path after skill://<app>/: undefined when no skill of the live version has it. */
      const skillFile = Effect.fnUntraced(function* (path: string) {
        const current = yield* versions.live()

        if (current === undefined) return undefined

        const uri = skillUri(name(), path)
        const file = filePathOf(path)

        if (file === undefined)
          return skillFileOf(
            uri,
            contentType(SKILL_FILE),
            new TextEncoder().encode(yield* appSkillText()),
          )

        const folder = path.split("/")[0] ?? ""
        const entry = current.files.get(file)

        if (entry === undefined || !(yield* ownSkills()).some((s) => s.frontmatter.name === folder))
          return undefined

        const bytes = yield* versions.body(entry.hash)

        return bytes === undefined ? undefined : skillFileOf(uri, contentType(file), bytes)
      })

      const functionsOf = Effect.fnUntraced(function* (version: string | undefined) {
        const config = settingsOf(yield* versions.config(version))

        return Object.keys(config.functions ?? {}).flatMap((fn): Array<FunctionSummary> => {
          const contract = contractOf(config, fn)

          if (contract === undefined) return []

          return [
            {
              name: fn,
              about: contract.about,
              kind: contract.kind,
              signature: signature(fn, contract, seenOf(fn)),
              call:
                notCallable(config, name(), fn) === undefined
                  ? `call_function({ app: "${name()}", function: "${fn}", input })`
                  : null,
            },
          ]
        })
      })

      const schemasOf = (fn: string, contract: FunctionContract | undefined) => {
        const seen = seenOf(fn)

        return {
          typed: contract?.input !== undefined,
          input: schemaJson(contract?.input ?? seen.input?.schema ?? null),
          output: schemaJson(contract?.output ?? seen.output?.schema ?? null),
        }
      }

      const functionDetails = Effect.fnUntraced(function* () {
        const config = settingsOf(yield* versions.config())
        const listed = yield* functionsOf(undefined)
        const last = yield* runs.lastOf(listed.map((f) => f.name))

        return listed.map((f): FunctionDetail => {
          const trigger = config.triggers?.[f.name]?.on
          const ons = trigger === undefined ? [] : onsOf(trigger)

          return {
            ...f,
            ...schemasOf(f.name, contractOf(config, f.name)),
            triggers: [
              ...(config.schedules?.[f.name] === undefined ? [] : ["schedule"]),
              ...(config.webhooks?.[f.name] === undefined ? [] : ["webhook"]),
              ...ons.map((on) => `data:${on}`),
            ],
            last: last.get(f.name) ?? null,
          }
        })
      })

      const bundleOfVersion = Effect.fnUntraced(function* (version: string) {
        const config = settingsOf(yield* versions.config(version))
        const files = (yield* versions.get(version))?.files ?? new Map<string, { hash: string }>()

        const hashes = Object.keys(config.functions ?? {})
          .toSorted()
          .flatMap((fn) => {
            const entry = files.get(functionPath(fn))

            return entry === undefined ? [] : [[fn, entry.hash] as const]
          })

        const code = Effect.forEach(hashes, ([fn, hash]) =>
          Effect.map(
            versions.body(hash),
            (bytes) => [fn, bytes === undefined ? "" : new TextDecoder().decode(bytes)] as const,
          ),
        )

        return { hashes, code }
      })

      const functionCode = Effect.fnUntraced(function* (version: string, fn: string) {
        const config = settingsOf(yield* versions.config(version))
        const contract = contractOf(config, fn)

        if (contract === undefined) return undefined

        const entry = (yield* versions.get(version))?.files.get(functionPath(fn))
        const bytes = entry === undefined ? undefined : yield* versions.body(entry.hash)

        if (entry === undefined || bytes === undefined) return undefined

        return { hash: entry.hash, code: new TextDecoder().decode(bytes), contract, config }
      })

      const attemptOf = (
        env: string | undefined,
        version: string,
        writer: Writer,
        run: {
          readonly fn: string
          readonly kind: "function" | "query"
          readonly caller: Caller | null
          readonly via: string
          readonly authority: RunAuthority
          readonly trace: string
          readonly config: AppConfig
          readonly values: ReadonlyMap<string, string>
          readonly problems: ReadonlyMap<string, string>
          readonly unsigned: ReadonlyMap<string, string>
          readonly nonce: string
          readonly depth: number
          readonly tree: Tree
          readonly chain: ReadonlyArray<string>
          readonly sendsForReal: boolean
          readonly readonly: boolean
          readonly unseen: Unseen
          readonly turn: boolean
          readonly committed: () => void
        },
      ) => {
        const readDocs = new Map<string, { collection: string; id: string; seq: number }>()
        const readCollections = new Map<string, number>()

        const pending = new Map<
          string,
          { collection: string; id: string; doc: Doc | null; born: boolean }
        >()

        const laters: Array<Later> = []
        let reads = 0
        let everythingAt: number | null = null
        const effects: Array<string> = []
        const moves: Array<Moved> = []
        const inflight = new Set<Deferred.Deferred<void>>()
        let overwrote: string | undefined
        let blocked = false

        const rebase = (moved: Moved) => {
          for (const doc of moved.docs) {
            const mine = readDocs.get(docKey(doc.collection, doc.id))

            if (mine !== undefined && mine.seq === doc.before)
              readDocs.set(docKey(doc.collection, doc.id), { ...mine, seq: doc.after })
          }

          for (const listed of moved.collections) {
            if (readCollections.get(listed.collection) === listed.before)
              readCollections.set(listed.collection, listed.after)
          }

          if (everythingAt === moved.seq.before) everythingAt = moved.seq.after

          moves.push(moved)
        }

        const absorb = (read: RunReads) => {
          for (const doc of read.docs) {
            if (!readDocs.has(docKey(doc.collection, doc.id)))
              readDocs.set(docKey(doc.collection, doc.id), doc)
          }

          for (const listed of read.collections) {
            if (!readCollections.has(listed.collection))
              readCollections.set(listed.collection, listed.version)
          }

          if (read.everything !== null && everythingAt === null) everythingAt = read.everything
        }

        const outside = Effect.fnUntraced(function* (
          op: Extract<Op, { op: "fetch" | "hmac" | "tool" | "call" | "notify" }>,
        ) {
          const { origin } = workspaceOf()

          if (op.op === "notify") {
            const problem = noticeProblem(op)

            if (problem !== undefined) return yield* new Refused({ message: `notify: ${problem}` })

            const { workspace } = workspaceOf()

            if (workspace === undefined)
              return yield* new Refused({ message: "notify: this app isn't in a workspace" })

            const to = op.to.join(", ")

            if (env !== undefined && !run.sendsForReal) {
              yield* log(
                "info",
                run.trace,
                `function ${run.fn}: notify ${to} not sent: preview ${env} doesn't send for real (preview_side_effects)`,
              )

              return { devices: 0, reached: [], notOptedIn: [], preview: env }
            }

            const sent = yield* workspaceStub(workspace).notify(
              name(),
              op.to,
              {
                title: op.title,
                body: op.body,
                navigate: `${origin}/${name()}${op.path}`,
              },
              origin.startsWith("https://") ? origin : "https://openbelt.com",
            )

            effects.push(`notify ${to}`)

            yield* log(
              sent.failed === 0 ? "info" : "warn",
              run.trace,
              `function ${run.fn}: notify ${to}: ${sent.devices} ${sent.devices === 1 ? "device" : "devices"}${sent.failed === 0 ? "" : `, ${sent.failed} failed (${sent.why.join("; ")})`}${sent.notOptedIn.length === 0 ? "" : `; not allowed yet by ${sent.notOptedIn.join(", ")} (${name()}'s page asks them)`}`,
            )

            return { devices: sent.devices, reached: sent.reached, notOptedIn: sent.notOptedIn }
          }

          if (op.op === "hmac") {
            const unavailable = run.problems.get(op.secret)

            if (unavailable !== undefined && !run.values.has(op.secret))
              return yield* new Refused({ message: `secrets.hmac: ${unavailable}` })

            const value = declaredSecrets(run.config).has(op.secret)
              ? run.values.get(op.secret)
              : undefined

            if (value === undefined)
              return yield* new Refused({
                message: `secrets.hmac: ${name()}'s secret ${op.secret} isn't set yet: ${howToSet(name(), op.secret, origin)}`,
              })

            const unsigned = run.unsigned.get(op.secret)

            if (unsigned !== undefined) {
              yield* log(
                "warn",
                run.trace,
                `function ${run.fn}: secrets.hmac(${op.secret}) refused: ${unsigned}`,
              )

              return yield* new Refused({ message: unsigned })
            }

            return yield* hmacHex(value, op.text)
          }

          if (op.op === "fetch") {
            const outcome = yield* outbound(
              op,
              {
                app: name(),
                origin,
                network: run.config.network ?? [],
                secrets: {
                  declared: declaredSecrets(run.config),
                  values: run.values,
                  problems: run.problems,
                },
                reach,
                preview: env === undefined ? null : { env, live: run.sendsForReal },
                nonce: run.nonce,
                nonces,
              },
              run.fn,
            )

            yield* log(
              outcome.ok ? "info" : "warn",
              run.trace,
              scrub(forget(outcome.line, nonces), run.values),
            )

            if (outcome.effect) effects.push(`${op.method.toUpperCase()} ${new URL(op.url).host}`)

            if (!outcome.ok) return yield* new Refused({ message: outcome.error })

            return outcome.reply
          }

          if (op.op === "call") {
            if (run.depth >= MAX_CALL_DEPTH)
              return yield* new Refused({
                message: `ctx.call("${op.fn}"): runs calling runs go at most ${MAX_CALL_DEPTH} deep`,
              })

            const unseen: Unseen = {
              by: run.unseen.by === "" ? run.fn : `${run.unseen.by} → ${run.fn}`,
              docs: new Set([...run.unseen.docs, ...pending.keys()]),
              collections: new Set([
                ...run.unseen.collections,
                ...[...pending.values()].map((p) => p.collection),
              ]),
            }

            let landed = false

            const inner = yield* execute({
              env,
              fn: op.fn,
              input: op.input ?? null,
              caller: run.caller,
              via: run.via,
              origin: run.authority,
              trace: run.trace,
              depth: run.depth + 1,
              tree: run.tree,
              chain: run.chain,
              unseen,
              turn: run.turn,
              readonly: run.readonly,
              committed: () => {
                landed = true
                run.committed()
              },
            }).pipe(
              Effect.catchTag("Missing", (e) =>
                Effect.fail(new Refused({ message: `ctx.call: ${e.message}` })),
              ),
              Effect.tapDefect(() =>
                Effect.sync(() => {
                  if (landed)
                    effects.push(
                      `ctx.call("${op.fn}"), which committed before OpenBelt failed on it`,
                    )
                }),
              ),
            )

            const sent = inner.effects ?? []
            const wrote = inner.moves.reduce((n, moved) => n + moved.docs.length, 0)

            const did = [
              ...(inner.moves.length === 0
                ? []
                : [wrote > 0 ? `committed ${wrote} documents` : "committed (a later run)"]),
              ...(sent.length === 0 ? [] : [`sent ${sent.join(", ")}`]),
            ]

            if (did.length > 0) effects.push(`ctx.call("${op.fn}"), which ${did.join(" and ")}`)

            for (const moved of inner.moves) rebase(moved)

            if (!(inner.ok && inner.committed)) absorb(inner.checked)

            const under = inner.moves
              .flatMap((moved) => moved.docs)
              .find((doc) => pending.has(docKey(doc.collection, doc.id)))

            if (under !== undefined) {
              overwrote = `ctx.call("${op.fn}") committed ${under.collection}/${under.id} while this run had a write to it that wasn't committed yet, which would have undone the call's: await each ctx.call before writing what it writes`

              return yield* new Refused({ message: overwrote })
            }

            if (!inner.ok)
              return yield* new Refused({
                message: `ctx.call("${op.fn}") failed (${inner.kind}), so none of its writes were committed: ${inner.error}`,
              })

            return inner.result
          }

          const { workspace } = workspaceOf()

          const carried = carriedIn(
            run.values,
            [op.connection, op.tool, JSON.stringify(op.input)],
            () => true,
          )

          if (carried !== undefined) {
            const connection = detailOf(op.connection, run.values).slice(0, 60)
            const named = `${connection}.${detailOf(op.tool, run.values).slice(0, 60)}`

            yield* log(
              "warn",
              run.trace,
              `function ${run.fn}: ${named} refused (${carried.kind === "unchecked" ? "too slow to check for secrets" : `holds secret ${carried.name}'s value`})`,
            )

            return yield* new Refused({
              message: `ctx.connections.${named}: ${carriedMessage(name(), carried, `the ${connection} connection`)}`,
            })
          }

          if (run.authority.kind === "public" && !run.authority.uses.includes(op.connection))
            return yield* new Refused({
              message: `ctx.connections${member(op.connection)} isn't available: ${notListed(run.authority.fn, "uses", `"${op.connection}"`)}`,
            })

          if (!Object.hasOwn(run.config.uses ?? {}, op.connection))
            return yield* new Refused({
              message: `ctx.connections${member(op.connection)}: ${name()}'s openbelt.json "uses" doesn't list "${op.connection}": add "uses": {"${op.connection}": "why the app needs it"} and deploy`,
            })

          if (workspace === undefined)
            return yield* new Refused({
              message: `${name()} was deployed before functions could call connections: deploy it again`,
            })

          const called = yield* workspaceStub(workspace)
            .functionTool(
              name(),
              env,
              run.authority,
              run.via,
              op.connection,
              op.tool,
              op.input,
              op.as,
              run.trace,
              origin,
            )
            .pipe(
              Effect.catchCause((cause) =>
                log(
                  "warn",
                  run.trace,
                  `function ${run.fn}: ${op.connection}.${op.tool}: the workspace didn't answer: ${detailOf(String(cause), run.values)}`,
                ).pipe(
                  Effect.as<ToolCalled>({
                    ok: false,
                    error: `the workspace didn't answer (trace ${run.trace}): it may have been sent; app_logs has the detail`,
                    sent: true,
                  }),
                ),
              ),
            )

          const qualified = `${op.connection}.${op.tool}`

          if (called.ok ? !called.readOnly && !called.previewed : called.sent)
            effects.push(qualified)

          const redact = redactAnswer(run.values)

          if (!called.ok) {
            const error = redact.text(called.error)

            yield* log("warn", run.trace, `function ${run.fn}: ${qualified} refused: ${error}`)

            return yield* new Refused({ message: error })
          }

          yield* log(
            called.isError ? "warn" : "info",
            run.trace,
            called.previewed
              ? `function ${run.fn}: ${qualified} not sent (preview ${env ?? ""}: it isn't read-only; answered { previewed: true })`
              : `function ${run.fn}: ${qualified} ${called.isError ? "tool_error" : "ok"} in ${called.ms}ms, as ${called.runsAs}`,
          )

          if (called.isError)
            return yield* new Refused({
              message: `${qualified} answered with an error: ${redact.text(called.text).slice(0, 1000)}`,
            })

          return { text: redact.text(called.text), structured: redact.json(called.structured) }
        })

        const view = Effect.fnUntraced(function* (
          data: Dataset,
          collection: string,
          id: string,
          track: boolean,
        ) {
          const mine = pending.get(docKey(collection, id))

          if (mine !== undefined) return { doc: mine.doc, born: mine.born }

          const doc = yield* data.get(collection, id)

          if (track && !readDocs.has(docKey(collection, id)))
            readDocs.set(docKey(collection, id), {
              collection,
              id,
              seq: doc?.seq ?? 0,
            })

          return { doc, born: doc === null }
        })

        const written = (collection: string, id: string, data: Json, before: Doc | null): Doc => {
          const now = new Date().toISOString()

          return {
            id,
            collection,
            data,
            ...stampOf({ by: writer }, before),
            created: before?.created ?? now,
            updated: now,
            seq: before?.seq ?? 0,
          }
        }

        const keep = (collection: string, id: string, doc: Doc | null, born: boolean) => {
          pending.delete(docKey(collection, id))
          pending.set(docKey(collection, id), { collection, id, doc, born })
        }

        const unseenBy = (op: Op) => {
          const { by, docs, collections } = run.unseen

          const what =
            op.op === "collections"
              ? docs.size > 0
                ? "db.collections()"
                : undefined
              : op.op === "list"
                ? collections.has(op.collection)
                  ? `listing ${op.collection}`
                  : undefined
                : op.op === "get" || op.op === "set" || op.op === "update" || op.op === "delete"
                  ? docs.has(docKey(op.collection, op.id))
                    ? `${op.op} ${op.collection}/${op.id}`
                    : undefined
                  : undefined

          return what === undefined
            ? undefined
            : `${what}: ${by}, which ctx.call'd this run, wrote there and hasn't committed it, and a ctx.call doesn't see its caller's uncommitted writes. In ${by}, make that write after the ctx.call returns, or pass what this function needs as its input`
        }

        const overspent = (op: Op) => {
          const { tree } = run
          const limits = FUNCTION_LIMITS.tree
          const within = `${tree.root} and every run it ctx.call'd or its writes triggered, together`
          const most = `the most one call tree may${tree.reruns === 0 ? "" : ` (counting ${tree.reruns} ${tree.reruns === 1 ? "attempt" : "attempts"} run again because what they read changed)`}`

          if (op.op === "call") {
            if (tree.runs >= limits.runs)
              return `ctx.call("${op.fn}"): ${within}, made ${limits.runs} runs, ${most}. Call once with a list instead of once per item, or spread the work over runs of their own with ctx.later`

            tree.runs += 1
          } else if (op.op === "fetch" || op.op === "tool" || op.op === "notify") {
            if (tree.requests >= limits.requests)
              return `${within}, made ${limits.requests} fetches and connection calls, ${most}: make fewer, or spread them over runs of their own with ctx.later`

            tree.requests += 1
          } else if (op.op !== "hmac") {
            if (tree.calls >= limits.calls)
              return `${within}, made ${limits.calls} db calls, ${most}: make fewer (list takes a limit up to 1000), or spread them over runs of their own with ctx.later`

            tree.calls += 1
          }

          return undefined
        }

        // A run anyone started on the public host reads members' documents as the public host shows them: emails as opaque ids.
        const seen = <D extends Doc>(doc: D): D =>
          run.authority.kind === "public" ? masked(doc) : doc

        /** ctx.files.read(id): the file's record and bytes; ctx.files.url(id): a url anyone who has it reads the file at, until it expires. */
        const fileOp = Effect.fnUntraced(function* (
          op: Extract<Op, { op: "fileRead" | "fileUrl" }>,
        ) {
          const what = op.op === "fileRead" ? "ctx.files.read" : "ctx.files.url"
          const { workspace, origin } = workspaceOf()

          const [file] = yield* (yield* sql.exec<{
            id: string
            name: string | null
            type: string
            size: number
          }>("SELECT id, name, type, size FROM files WHERE id = ?", op.id)).toArray()

          if (workspace === undefined || file === undefined)
            return yield* new Missing({
              message: `${what}("${op.id.slice(0, 80)}"): there's no file with that id in ${name()} (files.put on its pages gives { id, url }; only this app's own files are read)`,
            })

          const key = `${workspace}/${state.id.toString()}/${file.id}`

          if (op.op === "fileUrl") {
            if (!URL.canParse(origin))
              return yield* new Refused({
                message: `${what}: ${name()} doesn't know its address yet: deploy it again (deploy_app), then call this again`,
              })

            const ms = op.expiresIn === undefined ? FILE_URL_MS.default : inMs(op.expiresIn)

            if (ms === undefined || ms <= 0 || ms > FILE_URL_MS.most)
              return yield* new Refused({
                message: `${what}'s expiresIn is ms, or a string like "10m", "2h", "7d", up to 7 days; "${String(op.expiresIn).slice(0, 40)}" isn't one`,
              })

            const expires = Math.floor((Date.now() + ms) / 1000)

            yield* log(
              "info",
              run.trace,
              `function ${run.fn}: files.url ${file.id} until ${new Date(expires * 1000).toISOString()}`,
            )

            return {
              url: `${appOrigin(origin, name())}/_files/${file.id}?${fileUrlQuery(secretsKey, key, expires)}`,
              expires: new Date(expires * 1000).toISOString(),
            }
          }

          if (file.size > FILE_READ_BYTES)
            return yield* new Refused({
              message: `${what}: ${file.id} is ${sizeOf(file.size)}, and a function reads at most ${sizeOf(FILE_READ_BYTES)}: hand the service a link instead (ctx.files.url(id))`,
            })

          const bytes = yield* Effect.tryPromise(() =>
            new Response(Runtime.fileStore.read(key)).bytes(),
          ).pipe(
            Effect.tapError(() => Effect.sync(() => Runtime.recordFileStoreError("read"))),
            Effect.mapError(
              (error) =>
                new Refused({
                  message: `${what}: the file store failed reading ${file.id}: ${error.message}`,
                }),
            ),
          )

          Runtime.recordFileDownload(bytes.byteLength)

          yield* log(
            "info",
            run.trace,
            `function ${run.fn}: files.read ${file.id}${file.name === null ? "" : ` "${file.name}"`} (${file.type}, ${sizeOf(bytes.byteLength)})`,
          )

          return {
            id: file.id,
            name: file.name,
            type: file.type,
            size: bytes.byteLength,
            bytes: bytes.toBase64(),
          }
        })

        const answer: Answer = Effect.fnUntraced(function* (asked: Op) {
          const op = forgotten(asked, nonces)
          const spent = overspent(op)

          if (spent !== undefined) return yield* new Refused({ message: spent })

          const data = yield* dataOf(env)

          if (op.op === "collections") {
            const hidden = unseenBy(op)

            if (hidden !== undefined) return yield* new Refused({ message: hidden })

            if (everythingAt === null) everythingAt = data.seq()

            return yield* summaries(data, version)
          }

          const refused = QUERY_MAY_NOT[op.op]

          if (run.kind === "query" && refused !== undefined)
            return yield* new Refused({ message: queryRefusal(run.fn, refused) })

          if (run.readonly) {
            const writes = readonlyRefusal(op)
            const tool = op.op === "tool" ? `${op.connection}.${op.tool}` : undefined
            const { workspace } = workspaceOf()

            const changesOutside =
              tool !== undefined &&
              (workspace === undefined || !(yield* workspaceStub(workspace).toolOnlyReads(tool)))

            if (writes !== undefined || changesOutside) {
              blocked = true

              return yield* new Refused({
                message: `check_app is read-only (readonly: true), so "${run.fn}" may only read: it can't ${writes ?? `call ${tool ?? ""}, a connection tool that isn't read-only`}. Test what it changes in a preview environment, or without readonly`,
              })
            }
          }

          const hidden = unseenBy(op)

          if (hidden !== undefined) return yield* new Refused({ message: hidden })

          if (
            op.op === "fetch" ||
            op.op === "hmac" ||
            op.op === "tool" ||
            op.op === "call" ||
            op.op === "notify"
          )
            return yield* outside(op).pipe(
              Effect.catchDefect((defect) =>
                Effect.gen(function* () {
                  if (op.op === "fetch" && !["GET", "HEAD"].includes(op.method.toUpperCase()))
                    effects.push(`${op.method.toUpperCase()} (it failed inside OpenBelt)`)

                  yield* log(
                    "error",
                    run.trace,
                    forget(
                      `function ${run.fn}: ${op.op} failed inside OpenBelt: ${detailOf(String(defect), run.values)}`,
                      nonces,
                    ),
                  )

                  return yield* new Refused({
                    message:
                      defect instanceof Unchecked
                        ? `${op.op}: it was sent, but ${defect.message}, so OpenBelt withheld the answer (trace ${run.trace})`
                        : `${op.op}: OpenBelt failed on it (trace ${run.trace}); app_logs has the detail`,
                  })
                }),
              ),
            )

          if (op.op === "later") return yield* bookLater(env, version, op, laters)

          if (op.op === "fileRead" || op.op === "fileUrl") return yield* fileOp(op)

          const problem =
            collectionProblem(op.collection) ?? ("id" in op ? docIdProblem(op.id) : undefined)

          if (problem !== undefined) return yield* new Refused({ message: problem })

          const { collection } = op

          switch (op.op) {
            case "list": {
              reads += 1

              const limit = Math.min(Math.max(Math.trunc(op.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

              if (!readCollections.has(collection))
                readCollections.set(collection, yield* data.version(collection))

              const page = yield* data.list(collection, {
                limit,
                cursor: op.cursor ?? undefined,
              })

              const docs = page.docs.flatMap((doc) => {
                const mine = pending.get(docKey(collection, doc.id))

                return mine === undefined ? [doc] : mine.doc === null ? [] : [mine.doc]
              })

              const made =
                op.cursor === undefined || op.cursor === null
                  ? [...pending.values()]
                      .filter((p) => p.collection === collection && p.born && p.doc !== null)
                      .flatMap((p) => (p.doc === null ? [] : [p.doc]))
                      .toReversed()
                  : []

              return { docs: [...made, ...docs].map(seen), cursor: page.cursor }
            }

            case "get": {
              reads += 1

              const { doc } = yield* view(data, collection, op.id, true)

              return doc === null ? null : seen(doc)
            }

            case "add": {
              const id = crypto.randomUUID()

              yield* sized(op.data)

              const doc = written(collection, id, op.data, null)

              keep(collection, id, doc, true)

              return seen(doc)
            }

            case "set":
            case "update": {
              const { doc: before, born } = yield* view(
                data,
                collection,
                op.id,
                op.op === "update" || op.ifSeq !== undefined,
              )

              if (op.op === "update" && before === null && op.ifSeq !== 0)
                return yield* missing(collection, op.id)

              const next =
                op.op === "update" ? yield* mergeInto(collection, op.id, before, op.data) : op.data

              yield* checkSeq(collection, op.id, before, op.ifSeq)
              yield* sized(next)

              const doc = written(collection, op.id, next, before)

              keep(collection, op.id, doc, born)

              return seen(doc)
            }

            default: {
              const { doc: before, born } = yield* view(data, collection, op.id, true)

              if (before === null) return yield* missing(collection, op.id)

              yield* checkSeq(collection, op.id, before, op.ifSeq)
              keep(collection, op.id, null, born)

              return seen(before)
            }
          }
        })

        const tracked: Answer = (op) => {
          const done = Deferred.makeUnsafe<void>()

          inflight.add(done)

          return answer(op).pipe(
            Effect.ensuring(
              Effect.andThen(
                Effect.sync(() => inflight.delete(done)),
                Deferred.succeed(done, undefined),
              ),
            ),
          )
        }

        return {
          answer: tracked,
          laters,
          effects,
          moves,
          overwrote: () => overwrote,
          blocked: () => blocked,
          settle: Effect.fnUntraced(function* () {
            if (inflight.size === 0) return

            const settled = yield* Runtime.idle(
              Effect.forEach([...inflight], Deferred.await).pipe(
                Effect.timeoutOption(Duration.millis(FUNCTION_LIMITS.ms)),
              ),
            )

            if (Option.isNone(settled))
              effects.push(`${inflight.size} calls it didn't await, still going when it ended`)
          }),
          live: (): LiveReads => ({
            docs: [...readDocs.values()].map(({ collection, id }) => ({ collection, id })),
            collections: [...readCollections.keys()],
            everything: everythingAt !== null,
          }),
          reads: () => reads,
          checked: (): RunReads => ({
            docs: [...readDocs.values()],
            collections: [...readCollections].map(([collection, v]) => ({
              collection,
              version: v,
            })),
            everything: everythingAt,
          }),
          writes: (): ReadonlyArray<RunWrite> =>
            [...pending.values()].map((p) => ({
              collection: p.collection,
              id: p.id,
              data: p.doc === null ? null : p.doc.data,
              stamp: { by: writer },
            })),
        }
      }

      const bookLater = Effect.fnUntraced(function* (
        env: string | undefined,
        version: string,
        op: Extract<Op, { op: "later" }>,
        laters: Array<Later>,
      ) {
        if (!lists(settingsOf(yield* versions.config(version)), op.fn)) {
          const listed = (yield* functionsOf(version)).map((f) => f.name)

          return yield* new Refused({
            message: `ctx.later("${op.fn.slice(0, 40)}", ...) names no function of this app: openbelt.json "functions" lists ${listed.join(", ")}`,
          })
        }

        const due = laterAt(op)

        if (Result.isFailure(due)) return yield* new Refused({ message: due.failure })

        const at = due.success

        const input = op.input ?? null

        if (JSON.stringify(input).length > FUNCTION_LIMITS.inputBytes) {
          return yield* new Refused({
            message: `ctx.later's input is at most ${FUNCTION_LIMITS.inputBytes / 1000} KB of JSON: keep the rest in a collection and pass its id`,
          })
        }

        const key = op.key ?? crypto.randomUUID()

        if (key.length > 200 || key === "")
          return yield* new Refused({
            message: "ctx.later's key is 1-200 characters",
          })

        const [booked] = yield* (yield* sql.exec<{ at: number }>(
          "SELECT at FROM laters WHERE env = ? AND key = ?",
          laterEnv(env),
          key,
        )).toArray()

        if (booked !== undefined || laters.some((l) => l.key === key))
          return {
            booked: false,
            key,
            at: new Date(booked?.at ?? at).toISOString(),
          }

        if ((yield* latersIn(env)) + laters.length >= MAX_LATERS) {
          return yield* new Refused({
            message: `this app has ${MAX_LATERS} runs booked with ctx.later${env === undefined ? "" : ` in preview ${env}`}, the most it may: wait for some to run (app_info's later lists them)`,
          })
        }

        laters.push({ fn: op.fn, input, at, key, booking: crypto.randomUUID() })

        return { booked: true, key, at: new Date(at).toISOString() }
      })

      const latersIn = Effect.fnUntraced(function* (env: string | undefined) {
        const [count] = yield* (yield* sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM laters WHERE env = ?",
          laterEnv(env),
        )).toArray()

        return count?.n ?? 0
      })

      const laterTaken = Effect.fnUntraced(function* (
        env: string | undefined,
        laters: ReadonlyArray<Later>,
      ) {
        if (laters.length > 0 && (yield* latersIn(env)) + laters.length > MAX_LATERS)
          return `other runs booked ctx.later runs after this one counted ${MAX_LATERS - laters.length} or fewer`

        for (const later of laters) {
          const [taken] = yield* (yield* sql.exec<{ n: number }>(
            "SELECT 1 AS n FROM laters WHERE env = ? AND key = ?",
            laterEnv(env),
            later.key,
          )).toArray()

          if (taken !== undefined)
            return `ctx.later's key "${later.key}" was booked by another run after this one booked it`
        }

        return undefined
      })

      const bookLaters = Effect.fnUntraced(function* (
        laters: ReadonlyArray<Later>,
        version: string,
        trace: string,
        env: string | undefined,
        chain: ReadonlyArray<string>,
        origin: RunAuthority,
      ) {
        for (const later of laters) {
          yield* sql.exec(
            "INSERT INTO laters (env, key, fn, at, version, trace, booking) VALUES (?, ?, ?, ?, ?, ?, ?)",
            laterEnv(env),
            later.key,
            later.fn,
            later.at,
            version,
            trace,
            later.booking,
          )
          yield* job
            .schedule(`later:${later.booking}`, {
              at: Math.max(later.at, Date.now()),
              payload: {
                kind: "later",
                fn: later.fn,
                input: later.input,
                key: later.key,
                booking: later.booking,
                enqueuedBy: version,
                chain,
                env: env ?? null,
                origin,
              },
            })
            .pipe(Effect.orDie)
        }
      })

      const inFlight = new Map<string, Deferred.Deferred<Outcome | undefined>>()

      const retries = Semaphore.makeUnsafe(1)

      const execute: (spec: RunSpec) => Effect.Effect<Outcome, Missing> = (spec) =>
        Effect.acquireUseRelease(
          Effect.sync(() => nonces.issue()),
          (nonce) =>
            spec.tree !== undefined
              ? runIn(spec, spec.tree, nonce)
              : Effect.acquireUseRelease(
                  Effect.sync(() => trees.start(spec.fn)),
                  (tree) => runIn(spec, tree, nonce),
                  (tree) => trees.release(tree),
                ),
          (nonce) => Effect.sync(() => nonces.end(nonce)),
        )

      const runIn: (spec: RunSpec, tree: Tree, nonce: string) => Effect.Effect<Outcome, Missing> =
        Effect.fn("AppDO.execute")(function* (spec: RunSpec, tree: Tree, nonce: string) {
          const { env, fn, input, caller, via, trace } = spec

          yield* Effect.annotateCurrentSpan({ "openbelt.function": fn, "openbelt.via": via })

          const version = env === undefined ? versions.liveName() : yield* envVersion(env)
          const openbelt = version === undefined ? undefined : yield* versions.config(version)

          if (openbelt?.kind === "unreadable") {
            yield* log("error", trace, `${via} run of ${fn} refused: ${openbelt.problem}`)

            return yield* new Missing({ message: openbelt.problem })
          }

          const found = version === undefined ? undefined : yield* functionCode(version, fn)
          const where = env === undefined ? "" : ` in preview ${env}`

          if (version === undefined || found === undefined) {
            const listed = (yield* functionsOf(version)).map((f) => f.name)

            return yield* new Missing({
              message: `"${name()}" has no function "${fn}"${where}: its openbelt.json "functions" lists ${listed.length === 0 ? "none" : listed.join(", ")}. A function is functions/<name>.js with a line in openbelt.json "functions" (docs({ page: "functions" }))`,
            })
          }

          const carried = authorityOf(spec)

          const authority =
            carried.kind === "public"
              ? grantedNow(carried, settingsOf(yield* versions.config()).public)
              : carried

          const writer: Writer =
            caller !== null
              ? { author: caller.email, name: caller.name }
              : TRIGGER_WRITERS.has(via)
                ? { author: via, name: via }
                : ANONYMOUS

          const { contract, config } = found
          const kind = contract.kind
          const depth = spec.depth ?? 0
          const known = spec.chain ?? []

          const chain =
            Object.hasOwn(config.triggers ?? {}, fn) && !known.includes(fn) ? [...known, fn] : known

          const declared = declaredSecrets(config)

          const withheld = new Map(
            authority.kind !== "public"
              ? []
              : [...declared.keys()].flatMap((secret) =>
                  authority.secrets.includes(secret)
                    ? []
                    : [
                        [
                          secret,
                          `${name()}'s secret ${secret} isn't available: ${notListed(authority.fn, "secrets", "it")}`,
                        ] as const,
                      ],
                ),
          )

          const kept = new Map(
            [...(yield* sealed.values((yield* sealed.status()).keys()))].filter(
              ([secret]) => !withheld.has(secret),
            ),
          )

          const held = new Map([...kept].filter(([secret]) => declared.has(secret)))
          const values = new Map([...kept].map(([secret, h]) => [secret, h.value]))
          const { origin } = workspaceOf()

          const problems = new Map([
            ...withheld,
            ...[...held].flatMap(([secret, h]) => {
              const problem =
                tooShort(name(), secret, h, origin) ??
                widened(
                  name(),
                  secret,
                  h,
                  declared.get(secret)?.hosts ?? config.network ?? [],
                  origin,
                )

              return problem === undefined ? [] : [[secret, problem] as const]
            }),
          ])

          const unsigned = new Map(
            [...held].flatMap(([secret, h]) => {
              const problem =
                problems.get(secret) ?? unsignable(name(), secret, h, config.network ?? [])

              return problem === undefined ? [] : [[secret, problem] as const]
            }),
          )

          const grants: Grants = {
            app: name(),
            nonce,
            uses: Object.keys(config.uses ?? {}),
            secrets: Object.fromEntries(
              [...declared.keys()].map((secret) => [
                secret,
                withheld.has(secret)
                  ? { problem: withheld.get(secret) ?? "" }
                  : values.has(secret)
                    ? Object.fromEntries(
                        problems.has(secret) ? [["problem", problems.get(secret) ?? ""]] : [],
                      )
                    : {
                        problem: `${name()}'s secret ${secret} isn't set yet: ${howToSet(name(), secret, origin)}`,
                      },
              ]),
            ),
          }

          const hideSecrets = (ran: Ran): Ran => {
            if (values.size === 0) return ran

            const logs = ran.logs.map((l) => ({
              ...l,
              text: scrub(forget(l.text, nonces), values),
            }))

            return ran.ok
              ? { ...ran, logs, result: scrubJson(forgetJson(ran.result, nonces), values) }
              : { ...ran, logs, error: scrub(forget(ran.error, nonces), values) }
          }

          const sendsForReal = env === undefined ? false : yield* previewLive(env)

          const inputText = JSON.stringify(input)
          const inputHash = yield* hashOf(inputText)
          const keyHash = spec.keyedOn === undefined ? inputHash : yield* hashOf(spec.keyedOn)
          const key = spec.key ?? null
          const scope = keyScope(fn, env, caller, via, spec.manual)
          const id = newRunId()
          const started = Date.now()

          const record = (outcome: Outcome, extra: { readonly replayed: boolean }) =>
            Effect.andThen(
              extra.replayed
                ? Effect.void
                : Effect.andThen(
                    Runtime.recordRun(outcome.ok ? "ok" : "error", via, outcome.ms),
                    env === undefined ? appUsage.ran(outcome.ok) : Effect.void,
                  ),
              runs.record({
                id: outcome.run,
                fn,
                trigger: via,
                caller: caller?.email ?? null,
                manual: spec.manual ?? null,
                version,
                enqueuedBy: spec.enqueuedBy ?? null,
                env: env ?? null,
                started,
                ms: outcome.ms,
                attempts: outcome.attempts,
                reads: outcome.reads,
                writes: outcome.ok ? outcome.writes : 0,
                outcome: outcome.ok ? "ok" : "error",
                error: outcome.ok ? null : { kind: outcome.kind, message: outcome.error },
                key,
                replayed: extra.replayed,
                input: inputText,
                inputHash,
                result: outcome.ok ? JSON.stringify(outcome.result) : null,
                logs: outcome.logs.map((l) => `${l.level}: ${l.text}`),
                trace,
              }),
            )

          const replay = Effect.fnUntraced(function* (earlier: {
            readonly run: string
            readonly input_hash: string
            readonly result: string
          }) {
            const outcome: Outcome =
              earlier.input_hash !== keyHash
                ? {
                    ok: false,
                    kind: "input",
                    error: `the key "${key}" was used for an earlier run of ${fn} with a different input: a key names one operation, so use a new key for a new one`,
                    logs: [],
                    calls: 0,
                    ms: 0,
                    version,
                    run: id,
                    attempts: 0,
                    reads: 0,
                    replayed: false,
                    checked: NO_READS,
                    moves: [],
                  }
                : {
                    ok: true,
                    result: Option.getOrElse(decodeInput(earlier.result), () => null),
                    logs: [],
                    calls: 0,
                    ms: 0,
                    version,
                    run: id,
                    attempts: 0,
                    reads: 0,
                    writes: 0,
                    replayed: true,
                    replayOf: earlier.run,
                    effects: [],
                    clock: false,
                    checked: NO_READS,
                    committed: false,
                    moves: [],
                  }

            yield* record(outcome, { replayed: outcome.ok })
            yield* log(
              "info",
              trace,
              outcome.ok
                ? `function ${fn}${where} answered from run ${earlier.run} (key ${key}): it didn't run again`
                : `function ${fn}${where} refused: ${outcome.error}`,
            )

            return outcome
          })

          const refuse = Effect.fnUntraced(function* (refusedKind: string, error: string) {
            const outcome: Outcome = {
              ok: false,
              kind: refusedKind,
              error,
              logs: [],
              calls: 0,
              ms: 0,
              version,
              run: id,
              attempts: 0,
              reads: 0,
              replayed: false,
              checked: NO_READS,
              moves: [],
            }

            yield* record(outcome, { replayed: false })
            yield* log(
              "warn",
              trace,
              `function ${fn}${where} refused (${refusedKind}): ${error} (run ${id})`,
            )

            return outcome
          })

          if (spec.expect === "query" && kind !== "query")
            return yield* refuse(
              "kind",
              `"${fn}" isn't a query, so it can't be watched or run with db.query: call it with db.fn("${fn}", input). To watch what it computes, make a query that reads the same data (openbelt.json "functions": {"<name>": {"kind": "query", "description": "..."}})`,
            )

          const uncallable =
            depth === 0 && !TRIGGER_WRITERS.has(via) ? notCallable(config, name(), fn) : undefined

          if (uncallable !== undefined) return yield* refuse("not_callable", uncallable)

          const unfitInput =
            contract.input !== undefined && CHECKED_VIA(via)
              ? misfit(contract.input, input, "input")
              : undefined

          if (contract.input !== undefined && unfitInput !== undefined)
            return yield* refuse(
              "bad_input",
              `its input doesn't fit its openbelt.json input schema: ${unfitInput}. It takes ${typeOf(contract.input)}. It didn't run: fix the input (app_info shows its signature)`,
            )

          if (key !== null && scope === undefined)
            return yield* refuse(
              "signed_out_key",
              "a key needs someone signed in: signed out, every visitor's call would share it, so one could be answered with another's result. Call without a key, or have the viewer sign in",
            )

          const keyed = key === null || scope === undefined ? undefined : { key, scope }
          const latchKey = `${scope ?? "-"}\u0000${key ?? "-"}`

          for (;;) {
            if (keyed === undefined) break

            const earlier = yield* runs.keyed(keyed.scope, keyed.key)

            if (earlier !== undefined) return yield* replay(earlier)

            const running = inFlight.get(latchKey)

            if (running === undefined) break

            const first = yield* Runtime.idle(Deferred.await(running))

            if (first !== undefined) {
              const again = yield* runs.keyed(keyed.scope, keyed.key)

              return again !== undefined ? yield* replay(again) : first
            }
          }

          const latch = Deferred.makeUnsafe<Outcome | undefined>()

          if (keyed !== undefined) inFlight.set(latchKey, latch)

          const landed = () => spec.committed?.()

          const run = Effect.gen(function* () {
            const data = yield* dataOf(env)
            const bundle = yield* bundleOfVersion(version)
            let turn = spec.turn === true

            const attempt = Effect.fnUntraced(function* (n: number) {
              const buffer = attemptOf(env, version, writer, {
                fn,
                kind,
                caller,
                via,
                authority,
                trace,
                config,
                values,
                problems,
                unsigned,
                nonce,
                depth,
                tree,
                chain,
                sendsForReal,
                readonly: spec.readonly === true,
                unseen: spec.unseen ?? NONE_UNSEEN,
                turn,
                committed: landed,
              })

              const raw = yield* functions.run({
                fn,
                bundle,
                input,
                context: {
                  caller:
                    caller === null
                      ? null
                      : { email: caller.email, name: caller.name, groups: caller.groups },
                  via,
                  env: env ?? null,
                  app: name(),
                  kind,
                  run: { id, attempt: n, key },
                  schedule: spec.schedule ?? null,
                },
                grants,
                answer: buffer.answer,
                watch: contract.input === undefined,
                nested: depth > 0,
              })

              yield* buffer.settle()

              const shown = hideSecrets(raw)

              const unfit =
                shown.ok && contract.output !== undefined
                  ? misfit(contract.output, shown.result, "result")
                  : undefined

              const overwrote = buffer.overwrote()

              if (overwrote !== undefined)
                return {
                  ran: {
                    ok: false,
                    kind: "threw",
                    error: `${overwrote}. Nothing this run wrote was kept`,
                    logs: shown.logs,
                    calls: shown.calls,
                    requests: shown.requests,
                    ms: shown.ms,
                    clock: shown.clock,
                  } satisfies Ran,
                  buffer,
                  stale: undefined,
                  writes: 0,
                  failedKind: "conflict",
                  moved: undefined,
                }

              const ran: Ran =
                shown.ok && unfit !== undefined
                  ? {
                      ok: false,
                      kind: "threw",
                      error: `it returned a result its openbelt.json output schema refuses: ${unfit}. Nothing it wrote was kept: fix functions/${fn}.js or its "output" schema`,
                      logs: shown.logs,
                      calls: shown.calls,
                      requests: shown.requests,
                      ms: shown.ms,
                      clock: shown.clock,
                    }
                  : shown

              const failedKind =
                shown.ok && unfit !== undefined
                  ? "output"
                  : !shown.ok && buffer.blocked()
                    ? "check_readonly"
                    : undefined

              if (!ran.ok)
                return { ran, buffer, stale: undefined, writes: 0, failedKind, moved: undefined }

              if (kind === "query") {
                const checked = yield* data
                  .commitRun({
                    reads: buffer.checked(),
                    writes: [],
                    by: writer,
                    trace,
                    chain: [],
                    origin: authority,
                    tree,
                    inside: () => Effect.void,
                  })
                  .pipe(Effect.orDie)

                return {
                  ran,
                  buffer,
                  stale: "stale" in checked ? checked.stale : undefined,
                  writes: 0,
                  failedKind,
                  moved: undefined,
                }
              }

              const writes = buffer.writes()

              if (writes.length === 0 && buffer.laters.length === 0 && key === null)
                return { ran, buffer, stale: undefined, writes: 0, failedKind, moved: undefined }

              const full = writes.some((w) => w.data !== null)
                ? yield* storageFull(trace)
                : undefined

              if (full !== undefined) {
                const refused: Ran = {
                  ok: false,
                  kind: "threw",
                  error: full,
                  logs: ran.logs,
                  calls: ran.calls,
                  requests: ran.requests,
                  ms: ran.ms,
                  clock: ran.clock,
                }

                return {
                  ran: refused,
                  buffer,
                  stale: undefined,
                  writes: 0,
                  failedKind,
                  moved: undefined,
                }
              }

              const committing = yield* Effect.result(
                data.commitRun({
                  reads:
                    writes.length === 0 && buffer.laters.length === 0 ? NO_READS : buffer.checked(),
                  writes,
                  by: writer,
                  trace,
                  chain,
                  origin: authority,
                  tree,
                  check: () => laterTaken(env, buffer.laters),
                  inside: Effect.fnUntraced(function* () {
                    if (keyed !== undefined)
                      yield* runs.remember(
                        keyed.scope,
                        keyed.key,
                        id,
                        keyHash,
                        JSON.stringify(ran.result),
                      )

                    yield* bookLaters(buffer.laters, version, trace, env, chain, authority)
                  }),
                }),
              )

              if (Result.isFailure(committing)) {
                const refused: Ran = {
                  ok: false,
                  kind: "threw",
                  error: committing.failure.message,
                  logs: ran.logs,
                  calls: ran.calls,
                  requests: ran.requests,
                  ms: ran.ms,
                  clock: ran.clock,
                }

                return {
                  ran: refused,
                  buffer,
                  stale: undefined,
                  writes: 0,
                  failedKind,
                  moved: undefined,
                }
              }

              const committed = committing.success

              if ("moved" in committed) landed()

              return {
                ran,
                buffer,
                stale: "stale" in committed ? committed.stale : undefined,
                writes: writes.length,
                failedKind,
                moved: "moved" in committed ? committed.moved : undefined,
              }
            })

            const again = Effect.fnUntraced(function* (n: number, why: string) {
              tree.reruns += 1

              yield* log(
                "info",
                trace,
                `function ${fn}${where} run ${id}: ${why}, so nothing was written and it runs again on the new data (attempt ${n})`,
              )

              return yield* attempt(n)
            })

            let n = 1
            let last = yield* attempt(1)

            const rerunnable = (one: typeof last) =>
              one.stale !== undefined && one.buffer.effects.length === 0 && n < MAX_ATTEMPTS

            const rerun = Effect.gen(function* () {
              let current = last

              while (rerunnable(current)) {
                n += 1
                current = yield* again(n, current.stale ?? "")
              }

              return current
            })

            if (rerunnable(last)) {
              const taken =
                kind === "query" || turn
                  ? Option.none()
                  : yield* Runtime.idle(
                      retries
                        .take(1)
                        .pipe(Effect.timeoutOption(Duration.millis(FUNCTION_LIMITS.ms))),
                    )

              if (Option.isSome(taken)) turn = true

              last = yield* rerun.pipe(
                Effect.ensuring(Option.isSome(taken) ? retries.release(1) : Effect.void),
              )
            }

            const { ran, buffer } = last
            const ms = Date.now() - started
            const checked = buffer.checked()
            const moves = [...buffer.moves, ...(last.moved === undefined ? [] : [last.moved])]

            const outcome: Outcome =
              last.stale !== undefined && buffer.effects.length > 0
                ? {
                    ok: false,
                    kind: "conflict",
                    error: `what it read changed before it could commit (${last.stale}), and this run had already done something outside OpenBelt that running it again would do twice (${buffer.effects.join(", ")}), so it wasn't run again and none of its writes were committed. Keep the reads and writes that can change under it in a function of their own and call it with ctx.call(name, input) (it commits by itself, and re-runs safely), before or after the outside call; or make the outside call the last thing, after a ctx.call that claimed what it's for`,
                    logs: ran.logs,
                    calls: ran.calls,
                    ms,
                    version,
                    run: id,
                    attempts: n,
                    reads: buffer.reads(),
                    replayed: false,
                    effects: buffer.effects,
                    checked,
                    moves,
                  }
                : last.stale !== undefined
                  ? {
                      ok: false,
                      kind: "conflict",
                      error: `what it read kept changing while it ran (${last.stale}), ${MAX_ATTEMPTS} times, so nothing was written: call it again, or have it read less (one document instead of a whole collection)`,
                      logs: ran.logs,
                      calls: ran.calls,
                      ms,
                      version,
                      run: id,
                      attempts: n,
                      reads: buffer.reads(),
                      replayed: false,
                      effects: buffer.effects,
                      checked,
                      moves,
                    }
                  : ran.ok
                    ? {
                        ok: true,
                        result: ran.result,
                        logs: ran.logs,
                        calls: ran.calls,
                        ms,
                        version,
                        run: id,
                        attempts: n,
                        reads: buffer.reads(),
                        writes: last.writes,
                        replayed: false,
                        replayOf: null,
                        effects: buffer.effects,
                        checked,
                        moves,
                        read: kind === "query" ? buffer.live() : undefined,
                        clock: ran.clock,
                        committed: last.moved !== undefined,
                      }
                    : {
                        ok: false,
                        kind: last.failedKind ?? ran.kind,
                        error: ran.error,
                        logs: ran.logs,
                        calls: ran.calls,
                        ms,
                        version,
                        run: id,
                        attempts: n,
                        reads: buffer.reads(),
                        replayed: false,
                        effects: buffer.effects,
                        checked,
                        moves,
                      }

            const read = ran.ok ? ran.read : undefined

            const learned = outcome.ok
              ? observed(fn, contract, input, outcome.result, read)
              : undefined

            const unread =
              outcome.ok && via === "agent" && read !== undefined
                ? unreadOf(input, read, learned)
                : undefined

            for (const line of ran.logs)
              yield* log(line.level, trace, `function ${fn}: ${line.text}`)

            const who = `for ${caller?.email ?? "nobody signed in"} via ${via}${spec.manual === undefined ? "" : ` (by hand, ${spec.manual})`}`
            const tries = n > 1 ? ` after ${n} attempts` : ""

            yield* log(
              outcome.ok ? "info" : "error",
              trace,
              outcome.ok
                ? `${kind} ${fn}${where} ran in ${ms}ms ${who}${tries}, ${ran.calls} db calls, ${ran.requests} ${ran.requests === 1 ? "request" : "requests"}, ${outcome.writes} documents written (run ${id})`
                : `function ${fn}${where} failed after ${ms}ms ${who}${tries}: ${outcome.error} (${outcome.kind}; run ${id})`,
            )

            yield* record(outcome, { replayed: false })

            return outcome.ok && unread !== undefined ? { ...outcome, unread } : outcome
          }).pipe(
            Effect.onExit((exit) =>
              keyed === undefined
                ? Effect.void
                : Effect.gen(function* () {
                    if (inFlight.get(latchKey) === latch) inFlight.delete(latchKey)

                    yield* Deferred.succeed(latch, Exit.isSuccess(exit) ? exit.value : undefined)
                  }),
            ),
          )

          return yield* run
        })

      const runQuery = (spec: LiveSpec, origin: RunAuthority | undefined): Effect.Effect<LiveRan> =>
        execute({
          env: spec.env,
          fn: spec.name,
          input: spec.input,
          origin,
          caller: spec.audience === "public" ? null : spec.viewer,
          via: spec.via,
          trace: newTrace(),
          expect: "query",
        }).pipe(
          Effect.map((ran): LiveRan =>
            ran.ok
              ? {
                  ok: true,
                  result: ran.result,
                  reads: {
                    ...(ran.read ?? { docs: [], collections: [], everything: true }),
                    clock: ran.clock,
                  },
                }
              : {
                  ok: false,
                  error:
                    ran.kind === "kind" ? ran.error : `query ${spec.name} failed: ${ran.error}`,
                  code:
                    ran.kind === "kind" || ran.kind === "bad_input" ? "invalid" : "function_failed",
                },
          ),
          Effect.catchTag("Missing", (e) =>
            Effect.succeed<LiveRan>({ ok: false, error: e.message, code: "missing" }),
          ),
        )

      /**
       * The authority a run anyone starts on the public host has: the function's own "public".functions entry, its secrets and
       * connections, for it and every run it leads to. Undefined: the function isn't on the public host.
       */
      const publicOrigin = Effect.fnUntraced(function* (fn: string) {
        const published = settingsOf(yield* versions.config()).public
        const granted = published === undefined ? undefined : publicFunction(published, fn)

        if (granted === undefined) return undefined

        const origin: RunAuthority = {
          kind: "public",
          fn,
          secrets: granted.secrets,
          uses: granted.uses,
        }

        return origin
      })

      const publicBudget = openPublicBudget()

      /**
       * A public page's watched query: free when only writes from outside the public host made it due, otherwise charged to the app's public
       * budget (and the asking page's address), and given back when it was refused before running.
       */
      const publicQuery = Effect.fnUntraced(function* (spec: LiveSpec, charge: Charge) {
        const origin = yield* publicOrigin(spec.name)

        if (origin === undefined) {
          const unlisted: LiveRan = {
            ok: false,
            error: noPublicFunction(spec.name),
            code: "missing",
          }

          return unlisted
        }

        if (charge === "free") return yield* runQuery(spec, origin)

        const over = publicBudget.charge(charge.address)

        if (over !== undefined) {
          const refused: LiveRan = {
            ok: false,
            error: `${overMessage(over)}, so ${spec.name} didn't run; it runs again for this watch in ${over.retryAfter} s, or on the next change`,
            code: "rate_limited",
            retryAfter: over.retryAfter,
          }

          return refused
        }

        const ran = yield* runQuery(spec, origin)

        if (!ran.ok && ran.code !== "function_failed") publicBudget.refund(charge.address)

        return ran
      })

      const watched = openLive({
        run: (spec, charge) =>
          spec.kind === "aggregate"
            ? readAggregate(
                spec.env,
                spec.name,
                spec.audience === "public"
                  ? { audience: "public" }
                  : { audience: "workspace", me: spec.viewer?.email ?? null },
              ).pipe(
                Effect.map(({ result, collection }): LiveRan => ({
                  ok: true,
                  result,
                  reads: { docs: [], collections: [collection], everything: false, clock: false },
                })),
                Effect.catchTag("Refused", (e) =>
                  Effect.succeed<LiveRan>({
                    ok: false,
                    error: e.message,
                    code: e.code ?? "invalid",
                  }),
                ),
                Effect.catchTag("Missing", (e) =>
                  Effect.succeed<LiveRan>({ ok: false, error: e.message, code: "missing" }),
                ),
              )
            : spec.audience === "workspace"
              ? runQuery(spec, undefined)
              : publicQuery(spec, charge),
        sockets: Effect.fnUntraced(function* () {
          const found: Array<{ socket: Runtime.Socket; info: SocketInfo | undefined }> = []

          for (const socket of yield* state.getWebSockets()) {
            const tag = yield* socket.getAttachment(SocketTag).pipe(
              Effect.map(infoOf),
              Effect.orElseSucceed(() => undefined),
            )

            found.push({ socket, info: tag })
          }

          return found
        }),
        remember: (socket, kept) =>
          socket
            .setAttachment(SocketTag, {
              dataset: kept.dataset,
              audience: kept.audience,
              viewer: kept.viewer?.email ?? null,
              name: kept.viewer?.name ?? "",
              groups: kept.viewer?.groups ?? [],
              via: kept.via,
              watching: kept.watching,
              env: kept.env ?? null,
              address: kept.address ?? null,
            })
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
      })

      const runFunction = (
        env: string | undefined,
        fn: string,
        input: Json,
        caller: Caller | null,
        via: string,
        trace: string,
        key?: string,
      ) => execute({ env, fn, input, caller, via, trace, key })

      const callRoute = Effect.fnUntraced(function* (
        target: Target,
        fn: string,
        trace: string,
        asker: Asker,
      ) {
        const request = yield* HttpServerRequest
        const here = name()
        const usage = `db.fn("${fn}", input) from /sdk.js POSTs the input as JSON`

        if (request.method !== "POST") return failure(405, "method", usage, trace)

        const shown = fn.slice(0, 60)

        if (!isFunctionName(fn)) {
          return failure(
            404,
            "missing",
            `"${shown}" isn't a function name: 1-40 lowercase letters, digits, "_" and "-", starting with a letter`,
            trace,
          )
        }

        // A form can't send JSON, so a page of another origin can't post one here without a preflight.
        if (!(request.headers["content-type"] ?? "").startsWith("application/json"))
          return failure(415, "invalid", usage, trace)

        const from =
          target.kind === "outside" ? target.env : request.headers["x-openbelt-caller-env"]

        const query = request.headers["x-openbelt-kind"] === "query"

        if (target.kind !== "env" && from !== undefined && !query) {
          return failure(
            403,
            "live_from_preview",
            `a page in preview environment "${from}" never runs "${here}"'s live functions, which may change live data. To test them, ${joinHint(here, from)}`,
            trace,
          )
        }

        const tooBig = `a function's input is one JSON value, at most ${FUNCTION_LIMITS.inputBytes / 1000} KB`

        const bytes = yield* bodyOf(request, FUNCTION_LIMITS.inputBytes)

        if (bytes.kind === "over") return failure(413, "invalid", tooBig, trace)

        if (bytes.kind === "cut") return failure(400, "invalid", CUT_OFF, trace)

        const text = new TextDecoder().decode(bytes.bytes)
        const input = text === "" ? Option.some(null) : decodeInput(text)

        if (Option.isNone(input)) return failure(400, "invalid", tooBig, trace)

        const caller = request.headers["x-openbelt-caller"]

        const via =
          asker.audience === "public" || caller === undefined || caller === here
            ? "page"
            : `app:${caller}`

        const person: Caller | null =
          asker.audience === "public" || asker.writer === ANONYMOUS
            ? null
            : { email: asker.writer.author, name: asker.writer.name, groups: asker.groups }

        const viewer: Caller | null =
          person === null || asker.audience === "public" || asker.testFor === undefined
            ? person
            : { ...person, testFor: asker.testFor }

        const origin = asker.audience === "public" ? yield* publicOrigin(fn) : undefined

        if (asker.audience === "public" && origin === undefined)
          return failure(404, "missing", noPublicFunction(fn), trace)

        const env = target.kind === "env" ? target.env : undefined
        const key = request.headers["x-openbelt-key"]

        if (key !== undefined && (key === "" || key.length > 200))
          return failure(400, "invalid", "db.fn's key is 1-200 characters", trace)

        const outcome = yield* Effect.result(
          execute({
            env,
            fn,
            input: input.value,
            origin,
            caller: viewer,
            via,
            trace,
            key,
            expect: query ? "query" : undefined,
            readonly: request.headers["x-openbelt-readonly"] === "1",
          }),
        )

        if (Result.isFailure(outcome))
          return failure(404, "missing", outcome.failure.message, trace)

        const ran = outcome.success

        if (!ran.ok) {
          if (ran.kind === "bad_input") return failure(400, "bad_input", ran.error, trace)

          if (ran.kind === "check_readonly") return failure(423, "check_readonly", ran.error, trace)

          if (ran.kind === "not_callable") return failure(403, "not_callable", ran.error, trace)

          if (ran.kind === "kind" || ran.kind === "signed_out_key")
            return failure(400, "invalid", ran.error, trace)

          if (ran.kind === "busy")
            return HttpServerResponse.setHeader(
              failure(503, "busy", ran.error, trace),
              "retry-after",
              String(RETRY_AFTER_S),
            )

          return failure(500, "function_failed", `function ${fn} failed: ${ran.error}`, trace)
        }

        return HttpServerResponse.jsonUnsafe(ran.result, {
          headers: {
            "x-openbelt-run": ran.run,
            "x-openbelt-replayed": String(ran.replayed),
          },
        })
      })

      const schedules = yield* openSchedules(state.storage, state.id.toString(), {
        log,
        wanted: () =>
          Effect.map(versions.config(), (openbelt): Wanted =>
            openbelt.kind === "unreadable"
              ? openbelt
              : { kind: "read", schedules: openbelt.config.schedules ?? {} },
          ),
        run: (fn, input, trace, due, key) =>
          execute({
            env: undefined,
            fn,
            input,
            caller: null,
            via: "schedule",
            trace,
            key,
            schedule: due,
          }).pipe(
            Effect.map((ran) => ({
              ok: ran.ok,
              ms: ran.ms,
              error: ran.ok ? null : ran.error,
            })),
            Effect.catchTag("Missing", (e) =>
              Effect.succeed({ ok: false, ms: 0, error: e.message }),
            ),
          ),
      })

      const fireJob = Effect.fn("AppDO.fireJob")(function* (payload: Json) {
        const due = decodeJob(payload)

        if (Option.isNone(due)) return

        const { kind, fn, input, key, enqueuedBy, chain } = due.value
        const env = due.value.env ?? undefined
        const booking = due.value.booking ?? laterBooking(env, key)
        const booker = due.value.tree ?? undefined
        const id = kind === "later" ? `later:${booking}` : `data:${env ?? ""}:${fn}:${key}`
        const trace = newTrace()

        const version = env === undefined ? versions.liveName() : yield* envVersion(env)
        const openbelt = version === undefined ? undefined : yield* versions.config(version)

        if (openbelt?.kind === "unreadable") {
          const now = Date.now()
          const since = due.value.heldSince ?? now

          if (now - since >= HOLD_UNREADABLE.giveUpMs) {
            if (kind === "later") yield* sql.exec("DELETE FROM laters WHERE booking = ?", booking)

            if (booker !== undefined) yield* trees.settled(booker, id)

            yield* log(
              "error",
              trace,
              `${kind} run of ${fn} dropped, held since ${new Date(since).toISOString()}: ${openbelt.problem}`,
            )

            return
          }

          yield* job
            .schedule(id, {
              at: now + HOLD_UNREADABLE.holdMs,
              payload: { ...due.value, heldSince: since },
            })
            .pipe(Effect.orDie)

          yield* log(
            "error",
            trace,
            `${kind} run of ${fn} held, booked again an hour on: ${openbelt.problem}`,
          )

          return
        }

        if (kind === "later") yield* sql.exec("DELETE FROM laters WHERE booking = ?", booking)

        if (env !== undefined && (yield* envVersion(env)) === undefined) {
          if (booker !== undefined) yield* trees.settled(booker, id)

          return
        }

        const run = (tree: Tree | undefined) =>
          execute({
            env,
            fn,
            input,
            caller: null,
            via: kind,
            origin: due.value.origin === undefined ? undefined : bookedAuthority(due.value.origin),
            trace,
            key: `${kind}:${due.value.booking ?? key}`,
            enqueuedBy,
            chain,
            tree,
          })

        yield* (
          booker === undefined
            ? run(undefined)
            : Effect.acquireUseRelease(trees.claim(booker, fn), run, (tree, exit) =>
                Effect.andThen(
                  Exit.hasInterrupts(exit) ? Effect.void : trees.settled(booker, id),
                  trees.release(tree),
                ),
              )
        ).pipe(
          Effect.catchTag("Missing", (e) =>
            log("warn", trace, `${kind} run of ${fn} skipped: ${e.message}`),
          ),
          Effect.catchDefect((defect) =>
            Effect.logError(`a ${kind} run of ${fn} failed inside the platform`, defect),
          ),
        )
      })

      const job: Runtime.Callback<Json> = yield* Runtime.makeCallback("run", fireJob, {
        retry: { delay: "2 minutes" },
      })

      // A booking whose job is gone never runs, so its row would only hold its key (and count toward
      // MAX_LATERS) for good: a version without ctx.later drains "run" jobs, and rolling back to it
      // and forward again leaves the rows. Each is the job "later:<booking>".
      const bookedJobs = new Set((yield* job.pending("later:")).map((one) => one.id))

      const unbooked = yield* (yield* sql.exec<{ booking: string }>(
        "SELECT booking FROM laters",
      )).toArray()

      const orphans = unbooked.filter((one) => !bookedJobs.has(`later:${one.booking}`))

      for (const one of orphans)
        yield* sql.exec("DELETE FROM laters WHERE booking = ?", one.booking)

      if (orphans.length > 0)
        yield* log(
          "warn",
          newTrace(),
          `ctx.later: ${orphans.length} of this app's booked runs had no job left (a version without ctx.later drained them while OpenBelt was rolled back), so they won't run, and their keys are free to book again`,
        )

      const triggered: (
        env: string | undefined,
        changes: ReadonlyArray<Committed>,
        trace: string,
        chain: ReadonlyArray<string>,
        origin: RunAuthority,
        tree: Tree | undefined,
      ) => Effect.Effect<void> = Effect.fnUntraced(function* (
        env: string | undefined,
        changes: ReadonlyArray<Committed>,
        trace: string,
        chain: ReadonlyArray<string>,
        origin: RunAuthority,
        tree: Tree | undefined,
      ) {
        const version = env === undefined ? versions.liveName() : yield* envVersion(env)

        if (version === undefined) return

        const openbelt = yield* versions.config(version)

        if (openbelt.kind === "unreadable") {
          if (changes.length === 0) return

          const what = changes.map(
            ({ change }) => `${change.op} ${change.doc.collection}/${change.doc.id}`,
          )

          yield* log(
            "error",
            trace,
            `no trigger run on ${what.slice(0, 3).join(", ")}${what.length > 3 ? ` and ${what.length - 3} more` : ""}: ${openbelt.problem}`,
          )

          return
        }

        const triggers = Object.entries(openbelt.config.triggers ?? {})

        if (triggers.length === 0) return

        const spent = new Map<string, { n: number; first: string }>()

        for (const { change, before } of changes) {
          const { collection, id, seq } = change.doc

          for (const [fn, trigger] of triggers) {
            const ons = onsOf(trigger.on)

            if (!ons.some((on) => matches(on, change.op, collection))) continue

            if (chain.includes(fn)) {
              yield* log(
                "info",
                trace,
                `trigger ${fn} not run on ${change.op} ${collection}/${id}: ${fn} wrote it (a trigger never runs on its own chain's writes)`,
              )
              continue
            }

            if (chain.length >= MAX_CHAIN) {
              yield* log(
                "warn",
                trace,
                `trigger ${fn} not run on ${change.op} ${collection}/${id}: ${chain.join(" → ")} is ${MAX_CHAIN} triggers deep, the most a chain may be`,
              )
              continue
            }

            if (tree !== undefined && !(yield* trees.book(tree))) {
              const known = spent.get(fn)

              spent.set(fn, {
                n: (known?.n ?? 0) + 1,
                first: known?.first ?? `${change.op} ${collection}/${id}`,
              })
              continue
            }

            yield* job
              .schedule(`data:${env ?? ""}:${fn}:${seq}`, {
                after: 0,
                payload: {
                  kind: "data",
                  fn,
                  input: {
                    op: change.op,
                    collection,
                    id,
                    doc: change.op === "delete" ? null : change.doc,
                    before,
                  },
                  key: `${seq}`,
                  enqueuedBy: version,
                  chain: [...chain, fn],
                  env: env ?? null,
                  origin,
                  tree: tree?.id ?? null,
                },
              })
              .pipe(Effect.orDie)
          }
        }

        for (const [fn, { n, first }] of spent)
          yield* log(
            "warn",
            trace,
            `trigger ${fn} not run on ${n === 1 ? first : `${n} writes (the first: ${first})`}: ${tree?.root ?? fn} and every run it ctx.call'd or its writes triggered, together, made ${FUNCTION_LIMITS.tree.runs} runs, the most one call tree may. Write fewer documents per run (one document holding a list triggers once), or spread the writes over runs of their own with ctx.later`,
          )
      })

      type Delivered = {
        readonly status: number
        readonly body: Json
        readonly run: string | null
        readonly replayed: boolean
      }

      const deliver = Effect.fnUntraced(function* (delivery: {
        readonly preview: { readonly env: string; readonly version: string } | undefined
        readonly fn: string
        readonly bytes: Uint8Array<ArrayBuffer>
        readonly headers: Readonly<Record<string, string | undefined>>
        readonly token: string | undefined
        readonly trace: string
      }) {
        const { preview, fn, bytes, headers, token, trace } = delivery
        const raw = new TextDecoder().decode(bytes)
        const here = name()
        const env = preview?.env
        const openbelt = yield* versions.config(preview?.version)

        if (openbelt.kind === "unreadable") {
          yield* log("error", trace, `webhook ${fn} refused a delivery: ${openbelt.problem}`)

          const answer: Delivered = {
            status: 503,
            body: { error: openbelt.problem, code: "unavailable" satisfies ErrorCode, trace },
            run: null,
            replayed: false,
          }

          return answer
        }

        const hooks = openbelt.config.webhooks ?? {}
        const hook = Object.hasOwn(hooks, fn) ? hooks[fn] : undefined
        const header = (h: string) => headers[h.toLowerCase()]

        if (hook === undefined) {
          const listed = Object.keys(hooks)

          const answer: Delivered = {
            status: 404,
            body: {
              error: `"${here}" has no webhook "${fn.slice(0, 40)}"${env === undefined ? "" : ` in preview ${env}`}: its ${env === undefined ? "live" : "preview's"} openbelt.json "webhooks" lists ${listed.length === 0 ? "none" : listed.join(", ")}`,
              code: "missing",
              trace,
            },
            run: null,
            replayed: false,
          }

          return answer
        }

        const check = checkOf(hook)
        const kept = yield* hookSecrets.get(fn, env)

        const problem = yield* Effect.promise(() =>
          deliveryProblem(check, kept?.secret, bytes, header, token),
        )

        if (problem !== undefined) {
          const id = newRunId()

          yield* runs.record({
            id,
            fn,
            trigger: "webhook",
            caller: null,
            manual: null,
            version: preview?.version ?? versions.liveName() ?? null,
            enqueuedBy: null,
            env: env ?? null,
            started: Date.now(),
            ms: 0,
            attempts: 0,
            reads: 0,
            writes: 0,
            outcome: "error",
            error: { kind: "signature", message: problem },
            key: null,
            replayed: false,
            input: raw.slice(0, 1000),
            inputHash: yield* hashOf(bytes),
            result: null,
            logs: [],
            trace,
          })
          yield* log(
            "warn",
            trace,
            `webhook ${fn}${env === undefined ? "" : ` in preview ${env}`} refused a delivery before running it: ${problem} (run ${id}; function_runs shows it)`,
          )

          const answer: Delivered = {
            status: 401,
            body: { error: problem, code: "unauthorized", run: id, trace },
            run: id,
            replayed: false,
          }

          return answer
        }

        const sent = hook.key === undefined ? undefined : header(hook.key)?.trim()
        const key = sent === "" ? undefined : sent

        if (hook.key !== undefined && key !== undefined && key.length > 200) {
          const error = `the ${hook.key} header (openbelt.json webhooks.${fn}.key, which dedupes redeliveries) is ${key.length} characters, over 200: it wasn't run. Send a delivery id there, or name another header in "key"`

          yield* log("warn", trace, `webhook ${fn} refused a delivery: ${error}`)

          const answer: Delivered = {
            status: 400,
            body: { error, code: "invalid", trace },
            run: null,
            replayed: false,
          }

          return answer
        }

        const input: Json = {
          body: Option.getOrElse(decodeInput(raw), () => raw),
          headers: shownHeaders(headers),
          raw,
        }

        const outcome = yield* Effect.result(
          execute({
            env,
            fn,
            input,
            caller: null,
            via: "webhook",
            trace,
            key,
            keyedOn: bytes,
          }),
        )

        if (Result.isFailure(outcome)) {
          const answer: Delivered = {
            status: 404,
            body: { error: outcome.failure.message, code: "missing", trace },
            run: null,
            replayed: false,
          }

          return answer
        }

        const ran = outcome.success

        const answer: Delivered = ran.ok
          ? { status: 200, body: ran.result, run: ran.run, replayed: ran.replayed }
          : ran.kind === "busy"
            ? {
                // It didn't start: the sender sends it again (hookRoute adds Retry-After to a 503).
                status: 503,
                body: { error: ran.error, code: "busy" satisfies ErrorCode, run: ran.run, trace },
                run: ran.run,
                replayed: false,
              }
            : {
                status: 500,
                body: {
                  error: `function ${fn} failed: ${ran.error}`,
                  code: "function_failed",
                  run: ran.run,
                  trace,
                },
                run: ran.run,
                replayed: false,
              }

        return answer
      })

      const hookRoute = Effect.fnUntraced(function* (
        preview: { readonly env: string; readonly version: string } | undefined,
        fn: string,
        token: string | undefined,
        trace: string,
      ) {
        const request = yield* HttpServerRequest

        if (request.method !== "POST")
          return failure(405, "method", `POST deliveries to /_hook/${fn}`, trace)

        const bytes = yield* bodyOf(request, FUNCTION_LIMITS.inputBytes)

        if (bytes.kind === "over")
          return failure(
            413,
            "invalid",
            `a delivery is at most ${FUNCTION_LIMITS.inputBytes / 1000} KB`,
            trace,
          )

        if (bytes.kind === "cut") return failure(400, "invalid", CUT_OFF, trace)

        const got = yield* deliver({
          preview,
          fn,
          bytes: bytes.bytes,
          headers: request.headers,
          token,
          trace,
        })

        const answered = HttpServerResponse.jsonUnsafe(got.body, {
          status: got.status,
          headers: { "x-openbelt-trace": trace, "x-openbelt-replayed": String(got.replayed) },
        })

        // A 503 ran nothing (busy, restarting, an openbelt.json this server can't read): senders that retry wait this long.
        const response =
          got.status === 503
            ? HttpServerResponse.setHeader(answered, "retry-after", String(RETRY_AFTER_S))
            : answered

        return got.run === null
          ? response
          : HttpServerResponse.setHeader(response, "x-openbelt-run", got.run)
      })

      const hookTest = Effect.fn("AppDO.hookTest")(function* (
        env: string | undefined,
        fn: string,
        body: Json,
        how: "good" | "bad" | "none",
        trace: string,
      ) {
        const version = env === undefined ? undefined : yield* envVersion(env)
        const hooks = settingsOf(yield* versions.config(version)).webhooks ?? {}
        const hook = Object.hasOwn(hooks, fn) ? hooks[fn] : undefined
        const bytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(body)))
        const secret = (yield* hookSecrets.get(fn, env))?.secret

        const signed =
          hook === undefined || secret === undefined
            ? { headers: {}, token: undefined }
            : yield* Effect.promise(() => signedAs(checkOf(hook), secret, bytes, how))

        const headers = Object.fromEntries(
          Object.entries({ "content-type": "application/json", ...signed.headers }).map(
            ([k, v]) => [k.toLowerCase(), v],
          ),
        )

        const got = yield* deliver({
          preview: env === undefined || version === undefined ? undefined : { env, version },
          fn,
          bytes,
          headers,
          token: signed.token,
          trace,
        })

        return { ...got, sent: Object.keys(headers), secretSet: secret !== undefined }
      })

      const callAs = Effect.fn("AppDO.callAs")(function* (
        env: string | undefined,
        fn: string,
        input: Json,
        caller: Caller,
        trace: string,
        options: {
          readonly as?: ByHand | undefined
          readonly key?: string | undefined
        },
      ) {
        const by = options.as

        if (by === undefined)
          return yield* runFunction(env, fn, input, caller, "agent", trace, options.key)

        const config = settingsOf(
          yield* versions.config(env === undefined ? undefined : yield* envVersion(env)),
        )

        const common = {
          env,
          fn,
          caller: null,
          via: by,
          trace,
          key: options.key,
          manual: caller.email,
        }

        if (by === "schedule") {
          const schedule = schedules.manual(fn)

          const ran = yield* execute({
            ...common,
            input: input ?? config.schedules?.[fn]?.input ?? null,
            schedule,
          })

          if (ran.ok && env === undefined) schedules.ranOk(fn, schedule.scheduledFor)

          return ran
        }

        if (by === "webhook") {
          return yield* execute({
            ...common,
            input: {
              body: input,
              headers: { "content-type": "application/json" },
              raw: JSON.stringify(input),
            },
          })
        }

        if (by === "later") return yield* execute({ ...common, input })

        const asked = decodeDataInput(input)

        if (Option.isNone(asked)) {
          return yield* new Refused({
            message: `as "data" takes input { collection, id } (and op, before, doc if you want them set): the change a trigger gets, { op, collection, id, doc, before }, is made from the document as it is now`,
          })
        }

        const { collection, id } = asked.value
        const data = yield* dataOf(env)

        const doc =
          asked.value.doc !== undefined ? asked.value.doc : yield* data.get(collection, id)

        const op = asked.value.op ?? (doc === null ? "delete" : "update")

        return yield* execute({
          ...common,
          input: {
            op,
            collection,
            id,
            doc,
            before: asked.value.before ?? null,
          },
        })
      })

      const logs = Effect.fn("AppDO.logs")(function* (trace: string | undefined, limit: number) {
        const rows = yield* (yield* sql.exec<LogRow>(
          "SELECT at, level, trace, message FROM logs WHERE ? IS NULL OR trace = ? ORDER BY id DESC LIMIT ?",
          trace ?? null,
          trace ?? null,
          limit,
        )).toArray()

        const app = name()

        return rows.map((r): LogLine => ({
          at: r.at,
          level: level(r.level),
          trace: r.trace,
          app,
          message: r.message,
        }))
      })

      const file = Effect.fnUntraced(function* (
        path: string,
        trace: string,
        version: string | undefined,
        audience: Audience,
        opener: Opener | undefined,
      ) {
        const manifest = version === undefined ? undefined : yield* versions.get(version)

        if (manifest === undefined) {
          return HttpServerResponse.text("This app has no deployed version yet.\n", {
            status: 404,
          })
        }

        const filename = path === "" || path.endsWith("/") ? `${path}index.html` : path

        if (audience === "public") return yield* publicFile(manifest, path, filename, opener)
        const fn = /^functions\/([^/]+)\.js$/.exec(filename)?.[1]

        const openbelt = yield* versions.config(manifest.version)

        if (fn !== undefined && openbelt.kind === "read" && lists(openbelt.config, fn)) {
          return HttpServerResponse.text(
            `Not found: ${filename} is the function "${fn}", which runs on OpenBelt: pages call it with db.fn("${fn}", input) from /sdk.js\n`,
            { status: 404 },
          )
        }

        if (filename.startsWith("functions/") && fromLaterOpenBelt(openbelt)) {
          yield* log(
            "warn",
            trace,
            `404 ${filename}: functions/ under a later OpenBelt's openbelt.json`,
          )

          return HttpServerResponse.text(
            `Not found: ${filename}: this app's openbelt.json is a later OpenBelt's, and its functions/ files may be server code, which is never served. Deploy the app again to serve functions/ as files.\n`,
            { status: 404 },
          )
        }

        const request = yield* HttpServerRequest
        const served = servedAt(path, (f) => manifest.files.has(f), navigates(request))
        const entry = served === undefined ? undefined : manifest.files.get(served.file)

        if (entry === undefined) {
          yield* log("warn", trace, `404 ${filename} (version ${manifest.version})`)

          return HttpServerResponse.text(`Not found: ${filename}\n`, { status: 404 })
        }

        const bytes = yield* versions.body(entry.hash)

        if (bytes === undefined) {
          yield* log(
            "error",
            trace,
            `version ${manifest.version} lists ${filename} but its bytes are missing`,
          )

          return HttpServerResponse.text("Internal error: a file of this version is missing\n", {
            status: 500,
          })
        }

        const type = contentType(served?.file ?? filename)
        const shown = { theme: themeOf(request), base: served?.base ?? null }

        if (opener !== undefined && opensPage(type, request)) yield* pageOpened(opener)

        const page = opensPage(type, request)
          ? withReporter(new TextDecoder().decode(bytes), manifest.version, shown)
          : undefined

        const headers = {
          "cache-control": "no-cache",
          "x-openbelt-version": manifest.version,
          vary: "Sec-Fetch-Dest",
          etag: `"${entry.hash}"`,
        }

        if (page === undefined)
          return HttpServerResponse.uint8Array(bytes, { contentType: type, headers })

        const { line, column, length } = page.inserted

        return HttpServerResponse.uint8Array(new TextEncoder().encode(page.html), {
          contentType: type,
          headers: {
            ...headers,
            [INSERTED_HEADER]: `${line}:${column}:${length}`,
            // What OpenBelt adds stays last: a page's ETag from before a change to it (sdk-preload) is then the same with another end.
            etag: `"${entry.hash}-${manifest.version}-${shown.theme}${(shown.base ?? "").length / 3}-${PAGE_TAGS_VERSION}"`,
          },
        })
      })

      /**
       * A file of the live version for anyone on the public host: how the app works inside (openbelt.json, skills/, functions/) isn't
       * theirs, the page gets no error reporter (the public host takes no /_log), and a miss isn't written to the app's log.
       */
      const publicFile = Effect.fnUntraced(function* (
        manifest: NonNullable<Effect.Success<ReturnType<typeof versions.get>>>,
        path: string,
        filename: string,
        opener: Opener | undefined,
      ) {
        const request = yield* HttpServerRequest

        const served = publicHides(filename)
          ? undefined
          : servedAt(path, (f) => !publicHides(f) && manifest.files.has(f), navigates(request))

        const entry = served === undefined ? undefined : manifest.files.get(served.file)
        const bytes = entry === undefined ? undefined : yield* versions.body(entry.hash)

        if (served === undefined || entry === undefined || bytes === undefined)
          return HttpServerResponse.text("Not found.\n", { status: 404 })

        const type = contentType(served.file)
        const page = opensPage(type, request)
        const base = served.base

        if (opener !== undefined && page) yield* pageOpened(opener)

        const headers = {
          "cache-control": "no-cache",
          "x-openbelt-version": manifest.version,
          vary: "Sec-Fetch-Dest",
        }

        return page
          ? HttpServerResponse.uint8Array(
              new TextEncoder().encode(withPageStyle(new TextDecoder().decode(bytes), base)),
              {
                contentType: type,
                headers: {
                  ...headers,
                  etag: `"${entry.hash}-page${(base ?? "").length / 3}-${PAGE_TAGS_VERSION}"`,
                },
              },
            )
          : HttpServerResponse.uint8Array(bytes, {
              contentType: type,
              headers: { ...headers, etag: `"${entry.hash}"` },
            })
      })

      const overPublicBudget = Effect.fnUntraced(function* (
        path: string,
        trace: string,
        address: string | undefined,
      ) {
        const over = publicBudget.charge(address)

        if (over === undefined) return undefined

        Runtime.recordRefused("rate", "public")

        const minute = Math.floor(Date.now() / 60_000)

        if (fullLogged.get(`public-rate ${over.whose}`) !== minute) {
          fullLogged.set(`public-rate ${over.whose}`, minute)
          yield* log(
            "warn",
            trace,
            `refused /${path} from the public host (and others this minute): ${overMessage(over)}`,
          )
        }

        return HttpServerResponse.jsonUnsafe(
          {
            error: `${overMessage(over)}; try again in ${over.retryAfter} s`,
            code: "rate_limited",
            trace,
          },
          { status: 429, headers: { "retry-after": String(over.retryAfter) } },
        )
      })

      /** Past OPENBELT_PUBLIC_DATA_SHARE of its data cap, an app takes no new or changed documents from the public host. */
      const overPublicShare = Effect.fnUntraced(function* (trace: string) {
        const cap = Runtime.dataLimits.app

        if (cap === 0) return undefined

        const [row] = yield* (yield* sql.exec<{ n: number }>(
          "SELECT (page_count - freelist_count) * page_size AS n FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()",
        )).toArray()

        const bytes = row?.n ?? 0
        const share = Math.floor((cap * PUBLIC_DATA_SHARE) / 100)

        if (bytes < share) return undefined

        Runtime.recordRefused("storage", "public")

        const message = `"${name()}" holds ${sizeOf(bytes)}, past the ${PUBLIC_DATA_SHARE}% of its ${sizeOf(cap)} data cap that the public host may fill (OPENBELT_PUBLIC_DATA_SHARE). Nothing was written; its members still can. Delete documents it no longer needs to take writes from the public host again.`

        const minute = Math.floor(Date.now() / 60_000)

        if (fullLogged.get("public-share") !== minute) {
          fullLogged.set("public-share", minute)
          yield* log(
            "warn",
            trace,
            `a write from the public host was refused (and others this minute): ${message}`,
          )
        }

        return failure(507, "storage_full", message, trace)
      })

      /**
       * The public host's requests (gateway.ts publicRoute), from anyone, who is nobody: the live version's files and what its openbelt.json
       * "public" names, only while it has one. Never a preview, the browser's log, uploads or OpenBelt's own routes.
       */
      const publicFetch = Effect.fnUntraced(function* (
        full: string,
        query: URLSearchParams,
        trace: string,
        asker: Asker,
      ) {
        const request = yield* HttpServerRequest
        const version = versions.liveName()
        const stored = yield* versions.config()

        if (
          version === undefined ||
          stored.kind !== "read" ||
          stored.config.public === undefined ||
          previewOf(full) !== undefined
        )
          return HttpServerResponse.text("Not found.\n", { status: 404 })

        if (full === "_og" || full === "_og.png")
          return yield* linkPreview(full === "_og.png", query, "public")

        const target: Target = { kind: "live" }
        const writes = request.method !== "GET" && request.method !== "HEAD"
        const called = /^_fn\/([^/]*)$/.exec(full)
        const route = /^_db\/([^/]+)(?:\/([^/]*))?$/.exec(full)
        const aggregate = /^_aggregates\/([^/]+)$/.exec(full)
        const fn = called === null ? undefined : decoded(called[1] ?? "")

        const grows =
          (route !== null &&
            (request.method === "POST" ||
              request.method === "PUT" ||
              request.method === "PATCH")) ||
          (fn !== undefined && contractOf(stored.config, fn)?.kind !== "query")

        if (grows) {
          const capped = yield* storageFull(trace)

          if (capped !== undefined) return failure(507, "storage_full", capped, trace)

          const share = yield* overPublicShare(trace)

          if (share !== undefined) return share
        }

        const charged =
          fn !== undefined
            ? callRoute(target, fn, trace, asker)
            : route !== null && writes
              ? db(
                  target,
                  live,
                  decoded(route[1] ?? ""),
                  route[2] === undefined ? undefined : decoded(route[2]),
                  query,
                  trace,
                  asker,
                )
              : undefined

        if (charged !== undefined) {
          const address = asker.audience === "public" ? asker.address : undefined
          const over = yield* overPublicBudget(full, trace, address)

          if (over !== undefined) return over

          const answer = yield* charged

          // Refused before any work was done (no such function, an op or collection "public" doesn't list, the rules, a bad body): free.
          // A 423 (check_readonly) comes after the function ran, so it counts.
          if (answer.status >= 400 && answer.status < 500 && answer.status !== 423)
            publicBudget.refund(address)

          return answer
        }

        if (full === "_ws") {
          const since = Number(query.get("since") ?? "NaN")

          return yield* socket(
            undefined,
            live,
            Number.isInteger(since) ? since : undefined,
            version,
            query.get("batch") === "1",
            asker,
          )
        }

        if (aggregate !== null && request.method === "GET")
          return yield* respond(
            trace,
            readAggregate(undefined, decoded(aggregate[1] ?? ""), readerOf(asker)).pipe(
              Effect.map((value) => value.result),
            ),
          )

        if (route !== null) {
          const [, collection = "", id] = route

          return yield* db(
            target,
            live,
            decoded(collection),
            id === undefined ? undefined : decoded(id),
            query,
            trace,
            asker,
          )
        }

        if (full.startsWith("_")) return HttpServerResponse.text("Not found.\n", { status: 404 })

        return yield* file(full, trace, version, "public", openerOf(asker, request))
      })

      const reports = { minute: 0, count: 0, last: new Map<string, number>() }

      const browserLog = Effect.fnUntraced(function* (data: string, trace: string) {
        const request = yield* HttpServerRequest
        const body = yield* bodyOf(request, MAX_REPORT_BYTES)

        if (request.method !== "POST") {
          return failure(
            405,
            "method",
            "POST a report: the page's error reporter does this for you",
            trace,
          )
        }

        const report =
          body.kind === "read" ? decodeReport(new TextDecoder().decode(body.bytes)) : Option.none()

        if (Option.isNone(report)) {
          return failure(
            400,
            "invalid",
            `a report is JSON {kind, message, page, at?, version?, trace?}, under ${MAX_REPORT_BYTES} bytes`,
            trace,
          )
        }

        const { kind, message, page, at, version } = report.value
        const now = Date.now()
        const minute = Math.floor(now / 60_000)
        // A check's report doesn't hide the same error from a person's browser, nor the other way round.
        const from = CHECK_AGENT.test(request.headers["user-agent"] ?? "") ? "check" : "page"
        const key = `${from} ${kind} ${page} ${message} ${at ?? ""}`
        const seen = reports.last.get(key)

        if (minute !== reports.minute) {
          reports.minute = minute
          reports.count = 0
        }

        if (
          reports.count >= BROWSER_LINES_PER_MINUTE ||
          (seen !== undefined && now - seen < BROWSER_REPEAT_MS)
        ) {
          return HttpServerResponse.empty({ status: 204 })
        }

        reports.count += 1
        reports.last.set(key, now)

        if (reports.last.size > 500) reports.last.clear()

        const agent = request.headers["user-agent"] ?? ""

        const sdkTrace = /^[a-z0-9]{1,40}$/.test(report.value.trace ?? "")
          ? report.value.trace
          : undefined

        const where = at === undefined || at === "" ? "" : ` (${at.slice(0, 200)})`

        const served = /^[a-z0-9]{1,40}$/.test(version ?? "") ? version : "unknown"

        yield* log(
          "error",
          CHECK_AGENT.exec(agent)?.[1] ?? sdkTrace ?? trace,
          `browser error on ${page.slice(0, 200)}: ${message.slice(0, 1000)}${where} (${browserName(agent)}, version ${served}, ${data})`,
        )

        return HttpServerResponse.empty({ status: 204 })
      })

      const db = Effect.fnUntraced(function* (
        target: Target,
        data: Dataset,
        collection: string,
        id: string | undefined,
        query: URLSearchParams,
        trace: string,
        asker: Asker,
      ) {
        const request = yield* HttpServerRequest

        const actor: Actor =
          asker.audience === "public"
            ? { writer: ANONYMOUS, rules: "public", testFor: null }
            : { writer: asker.writer, rules: "apply", testFor: asker.testFor ?? null }

        const reader = readerOf(asker)
        const shown = asker.audience === "public" ? masked : <D extends Doc>(doc: D) => doc
        const env = target.kind === "env" ? target.env : undefined

        // What a write answers: on the public host, the document only when anyone may read it there (the list and the rules), else
        // its id and seq, so an op listed without "read" never shows what was written over or deleted.
        const wrote = Effect.fnUntraced(function* (doc: Doc) {
          if (asker.audience === "workspace") return doc

          return (yield* mayRead(env, reader, doc)) ? masked(doc) : { id: doc.id, seq: doc.seq }
        })

        const problem =
          collectionProblem(collection) ?? (id === undefined ? undefined : docIdProblem(id))

        if (problem !== undefined) return failure(400, "invalid", problem, trace)

        const openbelt = yield* configOf(env)

        if (openbelt.kind === "unreadable") {
          yield* log("warn", trace, `refused ${request.method} ${collection}: ${openbelt.problem}`)

          return yield* respond(
            trace,
            Effect.fail(
              new Denied({
                message: openbelt.problem,
                rule: UNREADABLE,
                hint: "deploy the app again (deploy_app) so this OpenBelt can read its openbelt.json",
              }),
            ),
          )
        }

        if (
          asker.audience === "public" &&
          (request.method === "GET" || request.method === "HEAD") &&
          !publicReads(openbelt, collection)
        ) {
          return yield* respond(
            trace,
            Effect.fail(
              new Denied({
                message: `denied by ${PUBLIC_RULE}: it doesn't list "read" for ${collection}`,
                rule: PUBLIC_RULE,
                hint: 'openbelt.json "public".collections lists what anyone may do in each collection; nothing else is reachable from the public host',
              }),
            ),
          )
        }

        const published = openbelt.config.public

        const needs = PUBLIC_WRITE_OPS.get(request.method) ?? []

        // Before any document is looked up: an op the list doesn't name is refused the same whether the id exists or not.
        if (
          asker.audience === "public" &&
          needs.length > 0 &&
          (published === undefined || !needs.some((op) => exposes(published, collection, op)))
        ) {
          return yield* respond(
            trace,
            Effect.fail(
              new Denied({
                message: `denied by ${PUBLIC_RULE}: it doesn't list ${needs.map((op) => `"${op}"`).join(" or ")} for ${collection}`,
                rule: PUBLIC_RULE,
                hint: 'openbelt.json "public".collections lists what anyone may do in each collection; nothing else is reachable from the public host',
              }),
            ),
          )
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          const refused = yield* writeProblem(target, collection)

          if (refused !== undefined) {
            yield* log("warn", trace, `refused ${request.method} ${collection}: ${refused.message}`)

            return failure(403, refused.code, refused.message, trace)
          }
        }

        if (id === undefined) {
          if (request.method === "GET") {
            // The data's seq before this read: every change up to it is in the page. The SDK's watch() reads while its socket opens
            // and compares this with the socket's hello, so a change between the two isn't lost (sdk.ts).
            const seq = data.seq()

            const listed = yield* respond(
              trace,
              Effect.gen(function* () {
                yield* takes(query, ["limit", "cursor"], LIST_USAGE)

                const limit = yield* limitOf(query.get("limit"))

                const page = yield* data.list(collection, {
                  limit,
                  cursor: query.get("cursor") ?? undefined,
                })

                return { ...page, docs: (yield* readable(env, reader, page.docs)).map(shown) }
              }),
            )

            return listed.status === 200
              ? HttpServerResponse.setHeader(listed, SEQ_HEADER, String(seq))
              : listed
          }

          if (request.method === "POST") {
            return yield* respond(
              trace,
              Effect.gen(function* () {
                yield* takes(query, [], "adding takes no parameters")

                const doc = yield* jsonBody("the document to add")

                return yield* wrote(
                  yield* writeOne(env, collection, { op: "add", data: doc }, actor, trace),
                )
              }),
            )
          }

          return failure(
            405,
            "method",
            `use GET to list or POST to add; /_db/${collection}/<id> reads and changes one document`,
            trace,
          )
        }

        if (request.method === "GET") {
          const missingIsNull = request.headers[MISSING_HEADER] === "null"

          return yield* respond(
            trace,
            Effect.gen(function* () {
              yield* takes(query, [], "reading one document takes no parameters")

              const stored = yield* data.get(collection, id)

              const doc =
                stored !== null && (yield* mayRead(env, reader, stored)) ? shown(stored) : null

              if (doc === null && !missingIsNull) {
                return yield* new Missing({
                  message: `there's no document "${id}" in ${collection}`,
                })
              }

              return doc
            }),
          ).pipe(
            Effect.map((response) =>
              missingIsNull
                ? HttpServerResponse.setHeader(response, MISSING_HEADER, "null")
                : response,
            ),
          )
        }

        const change = DOC_WRITES.get(request.method)

        if (change !== undefined) {
          return yield* respond(
            trace,
            Effect.gen(function* () {
              yield* takes(query, ["ifSeq"], change.usage)

              const ifSeq = yield* ifSeqOf(query.get("ifSeq"))
              const body = change.body === undefined ? null : yield* jsonBody(change.body)

              return yield* wrote(
                yield* writeOne(env, collection, change.write(id, ifSeq, body), actor, trace),
              )
            }),
          )
        }

        return failure(405, "method", "use GET, PUT, PATCH or DELETE on a document", trace)
      })

      const socket = Effect.fnUntraced(function* (
        env: string | undefined,
        data: Dataset,
        since: number | undefined,
        version: string | undefined,
        batching: boolean,
        asker: Asker,
      ) {
        const request = yield* HttpServerRequest
        const dataset = env === undefined ? "live" : envDataset(env)
        const reader = readerOf(asker)
        const caller = request.headers["x-openbelt-caller"]

        const via =
          asker.audience === "public" || caller === undefined || caller === name()
            ? "page"
            : `app:${caller}`

        const [response, ws] = yield* Runtime.upgrade({ batching })

        yield* ws
          .setAttachment(
            SocketTag,
            asker.audience === "public"
              ? {
                  dataset,
                  audience: "public",
                  viewer: null,
                  via,
                  watching: [],
                  env: null,
                  address: asker.address ?? null,
                }
              : {
                  dataset,
                  audience: "workspace",
                  viewer: meOf(asker.writer),
                  name: asker.writer.name,
                  groups: asker.groups,
                  via,
                  watching: [],
                  env: env ?? null,
                },
          )
          .pipe(Effect.orDie)

        if (since !== undefined && since < data.resetAt()) {
          yield* ws.send(JSON.stringify({ type: "reload", version: null }))

          return response
        }

        if (since !== undefined) {
          yield* data.replay(since, (change) =>
            Effect.flatMap(mayRead(env, reader, change.doc), (ok) => {
              const out = toPage(change)

              return ok
                ? ws.send(
                    JSON.stringify({
                      type: "change",
                      ...out,
                      doc: asker.audience === "public" ? masked(out.doc) : out.doc,
                    }),
                  )
                : Effect.void
            }),
          )
        }

        yield* ws.send(
          JSON.stringify({ type: "hello", seq: data.seq(), version: version ?? null, hiddenMs }),
        )

        return response
      })

      // The home page asks for the pictures of the cards it shows, and only those: one with none (or not tried for a while) is booked
      // again here, and one of an older format (light only, or 800×500) is taken again as pictures are taken now.
      const shot = Effect.fnUntraced(function* (query: URLSearchParams) {
        const taken = yield* shots.get()

        if (taken === undefined) yield* shots.missing()
        else yield* shots.outdated()

        if (taken === undefined) {
          return HttpServerResponse.text(`${name()} has no picture yet.\n`, {
            status: 404,
            headers: { "cache-control": "no-store" },
          })
        }

        const dark = query.get("theme") === "dark" ? taken.dark : undefined

        return HttpServerResponse.uint8Array(dark ?? taken.image, {
          contentType: "image/webp",
          headers: {
            "x-openbelt-theme": dark === undefined ? "light" : "dark",
            "cache-control":
              query.get("v") === taken.at ? "private, max-age=31536000, immutable" : "no-cache",
            "x-openbelt-version": taken.version,
            "x-openbelt-taken": taken.at,
          },
        })
      })

      // A link previewer (Slack, iMessage, X), which never signs in. On the workspace host: the app's own card and line if openbelt.json
      // says "card": "public", else the workspace's private one. On the public host the app is anyone's already, so always its own, and
      // never the private one. The gateway sends it here (_og for a page, _og.png for the image).
      const linkPreview = Effect.fnUntraced(function* (
        image: boolean,
        query: URLSearchParams,
        audience: Audience,
      ) {
        const taken = yield* shots.get()
        const text = yield* cardText()

        // No card yet, or one of an older version (a live switch that booked no picture): take one.
        if (taken?.cards === undefined || taken.version !== versions.liveName())
          yield* shots.missing()
        else yield* shots.outdated()

        const own = audience === "public" || text?.config.card === "public"
        // Only a card drawn from the live version: one from an older (maybe private) version shows what that one had.
        const shown = own && taken?.version === versions.liveName()

        if (image) {
          const cards = taken?.cards

          if (cards === undefined || taken === undefined || (audience === "public" && !shown))
            return HttpServerResponse.text(`${name()} has no link preview card yet.\n`, {
              status: 404,
              headers: { "cache-control": "no-store" },
            })

          return HttpServerResponse.uint8Array(shown ? cards.card : cards.private, {
            contentType: "image/jpeg",
            headers: {
              "cache-control":
                query.get("v") === `${taken.at}${shown ? "" : "-p"}`
                  ? "public, max-age=31536000, immutable"
                  : "public, max-age=300",
            },
          })
        }

        const workspace = text?.workspace ?? ""

        const url =
          text === undefined
            ? ""
            : audience === "public"
              ? publicUrl(text.origin, name(), workspace, publicHost)
              : appUrl(text.origin, name())

        const title = taken?.cards?.title ?? nameOfSlug(name())
        // The app's own words: on the public host always, on the workspace host only beside its own card.
        const words = audience === "public" || shown

        return HttpServerResponse.text(
          cardTags({
            url,
            title: words ? title : `An app in ${workspace}`,
            description: words
              ? aboutOf(title, text?.description ?? "")
              : `Sign in with your ${workspace} account to open it.`,
            image:
              taken?.cards === undefined || url === "" || (audience === "public" && !shown)
                ? null
                : `${url}_og.png?v=${encodeURIComponent(`${taken.at}${shown ? "" : "-p"}`)}`,
          }),
          {
            contentType: "text/html; charset=utf-8",
            headers: { "cache-control": "public, max-age=300" },
          },
        )
      })

      return {
        deploy: Effect.fn("AppDO.deploy")(function* (
          app: string,
          request: DeployRequest,
          seed: boolean,
          where?: { readonly workspace: WorkspaceId; readonly origin: string },
        ) {
          kv.put("name", app)

          if (where !== undefined) {
            kv.put("workspace", where.workspace)
            kv.put("origin", where.origin)
          }

          const env = request.env

          if (env === undefined) return yield* versions.deploy(request)

          const there = yield* envVersion(env)

          const deployed = yield* versions.deploy({
            ...request,
            base:
              request.base ?? (request.keepOthers || request.edits.length > 0 ? there : undefined),
          })

          yield* sql.exec(
            "INSERT INTO environments (env, version) VALUES (?, ?) ON CONFLICT (env) DO UPDATE SET version = excluded.version",
            env,
            deployed.version,
          )

          if (there !== deployed.version) {
            yield* watched.aggregatesChanged(env)
            yield* broadcast(envDataset(env), { type: "reload", version: deployed.version })
          }

          const result = { ...deployed, previous: there ?? null }

          if (!seed) return result

          const data = yield* envData(env)

          if ((yield* data.size()) > 0) {
            return {
              ...result,
              seeded: {
                docs: 0,
                capped: false,
                skipped: `${app} already has data in "${env}", so nothing was copied (seed copies once, into empty data). preview_reset({ env: "${env}", app: "${app}" }) empties it; deploy with seed again to copy live data in.`,
              },
            }
          }

          const full = yield* storageFull(request.trace)

          if (full !== undefined)
            return {
              ...result,
              seeded: { docs: 0, capped: false, skipped: `nothing was copied: ${full}` },
            }

          const seeded = yield* data.seed("live", SEED_CAP, request.trace).pipe(
            Effect.catchTag("Refused", (e) =>
              Effect.succeed({
                docs: 0,
                capped: false,
                skipped: `nothing was copied: ${e.message}`,
              }),
            ),
          )

          yield* watched.aggregatesChanged(env)
          yield* broadcast(envDataset(env), { type: "reload", version: null })

          return { ...result, seeded }
        }),
        promote: versions.promote,
        restore: Effect.fn("AppDO.restore")(function* (previous: string | null, trace: string) {
          yield* versions.restore(previous, trace)

          if (previous === null) yield* schedules.sync(trace)
        }),
        movedSince: versions.movedSince,
        contents: versions.contents,
        diff: versions.diff,
        envVersion,
        resetEnv,
        dropEnv,
        info,
        disconnect: Effect.fn("AppDO.disconnect")(function* (
          email: string,
          why: string,
          kind: "removed" | "regrouped" | "signed_out" = "removed",
        ) {
          let closed = 0

          for (const open of yield* state.getWebSockets()) {
            const tag = yield* open
              .getAttachment(SocketTag)
              .pipe(Effect.orElseSucceed(() => ({ dataset: "live", viewer: null })))

            if (tag.viewer === email) {
              yield* watched.closed(open)
              // A close reason is at most 123 bytes.
              yield* kind === "regrouped"
                ? open.close(4409, "groups changed: reconnect")
                : open.close(4403, kind === "removed" ? "removed from the workspace" : "signed out")
              closed += 1
            }
          }

          if (closed > 0) yield* log("info", "-", `closed ${closed} pages of ${email}: ${why}`)

          return closed
        }),
        /**
         * Delete everything the app holds, for WorkspaceDO.deleteApp: its files' bytes in the file store, its open pages (they reload,
         * to the 404 its deleted record gives), and every table, job and kv key of its own. The workspace then puts it to sleep; were it
         * woken later, it finds no live version, nothing booked and nothing to send. Running it again finds nothing and does nothing.
         */
        destroy: Effect.fn("AppDO.destroy")(function* (trace: string) {
          // A public app's files kept at the CDN's edge go now, not a minute later (before its name and origin go below).
          const origin = kv.get<string>("origin") ?? ""

          if (
            purger.kind !== "off" &&
            publicHost !== "" &&
            URL.canParse(origin) &&
            kv.get<boolean>("edge-public") === true
          )
            yield* purgeHost(
              purger,
              `${publicLabel(name(), new URL(origin).hostname.split(".")[0] ?? "")}.${publicHost}`,
            )

          const workspace = workspaceId()
          const self = state.id.toString()

          // A second run (a retry, or two deletes at once) finds the tables already gone: nothing to remove.
          const [hasFiles] = yield* (yield* sql.exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'files'",
          )).toArray()

          const stored =
            (hasFiles?.n ?? 0) === 0
              ? []
              : yield* (yield* sql.exec<{ id: string }>("SELECT id FROM files")).toArray()

          if (workspace !== undefined)
            yield* Effect.forEach(
              stored,
              (one) =>
                Effect.tryPromise(() =>
                  Runtime.fileStore.remove(`${workspace}/${self}/${one.id}`),
                ).pipe(
                  Effect.tapError(() => Effect.sync(() => Runtime.recordFileStoreError("remove"))),
                  Effect.ignore,
                ),
              { concurrency: 8 },
            )

          for (const open of yield* state.getWebSockets()) {
            yield* watched.closed(open)
            yield* open.close(4403, "app deleted")
          }

          const tables = yield* (yield* sql.exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('__kv', '__jobs')",
          )).toArray()

          for (const table of tables)
            yield* sql.exec(`DROP TABLE IF EXISTS "${table.name.replaceAll('"', '""')}"`)

          yield* sql.exec("DELETE FROM __jobs")

          for (const key of Array.from(kv.list(), ([k]) => k)) kv.delete(key)

          yield* Effect.logInfo(
            `app deleted: ${stored.length} files and ${tables.length} tables of ${self}`,
          ).pipe(Effect.annotateLogs({ trace }))

          return { files: stored.length, tables: tables.length }
        }),
        shootSoon: shots.soon,
        /** A starter just added (starters.ts): its picture made ahead, when it has a current one, else one taken soon. */
        starterPicture: Effect.fn("AppDO.starterPicture")(function* (
          starter: string,
          root: string,
        ) {
          const found = STARTERS.find((s) => s.name === starter)
          const picture = found?.picture

          if (found !== undefined && picture?.kind === "current")
            yield* shots.given(root, picture.light, picture.dark, found.color)
          else yield* shots.soon(root)
        }),
        entry: directoryEntry,
        listing: Effect.fn("AppDO.listing")(function* () {
          return {
            collections: yield* summaries(live),
            functions: yield* functionsOf(undefined),
            skills: skillSummaries(yield* ownSkills()),
          }
        }),
        /** The home page's picture of it, as app_picture sends it (base64 WebP), or null before the first is taken (booked here, as
         *  the home page's ask books one). */
        picture: Effect.fn("AppDO.picture")(function* (theme: "light" | "dark") {
          const taken = yield* shots.get()

          if (taken === undefined) {
            yield* shots.missing()

            return null
          }

          yield* shots.outdated()

          const dark = theme === "dark" ? taken.dark : undefined

          return {
            image: (dark ?? taken.image).toBase64(),
            theme: dark === undefined ? ("light" as const) : ("dark" as const),
            version: taken.version,
            at: taken.at,
          }
        }),
        skills: Effect.fn("AppDO.skills")(function* () {
          return yield* skills()
        }),
        skillFile: Effect.fn("AppDO.skillFile")(function* (path: string) {
          return (yield* skillFile(path)) ?? null
        }),
        /** Its live functions, each with its declared input schema (null when it declares none). */
        functionsWithInput: Effect.fn("AppDO.functionsWithInput")(function* () {
          const config = settingsOf(yield* versions.config())

          return (yield* functionsOf(undefined)).map((f) => ({
            ...f,
            input: contractOf(config, f.name)?.input ?? null,
          }))
        }),
        call: callAs,
        runs: runs.list,
        hookSecret: Effect.fn("AppDO.hookSecret")(function* (
          fn: string,
          rotate: boolean,
          trace: string,
          env?: string,
        ) {
          const version = env === undefined ? undefined : yield* envVersion(env)
          const openbelt = yield* versions.config(version)

          if (openbelt.kind === "unreadable")
            return yield* new Refused({ message: openbelt.problem })

          const hooks = openbelt.config.webhooks ?? {}
          const hook = Object.hasOwn(hooks, fn) ? hooks[fn] : undefined

          if (hook === undefined) {
            const listed = Object.keys(hooks)

            return yield* new Refused({
              message: `"${name()}"'s ${env === undefined ? "live" : `preview ${env}`} openbelt.json has no webhook "${fn}" (it lists ${listed.length === 0 ? "none" : listed.join(", ")}): add it under "webhooks", e.g. "webhooks": {"${fn}": {"verify": "hmac-sha256"}}, deploy, then ask again`,
            })
          }

          const check = checkOf(hook)

          if (check.kind === "none")
            return { verify: hook.verify, header: null, prefix: null, secret: null, at: null }

          const had = yield* hookSecrets.get(fn, env)
          const prefix = check.kind === "hmac" ? check.prefix : null

          if (had !== undefined && !rotate)
            return {
              verify: hook.verify,
              header: headerOf(check),
              prefix,
              secret: null,
              at: had.at,
            }

          const made = yield* hookSecrets.make(fn, env)

          yield* log(
            "info",
            trace,
            `webhook ${fn}: ${had === undefined ? "secret made" : "secret rotated: the old one no longer works"}`,
          )

          return {
            verify: hook.verify,
            header: headerOf(check),
            prefix,
            secret: made.secret,
            at: made.at,
          }
        }),
        setSecret: Effect.fn("AppDO.setSecret")(function* (
          secret: string,
          value: string | null,
          by: string,
          trace: string,
          hosts?: ReadonlyArray<string>,
        ) {
          const stored = yield* versions.config()
          const config = settingsOf(stored)
          const listed = declaredSecrets(config)
          const declared = listed.get(secret)
          let pinned: ReadonlyArray<string> | null = null

          const tooShortOrLong = value === null ? undefined : secretValueProblem(value)

          if (tooShortOrLong !== undefined) return yield* new Refused({ message: tooShortOrLong })

          if (value === null) {
            const had = yield* sealed.remove(secret)

            yield* log("info", trace, `secret ${secret} ${had ? "removed" : "wasn't set"} by ${by}`)
          } else {
            pinned =
              hosts ?? (declared === undefined ? null : (declared.hosts ?? config.network ?? []))

            if (pinned === null && stored.kind === "unreadable")
              return yield* new Refused({ message: `${stored.problem}; or pass hosts` })

            if (pinned === null)
              return yield* new Refused({
                message: `a secret is pinned to the hosts it may go to when it's set, and ${name()}'s live openbelt.json doesn't list ${secret} under "secrets" yet (it lists ${listed.size === 0 ? "none" : [...listed.keys()].join(", ")}): deploy "secrets": {"${secret}": "what it's for"} with its API's host in "network" first, then set it; or pass hosts: ["api.example.com"]`,
              })

            const { replaced } = yield* sealed.set(secret, value, pinned, by)

            yield* log(
              "info",
              trace,
              `secret ${secret} ${replaced ? "replaced" : "set"} by ${by} (${value.length} characters), to go only to ${pinned.length === 0 ? "no host (secrets.hmac only)" : pinned.join(", ")}`,
            )
          }

          const status = yield* sealed.status()

          return {
            set: value !== null,
            at: status.get(secret)?.at ?? null,
            about: declared?.for ?? null,
            declared: [...listed.keys()],
            hosts: pinned,
          }
        }),
        widenedSecrets: Effect.fn("AppDO.widenedSecrets")(function* (version: string) {
          const config = settingsOf(yield* versions.config(version))
          const declared = declaredSecrets(config)
          const held = yield* sealed.values(declared.keys())
          const { origin } = workspaceOf()

          return [...held].flatMap(([secret, h]) => {
            const problem = widened(
              name(),
              secret,
              h,
              declared.get(secret)?.hosts ?? config.network ?? [],
              origin,
            )

            return problem === undefined ? [] : [problem]
          })
        }),
        unsetSecrets: Effect.fn("AppDO.unsetSecrets")(function* (version: string) {
          const status = yield* sealed.status()

          return [...declaredSecrets(settingsOf(yield* versions.config(version))).keys()].filter(
            (secret) => !status.has(secret),
          )
        }),
        sdkMisuse: Effect.fn("AppDO.sdkMisuse")(function* (
          version: string,
          changed: ReadonlyArray<string>,
        ) {
          const files = (yield* versions.get(version))?.files ?? new Map<string, never>()
          const found: Array<string> = []

          for (const path of changed) {
            const entry = files.get(path)

            if (entry === undefined || !/\.(?:html?|m?js)$/.test(path)) continue

            const bytes = yield* versions.body(entry.hash)

            if (bytes === undefined) continue

            for (const problem of sdkMisuseIn(path, new TextDecoder().decode(bytes)))
              found.push(problem)
          }

          return found
        }),
        exposedFunctions: Effect.fn("AppDO.exposedFunctions")(function* (version: string) {
          const config = settingsOf(yield* versions.config(version))
          const files = (yield* versions.get(version))?.files ?? new Map<string, never>()
          const listed = new Set(Object.keys(config.functions ?? {}).map(functionPath))
          const runBy = new Map<string, { by: string; as: "schedule" | "later" }>()

          for (const fn of Object.keys(config.schedules ?? {}))
            runBy.set(fn, { by: `openbelt.json "schedules"`, as: "schedule" })

          for (const fn of Object.keys(config.functions ?? {})) {
            const code = (yield* functionCode(version, fn))?.code ?? ""

            for (const [target, how] of functionsRunIn(code))
              if (!runBy.has(target))
                runBy.set(target, { by: `${functionPath(fn)}'s ${how}`, as: "later" })
          }

          const open = [...runBy].filter(
            ([fn]) => lists(config, fn) && notCallable(config, name(), fn) === undefined,
          )

          if (open.length === 0) return []

          const paged = new Set<string>()

          for (const [path, entry] of files) {
            if (listed.has(path) || !/\.(?:html?|m?js)$/.test(path)) continue

            const bytes = yield* versions.body(entry.hash)

            if (bytes !== undefined)
              for (const fn of functionsCalledIn(new TextDecoder().decode(bytes))) paged.add(fn)
          }

          return open.flatMap(([fn, { by, as }]) =>
            paged.has(fn)
              ? []
              : [
                  `${by} runs "${fn}" and no page calls it, but anyone signed in can call "${fn}" directly (a page's db.fn, call_function, its tool ${name()}__${fn}). Mark it "internal": true in openbelt.json ("functions": {"${fn}": {"description": "...", "internal": true}}) if only your code should; you can still test it then: call_function({ app: "${name()}", function: "${fn}", as: "${as}" }) runs it as ${by} would`,
                ],
          )
        }),
        hookTest,
        inventory: Effect.fn("AppDO.inventory")(function* () {
          const docs = (yield* live.counts()).reduce((sum, c) => sum + c.docs, 0)
          const page = (yield* versions.live())?.files.get("index.html")

          return {
            version: versions.liveName() ?? null,
            docs,
            serves: page !== undefined && (yield* versions.body(page.hash)) !== undefined,
          }
        }),
        config: (version?: string) => Effect.map(versions.config(version), settingsOf),
        /**
         * What the app's panel in its frame shows (frame.ts): its live version and whether it's public, and with `full` (its owner
         * or an admin is looking) its last versions, preview environments, collections and newest log lines.
         */
        panel: Effect.fn("AppDO.panel")(function* (full: boolean) {
          const current = yield* versions.live()
          const settings = settingsOf(yield* versions.config())

          const shown = {
            live:
              current === undefined
                ? null
                : {
                    version: current.version,
                    at: current.promotedAt ?? current.deployedAt,
                    by: current.promotedBy ?? current.deployedBy,
                  },
            published: current !== undefined && settings.public !== undefined,
          }

          if (!full) return { ...shown, details: null }

          return {
            ...shown,
            details: {
              public: settings.public ?? null,
              functions: Object.keys(settings.functions ?? {}),
              versions: yield* versions.history(),
              environments: yield* environments(),
              collections: (yield* summaries(live)).map((c) => ({
                name: c.name,
                docs: c.docs,
                lastWrite: c.lastWrite,
                writable: c.writable,
                ruled: c.rules !== null,
              })),
              logs: yield* logs(undefined, PANEL_LOGS),
              usage: yield* appUsage.stats(),
            },
          }
        }),
        /**
         * `change` as the live openbelt.json's "public", deployed by `by` as a new live version with nothing else changed: who can
         * view the app and what visitors can use, from its panel. A block replaces it, null takes it out, and "open" makes the app
         * public with its pages and files only unless it already is. Null when it already says that.
         */
        publish: Effect.fn("AppDO.publish")(function* (
          change: PublicBlock | null | "open",
          by: string,
          trace: string,
        ) {
          const current = yield* versions.live()

          if (current === undefined)
            return yield* new Refused({ message: "it has no live version yet: deploy it first" })

          const [written] = current.files.has("openbelt.json")
            ? (yield* versions.contents(undefined, ["openbelt.json"], undefined)).files
            : []

          const parsed = decodeOpenbeltJson(written?.content ?? "{}")

          if (Option.isNone(parsed))
            return yield* new Refused({
              message:
                "its openbelt.json isn't a JSON object, so it wasn't changed: fix it with a deploy",
            })

          const { public: was, ...rest } = parsed.value

          if (change === "open" && was !== undefined) return null

          const block = change === "open" ? {} : change
          const next = block === null ? rest : { public: block, ...rest }

          if (JSON.stringify(was ?? null) === JSON.stringify(block)) return null

          return yield* versions.deploy({
            files: [{ path: "openbelt.json", content: `${JSON.stringify(next, null, 2)}\n` }],
            keepOthers: true,
            remove: [],
            edits: [],
            base: current.version,
            env: undefined,
            by,
            trace,
          })
        }),
        /**
         * Whether a browser opening `path` on the public host gets it under the OpenBelt bar: the live version is public, its "bar"
         * isn't false, and `path` is one of its pages, as publicFile would serve it. If so the visit is counted here, with where it
         * came from, as that page's own open would be; a path that isn't a page gets the 404 itself, counted as nothing.
         */
        publicPage: Effect.fn("AppDO.publicPage")(function* (
          path: string,
          address: string | undefined,
          agent: string,
          referer: string | undefined,
          host: string,
        ) {
          const version = versions.liveName()

          if (version === undefined) return false

          const block = settingsOf(yield* versions.config()).public

          if (block === undefined || block.bar === false) return false

          const manifest = yield* versions.get(version)
          const filename = path === "" || path.endsWith("/") ? `${path}index.html` : path

          const served =
            manifest === undefined || publicHides(filename)
              ? undefined
              : servedAt(path, (f) => !publicHides(f) && manifest.files.has(f), true)

          if (served === undefined || !contentType(served.file).startsWith("text/html"))
            return false

          yield* pageOpened(publicOpener(address, agent, referer, host))

          return true
        }),
        /** Whether the live version is public (openbelt.json "public"): the public host's old names move only for one that is. */
        published: Effect.fn("AppDO.published")(function* () {
          return (
            versions.liveName() !== undefined &&
            settingsOf(yield* versions.config()).public !== undefined
          )
        }),
        tools: Effect.fn("AppDO.tools")(function* (env: string | undefined) {
          return yield* toolsOf(env)
        }),
        ownedByFunctions: Effect.fn("AppDO.ownedByFunctions")(function* (
          collection: string,
          ops: ReadonlyArray<"create" | "update" | "delete">,
          via: string,
        ) {
          const rule = matchKey(settingsOf(yield* versions.config()).rules ?? {}, collection)?.value

          const closed = ops.filter(
            (op) => rule !== undefined && ["nobody", "false"].includes(rule[op].trim()),
          )

          if (closed.length === 0) return undefined

          const current = versions.liveName()

          if (collectionProblem(collection) !== undefined) return undefined

          const uses = new RegExp(`\\bcollection\\(\\s*["'\`]${collection}["'\`]\\s*\\)`)

          const writers =
            current === undefined
              ? []
              : yield* Effect.filter(
                  (yield* functionsOf(undefined)).filter((f) => f.kind === "function"),
                  (f) =>
                    Effect.map(
                      functionCode(current, f.name),
                      (found) => found !== undefined && uses.test(found.code),
                    ),
                )

          if (writers.length === 0) return undefined

          const named = writers.map((m) => m.name).join(", ")

          return `"${collection}" in "${name()}" is written only by its functions (its rules let nobody ${closed.join(" or ")} there), so ${via} would go around the checks they make, and OpenBelt refused it. Call the function that does this, call_function({ app: "${name()}", function: "<one of: ${named}>", input }) (app_info says what each takes); to seed or fix data, add a function that does it (e.g. "seed") and call that. In a preview environment, test data can be written directly.`
        }),
        list: (env: string | undefined, ...args: Parameters<typeof live.list>) =>
          Effect.flatMap(dataOf(env), (data) => data.list(...args)),
        get: (env: string | undefined, collection: string, id: string) =>
          Effect.flatMap(dataOf(env), (data) => data.get(collection, id)),
        remove: (
          env: string | undefined,
          collection: string,
          id: string,
          actor: Actor,
          trace: string,
        ) => writeOne(env, collection, { op: "delete", id }, actor, trace),
        clear,
        writeMany,
        logs,
        note: (lvl: LogLine["level"], trace: string, message: string) => log(lvl, trace, message),

        fileAdded: Effect.fn("AppDO.fileAdded")(function* (
          added: {
            readonly id: string
            readonly env: string
            readonly name: string | null
            readonly type: string
            readonly size: number
            readonly sha256: string
            readonly author: string
          },
          trace: string,
          took: string,
        ) {
          yield* sql.exec(
            "INSERT INTO files (id, env, name, type, size, sha256, author, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            added.id,
            added.env,
            added.name,
            added.type,
            added.size,
            added.sha256,
            added.author,
            new Date().toISOString(),
          )

          yield* bookSweep()

          yield* log(
            "info",
            trace,
            `file stored: ${added.id}${added.name === null ? "" : ` "${added.name}"`} (${added.type}, ${sizeOf(added.size)}) by ${added.author}${added.env === "" ? "" : ` in ${added.env}`}, ${took}`,
          )
        }),

        /** The file's record gone, and its size (to give back to the workspace), or null if there was none. */
        fileRemoved: Effect.fn("AppDO.fileRemoved")(function* (
          id: string,
          by: string,
          trace: string,
        ) {
          const [row] = yield* (yield* sql.exec<{
            size: number
            name: string | null
            author: string
          }>("SELECT size, name, author FROM files WHERE id = ?", id)).toArray()

          if (row === undefined) {
            yield* log(
              "warn",
              trace,
              `file delete by ${by}: there's no file ${id} (deleted before, or never stored)`,
            )

            return { kind: "missing" as const }
          }

          const what = `${id}${row.name === null ? "" : ` "${row.name}"`} (${sizeOf(row.size)})`

          // Only whoever uploaded a file deletes it: a page's delete button for someone else's file is refused, whatever it shows.
          if (row.author !== by) {
            yield* log(
              "warn",
              trace,
              `file delete refused: ${what} was uploaded by ${row.author}, not ${by}`,
            )

            return { kind: "theirs" as const, author: row.author }
          }

          yield* sql.exec("DELETE FROM files WHERE id = ?", id)
          yield* log("info", trace, `file deleted: ${what} by ${by}`)

          return { kind: "deleted" as const, size: row.size }
        }),

        filesList: Effect.fn("AppDO.filesList")(function* (env: string | undefined) {
          return yield* (yield* sql.exec<{
            id: string
            env: string
            name: string | null
            type: string
            size: number
            sha256: string
            author: string
            created: string
          }>(
            env === undefined
              ? "SELECT * FROM files ORDER BY created DESC"
              : "SELECT * FROM files WHERE env = ? ORDER BY created DESC",
            ...(env === undefined ? [] : [env]),
          )).toArray()
        }),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest
          const trace = request.headers["x-openbelt-trace"] ?? "-"
          const full = request.headers["x-openbelt-path"] ?? ""
          const query = new URL(request.url, "http://app").searchParams
          const asker = askerOf(request.headers)

          if (asker.audience === "public") return yield* publicFetch(full, query, trace, asker)

          const under = previewOf(full)

          if (under !== undefined && under.rest === undefined) {
            return HttpServerResponse.redirect(
              `${encodeURIComponent(under.env)}/${query.size > 0 ? `?${query.toString()}` : ""}`,
              { status: 301 },
            )
          }

          const path = under === undefined ? full : (under.rest ?? "/").slice(1)
          const there = under === undefined ? undefined : yield* envVersion(under.env)

          const target: Target =
            under === undefined
              ? { kind: "live" }
              : there === undefined
                ? { kind: "outside", env: under.env }
                : { kind: "env", env: under.env, version: there }

          if (target.kind === "outside" && !DATA_ROUTE.test(path)) {
            const problem = envProblem(target.env)

            return HttpServerResponse.text(
              problem === undefined
                ? `"${name()}" isn't deployed into preview environment "${target.env}". Its live app is at / on this host. To try it in "${target.env}", ${joinHint(name(), target.env)}\n`
                : `${problem}\n`,
              { status: 404 },
            )
          }

          const env = target.kind === "env" ? target.env : undefined
          const data = yield* dataOf(env)
          const version = target.kind === "env" ? target.version : versions.liveName()

          if (path === "_shot" && target.kind === "live") return yield* shot(query)

          if ((path === "_og" || path === "_og.png") && target.kind === "live")
            return yield* linkPreview(path === "_og.png", query, "workspace")

          if (path === "_log") {
            return yield* browserLog(env === undefined ? "live" : `preview ${env}`, trace)
          }

          if (path === "_ws") {
            const since = Number(query.get("since") ?? "NaN")

            return yield* socket(
              env,
              data,
              Number.isInteger(since) ? since : undefined,
              version,
              query.get("batch") === "1",
              asker,
            )
          }

          const aggregateRoute = /^_aggregates\/([^/]+)$/.exec(path)

          if (aggregateRoute !== null) {
            if (request.method !== "GET" && request.method !== "HEAD")
              return failure(405, "method", "read aggregates with GET /_aggregates/<name>", trace)
            const aggregateName = decoded(aggregateRoute[1] ?? "")
            const problem = collectionProblem(aggregateName)

            if (problem !== undefined) return failure(400, "invalid", problem, trace)

            return yield* respond(
              trace,
              readAggregate(env, aggregateName, readerOf(asker)).pipe(
                Effect.map((value) => value.result),
              ),
            )
          }

          if (path === "_db" || path === "_db/") {
            if (request.method !== "GET") {
              return failure(
                405,
                "method",
                "GET /_db lists the collections; /_db/<collection> adds",
                trace,
              )
            }

            return HttpServerResponse.jsonUnsafe(
              yield* summaries(data, target.kind === "env" ? target.version : undefined),
            )
          }

          const hooked = /^_hook\/([^/]*)(?:\/([^/]*))?$/.exec(path)

          if (hooked !== null) {
            if (target.kind === "outside")
              return failure(
                404,
                "missing",
                `"${name()}" isn't deployed into preview environment "${target.env}", so it has no webhooks there: ${joinHint(name(), target.env)}`,
                trace,
              )

            return yield* hookRoute(
              target.kind === "env" ? target : undefined,
              decoded(hooked[1] ?? ""),
              hooked[2] === undefined ? undefined : decoded(hooked[2]),
              trace,
            )
          }

          const called = /^_fn\/([^/]*)$/.exec(path)

          if (called !== null)
            return yield* callRoute(target, decoded(called[1] ?? ""), trace, asker)

          const route = /^_db\/([^/]*)(?:\/([^/]*))?$/.exec(path)

          if (route !== null) {
            const [, collection = "", id] = route

            if (
              request.method === "POST" ||
              request.method === "PUT" ||
              request.method === "PATCH"
            ) {
              const over = yield* storageFull(trace)

              if (over !== undefined) return failure(507, "storage_full", over, trace)
            }

            return yield* db(
              target,
              data,
              decoded(collection),
              id === undefined ? undefined : decoded(id),
              query,
              trace,
              asker,
            )
          }

          return yield* file(
            path,
            trace,
            version,
            "workspace",
            target.kind === "live" ? openerOf(asker, request) : undefined,
          )
        }),
        webSocketMessage: Effect.fn(function* (ws: Runtime.Socket, message: string | ArrayBuffer) {
          if (!Predicate.isString(message)) return

          const tag = yield* ws.getAttachment(SocketTag).pipe(Effect.option)

          if (Option.isNone(tag)) return

          yield* watched.message(ws, infoOf(tag.value), message)
        }),
        webSocketClose: Effect.fn(function* (ws: Runtime.Socket, code: number, reason: string) {
          yield* watched.closed(ws)
          // 1005 (no code given) and 1006 (dropped) can't be sent back: answer a plain close.
          yield* ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
        }),
      }
    })
  }).pipe(Effect.provide(Checker.layer)),
) {}
