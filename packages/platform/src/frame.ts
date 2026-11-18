import { PWA_HEAD } from "./pwa.ts"
import markSvg from "../../../brand/logo/tile-light.svg" with { type: "text" }
import { THEME_SCRIPT } from "./theme.ts"
import baseCss from "../../../brand/css/base.css" with { type: "text" }
import tokensCss from "../../../brand/css/tokens.css" with { type: "text" }
import { escape, icon } from "./home.ts"
import type { PanelAccess } from "./model.ts"

/** What the frame knows of its viewer and the app's panel when it's served; the panel's pages load the rest when opened. */
export type FramePanel = {
  readonly access: PanelAccess
  /** The viewer's form token, for changing who can view the app: only its owner or an admin gets one. */
  readonly form: string | null
  /** The workspace's name, which the "Who can view it" choices say. */
  readonly workspace: string
}

const PANEL_ICONS = {
  panel: icon("panelRight"),
  info: icon("info"),
  history: icon("history"),
  data: icon("database"),
  logs: icon("fileText"),
  stats: icon("activity"),
  users: icon("users"),
  globe: icon("globe"),
  lock: icon("lock"),
  building: icon("building"),
  check: icon("check"),
  left: icon("chevronLeft"),
  right: icon("chevronRight"),
  x: icon("x"),
  copy: icon("copy"),
  bell: icon("bell"),
}

/** What the panel's script starts from: the frame's panel and the icons it draws. */
type PanelConfig = FramePanel & { readonly app: string; readonly icons: typeof PANEL_ICONS }

/** The panel's config as JSON in a <script>: no "</script>" can end it early. */
const scriptJson = (config: PanelConfig) => JSON.stringify(config).replaceAll("<", "\\u003c")

/** The frame around an app's page, in the workspace and on the public host: its header, then the page. The logo button mirrors the
 * panel button at the other end: a 36px square, as far from its edge. */
const FRAME_CSS = `
body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); height: 100dvh; display: grid; grid-template-rows: auto 1fr; overflow: clip; background: var(--openbelt-color-surface); }
.head { display: flex; align-items: center; gap: 0; height: 52px; padding: 0 14px; }
.home { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 36px; height: 36px; padding: 0; border-radius: var(--openbelt-radius-sm); flex: none; color: var(--openbelt-color-muted); text-decoration: none; }
.home-logo { width: 16px; height: 16px; flex: none; }
.home-logo .t { fill: currentColor; }
.home-logo .s { fill: var(--openbelt-color-surface); }
.home:hover, .home:focus-visible { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.home:active { transform: translateY(1px); }
.divider { width: 8px; height: 18px; color: var(--openbelt-color-border-strong); flex: none; }
.name { padding-left: 6px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.stage { min-height: 0; padding: 0 10px 10px; }
.frame { height: 100%; min-height: 0; border-radius: var(--openbelt-radius-lg); overflow: clip; box-shadow: 0 0 0 0.5px var(--openbelt-color-border); }
iframe { border: 0; width: 100%; height: 100%; display: block; color-scheme: light; background: transparent; }
:root[data-theme="dark"] iframe { color-scheme: dark; }
@media (prefers-color-scheme: dark) { :root[data-theme="system"] iframe { color-scheme: dark; } }
@media (max-width: 560px) {
.head { height: 48px; padding: 0 var(--openbelt-space-xs); }
.stage { padding: 0 6px 6px; }
}
`

