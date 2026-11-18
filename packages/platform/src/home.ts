import { PWA_HEAD } from "./pwa.ts"
import { THEME_SCRIPT } from "./theme.ts"
import baseCss from "../../../brand/css/base.css" with { type: "text" }
import componentsCss from "../../../brand/css/components.css" with { type: "text" }
import tokensCss from "../../../brand/css/tokens.css" with { type: "text" }
import logoCss from "../../../brand/css/logo.css" with { type: "text" }
import wordmarkSvg from "../../../brand/logo/openbelt.svg" with { type: "text" }
import { appPath } from "./model.ts"
import type { Inside } from "./starters.ts"
import { CATALOG } from "./providers.ts"
import { DRAWER_SCRIPT, RAIL_HEAD, SCRIM, SIDEBAR_CSS } from "./sidebar.ts"

export type Card = {
  readonly name: string
  readonly description: string
  readonly owner: string
  readonly created: string
  readonly updated: string | null
  readonly shot: string | null
  /** The tint behind its picture, as CSS: its own colour or its name's (colors.ts). */
  readonly color: string
  readonly coming: boolean
  /** Whether the workspace's directory has the app's entry yet (an app deployed before it is asked for it soon after). */
  readonly entered: boolean
  /** Whether the viewer may delete it: its owner or a workspace admin (the workspace checks again when asked). */
  readonly manage: boolean
}

/** What the home page shows: one page of the apps asked for, out of `total`; `next` is where the next page starts. */
type Gallery = {
  readonly cards: ReadonlyArray<Card>
  readonly total: number
  readonly next: number | null
  /** Where this page starts in the list: only the first page features its newest app. */
  readonly from: number
  readonly recent: ReadonlyArray<Card>
  /** The apps the viewer opened last, newest first, each with when (ISO): Jump back in. */
  readonly jump: ReadonlyArray<{ readonly card: Card; readonly opened: string }>
  readonly q: string
  readonly sort: "updated" | "created" | "name"
}

type Home = {
  readonly workspace: string
  readonly workspaceOrigin: string
  readonly switcher: string
  /** The MCP address an agent signs in to by itself from here (the Connect dialog's one command). */
  readonly mcp: string
  readonly viewer: { readonly email: string; readonly name: string } | null
  /** The viewer's form token for this host, sent with a delete; null signed out. */
  readonly form: string | null
  readonly signOut: boolean
  readonly gallery: Gallery
  /** People who asked to join and aren't invited yet, shown to an admin. */
  readonly asks: ReadonlyArray<string>
  /** Which tab of Apps: the workspace's apps (Yours), or the starter apps anyone in it can add (Starters). */
  readonly tab: "yours" | "starters"
  /** On Starters, the starter whose page is open (?starter=), or null for them all. */
  readonly starter: string | null
  /** Every starter app (starters.ts), in order: Yours lists the first few not added beside Just updated, Starters all of them. */
  readonly starters: ReadonlyArray<StarterCard>
}

/** A starter app as Apps shows it. */
type StarterCard = {
  readonly name: string
  readonly description: string
  /** Its icon.svg, from this repo's starters (never what a page sent), put in the page as it is. */
  readonly icon: string
  readonly color: string
  /** Its picture made ahead, by version (GET /_starters/<name>/picture?v=), or null: its icon instead. */
  readonly picture: string | null
  /** The app it was added as in this workspace, or null when it isn't. */
  readonly app: string | null
  /** Whether the viewer may remove that app: its owner or a workspace admin. */
  readonly manage: boolean
  /** What's inside it, for its page. */
  readonly inside: Inside
  /** Another app already named as the starter is, and the free name its page adds it as instead (journal-2); else null. */
  readonly taken: { readonly card: Card; readonly free: string } | null
}

export const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const ICONS = {
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  externalLink:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  panelLeftClose:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  panelLeftOpen:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  circleCheck: '<circle cx="12" cy="12" r="10" /><path d="m16 9-5.5 5.5L8 12" />',
  check: '<path d="M20 6 9 17l-5-5"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  logOut:
    '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
  chevronsUpDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  arrowLeftRight:
    '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  sunMoon:
    '<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  fileText:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  moreHorizontal:
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  building:
    '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
} as const

// The one line a heading may carry. Keep it under about eight words (scripts/guard.ts counts them);
// most headings need none: the page explains itself.
export type Sub = { readonly html: string }

export const sub = (html: string): Sub => ({ html })

export const headingHtml = (
  tag: "h1" | "h2" | "h3",
  title: string,
  note: Sub | null = null,
  { id, cls }: { readonly id?: string; readonly cls?: string } = {},
) =>
  `<${tag}${id === undefined ? "" : ` id="${id}"`}>${title}</${tag}>${note === null ? "" : `<p${cls === undefined ? "" : ` class="${cls}"`}>${note.html}</p>`}`

