// The gateway's small HTTP pieces, shared by the modules that answer its routes (gateway.ts, base.ts): JSON and HTML answers,
// what a form or an OAuth request carries, and whether a request came from a page of the same host.
import type * as Headers from "effect/http/Headers"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ErrorCode, Json } from "./model.ts"

export const json = (
  body: Readonly<Record<string, Json>> & { readonly code?: ErrorCode },
  status = 200,
) => HttpServerResponse.jsonUnsafe(body, { status })

/** Whether a request asks for markdown first (an agent fetching a page), not HTML. */
export const wantsMarkdown = (accept: string | undefined) =>
  (accept ?? "").includes("text/markdown")

export const markdown = (text: string) =>
  HttpServerResponse.text(text, {
    contentType: "text/markdown; charset=utf-8",
    headers: { vary: "accept", "cache-control": "no-cache" },
  })

export const htmlOf = (
  body: string,
  options: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
) => HttpServerResponse.text(body, { ...options, contentType: "text/html; charset=utf-8" })

/**
 * The part of a file a Range header asks for ("bytes=0-99", "bytes=100-", "bytes=-50"), as first and last byte: null
 * when it asks for none (no header, or one this doesn't serve: several ranges, another unit), "unsatisfiable" when it
 * starts past the end. A player seeks through a video this way, and some won't play one from a server that can't.
 */
export const byteRange = (header: string | undefined, size: number) => {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "")

  if (asked === null || (asked[1] === "" && asked[2] === "")) return null

  const first = asked[1] === "" ? Math.max(0, size - Number(asked[2])) : Number(asked[1])
  const last = asked[1] === "" || asked[2] === "" ? size - 1 : Math.min(Number(asked[2]), size - 1)

  return first >= size || first > last ? ("unsatisfiable" as const) : { first, last }
}

/**
 * Who sent a request: the first X-Forwarded-For address when a front door set it (Caddy replaces any a client sends, as it trusts
 * no proxy before it; the platform's own port is bound to 127.0.0.1 on a server), else the connection's own address.
 */
export const clientAddress = (
  headers: Readonly<Record<string, string | undefined>>,
  remote: string | undefined,
) => headers["x-forwarded-for"]?.split(",")[0]?.trim() || remote || "unknown"

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Electron\//, "Electron"],
  [/HeadlessChrome\//, "Headless Chrome"],
  [/Edg\//, "Edge"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
]

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
]

/** A browser's family and system from its User-Agent ("Safari · macOS"), for logs: never the whole string. */
export const browserOf = (agent: string | undefined) => {
  const named = (list: ReadonlyArray<readonly [RegExp, string]>) =>
    list.find(([test]) => test.test(agent ?? ""))?.[1] ?? "other"

  return `${named(BROWSERS)} · ${named(SYSTEMS)}`
}

export const bearer = (header: string | undefined) => /^Bearer (.+)$/.exec(header ?? "")?.[1]

/** OAuth's endpoints are called from anywhere, browsers included (RFC 8414 and 7591 clients). */
const OAUTH_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
}

const AuthorizeFields = Schema.Struct({
  response_type: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  client_id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  redirect_uri: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  state: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  scope: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  code_challenge: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  code_challenge_method: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20))),
  resource: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
})

export const decodeAuthorize = Schema.decodeUnknownOption(AuthorizeFields)

const decodeJsonFields = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

export const isString = Schema.is(Schema.String)

export const withOAuthCors = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(response, OAUTH_CORS)

export const fieldsOf = (text: string, contentType: string | undefined): Record<string, string> => {
  if ((contentType ?? "").includes("json")) {
    return Option.match(decodeJsonFields(text), {
      onNone: () => ({}),
      onSome: (o) =>
        Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (isString(v) ? [[k, v]] : []))),
    })
  }

  return Object.fromEntries(new URLSearchParams(text))
}

/** Authorization: Basic's client id and secret (RFC 6749 2.3.1: each form-urlencoded). */
export const basicOf = (header: string | undefined) => {
  const encoded = /^Basic (.+)$/i.exec(header ?? "")?.[1]

  if (encoded === undefined) return undefined

  try {
    const [id = "", ...rest] = atob(encoded).split(":")

    return {
      id: decodeURIComponent(id.replaceAll("+", " ")),
      secret: decodeURIComponent(rest.join(":").replaceAll("+", " ")),
    }
  } catch {
    return undefined
  }
}

export const WORKSPACE_PAGE = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
}

/**
 * Why a request to an app's data isn't from a page of `origin` itself, or undefined when it is (or
 * isn't from a browser page at all: curl and scripts send neither header). Browsers set both
 * headers themselves; a page can't change them. The host is what's compared: the scheme is the
 * front door's to say (a proxy that ends HTTPS), and a host is an app.
 */
export const crossOrigin = (headers: Headers.Headers, origin: string) => {
  const fetchedFrom = headers["sec-fetch-site"]
  const from = headers["origin"]

  if (fetchedFrom !== undefined && fetchedFrom !== "same-origin" && fetchedFrom !== "none")
    return `Sec-Fetch-Site: ${fetchedFrom}${from === undefined ? "" : `, Origin: ${from}`}`

  if (from !== undefined && !sameHost(from, origin)) return `Origin: ${from}`

  return undefined
}

export const sameHost = (url: string, origin: string) =>
  URL.canParse(url) && new URL(url).host === new URL(origin).host

/** `asked` as a path on `origin`, or "/" when it would lead anywhere else (`//elsewhere`, `/\telsewhere`, a full URL). */
export const localPath = (asked: string, origin: string) => {
  if (!URL.canParse(asked, origin)) return "/"

  const to = new URL(asked, origin)

  return to.origin === origin ? pathOf(to) : "/"
}

/** A URL's path and query, never starting with `//` (which a browser would read as another host). */
export const pathOf = (to: URL) => `/${to.pathname.replace(/^\/+/, "")}${to.search}`
