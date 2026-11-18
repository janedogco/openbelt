import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Effect, Option, Result, Schema } from "effect"
import { applyFixes, BEARER, callApi, readSource } from "../packages/platform/src/apis.ts"
import { Refused } from "../packages/platform/src/model.ts"
import { textOf } from "../packages/platform/src/upstream.ts"
import { howToRegister } from "../packages/platform/src/oauth-client.ts"
import { discover, discoverApi } from "../packages/platform/src/oauth-discovery.ts"
import type { Fetcher } from "../packages/platform/src/oauth-wire.ts"
import type { Provider } from "../packages/platform/src/providers.ts"
import type { Sending } from "../packages/platform/src/outbound.ts"

const PROVIDERS = resolve(import.meta.dir, "../packages/platform/providers")

const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await".split(
    " ",
  ),
)

const FAMILY = "family.json"

export const providerFiles = () => {
  const families = readdirSync(PROVIDERS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted()

  return {
    entries: families.flatMap((family) =>
      readdirSync(join(PROVIDERS, family))
        .filter((f) => f.endsWith(".json") && f !== FAMILY)
        .map((f) => `${family}/${f.slice(0, -".json".length)}`)
        .toSorted(),
    ),
    shared: families.filter((family) => existsSync(join(PROVIDERS, family, FAMILY))),
  }
}

const importName = (path: string) => {
  const camel = path.replace(/[/-]([a-z0-9])/g, (_, c: string) => c.toUpperCase())

  return RESERVED.has(camel) ? `${camel}Provider` : camel
}

export const indexSource = (files: ReturnType<typeof providerFiles>) =>
  `// Every catalog entry, bundled with the Worker, by its path (<family>/<entry>), with what its
// family's family.json says under what it says itself. Written by \`bun run providers index\` from
// the folder: don't edit it (the guard says when it's stale). The format is in README.md;
// src/providers.ts decodes them.
${[
  ...files.shared.map(
    (f) => `import ${importName(`${f}/family`)} from "./${f}/${FAMILY}" with { type: "json" }`,
  ),
  ...files.entries.map((e) => `import ${importName(e)} from "./${e}.json" with { type: "json" }`),
].join("\n")}

export const FILES = {
${files.entries
  .map((e) => {
    const family = e.split("/")[0] ?? ""

    return `  "${e}": ${files.shared.includes(family) ? `{ ...${importName(`${family}/family`)}, ...${importName(e)} }` : importName(e)},`
  })
  .join("\n")}
}
`

export const INDEX = join(PROVIDERS, "index.ts")

const TIMEOUT_MS = 15_000

const PROTOCOL = "2025-06-18"

const ToolList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            annotations: Schema.optional(
              Schema.NullOr(Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) })),
            ),
          }),
        ),
      }),
    }),
  ),
)

type Got = {
  readonly status: number
  readonly text: string
  readonly headers: Headers
}

const get = async (url: string, init: Sending = {}): Promise<Got> => {
  try {
    const r = await fetch(url, {
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body ?? null,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    return { status: r.status, text: await r.text(), headers: r.headers }
  } catch (e) {
    return { status: 0, text: e instanceof Error ? e.message : String(e), headers: new Headers() }
  }
}

type Message = {
  readonly id?: number
  readonly method: string
  readonly params?: Readonly<Record<string, Schema.Json>>
}

const rpc = (url: string, message: Message, session: string | null) => {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
  })

  if (session !== null) headers.set("mcp-session-id", session)

  return get(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  })
}

const payload = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length))
    .at(-1) ?? text

const bare = (url: string) => url.replace(/\/+$/, "")

const ResourceScopes = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      resource: Schema.String,
      scopes_supported: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
)

const fetcher = (answers: Array<string>): Fetcher => ({
  pageProblem: (url) =>
    URL.canParse(url) && new URL(url).protocol === "https:" ? undefined : "isn't https",
  fetch: (name, url, init) =>
    Effect.flatMap(
      Effect.promise(async () => get(url, init)),
      (got) => {
        if (got.status === 0)
          return Effect.fail(
            new Refused({ message: `${name}: ${url} doesn't answer: ${got.text}` }),
          )

        if (got.status === 200) answers.push(got.text)

        return Effect.succeed(got)
      },
    ),
})

const PUBLIC = { allowLocal: false, host: "openbelt.invalid", baseHost: "", ports: [] }

type ApiOf<P> = P extends { readonly api?: infer A } ? NonNullable<A> : never

type ProbedApi = ApiOf<Provider> & { readonly test?: ApiOf<Provider & { signIn: "none" }>["test"] }

