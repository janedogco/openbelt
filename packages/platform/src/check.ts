// (a headless Chrome the platform starts itself, runtime/browser.ts),
import { type Browser, type Request, type Response, type Page } from "playwright-core"
import * as Runtime from "./runtime/index.ts"
import { positive } from "./runtime/settings.ts"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { type CardAsk, type CardsDrawn, renderCards } from "./cards.ts"
import { appOfHost, inWorkspace, workspaceOfApp } from "./hosts.ts"
import { type CheckReport, type CheckStep, type ErrorCode, Refused } from "./model.ts"
import { INSERTED_HEADER, type Inserted, insertedOf, appLocations } from "./reporter.ts"
import { COOKIE, SESSION_MS, SESSION_SECRET, sessions } from "./session.ts"
import {
  assertAfter,
  BLOCKED_STATUS,
  type DataRequest,
  fillSaved,
  label,
  LOAD_TIMEOUT_MS,
  Problem,
  reason,
  runStep,
  settle,
  within,
} from "./steps.ts"

const TIME_LIMIT_MS = positive("OPENBELT_CHECK_TIME_LIMIT_SECONDS", 30) * 1000

const PER_PERSON_MS = 10_000

const TOOLS_MS = 30_000

const checkTimeLimit = (people: number, tools: boolean) =>
  TIME_LIMIT_MS + PER_PERSON_MS * Math.max(people - 1, 0) + (tools ? TOOLS_MS : 0)

const READ_LIMIT_MS = 5000

const MAX_TEXT = 3000

const MAX_CONTROLS = 40

const MAX_OPTIONS = 12

const MAX_LINES = 30

const STACK_FRAMES = 5

const ASSERT_MS = 3000

type CheckTarget = {
  readonly by: string | null
  /** The apps the checking agent may use; null for every app. */
  readonly apps: ReadonlyArray<string> | null
  readonly root: string
  readonly path: string
  readonly steps: ReadonlyArray<CheckStep>
  readonly width: number
  readonly screenshot: "none" | "report" | "gallery"
  readonly blockWrites: boolean
  readonly people: ReadonlyArray<Person>
  readonly others: ReadonlyArray<string>
  readonly trace: string
  readonly tools: boolean
  /** With a gallery picture: the app's link preview cards are drawn from it too (cards.ts). */
  readonly card: CardAsk | null
}

export type Person = {
  readonly name: string
  readonly email: string
  readonly shown: string
  readonly groups: ReadonlyArray<string>
}

type Cookies = ReadonlyArray<{ readonly url: string; readonly value: string }>

type Sealed = Omit<CheckTarget, "people"> & {
  readonly people: ReadonlyArray<Person & { readonly cookies: Cookies }>
  readonly cookies: Cookies
}

type Checked = {
  readonly report: CheckReport
  readonly screenshot: Uint8Array | undefined
  readonly dark: Uint8Array | undefined
  /** The link preview cards, or why there are none (the picture had none to draw from, or drawing them failed). */
  readonly cards: CardsDrawn
  readonly ms: number
}

/** Both cards: two tabs of a few hundred ms each, with room for a busy machine. */
const CARDS_LIMIT_MS = 15_000

/** The page's theme-color: one with no media query first, as a browser in light mode would take it. */
const THEME_COLOR = `(document.querySelector('meta[name="theme-color"]:not([media])') ?? document.querySelector('meta[name="theme-color"]'))?.content ?? null`

const decodeTheme = Schema.decodeUnknownOption(Schema.NullOr(Schema.String))

// The page at 1280×800, saved at 1.5× (1920×1200): the gallery zooms into the app's middle and shows it large on 2× screens, so a
// smaller picture blurs its text (at 0.625×, 800×500, the featured app's picture showed 800 pixels across about 1,700).
const GALLERY = { width: 1280, height: 800, scale: 1.5, quality: 85, settleMs: 8000 } as const