const PANEL_CSS = `
.head .name { flex: 1; }
.panel-toggle { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: var(--openbelt-radius-sm); background: none; color: var(--openbelt-color-muted); cursor: pointer; flex: none; }
.panel-toggle:hover, .panel-toggle:focus-visible, .panel-toggle[aria-expanded="true"] { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.stage { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.stage.docked { grid-template-columns: minmax(0, 1fr) 360px; }
.panel { display: none; min-height: 0; flex-direction: column; background: var(--openbelt-color-neutral); border-radius: var(--openbelt-radius-lg); box-shadow: 0 0 0 0.5px var(--openbelt-color-border); overflow: hidden; }
.panel.open { display: flex; }
.page { view-transition-name: panel-page; flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--openbelt-color-neutral); }
.ph { display: flex; align-items: center; gap: 4px; min-height: 52px; padding: 0 6px 0 4px; border-bottom: 1px solid var(--openbelt-color-border); flex: none; }
.ph.root { padding: 10px 6px 10px 14px; gap: 8px; }
.ph h2 { font: 600 15px/1.2 var(--openbelt-font-body); letter-spacing: 0; flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.ph h2 .icon { color: var(--openbelt-color-muted); }
.iconbtn { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: var(--openbelt-radius-sm); background: none; color: var(--openbelt-color-muted); cursor: pointer; flex: none; }
.iconbtn:hover, .iconbtn:focus-visible { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.panel .icon, .panel-toggle .icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.pb { flex: 1; min-height: 0; overflow: auto; padding: 14px; overscroll-behavior: contain; }
.pb > * + * { margin-top: 16px; }
.card { display: flex; gap: 12px; align-items: center; flex: 1; min-width: 0; }
.card .tile { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; color: var(--openbelt-color-on-primary); font: 700 18px/1 var(--openbelt-font-display); flex: none; text-transform: uppercase; }
.card .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .s { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border: 0; border-radius: 11px; background: none; box-shadow: inset 0 0 0 1px var(--openbelt-color-border-strong); color: var(--openbelt-color-muted); font: 550 11px/1 var(--openbelt-font-body); cursor: pointer; flex: none; }
.pill .icon { width: 11px; height: 11px; }
.pill:hover, .pill:focus-visible { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.pill.on, .pill.live { color: var(--openbelt-color-primary); }
.pill.live { color: var(--openbelt-color-success); box-shadow: inset 0 0 0 1px currentColor; cursor: default; height: 20px; }
.list { border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); box-shadow: 0 0 0 0.5px var(--openbelt-color-border); overflow: hidden; }
.row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 10px 12px; border: 0; background: none; text-align: left; color: inherit; font: inherit; }
button.row { cursor: pointer; }
button.row:hover, button.row:focus-visible { background: var(--openbelt-color-subtle); }
.row + .row { border-top: 1px solid var(--openbelt-color-border); }
.row > .icon:first-child { color: var(--openbelt-color-muted); }
.row .l { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.row .v { color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); white-space: nowrap; }
.row .v.warn { color: var(--openbelt-color-error); }
.row .chev { color: var(--openbelt-color-border-strong); width: 14px; height: 14px; }
.row .sub { display: block; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); margin-top: 2px; }
.row .tick { width: 18px; height: 18px; stroke-width: 2; color: var(--openbelt-color-primary); }
.mono { font: var(--openbelt-type-mono-sm); }
.note { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); line-height: 1.5; padding: 0 2px; }
.note.error { color: var(--openbelt-color-error); }
.glabel { font: 550 12px/1.2 var(--openbelt-font-body); color: var(--openbelt-color-muted); margin: 0 2px 6px; }
.okdot { width: 7px; height: 7px; border-radius: 50%; background: var(--openbelt-color-success); display: inline-block; margin-right: 6px; }
.okdot.bad { background: var(--openbelt-color-error); }
dl.kv { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin-left: 0; margin-right: 0; margin-bottom: 0; }
dl.kv dt { color: var(--openbelt-color-muted); }
dl.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.btn { height: 32px; padding: 0 12px; border: 0; border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-neutral); box-shadow: inset 0 0 0 1px var(--openbelt-color-border-strong); color: inherit; font: 550 13px/1 var(--openbelt-font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; flex: none; }
.btn:hover, .btn:focus-visible { background: var(--openbelt-color-subtle); }
.link { display: flex; gap: 8px; }
.link input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border: 0; border-radius: var(--openbelt-radius-sm); box-shadow: inset 0 0 0 1px var(--openbelt-color-border-strong); background: var(--openbelt-color-surface); color: inherit; font: var(--openbelt-type-mono-sm); }
pre.log { margin-left: 0; margin-right: 0; margin-bottom: 0; padding: 10px; border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-surface); box-shadow: 0 0 0 0.5px var(--openbelt-color-border); font: var(--openbelt-type-mono-sm); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--openbelt-color-muted); }
pre.log .error { color: var(--openbelt-color-error); }
pre.log .warn { color: var(--openbelt-color-warning); }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: var(--openbelt-radius-sm); background: var(--openbelt-color-subtle); }
.seg button { flex: 1; height: 28px; border: 0; border-radius: calc(var(--openbelt-radius-sm) - 2px); background: none; color: var(--openbelt-color-muted); font: 550 12px/1 var(--openbelt-font-body); cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--openbelt-color-neutral); color: var(--openbelt-color-primary); box-shadow: 0 0 0 0.5px var(--openbelt-color-border-strong); }
.kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.kpi { padding: 10px 12px; border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); box-shadow: 0 0 0 0.5px var(--openbelt-color-border); min-width: 0; }
.kpi .k { font: 550 12px/1.2 var(--openbelt-font-body); color: var(--openbelt-color-muted); }
.kpi .n { font: 600 22px/1.15 var(--openbelt-font-display); margin-top: 6px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpi .d { font: var(--openbelt-type-body-sm); color: var(--openbelt-color-muted); margin-top: 2px; }
.kpi .d.up { color: var(--openbelt-color-success); }
.kpi .d.bad { color: var(--openbelt-color-error); }
.chart { padding: 12px 12px 8px; border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); box-shadow: 0 0 0 0.5px var(--openbelt-color-border); }
.chart svg { display: block; width: 100%; height: 96px; }
.chart .bar { fill: var(--openbelt-color-primary); opacity: 0.35; }
.chart .bar.now { opacity: 1; }
.chart .grid { stroke: var(--openbelt-color-border); stroke-width: 1; stroke-dasharray: 2 3; }
.chart .axis, .chart .top span { display: flex; justify-content: space-between; font: var(--openbelt-type-body-sm); font-size: 11px; color: var(--openbelt-color-muted); font-variant-numeric: tabular-nums; }
.chart .axis { margin-top: 6px; }
.chart .top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.chart .top b { font: 600 13px/1.2 var(--openbelt-font-body); }
.avatar { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); font: 600 11px/1 var(--openbelt-font-body); flex: none; text-transform: uppercase; }
.meter { display: block; height: 4px; border-radius: 2px; background: var(--openbelt-color-subtle); margin-top: 6px; overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--openbelt-color-primary); opacity: 0.6; border-radius: 2px; }
.headcard { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; padding: 6px 8px; margin: 4px 0; border: 0; border-radius: var(--openbelt-radius-md); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.headcard:hover, .headcard:focus-visible { background: var(--openbelt-color-subtle); }
.headcard:active, .btn:active, button.row:active, .op:active { transform: translateY(1px); }
.headcard .tile { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; color: var(--openbelt-color-on-primary); font: 700 18px/1 var(--openbelt-font-display); flex: none; text-transform: uppercase; }
.headcard .l { flex: 1; min-width: 0; }
.headcard .t { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.headcard .s { display: block; color: var(--openbelt-color-muted); font: var(--openbelt-type-body-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.headcard .chev { color: var(--openbelt-color-border-strong); width: 14px; height: 14px; }
.sharebox { border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-surface); box-shadow: 0 0 0 0.5px var(--openbelt-color-border); overflow: hidden; }
.sharebox .link { padding: 12px 12px 10px; }
.sharebox .row { border-top: 1px solid var(--openbelt-color-border); }
.row .v { max-width: 50%; overflow: hidden; text-overflow: ellipsis; }
.row .l.one { overflow: hidden; }
.row .l.one .tt, .row .l.one .sub { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row[aria-pressed="true"] .l.one .tt, .row[aria-pressed="true"] .l.one .sub { white-space: normal; overflow-wrap: break-word; }
.row.on > .icon:first-child { color: var(--openbelt-color-success); }
button.row:disabled, .op:disabled, .switch:disabled { cursor: default; }
.busy { opacity: 0.55; }
.textbtn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 2px; border: 0; background: none; color: var(--openbelt-color-muted); font: 550 12px/1 var(--openbelt-font-body); cursor: pointer; }
.pb > .textbtn { margin-top: 2px; }
.panel .textbtn .icon { width: 13px; height: 13px; }
.textbtn:hover, .textbtn:focus-visible { color: var(--openbelt-color-primary); }
.textbtn:active { transform: translateY(1px); }
.ops { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.op { height: 26px; padding: 0 9px; border: 0; border-radius: 13px; background: var(--openbelt-color-subtle); color: var(--openbelt-color-muted); font: 550 12px/1 var(--openbelt-font-body); cursor: pointer; }
.op:hover, .op:focus-visible { color: var(--openbelt-color-primary); }
.op[aria-pressed="true"] { background: color-mix(in srgb, var(--openbelt-color-success) 18%, transparent); color: var(--openbelt-color-success); }
.switch { width: 38px; height: 22px; border-radius: 11px; background: var(--openbelt-color-border-strong); position: relative; flex: none; border: 0; cursor: pointer; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left 120ms; }
.switch[aria-checked="true"] { background: var(--openbelt-color-success); }
.switch[aria-checked="true"]::after { left: 19px; }
.switch:hover, .switch:focus-visible { filter: brightness(1.08); }
.row .chev.down { transform: rotate(90deg); }
.row.who[aria-expanded="true"] .chev.down { transform: rotate(-90deg); }
.row.who .wt { font: 550 13px/1.2 var(--openbelt-font-body); color: var(--openbelt-color-muted); }
.who-opts { display: grid; gap: 2px; padding: 2px 6px 8px; }
.sharebox .who-opts .row { border-top: 0; border-radius: var(--openbelt-radius-sm); padding-left: 10px; }
.who-opts .row[aria-pressed="true"] { background: var(--openbelt-color-subtle); }
.who-confirm { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 0 12px 12px; }
.who-confirm .note { flex: 1; }
.btn.primary { background: var(--openbelt-color-primary); color: var(--openbelt-color-on-primary); box-shadow: none; }
.btn.primary:hover, .btn.primary:focus-visible { background: var(--openbelt-color-primary); opacity: 0.88; }
.btn.ghost { background: none; box-shadow: none; }
.btn.ghost:hover, .btn.ghost:focus-visible { background: var(--openbelt-color-subtle); }
.btn:disabled { cursor: default; }
.btn.busy { opacity: 0.6; }
.link input.flash { animation: link-flash 1.6s ease-out; }
@keyframes link-flash { 0%, 40% { background: color-mix(in srgb, var(--openbelt-color-success) 22%, var(--openbelt-color-surface)); } }
@media (max-width: 720px) {
.stage.docked { grid-template-columns: minmax(0, 1fr); }
.panel { position: fixed; inset: 0; z-index: 10; border-radius: 0; box-shadow: none; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
}
::view-transition-old(root), ::view-transition-new(root) { animation: none; }
::view-transition-group(panel-page) { animation-duration: 340ms; }
::view-transition-old(panel-page), ::view-transition-new(panel-page) { animation-duration: 340ms; animation-timing-function: cubic-bezier(0.32, 0.72, 0, 1); animation-fill-mode: both; }
:root[data-panel-move="push"]::view-transition-old(panel-page) { animation-name: panel-back-out; }
:root[data-panel-move="push"]::view-transition-new(panel-page) { animation-name: panel-in; }
:root[data-panel-move="pop"]::view-transition-old(panel-page) { animation-name: panel-out; z-index: 1; }
:root[data-panel-move="pop"]::view-transition-new(panel-page) { animation-name: panel-back-in; }
@keyframes panel-in { from { transform: translateX(100%); } }
@keyframes panel-out { to { transform: translateX(100%); } }
@keyframes panel-back-out { to { transform: translateX(-28%); opacity: 0.6; } }
@keyframes panel-back-in { from { transform: translateX(-28%); opacity: 0.6; } }
@media (min-width: 721px) {
@keyframes panel-in { from { transform: translateX(40px); opacity: 0; } }
@keyframes panel-out { to { transform: translateX(40px); opacity: 0; } }
@keyframes panel-back-out { to { transform: translateX(-24px); opacity: 0; } }
@keyframes panel-back-in { from { transform: translateX(-24px); opacity: 0; } }
}
@media (prefers-reduced-motion: reduce) {
::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
}
`

