// An app's link preview cards (Open Graph images, 1200×630): drawn in the browser that takes its picture (shots.ts, check.ts),
// right after the picture, from it. Two per app: its own (name, description, picture, a colour of its own), shown to link
// previewers only when openbelt.json says "card": "public", and the private one (its workspace's name only), shown otherwise.
//
// The colour, first that gives one: openbelt.json "color", the page's <meta name="theme-color">, the colour this version had
// before (so a write that changes the picture doesn't change it), the picture's commonest strong colour, a hue from the app's
// name. The card is painted with it at most CALM chroma (OKLCH, how saturated it looks), its hue and lightness kept: a loud brand
// red unfurls as a calm red, and a colour already calm is left as it is. The colour kept for the version (and the gallery's tint) is
// the one chosen. The title steps down through fixed sizes until it fits in two lines, then three, and only at the smallest is cut.
import logoCss from "../../../brand/css/logo.css" with { type: "text" }
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { hueOf } from "./colors.ts"
import type { Browser } from "playwright-core"
import wordmarkSvg from "../../../brand/logo/openbelt.svg" with { type: "text" }

const CARD = { width: 1200, height: 630 } as const

/** The most chroma (OKLCH) a card's colour keeps: about the sky blue #7ec8f5's (0.098), so every hue unfurls about as calm. */
const CALM = 0.12

/** What the app knows when its picture is booked; the page's own title and theme-color come from the browser. */
export type CardAsk = {
  /** The app's name (its slug): the title when its page has none, and the seed of a colour when nothing else gives one. */
  readonly app: string
  readonly workspace: string
  readonly description: string
  /** <app>--<workspace>, as the card prints it. */
  readonly host: string
  /** openbelt.json "color", else the colour this version was given before; null to find one. */
  readonly color: Chosen | null
}

export type Chosen = { readonly color: string; readonly source: ColorSource }

export const ColorSource = Schema.Literals(["config", "theme", "picture", "name"])

export type ColorSource = typeof ColorSource.Type

/** What a card's page says it chose (window.card). */
const Made = Schema.Struct({
  color: Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9a-f]{6}$/))),
  source: ColorSource,
})

/** What the card's page script is told. */
type PageAsk = {
  readonly color: string | null
  readonly source: ColorSource | null
  readonly picture: boolean
  /** The hue the name gives (colors.ts), when nothing else gives a colour. */
  readonly hue: number
  readonly calm: number
}

/** The cards a picture's browser drew, or why it drew none. */
export type CardsDrawn =
  | { readonly kind: "drawn"; readonly cards: Cards }
  | { readonly kind: "none"; readonly why: string }

export type Cards = {
  readonly card: Uint8Array
  readonly private: Uint8Array
  readonly title: string
  readonly color: string
  readonly source: ColorSource
}

const FONTS = join(import.meta.dir, "../../../brand/fonts")

let fontFaces: string | undefined

/** Inter Tight and JetBrains Mono as data: URLs, so the card's page loads nothing. */
const fonts = () =>
  (fontFaces ??= [
    ["Inter Tight", "inter-tight.woff2", "500 800"],
    ["JetBrains Mono", "jetbrains-mono.woff2", "400 600"],
  ]
    .map(
      ([family, file, weight]) =>
        `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(join(FONTS, file ?? "")).toBase64()}) format("woff2")}`,
    )
    .join("\n"))

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  )

const WORDMARK = wordmarkSvg
  .replace(/<title>[^<]*<\/title>/, "")
  .replace("<svg ", '<svg class="brand-logo" aria-hidden="true" ')

/** A slug as a name: dashes to spaces, the first letter capitalised ("lunch-votes" → "Lunch votes"). */
export const nameOfSlug = (slug: string) => {
  const spaced = slug.replaceAll("-", " ")

  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * The app's line under its title: without the title again when the line starts with it ("Koa's Numberblocks: Add them up. Tap…"
 * under the title "Koa's Numberblocks: Add them up" is "Tap…"), and as it is when that would leave nothing.
 */
export const aboutOf = (title: string, description: string) => {
  const line = description.trim()
  const head = title.trim()

  if (head === "" || !line.toLowerCase().startsWith(head.toLowerCase())) return line

  const rest = line.slice(head.length).replace(/^[\s.:;,!?\u2013\u2014-]+/, "")

  return rest === "" ? line : rest
}

