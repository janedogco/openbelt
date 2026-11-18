// The workspace's directory of its apps: what the home page and search show of each, kept in the workspace's own storage (WorkspaceDO, beside
// its `apps` table) so none of them wakes every app. A workspace with 20,000 apps had its home page wake all 20,000 (cards fetched 8 at a
// time: 76 s for 200 apps, cold) and every search do the same. Each app sends its entry when a version goes live, a picture is taken
// or a new collection appears (app.ts `list`); one with no entry yet (deployed before the directory) is asked for it by `fill`.
// Search ranks from an index of each app's words (rankWeighted), reading only the apps that hold one.
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type Needs, queryWords, rankWeighted, type Weight, wordsIn } from "./words.ts"

/** What an app sends the workspace about itself. */
const DirectoryEntry = Schema.Struct({
  /** When its live version went live; null while it is only in preview environments. */
  updated: Schema.NullOr(Schema.String),
  /** When its picture for the home page was taken; null while it has none. */
  shot: Schema.NullOr(Schema.String),
  /** The colour it gave itself (openbelt.json, its theme-color, its picture's): its gallery card's. Null when only its name gives one;
   * absent from an app on a build before it. */
  color: Schema.optionalKey(
    Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9a-f]{6}$/)))),
  ),
  /** The connection tools its live version calls (`connection.tool`, or `connection.*` for one it uses whole). */
  tools: Schema.Array(Schema.String),
  functions: Schema.Array(Schema.Struct({ name: Schema.String, about: Schema.String })),
  collections: Schema.Array(
    Schema.Struct({ name: Schema.String, about: Schema.NullOr(Schema.String) }),
  ),
  /** Its own skills (skills/<name>/SKILL.md): absent from an app on a build before skills. */
  skills: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, about: Schema.String })),
  ),
})

export type DirectoryEntry = typeof DirectoryEntry.Type

const Fields = Schema.fromJsonString(
  Schema.Struct({
    functions: DirectoryEntry.fields.functions,
    collections: DirectoryEntry.fields.collections,
    skills: DirectoryEntry.fields.skills,
  }),
)

const decodeFields = Schema.decodeUnknownSync(Fields)

/** An app as the directory lists it: its record (the `apps` table) and its entry, when it has sent one. */
export type Listed = {
  readonly name: string
  readonly id: string
  readonly owner: string
  readonly created: string
  readonly description: string
  readonly updated: string | null
  readonly shot: string | null
  /** The colour it gave itself, or null for one from its name (colors.ts). */
  readonly color: string | null
  /** Whether the app has sent its entry: until then, only its record is known. */
  readonly entered: boolean
}

type Row = {
  name: string
  id: string
  owner: string
  created: string
  description: string
  updated: string | null
  shot: string | null
  color: string | null
  fields: string | null
}

const LISTED = `SELECT a.name, a.id, a.owner, a.created, a.description, d.updated, d.shot, d.color, d.fields
  FROM apps a LEFT JOIN directory d ON d.app_id = a.id`

const listedOf = (row: Row): Listed => ({
  name: row.name,
  id: row.id,
  owner: row.owner,
  created: row.created,
  description: row.description,
  updated: row.updated,
  shot: row.shot,
  color: row.color,
  entered: row.fields !== null,
})

export type Sort = "updated" | "created" | "name"

const ORDER: Record<Sort, string> = {
  updated: "d.updated IS NULL, d.updated DESC, a.name",
  created: "a.created DESC, a.name",
  name: "a.name",
}

/** A page of the home page's apps: those matching `q` (in a name, description or owner), in `sort` order. */
export type PageAsk = {
  readonly q: string
  readonly sort: Sort
  readonly offset: number
  readonly limit: number
  /** Only the apps this person (their user id) made. */
  readonly owner?: string
  /** Only these apps, by name (an agent limited to some apps); absent or null for every app. */
  readonly only?: ReadonlyArray<string> | null
}