/**
 * The panel's pages, drawn in the browser from GET /<app>/_panel when it opens. Moving between pages goes through the View
 * Transition API: a page slides in from the right and back out to it. Plain string concatenation, no template literals: this is a
 * template literal itself.
 */
const PANEL_SCRIPT = `(() => {
const C = JSON.parse(document.getElementById("panel-config").textContent)
const I = C.icons
const panel = document.getElementById("panel")
const stage = document.querySelector(".stage")
const toggle = document.getElementById("panel-toggle")
const S = { open: false, nav: [], data: null, error: null, saving: false, busy: null, saveError: null, copied: null, range: "30", everyone: false, notify: null, notifying: false, who: false, pending: null, fresh: false, flash: false }
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
const ago = (iso) => {
  if (!iso) return ""
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  for (const [u, n] of units) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u)
  return "just now"
}
const day = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""
const manage = C.access === "manage"
const PAGES = [
  { id: "about", icon: "info", title: "About" },
  { id: "stats", icon: "stats", title: "Stats", manage: true },
  { id: "history", icon: "history", title: "History", manage: true },
  { id: "data", icon: "data", title: "Data", manage: true },
  { id: "logs", icon: "logs", title: "Logs", manage: true },
].filter((p) => manage || !p.manage)
const VIEW = {
  private: { icon: "lock", title: "Private", value: "Private", sub: "Only you and workspace admins" },
  workspace: { icon: "building", title: "Workspace", value: "Workspace", sub: "Anyone with a link and in the " + C.workspace + " workspace" },
  public: { icon: "globe", title: "Public", value: "Public", sub: "Anyone with the link, no sign-in" },
}
const OPS = [["read", "Read"], ["create", "Add"], ["update", "Edit"], ["delete", "Delete"]]
const chev = I.right.replace('class="icon"', 'class="icon chev"')
const close = '<button class="iconbtn" data-act="close" aria-label="Close">' + I.x + "</button>"
const back = '<button class="iconbtn" data-act="back" aria-label="Back">' + I.left + "</button>"
const errors = () => S.data && S.data.details ? S.data.details.logs.filter((l) => l.level === "error").length : 0
const valueOf = (id) => {
  const d = S.data
  if (!d) return ""
  if (id === "about") return d.live ? "Live " + esc(ago(d.live.at)) : "Not live yet"
  if (id === "history") return d.details.versions.length + (d.details.versions.length === 1 ? " version" : " versions")
  if (id === "data") return d.details.collections.length + (d.details.collections.length === 1 ? " collection" : " collections")
  if (id === "stats") { const p = d.details.usage.windows["7"].people; return p ? p + (p === 1 ? " person" : " people") + " this week" : "No opens this week" }
  if (id === "logs") return errors() ? errors() + (errors() === 1 ? " error" : " errors") : '<span class="okdot"></span>No errors'
  return ""
}
const row = (p) => '<button class="row" data-act="go" data-page="' + p.id + '">' + I[p.icon] + '<span class="l">' + p.title + '</span><span class="v' + (p.id === "logs" && errors() ? " warn" : "") + '">' + valueOf(p.id) + "</span>" + I.right.replace('class="icon"', 'class="icon chev"') + "</button>"
const tile = () => { const d = S.data; return '<div class="tile" style="background:' + esc(d ? d.color : "var(--openbelt-color-muted)") + '">' + esc(C.app.slice(0, 1)) + "</div>" }
const byline = () => { const d = S.data; if (!d) return S.error ? "" : "Loading"; return "By " + esc(d.owner.name || d.owner.email) + (d.live ? " · Live " + esc(ago(d.live.at)) : "") }
const copy = (url, key) => '<button class="btn" data-act="copy" data-url="' + esc(url) + '" data-key="' + key + '">' + I.copy + (S.copied === key ? "Copied" : S.fresh ? "Copy new link" : "Copy") + "</button>"
const chevDown = I.right.replace('class="icon"', 'class="icon chev down"')
/** The button that saves a change of who can view it, named for what it does from the saved choice. */
const confirmOf = (from, to) => to === "public" ? "Make public" : to === "private" ? "Make private" : from === "public" ? "Turn off public link" : "Share with workspace"

/** Who can view it, for the owner or an admin: one row that opens in place on the choices; only the confirm button saves. */
function whoRows(d) {
  const v = VIEW[d.view]
  const head = '<button class="row who" data-act="who" aria-expanded="' + S.who + '">' + (S.who ? '<span class="l wt">Who can view it</span>' : I[v.icon] + '<span class="l">' + esc(v.title) + '<span class="sub">' + esc(v.sub) + "</span></span>") + chevDown + "</button>"
  if (!S.who) return head
  const chosen = S.pending || d.view
  const views = ["private", "workspace"].concat(d.publicHost ? ["public"] : [])
  const opts = views.map((k) => { const c = VIEW[k]; const on = chosen === k; return '<button class="row" data-act="pick" data-value="' + k + '" aria-pressed="' + on + '"' + (S.saving ? " disabled" : "") + ">" + I[c.icon] + '<span class="l">' + esc(c.title) + '<span class="sub">' + esc(c.sub) + "</span></span>" + (on ? I.check.replace('class="icon"', 'class="icon tick"') : "") + "</button>" }).join("")
  const changing = S.pending !== null && S.pending !== d.view
  const confirm = changing ? '<div class="who-confirm">' + (S.saveError ? '<p class="note error">' + esc(S.saveError) + "</p>" : "") + '<button class="btn ghost" data-act="cancel"' + (S.saving ? " disabled" : "") + ">Cancel</button>" + '<button class="btn primary' + (S.saving ? " busy" : "") + '" data-act="confirm"' + (S.saving ? " disabled" : "") + ">" + (S.saving ? "Saving…" : confirmOf(d.view, S.pending)) + "</button></div>" : ""
  return head + '<div class="who-opts">' + opts + "</div>" + confirm
}

function root() {
  const d = S.data
  const head = '<button class="headcard" data-act="go" data-page="about" aria-label="About ' + esc(C.app) + '">' + tile() + '<span class="l"><span class="t">' + esc(C.app) + '</span><span class="s">' + byline() + "</span></span>" + chev + "</button>"
  let body = '<p class="note">Loading</p>'
  if (S.error) body = '<p class="note error">' + esc(S.error) + "</p>"
  else if (d) {
    const link = d.publicUrl || d.url
    const visitors = manage && d.view === "public" && d.publicUrl !== null && d.details && !S.who ? '<button class="row" data-act="go" data-page="visitors">' + I.data + '<span class="l">What visitors can use</span><span class="v">' + exposed(d) + "</span>" + chev + "</button>" : ""
    // Members get the link to share; who can view it is the owner's and admins' to see and change.
    const share = '<div><div class="glabel">Share</div><div class="sharebox"><div class="link"><input readonly value="' + esc(link) + '" aria-label="Link"' + (S.flash ? ' class="flash"' : "") + ">" + copy(link, "root") + "</div>" + (manage ? whoRows(d) : "") + visitors + "</div></div>"
    body = share + notifyRow() + (manage ? '<div class="list">' + ["stats", "logs", "data", "history"].map((id) => row(TITLES[id])).join("") + "</div>" : "")
  }
  return '<div class="page"><div class="ph">' + head + close + '</div><div class="pb">' + body + "</div></div>"
}

/** This app's notifications on this device (pwa.ts openbeltNotify): a switch, where the browser can take a push. */
function notifyRow() {
  const n = S.notify
  if (!n) return ""
  const sub = n.blocked ? "Blocked in this browser's settings" : n.on ? "On for this device" : "Off"
  return '<div class="list"><div class="row">' + I.bell + '<span class="l one"><span class="tt">Notifications</span><span class="sub">' + sub + '</span></span><button class="switch' + (S.notifying ? " busy" : "") + '" role="switch" data-act="notify" aria-checked="' + n.on + '" aria-label="Notifications from ' + esc(C.app) + '"' + (S.notifying || n.blocked ? " disabled" : "") + "></button></div></div>"
}

/** How many ops and functions visitors may use: the Share page's count for What visitors can use. */
function exposed(d) {
  const block = d.details.public || {}
  const n = Object.values(block.collections || {}).reduce((sum, ops) => sum + ops.length, 0) + Object.keys(block.functions || {}).length
  return n === 0 ? "Pages only" : n + (n === 1 ? " thing" : " things")
}

function visitors(d) {
  const block = d.details.public || {}
  const files = '<div class="row">' + I.logs + '<span class="l">Pages and files<span class="sub">Always, when public</span></span></div>'
  const collections = d.details.collections.map((c) => {
    const has = (block.collections && block.collections[c.name]) || []
    return '<div class="row">' + I.data + '<span class="l mono">' + esc(c.name) + '</span><div class="ops">' + OPS.map(([op, label]) => '<button class="op' + (S.busy === "op:" + c.name + ":" + op ? " busy" : "") + '" data-act="op" data-c="' + esc(c.name) + '" data-op="' + op + '" aria-pressed="' + has.includes(op) + '"' + (S.saving ? " disabled" : "") + ">" + label + "</button>").join("") + "</div></div>"
  }).join("")
  const functions = d.details.functions.map((f) => {
    const on = Boolean(block.functions && block.functions[f])
    return '<div class="row">' + I.stats + '<span class="l mono">' + esc(f) + '</span><button class="switch' + (S.busy === "fn:" + f ? " busy" : "") + '" role="switch" data-act="fn" data-f="' + esc(f) + '" aria-checked="' + on + '" aria-label="Visitors can run ' + esc(f) + '"' + (S.saving ? " disabled" : "") + "></button></div>"
  }).join("")
  const bar = '<div><div class="glabel">Public page</div><div class="list"><div class="row">' + I.globe + '<span class="l one"><span class="tt">OpenBelt bar</span><span class="sub">Above the app, with Sign in</span></span><button class="switch' + (S.busy === "bar" ? " busy" : "") + '" role="switch" data-act="bar" aria-checked="' + (block.bar !== false) + '" aria-label="OpenBelt bar"' + (S.saving ? " disabled" : "") + "></button></div></div></div>"
  return '<div class="list">' + files + collections + functions + "</div>" + bar + (S.saveError ? '<p class="note error">' + esc(S.saveError) + "</p>" : "")
}

const PAGE = {
  about(d) {
    const live = d.live
    return (d.description ? "<p>" + esc(d.description) + "</p>" : '<p class="note">No description yet.</p>') +
      '<dl class="kv"><dt>Owner</dt><dd>' + esc(d.owner.name || d.owner.email) + (d.owner.name ? '<span class="note" style="display:block;padding:0">' + esc(d.owner.email) + "</span>" : "") + "</dd>" +
      "<dt>Live version</dt><dd>" + (live ? '<span class="mono">' + esc(live.version) + '</span> <span class="pill live">Live</span>' : "Not live yet") + "</dd>" +
      (live ? "<dt>Went live</dt><dd>" + esc(ago(live.at)) + "</dd>" : "") +
      "<dt>Created</dt><dd>" + esc(day(d.created)) + "</dd></dl>"
  },
  visitors,
  history(d) {
    const live = d.live ? d.live.version : null
    const versions = d.details.versions.map((v) => '<div class="row"><span class="l"><span class="mono">' + esc(v.version) + '</span><span class="sub">' + esc(ago(v.deployedAt)) + " · " + esc(v.by) + " · " + esc(v.kind) + " · " + v.files + (v.files === 1 ? " file" : " files") + "</span></span>" + (v.version === live ? '<span class="pill live">Live</span>' : "") + "</div>").join("")
    const envs = d.details.environments.map((e) => '<div class="row"><span class="l">' + esc(e.env) + '<span class="sub">' + [esc(e.note), '<span class="mono">' + esc(e.version) + "</span>", esc(ago(e.lastWrite)), esc(e.by)].filter((x) => x).join(" · ") + "</span></span></div>").join("")
    return (versions ? '<div class="list">' + versions + "</div>" : '<p class="note">No versions yet.</p>') +
      (envs ? '<div><div class="glabel">Preview environments</div><div class="list">' + envs + "</div></div>" : "")
  },
  data(d) {
    const cs = d.details.collections
    if (!cs.length) return '<p class="note">No collections yet.</p>'
    return '<div class="list">' + cs.map((c) => '<div class="row">' + I.data + '<span class="l"><span class="mono">' + esc(c.name) + '</span><span class="sub">' + [c.lastWrite ? "Last write " + esc(ago(c.lastWrite)) : "No writes yet", c.ruled ? "rules set" : "", c.writable ? "other apps can write" : ""].filter((x) => x).join(" · ") + '</span></span><span class="v">' + c.docs + (c.docs === 1 ? " doc" : " docs") + "</span></div>").join("") + "</div>"
  },
  stats(d) {
    const u = d.details.usage
    const r = S.range
    const w = u.windows[r]
    const was = u.before[r]
    const num = (n) => Number(n || 0).toLocaleString()
    const plural = (n, one, many) => num(n) + " " + (n === 1 ? one : many)
    const change = (now, before) => {
      if (!was || !before) return ""
      const p = Math.round(((now - before) / before) * 100)
      return (p >= 0 ? "\u25B2 " : "\u25BC ") + Math.abs(p) + "% on the " + r + " days before"
    }
    const tile = (k, n, line, cls) => '<div class="kpi"><div class="k">' + k + '</div><div class="n">' + n + '</div>' + (line ? '<div class="d' + (cls ? " " + cls : "") + '">' + line + "</div>" : "") + "</div>"
    const seg = '<div class="seg" role="group" aria-label="Days shown">' + ["7", "30", "90"].map((n) => '<button data-act="range" data-value="' + n + '" aria-pressed="' + (r === n) + '">' + n + " days</button>").join("") + "</div>"
    const peopleChange = was ? change(w.people, was.people) : ""
    const opensChange = was ? change(w.opens, was.opens) : ""
    const tiles = '<div class="kpis">' +
      tile("People", num(w.people), peopleChange, peopleChange.startsWith("\u25B2") ? "up" : "") +
      tile("Opens", num(w.opens), opensChange, opensChange.startsWith("\u25B2") ? "up" : "") +
      tile("Function runs", num(w.runs), w.failed ? plural(w.failed, "failed", "failed") : "none failed", w.failed ? "bad" : "") +
      tile("Last opened", u.lastOpened ? esc(u.lastOpened.length === 10 ? new Date(u.lastOpened + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : ago(u.lastOpened)) : "Never", w.visitors ? plural(w.visitors, "public visitor", "public visitors") : "", "") +
      "</div>"
    const count = Number(r)
    const byDay = new Map(u.days.map((x) => [x.day, x]))
    const series = []
    for (let i = count - 1; i >= 0; i--) {
      const at = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)
      const x = byDay.get(at)
      series.push({ at, n: x ? x.people + x.visitors : 0, opens: x ? x.opens : 0 })
    }
    const most = Math.max(1, ...series.map((x) => x.n))
    const W = 300, H = 96, gap = count > 30 ? 1 : 2, bw = (W - gap * (count - 1)) / count
    const md = (at) => new Date(at + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
    const bars = series.map((x, i) => {
      const h = x.n ? Math.max(2, (x.n / most) * (H - 4)) : 0
      return '<rect class="bar' + (i === count - 1 ? " now" : "") + '" x="' + (i * (bw + gap)).toFixed(2) + '" y="' + (H - h).toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="1.5"><title>' + esc(md(x.at)) + ": " + plural(x.n, "person", "people") + ", " + plural(x.opens, "open", "opens") + "</title></rect>"
    }).join("")
    const chart = '<div class="chart"><div class="top"><b>People a day</b><span>Most: ' + num(most) + '</span></div><svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="People who opened it each day">' +
      '<line class="grid" x1="0" x2="' + W + '" y1="' + H / 2 + '" y2="' + H / 2 + '"/>' + bars + '</svg><div class="axis"><span>' + esc(md(series[0].at)) + "</span><span>Today</span></div></div>"
    const people = u.people.filter((p) => p.opens[r] > 0)
    const shown = S.everyone ? people : people.slice(0, 5)
    const initials = (p) => esc((p.name || p.email).split(/[\\s@.]+/).filter((x) => x).slice(0, 2).map((x) => x[0]).join(""))
    const who = people.length ? '<div><div class="glabel">Who opens it</div><div class="list">' + shown.map((p) => '<div class="row"><span class="avatar">' + initials(p) + '</span><span class="l">' + esc(p.name) + '<span class="sub">' + plural(p.opens[r], "open", "opens") + '</span></span><span class="v">' + esc(ago(p.last)) + "</span></div>").join("") +
      (people.length > 5 && !S.everyone ? '<button class="row" data-act="everyone">' + I.users + '<span class="l">All ' + plural(people.length, "person", "people") + "</span>" + I.right.replace('class="icon"', 'class="icon chev"') + "</button>" : "") + "</div></div>" : ""
    const sources = u.sources.filter((x) => x.visitors[r] > 0)
    const linked = sources.reduce((a, x) => a + x.visitors[r], 0)
    const label = (x) => x.source === "direct" ? "Direct" : x.source === "other" ? "Other links" : esc(x.source)
    const from = sources.length ? '<div><div class="glabel">Public link</div><div class="list"><div class="row">' + I.globe + '<span class="l">Visitors</span><span class="v">' + num(w.visitors) + "</span></div>" +
      sources.map((x) => { const p = Math.round((x.visitors[r] / linked) * 100); return '<div class="row"><span class="l">' + label(x) + '<span class="meter"><i style="width:' + p + '%"></i></span></span><span class="v">' + p + "%</span></div>" }).join("") + "</div></div>" : ""
    const none = !w.opens && !w.runs ? '<p class="note">Nobody opened it in the last ' + r + " days.</p>" : ""
    return seg + tiles + chart + none + who + from
  },
  logs(d) {
    const lines = d.details.logs
    if (!lines.length) return '<p class="note">No log lines yet.</p>'
    const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    return "<p>" + (errors() ? '<span class="okdot bad"></span>' + errors() + (errors() === 1 ? " error" : " errors") : '<span class="okdot"></span>No errors') + "</p>" +
      '<pre class="log">' + lines.map((l) => '<span class="' + esc(l.level) + '">' + esc(time(l.at)) + " " + esc(l.level.padEnd(5)) + " " + esc(l.message) + "</span>").join("\\n") + "</pre>"
  },
}
const TITLES = { visitors: { id: "visitors", icon: "data", title: "What visitors can use" } }
for (const p of PAGES) TITLES[p.id] = p

function page(id) {
  const t = TITLES[id]
  const body = S.error ? '<p class="note error">' + esc(S.error) + "</p>" : !S.data ? '<p class="note">Loading</p>' : PAGE[id](S.data)
  return '<div class="page"><div class="ph">' + back + "<h2>" + I[t.icon] + t.title + '</h2></div><div class="pb">' + body + "</div></div>"
}

function render() {
  toggle.setAttribute("aria-expanded", String(S.open))
  stage.classList.toggle("docked", S.open)
  panel.classList.toggle("open", S.open)
  panel.innerHTML = S.open ? (S.nav.length ? page(S.nav[S.nav.length - 1]) : root()) : ""
}

function move(direction, change) {
  document.documentElement.dataset.panelMove = direction
  const run = () => { change(); render() }
  if (document.startViewTransition) document.startViewTransition(run)
  else run()
}

async function load() {
  S.error = null
  try {
    const answer = await fetch("/" + encodeURIComponent(C.app) + "/_panel", { headers: { accept: "application/json" } })
    const body = await answer.json().catch(() => null)
    if (!answer.ok || !body) throw new Error(body && body.error ? body.error : "Couldn't load this app's details. Reload the page to try again.")
    S.data = body
    if (window.openbeltNotify) S.notify = await window.openbeltNotify.state(C.app).catch(() => null)
  } catch (e) {
    S.error = e.message
  }
  render()
}

/** Who can view the app ({ view }) or what visitors can use ({ public }), saved; then the panel loads again. */
async function save(change, key) {
  if (S.saving) return
  S.saving = true
  S.busy = key
  S.saveError = null
  render()
  try {
    const answer = await fetch("/" + encodeURIComponent(C.app) + "/_panel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ form: C.form }, change)) })
    const body = await answer.json().catch(() => null)
    if (!answer.ok) throw new Error(body && body.error ? body.error : "Couldn't save. Try again.")
    S.saving = false
    S.busy = null
    await load()
  } catch (e) {
    S.saving = false
    S.busy = null
    S.saveError = e.message
    render()
  }
}

/** The live "public" block with one collection's op, or one function, turned on or off. */
function toggled(kind, name, op) {
  const block = JSON.parse(JSON.stringify(S.data.details.public || {}))
  const part = kind === "op" ? "collections" : "functions"
  const all = block[part] || {}
  if (kind === "op") {
    const has = all[name] || []
    const next = has.includes(op) ? has.filter((x) => x !== op) : has.concat([op])
    if (next.length > 0) all[name] = next
    else delete all[name]
  } else if (all[name]) delete all[name]
  else all[name] = { secrets: [], uses: [] }
  if (Object.keys(all).length > 0) block[part] = all
  else delete block[part]
  return block
}

document.addEventListener("click", (event) => {
  const t = event.target.closest("[data-act]")
  if (!t) return
  const act = t.dataset.act
  if (act === "toggle") move(S.open ? "pop" : "push", () => { S.open = !S.open; S.nav = []; S.who = false; S.pending = null; if (S.open) load() })
  else if (act === "close") move("pop", () => { S.open = false; S.nav = [] })
  else if (act === "back") move("pop", () => { S.nav.pop(); S.saveError = null })
  else if (act === "go") move("push", () => { S.nav.push(t.dataset.page) })
  else if (act === "who") { S.who = !S.who; S.pending = null; S.saveError = null; render() }
  else if (act === "pick" && S.data && !S.saving) { const k = t.dataset.value; if (k === S.data.view) { S.who = false; S.pending = null } else S.pending = k; S.saveError = null; render() }
  else if (act === "cancel" && !S.saving) { S.who = false; S.pending = null; S.saveError = null; render() }
  else if (act === "confirm" && S.data && S.pending) {
    const before = S.data.publicUrl || S.data.url
    save({ view: S.pending }, "view").then(() => {
      if (S.saveError) return
      S.who = false
      S.pending = null
      if ((S.data.publicUrl || S.data.url) !== before) { S.fresh = true; S.flash = true; setTimeout(() => { S.flash = false; render() }, 1700) }
      render()
    })
  }
  else if (act === "bar" && S.data) { const block = JSON.parse(JSON.stringify(S.data.details.public || {})); if (block.bar === false) delete block.bar; else block.bar = false; save({ public: block }, "bar") }
  else if (act === "op" && S.data) save({ public: toggled("op", t.dataset.c, t.dataset.op) }, "op:" + t.dataset.c + ":" + t.dataset.op)
  else if (act === "fn" && S.data) save({ public: toggled("fn", t.dataset.f) }, "fn:" + t.dataset.f)
  else if (act === "range") { S.range = t.dataset.value; S.everyone = false; render() }
  else if (act === "everyone") { S.everyone = true; render() }
  else if (act === "notify" && S.notify && window.openbeltNotify && !S.notifying) {
    S.notifying = true
    render()
    window.openbeltNotify.answer(C.app, !S.notify.on).then((n) => { S.notify = n }, () => {}).finally(() => { S.notifying = false; render() })
  }
  else if (act === "copy") navigator.clipboard.writeText(t.dataset.url).then(() => { S.copied = t.dataset.key; S.fresh = false; render(); setTimeout(() => { S.copied = null; render() }, 1500) })
})
addEventListener("openbelt:notify", (event) => { S.notify = event.detail; render() })
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !S.open) return
  if (S.who && !S.saving) { S.who = false; S.pending = null; S.saveError = null; render(); return }
  if (S.nav.length) move("pop", () => { S.nav.pop() })
  else move("pop", () => { S.open = false })
})
})()`

