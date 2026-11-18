import componentsCss from "../../../brand/css/components.css" with { type: "text" }
import tokensCss from "../../../brand/css/tokens.css" with { type: "text" }
import { CONNECTION_LABELS } from "./home.ts"
import { TOAST_CSS } from "./toast.ts"
import wordmarkSvg from "../../../brand/logo/openbelt.svg" with { type: "text" }

const SHEET_CSS = (() => {
  const blocks = [...tokensCss.matchAll(/:root(?:\[data-theme="light"\])? \{([^}]*)\}/g)]
  const dark = blocks[0]?.[1] ?? ""
  const light = blocks[1]?.[1] ?? ""

  const scrim = [...componentsCss.matchAll(/^\.scrim(?:\.open)? \{[^}]*\}/gm)]
    .map((m) => m[0])
    .join("\n")

  return `:host { all: initial; ${dark} }
@media (prefers-color-scheme: light) { :host { ${light} } }
${scrim}
.scrim { z-index: 2147483647; background: color-mix(in srgb, var(--openbelt-color-neutral) 64%, transparent); }
@media (prefers-color-scheme: light) { .scrim { background: color-mix(in srgb, var(--openbelt-color-primary) 32%, transparent); } }
${TOAST_CSS}
.toast { z-index: 2147483647; }
.toast:focus { outline: none; }`
})()