/** The words an app is found by, each with how much the app holds it (rankWeighted's weights). */
const wordsOf = (name: string, description: string, fields: typeof Fields.Type | undefined) => {
  const words = new Map<string, Weight>()

  const hold = (text: string, weight: Weight) => {
    for (const w of wordsIn(text)) if ((words.get(w) ?? 0) < weight) words.set(w, weight)
  }

  hold(`${name} ${description}`, 3)

  for (const field of [
    ...(fields?.functions ?? []),
    ...(fields?.collections ?? []),
    ...(fields?.skills ?? []),
  ]) {
    hold(field.name, 2)
    hold((field.about ?? "").split("\n")[0] ?? "", 1)
  }

  return words
}

/** What an app's words were indexed from, in TypeScript and in SQL (`unindexed` compares the two). */
const indexedText = (app: { readonly name: string; readonly description: string }) =>
  `${app.name}\n${app.description}`

const INDEXED_SQL = "a.name || char(10) || a.description"

/** How long Jump back in remembers an open: as long as the app's own usage keeps a person's (usage.ts). */
const OPENS_KEPT_DAYS = 90

/** How many people use an app for it to rank as high as popularity takes it. */
const BOOST_PEOPLE = 10

const likeOf = (q: string) => `%${q.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`

export const openDirectory = Effect.fn("Directory.open")(function* (storage: DurableObjectStorage) {
  const { sql } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS directory (
    app_id TEXT PRIMARY KEY, updated TEXT, shot TEXT, fields TEXT NOT NULL,
    tools TEXT NOT NULL)`)

  const columns = yield* (yield* sql.exec<{ name: string }>(
    "SELECT name FROM pragma_table_info('directory')",
  )).toArray()

  if (columns.some((column) => column.name === "tags"))
    yield* sql.exec("ALTER TABLE directory DROP COLUMN tags")

  if (!columns.some((column) => column.name === "color"))
    yield* sql.exec("ALTER TABLE directory ADD COLUMN color TEXT")

  yield* sql.exec("CREATE INDEX IF NOT EXISTS directory_updated ON directory (updated)")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS app_words (
    word TEXT NOT NULL, app_id TEXT NOT NULL, weight INTEGER NOT NULL, PRIMARY KEY (word, app_id))`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS app_words_app ON app_words (app_id)")
  // The name and description each app's words were indexed from. A build without this table (a rollback) changes a description
  // without indexing it again, and one before the directory makes apps it never indexes: either way the two differ, and `fill`
  // indexes the app again from the workspace's own table, waking none.
  yield* sql.exec(
    `CREATE TABLE IF NOT EXISTS app_indexed (app_id TEXT PRIMARY KEY, text TEXT NOT NULL)`,
  )
  // Who has run each app's functions from an agent (call_function, execute): search ranks the apps you use, and the ones many
  // people use, above the rest that match as well.
  // Your own apps (skills/list, search's boost) without reading every app.
  yield* sql.exec("CREATE INDEX IF NOT EXISTS apps_owner ON apps (owner)")
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS app_users (
    app_id TEXT NOT NULL, person TEXT NOT NULL, first TEXT NOT NULL, PRIMARY KEY (app_id, person))`)

  // When each person last opened each app's pages (usage.ts counts them in the app; the app sends the time here): the home page's
  // Jump back in reads a person's newest without waking any app. Kept OPENS_KEPT_DAYS, as the app keeps its own.
  yield* sql.exec(`CREATE TABLE IF NOT EXISTS app_opens (
    person TEXT NOT NULL, app_id TEXT NOT NULL, last TEXT NOT NULL, PRIMARY KEY (person, app_id)) WITHOUT ROWID`)
  yield* sql.exec("CREATE INDEX IF NOT EXISTS app_opens_last ON app_opens (person, last)")

  const rows = Effect.fnUntraced(function* (where: string, ...bindings: ReadonlyArray<unknown>) {
    return yield* (yield* sql.exec<Row>(`${LISTED} ${where}`, ...bindings)).toArray()
  })

  /** How much more each app holding one of `words` counts for `who`: twice when theirs, up to twice more when many use it. */
  const boostsOf = Effect.fnUntraced(function* (
    words: ReadonlyArray<string>,
    who: { readonly owner: string; readonly person: string },
  ) {
    const holds = `SELECT app_id FROM app_words WHERE word IN (${words.map(() => "?").join(", ")})`

    const used = yield* (yield* sql.exec<{ app_id: string; people: number; mine: number }>(
      `SELECT app_id, COUNT(*) AS people, MAX(person = ?) AS mine FROM app_users
       WHERE app_id IN (${holds}) GROUP BY app_id`,
      who.person,
      ...words,
    )).toArray()

    const owned = yield* (yield* sql.exec<{ id: string }>(
      `SELECT id FROM apps WHERE owner = ? AND id IN (${holds})`,
      who.owner,
      ...words,
    )).toArray()

    const people = new Map(used.map((u) => [u.app_id, u.people] as const))
    const made = new Set(owned.map((o) => o.id))
    const ran = new Set(used.filter((u) => u.mine === 1).map((u) => u.app_id))

    return new Map(
      [...new Set([...people.keys(), ...made])].map((id) => {
        const n = people.get(id) ?? 0
        const others = n - (ran.has(id) ? 1 : 0)

        const uses = [
          made.has(id) ? "you made it" : ran.has(id) ? "you use it" : "",
          others > 0
            ? `${others} ${ran.has(id) ? "other " : ""}${others === 1 ? "person uses" : "people use"} it`
            : "",
        ]
          .filter((u) => u !== "")
          .join("; ")

        return [
          id,
          {
            boost:
              1 +
              (made.has(id) || ran.has(id) ? 1 : 0) +
              Math.min(1, Math.log2(1 + n) / Math.log2(1 + BOOST_PEOPLE)),
            uses,
          },
        ] as const
      }),
    )
  })

  /** Index the app's words again, from its record and its entry: after either changes. */
  const reindex = Effect.fn("Directory.reindex")(function* (appId: string) {
    const [row] = yield* rows("WHERE a.id = ?", appId)

    yield* sql.exec("DELETE FROM app_words WHERE app_id = ?", appId)

    if (row === undefined) {
      yield* sql.exec("DELETE FROM app_indexed WHERE app_id = ?", appId)
      yield* sql.exec("DELETE FROM app_users WHERE app_id = ?", appId)
      yield* sql.exec("DELETE FROM app_opens WHERE app_id = ?", appId)

      return
    }

    yield* sql.exec(
      `INSERT INTO app_indexed (app_id, text) VALUES (?, ?) ON CONFLICT (app_id) DO UPDATE SET text = excluded.text`,
      appId,
      indexedText(row),
    )

    const found = [
      ...wordsOf(
        row.name,
        row.description,
        row.fields === null ? undefined : decodeFields(row.fields),
      ),
    ]

    // An app with no words to find it by still gets a row (the empty word, which no search asks for): builds before app_indexed
    // take an app with no row as never indexed, and would index it again and again.
    const words: ReadonlyArray<readonly [string, Weight]> = found.length === 0 ? [["", 0]] : found

    yield* sql.exec(
      `INSERT INTO app_words (word, app_id, weight) VALUES ${words.map(() => "(?, ?, ?)").join(", ")}`,
      ...words.flatMap(([word, weight]) => [word, appId, weight]),
    )
  })

  const put = Effect.fn("Directory.put")(function* (appId: string, entry: DirectoryEntry) {
    yield* sql.exec(
      `INSERT INTO directory (app_id, updated, shot, color, fields, tools) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET updated = excluded.updated, shot = excluded.shot,
         color = excluded.color, fields = excluded.fields, tools = excluded.tools`,
      appId,
      entry.updated,
      entry.shot,
      entry.color ?? null,
      JSON.stringify({
        functions: entry.functions,
        collections: entry.collections,
        skills: entry.skills ?? [],
      }),
      JSON.stringify(entry.tools),
    )
    yield* reindex(appId)
  })

  return {
    put,
    reindex,

    /** That `person` ran one of the app's functions: once per app and person is enough. */
    used: Effect.fn("Directory.used")(function* (app: string, person: string) {
      yield* sql.exec(
        `INSERT OR IGNORE INTO app_users (app_id, person, first) SELECT id, ?, ? FROM apps WHERE name = ?`,
        person,
        new Date().toISOString(),
        app,
      )
    }),

    /** That `person` (an email) opened one of the app's pages at `at` (ISO); a later time than the one kept replaces it. */
    opened: Effect.fn("Directory.opened")(function* (appId: string, person: string, at: string) {
      yield* sql.exec(
        `INSERT INTO app_opens (person, app_id, last) SELECT ?, id, ? FROM apps WHERE id = ?
         ON CONFLICT (person, app_id) DO UPDATE SET last = MAX(last, excluded.last)`,
        person,
        at,
        appId,
      )
      yield* sql.exec(
        "DELETE FROM app_opens WHERE last < ?",
        new Date(Date.now() - OPENS_KEPT_DAYS * 86_400_000).toISOString(),
      )
    }),

    /** The `limit` apps `person` opened last, newest first, each with when: the home page's Jump back in. */
    openedBy: Effect.fn("Directory.openedBy")(function* (person: string, limit: number) {
      const found = yield* (yield* sql.exec<Row & { opened: string }>(
        `SELECT a.name, a.id, a.owner, a.created, a.description, d.updated, d.shot, d.color, d.fields, o.last AS opened
         FROM app_opens o JOIN apps a ON a.id = o.app_id LEFT JOIN directory d ON d.app_id = a.id
         WHERE o.person = ? AND o.last >= ? ORDER BY o.last DESC LIMIT ?`,
        person,
        new Date(Date.now() - OPENS_KEPT_DAYS * 86_400_000).toISOString(),
        limit,
      )).toArray()

      return found.map((row) => ({ app: listedOf(row), opened: row.opened }))
    }),

    /** Up to `limit` apps whose words aren't indexed from their name and description as they are now. */
    unindexed: Effect.fnUntraced(function* (limit: number) {
      return (yield* (yield* sql.exec<{ id: string }>(
        `SELECT a.id FROM apps a LEFT JOIN app_indexed i ON i.app_id = a.id
         WHERE i.text IS NULL OR i.text != ${INDEXED_SQL} LIMIT ?`,
        limit,
      )).toArray()).map((r) => r.id)
    }),

    /** Up to `limit` apps that haven't sent an entry yet. */
    unentered: Effect.fnUntraced(function* (limit: number) {
      return (yield* (yield* sql.exec<{ id: string }>(
        "SELECT a.id FROM apps a LEFT JOIN directory d ON d.app_id = a.id WHERE d.app_id IS NULL LIMIT ?",
        limit,
      )).toArray()).map((r) => r.id)
    }),

    page: Effect.fn("Directory.page")(function* (ask: PageAsk) {
      const like = likeOf(ask.q.trim())

      const where = `WHERE (? = '' OR a.name LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\' OR a.owner LIKE ? ESCAPE '\\') AND (? = '' OR a.owner = ?)
        AND (? IS NULL OR a.name IN (SELECT value FROM json_each(?)))`

      const only = ask.only === undefined || ask.only === null ? null : JSON.stringify(ask.only)

      const bindings = [
        ask.q.trim(),
        like,
        like,
        like,
        ask.owner ?? "",
        ask.owner ?? "",
        only,
        only,
      ]

      const [counted] = yield* (yield* sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM apps a ${where}`,
        ...bindings,
      )).toArray()

      const shown = yield* rows(
        `${where} ORDER BY ${ORDER[ask.sort]} LIMIT ? OFFSET ?`,
        ...bindings,
        ask.limit,
        ask.offset,
      )

      return { apps: shown.map(listedOf), total: counted?.n ?? 0 }
    }),

    /** A page of the apps that have skills of their own (skills/<name>/), by name: skills/list wakes only these. */
    skilled: Effect.fn("Directory.skilled")(function* (
      offset: number,
      limit: number,
      only?: ReadonlyArray<string>,
    ) {
      const within = only === undefined ? null : JSON.stringify(only)

      return (yield* rows(
        "WHERE json_array_length(d.fields, '$.skills') > 0 AND (? IS NULL OR a.name IN (SELECT value FROM json_each(?))) ORDER BY a.name LIMIT ? OFFSET ?",
        within,
        within,
        limit,
        offset,
      )).map(listedOf)
    }),

    /** Which apps call each connection tool, by name. */
    bindings: Effect.fn("Directory.bindings")(function* () {
      const calls = yield* (yield* sql.exec<{ name: string; tool: string }>(
        `SELECT a.name, t.value AS tool FROM apps a JOIN directory d ON d.app_id = a.id, json_each(d.tools) t
         ORDER BY a.name`,
      )).toArray()

      const bound: Record<string, Array<string>> = {}

      for (const { name, tool } of calls) bound[tool] = [...(bound[tool] ?? []), name]

      return bound
    }),

    /** The `limit` apps updated most recently, since `since` (ISO): the home page's shelf. */
    recent: Effect.fn("Directory.recent")(function* (limit: number, since: string) {
      return (yield* rows(
        `WHERE d.updated >= ? ORDER BY d.updated DESC LIMIT ?`,
        since,
        limit,
      )).map(listedOf)
    }),

    /** One app as the directory lists it, or null when there's no such app. */
    listed: Effect.fn("Directory.listed")(function* (appId: string) {
      const [row] = yield* rows("WHERE a.id = ?", appId)

      return row === undefined ? null : listedOf(row)
    }),

    /** The `limit` newest apps `owner` made. */
    ownedBy: Effect.fn("Directory.ownedBy")(function* (owner: string, limit: number) {
      return (yield* rows("WHERE a.owner = ? ORDER BY a.created DESC LIMIT ?", owner, limit)).map(
        listedOf,
      )
    }),

    /**
     * The few apps best matching `query`, best first: those with a rare word for the search tool, those with
     * any for code mode's workspace.search (a function many apps have, like send, still finds some). Given `who`, an app that is theirs
     * (they made it or use it) scores twice, and one many people use up to twice more (BOOST_PEOPLE or more): in a workspace of 100,000
     * apps, the expenses app everyone uses outranks the dozens of look-alikes that hold the same words.
     */
    find: Effect.fn("Directory.find")(function* (
      query: string,
      limit: number,
      needs: Needs = "rare",
      who?: { readonly owner: string; readonly person: string },
    ) {
      const words = queryWords(query)

      if (words.length === 0) return []

      const held = yield* (yield* sql.exec<{ word: string; app_id: string; weight: Weight }>(
        `SELECT word, app_id, weight FROM app_words WHERE word IN (${words.map(() => "?").join(", ")})`,
        ...words,
      )).toArray()

      const [counted] = yield* (yield* sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM apps",
      )).toArray()

      const holding = new Map<string, number>()
      const byApp = new Map<string, Map<string, Weight>>()

      for (const { word, app_id, weight } of held) {
        holding.set(word, (holding.get(word) ?? 0) + 1)
        byApp.set(app_id, (byApp.get(app_id) ?? new Map<string, Weight>()).set(word, weight))
      }

      const boosts =
        who === undefined
          ? new Map<string, { readonly boost: number; readonly uses: string }>()
          : yield* boostsOf(words, who)

      const best = rankWeighted(
        [...byApp].map(([id, has]) => ({
          item: id,
          weight: (w: string) => has.get(w) ?? 0,
          boost: boosts.get(id)?.boost ?? 1,
        })),
        words,
        (w) => holding.get(w) ?? 0,
        counted?.n ?? 0,
        limit,
        needs,
      ).map((m) => m.item)

      if (best.length === 0) return []

      const found = new Map(
        (yield* rows(`WHERE a.id IN (${best.map(() => "?").join(", ")})`, ...best)).map((r) => [
          r.id,
          listedOf(r),
        ]),
      )

      return best.flatMap((id) => {
        const app = found.get(id)

        return app === undefined ? [] : [{ ...app, uses: boosts.get(id)?.uses ?? null }]
      })
    }),
  }
})