/**
 * The frame's own script: the app's page loads with the address's hash (a server never sees it) and has the keyboard at once, unless the
 * person already moved it elsewhere; the address bar and the tab follow the page as it moves (its path, query, hash and title, as the
 * page says in a message only the app's own origin, in this frame, can send). The theme reaches the page without one: the server tells
 * it (reporter.ts), and the frame's color-scheme sets its prefers-color-scheme where the browser lets it.
 */
const FRAME_SCRIPT = `(() => {
  const frame = document.querySelector("iframe");
  const origin = new URL(frame.dataset.src).origin;
  const base = "/" + location.pathname.split("/")[1];
  const named = document.title;
  // The frame's own focus() alone leaves the keys with this page in Chrome: its window's (one of the few calls another origin's window takes) moves them in.
  const focus = () => { if (document.activeElement === document.body || document.activeElement === frame) { frame.focus(); frame.contentWindow.focus(); } };
  frame.src = frame.dataset.src + location.hash;
  focus();
  frame.addEventListener("load", focus);
  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || e.origin !== origin) return;
    const page = e.data && e.data.openbelt === "page" ? e.data : null;
    if (page === null) return;
    if (typeof page.title === "string") document.title = page.title.trim().slice(0, 200) || named;
    const at = page.at;
    if (typeof at !== "string" || !at.startsWith("/") || at.startsWith("//")) return;
    const to = new URL(base + (at.startsWith("/?") || at.startsWith("/#") || at === "/" ? at.slice(1) : at), location.href);
    if (to.origin !== location.origin || (to.pathname !== base && !to.pathname.startsWith(base + "/"))) return;
    const next = to.pathname + to.search + to.hash;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", next);
  });
})()`