const TEMPLATE = `// OpenBelt SDK: import { db, env, appUrl, theme, tools } from "/sdk.js"
const workspaceHost = __WORKSPACE_HOST__
// An app's host is <app>--<workspace host>, on the workspace's host and on the public one (<app>--<workspace>.<public host>).
const appSeparator = "--"
const own = location.host.endsWith(appSeparator + workspaceHost) ? location.host.slice(0, -workspaceHost.length - appSeparator.length) : null
const [, under, named] = location.pathname.split("/")

const SDK_VERSION = "__SDK_VERSION__"

export const env = under === "_preview" && named ? decodeURIComponent(named) : null

const previewPath = env === null ? "" : "/_preview/" + encodeURIComponent(env)

const request = async (base, path, init = {}) => {
  const method = init.method || "GET"
  const label = method + " " + (base === previewPath ? "" : base) + path
  const fail = (error) => {
    error.openbeltReported = true
    globalThis.__openbelt?.report(label + " failed: " + error.message, error.trace)

    return error
  }
  let response

  try {
    // A busy OpenBelt refuses a request before doing any of it (x-openbelt-busy), so any request, a write too, can be sent again: after
    // Retry-After, spread out so the pages it refused don't all come back at once, three times at most.
    for (let attempt = 0; ; attempt++) {
      response = await (init.send || fetch)(base + path, init)

      if (response.status !== 503 || !response.headers.get("x-openbelt-busy") || attempt >= 3) break

      const after = Number(response.headers.get("retry-after")) || 1

      await new Promise((resolve) => setTimeout(resolve, after * 1000 * (0.5 + Math.random()) * (attempt + 1)))
    }
  } catch (cause) {
    if (cause && cause.name === "AbortError") {
      const error = new Error(label + " was cancelled (its signal aborted) (trace none)")

      error.status = 0
      error.code = "aborted"
      error.trace = null
      throw error
    }

    const error = new Error("couldn't reach OpenBelt: " + cause.message + " (trace none)")

    error.status = 0
    error.code = "unreachable"
    error.trace = null
    throw fail(error)
  }

  const trace = response.headers.get("x-openbelt-trace")
  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const message = (body && body.error) || response.status + " " + response.statusText
    const rule = response.status === 403 && body && body.rule
    const hint = body && body.hint ? " (" + body.hint + ")" : ""
    const error = new Error(message + hint + " (trace " + trace + ")")

    error.status = response.status
    error.code = (body && body.code) || null
    error.trace = trace

    if (body && body.seq !== undefined) error.seq = body.seq

    if (rule) {
      error.rule = rule
      error.openbeltReported = true
      throw error
    }

    throw fail(error)
  }

  return body
}

const queryOf = (options) => {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value))
  }

  return query.size > 0 ? "?" + query : ""
}

const json = (method, data) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data),
})

const connections = new Map()

const reloadForNewSdk = async () => {
  const health = await fetch("/_health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null), () => null)
  const served = health?.sdk

  if (served === undefined || served === SDK_VERSION) return

  try {
    if (sessionStorage.getItem("openbelt-sdk-reload") === served) return

    sessionStorage.setItem("openbelt-sdk-reload", served)
  } catch {
    return
  }

  location.reload()
}

const connection = (base) => {
  const existing = connections.get(base)

  if (existing) return existing

  const conn = { listeners: new Map(), queries: new Map(), socket: null, seq: null, firstSeq: null, replayed: null, ready: null, opened: false, hiddenMs: null, parked: false }
  let markReady
  let hiding = null

  conn.ready = new Promise((resolve) => (markReady = resolve))
  connections.set(base, conn)

  const connect = () => {
    if (conn.parked) return

    const scheme = location.protocol === "https:" ? "wss:" : "ws:"
    // batch=1: messages sent together arrive as one {type: "batch", messages} frame (a replay of thousands, as few frames).
    const since = conn.seq === null ? "?batch=1" : "?batch=1&since=" + conn.seq
    const socket = new WebSocket(scheme + "//" + location.host + base + "/_ws" + since)

    conn.socket = socket

    conn.replayed = conn.replayed ?? new Set()

    // A socket that stops hearing anything is ended and opened again with ?since=: the server answers "ping" with "pong" without
    // waking the app, so silence means the connection is gone without a close (an engine dropping a stream it cancelled, a proxy
    // forgetting it). The pings also keep a proxy that closes idle connections (a minute, often) from closing this one.
    let heard = Date.now()

    const beat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return

      if (Date.now() - heard > 40_000) return socket.close(4000, "silent")

      socket.send("ping")
    }, 15_000)

    socket.onmessage = (event) => {
      heard = Date.now()

      if (event.data === "pong") return

      const parsed = JSON.parse(event.data)

      for (const message of parsed.type === "batch" ? parsed.messages : [parsed]) handle(message)
    }

    const handle = (message) => {
      if (message.type === "hello") {
        // Where the first socket's live changes start: a later socket asks for what it missed with ?since=, so only the first can leave a gap.
        conn.firstSeq ??= message.seq
        conn.seq = Math.max(conn.seq ?? 0, message.seq)
        conn.hiddenMs = message.hiddenMs ?? null
        conn.replayed = null
        markReady()

        if (base === previewPath && conn.opened) reloadForNewSdk()

        conn.opened = true

        for (const [sub, query] of conn.queries) socket.send(JSON.stringify({ type: query.kind === "aggregate" ? "watch_aggregate" : "watch", sub, name: query.name, input: query.input }))
      }

      if (message.type === "query") conn.queries.get(message.sub)?.on(message)

      if (message.type === "reload" && base === previewPath) location.reload()

      if (message.type === "change") {
        if (conn.replayed !== null) {
          if (conn.replayed.has(message.doc.seq)) return

          conn.replayed.add(message.doc.seq)
        } else {
          conn.seq = Math.max(conn.seq ?? 0, message.doc.seq)
        }

        for (const listener of conn.listeners.get(message.doc.collection) ?? []) {
          listener({ op: message.op, doc: message.doc })
        }
      }
    }
    socket.onclose = (event) => {
      clearInterval(beat)

      if (event.code === 4403) return location.reload()

      if (!conn.parked) setTimeout(connect, 1000)
    }
  }

  // An open socket keeps its app in memory on the server. A tab hidden for a while (hiddenMs, from the hello) lets it go; shown
  // again, it connects with ?since= and gets what changed meanwhile, as after a dropped connection.
  document.addEventListener("visibilitychange", () => {
    clearTimeout(hiding)

    if (document.visibilityState === "hidden") {
      if (conn.hiddenMs === null) return

      hiding = setTimeout(() => {
        conn.parked = true
        conn.socket?.close(1000, "the tab is hidden")
      }, conn.hiddenMs)

      return
    }

    if (conn.parked) {
      conn.parked = false
      connect()
    }
  })

  connect()

  return conn
}

if (own !== null) connection(previewPath)

const applied = (docs, { op, doc }) => {
  const i = docs.findIndex((d) => d.id === doc.id)

  if (i !== -1 && docs[i].seq >= doc.seq) return null

  if (op === "delete") return i === -1 ? null : docs.toSpliced(i, 1)

  return i === -1 ? [doc, ...docs] : docs.with(i, doc)
}

const appApi = (base) => ({
  collection(name) {
    const path = "/_db/" + name
    const one = (id) => path + "/" + encodeURIComponent(id)

    const subscribe = (listener) => {
      const { listeners } = connection(base)

      listeners.set(name, [...(listeners.get(name) ?? []), listener])

      return () => listeners.set(name, (listeners.get(name) ?? []).filter((l) => l !== listener))
    }

    const list = (options) => request(base, path + queryOf(options))

    return {
      add: (data) => request(base, path, json("POST", data)),
      get: (id) => request(base, one(id), { headers: { "x-openbelt-missing": "null" } }),
      set: (id, data, options) => request(base, one(id) + queryOf(options), json("PUT", data)),
      update: (id, patch, options) => request(base, one(id) + queryOf(options), json("PATCH", patch)),
      delete: (id, options) => request(base, one(id) + queryOf(options), { method: "DELETE" }),
      list,
      subscribe,
      watch(listener, options = {}) {
        const onError =
          options.onError ?? ((error) => console.error("watch(" + JSON.stringify(name) + ") failed:", error))
        let docs = null
        let early = []
        let stopped = false

        const off = subscribe((change) => {
          if (docs === null) return void early.push(change)

          const next = applied(docs, change)

          if (next !== null && !stopped) {
            docs = next
            listener(docs, change)
          }
        })

        // Every document, and the data's seq when the read began (x-openbelt-seq on its first page).
        const read = async () => {
          let all = []
          let cursor = null
          let seq = null

          const send = (url, init) =>
            fetch(url, init).then((response) => {
              seq ??= Number(response.headers.get("x-openbelt-seq") ?? NaN)

              return response
            })

          do {
            const page = await request(base, path + queryOf({ limit: 1000, cursor }), { send })

            all = all.concat(page.docs)
            cursor = page.cursor
          } while (cursor !== null && !stopped)

          for (const change of early) all = applied(all, change) ?? all

          early = []

          return { all, seq }
        }

        const same = (a, b) => a.length === b.length && a.every((doc, i) => doc.id === b[i].id && doc.seq === b[i].seq)

        // The read goes out while the socket opens, not after its hello: the page shows its documents a few round trips sooner. A
        // change made between the read and the first socket's hello reaches neither, so then it reads once more.
        const load = async () => {
          const conn = connection(base)
          const first = await read()

          if (stopped) return

          docs = first.all
          listener(docs, null)

          await conn.ready

          if (stopped || first.seq >= conn.firstSeq) return

          const shown = docs

          docs = null

          const again = await read()

          docs = again.all

          if (!stopped && !same(shown, docs)) listener(docs, null)
        }

        load().catch((error) => {
          off()

          if (!stopped) onError(error)
        })

        return () => {
          stopped = true
          off()
        }
      },
    }
  },
  collections: () => request(base, "/_db"),
  // The app's function (functions/<name>.js), run on OpenBelt for whoever is viewing: its result.
  // key: an idempotency key (the same key within 24h answers from the first run that went ok).
  fn: (name, input = null, options = {}) => {
    const init = json("POST", input)

    if (options.key !== undefined) init.headers["x-openbelt-key"] = String(options.key)

    return request(base, "/_fn/" + encodeURIComponent(name), init)
  },
  // A query (openbelt.json kind "query"): await it for its result once, or watch(cb) for every
  // result as the data it reads changes. Refused when the function isn't a query.
  query: (name, input = null) => liveValue(base, name, input, "query"),
  aggregate: (name) => liveValue(base, name, null, "aggregate"),
})

const liveValue = (base, name, input, kind) => {
  let once = null
  const given = input === undefined ? null : JSON.parse(JSON.stringify(input))
  const run = () => {
    if (once !== null) return once
    if (kind === "aggregate") return once = request(base, "/_aggregates/" + encodeURIComponent(name))
    const init = json("POST", given)

    init.headers["x-openbelt-kind"] = "query"
    once = request(base, "/_fn/" + encodeURIComponent(name), init)
    return once
  }

  return {
    then: (ok, fail) => run().then(ok, fail),
    catch: (fail) => run().catch(fail),
    finally: (done) => run().finally(done),
    watch(listener, options = {}) {
      const onError =
        options.onError ?? ((error) => console.error(kind + "(" + JSON.stringify(name) + ").watch failed:", error))
      const conn = connection(base)
      const sub = "q" + ++watchCount
      let last = null

      conn.queries.set(sub, {
        name,
        kind,
        input: given,
        on(message) {
          if (message.error !== undefined) {
            const error = Object.assign(new Error(message.error), { code: message.code, status: null, trace: null })

            globalThis.__openbelt?.report(kind + "(" + JSON.stringify(name) + ").watch failed: " + message.error, null)
            last = null
            return void onError(error)
          }

          const text = JSON.stringify(message.result)

          if (text === last) return

          last = text
          listener(message.result)
        },
      })

      if (conn.socket?.readyState === 1) conn.socket.send(JSON.stringify({ type: kind === "aggregate" ? "watch_aggregate" : "watch", sub, name, input: given }))

      return () => {
        conn.queries.delete(sub)

        if (conn.socket?.readyState === 1) conn.socket.send(JSON.stringify({ type: "unwatch", sub }))
      }
    },
  }
}

let watchCount = 0

const ownApi = appApi(previewPath)
let viewer = null

const inEnv = env === null
  ? new Set()
  : await fetch("/_apps?env=" + encodeURIComponent(env))
      .then((r) => (r.ok ? r.json() : []))
      .then((apps) => new Set(apps.filter((a) => a.env !== null).map((a) => a.app)))
      .catch(() => new Set([own]))

/** A page of an app (this one, or another), on its own host: in this page's environment when it's there. */
export const appUrl = (name, path = "") => {
  const page = String(path).replace(/^\\//, "")
  const origin = location.protocol + "//" + name + appSeparator + workspaceHost

  return origin + (name === own || inEnv.has(name) ? previewPath : "") + "/" + page
}

/**
 * The person's OpenBelt theme, "light" or "dark", which OpenBelt also puts on the page's root as data-theme before it paints (unless
 * the page has its own). watch(listener) calls it now and on each change, and returns a stop function.
 */
export const theme = {
  get current() {
    return globalThis.__openbeltTheme?.() ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  },
  watch(listener) {
    const changed = () => listener(theme.current)

    addEventListener("openbelt:theme", changed)
    changed()

    return () => removeEventListener("openbelt:theme", changed)
  },
}

// fetch can't tell how much of a body has gone out, so an upload whose page wants to know goes by XMLHttpRequest, answering as
// fetch would (a Response, or a rejection: TypeError when nothing answered, AbortError when its signal aborted).
const sendWithProgress = (onProgress) => (url, init) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.open(init.method, url)
    for (const [key, value] of Object.entries(init.headers || {})) xhr.setRequestHeader(key, value)
    xhr.upload.onprogress = (event) => onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : init.body.size })
    xhr.onload = () => {
      const headers = new Headers()

      for (const line of xhr.getAllResponseHeaders().trim().split("\\n")) {
        const at = line.indexOf(":")

        if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim())
      }

      resolve(new Response(xhr.status === 204 ? null : xhr.responseText, { status: xhr.status, headers }))
    }
    xhr.onerror = () => reject(new TypeError("the connection failed"))
    xhr.onabort = () => reject(new DOMException("the upload was cancelled", "AbortError"))

    if (init.signal) {
      if (init.signal.aborted) return xhr.onabort()

      init.signal.addEventListener("abort", () => xhr.abort(), { once: true })
    }

    xhr.send(init.body)
  })

export const files = {
  async put(blob, { name, onProgress, signal } = {}) {
    const named = name ?? blob.name
    const headers = { "content-type": blob.type || "application/octet-stream" }

    if (named) headers["x-openbelt-file-name"] = encodeURIComponent(named)

    return await request(previewPath, "/_files", {
      method: "POST",
      body: blob,
      headers,
      signal,
      send: onProgress ? sendWithProgress(onProgress) : undefined,
    })
  },
  async delete(id) {
    await request(previewPath, "/_files/" + encodeURIComponent(id), { method: "DELETE" })
  },
}

export const db = {
  ...ownApi,
  app(name) {
    if (name === own) return ownApi

    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(name))) {
      throw new Error("db.app(" + JSON.stringify(name) + "): an app name is lowercase letters, digits and dashes, like \\"lunch\\"; db.apps() lists them")
    }

    return appApi("/a/" + name + previewPath)
  },
  apps: () => request("", "/_apps" + (env === null ? "" : "?env=" + encodeURIComponent(env))),
  // Asked once per page load unless refresh.
  me(options = {}) {
    if (viewer === null || options.refresh) {
      viewer = fetch("/_me" + (env === null ? "" : "?env=" + encodeURIComponent(env)), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
    }

    return viewer
  },
}

// Connection tools: the ones this app's openbelt.json "tools" binds, called on this host (so OpenBelt
// knows which app's page it is) as whoever is viewing. OpenBelt decides and holds every token.
const LABELS = ${JSON.stringify(Object.fromEntries(CONNECTION_LABELS))}
const labelOf = (name) => LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
const withReturn = (url) => (url ? url + "&return=" + encodeURIComponent(location.href) : null)
const sheetShown = new Set()

// One sheet per page: it names every account this app still needs the viewer to review (tools.list()), the refused one first.
const showSheet = async (error) => {
  const connection = String(error.tool).split(".")[0]

  if (!error.url || sheetShown.size > 0 || !document.body) return

  sheetShown.add(connection)

  const listed = await fetch(previewPath + "/_tools", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  const waiting = ((listed && listed.tools) || [])
    .filter((t) => t.code === "needs_token" || t.code === "needs_consent")
    .map((t) => String(t.tool).split(".")[0])
  const labels = [...new Set([connection, ...waiting])].map(labelOf)
  const accounts = labels.length === 1 ? labels[0] : labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1]

  const host = document.createElement("openbelt-sheet")
  const root = host.attachShadow({ mode: "closed" })
  const el = (tag, className, text) => {
    const node = document.createElement(tag)

    if (className) node.className = className
    if (text) node.textContent = text

    return node
  }
  const style = el("style", "", ${JSON.stringify(SHEET_CSS)})
  const sheet = el("div", "toast")
  const brand = el("div", "toast-brand")
  const title = el("h2", "toast-title", "This app wants to use your " + accounts)
  const scrim = el("div", "scrim")
  const actions = el("div", "toast-actions")
  const go = el("a", "btn btn-primary", "Review")
  const later = el("button", "btn btn-ghost", "Not now")

  sheet.setAttribute("role", "dialog")
  sheet.setAttribute("aria-modal", "true")
  sheet.tabIndex = -1
  sheet.setAttribute("aria-label", title.textContent)
  scrim.setAttribute("aria-hidden", "true")
  brand.innerHTML = ${JSON.stringify(wordmarkSvg.trim())}
  go.href = error.url
  go.target = "_top"
  go.rel = "noopener"
  later.type = "button"
  const close = () => {
    host.remove()
    removeEventListener("keydown", onKey, true)
  }
  const onKey = (e) => {
    if (e.key === "Escape") close()
  }
  // Following the link leaves the page: the button shows it's on its way.
  go.onclick = () => go.setAttribute("aria-busy", "true")
  later.onclick = close
  scrim.onclick = close
  addEventListener("keydown", onKey, true)
  actions.append(go, later)
  sheet.append(brand, title, actions)
  root.append(style, scrim, sheet)
  document.body.append(host)
  requestAnimationFrame(() => scrim.classList.add("open"))
  sheet.focus({ preventScroll: true })
}

export const tools = {
  /**
   * Call "<connection>.<tool>" with input: resolves to { text, content, structuredContent, ms, runsAs, trace }.
   * options.fields: only those parts of the answer, by dot path (["name", "types.type.name"]).
   */
  async call(name, input = {}, options = {}) {
    const label = "tools.call(" + JSON.stringify(name) + ")"
    const failed = (message, fields) => Object.assign(new Error(message), { tool: name, url: null, openbeltReported: true }, fields)
    let response

    try {
      response = await fetch(previewPath + "/_tools/call", json("POST", options.fields ? { tool: name, input, fields: options.fields } : { tool: name, input }))
    } catch (cause) {
      const error = failed("couldn't reach OpenBelt: " + cause.message + " (trace none)", {
        status: 0,
        code: "unreachable",
        fix: "Check the network and try again",
        trace: null,
      })

      globalThis.__openbelt?.report(label + " failed: " + error.message, null)
      throw error
    }

    const trace = response.headers.get("x-openbelt-trace")
    const body = await response.json().catch(() => null)

    if (!response.ok || body === null) {
      const error = failed(((body && body.error) || response.status + " " + response.statusText) + " (trace " + trace + ")", {
        status: response.status,
        code: (body && body.code) || null,
        fix: (body && body.fix) || null,
        url: withReturn(body && body.url),
        setting: (body && body.setting) || null,
        trace,
      })

      if ((error.code === "needs_token" || error.code === "needs_consent") && options.prompt !== false) showSheet(error)

      // A refusal is an answer, already in app_logs with its trace; a failure is reported too.
      if (response.status >= 500) globalThis.__openbelt?.report(label + " failed: " + error.message, trace)

      throw error
    }

    if (body.isError) {
      throw failed(name + " failed: " + (body.text || "the tool reported an error") + " (trace " + trace + ")", {
        status: 200,
        code: "tool_error",
        fix: "Check the input against the tool's input schema (tools.list() has it)",
        trace,
        result: body,
      })
    }

    return body
  },
  /** The tools this app binds, each as the viewer may use it: usable, or why not (code, message, fix, url). */
  async list() {
    const body = await request(previewPath, "/_tools")

    return body.tools.map((t) => (t.url ? { ...t, url: withReturn(t.url) } : t))
  },
}
`

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)

  return (hash >>> 0).toString(16).padStart(8, "0")
}

export const SDK_VERSION = fnv1a(TEMPLATE)

export const SDK_JS = TEMPLATE.replace("__SDK_VERSION__", SDK_VERSION)
