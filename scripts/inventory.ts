import { Option, Schema } from "effect"
import { Inventory } from "../packages/platform/src/model.ts"

const decodeInventory = Schema.decodeUnknownOption(Schema.fromJsonString(Inventory))

export const inventoryOf = async (url: string, admin: string) => {
  const response = await fetch(`${url}/_admin/inventory`, {
    headers: { authorization: `Bearer ${admin}` },
  }).catch(() => undefined)

  return response?.ok === true ? decodeInventory(await response.text()) : Option.none<Inventory>()
}

const HELD_IN = {
  app: ["WorkspaceDO", "apps", "AppDO", "versions", "blobs"],
  documents: ["AppDO", "docs_*"],
  environment: ["WorkspaceDO", "environments", "environment_apps"],
  tokens: ["WorkspaceDO", "tokens", "api_tokens", "people"],
} as const

export type Loss = { readonly kind: keyof typeof HELD_IN; readonly what: string }

export const lostBetween = (before: Inventory, after: Inventory, minted = 0) => {
  const lost: Array<Loss> = []

  for (const app of before.apps) {
    const found = after.apps.find((a) => a.app === app.app)

    if (found === undefined) lost.push({ kind: "app", what: `the app ${app.app}` })
    else if (found.version !== app.version)
      lost.push({
        kind: "app",
        what: `${app.app}'s live version (${app.version} before, ${found.version} after)`,
      })
    else if (found.docs < app.docs)
      lost.push({
        kind: "documents",
        what: `${app.docs - found.docs} of ${app.app}'s ${app.docs} documents`,
      })
    else if (app.version !== null && found.serves === false)
      lost.push({ kind: "app", what: `${app.app}'s live files (they no longer read back)` })
  }

  for (const env of before.environments)
    if (!after.environments.includes(env))
      lost.push({ kind: "environment", what: `the preview environment ${env}` })

  const gone = before.tokens + minted - after.tokens

  if (gone > 0) lost.push({ kind: "tokens", what: `${gone} API token${gone === 1 ? "" : "s"}` })

  return lost
}

export const unexcused = (
  lost: ReadonlyArray<Loss>,
  drops: ReadonlyArray<{ readonly name: string }>,
) => lost.filter((l) => !drops.some((d) => HELD_IN[l.kind].some((name) => name === d.name)))

export const described = (lost: ReadonlyArray<Loss>) =>
  [...new Set(lost.map((l) => l.what))].join(", ")

const Storage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      dropped: Schema.Array(Schema.Struct({ name: Schema.String, why: Schema.String })),
    }),
  ),
)

const droppedIn = (text: string | undefined) =>
  text === undefined
    ? []
    : Option.match(Storage(text), { onNone: () => [], onSome: (s) => s.dropped })

const usedAt = (repo: string, commit: string, name: string) =>
  Bun.spawnSync(
    [
      "git",
      "grep",
      "-q",
      "-E",
      "-e",
      `"${name}"`,
      "-e",
      `EXISTS ${name} `,
      commit,
      "--",
      "packages/platform/src",
    ],
    { cwd: repo, stdin: "ignore" },
  ).exitCode === 0

export const droppedSince = (repo: string, from: string, to: string | undefined) => {
  const had = new Set(
    droppedIn(fileAt(repo, from, "packages/platform/storage.json")).map((d) => d.name),
  )

  return droppedIn(to).filter((d) => !had.has(d.name) && usedAt(repo, from, d.name))
}

const sourcesSaying = (repo: string, commit: string, text: string) => {
  const git = (...args: ReadonlyArray<string>) =>
    Bun.spawnSync(["git", ...args], { cwd: repo, stdin: "ignore" }).stdout.toString()

  return git("grep", "-l", "-F", text, commit, "--", "packages/platform/src")
    .split("\n")
    .filter((line) => line !== "")
    .map((found) =>
      git("show", found)
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        .replaceAll(/\/\/.*$/gm, ""),
    )
}

export const callbacksAt = (repo: string, commit: string) => {
  const names = (text: string, pattern: RegExp) =>
    sourcesSaying(repo, commit, text).flatMap((source) =>
      [...source.matchAll(pattern)].map((m) => m[1] ?? ""),
    )

  const books = new Set(names("makeCallback(", /makeCallback\(\s*"(\w+)"/g))

  return {
    books,
    handles: new Set([...books, ...names("drain(", /\bdrain\("(\w+)", "(?:drop|hold)"\)/g)]),
  }
}

export const callbacksLostGoing = (repo: string, from: string, to: string) => {
  const { handles } = callbacksAt(repo, to)

  return [...callbacksAt(repo, from).books].filter((name) => !handles.has(name)).toSorted()
}

export const fileAt = (repo: string, commit: string, path: string) => {
  const shown = Bun.spawnSync(["git", "show", `${commit}:${path}`], { cwd: repo, stdin: "ignore" })

  return shown.exitCode === 0 ? shown.stdout.toString() : undefined
}