export const appFrame = (name: string, src: string, panel: FramePanel) => {
  const shown = panel.access !== "none"

  const config: PanelConfig = { ...panel, app: name, icons: PANEL_ICONS }

  return `<!doctype html>
<html lang="en" data-theme="system"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(name)} · OpenBelt</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">${PWA_HEAD}
<script>${THEME_SCRIPT}</script>
<style>${tokensCss}${baseCss}
${FRAME_CSS}${shown ? PANEL_CSS : ""}
</style></head><body>
<header class="head"><a class="home" href="/" aria-label="All apps">${markSvg.replace("<svg ", '<svg class="home-logo" aria-hidden="true" ')}</a><svg class="divider" viewBox="0 0 8 18" aria-hidden="true"><path d="M6 2 2 16" fill="none" stroke="currentColor" stroke-width="1"/></svg><span class="name">${escape(name)}</span>${shown ? `<button class="panel-toggle" id="panel-toggle" data-act="toggle" aria-expanded="false" aria-controls="panel" aria-label="App details" title="App details">${PANEL_ICONS.panel}</button>` : ""}</header>
<main class="stage"><div class="frame"><iframe title="${escape(name)}" data-src="${escape(src)}" allow="clipboard-write; fullscreen" allowfullscreen></iframe><script>${FRAME_SCRIPT}</script></div>${shown ? `<aside class="panel" id="panel" aria-label="App details"></aside>` : ""}</main>
${shown ? `<script type="application/json" id="panel-config">${scriptJson(config)}</script><script>${PANEL_SCRIPT}</script>` : ""}
</body></html>`
}

