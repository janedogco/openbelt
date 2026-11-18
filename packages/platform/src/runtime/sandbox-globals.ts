// What a sandbox has besides the language (QuickJS has the language only): the web globals the harnesses and functions use, made
// of a few host primitives (`__h`, sandbox-process.ts; taken off the global before any of a function's code runs). Evaluated once in
// each box, as a script.
export const GLOBALS = String.raw`;(() => {
  const h = globalThis.__h
  delete globalThis.__h
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, enumerable: false, value })

  // console: the harness replaces log/info/debug/warn/error; the rest do nothing
  define("console", { log() {}, info() {}, debug() {}, warn() {}, error() {}, trace() {}, dir() {}, table() {}, time() {}, timeEnd() {}, assert() {} })

  // timers: the host fires them; a context is dropped when its run ends, and its timers with it
  const timers = new Map()
  define("__fire", (id) => {
    const t = timers.get(id)
    if (t === undefined) return
    if (t.every === undefined) timers.delete(id)
    else t.handle = h.timer(t.every, id)
    t.fn(...t.args)
  })
  let nextTimer = 1
  const startTimer = (fn, ms, args, repeat) => {
    if (typeof fn !== "function") throw new TypeError("a timer needs a function")
    const id = nextTimer++
    const wait = Math.max(0, Number(ms) || 0)
    timers.set(id, { fn, args, every: repeat ? Math.max(1, wait) : undefined })
    h.timer(wait, id)
    return id
  }
  const stopTimer = (id) => {
    if (timers.delete(id)) h.clear(id)
  }
  define("setTimeout", (fn, ms, ...args) => startTimer(fn, ms, args, false))
  define("setInterval", (fn, ms, ...args) => startTimer(fn, ms, args, true))
  define("clearTimeout", stopTimer)
  define("clearInterval", stopTimer)
  define("setImmediate", (fn, ...args) => startTimer(fn, 0, args, false))
  define("queueMicrotask", (fn) => void Promise.resolve().then(fn))
  define("performance", { now: () => h.now(), timeOrigin: Date.now() })

  // bytes
  const bytesOf = (v) => {
    if (v instanceof Uint8Array) return v
    if (v instanceof ArrayBuffer) return new Uint8Array(v)
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    throw new TypeError("expected bytes (an ArrayBuffer or a typed array)")
  }
  const bufferOf = (v) => {
    const b = bytesOf(v)
    return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer
  }
  class TextEncoder {
    get encoding() {
      return "utf-8"
    }
    encode(s = "") {
      // a leading character, dropped by the host: a string crossing to it loses a leading byte-order mark (QuickJS's transfer decodes it)
      return new Uint8Array(h.enc("x" + String(s)))
    }
  }
  class TextDecoder {
    constructor(label = "utf-8", options = {}) {
      if (!/^utf-?8$/i.test(String(label))) throw new RangeError("only utf-8 is supported")
      this.fatal = options.fatal === true
    }
    get encoding() {
      return "utf-8"
    }
    decode(v) {
      return v === undefined ? "" : h.dec(bufferOf(v), this.fatal)
    }
  }
  define("TextEncoder", TextEncoder)
  define("TextDecoder", TextDecoder)
  define("btoa", (s) => {
    s = String(s)
    const b = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c > 255) throw new Error("btoa: a character is outside Latin1")
      b[i] = c
    }
    return h.b64enc(b.buffer, false)
  })
  define("atob", (s) => {
    const b = new Uint8Array(h.b64dec(String(s).replace(/[\t\n\f\r ]/g, ""), false))
    let out = ""
    for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i])
    return out
  })
  const proto = Uint8Array.prototype
  if (proto.toBase64 === undefined)
    Object.defineProperty(proto, "toBase64", { configurable: true, writable: true, value(o = {}) { return h.b64enc(bufferOf(this), o.alphabet === "base64url", o.omitPadding === true) } })
  if (Uint8Array.fromBase64 === undefined)
    Object.defineProperty(Uint8Array, "fromBase64", { configurable: true, writable: true, value: (s, o = {}) => new Uint8Array(h.b64dec(String(s), o.alphabet === "base64url")) })
  if (proto.toHex === undefined)
    Object.defineProperty(proto, "toHex", { configurable: true, writable: true, value() { let s = ""; for (const b of this) s += b.toString(16).padStart(2, "0"); return s } })
  if (Uint8Array.fromHex === undefined)
    Object.defineProperty(Uint8Array, "fromHex", { configurable: true, writable: true, value: (s) => { const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out } })

  // URL, URLSearchParams
  const encodeForm = (s) => encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  const decodeForm = (s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "))
    } catch {
      return s
    }
  }
  class URLSearchParams {
    #list = []
    #owner = undefined
    constructor(init = "") {
      if (typeof init === "string") this.#parse(init)
      else if (init instanceof URLSearchParams) this.#list = [...init]
      else if (init !== null && typeof init === "object") {
        const pairs = Symbol.iterator in init ? [...init] : Object.entries(init)
        for (const [k, v] of pairs) this.#list.push([String(k), String(v)])
      }
    }
    #parse(s) {
      this.#list = []
      for (const part of s.replace(/^\?/, "").split("&")) {
        if (part === "") continue
        const at = part.indexOf("=")
        this.#list.push(at < 0 ? [decodeForm(part), ""] : [decodeForm(part.slice(0, at)), decodeForm(part.slice(at + 1))])
      }
    }
    static __bind(params, owner) {
      params.#owner = owner
      return params
    }
    static __reset(params, search) {
      params.#parse(search)
    }
    #changed() {
      this.#owner?.__setSearch(this.toString())
    }
    get size() {
      return this.#list.length
    }
    append(k, v) {
      this.#list.push([String(k), String(v)])
      this.#changed()
    }
    delete(k, v) {
      this.#list = this.#list.filter(([a, b]) => a !== String(k) || (v !== undefined && b !== String(v)))
      this.#changed()
    }
    get(k) {
      return this.#list.find(([a]) => a === String(k))?.[1] ?? null
    }
    getAll(k) {
      return this.#list.filter(([a]) => a === String(k)).map(([, b]) => b)
    }
    has(k, v) {
      return this.#list.some(([a, b]) => a === String(k) && (v === undefined || b === String(v)))
    }
    set(k, v) {
      const at = this.#list.findIndex(([a]) => a === String(k))
      if (at < 0) this.#list.push([String(k), String(v)])
      else {
        this.#list[at] = [String(k), String(v)]
        this.#list = this.#list.filter(([a], i) => i <= at || a !== String(k))
      }
      this.#changed()
    }
    sort() {
      this.#list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      this.#changed()
    }
    forEach(fn, self) {
      for (const [k, v] of this.#list) fn.call(self, v, k, this)
    }
    keys() {
      return this.#list.map(([k]) => k)[Symbol.iterator]()
    }
    values() {
      return this.#list.map(([, v]) => v)[Symbol.iterator]()
    }
    entries() {
      return this.#list.map(([k, v]) => [k, v])[Symbol.iterator]()
    }
    [Symbol.iterator]() {
      return this.entries()
    }
    toString() {
      return this.#list.map(([k, v]) => encodeForm(k) + "=" + encodeForm(v)).join("&")
    }
  }
  const FIELDS = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"]
  const partsOf = new WeakMap()
  const paramsOf = new WeakMap()
  class URL {
    constructor(url, base) {
      partsOf.set(this, JSON.parse(h.url(String(url), base === undefined ? undefined : String(base))))
      paramsOf.set(this, URLSearchParams.__bind(new URLSearchParams(partsOf.get(this).search), this))
    }
    static canParse(url, base) {
      try {
        new URL(url, base)
        return true
      } catch {
        return false
      }
    }
    static parse(url, base) {
      try {
        return new URL(url, base)
      } catch {
        return null
      }
    }
    __setSearch(search) {
      partsOf.set(this, JSON.parse(h.urlSet(partsOf.get(this).href, "search", search)))
    }
    get searchParams() {
      return paramsOf.get(this)
    }
    toString() {
      return partsOf.get(this).href
    }
    toJSON() {
      return partsOf.get(this).href
    }
  }
  for (const field of FIELDS) {
    Object.defineProperty(URL.prototype, field, {
      configurable: true,
      get() {
        return partsOf.get(this)?.[field]
      },
      set(value) {
        if (field === "origin") return
        partsOf.set(this, JSON.parse(h.urlSet(partsOf.get(this).href, field, String(value))))
        if (field === "href" || field === "search") URLSearchParams.__reset(paramsOf.get(this), partsOf.get(this).search)
      },
    })
  }
  define("URL", URL)
  define("URLSearchParams", URLSearchParams)

  // Headers, Blob, Request, Response
  class Headers {
    #map = new Map()
    constructor(init) {
      if (init instanceof Headers) init.forEach((v, k) => this.append(k, v))
      else if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v)
      else if (init !== null && typeof init === "object") for (const [k, v] of Object.entries(init)) this.append(k, v)
    }
    append(k, v) {
      k = String(k).toLowerCase()
      v = String(v)
      const had = this.#map.get(k)
      this.#map.set(k, had === undefined ? v : k === "set-cookie" ? had + "\n" + v : had + ", " + v)
    }
    set(k, v) {
      this.#map.set(String(k).toLowerCase(), String(v))
    }
    get(k) {
      return this.#map.get(String(k).toLowerCase())?.replace(/\n/g, ", ") ?? null
    }
    getSetCookie() {
      return this.#map.get("set-cookie")?.split("\n") ?? []
    }
    has(k) {
      return this.#map.has(String(k).toLowerCase())
    }
    delete(k) {
      this.#map.delete(String(k).toLowerCase())
    }
    forEach(fn, self) {
      for (const [k, v] of this.entries()) fn.call(self, v, k, this)
    }
    *entries() {
      for (const k of [...this.#map.keys()].sort()) yield [k, this.get(k)]
    }
    *keys() {
      for (const [k] of this.entries()) yield k
    }
    *values() {
      for (const [, v] of this.entries()) yield v
    }
    [Symbol.iterator]() {
      return this.entries()
    }
  }
  define("Headers", Headers)

  class Blob {
    #bytes
    constructor(parts = [], options = {}) {
      const chunks = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Blob ? p.__bytes() : bytesOf(p)))
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      this.#bytes = out
      this.type = String(options.type ?? "").toLowerCase()
    }
    __bytes() {
      return this.#bytes
    }
    get size() {
      return this.#bytes.length
    }
    async text() {
      return new TextDecoder().decode(this.#bytes)
    }
    async arrayBuffer() {
      return this.#bytes.slice().buffer
    }
    async bytes() {
      return this.#bytes.slice()
    }
  }
  define("Blob", Blob)

  // a body as bytes, and the content type it implies
  const bodyOf = (body) => {
    if (body === null || body === undefined) return [null, null]
    if (typeof body === "string") return [new TextEncoder().encode(body), "text/plain;charset=UTF-8"]
    if (body instanceof URLSearchParams) return [new TextEncoder().encode(body.toString()), "application/x-www-form-urlencoded;charset=UTF-8"]
    if (body instanceof Blob) return [body.__bytes(), body.type || null]
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return [bytesOf(body).slice(), null]
    return [new TextEncoder().encode(String(body)), "text/plain;charset=UTF-8"]
  }
  class Body {
    #bytes
    #used = false
    __init(body, headers) {
      const [bytes, type] = bodyOf(body)
      this.#bytes = bytes
      if (type !== null && !headers.has("content-type")) headers.set("content-type", type)
    }
    #take() {
      if (this.#used) return Promise.reject(new TypeError("the body has already been read"))
      this.#used = true
      return Promise.resolve(this.#bytes ?? new Uint8Array(0))
    }
    get body() {
      return this.#bytes === null ? null : { __bytes: this.#bytes }
    }
    get bodyUsed() {
      return this.#used
    }
    async arrayBuffer() {
      return (await this.#take()).slice().buffer
    }
    async bytes() {
      return (await this.#take()).slice()
    }
    async text() {
      return new TextDecoder().decode(await this.#take())
    }
    async json() {
      return JSON.parse(await this.text())
    }
    async blob() {
      return new Blob([await this.#take()], { type: this.headers.get("content-type") ?? "" })
    }
    __peek() {
      return this.#bytes
    }
  }
  const unwrap = (body) => (body !== null && typeof body === "object" && body.__bytes instanceof Uint8Array ? body.__bytes : body)
  class Request extends Body {
    constructor(input, init = {}) {
      super()
      const from = input instanceof Request ? input : undefined
      this.url = from?.url ?? new URL(String(input)).href
      this.method = String(init.method ?? from?.method ?? "GET").toUpperCase()
      this.headers = new Headers(init.headers ?? from?.headers)
      this.signal = init.signal ?? from?.signal ?? null
      this.redirect = init.redirect ?? "follow"
      const body = init.body !== undefined ? init.body : from?.__peek() ?? null
      if (body !== null && (this.method === "GET" || this.method === "HEAD")) throw new TypeError("a GET or HEAD request can't have a body")
      this.__init(unwrap(body), this.headers)
    }
    clone() {
      return new Request(this)
    }
  }
  class Response extends Body {
    constructor(body = null, init = {}) {
      super()
      this.status = init.status ?? 200
      this.statusText = init.statusText ?? ""
      this.headers = new Headers(init.headers)
      this.ok = this.status >= 200 && this.status < 300
      this.type = "default"
      this.url = ""
      this.redirected = false
      this.__init(unwrap(body), this.headers)
    }
    static json(data, init = {}) {
      const headers = new Headers(init.headers)
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
      return new Response(JSON.stringify(data), { ...init, headers })
    }
    static error() {
      return new Response(null, { status: 0 })
    }
    clone() {
      return new Response(this.__peek()?.slice() ?? null, this)
    }
  }
  define("Request", Request)
  define("Response", Response)
  define("fetch", () => Promise.reject(new TypeError("fetch works only while a function runs")))

  class AbortSignal {
    aborted = false
    reason = undefined
    #listeners = []
    addEventListener(_type, fn) {
      this.#listeners.push(fn)
    }
    removeEventListener(_type, fn) {
      this.#listeners = this.#listeners.filter((f) => f !== fn)
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason
    }
    __abort(reason) {
      if (this.aborted) return
      this.aborted = true
      this.reason = reason ?? new Error("This operation was aborted")
      for (const fn of this.#listeners) fn({ type: "abort" })
      this.onabort?.({ type: "abort" })
    }
    static timeout(ms) {
      const s = new AbortSignal()
      setTimeout(() => s.__abort(new Error("The operation timed out")), ms)
      return s
    }
    static abort(reason) {
      const s = new AbortSignal()
      s.__abort(reason)
      return s
    }
  }
  class AbortController {
    signal = new AbortSignal()
    abort(reason) {
      this.signal.__abort(reason)
    }
  }
  define("AbortSignal", AbortSignal)
  define("AbortController", AbortController)

  // structuredClone: the data a function sends and keeps (JSON plus Dates, Maps, Sets, bytes)
  const clone = (v, seen) => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "function" || typeof v === "symbol") throw new TypeError("structuredClone: a " + typeof v + " can't be cloned")
      return v
    }
    if (seen.has(v)) return seen.get(v)
    if (v instanceof Date) return new Date(v.getTime())
    if (v instanceof RegExp) return new RegExp(v.source, v.flags)
    if (ArrayBuffer.isView(v)) return v.slice()
    if (v instanceof ArrayBuffer) return v.slice(0)
    if (v instanceof Map) {
      const out = new Map()
      seen.set(v, out)
      for (const [k, x] of v) out.set(clone(k, seen), clone(x, seen))
      return out
    }
    if (v instanceof Set) {
      const out = new Set()
      seen.set(v, out)
      for (const x of v) out.add(clone(x, seen))
      return out
    }
    const out = Array.isArray(v) ? [] : {}
    seen.set(v, out)
    for (const k of Object.keys(v)) out[k] = clone(v[k], seen)
    return out
  }
  define("structuredClone", (v) => clone(v, new Map()))

  // crypto: random bytes and UUIDs, digests and HMAC (what functions use: webhook signatures, ids, hashes)
  const HASHES = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" }
  const hashName = (a) => {
    const name = String(typeof a === "string" ? a : a?.name).toUpperCase()
    const found = HASHES[name]
    if (found === undefined) throw new Error("crypto.subtle: " + name + " isn't supported here (SHA-1, SHA-256, SHA-384, SHA-512)")
    return [name, found]
  }
  class CryptoKey {
    constructor(bytes, algorithm, usages) {
      this.__bytes = bytes
      this.algorithm = algorithm
      this.usages = usages
      this.type = "secret"
      this.extractable = false
    }
  }
  const subtle = {
    digest: async (algorithm, data) => h.digest(hashName(algorithm)[1], bufferOf(data)),
    importKey: async (format, keyData, algorithm, _extractable, usages) => {
      if (format !== "raw") throw new Error("crypto.subtle.importKey: only 'raw' keys are supported here")
      if (String(algorithm?.name).toUpperCase() !== "HMAC") throw new Error("crypto.subtle.importKey: only HMAC keys are supported here")
      const [name] = hashName(algorithm.hash)
      return new CryptoKey(bytesOf(keyData).slice(), { name: "HMAC", hash: { name } }, usages)
    },
    sign: async (_algorithm, key, data) => h.hmac(HASHES[key.algorithm.hash.name], bufferOf(key.__bytes), bufferOf(data)),
    verify: async (_algorithm, key, signature, data) => {
      const want = new Uint8Array(h.hmac(HASHES[key.algorithm.hash.name], bufferOf(key.__bytes), bufferOf(data)))
      const got = bytesOf(signature)
      if (want.length !== got.length) return false
      let diff = 0
      for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i]
      return diff === 0
    },
  }
  define("crypto", {
    subtle,
    getRandomValues: (array) => {
      const b = bytesOf(array)
      b.set(new Uint8Array(h.random(b.byteLength)))
      return array
    },
    randomUUID: () => h.uuid(),
  })
  define("CryptoKey", CryptoKey)
  // Intl: QuickJS has none; each call formats with the host's ICU (one value, as JSON, each way)
  const wire = (v) => (v instanceof Date ? { $date: v.getTime() } : typeof v === "bigint" ? Number(v) : v)
  const intl = (kind, locales, options, method, args) =>
    JSON.parse(h.intl(kind, JSON.stringify(locales ?? null), JSON.stringify(options ?? {}), method, JSON.stringify(args.map(wire))))
  const kinds = {
    NumberFormat: ["format", "formatToParts", "formatRange"],
    DateTimeFormat: ["format", "formatToParts", "formatRange"],
    RelativeTimeFormat: ["format", "formatToParts"],
    PluralRules: ["select", "selectRange"],
    ListFormat: ["format", "formatToParts"],
    Collator: ["compare"],
    DisplayNames: ["of"],
  }
  const Intl = { getCanonicalLocales: (l) => [].concat(l ?? []) }
  for (const [kind, methods] of Object.entries(kinds)) {
    const C = function (locales, options) {
      if (!new.target) return new C(locales, options)
      this.__l = locales
      this.__o = options ?? {}
      intl(kind, locales, options, "resolvedOptions", [])
      // bound, as Intl's are: arr.sort(collator.compare), dates.map(fmt.format)
      for (const m of methods)
        this[m] = (...args) => intl(kind, this.__l, this.__o, m, kind === "DateTimeFormat" && m === "format" && args.length === 0 ? [new Date()] : args)
    }
    C.prototype.resolvedOptions = function () {
      return intl(kind, this.__l, this.__o, "resolvedOptions", [])
    }
    C.supportedLocalesOf = (l) => [].concat(l ?? [])
    Object.defineProperty(C, "name", { value: kind })
    Intl[kind] = C
  }
  define("Intl", Intl)
  const method = (target, name, value) => Object.defineProperty(target, name, { configurable: true, writable: true, value })
  method(Number.prototype, "toLocaleString", function (l, o) {
    return intl("NumberFormat", l, o, "format", [Number(this)])
  })
  method(BigInt.prototype, "toLocaleString", function (l, o) {
    return intl("NumberFormat", l, o, "format", [Number(this)])
  })
  method(Date.prototype, "toLocaleString", function (l, o) {
    return intl("DateTimeFormat", l, o ?? { dateStyle: "short", timeStyle: "medium" }, "format", [this])
  })
  method(Date.prototype, "toLocaleDateString", function (l, o) {
    return intl("DateTimeFormat", l, o ?? {}, "format", [this])
  })
  method(Date.prototype, "toLocaleTimeString", function (l, o) {
    return intl("DateTimeFormat", l, o ?? { timeStyle: "medium" }, "format", [this])
  })
  method(String.prototype, "localeCompare", function (other, l, o) {
    return intl("Collator", l, o, "compare", [String(this), String(other)])
  })
  define("navigator", { userAgent: "OpenBelt" })
  define("self", globalThis)
})()
`
