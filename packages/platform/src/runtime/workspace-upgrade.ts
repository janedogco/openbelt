import { Database } from "bun:sqlite"
import { existsSync, readdirSync, renameSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { sealing } from "../upstream.ts"
import { objectFileId } from "./object-id.ts"

export const assertWorkspaceSettings = (settings: Readonly<Record<string, string | undefined>>) => {
  for (const key of Object.keys(settings))
    if (/^OPENBELT_.*_ORG(?:_|$)/.test(key) && settings[key] !== undefined)
      throw new Error(
        `Rename ${key} to ${key.replace(/_ORG(?=_|$)/, "_WORKSPACE")} before starting this release`,
      )
}

const Rows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.String, sql: Schema.NullOr(Schema.String) })),
)

const Columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))

const Cells = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ k: Schema.String, v: Schema.String })),
)

const Credentials = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      connection: Schema.String,
      sealed: Schema.String,
      refresh: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
)

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

const renamed = (name: string) =>
  name.replaceAll(/(^|_)orgs(?=_|$)/g, "$1workspaces").replaceAll(/(^|_)org(?=_|$)/g, "$1workspace")

const tablesOf = (db: Database) =>
  Rows(db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all())

const has = (db: Database, table: string) => tablesOf(db).some((t) => t.name === table)

const columnsOf = (db: Database, table: string) =>
  Columns(db.query(`PRAGMA table_info(${quote(table)})`).all()).map((c) => c.name)

const resealCredentials = async (db: Database, master: string) => {
  if (!has(db, "connection_credentials")) return

  const refresh = columnsOf(db, "connection_credentials").includes("refresh")

  const rows = Credentials(
    db
      .query(
        `SELECT connection, sealed${refresh ? ", refresh" : ""} FROM connection_credentials WHERE owner = 'org'`,
      )
      .all(),
  )

  if (rows.length === 0) return

  if (master === "") throw new Error("Set OPENBELT_SECRETS_KEY to migrate workspace credentials")

  const sealer = await Effect.runPromise(sealing(master))

  for (const row of rows) {
    const oldKey = `${row.connection}\u0000org`
    const newKey = `${row.connection}\u0000workspace`
    const access = await Effect.runPromise(sealer.open(row.sealed, oldKey))

    const renewal =
      row.refresh == null
        ? null
        : await Effect.runPromise(sealer.open(row.refresh, `${oldKey}\u0000refresh`))

    if (access === undefined || renewal === undefined)
      throw new Error(
        `Cannot decrypt ${row.connection}'s shared credential; restore OPENBELT_SECRETS_KEY before upgrading`,
      )

    const sealed = await Effect.runPromise(sealer.seal(access, newKey))

    const nextRefresh =
      renewal === null
        ? null
        : await Effect.runPromise(sealer.seal(renewal, `${newKey}\u0000refresh`))

    if (refresh)
      db.query(
        "UPDATE connection_credentials SET sealed = ?, refresh = ?, owner = 'workspace' WHERE connection = ? AND owner = 'org'",
      ).run(sealed, nextRefresh, row.connection)
    else
      db.query(
        "UPDATE connection_credentials SET sealed = ?, owner = 'workspace' WHERE connection = ? AND owner = 'org'",
      ).run(sealed, row.connection)
  }
}

const migrateTables = (db: Database) => {
  for (const table of tablesOf(db)) {
    if (table.name.startsWith("docs_") || table.name.startsWith("aggregate_")) continue

    const next = renamed(table.name)

    if (next !== table.name) db.exec(`ALTER TABLE ${quote(table.name)} RENAME TO ${quote(next)}`)

    for (const column of columnsOf(db, next)) {
      const nextColumn = renamed(column)

      if (nextColumn !== column)
        db.exec(`ALTER TABLE ${quote(next)} RENAME COLUMN ${quote(column)} TO ${quote(nextColumn)}`)
    }
  }

  const indexes = Rows(
    db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all(),
  )

  for (const index of indexes) {
    if (index.sql === null || renamed(index.name) === index.name) continue

    db.exec(`DROP INDEX ${quote(index.name)}`)
    db.exec(index.sql.replace(index.name, renamed(index.name)))
  }

  const connections = tablesOf(db).find((t) => t.name === "connections")

  if (connections?.sql?.includes("'org'") === true) {
    const cols = columnsOf(db, "connections")

    const sql = connections.sql
      .replace(
        /CREATE TABLE\s+(?:"connections"|connections)/i,
        'CREATE TABLE "__workspace_connections"',
      )
      .replaceAll("'org'", "'workspace'")

    db.exec(sql)
    db.exec(
      `INSERT INTO __workspace_connections (${cols.map(quote).join(", ")}) SELECT ${cols.map((c) => (c === "credential" ? "CASE credential WHEN 'org' THEN 'workspace' ELSE credential END" : quote(c))).join(", ")} FROM connections`,
    )
    db.exec("DROP TABLE connections")
    db.exec("ALTER TABLE __workspace_connections RENAME TO connections")
  }

  for (const [table, column] of [
    ["connection_signins", "owner"],
    ["connection_calls", "runs_as"],
  ] as const)
    if (has(db, table))
      db.query(
        `UPDATE ${quote(table)} SET ${quote(column)} = 'workspace' WHERE ${quote(column)} = 'org'`,
      ).run()

  if (has(db, "__kv")) {
    db.query("DELETE FROM __kv WHERE k = 'skill:app'").run()

    for (const cell of Cells(db.query("SELECT k, v FROM __kv").all())) {
      const key =
        cell.k === "orgName" ? "workspaceName" : cell.k.replace(/^org(?=$|[-:])/, "workspace")

      if (key !== cell.k) db.query("UPDATE __kv SET k = ? WHERE k = ?").run(key, cell.k)
    }
  }

  if (has(db, "wakes")) {
    db.exec(
      "UPDATE wakes SET cls = 'WorkspaceDO', key = 'WorkspaceDO/' || name WHERE cls = 'OrgDO'",
    )
  }
}