export const icon = (name: keyof typeof ICONS) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`

export const CONNECTION_LABELS = new Map([
  ...CATALOG.map((p) => [p.id, p.name] as const),
  ["gitlab", "GitLab"],
  ["pagerduty", "PagerDuty"],
  ["hubspot", "HubSpot"],
  ["quickbooks", "QuickBooks"],
  ["gdrive", "Google Drive"],
  ["gcal", "Google Calendar"],
])

export const connectionLabel = (name: string) => {
  const known = CONNECTION_LABELS.get(name)

  if (known !== undefined) return known

  const parts = name.split("-")

  for (let size = parts.length - 1; size >= 1; size--) {
    for (let at = 0; at + size <= parts.length; at++) {
      const label = CONNECTION_LABELS.get(parts.slice(at, at + size).join("-"))

      if (label !== undefined) {
        const words = [...parts.slice(0, at), label, ...parts.slice(at + size)].join(" ")

        return words.charAt(0).toUpperCase() + words.slice(1)
      }
    }
  }

  return name.charAt(0).toUpperCase() + name.slice(1)
}

export const toolLabel = (tool: string) => {
  const words = (tool.split(".").at(-1) ?? tool)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((w) => w !== "")
    .join(" ")
    .toLowerCase()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

const toolAbout = (description: string) =>
  (description.split(/(?<=\.)\s+|\s+(?=Returns\b)|:\s/)[0] ?? "").trim()

const DOES = new Map([
  ["get", "See"],
  ["list", "See"],
  ["read", "See"],
  ["fetch", "See"],
  ["view", "See"],
  ["retrieve", "See"],
  ["show", "See"],
  ["describe", "See"],
  ["search", "Search"],
  ["find", "Search"],
  ["query", "Search"],
  ["create", "Create"],
  ["add", "Add"],
  ["update", "Change"],
  ["edit", "Change"],
  ["modify", "Change"],
  ["patch", "Change"],
  ["set", "Change"],
  ["delete", "Delete"],
  ["remove", "Delete"],
  ["merge", "Merge"],
  ["close", "Close"],
  ["send", "Send"],
  ["post", "Post"],
  ["comment", "Comment on"],
])

const SELF =
  /^(me|self|viewer|profile|whoami|my profile|current user|authenticated user|user profile)$/

const MASS = new Set([
  "data",
  "info",
  "information",
  "metadata",
  "me",
  "content",
  "code",
  "history",
])

const QUIET = new Set(["a", "an", "the", "your", "of", "s", "and", "or"])

const plural = (words: string) => {
  const last = words.split(" ").at(-1) ?? ""

  if (last.endsWith("s") || MASS.has(last)) return words

  const head = words.slice(0, words.length - last.length)

  return /[^aeiou]y$/.test(last)
    ? `${head}${last.slice(0, -1)}ies`
    : /(ch|sh|x|z)$/.test(last)
      ? `${head}${last}es`
      : `${head}${last}s`
}

export const toolSaid = (tool: string, description: string) => {
  const dot = tool.indexOf(".")
  const service = dot === -1 ? "" : `${connectionLabel(tool.slice(0, dot))} `

  const words = tool
    .slice(dot + 1)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase())

  const verb = DOES.get(words[0] ?? "")
  const object = words.slice(1).join(" ")
  const yours = /\b(authenticated|current) user\b|\byour\b|\bme\b/i.test(description)

  const said =
    verb === undefined || object === ""
      ? toolLabel(tool)
      : verb === "See" && SELF.test(object)
        ? `See your ${service}profile`
        : `${verb} ${verb === "See" && yours ? "your " : ""}${plural(object)}`

  const about = toolAbout(description)
    .replace(/\bthe (authenticated|current) user's\b/gi, "your")
    .replace(/\bthe (authenticated|current) user\b/gi, "your account")
    .replace(/^(gets?|lists?|fetch(es)?|reads?|retrieves?|returns?|shows?)\s+/i, "")

  // A line that only names what the title already does says nothing: "See file contents" over "A file's contents".
  const told = new Set(said.toLowerCase().match(/[a-z]+/g) ?? [])

  const repeats = (about.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((w) => !QUIET.has(w))
    .every((w) => told.has(w) || told.has(`${w}s`) || told.has(w.replace(/s$/, "")))

  return {
    name: said,
    about: repeats ? "" : about.charAt(0).toUpperCase() + about.slice(1),
  }
}

const personName = (email: string) =>
  (email.split("@")[0] ?? email)
    .split(/[._-]+/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")

const initials = (text: string) =>
  text
    .split(/[\s-]+/)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase()

const SIDE_CSS = `
[hidden] { display: none !important; }
.wordmark { display: inline-flex; color: var(--openbelt-color-primary); }
.shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
.side { position: sticky; top: 0; height: 100vh; overflow: auto; display: flex; flex-direction: column; }
.side .head { display: flex; align-items: center; gap: var(--openbelt-space-xs); padding: var(--openbelt-space-md) var(--openbelt-space-md); margin-bottom: var(--openbelt-space-xs); font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); }
.nav { display: grid; gap: 1px; padding: 0 var(--openbelt-space-xs); }
.nav a { display: flex; align-items: center; gap: 10px; width: 100%; text-decoration: none; height: 30px; padding: 0 var(--openbelt-space-xs); border-radius: var(--openbelt-radius-sm); color: var(--openbelt-color-muted); text-align: left; transition: background-color var(--openbelt-duration) var(--openbelt-ease), color var(--openbelt-duration) var(--openbelt-ease); }
.nav .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avatar { width: 20px; height: 20px; flex: none; display: inline-grid; place-items: center; border-radius: var(--openbelt-radius-full); border: 1px solid var(--openbelt-color-border-strong); background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); font-size: 10px; font-weight: 550; }
.topbar { display: none; }
[id] { scroll-margin-top: var(--openbelt-space-lg); }
@media (max-width: 820px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  [id] { scroll-margin-top: calc(56px + var(--openbelt-space-md)); }
  .you { padding-bottom: var(--openbelt-space-sm); }
  .topbar { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; gap: var(--openbelt-space-2xs); height: 56px; padding: 0 var(--openbelt-space-xs); border-bottom: 1px solid var(--openbelt-color-border); background: var(--openbelt-color-neutral); }
}
`

const MENU_BUTTON = `<button class="btn btn-ghost btn-square drawer" aria-label="Menu" aria-expanded="false" aria-controls="side">${icon("panelLeft")}</button>`

export const topBar = () => `<div class="topbar">${MENU_BUTTON}</div>`

const SHUT = `<button type="button" class="btn btn-ghost btn-square shut" aria-controls="side" aria-label="Close menu">${icon("x")}</button>`

const COLLAPSE = `<button type="button" class="btn btn-ghost btn-square collapse" aria-controls="side" aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar ([ or ⌘B)"><span class="when-open">${icon("panelLeftClose")}</span><span class="when-rail">${icon("panelLeftOpen")}</span></button>`

export type MainPlace = "apps" | "connections"

/** `signOut`: they signed in here (an email code), so the menu can sign them out; the front door's people have nothing to end. */
export const mainSide = (
  workspace: string,
  switcher: string,
  viewer: Home["viewer"],
  here: MainPlace,
  signOut = false,
) => {
  const at = (place: MainPlace) => (here === place ? ' aria-current="page"' : "")

  return `<nav class="side" id="side" aria-label="OpenBelt">
<div class="head"><a class="wordmark" href="/">${wordmarkSvg.replace("<svg ", '<svg class="brand-logo" ')}</a>${COLLAPSE}${SHUT}</div>
${workspaceMenu(workspace, switcher)}
<div class="nav"><a href="/" data-filter="all"${at("apps")}>${icon("grid")}<span class="label">Apps</span></a>${viewer === null ? "" : `<a href="/_connections"${at("connections")}>${icon("plug")}<span class="label">Connections</span></a>`}</div>
${personMenu(viewer, signOut)}
</nav>`
}

const THEMES = [
  ["system", "System", "monitor"],
  ["light", "Light", "sun"],
  ["dark", "Dark", "moon"],
] as const

const workspaceMenu = (workspace: string, switcher: string) =>
  `<div class="switcher"><a class="me" href="${escape(switcher)}" aria-label="Switch workspace"><span class="avatar square">${escape(initials(workspace))}</span><span class="who"><b>${escape(workspace)}</b><span>Switch workspace</span></span>${icon("chevronsUpDown")}</a></div>`

const personMenu = (person: Home["viewer"], signOut: boolean) => {
  const who =
    person === null
      ? `<span class="who"><b>Not signed in</b><span>Settings need a sign-in</span></span>`
      : (() => {
          const given = person.name.trim()
          const local = person.email.split("@")[0] ?? ""

          const name =
            given === "" || given.toLowerCase() === local.toLowerCase()
              ? personName(person.email)
              : given

          return `<span class="avatar">${escape(initials(name))}</span><span class="who"><b>${escape(name)}</b><span>${escape(person.email)}</span></span>`
        })()

  const link =
    person === null
      ? ""
      : `<a class="menu-item" role="menuitem" href="/_settings">${icon("settings")}Settings</a>`

  const end = signOut
    ? `<div class="menu-sep" role="separator"></div><form method="post" action="/_signout"><button class="menu-item" role="menuitem" type="submit">${icon("logOut")}Sign out</button></form>`
    : ""

  const themes = THEMES.map(
    ([value, label, glyph]) =>
      `<button type="button" role="menuitemradio" aria-checked="false" aria-label="${label}" title="${label}" data-theme-choice="${value}">${icon(glyph)}</button>`,
  ).join("")

  return `<div class="you">
<button type="button" class="me" id="you-button" aria-haspopup="menu" aria-expanded="false" aria-controls="you-menu">${who}${icon(person === null ? "sunMoon" : "chevronsUpDown")}</button>
<div class="menu overlay" role="menu" id="you-menu" aria-labelledby="you-button" tabindex="-1" hidden>${link}<div class="menu-choice" role="group" aria-labelledby="you-theme"><span class="label">${icon("sunMoon")}<span id="you-theme">Theme</span></span><span class="options">${themes}</span></div><span class="label" data-theme-status role="status"></span>${end}</div>
</div>`
}

const PERSON_CSS = `
.you { position: relative; margin-top: auto; padding: var(--openbelt-space-md) var(--openbelt-space-xs) var(--openbelt-space-xs); }
.you .menu { position: absolute; z-index: 3; left: var(--openbelt-space-xs); right: var(--openbelt-space-xs); bottom: calc(100% - var(--openbelt-space-md) + var(--openbelt-space-2xs)); }
.you .menu:focus { outline: none; }
.you form { margin: 0; }
.you button.menu-item { width: 100%; border: 0; background: none; cursor: pointer; }
.switcher { position: relative; padding: 0 var(--openbelt-space-xs) var(--openbelt-space-xs); }
.me .avatar.square { border-radius: var(--openbelt-radius-sm); }
a.me { text-decoration: none; }
.you .menu-item .label { flex: 1; }
.me { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 6px var(--openbelt-space-xs); border-radius: var(--openbelt-radius-sm); color: var(--openbelt-color-primary); text-align: left; transition: background-color var(--openbelt-duration) var(--openbelt-ease); }
.me:hover { background: var(--openbelt-color-subtle); }
.me[aria-expanded="true"] { background: var(--openbelt-color-sidebar-selected); }
.me .avatar { width: 28px; height: 28px; flex: none; display: inline-grid; place-items: center; border-radius: var(--openbelt-radius-full); border: 1px solid var(--openbelt-color-border-strong); background: var(--openbelt-color-subtle); font: var(--openbelt-type-body-sm); font-weight: 550; }
.me .who { flex: 1; min-width: 0; display: grid; }
.me .who > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me .who b { font: var(--openbelt-type-label); }
.me .who span { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); }
.me > .icon { flex: none; color: var(--openbelt-color-muted); }
.me:hover > .icon, .me[aria-expanded="true"] > .icon { color: var(--openbelt-color-primary); }
`

const PERSON_SCRIPT = `for (const root of document.querySelectorAll(".you")) {
  const button = root.querySelector(".me")
  const menu = root.querySelector(".menu")
  let savingTheme = false
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')]
  const mark = () => { for (const r of menu.querySelectorAll("[data-theme-choice]")) r.setAttribute("aria-checked", String(r.dataset.themeChoice === document.documentElement.dataset.theme)) }
  const show = (open, at) => {
    menu.hidden = !open
    button.setAttribute("aria-expanded", String(open))
    if (!open) return
    mark()
    ;(at === "menu" ? menu : at === "last" ? items().at(-1) : items()[0]).focus()
  }
  // A pointer's click has a detail (its click count); Enter and Space's has none.
  const menuIsInline = () => matchMedia("(max-width: 820px)").matches
  mark()
  button.addEventListener("click", (e) => { if (!menuIsInline()) show(menu.hidden, e.detail > 0 ? "menu" : "first") })
  button.addEventListener("keydown", (e) => {
    if (menuIsInline()) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); show(true, e.key === "ArrowUp" ? "last" : "first") }
  })
  menu.addEventListener("keydown", (e) => {
    const all = items()
    const i = all.indexOf(document.activeElement)
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
    if (step) { e.preventDefault(); all[i === -1 ? (step > 0 ? 0 : all.length - 1) : (i + step + all.length) % all.length].focus() }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); (e.key === "Home" ? all[0] : all.at(-1)).focus() }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); show(false); button.focus() }
    else if (e.key === "Tab") show(false)
  })
  menu.addEventListener("click", (e) => {
    const choice = e.target.closest("[data-theme-choice]")
    if (!choice || savingTheme) return
    const theme = choice.dataset.themeChoice
    const status = menu.querySelector("[data-theme-status]")
    status.textContent = ""
    savingTheme = true
    menu.setAttribute("aria-busy", "true")
    window.openbeltTheme(theme).then(mark, (error) => { status.textContent = error.message }).finally(() => {
      savingTheme = false
      menu.removeAttribute("aria-busy")
    })
  })
  document.addEventListener("click", (e) => { if (!menu.hidden && !root.contains(e.target)) show(false) })
}`

const THEMED_PICTURES = `.picture img.light { display: none; }
:root[data-theme="light"] .picture img.light { display: block; }
:root[data-theme="light"] .picture img.dark { display: none; }
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] .picture img.light { display: block; }
  :root[data-theme="system"] .picture img.dark { display: none; }
}`

const pictures = (src: string) =>
  `<img class="light" alt="" loading="lazy" src="${src}"><img class="dark" alt="" loading="lazy" src="${src}&amp;theme=dark">`

export const MAIN_CSS = `${tokensCss}${baseCss}${componentsCss}${logoCss}${PERSON_CSS}${SIDE_CSS}${SIDEBAR_CSS}`

export const NAV_PREFETCH = `<script type="speculationrules">${JSON.stringify({
  prefetch: [
    {
      source: "document",
      where: {
        selector_matches: [
          "/_connections",
          "/_settings",
          "/_settings/agents",
          "/_settings/people",
          "/_settings/groups",
          "/_settings/connections",
          "/_settings/events",
          "/_settings/connections/add",
        ]
          .map((path) => `a[href="${path}"]`)
          .join(", "),
      },
      eagerness: "moderate",
    },
  ],
})}</script>`

export const switcherPreconnect = (switcher: string) =>
  switcher.startsWith("/")
    ? ""
    : `<link rel="preconnect" href="${escape(new URL(switcher).origin)}">`

export const MAIN_SCRIPT = `const switcherLink = document.querySelector('[aria-label="Switch workspace"]')
const switcherLabel = switcherLink?.querySelector(".who > span")
if (switcherLabel) {
  const label = switcherLabel.textContent
  switcherLink.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || switcherLink.target === "_blank") return
    switcherLabel.textContent = "Opening…"
    switcherLink.setAttribute("aria-busy", "true")
  })
  addEventListener("pageshow", () => {
    switcherLabel.textContent = label
    switcherLink.removeAttribute("aria-busy")
  })
}
if (new URL(location.href).searchParams.has("open")) {
  const address = new URL(location.href)
  address.searchParams.delete("open")
  history.replaceState(null, "", address.pathname + address.search + address.hash)
}
${PERSON_SCRIPT}\n${DRAWER_SCRIPT}`

const STYLE = `
.address { display: flex; align-items: center; gap: var(--openbelt-space-xs); height: 32px; padding: 0 2px 0 var(--openbelt-space-xs); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-surface); font: var(--openbelt-type-mono-sm); }
.address span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.address .btn { height: 26px; width: 26px; }
main { --card-min: 280px; --card-gap: var(--openbelt-space-lg); min-width: 0; padding: 0 var(--openbelt-space-xl) var(--openbelt-space-3xl); }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: var(--openbelt-space-xs); align-items: center; margin: 0 calc(-1 * var(--openbelt-space-xl)); padding: var(--openbelt-space-lg) var(--openbelt-space-xl) var(--openbelt-space-md); border-bottom: 1px solid transparent; background: var(--openbelt-color-neutral); transition: border-color var(--openbelt-duration) var(--openbelt-ease); }
.toolbar.stuck { border-bottom-color: var(--openbelt-color-border); }
#all[hidden] + .grid { margin-top: var(--openbelt-space-xs); }
.search { position: relative; flex: 0 1 440px; min-width: 0; }
.search .icon { position: absolute; left: 10px; top: 8px; color: var(--openbelt-color-muted); pointer-events: none; }
.search .input { width: 100%; padding-left: 32px; padding-right: 34px; }
.search .kbd { position: absolute; right: 8px; top: 7px; }
.search #clear { position: absolute; right: 3px; top: 3px; height: 26px; gap: 6px; padding: 0 6px; font: var(--openbelt-type-body-sm); }
.search #clear .kbd { position: static; }
.search:has(#clear:not([hidden])) > .kbd { display: none; }
.search:has(#clear:not([hidden])) .input { padding-right: 76px; }
.toolbar .grow { flex: 1; }
.tools { display: contents; }
.heading .drawer { display: none; }
.select .shown { display: none; }
.toolbar > .select { flex: none; }
.shelf { margin: var(--openbelt-space-sm) 0 var(--openbelt-space-xl); }
.shelf header { display: flex; align-items: center; gap: var(--openbelt-space-xs); margin-bottom: var(--openbelt-space-sm); }
/* Section titles are headings (Jump back in, Just updated, All apps): the page's order is heading, then pictures. */
.shelf h2 { margin-right: auto; font: 650 20px/1.2 var(--openbelt-font-display); letter-spacing: var(--openbelt-tracking-h5); color: var(--openbelt-color-primary); }
.shelf header .btn { height: 26px; width: 26px; }
.track { display: grid; grid-auto-flow: column; grid-auto-columns: calc((100% - (var(--cols, 3) - 1) * var(--card-gap)) / var(--cols, 3)); gap: var(--card-gap); overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding-inline: 4px; padding: 4px 4px var(--openbelt-space-xs); margin: -4px -4px 0; scrollbar-width: none; }
.track::-webkit-scrollbar { display: none; }
.track > .app { scroll-snap-align: start; }
.heading { display: flex; align-items: center; gap: var(--openbelt-space-xs); min-width: 0; }
.heading h1 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
.count { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); font-variant-numeric: tabular-nums; }
.seg .btn[aria-pressed="true"] { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.seg .btn[aria-pressed="false"] { color: var(--openbelt-color-muted); }
/* About three times more room above a heading than under it, so each heading reads as part of what follows. */
.all { margin: 40px 0 var(--openbelt-space-xs); font: 650 20px/1.2 var(--openbelt-font-display); letter-spacing: var(--openbelt-tracking-h5); color: var(--openbelt-color-primary); }
.toolbar + .jump .all, .toolbar + .feature .all { margin-top: var(--openbelt-space-xs); }
.heading .signed-out { display: none; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--card-min), 1fr)); gap: var(--openbelt-space-xl) var(--card-gap); }
.app { position: relative; container-type: inline-size; display: flex; flex-direction: column; min-width: 0; color: var(--openbelt-color-primary); text-decoration: none; }
.panel { --pad: var(--openbelt-space-sm); --corner: max(var(--openbelt-radius-lg), 10cqi); position: relative; aspect-ratio: 16 / 11; overflow: hidden; padding: var(--pad) var(--pad) 0; border-radius: var(--corner); background: light-dark(color-mix(in oklab, var(--app) 14%, var(--openbelt-color-surface)), color-mix(in oklab, var(--app) 28%, var(--openbelt-color-surface))); transition: transform var(--openbelt-duration) var(--openbelt-ease), background-color var(--openbelt-duration) var(--openbelt-ease); }
.app:hover .panel { transform: translateY(-2px); }
/* Pressed, a card's tint deepens and it gives slightly. */
.app { -webkit-tap-highlight-color: transparent; }
.app:active .panel { transform: scale(0.985); background: light-dark(color-mix(in oklab, var(--app) 30%, var(--openbelt-color-surface)), color-mix(in oklab, var(--app) 46%, var(--openbelt-color-surface))); transition-duration: 60ms; }
@media (prefers-reduced-motion: reduce) { .app:active .panel { transform: none; } }
.picture { --inner: max(var(--openbelt-radius-sm), calc(var(--corner) - var(--pad))); position: relative; aspect-ratio: 4 / 3; overflow: hidden; border-radius: var(--inner) var(--inner) 0 0; background: var(--openbelt-color-surface); box-shadow: 0 2px 10px rgb(0 0 0 / 0.12), 0 0 0 0.5px rgb(0 0 0 / 0.06); }
.picture img { display: block; position: absolute; top: 0; left: -32.5%; width: 165%; max-width: none; height: auto; }
${THEMED_PICTURES}
.picture .wait { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: var(--openbelt-space-xs); color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.picture .wait b { font: var(--openbelt-type-h3); letter-spacing: var(--openbelt-tracking-h3); color: var(--openbelt-color-border-strong); }
.app .body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: var(--openbelt-space-xs) 2px 0; }
.app .name { font: var(--openbelt-type-body-md); font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The name line holds the app's ⋯ at its end: shown on hover (always on a touch screen), centred on the name, adding no height. */
.app .name:has(.card-more) { display: flex; align-items: center; gap: 4px; overflow: visible; }
.app .name > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.card-more { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; margin: -6px -4px -6px 0; padding: 0; border: 0; border-radius: var(--openbelt-radius-sm); background: none; color: var(--openbelt-color-muted); cursor: pointer; opacity: 0;
  transition: opacity var(--openbelt-duration) var(--openbelt-ease), background-color var(--openbelt-duration) var(--openbelt-ease), color var(--openbelt-duration) var(--openbelt-ease); }
.app:hover .card-more, .card-more:focus-visible, .card-more[aria-expanded="true"] { opacity: 1; }
.card-more:hover, .card-more[aria-expanded="true"] { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.card-more:active { transform: scale(0.92); }
@media (hover: none) { .card-more { opacity: 1; } }
.app-menu { position: fixed; z-index: 20; min-width: 200px; }
.app-menu .menu-item { width: 100%; border: 0; background: none; cursor: pointer; }
.app-menu .danger, .app-menu .danger > .icon { color: var(--openbelt-color-error); }
.app-menu .danger:hover, .app-menu .danger:focus { background: color-mix(in srgb, var(--openbelt-color-error) 10%, transparent); }
.app-menu .head { display: none; }
.menu-scrim { position: fixed; inset: 0; z-index: 19; }
.menu-scrim[hidden] { display: none; }
.confirm { width: min(420px, calc(100vw - 2 * var(--openbelt-space-md))); margin: auto; padding: var(--openbelt-space-lg); border-radius: var(--openbelt-radius-lg); background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); }
.confirm::backdrop { background: rgb(12 11 10 / 0.32); }
.confirm h2 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); overflow-wrap: anywhere; }
.confirm p { margin: var(--openbelt-space-2xs) 0 0; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-md); }
.confirm .error { color: var(--openbelt-color-error); }
.confirm .btns { display: flex; justify-content: flex-end; gap: var(--openbelt-space-xs); margin-top: var(--openbelt-space-lg); }
.btn-delete { background: var(--openbelt-color-error); color: #fff; }
.btn-delete:hover { background: color-mix(in srgb, var(--openbelt-color-error) 86%, #000); }
.btn-delete .spin { display: none; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; }
.btn-delete[aria-busy="true"] { opacity: 0.8; pointer-events: none; }
.btn-delete[aria-busy="true"] .spin { display: inline-block; }
.btn-delete[aria-busy="true"] .icon { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.about { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.about:empty { display: none; }
.app .foot { display: flex; align-items: center; justify-content: space-between; gap: var(--openbelt-space-xs); min-width: 0; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app .foot time, .app .status { flex-shrink: 0; white-space: nowrap; }
.feature { margin-bottom: 0; }
.jump { margin-bottom: 0; }
/* The heading's chevron moves the row along (and back to the start at its end), as a store's section heading does. */
.row-more { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit; cursor: pointer; }
.row-more .icon { width: 20px; height: 20px; color: var(--openbelt-color-muted); transition: transform var(--openbelt-duration) var(--openbelt-ease); }
.row-more:hover .icon, .row-more:focus-visible .icon { color: var(--openbelt-color-primary); transform: translateX(2px); }
.jumps { display: grid; grid-auto-flow: column; grid-auto-columns: 168px; gap: var(--openbelt-space-sm); overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding-inline: 4px; padding: 4px; margin: -4px; scrollbar-width: none; }
.jumps::-webkit-scrollbar { display: none; }
.jumps > .app { scroll-snap-align: start; }
.app.mini .panel { --pad: var(--openbelt-space-xs); }
.app.mini .name { font: 600 14px/1.3 var(--openbelt-font-body); }
.app.mini time { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.feature[hidden] { display: none; }
/* Capped, so on a wide screen the featured app stays about two cards wide, not most of the page. */
.hero { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: var(--openbelt-space-2xl); align-items: center; max-width: 960px; }
/* Capped, so the hero's corner stays near a card's however wide it gets (beside the starters it has no max width). */
.hero .panel { --pad: var(--openbelt-space-lg); --corner: min(7cqi, 24px); aspect-ratio: 16 / 9; padding: var(--pad) 12% 0; }
/* The corner grows with the card (as an app icon's does), so a phone's narrow card and the wide hero read as one shape; the
   picture's corner is the panel's less its padding. Where the browser draws corner-shape, it's iOS's continuous corner
   (superellipse(1.3), 13% of the width, measured off an iOS 26 alert); elsewhere a round one a little smaller. */
@supports (corner-shape: superellipse(1.3)) {
  .panel { --corner: max(var(--openbelt-radius-lg), 13cqi); corner-shape: superellipse(1.3); }
  .hero .panel { --corner: min(9.5cqi, 32px); }
  .picture { corner-shape: superellipse(1.3); }
}
.hero .copy { display: grid; justify-items: start; gap: var(--openbelt-space-2xs); min-width: 0; }
.hero h3 { max-width: 100%; font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hero h3 a { color: inherit; text-decoration: none; }
.hero .about { font: var(--openbelt-type-body-md); }
.hero .who { display: flex; align-items: center; gap: 6px; max-width: 100%; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.hero .acts { display: flex; align-items: center; gap: var(--openbelt-space-2xs); margin-top: var(--openbelt-space-sm); }
.hero .acts .card-more { opacity: 1; width: var(--openbelt-control-height); height: var(--openbelt-control-height); }
.more { display: flex; margin: var(--openbelt-space-lg) auto 0; }
.more[hidden] { display: none; }
mark { background: var(--openbelt-color-subtle); color: inherit; border-radius: 2px; }
.empty.none { padding: var(--openbelt-space-3xl) var(--openbelt-space-md); }
.tiles.app-mock > i:nth-child(3) { display: grid; grid-template-rows: auto auto auto 1fr; place-items: stretch; gap: 5px; padding: 12px; }
.tiles.app-mock b { justify-self: start; }
.tiles b { width: 46%; height: 6px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-border-strong); }
.tiles u { display: block; height: 4px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-border); }
.tiles > i > u:nth-of-type(2) { width: 70%; }
.tiles s { display: flex; align-items: end; gap: 4px; min-height: 0; }
.tiles s u { flex: 1; height: 55%; border-radius: 2px; background: var(--openbelt-color-border); }
.tiles s u:nth-child(2) { height: 100%; background: var(--openbelt-color-border-strong); }
.tiles s u:nth-child(3) { height: 35%; }
.connect { width: min(880px, calc(100vw - 2 * var(--openbelt-space-md))); max-height: calc(100dvh - 2 * var(--openbelt-space-md)); margin: auto; padding: var(--openbelt-space-2xl); border-radius: var(--openbelt-radius-lg); background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); }
.connect[open] { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--openbelt-space-2xl); align-items: center; }
.connect::backdrop { background: rgb(12 11 10 / 0.32); }
.connect .close { position: absolute; top: var(--openbelt-space-sm); right: var(--openbelt-space-sm); }
.scene { display: grid; align-content: center; gap: var(--openbelt-space-md); aspect-ratio: 5 / 4; padding: var(--openbelt-space-xl); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); }
.scene .ask { justify-self: end; max-width: 80%; padding: var(--openbelt-space-xs) var(--openbelt-space-sm); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-sidebar-selected); color: var(--openbelt-color-primary); }
.scene .made { justify-self: start; width: 72%; overflow: hidden; border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-neutral); }
.scene .pic { display: grid; gap: var(--openbelt-space-xs); padding: var(--openbelt-space-sm); border-bottom: 1px solid var(--openbelt-color-border); }
.scene .pic > b { width: 40%; height: 8px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-border-strong); }
.scene .pic > span { display: flex; align-items: end; gap: 6px; height: 56px; }
.scene .pic i { flex: 1; border-radius: 2px; background: var(--openbelt-color-subtle); }
.scene .pic i:first-child { background: var(--openbelt-color-border-strong); }
.scene .cap { display: grid; gap: 2px; padding: var(--openbelt-space-sm); }
.scene .cap b { font-weight: 550; }
.scene .cap span { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.how { display: grid; gap: var(--openbelt-space-md); }
.how h2 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
.how .small { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.how .small a { color: inherit; }
.how .btn-primary { width: 100%; margin-top: var(--openbelt-space-xs); }
.how .other { justify-self: center; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.how .other:hover { color: var(--openbelt-color-primary); }
.connect[open] { grid-template-columns: minmax(0, 1fr); width: min(480px, calc(100vw - 2 * var(--openbelt-space-md))); }
.how .command { margin: 0; padding: var(--openbelt-space-sm) var(--openbelt-space-md); border: 1px solid var(--openbelt-color-border); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); font: var(--openbelt-type-mono-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-tabs { display: flex; gap: 2px; padding: 3px; border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-subtle); }
.agent-tabs button { flex: auto; min-width: 0; height: 32px; padding: 0 var(--openbelt-space-xs); border: 0; border-radius: var(--openbelt-radius-sm); background: none; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); font-weight: 550; white-space: nowrap; cursor: pointer; transition: background-color var(--openbelt-duration) var(--openbelt-ease), color var(--openbelt-duration) var(--openbelt-ease); }
.agent-tabs button:hover { color: var(--openbelt-color-primary); }
.agent-tabs button:active { transform: translateY(1px); }
.agent-tabs button[aria-selected="true"] { background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); }
.agent-panel { display: grid; gap: var(--openbelt-space-md); }
.agent-panel .btn-primary { margin-top: 0; }
/* No apps yet: two steps in order, each a solid row with its one action. Connect turns step 1 done. */
.start .steps { display: grid; gap: var(--openbelt-space-xs); width: min(480px, 100%); margin: var(--openbelt-space-sm) 0 0; padding: 0; list-style: none; text-align: left; }
.start .step { display: flex; align-items: center; gap: var(--openbelt-space-sm); padding: var(--openbelt-space-sm) var(--openbelt-space-sm) var(--openbelt-space-sm) var(--openbelt-space-md); border-radius: var(--openbelt-radius-lg); background: var(--openbelt-color-subtle); }
.start .step .n { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: var(--openbelt-radius-full); background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); font: var(--openbelt-type-body-sm); font-weight: 600; transition: background-color var(--openbelt-duration) var(--openbelt-ease), color var(--openbelt-duration) var(--openbelt-ease); }
.start .step.done .n { background: var(--openbelt-color-success); color: var(--openbelt-color-on-primary); }
.start .step .what { flex: 1; min-width: 0; }
.start .step .what b { display: block; color: var(--openbelt-color-primary); font-weight: 550; }
.start .step .what span { display: block; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); overflow-wrap: anywhere; }
.start .step .btn { flex: none; }
.start .step .btn-plain { background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); }
.start .more-starters { margin-top: var(--openbelt-space-2xs); color: var(--openbelt-color-muted); }
/* Apps' two tabs, under the bar on every visit: the workspace's apps, and the starters anyone in it can add. */
.tabs { display: flex; gap: var(--openbelt-space-2xs); margin: 0 0 var(--openbelt-space-sm); }
.tabs a { display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 var(--openbelt-space-sm); margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--openbelt-color-muted); font-weight: 550; text-decoration: none; transition: color var(--openbelt-duration) var(--openbelt-ease), border-color var(--openbelt-duration) var(--openbelt-ease); }
.tabs a:hover { color: var(--openbelt-color-primary); }
.tabs a:active { transform: translateY(1px); }
.tabs a[aria-current="page"] { color: var(--openbelt-color-primary); border-bottom-color: var(--openbelt-color-primary); }
.tabs .count { font-weight: 400; }
.tabs + .jump .all, .tabs + .lead .all, .tabs + .shelf, .tabs + #all { margin-top: var(--openbelt-space-xl); }
.add { position: relative; flex: none; }
.add-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 4; width: 340px; text-align: left; }
.add-menu .menu-item { width: 100%; height: auto; gap: var(--openbelt-space-sm); padding: var(--openbelt-space-xs) var(--openbelt-space-sm); border: 0; background: none; color: var(--openbelt-color-primary); text-decoration: none; cursor: pointer; }
.add-menu .menu-item:hover, .add-menu .menu-item:focus-visible { background: var(--openbelt-color-subtle); }
.add-menu .mark { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); }
.mark svg { display: block; width: 100%; height: 100%; }
.add-menu .mark .icon { width: 18px; height: 18px; }
.what { flex: 1; min-width: 0; }
.what b { display: block; font-weight: 550; color: var(--openbelt-color-primary); }
.what span { display: block; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
/* Just updated with the starters not added yet beside it, filling the room its copy left; under it, on a phone. */
.lead.with-starters { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--openbelt-space-2xl); align-items: start; }
.lead.with-starters .hero { grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-sm); max-width: none; }
.lead.with-starters .hero .copy { grid-template-columns: minmax(0, 1fr) auto; gap: 2px var(--openbelt-space-sm); align-items: center; }
.lead.with-starters .hero .copy > :not(.acts) { grid-column: 1; }
.lead.with-starters .hero h3 { font: 650 18px/1.25 var(--openbelt-font-display); letter-spacing: var(--openbelt-tracking-h5); }
.lead.with-starters .hero .acts { grid-column: 2; grid-row: 1 / span 3; margin-top: 0; }
.lead:has(> .feature[hidden]) > .side-starters { display: none; }
.lead:has(> .feature[hidden]) { display: block; }
.side-starters .all { display: flex; align-items: baseline; justify-content: space-between; gap: var(--openbelt-space-sm); }
.side-starters .all a { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); font-weight: 550; text-decoration: none; }
.side-starters .all a:hover { color: var(--openbelt-color-primary); }
.srow { display: flex; align-items: center; gap: var(--openbelt-space-sm); padding: var(--openbelt-space-xs) 6px; border-radius: var(--openbelt-radius-md); color: var(--openbelt-color-primary); text-decoration: none; transition: background-color var(--openbelt-duration) var(--openbelt-ease); }
.srow:hover { background: var(--openbelt-color-subtle); }
.srow > .icon { flex: none; color: var(--openbelt-color-muted); }
.srow .added { padding: 0 var(--openbelt-space-sm); color: var(--openbelt-color-muted); font-weight: 550; }
.srow .mark { flex: none; width: 36px; height: 36px; }
.srow .what span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srow .btn, .starter .foot .btn { flex: none; }
[data-starter] .spin { display: none; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; }
[data-starter][aria-busy="true"] { pointer-events: none; opacity: 0.8; }
[data-starter][aria-busy="true"] .spin { display: inline-block; }
.starter-error { margin: var(--openbelt-space-xs) 0 0; color: var(--openbelt-color-error); font: var(--openbelt-type-body-sm); }
/* The Starters tab: each starter's picture made ahead (or its icon), what it is, and Add, or Added and a way to it. */
.starters-grid { margin-top: var(--openbelt-space-md); }
.starter .picture.glyph { display: grid; place-items: center; background: color-mix(in oklab, var(--app) 8%, var(--openbelt-color-surface)); }
.starter .picture.glyph svg { width: 22cqi; height: 22cqi; }
.starter .body { flex: 1; grid-template-rows: auto auto 1fr; }
.starter .foot { min-height: 32px; align-self: end; }
/* Added takes Add's place: the same end of the row, as tall as the button, so a card keeps its shape once added. */
/* A starter's icon before its name: a template, not one of your apps. */
.starter .name { display: flex; align-items: center; gap: var(--openbelt-space-xs); }
.starter .name > .tmark { flex: none; width: 22px; height: 22px; }
.starter .name > .tmark svg { display: block; width: 100%; height: 100%; }
/* A starter's page: its picture beside what it is, Add (or Open and Remove), and what's inside; one column on a phone. */
.crumb { display: inline-flex; align-items: center; gap: 2px; margin: var(--openbelt-space-md) 0; color: var(--openbelt-color-muted); font-weight: 550; text-decoration: none; }
.crumb:hover { color: var(--openbelt-color-primary); }
.sp { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--openbelt-space-2xl); align-items: start; }
.sp-pic .panel { --pad: var(--openbelt-space-lg); --corner: 28px; aspect-ratio: 16 / 11; padding: var(--pad) 10% 0; }
.app.sp-pic:hover .panel { transform: none; }
.sp-head { display: flex; gap: var(--openbelt-space-sm); align-items: center; }
.sp-head .mark { flex: none; width: 56px; height: 56px; }
.sp-head h2 { font: var(--openbelt-type-h4); letter-spacing: var(--openbelt-tracking-h4); }
.sp-head p { margin: 2px 0 0; color: var(--openbelt-color-muted); }
.sp-acts { display: flex; gap: var(--openbelt-space-xs); margin: var(--openbelt-space-lg) 0 0; }
.sp-acts .btn { flex: 1; justify-content: center; }
.sp-acts .remove { flex: none; color: var(--openbelt-color-error); }
/* The app that already has the starter's name, above Add as journal-2 (or Open and Remove, once added). */
.taken { display: flex; align-items: center; gap: var(--openbelt-space-sm); margin: var(--openbelt-space-lg) 0 0; padding: var(--openbelt-space-sm); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-subtle); }
.taken + .sp-acts { margin-top: var(--openbelt-space-xs); }
.taken .initial { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: var(--openbelt-radius-sm); background: light-dark(color-mix(in oklab, var(--app) 22%, var(--openbelt-color-surface)), color-mix(in oklab, var(--app) 40%, var(--openbelt-color-surface))); color: var(--openbelt-color-primary); font-weight: 650; }
.taken .what span { display: block; }
.facts { display: grid; gap: var(--openbelt-space-md); margin: var(--openbelt-space-xl) 0 0; }
.facts dt { margin-bottom: 4px; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); font-weight: 550; }
.facts dd { margin: 0; line-height: 1.6; }
.facts code { padding: 1px 6px; border-radius: 6px; background: var(--openbelt-color-subtle); font: var(--openbelt-type-mono-sm); }
.prompt { display: flex; gap: var(--openbelt-space-sm); align-items: flex-start; padding: var(--openbelt-space-sm) var(--openbelt-space-sm) var(--openbelt-space-sm) var(--openbelt-space-md); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-subtle); }
.prompt p { flex: 1; margin: 0; font: var(--openbelt-type-body-sm); }
.prompt .btn { flex: none; }
.frows { display: grid; gap: 2px; }
.starter .added { display: inline-flex; align-items: center; height: var(--openbelt-control-height); padding: 0 var(--openbelt-space-sm); border: 0; border-radius: var(--openbelt-radius-sm); background: none; color: var(--openbelt-color-muted); font: inherit; font-weight: 550; }
.start .step .btn-plain:hover { background: color-mix(in srgb, var(--openbelt-color-neutral) 70%, var(--openbelt-color-border)); }
.asks { margin: var(--openbelt-space-md) 0 0; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); }
.asks a { color: var(--openbelt-color-primary); }
@media (max-width: 820px) {
  main { padding: 0 var(--openbelt-space-md) var(--openbelt-space-3xl); }
  main { --card-min: 200px; --card-gap: var(--openbelt-space-sm); }
  /* One bar on a phone, as the app frame's panel has: menu, Apps and the count, sticky, over a hairline; search and sort share the row under it. */
  .toolbar { display: contents; }
  .heading { position: sticky; top: 0; z-index: 3; min-height: 52px; margin: 0 calc(-1 * var(--openbelt-space-md)); padding: 0 var(--openbelt-space-md) 0 var(--openbelt-space-2xs); gap: var(--openbelt-space-2xs); border-bottom: 1px solid var(--openbelt-color-border); background: var(--openbelt-color-neutral); }
  .heading .drawer { display: inline-flex; }
  .heading h1 { font: var(--openbelt-type-h5); letter-spacing: var(--openbelt-tracking-h5); margin-left: 2px; }
  .tools { display: flex; gap: var(--openbelt-space-xs); padding: var(--openbelt-space-sm) 0 var(--openbelt-space-2xs); }
  .tools .input { height: 36px; border-color: transparent; background: var(--openbelt-color-subtle); }
  /* The sort shows its choice at 13 px over a see-through 16 px select: under 16 px, iOS Safari zooms into a field it opens. */
  .tools .select { flex: none; }
  .tools .select .shown { display: flex; align-items: center; height: 36px; padding: 0 32px 0 12px; border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); font: var(--openbelt-type-label); font-weight: 400; }
  .tools .select select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; }
  .tools .select:has(select:focus-visible) .shown { box-shadow: 0 0 0 3px color-mix(in srgb, var(--openbelt-color-primary) 14%, transparent); }
  .search .icon { top: 10px; }
  .search #clear { top: 5px; }
  .toolbar + .jump .all, .toolbar + .feature .all { margin-top: var(--openbelt-space-md); }
  .jump { margin: 0 calc(-1 * var(--openbelt-space-md)); }
  .jump .all { margin-left: var(--openbelt-space-md); margin-right: var(--openbelt-space-md); }
  .jumps { grid-auto-columns: 148px; padding: 4px var(--openbelt-space-md); margin: -4px 0; scroll-padding-inline: var(--openbelt-space-md); }
  .app .name { font: 600 14px/1.3 var(--openbelt-font-body); }
  .connect { padding: var(--openbelt-space-xl) var(--openbelt-space-lg) var(--openbelt-space-lg); }
  .connect[open] { grid-template-columns: minmax(0, 1fr); }
  .scene { display: none; }
  .toolbar .grow { display: none; }
  .search { flex: 1 1 auto; }
  .search .kbd, .heading .kbd { display: none; }
  .heading { flex-wrap: wrap; row-gap: var(--openbelt-space-2xs); }
  .heading #clear { margin-left: auto; }
  .heading .signed-out { display: block; flex-basis: 100%; padding: 0 0 var(--openbelt-space-xs) 6px; color: var(--openbelt-color-muted); }
  .search .input { padding-right: 10px; }
  .grid { row-gap: var(--openbelt-space-lg); }
  .shelf header .btn { display: none; }
  .hero { grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-sm); }
  .hero .panel { --pad: var(--openbelt-space-sm); aspect-ratio: 2 / 1; padding: var(--pad) 12% 0; }
  /* The featured app's name, description and owner beside a small Open, not stacked over a full-width button. */
  .hero .copy { grid-template-columns: minmax(0, 1fr) auto; gap: 2px var(--openbelt-space-sm); align-items: center; }
  .hero .copy > :not(.acts) { grid-column: 1; }
  .hero h3 { font: 650 17px/1.25 var(--openbelt-font-display); letter-spacing: var(--openbelt-tracking-h5); }
  .hero .about { font: 400 13px/1.45 var(--openbelt-font-body); }
  .hero .acts { grid-column: 2; grid-row: 1 / span 3; margin-top: 0; }
  .lead.with-starters { grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-sm); }
  .sp { grid-template-columns: minmax(0, 1fr); gap: var(--openbelt-space-lg); }
  .sp-pic .panel { --pad: var(--openbelt-space-sm); --corner: 20px; }
  .add .label { display: none; }
  .add > .btn { width: 36px; height: 36px; padding: 0; }
  .add-menu { position: fixed; left: var(--openbelt-space-md); right: var(--openbelt-space-md); top: 112px; width: auto; }
}
@media (max-width: 820px) {
  .card-more { opacity: 1; }
}
/* On a phone the menu is a sheet from the bottom, under the app's name, and the question to delete is one too. */
@media (max-width: 560px) {
  .app-menu { left: 0 !important; right: 0; top: auto !important; bottom: 0; min-width: 0; padding: var(--openbelt-space-xs) var(--openbelt-space-xs) calc(var(--openbelt-space-sm) + env(safe-area-inset-bottom)); border-radius: var(--openbelt-radius-lg) var(--openbelt-radius-lg) 0 0; }
  .app-menu .head { display: grid; gap: 2px; padding: var(--openbelt-space-xs) var(--openbelt-space-sm) var(--openbelt-space-sm); margin-bottom: var(--openbelt-space-2xs); border-bottom: 1px solid var(--openbelt-color-border); }
  .app-menu .head b { font: 600 15px/1.3 var(--openbelt-font-body); overflow-wrap: anywhere; }
  .app-menu .head span { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
  .app-menu .menu-item { height: 48px; padding: 0 var(--openbelt-space-sm); font-size: 16px; }
  .app-menu .menu-sep { display: none; }
  .menu-scrim { background: rgb(12 11 10 / 0.32); }
  .confirm { width: 100%; max-width: none; margin: auto 0 0; padding: var(--openbelt-space-lg) var(--openbelt-space-md) calc(var(--openbelt-space-md) + env(safe-area-inset-bottom)); border-radius: var(--openbelt-radius-lg) var(--openbelt-radius-lg) 0 0; }
  /* Side by side, Cancel first: a thumb aiming at one never lands on the other. */
  .confirm .btns { display: grid; grid-template-columns: 1fr 1fr; gap: var(--openbelt-space-sm); }
  .confirm .btns .btn { height: 48px; font-size: 16px; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .panel { --pad: var(--openbelt-space-xs); }
  .track { grid-auto-columns: 46%; }
}
`

const SCRIPT = `
const data = JSON.parse(document.getElementById("data").textContent)
const now = Date.now()
const state = { q: data.q, sort: data.sort, total: data.total, next: data.next }
const grid = document.getElementById("grid")
const ago = (iso) => { if (!iso) return "not live"; const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000)); return m < 1 ? "just now" : m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : m < 10080 ? Math.round(m / 1440) + "d" : Math.round(m / 10080) + "w" }
const dated = (root) => { for (const el of root.querySelectorAll("[data-ago]")) { if (!el.dataset.ago) continue; const said = ago(el.dataset.ago); const verb = el.dataset.long || "updated"; el.textContent = el.dataset.long === undefined ? said : said === "just now" ? verb + " just now" : verb + " " + said + " ago" } }
const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const mark = (text, q) => { const i = q ? text.toLowerCase().indexOf(q) : -1; return i < 0 ? esc(text) : esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length)) }
const marked = (root) => {
  const q = state.q.trim().toLowerCase()
  for (const el of root.querySelectorAll(".app")) for (const part of el.querySelectorAll(".name > span:not(.tmark), .about")) part.innerHTML = mark(part.textContent, q)
}
const waits = (root) => {
  for (const el of root.querySelectorAll(".picture[data-wait]")) {
    let tries = 0
    const look = () => fetch("/a/" + el.dataset.wait + "/_shot", { cache: "no-store" }).then((r) => {
      if (r.ok) { el.innerHTML = ${JSON.stringify(pictures("/a/APP/_shot?t=NOW"))}.replaceAll("APP", el.dataset.wait).replaceAll("NOW", Date.now()); return }
      if (++tries < 40) setTimeout(look, 4000)
    }, () => {})
    setTimeout(look, 4000)
  }
}
const feature = document.getElementById("feature")
const jump = document.getElementById("jump")
const shelves = [...document.querySelectorAll(".shelf")]
for (const shelf of shelves) shelf.dataset.empty = String(shelf.querySelector(".track").children.length === 0)
const asked = () => {
  const p = new URLSearchParams()
  if (state.q.trim()) p.set("q", state.q.trim())
  if (state.sort !== "updated") p.set("sort", state.sort)
  return p
}
// The server finds, sorts and pages (a workspace can have thousands of apps); each change asks it again, and only the newest answer shows.
let asking = 0
// The grid says it's busy (aria-busy) from a change until its answer shows: for assistive technology, and for checks to wait on.
const busy = (on) => { if (!grid) return; if (on) grid.setAttribute("aria-busy", "true"); else grid.removeAttribute("aria-busy") }
const load = (from) => {
  const mine = ++asking
  busy(true)
  const p = asked()
  p.set("grid", "1")
  if (from) p.set("from", String(from))
  return fetch("/?" + p, { cache: "no-store" }).then((r) => r.json()).then((page) => {
    if (mine !== asking || !grid) return
    // No apps left (the last one deleted) and no search: the empty page (how to start, the starters) is the server's to draw.
    if (page.total === 0 && !state.q) return location.reload()
    const got = document.createElement("template")
    got.innerHTML = page.html
    dated(got.content)
    marked(got.content)
    waits(got.content)
    if (from) grid.append(got.content)
    else {
      grid.replaceChildren(got.content)
      feature.innerHTML = page.hero
      feature.hidden = page.hero === ""
      dated(feature)
      waits(feature)
    }
    state.total = page.total
    state.next = page.next
    const shown = asked().toString()
    history.replaceState(history.state, "", shown ? "?" + shown : location.pathname)
    busy(false)
    render()
  }, () => { if (mine === asking) busy(false) })
}
let typing
const changed = () => { clearTimeout(typing); load(0) }
function render() {
  if (!grid) return
  const q = state.q.trim().toLowerCase()
  const filtered = q !== ""
  const css = getComputedStyle(grid)
  const cols = css.gridTemplateColumns.split(" ").length
  for (const shelf of shelves) {
    shelf.style.setProperty("--cols", String(cols))
    shelf.hidden = shelf.dataset.empty === "true" || filtered || state.sort === "updated" || state.total <= cols
  }
  document.getElementById("clear").hidden = !filtered
  document.getElementById("none").hidden = state.total > 0
  document.getElementById("count").textContent = String(state.total)
  document.getElementById("more").hidden = state.next === null
  if (jump) jump.hidden = filtered || state.sort !== "updated"
  document.getElementById("all").hidden = shelves.every((shelf) => shelf.hidden) && feature.hidden && (jump?.hidden ?? true)
}
const copied = (button) => {
  button.dataset.was ??= button.innerHTML
  button.innerHTML = ${JSON.stringify(icon("check"))} + (button.textContent.trim() === "" ? "" : "Copied")
  clearTimeout(button.t)
  button.t = setTimeout(() => { button.innerHTML = button.dataset.was }, 1400)
}
const reset = () => { state.q = ""; const q = document.getElementById("q"); if (q) q.value = "" }
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-filter], [data-copy], [data-scroll], [data-jumps], #clear, #clear-none, #more")
  if (!t) return
  if (t.dataset.filter && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0)) e.preventDefault()
  if (t.dataset.jumps !== undefined) { const row = document.querySelector(".jumps"); const end = row.scrollLeft + row.clientWidth >= row.scrollWidth - 4; row.scrollTo({ left: end ? 0 : row.scrollLeft + row.clientWidth * 0.8, behavior: "smooth" }); return }
  if (t.dataset.scroll) { const track = t.closest(".shelf").querySelector(".track"); track.scrollBy({ left: Number(t.dataset.scroll) * track.clientWidth * 0.8, behavior: "smooth" }); return }
  if (t.dataset.copy) { navigator.clipboard?.writeText(t.dataset.copy).catch(() => {}); copied(t); return }
  if (t.id === "more") { if (state.next !== null) load(state.next); return }
  reset()
  changed()
})
${MAIN_SCRIPT}
// iOS shows :active only on a page that listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true })
document.getElementById("q")?.addEventListener("input", (e) => { state.q = e.target.value; clearTimeout(typing); busy(true); typing = setTimeout(() => load(0), 150) })
document.getElementById("sort")?.addEventListener("change", (e) => { state.sort = e.target.value; e.target.parentElement.querySelector(".shown").textContent = e.target.selectedOptions[0].textContent; changed() })
addEventListener("resize", () => render())
{
  const bar = document.querySelector(".toolbar")
  const pane = document.querySelector(".inset")
  const stick = () => bar.classList.toggle("stuck", pane.scrollTop > 0)
  pane.addEventListener("scroll", stick, { passive: true })
  stick()
  // Back from an app: the back/forward cache restores the page as it was; when the browser loads it again instead (or on
  // a reload), the place kept here (pane on desktop, window on a phone, how many cards Show more had loaded) is put back.
  history.scrollRestoration = "manual"
  addEventListener("pagehide", () => history.replaceState({ ...history.state, gallery: { top: pane.scrollTop, y: scrollY, cards: grid?.children.length ?? 0 } }, ""))
  const arrived = performance.getEntriesByType("navigation")[0]?.type
  const kept = history.state?.gallery
  if (kept && (arrived === "back_forward" || arrived === "reload")) {
    const more = () => {
      const had = grid?.children.length ?? 0
      return had < kept.cards && state.next !== null ? load(state.next).then(() => (grid.children.length > had ? more() : undefined)) : Promise.resolve()
    }
    more().then(() => { pane.scrollTop = kept.top; scrollTo(0, kept.y) })
  }
  // A page shown again from a cache may be for someone who has since signed out or in: it loads again if so.
  const recheck = () => fetch("/_me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((who) => { if ((who?.email ?? null) !== data.viewer) location.reload() }, () => {})
  addEventListener("pageshow", (e) => { if (e.persisted) recheck() })
  if (arrived === "back_forward") recheck()
}
document.addEventListener("keydown", (e) => {
  const typed = e.target.matches("input, select, textarea")
  if (e.key === "/" && !typed) { e.preventDefault(); document.querySelector("#q, #sq")?.focus() }
  if (e.key === "Escape") { if (typed) e.target.blur(); if (state.q) { reset(); changed() } }
})
dated(document)
marked(document)
waits(document)
// Capture: Add sits inside a starter's card or row, a link to its page, and adds instead of following it.
document.addEventListener("click", async (e) => {
  const add = e.target.closest("[data-starter]")
  if (!add) return
  e.preventDefault()
  e.stopPropagation()
  if (add.getAttribute("aria-busy") === "true") return
  const error = document.getElementById("starter-error")
  add.setAttribute("aria-busy", "true")
  error.hidden = true
  try {
    const response = await fetch("/_starters/" + encodeURIComponent(add.dataset.starter), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form: data.form, app: add.dataset.as }) })
    const said = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(said.error || "Couldn't add it. Try again.")
    location.href = said.url
  } catch (failed) {
    error.textContent = failed.message
    error.hidden = false
    add.removeAttribute("aria-busy")
  }
}, true)
const addToggle = document.getElementById("add-toggle")
const addMenu = document.getElementById("add-menu")
const showAdd = (on) => { if (!addToggle) return; addMenu.hidden = !on; addToggle.setAttribute("aria-expanded", String(on)); if (on) addMenu.querySelector(".menu-item")?.focus() }
addToggle?.addEventListener("click", () => showAdd(addMenu.hidden))
document.addEventListener("click", (e) => { if (addMenu && !addMenu.hidden && !e.target.closest(".add")) showAdd(false) })
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && addMenu && !addMenu.hidden) { showAdd(false); addToggle.focus() } })
// The Starters tab's search: every starter is on the page, so it filters them there (on a starter's page, the others).
const starterSearch = document.getElementById("sq")
starterSearch?.addEventListener("input", () => {
  const q = starterSearch.value.trim().toLowerCase()
  let shown = 0
  for (const card of document.querySelectorAll("main [data-find]")) { card.hidden = q !== "" && !card.dataset.find.includes(q); if (!card.hidden) shown++ }
  const none = document.getElementById("no-starters")
  if (none) none.hidden = shown > 0
})
const dialog = document.getElementById("connect")
if (dialog) {
  for (const opener of document.querySelectorAll("[data-open=connect]")) opener.addEventListener("click", () => { showAdd(false); dialog.showModal() })
  dialog.addEventListener("click", (e) => { if (e.target === dialog || e.target.closest("[data-close]")) dialog.close(); if (e.target.closest("[data-copy]")) document.getElementById("step-connect")?.classList.add("done"); const tab = e.target.closest("[data-agent]"); if (tab) pickAgent(tab.dataset.agent, true) })
  const pickAgent = (id, keep) => {
    if (!document.getElementById("agent-" + id)) return
    for (const t of dialog.querySelectorAll("[data-agent]")) { t.setAttribute("aria-selected", String(t.dataset.agent === id)); document.getElementById("agent-" + t.dataset.agent).hidden = t.dataset.agent !== id }
    if (keep) try { localStorage.setItem("openbelt.agent", id) } catch {}
  }
  try { const kept = localStorage.getItem("openbelt.agent"); if (kept) pickAgent(kept, false) } catch {}
}
// The empty page (no apps yet) shows the first one an agent makes: it asks until there is one. Not the Starters tab, which has no grid either.
if (document.querySelector(".start")) {
  const poll = () => fetch("/?grid=1", { cache: "no-store" }).then((r) => r.json()).then((s) => { if (s.total > 0) location.reload(); else setTimeout(poll, 3000) }, () => setTimeout(poll, 3000))
  setTimeout(poll, 3000)
}
// Each app's ⋯ opens the one menu, below the ⋯ (above it near the bottom), or as a sheet on a phone. Delete asks first.
const menu = document.getElementById("app-menu")
if (menu) {
  const scrim = document.querySelector(".menu-scrim")
  const confirmBox = document.getElementById("confirm-delete")
  const sheet = () => matchMedia("(max-width: 560px)").matches
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter((el) => !el.hidden)
  let opener = null
  const close = (focus) => {
    if (menu.hidden) return
    menu.hidden = true
    scrim.hidden = true
    opener?.setAttribute("aria-expanded", "false")
    if (focus) opener?.focus()
  }
  const open = (button, pointer) => {
    opener = button
    const name = button.dataset.more
    const may = button.dataset.manage !== undefined
    menu.dataset.app = name
    menu.querySelector(".head b").textContent = name
    menu.querySelector(".head span").textContent = button.closest(".app, .copy")?.querySelector(".about")?.textContent ?? ""
    menu.querySelector('[data-act="open"]').href = location.origin + "/" + encodeURIComponent(name)
    menu.querySelector('[data-act="delete"]').hidden = !may
    menu.querySelector(".menu-sep").hidden = !may
    menu.hidden = false
    scrim.hidden = false
    button.setAttribute("aria-expanded", "true")
    if (!sheet()) {
      const at = button.getBoundingClientRect()
      const size = menu.getBoundingClientRect()
      const below = at.bottom + 4 + size.height <= innerHeight - 8
      menu.style.top = (below ? at.bottom + 4 : Math.max(8, at.top - 4 - size.height)) + "px"
      menu.style.left = Math.max(8, Math.min(at.right - size.width, innerWidth - size.width - 8)) + "px"
    }
    ;(pointer ? menu : items()[0])?.focus({ preventScroll: true })
  }
  // Capture, so a ⋯ inside a card's link opens the menu instead of the app.
  document.addEventListener("click", (e) => {
    const button = e.target.closest(".card-more")
    if (button) {
      e.preventDefault()
      e.stopPropagation()
      const again = button === opener && !menu.hidden
      close(false)
      if (!again) open(button, e.detail > 0)
      return
    }
    if (!menu.hidden && !menu.contains(e.target)) close(false)
  }, true)
  menu.addEventListener("keydown", (e) => {
    const all = items()
    const i = all.indexOf(document.activeElement)
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (step) { e.preventDefault(); all[i === -1 ? (step > 0 ? 0 : all.length - 1) : (i + step + all.length) % all.length]?.focus() }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true) }
    else if (e.key === "Tab") close(false)
  })
  document.querySelector(".inset")?.addEventListener("scroll", () => { if (!sheet()) close(false) }, { passive: true })
  addEventListener("resize", () => close(false))
  const gone = confirmBox.querySelector("h2 + p")
  const goes = gone.textContent
  const ask = (name, stays) => {
    confirmBox.dataset.app = name
    confirmBox.querySelector("h2").textContent = "Delete " + name + "?"
    gone.textContent = stays ? goes + " " + stays : goes
    const error = confirmBox.querySelector(".error")
    error.hidden = true
    error.textContent = ""
    confirmBox.showModal()
    confirmBox.querySelector("[data-keep]").focus()
  }
  menu.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]")
    if (!t) return
    const name = menu.dataset.app
    if (t.dataset.act === "open") return close(false)
    if (t.dataset.act === "link") {
      navigator.clipboard?.writeText(location.origin + "/" + encodeURIComponent(name)).catch(() => {})
      const label = t.querySelector("span")
      label.textContent = "Copied"
      setTimeout(() => { label.textContent = "Copy link"; close(false) }, 700)
      return
    }
    if (t.dataset.act === "delete") { close(false); ask(name) }
  })
  // Capture, so Remove inside an added starter's link asks instead of opening the app.
  document.addEventListener("click", (e) => { const remove = e.target.closest("[data-remove]"); if (!remove) return; e.preventDefault(); e.stopPropagation(); ask(remove.dataset.remove, remove.dataset.stays) }, true)
  confirmBox.addEventListener("click", async (e) => {
    const box = confirmBox.getBoundingClientRect()
    const outside = e.target === confirmBox && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)
    if (outside || e.target.closest("[data-keep]")) return confirmBox.close()
    const go = e.target.closest("[data-confirm]")
    if (!go || go.getAttribute("aria-busy") === "true") return
    const name = confirmBox.dataset.app
    const error = confirmBox.querySelector(".error")
    go.setAttribute("aria-busy", "true")
    error.hidden = true
    try {
      const response = await fetch("/" + encodeURIComponent(name) + "/_delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form: data.form }) })
      const said = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(said.error || "Couldn't delete " + name + ". Try again.")
      confirmBox.close()
      // On the Starters tab, the starter's card goes back to Add: the server's to draw.
      if (!grid) return location.reload()
      for (const el of document.querySelectorAll('.app[data-app="' + CSS.escape(name) + '"]')) el.remove()
      for (const shelf of shelves) shelf.dataset.empty = String(shelf.querySelector(".track").children.length === 0)
      load(0)
    } catch (failed) {
      error.textContent = failed.message
      error.hidden = false
    } finally {
      go.removeAttribute("aria-busy")
    }
  })
}
render()
`

const SORTS = [
  ["updated", "Updated"],
  ["created", "Newest"],
  ["name", "Name"],
] as const

const SHELVES = [["recent", "Recently updated"]]
  .map(
    ([id, label]) =>
      `<section class="shelf" data-shelf="${id}" hidden><header><h2>${label}</h2><button class="btn btn-ghost btn-square" data-scroll="-1" aria-label="Back">${icon("chevronLeft")}</button><button class="btn btn-ghost btn-square" data-scroll="1" aria-label="Forward">${icon("chevronRight")}</button></header><div class="track"></div></section>`,
  )
  .join("")

/** The app's tinted panel with its picture: the card's top, and the hero's. */
const panel = (app: Card) => {
  const caption = !app.entered
    ? ""
    : app.updated === null
      ? "Only in preview environments"
      : app.coming
        ? "Taking a picture"
        : ""

  const picture =
    app.shot === null
      ? `<div class="picture" ${app.coming ? `data-wait="${escape(app.name)}"` : ""}><div class="wait"><b>${escape(initials(app.name))}</b>${caption && `<span>${caption}</span>`}</div></div>`
      : `<div class="picture">${pictures(`${escape(appPath(app.name))}_shot?v=${encodeURIComponent(app.shot)}`)}</div>`

  return `<div class="panel">${picture}</div>`
}

const opens = (app: Card, origin: string) =>
  `href="${escape(`${origin}/${app.name}`)}" data-app="${escape(app.name)}" style="--app:${escape(app.color)}"`

/** When it went live (the page's script says how long ago), or why it isn't. */
const when = (app: Card, long = false) =>
  app.updated === null
    ? `<span class="status">${app.entered ? "Not live" : "Not published"}</span>`
    : `<time datetime="${escape(app.updated)}" data-ago="${escape(app.updated)}"${long ? " data-long" : ""}>${escape(app.updated.slice(0, 10))}</time>`

/** Who made it, short: You for the viewer's own apps, otherwise the name before their email's @ (the whole email is its title). */
const author = (app: Card, viewer: string | null) =>
  `<span class="author" title="${escape(app.owner)}">${escape(app.owner === viewer ? "You" : (app.owner.split("@")[0] ?? app.owner))}</span>`

/** The ⋯ that opens the app's menu (one menu for the page, moved to it by the page script): Open in new tab, Copy link, Delete. */
const more = (app: Card) =>
  `<button type="button" class="card-more" aria-label="More for ${escape(app.name)}" aria-haspopup="menu" aria-expanded="false" aria-controls="app-menu" data-more="${escape(app.name)}"${app.manage ? " data-manage" : ""}>${icon("moreHorizontal")}</button>`

const card = (app: Card, origin: string, viewer: string | null) =>
  `<a class="app" ${opens(app, origin)}>
${panel(app)}
<div class="body">
<div class="name"><span>${escape(app.name)}</span>${more(app)}</div>
<div class="about">${escape(app.description)}</div>
<div class="foot">${author(app, viewer)}${when(app)}</div>
</div>
</a>`

/** The newest app, large, above the rest: its picture (which opens it), what it is and who made it. No Open: it was too loud. */
const hero = (app: Card, origin: string, viewer: string | null) =>
  `<h2 class="all">Just updated</h2>
<div class="hero">
<a class="app" ${opens(app, origin)} aria-label="Open ${escape(app.name)}">${panel(app)}</a>
<div class="copy">
<h3><a href="${escape(`${origin}/${app.name}`)}">${escape(app.name)}</a></h3>
<div class="about">${escape(app.description)}</div>
<p class="who">${author(app, viewer)}·${when(app, true)}</p>
<div class="acts">${more(app)}</div>
</div>
</div>`

/** The apps the viewer opened last, small, in a row that scrolls sideways: back to what they were using in one tap. */
const jumpBackIn = (jump: Gallery["jump"], origin: string, shown: boolean) =>
  jump.length === 0
    ? ""
    : `<section class="jump" id="jump"${shown ? "" : " hidden"}><h2 class="all"><button type="button" class="row-more" data-jumps aria-label="Jump back in: show more">Jump back in${icon("chevronRight")}</button></h2><div class="jumps">${jump
        .map(
          ({ card: app, opened }) =>
            `<a class="app mini" ${opens(app, origin)}>${panel(app)}<div class="body"><div class="name"><span>${escape(app.name)}</span></div><time datetime="${escape(opened)}" data-ago="${escape(opened)}" data-long="opened">${escape(opened.slice(0, 10))}</time></div></a>`,
        )
        .join("")}</div></section>`

/** How many apps a workspace has before the gallery features its newest: with fewer, there's nothing to set it apart from. */
const FEATURED_FROM = 4

/**
 * A page of the gallery: the newest app featured (the first page of all apps by Recently updated, once there are FEATURED_FROM),
 * and the grid's cards. The page and its script (`/?grid=1`) both take it from here.
 */
export const galleryParts = (
  cards: ReadonlyArray<Card>,
  shown: {
    readonly q: string
    readonly sort: string
    readonly from: number
    readonly total: number
  },
  origin: string,
  viewer: string | null,
) => {
  const [first, ...rest] = cards

  const featured =
    first !== undefined &&
    shown.q.trim() === "" &&
    shown.sort === "updated" &&
    shown.from === 0 &&
    shown.total >= FEATURED_FROM

  return featured
    ? { hero: hero(first, origin, viewer), grid: galleryCards(rest, origin, viewer) }
    : { hero: "", grid: galleryCards(cards, origin, viewer) }
}

const signedOut = (viewer: Home["viewer"]) =>
  viewer === null ? `<p class="signed-out">Not signed in. Settings need a sign-in.</p>` : ""

export const tiles = (front: string, kind = "") =>
  `<div class="art tiles${kind === "" ? "" : ` ${kind}`}" aria-hidden="true"><i></i><i></i><i>${front}</i></div>`

const STACK = tiles("<b></b><u></u><u></u><s><u></u><u></u><u></u></s>", "app-mock")

/** Each agent's commands to add OpenBelt for every folder and sign in (OAuth): no token to paste. Codex signs in as it adds. */
const AGENTS = (address: string) =>
  [
    [
      "claude",
      "Claude Code",
      `claude mcp add --scope user --transport http openbelt ${address}\nclaude mcp login openbelt`,
    ],
    ["codex", "Codex", `codex mcp add openbelt --url ${address}`],
    ["pi", "pi", `pi mcp add openbelt --url ${address}\npi mcp login openbelt`],
    [
      "opencode",
      "opencode",
      `opencode mcp add openbelt --url ${address} --global\nopencode mcp auth openbelt`,
    ],
  ] as const

/** A tab per agent, each with its commands and one Copy; the page script remembers the last tab. */
const connectDialog = (address: string) => {
  const agents = AGENTS(address)

  return `<dialog class="connect overlay" id="connect" aria-labelledby="connect-title">
<button type="button" class="btn btn-ghost btn-square close" data-close aria-label="Close">${icon("x")}</button>
<div class="how">
<h2 id="connect-title">Connect an agent</h2>
<div class="agent-tabs" role="tablist" aria-label="Agent">${agents.map(([id, name], i) => `<button type="button" role="tab" id="tab-${id}" aria-controls="agent-${id}" aria-selected="${i === 0}" data-agent="${id}">${escape(name)}</button>`).join("")}</div>
${agents.map(([id, , command], i) => `<div class="agent-panel" role="tabpanel" id="agent-${id}" aria-labelledby="tab-${id}"${i === 0 ? "" : " hidden"}><pre class="command"><code>${escape(command)}</code></pre><button type="button" class="btn btn-primary btn-lg" data-copy="${escape(command)}">${icon("copy")}Copy command</button></div>`).join("\n")}
<a class="other" href="/_settings/agents">Other agents and tokens</a>
</div>
</dialog>`
}

/** What step 2 asks the agent to build: shown under "Ask it to build", copied as a prompt with this workspace's host (whose /auth.md says how to connect). */
const IDEA = "a live team poll"

/** Where the Starters tab is: Apps with ?tab=starters. */
const STARTERS_TAB = "/?tab=starters"

/** How many starters not added yet Yours lists beside Just updated; See all opens the rest. */
const SIDE_STARTERS = 5

const titled = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/** Apps' two tabs, on every visit: the workspace's apps (the count the page script keeps), and every starter. */
const tabs = (tab: Home["tab"], total: number, starters: number) =>
  `<nav class="tabs" aria-label="Apps"><a href="/"${tab === "yours" ? ' aria-current="page"' : ""}>Yours<span class="count"${tab === "yours" ? ' id="count"' : ""}>${total}</span></a><a href="${STARTERS_TAB}"${tab === "starters" ? ' aria-current="page"' : ""}>Starters<span class="count">${starters}</span></a></nav>`

/** Add app: build one with your agent (how to connect it), or pick a starter. */
const ADD_APP = `<div class="add"><button type="button" class="btn btn-secondary" id="add-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="add-menu">${icon("plus")}<span class="label">Add app</span></button>
<div class="menu overlay add-menu" role="menu" id="add-menu" hidden>
<button type="button" class="menu-item" role="menuitem" data-open="connect"><span class="mark" aria-hidden="true">${icon("terminal")}</span><span class="what"><b>Build with your agent</b><span>Claude Code, Codex, pi or opencode</span></span></button>
<a class="menu-item" role="menuitem" href="${STARTERS_TAB}"><span class="mark" aria-hidden="true">${icon("grid")}</span><span class="what"><b>Browse starter apps</b><span>Ready-made, in your workspace in a second</span></span>${icon("chevronRight")}</a>
</div></div>`

const addButton = (s: StarterCard) =>
  `<button type="button" class="btn btn-secondary" data-starter="${escape(s.name)}"><span class="spin"></span>Add</button>`

const STARTER_ERROR = `<p class="starter-error" id="starter-error" role="alert" hidden></p>`

/** A starter's page: the Starters tab with ?starter=<name>. */
const starterPage = (name: string) => `${STARTERS_TAB}&amp;starter=${encodeURIComponent(name)}`

/**
 * Added for one in the workspace, else Add (which, inside a link, adds instead of following it); nothing when another app has
 * its name, since its page says so and adds it under a free one.
 */
const addOrAdded = (s: StarterCard) =>
  s.app !== null ? `<span class="added">Added</span>` : s.taken === null ? addButton(s) : ""

/** A starter as a row (icon, what it is, Add or Added), opening its page: beside Just updated, and under a starter's page. */
const starterRow = (s: StarterCard) =>
  `<a class="srow" href="${starterPage(s.name)}" data-find="${escape(`${s.name} ${s.description}`.toLowerCase())}"><span class="mark" aria-hidden="true">${s.icon}</span><span class="what"><b>${escape(titled(s.name))}</b><span>${escape(s.description)}</span></span>${addOrAdded(s)}${icon("chevronRight")}</a>`

/** Beside Just updated: the first starters not added yet, and See all; nothing once every one is. */
const sideStarters = (starters: Home["starters"]) => {
  const left = starters.filter((s) => s.app === null)

  return left.length === 0
    ? ""
    : `<aside class="side-starters"><h2 class="all">Starter apps<a href="${STARTERS_TAB}">See all ${starters.length}</a></h2>${left
        .slice(0, SIDE_STARTERS)
        .map(starterRow)
        .join("")}${STARTER_ERROR}</aside>`
}

/** A starter's picture made ahead, else its icon on its tint. */
const starterPicture = (s: StarterCard) =>
  `<div class="panel">${
    s.picture === null
      ? `<div class="picture glyph">${s.icon}</div>`
      : `<div class="picture">${pictures(`/_starters/${escape(s.name)}/picture?v=${escape(s.picture)}`)}</div>`
  }</div>`

/**
 * A starter as a card on the Starters tab, opening its page: its picture, its icon before its name (a template, not one of
 * your apps), and Add, or Added where Add was.
 */
const starterCard = (s: StarterCard) =>
  `<a class="app starter" href="${starterPage(s.name)}" style="--app:${escape(s.color)}" data-find="${escape(`${s.name} ${s.description}`.toLowerCase())}">
${starterPicture(s)}
<div class="body">
<div class="name"><span class="tmark" aria-hidden="true">${s.icon}</span><span>${escape(titled(s.name))}</span></div>
<div class="about">${escape(s.description)}</div>
<div class="foot"><span></span>${addOrAdded(s)}</div>
</div>
</a>`

/** The Starters tab: every starter, found by name or what it does. */
const startersTab = (starters: Home["starters"]) =>
  `<div class="grid starters-grid" id="starters">${starters.map(starterCard).join("\n")}</div>
${STARTER_ERROR}
<div class="empty none" id="no-starters" hidden><b>No starters match</b><p>Try another search, or ask an agent to build it.</p></div>`

/** What's inside a starter, as its page lists it: only what it has. */
const insideList = (inside: Inside) => {
  const facts = [
    inside.data.length === 0
      ? null
      : [
          "Data",
          inside.data
            .map(
              (d) =>
                `<code>${escape(d.name)}</code>${d.fields.length === 0 ? "" : `: ${escape(d.fields.join(", "))}`}`,
            )
            .join("<br>"),
        ],
    inside.agents.length === 0
      ? null
      : [
          "For agents",
          inside.agents
            .map((a) => `<code>${escape(a.name)}</code> ${escape(a.about)}`)
            .join("<br>"),
        ],
    inside.runs.length === 0
      ? null
      : [
          "Runs by itself",
          inside.runs.map((r) => `${escape(r.when)}: ${escape(r.about)}`).join("<br>"),
        ],
    inside.prompt === null
      ? null
      : [
          "Built from",
          `<div class="prompt"><p>${escape(inside.prompt)}</p><button type="button" class="btn btn-ghost" data-copy="${escape(inside.prompt)}">${icon("copy")}Copy</button></div>`,
        ],
  ].filter((f): f is [string, string] => f !== null)

  return `<dl class="facts">${facts.map(([term, said]) => `<div><dt>${term}</dt><dd>${said}</dd></div>`).join("")}</dl>`
}

/** The app that already has a starter's name, above its Add: whose it is, when it last went live, and Open. */
const takenRow = (app: Card, origin: string, viewer: string | null) =>
  `<div class="taken" style="--app:${escape(app.color)}"><span class="initial" aria-hidden="true">${escape(initials(app.name))}</span><span class="what"><b>${escape(app.name)}</b><span>${app.owner === viewer ? "Yours" : `${escape(app.owner.split("@")[0] ?? app.owner)}'s`} · ${when(app, true)}</span></span><a class="btn btn-secondary" href="${escape(`${origin}/${app.name}`)}">Open</a></div>`

/** What Remove's question adds when the starter sits beside an app with its name: that app stays. */
const stays = (app: Card, viewer: string | null) =>
  `${app.owner === viewer ? "Your" : `${app.owner.split("@")[0] ?? app.owner}'s`} ${app.name} stays.`

/**
 * A starter's page: its picture, what it does, Add to the workspace (or, once added, Open and, for whoever may delete it,
 * Remove), what's inside it and the prompt that built it; then the other starters.
 */
const starterDetail = (
  s: StarterCard,
  starters: Home["starters"],
  workspace: string,
  origin: string,
  viewer: string | null,
) =>
  `<a class="crumb" href="${STARTERS_TAB}">${icon("chevronLeft")}Starters</a>
<div class="sp" style="--app:${escape(s.color)}">
<div class="app sp-pic">${starterPicture(s)}</div>
<div class="sp-info">
<div class="sp-head"><span class="mark" aria-hidden="true">${s.icon}</span><div>${headingHtml("h2", escape(titled(s.name)), sub(escape(s.description)))}</div></div>
${s.taken === null ? "" : takenRow(s.taken.card, origin, viewer)}
<div class="sp-acts">${
    s.app !== null
      ? `<a class="btn btn-primary btn-lg" href="${escape(`${origin}/${s.app}`)}">Open ${escape(s.app)}</a>${s.manage ? `<button type="button" class="btn btn-secondary btn-lg remove" data-remove="${escape(s.app)}"${s.taken === null ? "" : ` data-stays="${escape(stays(s.taken.card, viewer))}"`}>Remove</button>` : ""}`
      : s.taken === null
        ? `<button type="button" class="btn btn-primary btn-lg" data-starter="${escape(s.name)}"><span class="spin"></span>${icon("plus")}Add to ${escape(workspace)}</button>`
        : `<button type="button" class="btn btn-primary btn-lg" data-starter="${escape(s.name)}" data-as="${escape(s.taken.free)}"><span class="spin"></span>${icon("plus")}Add as ${escape(s.taken.free)}</button>`
  }</div>
${STARTER_ERROR}
${insideList(s.inside)}
</div>
</div>
<h2 class="all">More starters</h2>
<div class="frows">${starters
    .filter((other) => other.name !== s.name)
    .map(starterRow)
    .join("")}</div>`

const start = (origin: string) =>
  `<div class="empty page start">${STACK}<b>No apps yet</b>
<ol class="steps">
<li class="step" id="step-connect"><span class="n">1</span><span class="what"><b>Connect an agent</b><span>Claude Code, Codex, pi or opencode</span></span><button type="button" class="btn btn-plain" data-open="connect">Connect</button></li>
<li class="step"><span class="n">2</span><span class="what"><b>Ask it to build</b><span>${IDEA.charAt(0).toUpperCase()}${IDEA.slice(1)}</span></span><button type="button" class="btn btn-primary" data-copy="${escape(`Build me ${IDEA} on OpenBelt (${new URL(origin).host})`)}">${icon("copy")}Copy</button></li>
</ol>
<a class="btn btn-ghost more-starters" href="${STARTERS_TAB}">Or add a starter app${icon("chevronRight")}</a></div>`

/** Cards in a row: the grid's, and the shelf's. */
const galleryCards = (cards: ReadonlyArray<Card>, origin: string, viewer: string | null) =>
  cards.map((app) => card(app, origin, viewer)).join("\n")

/** One menu for every app's ⋯, filled and placed by the page script; then the question before a delete. */
const APP_MENU = `<div class="menu-scrim" hidden></div>
<div class="menu overlay app-menu" role="menu" id="app-menu" tabindex="-1" hidden>
<div class="head"><b></b><span></span></div>
<a class="menu-item" role="menuitem" data-act="open" target="_blank" rel="noopener">${icon("externalLink")}Open in new tab</a>
<button type="button" class="menu-item" role="menuitem" data-act="link">${icon("link")}<span>Copy link</span></button>
<div class="menu-sep" role="separator"></div>
<button type="button" class="menu-item danger" role="menuitem" data-act="delete">${icon("trash")}Delete</button>
</div>
<dialog class="confirm overlay" id="confirm-delete" aria-labelledby="confirm-title">
${headingHtml("h2", "Delete this app?", sub("Its pages, data and files go for good."), { id: "confirm-title" })}
<p class="error" role="alert" hidden></p>
<div class="btns"><button type="button" class="btn btn-secondary" data-keep>Cancel</button><button type="button" class="btn btn-delete" data-confirm><span class="spin"></span>${icon("trash")}Delete</button></div>
</dialog>`

const asksNotice = (asks: ReadonlyArray<string>) =>
  asks.length === 0
    ? ""
    : `<p class="asks">${escape(asks.length === 1 ? `${asks[0] ?? ""} asked to join.` : `${asks.length} people asked to join.`)} <a href="/_settings/people#asks">Invite</a></p>`

export const homePage = ({
  workspace,
  workspaceOrigin,
  switcher,
  mcp,
  viewer,
  form,
  signOut,
  gallery,
  asks,
  tab,
  starter,
  starters,
}: Home) => {
  const { cards, total, q, sort } = gallery

  const data = {
    viewer: viewer?.email ?? null,
    form,
    q,
    sort,
    total,
    next: gallery.next,
  }

  const shelves = SHELVES.replace(
    '<div class="track"></div>',
    `<div class="track">${galleryCards(gallery.recent, workspaceOrigin, viewer?.email ?? null)}</div>`,
  )

  const side = mainSide(workspace, switcher, viewer, "apps", signOut)

  const parts = galleryParts(
    cards,
    { q, sort, from: gallery.from, total },
    workspaceOrigin,
    viewer?.email ?? null,
  )

  const bar = (tools: string) =>
    `<div class="toolbar">
<div class="heading">${MENU_BUTTON}<h1>Apps</h1>${signedOut(viewer)}</div>
<span class="grow"></span>${tools === "" ? "" : `\n<div class="tools">${tools}</div>`}
</div>
${tabs(tab, total, starters.length)}`

  const search = (id: string, placeholder: string, value: string) =>
    `<label class="search">${icon("search")}<input class="input" id="${id}" placeholder="${placeholder}" autocomplete="off" aria-label="Search" value="${escape(value)}"><span class="kbd">/</span>${id === "q" ? `<button type="button" class="btn btn-ghost" id="clear" hidden>Clear <span class="kbd">esc</span></button>` : ""}</label>`

  const besides = parts.hero === "" ? "" : sideStarters(starters)

  // Adding an app, or connecting an agent to build one, takes a sign-in; the empty page shows how to connect to anyone.
  const add = viewer === null ? "" : ADD_APP
  const empty = tab === "yours" && total === 0 && q === ""

  const shown =
    tab === "starters"
      ? `${asksNotice(asks)}${bar(`${search("sq", "Search starters", "")}${add}`)}
${(() => {
  const open = starters.find((s) => s.name === starter)

  return open === undefined
    ? startersTab(starters)
    : starterDetail(open, starters, workspace, workspaceOrigin, viewer?.email ?? null)
})()}
${APP_MENU}`
      : empty
        ? `${asksNotice(asks)}${bar("")}
${start(workspaceOrigin)}`
        : `${asksNotice(asks)}${bar(`${search("q", "Search apps, people", q)}
<span class="select"><span class="shown" aria-hidden="true">${SORTS.find(([value]) => value === sort)?.[1] ?? ""}</span><select class="input" id="sort" aria-label="Sort">${SORTS.map(([value, label]) => `<option value="${value}"${value === sort ? " selected" : ""}>${label}</option>`).join("")}</select>${icon("chevronDown")}</span>${add}`)}
${jumpBackIn(gallery.jump, workspaceOrigin, q === "" && sort === "updated")}
<div class="lead${besides === "" ? "" : " with-starters"}"><section class="feature" id="feature"${parts.hero === "" ? " hidden" : ""}>${parts.hero}</section>${besides}</div>
${shelves}
<h2 class="all" id="all" hidden>All apps</h2>
<div class="grid" id="grid">${parts.grid}</div>
<button type="button" class="btn btn-secondary more" id="more"${gallery.next === null ? " hidden" : ""}>Show more</button>
<div class="empty none" id="none" hidden><b>No apps match</b><p>Try another search, or ask an agent to build it.</p><button class="btn btn-secondary" id="clear-none">Clear search</button></div>
${APP_MENU}`

  const page = viewer === null && !empty ? shown : `${shown}\n${connectDialog(mcp)}`

  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
<script>${THEME_SCRIPT}
${RAIL_HEAD}</script>
${switcherPreconnect(switcher)}
${NAV_PREFETCH}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(workspace)} · OpenBelt</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">${PWA_HEAD}
<style>${MAIN_CSS}${STYLE}</style>
</head>
<body>
<div class="shell">${side}<div class="inset"><main>${page}</main></div></div>
${SCRIM}
<script type="application/json" id="data">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>
<script>${SCRIPT}</script>
</body>
</html>`
}