/**
 * The public host's page load of a public app: the OpenBelt bar (the logo to OpenBelt, the app's name, Sign in to its workspace,
 * back to the app there), then the app's page in a frame on the same address. The frame's own request (Sec-Fetch-Dest: iframe)
 * gets the page itself, so does anything that isn't a browser opening the page; the address bar follows the page.
 */
export const publicFrame = (name: string, home: string, signIn: string) => `<!doctype html>
<html lang="en" data-theme="system"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(name)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${tokensCss}${baseCss}${FRAME_CSS}
.home.brand { width: auto; padding: 0 10px 0 10px; }
.home.brand b { font: 600 14px/1 var(--openbelt-font-body); color: var(--openbelt-color-primary); }
.head .name { flex: 1; }
.signin { height: 32px; padding: 0 12px; border-radius: var(--openbelt-radius-sm); display: inline-flex; align-items: center; color: inherit; font: 550 13px/1 var(--openbelt-font-body); text-decoration: none; flex: none; }
.signin:hover, .signin:focus-visible { background: var(--openbelt-color-subtle); }
.signin:active { transform: translateY(1px); }
@media (max-width: 560px) { .home.brand b { display: none; } .home.brand { width: 36px; padding: 0; } }
</style></head><body>
<header class="head"><a class="home brand" href="${escape(home)}" aria-label="OpenBelt">${markSvg.replace("<svg ", '<svg class="home-logo" aria-hidden="true" ')}<b>OpenBelt</b></a><svg class="divider" viewBox="0 0 8 18" aria-hidden="true"><path d="M6 2 2 16" fill="none" stroke="currentColor" stroke-width="1"/></svg><span class="name">${escape(name)}</span><a class="signin" href="${escape(signIn)}">Sign in</a></header>
<main class="stage"><div class="frame"><iframe title="${escape(name)}" allow="clipboard-write; fullscreen" allowfullscreen></iframe></div></main>
<script>${PUBLIC_FRAME_SCRIPT}</script>
</body></html>`

