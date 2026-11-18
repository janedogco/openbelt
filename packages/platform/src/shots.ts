// When it's taken is a durable callback on the AppDO (makeCallback), which shares the
import * as Runtime from "./runtime/index.ts"
import type { DurableObjectStorage } from "./runtime/index.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type CardAsk, ColorSource } from "./cards.ts"
import type { Checker } from "./check.ts"
import { APP_SEPARATOR } from "./hosts.ts"
import { type LogLine, newTrace } from "./model.ts"

type Hooks = {
  readonly log: (level: LogLine["level"], trace: string, message: string) => Effect.Effect<void>
  readonly note: (trace: string, message: string) => Effect.Effect<void>
  readonly live: () => string | undefined
  /** A picture was taken: the workspace's directory shows it from now on. */
  readonly taken: () => Effect.Effect<void>
  readonly check: Checker["Service"]["check"]
  /** What the app's link preview cards say, or null for none (it has no workspace yet). */
  readonly card: () => Effect.Effect<CardAsk | null>
  readonly delayMs: number
  readonly refreshMs: number
}

type Shot = {
  readonly version: string
  readonly at: string
  readonly image: Uint8Array
  readonly dark: Uint8Array | undefined
  readonly cards: StoredCards | undefined
}

type StoredCards = {
  readonly card: Uint8Array
  readonly private: Uint8Array
  readonly title: string
  readonly color: string
  readonly source: ColorSource
}

const isSource = Schema.is(ColorSource)

/** Where a card's colour came from, as the log says it. */
const SOURCE_SAID: Readonly<Record<ColorSource, string>> = {
  config: "openbelt.json",
  theme: "theme-color",
  picture: "picture",
  name: "name",
}

/** Columns added after the table was made: a picture taken before them has none of them. */
const ADDED = [
  ["dark", "BLOB"],
  ["card", "BLOB"],
  ["private_card", "BLOB"],
  ["title", "TEXT"],
  ["color", "TEXT"],
  ["color_source", "TEXT"],
] as const

const ROOT = "shot:root"

const TRIED = "shot:tried"

/** How pictures are taken now: 3 since link preview cards are painted at a calm chroma with the picture clear of the text, 2 since
 * they came at 1.5× (1920×1200), 1 before (800×500, and before that light only). One of an older format is taken again, once, the
 * next time the home page shows it or a link previewer asks for its card. */
const FORMAT = 3

/** The format of the picture kept (none: one from before formats were kept, so 1). */
const KEPT_FORMAT = "shot:format"

/** The format a picture was last booked again for, so an outdated one is booked once. */
const REBOOKED_FORMAT = "shot:rebooked"

/** When the next picture is booked for (ms), while one is: the callback's own time isn't readable. */
const DUE = "shot:due"

/** Tries in a row that found no browser free (Browser Run caps how many run at once). */
const BUSY = "shot:busy"

const BUSY_RETRIES = 3

const BUSY_WAIT_MS = 30_000

const spread = (ms: number) => ms + Math.floor((Math.random() * ms) / 2)

/**
 * How many pictures the platform takes at once, across all its processes (runtime/slots.ts), each in a Chrome of its own (200 to
 * 400 MB). Every deploy books one, so a burst of deploys started as many browsers at once: 200 deploys in 30 s killed the platform
 * on an 8 GB machine (out of memory). Counted per process, 4 processes took 8 at once. A picture that finds no slot free is booked
 * again a little later instead (waiting would hold its app meanwhile).
 */
const AT_ONCE = 2

