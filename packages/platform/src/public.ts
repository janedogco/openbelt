// The public host (OPENBELT_PUBLIC_HOST, a registrable domain of its own, like openbelt.page): a published app for anyone, signed in
// or not, at <app>--<workspace>.<public host>, one label deep so one wildcard certificate covers every app. An app is published by
// its live openbelt.json "public": its files are then public, and of its data and functions only what that names. Here: the names,
// what "public" lets anyone reach, how deploy_app and app_info say so, and the opaque ids members' emails become there.
import { createHmac } from "node:crypto"
import * as Config from "effect/Config"
import {
  ANONYMOUS,
  type AppConfig,
  contractOf,
  type Doc,
  type PublicBlock,
  type PublicOp,
  type RunAuthority,
  secretsOf,
  TRIGGERS,
} from "./model.ts"
import { matchKey } from "./rules.ts"
import { APP_SEPARATOR } from "./hosts.ts"

/** The public apps' registrable domain (openbelt.page); empty: none, nothing is public. gateway.ts refuses one beside the other hosts. */
export const PUBLIC_HOST = Config.String("OPENBELT_PUBLIC_HOST").pipe(
  Config.withDefault(""),
  Config.map((given) => given.trim().toLowerCase()),
)

/** The same label as the app's host on the workspace's host (hosts.ts): neither name holds "--". */
const SEPARATOR = APP_SEPARATOR

/** Who an app's object answers: someone on the workspace host (signed in or not), or anyone on the public host. */
export type Audience = "workspace" | "public"

/** What the gateway says about each request it sends an app's object (it removes any a client sent); anything but "workspace" is public. */
export const AUDIENCE_HEADER = "x-openbelt-audience"

/** The client's address the gateway counts a public request by (as its per-address limit does); absent: one straight to this machine's port. */
export const ADDRESS_HEADER = "x-openbelt-address"

export const audienceOf = (said: string | undefined): Audience =>
  said === "workspace" ? "workspace" : "public"

export const publicLabel = (app: string, workspace: string) => `${app}${SEPARATOR}${workspace}`

/** A published app's page, on the scheme and port its workspace's host is served on. */
export const publicUrl = (
  workspaceOrigin: string,
  app: string,
  workspace: string,
  host: string,
) => {
  const origin = new URL(workspaceOrigin)

  return `${origin.protocol}//${publicLabel(app, workspace)}.${host}${origin.port === "" ? "" : `:${origin.port}`}/`
}

/** The one label under the public host, as `<app>--<workspace>`: anything else (no "--", a dot, either side empty) is no app. */
export const publicNameOf = (label: string) => {
  const split = label.lastIndexOf(SEPARATOR)

  if (label.includes(".") || split <= 0 || split + SEPARATOR.length >= label.length)
    return undefined

  return { app: label.slice(0, split), workspace: label.slice(split + SEPARATOR.length) }
}

/** Whether openbelt.json "public" lets anyone `op` in `collection` (the collection's rules judge it too). */
export const exposes = (block: PublicBlock, collection: string, op: PublicOp) => {
  const collections = block.collections ?? {}

  return Object.hasOwn(collections, collection) && (collections[collection] ?? []).includes(op)
}

/** A function anyone may call on the public host, with the secrets and connections it may use there; undefined: not there. */
export const publicFunction = (block: PublicBlock, fn: string) => {
  const functions = block.functions ?? {}

  return Object.hasOwn(functions, fn) ? functions[fn] : undefined
}

/**
 * What a run anyone started on the public host may use as it starts: what it carried, and only as much of that as the live "public"
 * block grants its function now. Unpublished, or the function no longer listed: no secrets and no connections.
 */
export const grantedNow = (
  carried: Extract<RunAuthority, { readonly kind: "public" }>,
  block: PublicBlock | undefined,
): RunAuthority => {
  const granted =
    carried.fn === null || block === undefined ? undefined : publicFunction(block, carried.fn)

  return {
    ...carried,
    secrets: carried.secrets.filter((secret) => granted?.secrets.includes(secret) === true),
    uses: carried.uses.filter((connection) => granted?.uses.includes(connection) === true),
  }
}