const DARK_SETTLE = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))))`

const SUMMARY = `(() => {
  const clean = (s) => String(s || "").trim().replace(/\\s+/g, " ")
  const visible = (el) => el.getClientRects().length > 0
  const controls = [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button]")]
    .filter((el) => visible(el) && el.type !== "hidden")
    .slice(0, ${MAX_CONTROLS})
    .map((el) => {
      const tag = el.tagName.toLowerCase()
      const id = el.id ? "#" + el.id : ""
      const type = tag === "input" ? "[type=" + (el.type || "text") + "]" : ""
      const name = clean(tag === "input" || tag === "textarea" || tag === "select" ? el.getAttribute("aria-label") || el.placeholder || el.name || (el.labels && el.labels[0] && el.labels[0].innerText) : el.innerText || el.getAttribute("aria-label") || el.title).slice(0, 60)
      const value = tag === "input" && (el.type === "checkbox" || el.type === "radio") ? (el.checked ? " checked" : "") : "value" in el && tag !== "button" && el.value ? " value=" + JSON.stringify(String(el.value).slice(0, 60)) : ""
      const options = tag === "select" ? " options: " + [...el.options].slice(0, ${MAX_OPTIONS}).map((o) => clean(o.label) === o.value ? JSON.stringify(o.value) : JSON.stringify(o.value) + " (" + clean(o.label) + ")").join(", ") + (el.options.length > ${MAX_OPTIONS} ? ", +" + (el.options.length - ${MAX_OPTIONS}) + " more" : "") : ""
      return tag + id + type + ' "' + name + '"' + value + (el.disabled ? " (disabled)" : "") + options
    })
  let text = document.body ? document.body.innerText : ""
  for (const select of document.querySelectorAll("select")) {
    const own = select.innerText
    if (own) text = text.replace(own, "")
  }
  return JSON.stringify({ title: document.title, text: text.trim().slice(0, ${MAX_TEXT}), controls })
})()`

const Summary = Schema.Struct({
  title: Schema.String,
  text: Schema.String,
  controls: Schema.Array(Schema.String),
})

const EMPTY: typeof Summary.Type = { title: "", text: "", controls: [] }

const decodeSummary = Schema.decodeUnknownOption(Schema.fromJsonString(Summary))

const push = (lines: Array<string>, line: string) => {
  if (lines.length < MAX_LINES) lines.push(line)
}

const ours = (url: string) => /\/_log$|^[^?]*\/favicon\.ico$/.test(url)

const READS = new Set(["GET", "HEAD", "OPTIONS"])

const isWrite = (request: Request, root: URL) => {
  const url = new URL(request.url())

  return (
    inWorkspace(url, workspaceOfApp(root)) &&
    !READS.has(request.method()) &&
    !/^(?:\/_preview\/[^/]+)?\/_log$/.test(url.pathname)
  )
}

const DATA = /^(?:\/a\/[^/]+)?(?:\/_preview\/[^/]+)?\/_db(?:\/|$)/

const FN_CALL = /^(?:\/a\/[^/]+)?(?:\/_preview\/[^/]+)?\/_fn\//

const pathFrom = (url: URL, root: URL) => {
  const app = url.host === root.host ? undefined : appOfHost(url.host, workspaceOfApp(root).host)

  return app === undefined ? url.pathname : `/a/${app}${url.pathname}`
}

const urlShown = (url: string, root: URL) =>
  url.startsWith(root.origin) ? url.slice(root.origin.length) : url

const TOOLS_CALL = /^(?:\/_preview\/[^/]+)?\/_tools\/call$/

const decodeToolRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ tool: Schema.String, code: Schema.String })),
)

const ruleOf = (body: string) =>
  Option.getOrUndefined(decodeDenial(body).pipe(Option.map((e) => e.rule)))

const decodeDenial = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ rule: Schema.String })),
)

const dataRequest = (request: Request, root: URL): DataRequest => {
  const pathname = pathFrom(new URL(request.url()), root)
  const app = root.pathname.replace(/\/$/, "")
  const path = pathname.startsWith(`${app}/`) ? pathname.slice(app.length) : pathname

  return {
    method: request.method(),
    path,
    names: [path, pathname.replace(/^(\/a\/[^/]+)\/_preview\/[^/]+/, "$1"), pathname],
    status: null,
    rule: undefined,
    expected: false,
  }
}

const expectThrown = (
  requests: ReadonlyArray<DataRequest>,
  threw: { readonly status?: number; readonly rule?: string } | undefined,
) => {
  if (threw?.rule === undefined) return

  for (const request of requests) {
    if (request.status === threw.status && request.rule === threw.rule) request.expected = true
  }
}

const BLOCKED_BODY = JSON.stringify({
  error: "check_app is read-only (readonly: true): this write was blocked and nothing was saved",
  code: "check_readonly" satisfies ErrorCode,
})

type Seen = {
  readonly errors: Array<string>
  readonly console: Array<string>
  readonly dialogs: Array<string>
  readonly failed: Array<string>
  readonly blocked: Array<string>
  readonly refusedTools: Array<string>
}

const prefix = (who: string) => (who === "" ? "" : `[${who}] `)

const watch = async (
  page: Page,
  root: string,
  blockWrites: boolean,
  who: string,
  seen: Seen,
  requests: Array<DataRequest>,
) => {
  const home = new URL(root)
  const answered = new WeakSet<Request>()
  const data = new WeakMap<Request, DataRequest>()
  const pages = new Map<string, Inserted>()
  const local = (text: string) => appLocations(text, root, pages)
  const add = (lines: Array<string>, line: string) => push(lines, prefix(who) + line)

  const stackOf = (stack: string) =>
    local(
      stack
        .split("\n")
        .slice(0, STACK_FRAMES + 1)
        .join("\n"),
    )

  page.on("pageerror", (error) => {
    add(seen.errors, error instanceof Error ? stackOf(error.stack ?? error.message) : String(error))
  })
  const protocol = await page.context().newCDPSession(page)

  protocol.on("Runtime.consoleAPICalled", (message) => {
    const type = message.type === "warning" ? "warn" : message.type

    if (type !== "error" && type !== "warn") return

    const parts = message.args.map((arg) => {
      if (arg.subtype === "error") return stackOf(arg.description ?? "Error")

      return arg.type === "string" || arg.type === "number" || arg.type === "boolean"
        ? String(arg.value)
        : (arg.description ?? arg.type)
    })

    const where = message.stackTrace?.callFrames.find((frame) => {
      const inserted = pages.get(frame.url)

      return (
        inserted === undefined ||
        frame.lineNumber + 1 !== inserted.line ||
        frame.columnNumber + 1 < inserted.column ||
        frame.columnNumber + 1 >= inserted.column + inserted.length
      )
    })

    const at =
      where === undefined || message.args.some((arg) => arg.subtype === "error")
        ? ""
        : ` (${local(`${where.url}:${where.lineNumber + 1}:${where.columnNumber + 1}`)})`

    add(seen.console, `${type}: ${parts.join(" ")}${at}`)
  })
  await protocol.send("Runtime.enable")
  // A dialog would block the page (and every step after it): accept it, as OK, and say so.
  page.on("dialog", (dialog) => {
    add(seen.dialogs, `${dialog.type()} ${JSON.stringify(dialog.message())} (accepted)`)
    dialog.accept().catch(() => undefined)
  })

  if (blockWrites) {
    await page.context().route("**/*", async (route) => {
      const request = route.request()

      if (!isWrite(request, home)) {
        route.continue().catch(() => undefined)

        return
      }

      if (
        FN_CALL.test(new URL(request.url()).pathname) ||
        TOOLS_CALL.test(new URL(request.url()).pathname)
      ) {
        route
          .continue({ headers: { ...request.headers(), "x-openbelt-readonly": "1" } })
          .catch(() => undefined)

        return
      }

      answered.add(request)
      add(seen.blocked, `${request.method()} ${urlShown(request.url(), home)}`)

      if (DATA.test(new URL(request.url()).pathname)) {
        const recorded = dataRequest(request, new URL(root))

        recorded.status = BLOCKED_STATUS
        requests.push(recorded)
      }

      route
        .fulfill({ status: BLOCKED_STATUS, contentType: "application/json", body: BLOCKED_BODY })
        .catch(() => undefined)
    })
  }

  page.on("request", (request) => {
    const url = new URL(request.url())

    if (
      !inWorkspace(url, workspaceOfApp(home)) ||
      !DATA.test(url.pathname) ||
      answered.has(request)
    )
      return

    const recorded = dataRequest(request, new URL(root))

    data.set(request, recorded)
    requests.push(recorded)
  })
  page.on("requestfailed", (request) => {
    if (ours(request.url())) return

    const recorded = data.get(request)

    if (recorded !== undefined) recorded.status = 0

    add(
      seen.failed,
      `${request.method()} ${urlShown(request.url(), home)}: ${request.failure()?.errorText ?? "failed"}`,
    )
  })
  page.on("response", (response: Response) => {
    const inserted = insertedOf(response.headers()[INSERTED_HEADER])

    if (inserted !== undefined) pages.set(response.url().split("#")[0] ?? "", inserted)

    const recorded = data.get(response.request())

    if (recorded !== undefined) {
      const status = response.status()

      if (status !== 403) {
        recorded.status = status

        return
      }

      response
        .text()
        .then(ruleOf, () => undefined)
        .then((rule) => {
          recorded.rule = rule
          recorded.status = status

          return rule
        })
        .catch(() => undefined)

      return
    }

    if (response.status() === 403 && TOOLS_CALL.test(new URL(response.url()).pathname)) {
      response
        .text()
        .then((body) => {
          const refusal = decodeToolRefusal(body)

          if (Option.isSome(refusal))
            add(seen.refusedTools, `${refusal.value.tool}: ${refusal.value.code}`)
          else add(seen.failed, `403 POST ${urlShown(response.url(), home)}`)

          return undefined
        })
        .catch(() => undefined)

      return
    }

    if (
      blockWrites &&
      response.status() === 423 &&
      (FN_CALL.test(new URL(response.url()).pathname) ||
        TOOLS_CALL.test(new URL(response.url()).pathname))
    ) {
      add(seen.blocked, `POST ${urlShown(response.url(), home)}`)

      return
    }

    if (response.status() >= 400 && !ours(response.url()) && !answered.has(response.request())) {
      add(
        seen.failed,
        `${response.status()} ${response.request().method()} ${urlShown(response.url(), home)}`,
      )
    }
  })
}

type Tab = {
  readonly who: string
  readonly email: string
  readonly page: Page
  readonly requests: Array<DataRequest>
  /** The page's own document's status, from the response event: goto's answer is null when a request interceptor handled it. */
  readonly document: { status: number | undefined }
  since: number
}

type StepLine = {
  readonly who: string
  readonly label: string
  state: "running" | "ok" | "FAILED" | "not run"
  detail: string
}

/** Where one check's time went: ms per phase, summed when a phase repeats (each step's settle), for its log line. */
const phases = () => {
  const spent: Record<string, number> = {}
  let at = performance.now()

  return {
    spent,
    lap: (phase: string) => {
      const now = performance.now()

      spent[phase] = (spent[phase] ?? 0) + Math.round(now - at)
      at = now
    },
  }
}

type Lap = ReturnType<typeof phases>["lap"]

const inspect = async (browser: Browser, target: Sealed, started: number, lap: Lap) => {
  const seen: Seen = {
    errors: [],
    console: [],
    dialogs: [],
    failed: [],
    blocked: [],
    refusedTools: [],
  }

  const version = browser.version()
  const agent = `Mozilla/5.0 Chrome/${version} OpenBeltCheck/${target.trace}`

  const timeLimit = checkTimeLimit(target.people.length, target.tools)

  const lines: Array<StepLine> = []
  const tabs: Array<Tab> = []
  const saved = new Map<string, string>()
  let status: number | null = null
  let shown = ""
  const stop = new AbortController()

  const open = async (who: string, email: string, cookies: Cookies): Promise<Tab> => {
    const page = await within(10_000, "opening a tab", async () =>
      (await browser.newContext({ userAgent: agent, serviceWorkers: "block" })).newPage(),
    )

    const requests: Array<DataRequest> = []

    await watch(page, target.root, target.blockWrites, who, seen, requests)

    const document: Tab["document"] = { status: undefined }

    page.on("response", (response: Response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        document.status ??= response.status()
      }
    })

    await within(5000, "setting up the tab", async () => {
      await page.setViewportSize({
        width: target.width,
        height: target.screenshot === "gallery" ? GALLERY.height : target.width < 600 ? 844 : 768,
      })

      // A __Host- cookie: Secure, on that host alone (the browser keeps it to http://*.localhost
      // too), sealed for that host.
      await page.context().addCookies(
        cookies.map(({ url, value }) => ({
          name: COOKIE,
          value,
          domain: new URL(url).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax" as const,
        })),
      )

      if (target.screenshot === "gallery") {
        await page.emulateMedia({ colorScheme: "light" })
      }
    })

    return { who, email, page, requests, document, since: 0 }
  }

  const load = async (tab: Tab) => {
    try {
      const response = await within(LOAD_TIMEOUT_MS + 1000, "loading the page", () =>
        tab.page.goto(target.root + target.path.replace(/^\//, ""), {
          waitUntil: "load",
          timeout: LOAD_TIMEOUT_MS,
        }),
      )

      if (!stop.signal.aborted) status ??= response?.status() ?? tab.document.status ?? null

      return true
    } catch (cause) {
      if (!stop.signal.aborted) {
        seen.errors.push(`${prefix(tab.who)}the page didn't load: ${reason(cause)}`)
      }

      return false
    }
  }

  const run = async () => {
    const people =
      target.people.length === 0
        ? [{ name: "", email: "", cookies: target.cookies }]
        : target.people

    for (const person of people) {
      const tab = await open(person.name, person.email, person.cookies)

      if (stop.signal.aborted) return

      tabs.push(tab)
    }

    lap("tabs")
    shown = tabs[0]?.who ?? ""

    const loaded = await Promise.all(tabs.map(load))

    lap("load")

    if (stop.signal.aborted || loaded.includes(false)) return

    // Before an eval, and before the page is read at the end, the longer wait (steps.ts, QUIET_MS).
    const before = (index: number) =>
      index >= target.steps.length || target.steps[index]?.action === "eval" ? "read" : "step"

    await Promise.all(tabs.map((tab) => settle(tab.page, before(0))))
    lap("settle")

    if (target.screenshot === "gallery") {
      await Promise.all(
        tabs.map((tab) =>
          within(GALLERY.settleMs, "waiting for the page to finish", async () => {
            await tab.page.waitForLoadState("networkidle", { timeout: GALLERY.settleMs - 500 })
            await tab.page.evaluate("document.fonts.ready.then(() => true)")
          }).catch(() => undefined),
        ),
      )
    }

    for (const [index, given] of target.steps.entries()) {
      const tab = tabs.find((t) => t.who === given.as) ?? tabs[0]

      if (stop.signal.aborted || tab === undefined) return

      const step = fillSaved(given, saved)
      const line: StepLine = { who: tab.who, label: label(step), state: "running", detail: "" }

      shown = tab.who
      lines.push(line)

      const since = tab.since

      tab.since = tab.requests.length

      try {
        const ran = await runStep(
          tab.page,
          target.root,
          step,
          () => tab.requests.slice(since),
          stop.signal,
        )

        lap("steps")
        await settle(tab.page, before(index + 1))
        lap("settle")

        if (step.assert !== undefined) {
          await assertAfter(
            tab.page,
            step.assert,
            step.ms ?? ASSERT_MS,
            step.action === "eval",
            stop.signal,
          ).catch((cause: Error) => {
            throw new Problem(`${reason(cause)}${ran.line}`)
          })
          expectThrown(tab.requests.slice(since), ran.threw)
          lap("expect")
        }

        if (stop.signal.aborted) return

        if (step.save !== undefined && ran.saved !== undefined) saved.set(step.save, ran.saved)

        line.state = "ok"
        line.detail = ran.line
      } catch (cause) {
        if (stop.signal.aborted) return

        line.state = "FAILED"
        line.detail = `: ${reason(cause)}`

        return
      }
    }
  }

  const finished = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(false),
      Math.max(timeLimit - (Date.now() - started), 1000),
    )

    run()
      .then(
        () => resolve(true),
        (cause: Error) => reject(cause),
      )
      .finally(() => clearTimeout(timer))
  })

  stop.abort()

  const incomplete = finished
    ? null
    : `stopped at the ${timeLimit / 1000}s limit for a check; below is what it saw until then`

  for (const line of lines) {
    if (line.state === "running") {
      line.state = "FAILED"
      line.detail = `: still running at the ${timeLimit / 1000}s limit`
    }
  }

  for (const step of target.steps.slice(lines.length)) {
    const who = target.people.length === 0 ? "" : (step.as ?? target.people[0]?.name ?? "")

    lines.push({ who, label: label(step), state: "not run", detail: "" })
  }

  const steps = lines.map((line) => `${prefix(line.who)}${line.state}: ${line.label}${line.detail}`)

  lap("steps")

  const summaries = await Promise.all(
    tabs.map((tab) =>
      within(READ_LIMIT_MS, "reading the page", () => tab.page.evaluate(SUMMARY)).then(
        (raw) => Option.getOrElse(decodeSummary(String(raw)), () => EMPTY),
        () => EMPTY,
      ),
    ),
  )

  lap("read")

  const current = tabs.find((tab) => tab.who === shown)
  const summary = (current === undefined ? undefined : summaries[tabs.indexOf(current)]) ?? EMPTY

  const gallery = (page: Page) =>
    within(READ_LIMIT_MS, "the screenshot", () =>
      (async () => {
        const session = await page.context().newCDPSession(page)

        try {
          const shot = await session.send("Page.captureScreenshot", {
            format: "webp",
            quality: GALLERY.quality,
            clip: {
              x: 0,
              y: 0,
              width: GALLERY.width,
              height: GALLERY.height,
              scale: GALLERY.scale,
            },
          })

          return Buffer.from(shot.data, "base64")
        } finally {
          await session.detach()
        }
      })(),
    ).then(
      (bytes) => new Uint8Array(bytes),
      () => undefined,
    )

  const screenshot =
    target.screenshot === "none" || current === undefined
      ? undefined
      : target.screenshot === "gallery"
        ? await gallery(current.page)
        : await within(READ_LIMIT_MS, "the screenshot", () =>
            current.page.screenshot({ type: "jpeg", quality: 60 }),
          ).then(
            (bytes) => new Uint8Array(bytes),
            () => undefined,
          )

  const dark =
    target.screenshot === "gallery" && current !== undefined && screenshot !== undefined
      ? await within(READ_LIMIT_MS, "switching the page to dark", async () => {
          await current.page.emulateMedia({ colorScheme: "dark" })
          await current.page.evaluate(DARK_SETTLE)
          await current.page
            .waitForLoadState("networkidle", { timeout: 1000 })
            .catch(() => undefined)
        }).then(
          () => gallery(current.page),
          () => undefined,
        )
      : undefined

  const ask = target.card

  const cards: CardsDrawn =
    ask === null
      ? { kind: "none", why: "none asked for" }
      : current === undefined || screenshot === undefined || target.screenshot !== "gallery"
        ? { kind: "none", why: "no picture to draw them from" }
        : await within(CARDS_LIMIT_MS, "drawing the link preview cards", async () => {
            const theme = decodeTheme(await current.page.evaluate(THEME_COLOR))

            return renderCards(
              browser,
              ask,
              { title: summary.title, theme: Option.getOrNull(theme) },
              screenshot,
            )
          }).then(
            (drawn): CardsDrawn => ({ kind: "drawn", cards: drawn }),
            (cause: unknown): CardsDrawn => ({
              kind: "none",
              why: `drawing them failed: ${reason(cause)}`,
            }),
          )

  lap("pictures")

  const share = Math.max(tabs.length, 1)

  const people = tabs.map((tab, index) => {
    const seenThere = summaries[index] ?? EMPTY

    return {
      name: tab.who,
      email: tab.email,
      url: urlShown(tab.page.url(), new URL(target.root)),
      title: seenThere.title,
      text: seenThere.text.slice(0, Math.floor(MAX_TEXT / share)),
      controls: seenThere.controls.slice(0, Math.floor(MAX_CONTROLS / share)),
    }
  })

  const withPeople = target.people.length > 0
  const denied: Array<CheckReport["denied"][number]> = []
  const expectedDenials: Array<CheckReport["denied"][number]> = []
  const failed = [...seen.failed]

  for (const tab of tabs) {
    for (const request of tab.requests) {
      const { status: got, rule } = request

      if (got === null || got < 400 || got === BLOCKED_STATUS) continue

      if (rule !== undefined) {
        const person = tab.who === "" ? null : tab.who

        ;(request.expected ? expectedDenials : denied).push({
          person,
          method: request.method,
          path: request.path,
          rule,
        })
      } else if (!request.expected) {
        push(failed, `${prefix(tab.who)}${got} ${request.method} ${request.path}`)
      }
    }
  }

  const base: CheckReport = {
    url: current === undefined ? "" : urlShown(current.page.url(), new URL(target.root)),
    status,
    title: summary.title,
    errors: seen.errors,
    console: seen.console,
    dialogs: seen.dialogs,
    failedRequests: failed,
    denied,
    expectedDenials,
    blocked: seen.blocked,
    refusedTools: seen.refusedTools,
    steps,
    text: withPeople ? "" : summary.text,
    controls: withPeople ? [] : summary.controls,
    incomplete,
    ms: Date.now() - started,
  }

  const report: CheckReport = withPeople ? { ...base, people } : base

  return { report, screenshot, dark, cards }
}