const probeApi = async (p: Provider, api: ProbedApi, drift: Array<string>) => {
  const read = await Effect.runPromise(
    Effect.result(
      readSource(
        p.id,
        api.kind,
        api.spec ?? null,
        p.url,
        BEARER,
        undefined,
        PUBLIC,
        api.groups ?? null,
      ),
    ),
  )

  if (Result.isFailure(read)) {
    drift.push(
      `its ${api.kind === "graphql" ? "schema" : "spec"} doesn't read: ${read.failure.message}`,
    )

    return
  }

  const { tools, unused } = applyFixes(read.success.tools, api.fixes ?? [])

  for (const fix of unused) drift.push(`fixes: it has no tool ${fix.tool} anymore`)

  if (api.test === undefined) return

  const test = tools.find((t) => t.name === api.test?.tool)

  if (test === undefined) {
    drift.push(`test: it has no tool ${api.test.tool}`)

    return
  }

  const called = await Effect.runPromise(
    Effect.result(
      callApi(
        p.id,
        test.name,
        p.url,
        read.success.auth ?? BEARER,
        test.binding,
        api.test.input,
        undefined,
        PUBLIC,
      ),
    ),
  )

  if (Result.isFailure(called))
    drift.push(`test: ${test.name} was refused: ${called.failure.message}`)
  else if (called.success.isError === true || !textOf(called.success).includes(api.test.expect))
    drift.push(
      `test: ${test.name}'s answer doesn't have "${api.test.expect}": ${textOf(called.success).replace(/\s+/g, " ").slice(0, 200)}`,
    )
}

const probe = async (p: Provider): Promise<ReadonlyArray<string>> => {
  const drift: Array<string> = []

  const docs = await get(p.docs)

  if (docs.status === 0 || docs.status >= 400)
    drift.push(`its docs link answers ${docs.status === 0 ? docs.text : docs.status}`)

  if (p.signIn === "none" && p.api !== undefined) {
    await probeApi(p, p.api, drift)

    return drift
  }

  // An API people sign in to: its spec reads, and its issuer (where it signs in, as its own
  // metadata says, else as the file says) answers metadata.
  if (p.signIn === "oauth" && p.api !== undefined) {
    await probeApi(p, p.api, drift)

    const at = await Effect.runPromise(
      Effect.result(discoverApi(fetcher([]), p.id, p.url, p.issuer)),
    )

    if (Result.isFailure(at)) drift.push(at.failure.message)
    else if (Option.isNone(at.success)) drift.push(`it names nowhere to sign in`)
    else if (bare(at.success.value.server.issuer) !== bare(p.issuer))
      drift.push(`it signs in at ${at.success.value.server.issuer} now, not ${p.issuer}`)

    return drift
  }

  const answers: Array<string> = []
  const found = await Effect.runPromise(Effect.result(discover(fetcher(answers), p.id, p.url)))

  if (Result.isFailure(found)) return [...drift, found.failure.message]

  if (p.signIn !== "oauth") {
    if (Option.isSome(found.success))
      drift.push(
        `it now signs in with OAuth at ${found.success.value.server.issuer}: it isn't "signIn": "${p.signIn}"`,
      )
    else {
      const init = await initialize(p.url)

      if (init.status === 0) drift.push(`its MCP URL doesn't answer: ${init.text}`)
      else if (p.signIn === "token" && init.status !== 401)
        drift.push(`initialize without a token answers ${init.status}, not 401`)
      else if (p.signIn === "none" && init.status === 401)
        drift.push(`it now asks for a sign-in (401): it isn't "signIn": "none"`)
      else if (p.signIn === "none" && init.status !== 200)
        drift.push(`initialize answers ${init.status}, not 200`)
      else if (p.signIn === "none") await toolDrift(p, init, drift)
    }

    return drift
  }

  if (Option.isNone(found.success))
    return [
      ...drift,
      "it doesn't sign in with OAuth anymore: no Bearer challenge, no protected resource metadata",
    ]

  const { server, resource } = found.success.value

  if (bare(server.issuer) !== bare(p.issuer))
    drift.push(`its authorization server is now ${server.issuer}, not ${p.issuer}`)

  const unreachable = howToRegister(server, false)
  const reachable = howToRegister(server, true)
  const kind = unreachable === "admin" && reachable === "cimd" ? "cimd" : unreachable

  if (kind !== p.registration.kind)
    drift.push(
      kind === "admin"
        ? `no longer advertises dynamic registration (no registration_endpoint) or client metadata documents: "registration" is admin`
        : p.registration.kind === "admin"
          ? `now takes ${kind === "dcr" ? "dynamic registration" : "a client metadata document"}: "registration" could be ${kind}`
          : `"registration" is ${kind} now (registration_endpoint ${server.registration_endpoint === undefined ? "gone" : "advertised"}, client metadata documents ${server.client_id_metadata_document_supported === true ? "taken" : "not taken"})`,
    )

  const listed = answers.flatMap((text) =>
    Option.match(ResourceScopes(text), {
      onNone: () => [],
      onSome: (r) => (bare(r.resource) === bare(resource) ? (r.scopes_supported ?? []) : []),
    }),
  )

  const offered = [...new Set([...listed, ...(server.scopes_supported ?? [])])]

  if (offered.length > 0)
    for (const scope of p.scopes.filter((s) => !offered.includes(s)))
      drift.push(
        `no longer offers the scope ${scope} (it offers ${offered.slice(0, 6).join(" ")}${offered.length > 6 ? " ..." : ""})`,
      )

  const auth = p.quirks?.clientAuth
  const methods = server.token_endpoint_auth_methods_supported

  if (auth !== undefined && methods !== undefined && !methods.includes(auth))
    drift.push(`its quirks say ${auth}, but it lists ${methods.join(", ")}`)

  return drift
}