const STYLE = `${logoCss}
*{box-sizing:border-box;margin:0}
html,body{width:${CARD.width}px;height:${CARD.height}px;overflow:hidden}
body{font-family:"Inter Tight",sans-serif;position:relative;color:var(--fg);background:linear-gradient(135deg,var(--bg),var(--bg2))}
.pad{position:absolute;inset:0;padding:78px}
.brand{display:flex;align-items:center;gap:22px;max-width:600px}
.brand-logo{--logo-size:40px}
.sep{width:3px;height:41px;background:currentColor;opacity:.3;flex:none}
.workspace{font-size:34px;font-weight:650;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.text{margin-top:66px;width:516px}
.title{font-size:84px;font-weight:750;letter-spacing:-.03em;line-height:1.04;overflow-wrap:normal}
.title.cut{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.about{font-size:34px;font-weight:500;line-height:1.3;opacity:.8;margin-top:22px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.host{font-family:"JetBrains Mono",monospace;font-size:22px;opacity:.6;position:absolute;left:78px;bottom:60px;max-width:480px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.shot{position:absolute;left:660px;top:132px;width:696px;transform:rotate(-4deg);border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 0 2px rgba(0,0,0,.08)}
.bar{height:36px;background:#efede7;display:flex;align-items:center;gap:10px;padding:0 17px}
.bar i{width:12px;height:12px;border-radius:50%;background:#d1cdc1}
.shot img{display:block;width:100%}
.lock{position:absolute;right:120px;top:50%;width:300px;height:300px;margin-top:-150px;transform:rotate(-4deg);border-radius:66px;display:grid;place-items:center;background:color-mix(in srgb,var(--fg) 10%,transparent)}
.lock svg{width:130px;height:130px}
`

// The page's script: the colour (when none was given), the text colour for it, and the title's size. Its result is window.card.
const SCRIPT = `(async () => {
const ask = JSON.parse(document.getElementById("ask").textContent)
const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const hsl = (h, s, l) => { const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return hex([f(0), f(8), f(4)].map((v) => v * 255)) }
const toHsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (d === 0) return [0, 0, l]; const s = d / (1 - Math.abs(2 * l - 1)); const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(h * 60 + 360) % 360, s, l] }
const lum = (h) => { const [r, g, b] = rgbOf(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const mix = (a, b, t) => { const x = rgbOf(a), y = rgbOf(b); return hex(x.map((v, i) => v * (1 - t) + y[i] * t)) }
// A colour with its OKLCH chroma cut to ask.calm, its lightness and hue kept (Björn Ottosson's OKLab).
const calm = (h) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4), gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
  const [r, g, b] = rgbOf(h).map((v) => lin(v / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const c = Math.hypot(A, B)
  if (c <= ask.calm) return h
  const a = (A * ask.calm) / c, bb = (B * ask.calm) / c
  const [x, y, z] = [(L + 0.3963377774 * a + 0.2158037573 * bb) ** 3, (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3, (L - 0.0894841775 * a - 1.291485548 * bb) ** 3]
  return hex([4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z, -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z, -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z].map((v) => gam(Math.max(0, Math.min(1, v))) * 255))
}
// The picture's commonest strong colour: hues in 24 bins, greys and near-black and near-white left out, a bin that covers
// under 1% of the picture not counted. Its saturation and lightness are kept in bounds, so a neon page gives a colour a feed can take.
const picked = (img) => {
  if (!img) return null
  const c = document.createElement("canvas"), w = 160, h = Math.round((160 * img.naturalHeight) / img.naturalWidth) || 100
  c.width = w; c.height = h
  const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h)
  const px = x.getImageData(0, 0, w, h).data, bins = new Map()
  for (let i = 0; i < px.length; i += 4) {
    const rgb = [px[i], px[i + 1], px[i + 2]], [hue, s, l] = toHsl(rgb)
    if (s < 0.45 || l < 0.18 || l > 0.88) continue
    const k = Math.floor(hue / 15), e = bins.get(k) ?? [0, 0, 0, 0]
    e[0]++; e[1] += rgb[0]; e[2] += rgb[1]; e[3] += rgb[2]; bins.set(k, e)
  }
  const best = [...bins.values()].sort((a, b) => b[0] - a[0])[0]
  if (!best || best[0] < (w * h) / 100) return null
  const [hue, s, l] = toHsl([best[1] / best[0], best[2] / best[0], best[3] / best[0]])
  return hsl(hue, Math.min(s, 0.78), Math.max(0.2, Math.min(l, 0.58)))
}
const img = document.querySelector(".shot img")
if (img) await img.decode()
const chosen = ask.color ? [ask.color, ask.source] : (() => { const p = ask.picture ? picked(img) : null; return p ? [p, "picture"] : [hsl(ask.hue, 0.62, 0.52), "name"] })()
const bg = calm(chosen[0]), light = lum(bg) > 0.32
document.body.style.setProperty("--bg", bg)
document.body.style.setProperty("--bg2", mix(bg, "#ffffff", 0.28))
document.body.style.setProperty("--fg", light ? "#0c0b0a" : "#fffefb")
const t = document.querySelector(".title"), text = document.querySelector(".text"), host = document.querySelector(".host")
const fits = (size, most) => {
  t.style.fontSize = size + "px"
  const lines = Math.round(t.offsetHeight / (size * 1.04))
  const clear = !host || text.getBoundingClientRect().bottom <= host.getBoundingClientRect().top - 14
  return lines <= most && t.scrollWidth <= t.clientWidth + 1 && clear
}
const SIZES = [84, 77, 71, 65, 60, 56, 53]
const size = [2, 3].flatMap((most) => SIZES.filter((s) => fits(s, most)))[0]
if (size === undefined) { t.style.fontSize = SIZES.at(-1) + "px"; t.classList.add("cut") } else t.style.fontSize = size + "px"
window.card = { color: chosen[0], source: chosen[1] }
})()
`

const LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`

const page = (body: string, ask: PageAsk) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fonts()}${STYLE}</style></head><body>${body}<script type="application/json" id="ask">${JSON.stringify(ask).replaceAll("<", "\\u003c")}</script><script>${SCRIPT}</script></body></html>`

const brand = (workspace: string) =>
  `<div class="brand">${WORDMARK}<i class="sep"></i><span class="workspace">${escape(workspace)}</span></div>`

/** The app's own card's page: its picture's colour comes out of it as window.card. */
const cardPage = (
  ask: CardAsk,
  title: string,
  color: Chosen | null,
  picture: Uint8Array | undefined,
) =>
  page(
    `<div class="pad">${brand(ask.workspace)}<div class="text"><div class="title">${escape(title)}</div>${ask.description === "" ? "" : `<div class="about">${escape(ask.description)}</div>`}</div><div class="host">${escape(ask.host)}</div></div>${picture === undefined ? "" : `<div class="shot"><div class="bar"><i></i><i></i><i></i></div><img src="data:image/webp;base64,${picture.toBase64()}"></div>`}`,
    {
      color: color?.color ?? null,
      source: color?.source ?? null,
      picture: picture !== undefined,
      hue: hueOf(ask.app),
      calm: CALM,
    },
  )

/** The card a link previewer gets for an app that isn't "card": "public": its workspace's name, and a colour from the workspace's. */
const privatePage = (workspace: string) =>
  page(
    `<div class="pad">${brand(workspace)}<div class="text"><div class="title">An app in ${escape(workspace)}</div><div class="about">Sign in with your ${escape(workspace)} account to open it.</div></div></div><div class="lock">${LOCK}</div>`,
    { color: null, source: null, picture: false, hue: hueOf(workspace), calm: CALM },
  )

const shoot = async (browser: Browser, html: string) => {
  const tab = await browser.newPage()

  try {
    await tab.setViewportSize({ width: CARD.width, height: CARD.height })
    await tab.setContent(html, { waitUntil: "load", timeout: 10_000 })
    await tab.evaluate("document.fonts.ready.then(() => true)")
    await tab.waitForFunction("window.card !== undefined", undefined, { timeout: 5000 })

    const made: unknown = await tab.evaluate("window.card")
    const bytes = await tab.screenshot({ type: "jpeg", quality: 88 })

    return { made, bytes: new Uint8Array(bytes) }
  } finally {
    await tab.close().catch(() => undefined)
  }
}

const HEX = /^#[0-9a-f]{6}$/i

/**
 * Both cards, in a tab each of the browser that took the picture. `title` and `theme` are what the page showed (its <title>, its
 * theme-color); `picture` is the light picture.
 */
export const renderCards = async (
  browser: Browser,
  ask: CardAsk,
  shown: { readonly title: string; readonly theme: string | null },
  picture: Uint8Array,
): Promise<Cards> => {
  const title = shown.title.trim() === "" ? nameOfSlug(ask.app) : shown.title.trim().slice(0, 200)

  const given: Chosen | null =
    ask.color !== null
      ? ask.color
      : shown.theme !== null && HEX.test(shown.theme)
        ? { color: shown.theme.toLowerCase(), source: "theme" as const }
        : null

  const own = await shoot(
    browser,
    cardPage({ ...ask, description: aboutOf(title, ask.description) }, title, given, picture),
  )

  const other = await shoot(browser, privatePage(ask.workspace))

  const made = Option.getOrUndefined(Schema.decodeUnknownOption(Made)(own.made))

  if (made === undefined)
    throw new Error(`the card's page gave no colour (${JSON.stringify(own.made)})`)

  return { card: own.bytes, private: other.bytes, title, color: made.color, source: made.source }
}

/** The page a link previewer gets: Open Graph and X tags, nothing else (it never runs the app). */
export const cardTags = (card: {
  readonly url: string
  readonly title: string
  readonly description: string
  readonly image: string | null
}) => {
  const tag = (property: string, content: string) =>
    `<meta property="${property}" content="${escape(content)}">`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(card.title)}</title>
<meta name="description" content="${escape(card.description)}">
${tag("og:site_name", "OpenBelt")}
${tag("og:type", "website")}
${tag("og:title", card.title)}
${tag("og:description", card.description)}
${card.url === "" ? "" : tag("og:url", card.url)}
${
  card.image === null
    ? '<meta name="twitter:card" content="summary">'
    : `${tag("og:image", card.image)}
${tag("og:image:type", "image/jpeg")}
${tag("og:image:width", String(CARD.width))}
${tag("og:image:height", String(CARD.height))}
${tag("og:image:alt", card.title)}
<meta name="twitter:card" content="summary_large_image">`
}
</head><body></body></html>
`
}