/**
 * The public frame's script: the page loads at this address (with its hash) with the keyboard, and the address bar and title follow it.
 * The page is on this same origin (the public host sends no reporter), so the frame watches its history and title itself.
 */
const PUBLIC_FRAME_SCRIPT = `(() => {
  const frame = document.querySelector("iframe");
  const named = document.title;
  // The whole address, never the path alone: a path starting "//" would read as another host.
  frame.src = location.href;
  const focus = () => { if (document.activeElement === document.body || document.activeElement === frame) { frame.focus(); frame.contentWindow.focus(); } };
  focus();
  const follow = () => {
    try {
      const page = frame.contentWindow.location;
      const at = page.pathname + page.search + page.hash;
      if (page.origin === location.origin && at !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", at);
      document.title = frame.contentDocument.title.trim().slice(0, 200) || named;
    } catch {}
  };
  frame.addEventListener("load", () => {
    focus();
    follow();
    try {
      const inner = frame.contentWindow;
      new inner.MutationObserver(follow).observe(frame.contentDocument.head, { subtree: true, childList: true, characterData: true });
      for (const k of ["pushState", "replaceState"]) {
        const original = inner.history[k];
        inner.history[k] = function (...args) { const r = original.apply(this, args); follow(); return r; };
      }
      inner.addEventListener("popstate", follow);
      inner.addEventListener("hashchange", follow);
    } catch {}
  });
})()`

export const frameSignIn = (
  url: string,
) => `<!doctype html><html lang="en" data-theme="system"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · OpenBelt</title>
<script>${THEME_SCRIPT}</script><style>${tokensCss}${baseCss}body { padding: 24px; }</style></head>
<body><p>Your session ended.</p><a href="${escape(url)}" target="_top">Sign in to continue</a></body></html>`