const initialize = (url: string) =>
  rpc(
    url,
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "openbelt-providers-probe", version: "0" },
      },
    },
    null,
  )

const toolDrift = async (p: Provider, init: Got, drift: Array<string>) => {
  const marked = p.readOnlyTools ?? []

  if (marked.length === 0) return

  const session = init.headers.get("mcp-session-id")

  await rpc(p.url, { method: "notifications/initialized" }, session)

  const listed = ToolList(
    payload((await rpc(p.url, { id: 2, method: "tools/list" }, session)).text),
  )

  if (Option.isNone(listed)) {
    drift.push("tools/list didn't answer a tool list")

    return
  }

  const tools = new Map(listed.value.result.tools.map((t) => [t.name, t]))

  for (const name of marked) {
    const tool = tools.get(name)

    if (tool === undefined) drift.push(`readOnlyTools: it lists no tool ${name} anymore`)
    else if (tool.annotations?.readOnlyHint === true)
      drift.push(`readOnlyTools: it marks ${name} readOnlyHint itself now, so the entry can go`)
  }
}

const stampProbed = (path: string, day: string) => {
  const own = join(PROVIDERS, `${path}.json`)
  const shared = join(PROVIDERS, path.split("/")[0] ?? "", FAMILY)
  const file = readFileSync(own, "utf8").includes('"probed"') ? own : shared

  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(/"probed": "\d{4}-\d{2}-\d{2}"/, `"probed": "${day}"`),
  )
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { write: { type: "boolean" } },
    allowPositionals: true,
  })

  const [command = "", ...ids] = positionals

  if (command === "index") {
    writeFileSync(INDEX, indexSource(providerFiles()))
    console.log(`wrote ${INDEX.replace(`${resolve(PROVIDERS, "../../..")}/`, "")}`)
    process.exit(0)
  }

  const { CATALOG, FILE_NAMES, nearIds, signInLine } =
    await import("../packages/platform/src/providers.ts")

  if (command === "list") {
    for (const p of CATALOG)
      console.log(
        `${p.id.padEnd(16)} ${signInLine(p).padEnd(56)} ${p.signIn === "none" ? "none" : p.credential}, ${p.level}`,
      )
  } else if (command === "probe") {
    const unknown = ids.filter((id) => !CATALOG.some((p) => p.id === id))

    if (unknown.length > 0) {
      for (const id of unknown) {
        const close = nearIds(id.toLowerCase())

        console.error(
          `providers: there's no ${id} in the catalog${close.length === 0 ? "" : ` (did you mean ${close.slice(0, 3).join(" or ")}?)`}; bun run providers list lists them`,
        )
      }

      process.exit(2)
    }

    const chosen = ids.length === 0 ? CATALOG : CATALOG.filter((p) => ids.includes(p.id))
    const results = await Promise.all(chosen.map(async (p) => ({ p, drift: await probe(p) })))
    const today = new Date().toISOString().slice(0, 10)
    let drifted = 0

    for (const { p, drift } of results) {
      if (drift.length === 0) {
        if (values.write === true) stampProbed(FILE_NAMES[CATALOG.indexOf(p)] ?? p.id, today)

        console.log(`✓ ${p.id}${values.write === true ? ` (probed ${today})` : ""}`)
        continue
      }

      drifted += 1

      for (const line of drift.slice(0, 6)) console.log(`✗ ${p.id}: ${line}`)
    }

    console.log(
      drifted === 0
        ? `${results.length} providers match their files${values.write === true ? "" : " (--write sets their probed to today)"}`
        : `${drifted} of ${results.length} providers drifted: fix each file (packages/platform/providers/README.md), then bun run check`,
    )
    process.exit(drifted === 0 ? 0 : 1)
  } else {
    console.error("usage: bun run providers list | index | probe [id ...] [--write]")
    process.exit(2)
  }
}