/** The most a check's steps may take, for `people` signed in, with or without the app's tools: what check_app books (mcp.ts). */
export class Checker extends Context.Service<
  Checker,
  {
    readonly check: (target: CheckTarget) => Effect.Effect<Checked, Refused>
  }
>()("openbelt/Checker") {
  /** Over a headless Chrome the platform starts itself (runtime/browser.ts). */
  static readonly layer = Layer.effect(
    Checker,
    Effect.gen(function* () {
      const chrome = yield* Runtime.Browser

      const cookies = sessions(yield* SESSION_SECRET.pipe(Effect.orDie))

      return {
        check: Effect.fn("Checker.check")(function* (target: CheckTarget) {
          const started = Date.now()
          const timed = phases()
          const until = started + SESSION_MS
          const urls = [new URL(target.root).origin, ...target.others]

          const limited = target.apps === null ? {} : { apps: [...target.apps] }

          const sealFor = (who: Person | undefined) =>
            Effect.forEach(urls, (url) => {
              const host = new URL(url).host

              return Effect.map(
                cookies.seal(
                  who === undefined
                    ? { kind: "check", host, until, by: target.by, ...limited }
                    : {
                        kind: "test",
                        email: who.email,
                        name: who.shown,
                        groups: who.groups,
                        host,
                        until,
                        by: target.by,
                        ...limited,
                      },
                ),
                (value) => ({ url, value }),
              )
            })

          const sealed: Sealed = {
            ...target,
            cookies: yield* sealFor(undefined),
            people: yield* Effect.forEach(target.people, (person) =>
              Effect.map(sealFor(person), (sealedFor) => ({ ...person, cookies: sealedFor })),
            ),
          }

          // A browser launch can fail for reasons of its own (a busy machine is slow to start Chrome):
          // two more tries, 2s then 4s apart, before refusing.
          const owned = yield* Effect.tryPromise({
            try: () => within(20_000, "starting the browser", () => chrome.launch()),
            catch: (cause) =>
              new Refused({
                message: `check_app couldn't start a browser (${reason(cause)}). Try again in a minute.`,
              }),
          }).pipe(
            Effect.tapError((e) => Effect.logWarning(`check_app: ${e.message}; trying again`)),
            Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }),
          )

          timed.lap("launch")

          const opened = Date.now()

          const checked = yield* Effect.promise(async (): Promise<Omit<Checked, "ms">> => {
            try {
              return await inspect(owned.browser, sealed, opened, timed.lap)
            } catch (cause) {
              const report: CheckReport = {
                url: target.root + target.path,
                status: null,
                title: "",
                errors: [`the browser stopped: ${reason(cause)}`],
                console: [],
                dialogs: [],
                failedRequests: [],
                denied: [],
                expectedDenials: [],
                blocked: [],
                refusedTools: [],
                steps: [],
                text: "",
                controls: [],
                incomplete: null,
                ms: Date.now() - started,
              }

              return {
                report,
                screenshot: undefined,
                dark: undefined,
                cards: { kind: "none", why: "the browser stopped" },
              }
            } finally {
              await owned.close()
              timed.lap("close")
            }
          })

          const ms = Date.now() - started

          // One line per check saying where its time went (bench: scripts/check-app-bench.ts).
          yield* Effect.logInfo(
            `check_app: ${ms} ms (${Object.entries(timed.spent)
              .map(([phase, spent]) => `${phase} ${spent}`)
              .join(", ")})`,
          ).pipe(Effect.annotateLogs({ trace: target.trace, phases: timed.spent }))

          return { ...checked, ms }
          // The object that asked (a shot is an app's own callback) gives up its turn while the browser works: the pages it opens
          // are requests to that object and to the people's MCP instances, and they'd wait for a turn the check holds.
        }, Runtime.idle),
      }
    }),
  )
}