const listOrNone = (names: ReadonlyArray<string>) =>
  names.length === 0 ? "none" : names.join(", ")

/** What anyone on the public host reaches, line by line, as deploy_app and app_info say it. */
export const reachesOf = (block: PublicBlock) => [
  "every file of the app (its pages, scripts, images), except openbelt.json, skills/ and functions/",
  ...Object.entries(block.collections ?? {}).map(
    ([collection, ops]) =>
      `collection ${collection}: ${ops.join(", ")} (each also judged by its rules, for nobody signed in)`,
  ),
  ...Object.entries(block.functions ?? {}).map(
    ([fn, reach]) =>
      `function ${fn} (caller null): secrets ${listOrNone(reach.secrets)}; connections ${listOrNone(reach.uses)}`,
  ),
]

const collectionKnown = (config: AppConfig, collection: string) =>
  matchKey(config.collections ?? {}, collection) !== undefined ||
  matchKey(config.rules ?? {}, collection) !== undefined

/** What a deploy is refused for in openbelt.json "public": a name it lists that the app doesn't have. */
export const publicProblems = (config: AppConfig) => {
  const block = config.public

  if (block === undefined) return []

  const problems: Array<string> = []
  const secrets = secretsOf(config)

  for (const collection of Object.keys(block.collections ?? {}))
    if (!collectionKnown(config, collection))
      problems.push(
        `openbelt.json "public".collections names ${collection}, which isn't one of the app's collections: describe it in "collections" (or give it "rules"), or take it out of "public"`,
      )

  for (const [fn, reach] of Object.entries(block.functions ?? {})) {
    const contract = contractOf(config, fn)

    if (contract === undefined) {
      problems.push(
        `openbelt.json "public".functions names ${fn}, which isn't one of its functions (${listOrNone(Object.keys(config.functions ?? {}))}): list it under "functions", or take it out of "public"`,
      )
      continue
    }

    if (contract.internal)
      problems.push(
        `openbelt.json "public".functions names ${fn}, which is internal (only the app's own code runs it): take it out of "public", or drop "internal"`,
      )

    for (const secret of reach.secrets)
      if (!secrets.has(secret))
        problems.push(
          `openbelt.json "public".functions.${fn}.secrets names ${secret}, which isn't one of the app's secrets (${listOrNone([...secrets.keys()])}): declare it in "secrets", or take it out`,
        )

    for (const connection of reach.uses)
      if (!Object.hasOwn(config.uses ?? {}, connection))
        problems.push(
          `openbelt.json "public".functions.${fn}.uses names ${connection}, which "uses" doesn't list (${listOrNone(Object.keys(config.uses ?? {}))}): add it to "uses", or take it out`,
        )
  }

  return problems
}

const NOT_PEOPLE: ReadonlySet<string> = new Set([ANONYMOUS.author, ...TRIGGERS])

/**
 * A document as anyone on the public host sees it: who wrote it is a stable opaque id per workspace and app (an HMAC of their email
 * with the platform's key), never the email, and their name is "a member". Visitors' own writes stay "anonymous"; what a document's
 * data holds is shown as it is.
 */
export const maskedFor = (key: string, workspace: string, app: string) => {
  const mask = (who: string) =>
    NOT_PEOPLE.has(who)
      ? who
      : `member-${createHmac("sha256", key).update(`public-author\n${workspace}\n${app}\n${who}`).digest("hex").slice(0, 16)}`

  return <D extends Doc>(doc: D): D => ({
    ...doc,
    author: mask(doc.author),
    authorName: NOT_PEOPLE.has(doc.author) ? doc.authorName : "a member",
    updatedBy: mask(doc.updatedBy),
  })
}