export const openShots = Effect.fn("Shots.open")(function* (
  storage: DurableObjectStorage,
  hooks: Hooks,
) {
  const { sql, kv } = storage

  yield* sql.exec(`CREATE TABLE IF NOT EXISTS shot (
    id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, at TEXT NOT NULL,
    image BLOB NOT NULL)`)

  const columns = new Set(
    (yield* (yield* sql.exec<{ name: string }>(
      "SELECT name FROM pragma_table_info('shot')",
    )).toArray()).map((c) => c.name),
  )

  for (const [column, type] of ADDED) {
    if (!columns.has(column)) yield* sql.exec(`ALTER TABLE shot ADD COLUMN ${column} ${type}`)
  }

  const get = Effect.fnUntraced(function* () {
    const [row] = yield* (yield* sql.exec<{
      version: string
      at: string
      image: ArrayBuffer
      dark: ArrayBuffer | null
      card: ArrayBuffer | null
      private_card: ArrayBuffer | null
      title: string | null
      color: string | null
      color_source: string | null
    }>(
      "SELECT version, at, image, dark, card, private_card, title, color, color_source FROM shot WHERE id = 1",
    )).toArray()

    if (row === undefined) return undefined

    const source = isSource(row.color_source) ? row.color_source : undefined

    return {
      version: row.version,
      at: row.at,
      image: new Uint8Array(row.image),
      dark: row.dark === null ? undefined : new Uint8Array(row.dark),
      cards:
        row.card === null ||
        row.private_card === null ||
        row.title === null ||
        row.color === null ||
        source === undefined
          ? undefined
          : {
              card: new Uint8Array(row.card),
              private: new Uint8Array(row.private_card),
              title: row.title,
              color: row.color,
              source,
            },
    } satisfies Shot
  })

  // A picture being taken (minutes at most, and none survives the object): asking for the picture meanwhile books no second one,
  // however long the browser takes.
  let taking = false

  const book = (at: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      kv.put(DUE, at)

      return job.schedule("next", { at, payload: null }).pipe(Effect.orDie)
    })

  const due = Effect.fnUntraced(function* (inMs: number) {
    const ring = kv.get<number>(DUE)
    const at = Date.now() + inMs

    if (ring === undefined || ring > at) yield* book(at)
  })

  const take = Effect.fnUntraced(function* () {
    const root = kv.get<string>(ROOT)
    const version = hooks.live()

    kv.delete(DUE)
    const trace = newTrace()

    if (root === undefined || version === undefined) return

    const slot = Runtime.takeSlot("shot", AT_ONCE)

    if (slot === undefined) {
      yield* book(Date.now() + spread(hooks.delayMs))

      return
    }

    kv.put(TRIED, Date.now())
    taking = true

    // A version keeps the colour its first card was given (unless openbelt.json names one): a write that changes the picture
    // doesn't change it.
    const before = yield* get()
    const asked = yield* hooks.card()

    const card =
      asked === null ||
      asked.color !== null ||
      before?.cards === undefined ||
      before.version !== version
        ? asked
        : { ...asked, color: { color: before.cards.color, source: before.cards.source } }

    const checked = yield* hooks
      .check({
        by: null,
        apps: null,
        root,
        path: "",
        steps: [],
        width: 1280,
        screenshot: "gallery",
        blockWrites: true,
        people: [],
        others: [],
        trace,
        tools: false,
        card,
      })
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            slot()
          }),
        ),
        Effect.catchTag("Refused", (refused) =>
          Effect.gen(function* () {
            const busy = (kv.get<number>(BUSY) ?? 0) + 1
            const again = busy <= BUSY_RETRIES

            kv.put(BUSY, again ? busy : 0)

            if (again) yield* book(Date.now() + spread(BUSY_WAIT_MS * 2 ** (busy - 1)))

            yield* hooks.log(
              "warn",
              trace,
              `no picture for the workspace's home page: ${refused.message}${again ? ` Trying again (${busy} of ${BUSY_RETRIES}).` : ""}`,
            )
          }),
        ),
      )

    if (checked === undefined) return

    kv.delete(BUSY)

    const { report, screenshot, dark, cards, ms } = checked
    const status = report.status ?? 0

    if (screenshot === undefined || status < 200 || status >= 400) {
      const why =
        screenshot === undefined
          ? (report.errors[0] ?? "the browser took none")
          : `${root} answered ${status}${report.errors.length > 0 ? ` (${report.errors.join("; ")})` : ""}`

      yield* hooks.log(
        "warn",
        trace,
        `no picture for the workspace's home page of ${version}: ${why}`,
      )

      return
    }

    const drawn = cards.kind === "drawn" ? cards.cards : undefined

    yield* sql.exec(
      `INSERT INTO shot (id, version, at, image, dark, card, private_card, title, color, color_source)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, at = excluded.at,
         image = excluded.image, dark = excluded.dark, card = excluded.card, private_card = excluded.private_card,
         title = excluded.title, color = excluded.color, color_source = excluded.color_source`,
      version,
      new Date().toISOString(),
      screenshot,
      dark ?? null,
      drawn?.card ?? null,
      drawn?.private ?? null,
      drawn?.title ?? null,
      drawn?.color ?? null,
      drawn?.source ?? null,
    )

    if (cards.kind === "none" && card !== null)
      yield* hooks.log("warn", trace, `no link preview cards for ${version}: ${cards.why}`)

    kv.put(KEPT_FORMAT, FORMAT)
    yield* hooks.taken()
    yield* hooks.note(
      trace,
      `took the workspace's home page picture of ${version} (${Math.round(screenshot.length / 1024)} KB light, ${dark === undefined ? "no dark" : `${Math.round(dark.length / 1024)} KB dark`}, ${(ms / 1000).toFixed(1)}s of browser time)${drawn === undefined ? "" : `, and its link preview cards (${drawn.color}, from its ${SOURCE_SAID[drawn.source]})`}`,
    )
  })

  const job = yield* Runtime.makeCallback("shot", () =>
    take().pipe(
      Effect.ensuring(
        Effect.sync(() => {
          taking = false
        }),
      ),
      Effect.catchDefect((defect) =>
        hooks.log(
          "warn",
          newTrace(),
          `no picture for the workspace's home page: ${String(defect).slice(0, 300)}`,
        ),
      ),
    ),
  )

  // rolled back to drained its job.
  const pending = kv.get<number>(DUE)

  if (pending !== undefined) yield* book(pending)

  // An app deployed before #107 kept its page as `<app>.<workspace>.<host>`, a host nothing answers now: it becomes
  // `<app>--<workspace>.<host>`, or no picture of the app is taken again until its next deploy.
  const saved = kv.get<string>(ROOT)

  if (saved !== undefined) {
    const url = new URL(saved)
    const [app, ...rest] = url.hostname.split(".")

    if (app !== undefined && !app.includes(APP_SEPARATOR) && rest.length >= 2) {
      url.hostname = `${app}${APP_SEPARATOR}${rest.join(".")}`
      kv.put(ROOT, url.href)
    }
  }

  return {
    get,

    taken: Effect.fnUntraced(function* () {
      const [row] = yield* (yield* sql.exec<{ at: string }>(
        "SELECT at FROM shot WHERE id = 1",
      )).toArray()

      return row?.at
    }),

    /** The colour the app gave itself (openbelt.json, its theme-color or its picture's), as its cards were drawn; not one from its name. */
    own: Effect.fnUntraced(function* () {
      const [row] = yield* (yield* sql.exec<{ color: string | null; color_source: string | null }>(
        "SELECT color, color_source FROM shot WHERE id = 1",
      )).toArray()

      return row?.color !== null &&
        row?.color !== undefined &&
        isSource(row.color_source) &&
        row.color_source !== "name"
        ? row.color
        : undefined
    }),

    soon: Effect.fnUntraced(function* (root: string) {
      kv.put(ROOT, root)
      kv.delete(BUSY)
      yield* book(Date.now() + spread(hooks.delayMs))
    }),

    /**
     * A picture made ahead (a starter's, starters.ts), kept as the live version's instead of booking one: its card shows it at once.
     * `root` is kept as `soon` keeps it, so the next deploy or write takes a picture as usual. It keeps `color` (openbelt.json's) as its tint; its link
     * preview cards are drawn with the next picture.
     */
    given: Effect.fnUntraced(function* (
      root: string,
      image: Uint8Array,
      dark: Uint8Array,
      color: string,
    ) {
      const version = hooks.live()

      kv.put(ROOT, root)

      if (version === undefined) return

      yield* sql.exec(
        `INSERT INTO shot (id, version, at, image, dark, card, private_card, title, color, color_source)
         VALUES (1, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'config')
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, at = excluded.at, image = excluded.image,
           dark = excluded.dark, card = NULL, private_card = NULL, title = NULL, color = excluded.color,
           color_source = excluded.color_source`,
        version,
        new Date().toISOString(),
        image,
        dark,
        color.toLowerCase(),
      )

      kv.put(KEPT_FORMAT, FORMAT)
      yield* hooks.taken()
    }),

    changed: Effect.fnUntraced(function* () {
      if (kv.get<string>(ROOT) === undefined) return

      const [row] = yield* (yield* sql.exec<{ at: string }>(
        "SELECT at FROM shot WHERE id = 1",
      )).toArray()

      const age = row === undefined ? Infinity : Date.now() - Date.parse(row.at)
      const sinceTried = Date.now() - (kv.get<number>(TRIED) ?? 0)

      const wait = Math.max(hooks.refreshMs - age, hooks.refreshMs - sinceTried, 0)

      yield* due(wait + spread(hooks.delayMs))
    }),

    missing: Effect.fnUntraced(function* () {
      if (hooks.live() === undefined || kv.get<string>(ROOT) === undefined) return false

      const sinceTried = Date.now() - (kv.get<number>(TRIED) ?? 0)

      if (!taking && sinceTried >= hooks.refreshMs) yield* due(0)

      return taking || kv.get<number>(DUE) !== undefined
    }),

    /** The picture kept is of an older format (smaller, or light only): book it again, once. */
    outdated: Effect.fnUntraced(function* () {
      if (
        (kv.get<number>(KEPT_FORMAT) ?? 1) === FORMAT ||
        kv.get<number>(REBOOKED_FORMAT) === FORMAT ||
        hooks.live() === undefined ||
        kv.get<string>(ROOT) === undefined
      )
        return

      kv.put(REBOOKED_FORMAT, FORMAT)
      yield* due(0)
    }),
  }
})
