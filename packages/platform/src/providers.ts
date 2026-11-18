import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { FILES } from "../providers/index.ts"
import { CredentialOwner, Fix, Level, Refused } from "./model.ts"
import { same } from "./oauth-wire.ts"
import { queryWords, wordsIn } from "./words.ts"

const ProviderId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,29}$/, {
    description: 'lowercase letters, digits and dashes, starting with a letter, like "linear"',
  }),
)

const Https = Schema.String.check(
  Schema.isPattern(/^https:\/\/[^\s/]+(?:\/\S*)?$/, { description: "an https URL" }),
)

const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { description: 'a day, like "2026-10-28"' }),
)

const ToolName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/, { description: 'a tool name, like "list_issues"' }),
)

const Registration = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["dcr", "cimd"]) }),
  Schema.Struct({ kind: Schema.Literal("admin"), registerAt: Https }),
])

const FileQuirks = Schema.Struct({
  authorize: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Whether it takes RFC 8707's resource parameter (default true; Google doesn't). */
  sendResource: Schema.optionalKey(Schema.Boolean),
  scopeOnRefresh: Schema.optionalKey(Schema.Boolean),
  clientAuth: Schema.optionalKey(Schema.Literals(["client_secret_basic", "client_secret_post"])),
  revokeEndsAllGrants: Schema.optionalKey(Schema.Boolean),
})

const Measured = Schema.Struct({
  on: Day,
  accessTokenSeconds: Schema.optionalKey(Schema.Number),
  refreshRotates: Schema.optionalKey(Schema.Boolean),
  refreshTokenSeconds: Schema.optionalKey(Schema.Number),
  replay: Schema.optionalKey(Schema.Literals(["refused-grant-kept", "refused-grant-ended"])),
  note: Schema.optionalKey(Schema.String),
})

const common = {
  id: ProviderId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  maker: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
  about: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  url: Https,
  docs: Https,
  level: Schema.Literals(["read", "all"]),
  readOnlyTools: Schema.optionalKey(Schema.Array(ToolName)),
  probed: Day,
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
}

const apiFields = {
  kind: Schema.Literals(["openapi", "graphql"]),
  spec: Schema.optionalKey(Https),
  groups: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  fixes: Schema.optionalKey(Schema.Array(Fix)),
}

const ApiEntry = Schema.Struct({
  ...apiFields,
  test: Schema.Struct({
    tool: ToolName,
    input: Schema.Record(Schema.String, Schema.Json),
    expect: Schema.String.check(Schema.isMinLength(1)),
  }),
})

/** An API people sign in to: no test call, which would need an account. */
const SignedInApiEntry = Schema.Struct(apiFields)

const Provider = Schema.Union([
  Schema.Struct({ ...common, signIn: Schema.Literal("none"), api: Schema.optionalKey(ApiEntry) }),
  Schema.Struct({
    ...common,
    signIn: Schema.Literal("token"),
    credential: Schema.Literals(["workspace", "person", "both"]),
    tokenAt: Https,
  }),
  Schema.Struct({
    ...common,
    signIn: Schema.Literal("oauth"),
    credential: Schema.Literals(["workspace", "person", "both"]),
    issuer: Https,
    registration: Registration,
    scopes: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
    quirks: Schema.optionalKey(FileQuirks),
    measured: Schema.optionalKey(Measured),
    api: Schema.optionalKey(SignedInApiEntry),
  }),
])

export type Provider = typeof Provider.Type

const decodeProvider = Schema.decodeUnknownResult(Provider)

export const CATALOG: ReadonlyArray<Provider> = Object.entries(FILES).map(([file, data]) =>
  Result.getOrThrowWith(
    decodeProvider(data, { onExcessProperty: "error" }),
    (e) =>
      new Error(
        `packages/platform/providers/${file}.json doesn't match the format (packages/platform/providers/README.md): ${e.message}`,
      ),
  ),
)

export const FILE_NAMES: ReadonlyArray<string> = Object.keys(FILES)

const BY_ID = new Map(CATALOG.map((p) => [p.id, p]))

export const providerById = (id: string) => BY_ID.get(id)

export const signInLine = (p: Provider) => {
  const maker = p.maker ?? p.name

  if (p.signIn === "none") return "No sign-in needed"

  if (p.signIn === "token") return `Paste a ${maker} token`

  return p.registration.kind === "admin"
    ? `Sign in with ${maker}, once you register an app there`
    : `Sign in with ${maker}`
}

export type Quirks = {
  readonly authorize: Readonly<Record<string, string>>
  readonly sendResource: boolean
  readonly scopeOnRefresh: boolean
  readonly clientAuth?: "client_secret_basic" | "client_secret_post"
  readonly revokeEndsAllGrants: boolean
  readonly refreshRotates?: boolean
}

const STANDARD: Quirks = {
  authorize: {},
  sendResource: true,
  scopeOnRefresh: true,
  revokeEndsAllGrants: false,
}

const fileQuirks = (p: Extract<Provider, { readonly signIn: "oauth" }>): Quirks => {
  const q = p.quirks ?? {}
  const rotates = p.measured?.refreshRotates

  const base: Quirks = {
    authorize: q.authorize ?? STANDARD.authorize,
    sendResource: q.sendResource ?? STANDARD.sendResource,
    scopeOnRefresh: q.scopeOnRefresh ?? STANDARD.scopeOnRefresh,
    revokeEndsAllGrants: q.revokeEndsAllGrants ?? STANDARD.revokeEndsAllGrants,
  }

  const authed: Quirks = q.clientAuth === undefined ? base : { ...base, clientAuth: q.clientAuth }

  return rotates === undefined ? authed : { ...authed, refreshRotates: rotates }
}

