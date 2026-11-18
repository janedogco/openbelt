const PHONE = "(max-width: 820px)"

const WIDE = "(min-width: 821px)"

export const RAIL_HEAD = `try { if (localStorage.getItem("openbelt-sidebar") === "rail") document.documentElement.dataset.sidebar = "rail" } catch {}`

const HIDDEN =
  "position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;"

const RAIL = ':root[data-sidebar="rail"]'

export const SCRIM = `<div class="scrim" aria-hidden="true"></div>`

export const SIDEBAR_CSS = `
html, body { overscroll-behavior-y: none; }
body { background: var(--openbelt-color-sidebar); }
.shell { height: 100vh; height: 100dvh; min-height: 0; }
.side { position: relative; height: 100%; background: none; }
.side .nav > a:hover { background: var(--openbelt-color-subtle); color: var(--openbelt-color-primary); }
.side .nav > [aria-current="page"] { background: var(--openbelt-color-sidebar-selected); color: var(--openbelt-color-primary); font-weight: 550; }
.inset { min-width: 0; margin: var(--openbelt-space-xs) var(--openbelt-space-xs) var(--openbelt-space-xs) 0; overflow: auto; overscroll-behavior-y: none; background: var(--openbelt-color-neutral); border-radius: var(--openbelt-radius-lg); }
.scrim { display: none; }
.collapse { flex: none; width: 28px; height: 28px; margin: -3px 0 -3px auto; color: var(--openbelt-color-muted); }
.collapse:hover { color: var(--openbelt-color-primary); }
.collapse > span { display: inline-flex; }
.collapse .when-rail { display: none; }
.shut, .switcher .me > .icon { display: none; }
.side:focus { outline: none; }
@media ${WIDE} {
  .shell { transition: grid-template-columns var(--openbelt-duration) var(--openbelt-ease); }
  ${RAIL} .shell { grid-template-columns: 56px minmax(0, 1fr); }
  ${RAIL} .side { overflow: visible; z-index: 5; }
  ${RAIL} .collapse { margin: 0; }
  ${RAIL} .collapse .when-open { display: none; }
  ${RAIL} .collapse .when-rail { display: inline-flex; }
  ${RAIL} .side .head { justify-content: center; padding-inline: 0; }
  ${RAIL} .side .head > :not(.collapse) { display: none; }
  ${RAIL} .nav a { justify-content: center; padding: 0; }
  ${RAIL} .nav .label { ${HIDDEN} }
  ${RAIL} .me { justify-content: center; padding-inline: 0; }
  ${RAIL} .me .who, ${RAIL} .me > .icon { display: none; }
  ${RAIL} .you .menu { right: auto; width: 232px; }
}
@media (prefers-reduced-motion: reduce) {
  .shell { transition: none; }
}
@media ${PHONE} {
  .collapse { display: none; }
  body { background: var(--openbelt-color-neutral); }
  .shell { height: auto; min-height: 100vh; }
  .inset { margin: 0; overflow: visible; border-radius: 0; }
  .side { position: fixed; z-index: 6; inset: 0 auto 0 0; height: auto; width: min(280px, calc(100vw - 56px)); overscroll-behavior: contain; background: var(--openbelt-color-sidebar); border-radius: 0 var(--openbelt-radius-lg) var(--openbelt-radius-lg) 0; transform: translateX(-100%); visibility: hidden; transition: transform var(--openbelt-duration) var(--openbelt-ease), visibility 0s linear var(--openbelt-duration); }
  .side.open { transform: none; visibility: visible; transition: transform var(--openbelt-duration) var(--openbelt-ease); }
  .side { inset: var(--openbelt-space-xs) auto var(--openbelt-space-xs) var(--openbelt-space-xs); width: min(320px, calc(100vw - 56px)); border-radius: var(--openbelt-radius-lg); transform: translateX(calc(-100% - var(--openbelt-space-xs))); }
  .side .head { margin-bottom: 0; padding: var(--openbelt-space-xs) var(--openbelt-space-xs) var(--openbelt-space-xs) var(--openbelt-space-md); }
  .shut { display: inline-flex; width: 36px; height: 36px; margin-left: auto; color: var(--openbelt-color-muted); }
  .switcher { padding: 0 var(--openbelt-space-xs) var(--openbelt-space-2xs); }
  .switcher .me { gap: var(--openbelt-space-sm); padding: var(--openbelt-space-xs) var(--openbelt-space-sm); border-radius: var(--openbelt-radius-lg); background: var(--openbelt-color-neutral); }
  .switcher .me:hover { background: var(--openbelt-color-subtle); }
  .switcher .me:active { background: var(--openbelt-color-sidebar-selected); }
  .switcher .me .avatar { width: 30px; height: 30px; }
  .switcher .me .who b { font: 600 15px/1.25 var(--openbelt-font-body); }
  .switcher .me > .icon { display: inline-flex; }
  .side .nav { gap: 2px; padding: var(--openbelt-space-xs) var(--openbelt-space-xs) 0; }
  .side .nav a { gap: var(--openbelt-space-sm); height: 44px; padding: 0 var(--openbelt-space-sm); border-radius: var(--openbelt-radius-md); color: var(--openbelt-color-primary); font: var(--openbelt-type-body-md); }
  .side .nav a:active { background: var(--openbelt-color-sidebar-selected); }
  .you { display: flex; flex-direction: column; gap: var(--openbelt-space-2xs); padding: var(--openbelt-space-md) var(--openbelt-space-xs) var(--openbelt-space-sm); }
  .you .menu { display: grid !important; order: -1; position: static; min-width: 0; padding: 0; gap: 2px; border: 0; box-shadow: none; background: none; }
  .you .menu-item, .you .menu-choice { gap: var(--openbelt-space-sm); height: 44px; padding: 0 var(--openbelt-space-sm); border-radius: var(--openbelt-radius-md); font: var(--openbelt-type-body-md); }
  .you .menu-choice [role="menuitemradio"] { width: 36px; height: 36px; }
  .you .menu-choice { padding-right: var(--openbelt-space-2xs); }
  .you .menu-choice .label { gap: var(--openbelt-space-sm); }
  .you .menu-item:focus:not(:focus-visible) { background: none; }
  .you .menu-item:active { background: var(--openbelt-color-sidebar-selected); }
  .you > .me { pointer-events: none; padding: var(--openbelt-space-xs) var(--openbelt-space-sm); border-radius: var(--openbelt-radius-md); background: var(--openbelt-color-neutral); }
  .you > .me > .icon { display: none; }
  .scrim { display: none; z-index: 5; background: rgb(12 11 10 / 0.5); transition: opacity var(--openbelt-duration) var(--openbelt-ease), visibility 0s linear var(--openbelt-duration), display var(--openbelt-duration) allow-discrete; }
  .scrim.open { display: block; }
  @starting-style { .scrim.open { opacity: 0; } }
  html.drawer-open { overflow: hidden; }
}
`