const FileEntries = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ path: Schema.String, hash: Schema.String, size: Schema.Number })),
  ),
)

const Versions = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ version: Schema.String, files: Schema.String })),
)

const Blob = Schema.decodeUnknownSync(Schema.Struct({ body: Schema.Uint8Array }))

const Config = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

const Bindings = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))

const hashOf = (body: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(body).digest("hex")

const migrateAppConfigs = (db: Database) => {
  if (!has(db, "versions") || !has(db, "blobs")) return

  const changes = new Map<string, string>()

  for (const version of Versions(db.query("SELECT version, files FROM versions").all())) {
    const files = FileEntries(version.files)
    const manifest = files.find((file) => file.path === "openbelt.json")

    if (manifest === undefined) continue

    const original = Blob(db.query("SELECT body FROM blobs WHERE hash = ?").get(manifest.hash))
    const config = Config(new TextDecoder().decode(original.body))

    if (config["tools"] === undefined) continue

    const bindings = Bindings(config["tools"])

    if (!Object.values(bindings).includes("org")) continue

    const body = new TextEncoder().encode(
      JSON.stringify({
        ...config,
        tools: Object.fromEntries(
          Object.entries(bindings).map(([name, owner]) => [
            name,
            owner === "org" ? "workspace" : owner,
          ]),
        ),
      }),
    )

    const hash = hashOf(body)

    const nextFiles = files.map((file) =>
      file.path === "openbelt.json" ? { ...file, hash, size: body.byteLength } : file,
    )

    const next = hashOf(
      JSON.stringify(
        nextFiles
          .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((file) => [file.path, file.hash]),
      ),
    ).slice(0, 12)

    db.query("INSERT OR IGNORE INTO blobs (hash, body) VALUES (?, ?)").run(hash, body)
    db.query("UPDATE versions SET version = ?, files = ? WHERE version = ?").run(
      `workspace-migration:${version.version}`,
      JSON.stringify(nextFiles),
      version.version,
    )
    changes.set(version.version, next)
  }

  for (const [before, after] of changes) {
    db.query("UPDATE OR IGNORE versions SET version = ? WHERE version = ?").run(
      after,
      `workspace-migration:${before}`,
    )
    db.query("DELETE FROM versions WHERE version = ?").run(`workspace-migration:${before}`)
    db.query("UPDATE versions SET anchor = ? WHERE anchor = ?").run(after, before)

    for (const table of ["environments", "laters", "shot", "runs"])
      if (has(db, table) && columnsOf(db, table).includes("version"))
        db.query(`UPDATE ${quote(table)} SET version = ? WHERE version = ?`).run(after, before)

    if (has(db, "__kv"))
      db.query("UPDATE __kv SET v = ? WHERE k = 'live' AND v = ?").run(
        JSON.stringify(after),
        JSON.stringify(before),
      )
  }
}

/** Runs before any platform process opens this namespace. Each file commits independently and can be retried after a crash. */
export const upgradeWorkspaces = async (directory: string, master: string) => {
  const done = join(directory, ".workspace-v1")

  if (!existsSync(directory) || existsSync(done)) return

  const lock = new Database(join(directory, ".workspace-upgrade.lock"))

  try {
    lock.exec("PRAGMA busy_timeout = 15000")
    lock.exec("BEGIN EXCLUSIVE")

    if (existsSync(done)) return

    const backup = join(directory, ".before-workspace-v1")

    mkdirSync(backup, { recursive: true, mode: 0o700 })

    const files = readdirSync(directory).filter((file) => file.endsWith(".sqlite"))

    for (const file of files) {
      const path = join(directory, file)
      const db = new Database(path, { strict: true })

      try {
        db.exec("PRAGMA busy_timeout = 15000")
        const saved = join(backup, file)

        if (!existsSync(saved)) db.query("VACUUM INTO ?").run(saved)

        db.exec("BEGIN EXCLUSIVE")
        await resealCredentials(db, master)
        migrateTables(db)
        migrateAppConfigs(db)
        db.exec("COMMIT")

        const checkpoint = Schema.decodeUnknownSync(Schema.Struct({ busy: Schema.Number }))(
          db.query("PRAGMA wal_checkpoint(TRUNCATE)").get(),
        )

        if (checkpoint.busy !== 0)
          throw new Error(`Stop every process using ${file} before migrating workspace storage`)
      } catch (error) {
        if (db.inTransaction) db.exec("ROLLBACK")
        throw error
      } finally {
        db.close()
      }

      const old = /^OrgDO-(.+)-[a-f0-9]{8}\.sqlite$/.exec(file)

      if (old?.[1] !== undefined) {
        const next = join(directory, `${objectFileId("WorkspaceDO", old[1])}.sqlite`)

        if (existsSync(next))
          throw new Error(
            `Workspace storage already exists beside ${file}; resolve the duplicate before upgrading`,
          )

        rmSync(`${path}-wal`, { force: true })
        rmSync(`${path}-shm`, { force: true })
        renameSync(path, next)
      }
    }

    writeFileSync(done, "1\n")
  } finally {
    if (lock.inTransaction) lock.exec("ROLLBACK")
    lock.close()
  }
}