const SIGNS_IN = CATALOG.flatMap((p) => (p.signIn === "oauth" ? [p] : []))

const QUIRKS = new Map(SIGNS_IN.map((p) => [p.id, fileQuirks(p)]))

export const quirksOf = (id: string | null | undefined): Quirks =>
  (id === null || id === undefined ? undefined : QUIRKS.get(id)) ?? STANDARD

export const providerAt = (at: { readonly url?: string; readonly issuer?: string }) => {
  const { url, issuer } = at

  return (
    (url === undefined ? undefined : CATALOG.find((p) => same(p.url, url)))?.id ??
    (issuer === undefined ? undefined : SIGNS_IN.find((p) => same(p.issuer, issuer))?.id)
  )
}

export const CatalogAdd = Schema.Struct({
  provider: Schema.String,
  name: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  spec: Schema.optionalKey(Schema.String),
  credential: Schema.optionalKey(CredentialOwner),
  everyone: Schema.optionalKey(Level),
  signIn: Schema.optionalKey(Schema.Literals(["oauth", "token"])),
  scopes: Schema.optionalKey(Schema.String),
  authorizeParams: Schema.optionalKey(Schema.String),
})

export const catalogFor = (query: string, have: ReadonlySet<string>, limit: number) => {
  const words = queryWords(query)

  const docs = CATALOG.map((p) => ({ p, words: new Set(wordsIn(`${p.id} ${p.name} ${p.about}`)) }))

  const having = new Map(words.map((w) => [w, docs.filter((d) => d.words.has(w)).length]))

  return docs
    .flatMap(({ p, words: own }) => {
      if (have.has(p.id)) return []

      const hits = words.filter((w) => own.has(w))

      if (!hits.some((w) => (having.get(w) ?? 0) <= 3)) return []

      const score = hits.reduce(
        (n, w) => n + Math.log((docs.length + 1) / ((having.get(w) ?? 0) + 1)),
        0,
      )

      return [{ p, score }]
    })
    .toSorted((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id))
    .slice(0, limit)
    .map(({ p }) => ({
      provider: p.id,
      name: p.name,
      about: p.about,
      signIn: signInLine(p),
    }))
}

export const nearIds = (asked: string) =>
  CATALOG.flatMap((p) =>
    p.id.startsWith(asked.slice(0, 3)) ||
    p.id.includes(asked) ||
    p.name.toLowerCase().includes(asked)
      ? [p.id]
      : [],
  )

export const apiFromCatalog = (asked: typeof CatalogAdd.Type) => {
  const p = providerById(asked.provider)

  if (p === undefined || p.signIn === "token" || p.api === undefined) return undefined

  const added = {
    name: asked.name ?? p.id,
    kind: p.api.kind,
    url: asked.url ?? p.url,
    everyone: asked.everyone ?? p.level,
    provider: p.id,
    spec: asked.spec ?? p.api.spec,
    tags: p.api.groups,
  }

  if (p.signIn === "none") return { ...added, credential: "none" as const }

  return {
    ...added,
    credential: asked.credential ?? p.credential,
    signIn: {
      issuer: p.issuer,
      scopes: asked.scopes ?? p.scopes.join(" "),
      params: asked.authorizeParams,
    },
  }
}

export const fixesOf = (id: string | null) => {
  const p = id === null ? undefined : providerById(id)

  return p?.signIn === "token" ? [] : (p?.api?.fixes ?? [])
}

export const testOf = (id: string | null) => {
  const p = id === null ? undefined : providerById(id)

  return p?.signIn === "none" ? p.api?.test : undefined
}

type FromCatalog = {
  provider: string
  name: string
  url: string
  credential: CredentialOwner
  everyone: Level
  signIn?: "oauth" | "token"
  scopes?: string
  authorizeParams?: string
  readOnlyTools: ReadonlyArray<string>
}

export const fromCatalog = Effect.fn("providers.fromCatalog")(function* (
  asked: typeof CatalogAdd.Type,
) {
  const p = providerById(asked.provider)

  if (p === undefined) {
    const close = nearIds(asked.provider.toLowerCase())

    return yield* new Refused({
      message: `there's no "${asked.provider.slice(0, 40)}" in OpenBelt's catalog${close.length === 0 ? " (Settings > Connections > Add a connection lists it)" : ` (did you mean ${close.slice(0, 3).join(" or ")}?)`}. A server that isn't listed is added by its URL: bun run workspace connections add <name> <url> --credential none|workspace|person|both (over HTTP, {"name", "url", "credential"}).`,
    })
  }

  const added: FromCatalog = {
    provider: p.id,
    name: asked.name ?? p.id,
    url: asked.url ?? p.url,
    credential: asked.credential ?? (p.signIn === "none" ? "none" : p.credential),
    everyone: asked.everyone ?? p.level,
    readOnlyTools: p.readOnlyTools ?? [],
  }

  const signIn = asked.signIn ?? (p.signIn === "none" ? undefined : p.signIn)

  if (signIn !== undefined) added.signIn = signIn

  const scopes =
    asked.scopes ?? (p.signIn === "oauth" && p.scopes.length > 0 ? p.scopes.join(" ") : undefined)

  if (scopes !== undefined) added.scopes = scopes

  if (asked.authorizeParams !== undefined) added.authorizeParams = asked.authorizeParams

  return added
})