export const DRAWER_SCRIPT = `{
  const side = document.getElementById("side")
  const toggle = document.querySelector(".drawer")
  const scrim = document.querySelector(".scrim")
  const behind = [...side.parentElement.children].filter((el) => el !== side)
  const isOpen = () => side.classList.contains("open")
  const set = (open, refocus) => {
    if (open === isOpen()) return
    side.classList.toggle("open", open)
    scrim.classList.toggle("open", open)
    document.documentElement.classList.toggle("drawer-open", open)
    for (const el of behind) el.inert = open
    toggle?.setAttribute("aria-expanded", String(open))
    if (open) {
      side.tabIndex = -1
      side.focus({ preventScroll: true })
      return
    }
    side.removeAttribute("tabindex")
    if (refocus) toggle?.focus()
  }
  toggle?.addEventListener("click", () => set(!isOpen(), true))
  scrim.addEventListener("click", () => set(false, true))
  side.querySelector(".shut")?.addEventListener("click", () => set(false, true))
  side.addEventListener("click", (e) => { if (e.target.closest(".nav a")) set(false, false) })
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) { e.stopImmediatePropagation(); set(false, true) } })
  matchMedia(${JSON.stringify(PHONE)}).addEventListener("change", (e) => { if (!e.matches) set(false, false) })
  const fold = side.querySelector(".collapse")
  const root = document.documentElement
  const sync = () => {
    const rail = root.dataset.sidebar === "rail"
    const says = rail ? "Expand sidebar" : "Collapse sidebar"
    fold?.setAttribute("aria-expanded", String(!rail))
    fold?.setAttribute("aria-label", says)
    if (fold) fold.title = says + " ([ or ⌘B)"
    for (const el of side.querySelectorAll(".nav a, .me")) {
      const text = el.querySelector(".label, .who b")?.textContent
      if (!text) continue
      if (rail && !el.hasAttribute("title")) { el.title = text; el.dataset.tip = "" }
      else if (!rail && el.hasAttribute("data-tip")) { el.removeAttribute("title"); el.removeAttribute("data-tip") }
    }
  }
  const flip = () => {
    const rail = root.dataset.sidebar !== "rail"
    if (rail) root.dataset.sidebar = "rail"
    else delete root.dataset.sidebar
    try { if (rail) localStorage.setItem("openbelt-sidebar", "rail"); else localStorage.removeItem("openbelt-sidebar") } catch {}
    sync()
  }
  fold?.addEventListener("click", flip)
  document.addEventListener("keydown", (e) => {
    const chord = e.key?.toLowerCase() === "b" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
    if (!(chord || (e.key === "[" && !e.metaKey && !e.ctrlKey && !e.altKey)) || !fold || matchMedia(${JSON.stringify(PHONE)}).matches) return
    if (e.target.closest?.(chord ? "[contenteditable]" : "input, textarea, select, [contenteditable]")) return
    e.preventDefault()
    flip()
  })
  sync()
}`
