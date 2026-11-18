// Small DOM helpers, icons, menus, dialogs, toasts and formatters.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === "class") el.className = v
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v)
    else if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === "html") el.innerHTML = v
    else if (k in el && typeof v !== "string") el[k] = v
    else el.setAttribute(k, v === true ? "" : v)
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

const P = {
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  start: '<path d="M19 20 9 12l10-8v16z" fill="currentColor" stroke="none"/><path d="M5 19V5"/>',
  end: '<path d="m5 4 10 8-10 8V4z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
  stepBack: '<path d="m15 18-6-6 6-6"/>',
  stepFwd: '<path d="m9 18 6-6-6-6"/>',
  loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
  split:
    '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  zoomIn:
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
  fit: '<path d="M21 3 14 10"/><path d="M3 21l7-7"/><path d="M15 3h6v6"/><path d="M9 21H3v-6"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="M2 2l20 20"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  volume:
    '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/><path d="M17 7h5"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  shape: '<rect x="3" y="3" width="11" height="11" rx="1"/><circle cx="16" cy="16" r="6"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r="1.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="1.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="1.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="1.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  more: '<circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/>',
  magnet:
    '<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  sparkles:
    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  diamond: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/>',
  diamondFill: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z" fill="currentColor"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  flipH:
    '<path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/>',
  flipV:
    '<path d="M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/>',
  alignL: '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
  alignC: '<path d="M21 6H3"/><path d="M17 12H7"/><path d="M19 18H5"/>',
  alignR: '<path d="M21 6H3"/><path d="M21 12H9"/><path d="M21 18H7"/>',
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<path d="M19 4h-9"/><path d="M14 20H5"/><path d="M15 4 9 20"/>',
  speed: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  record: '<circle cx="12" cy="12" r="8" fill="currentColor" stroke="none"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  keyboard:
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
  captions:
    '<rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4"/><path d="M15 15h2"/><path d="M7 11h2"/><path d="M13 11h4"/>',
  unlink:
    '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><path d="M8 2v3"/><path d="M2 8h3"/><path d="M16 22v-3"/><path d="M22 16h-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
}

export function icon(name, size = 18) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  s.setAttribute("viewBox", "0 0 24 24")
  s.setAttribute("width", size)
  s.setAttribute("height", size)
  s.setAttribute("fill", "none")
  s.setAttribute("stroke", "currentColor")
  s.setAttribute("stroke-width", "2")
  s.setAttribute("stroke-linecap", "round")
  s.setAttribute("stroke-linejoin", "round")
  s.setAttribute("aria-hidden", "true")
  s.classList.add("icon")
  s.innerHTML = P[name] || ""
  return s
}

export function iconBtn(name, title, onClick, opts = {}) {
  return h(
    "button",
    {
      class: "ibtn " + (opts.class || ""),
      title,
      "aria-label": title,
      type: "button",
      onclick: onClick,
    },
    icon(name, opts.size || 18),
    opts.label ? h("span", {}, opts.label) : null,
  )
}

export function btn(label, onClick, cls = "") {
  return h("button", { class: "btn " + cls, type: "button", onclick: onClick }, label)
}

// Run an async action with the button's loading state.
export async function busy(button, fn) {
  if (button.classList.contains("loading")) return
  button.classList.add("loading")
  button.disabled = true
  try {
    return await fn()
  } finally {
    button.classList.remove("loading")
    button.disabled = false
  }
}

let toastBox
export function toast(msg, kind = "") {
  if (!toastBox) document.body.append((toastBox = h("div", { class: "toasts" })))
  const t = h("div", { class: "toast " + kind }, msg)
  toastBox.append(t)
  setTimeout(() => t.classList.add("out"), 2600)
  setTimeout(() => t.remove(), 3000)
}

let openMenuEl = null
export function closeMenu() {
  openMenuEl?.remove()
  openMenuEl = null
}
// items: [{ label, icon, kbd, onClick, danger, disabled } | "-"]
export function menu(x, y, items) {
  closeMenu()
  const m = h(
    "div",
    { class: "menu", role: "menu" },
    items.map((it) =>
      it === "-"
        ? h("div", { class: "menu-sep" })
        : h(
            "button",
            {
              class: "menu-item" + (it.danger ? " danger" : ""),
              disabled: it.disabled,
              type: "button",
              onclick: () => {
                closeMenu()
                it.onClick()
              },
            },
            it.icon ? icon(it.icon, 16) : h("span", { class: "menu-icon-pad" }),
            h("span", { class: "menu-label" }, it.label),
            it.kbd ? h("kbd", {}, it.kbd) : null,
          ),
    ),
  )
  document.body.append(m)
  const r = m.getBoundingClientRect()
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px"
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px"
  openMenuEl = m
  setTimeout(() => {
    const off = (e) => {
      if (!m.contains(e.target)) {
        closeMenu()
        removeEventListener("pointerdown", off, true)
      }
    }
    addEventListener("pointerdown", off, true)
  })
  return m
}

export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => {
    back.remove()
    removeEventListener("keydown", onKey, true)
    onClose?.()
  }
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      close()
    }
  }
  const back = h(
    "div",
    { class: "modal-back", onpointerdown: (e) => e.target === back && close() },
    h(
      "div",
      { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-label": title },
      h("div", { class: "modal-head" }, h("h2", {}, title), iconBtn("x", "Close", close)),
      h("div", { class: "modal-body" }, body),
    ),
  )
  addEventListener("keydown", onKey, true)
  document.body.append(back)
  return { close, el: back }
}

export function confirmDialog(title, text, okLabel = "Delete") {
  return new Promise((resolve) => {
    let done = false
    const m = modal(
      title,
      h(
        "div",
        { class: "confirm" },
        h("p", {}, text),
        h(
          "div",
          { class: "row end" },
          btn("Cancel", () => m.close()),
          btn(
            okLabel,
            () => {
              done = true
              resolve(true)
              m.close()
            },
            "danger",
          ),
        ),
      ),
      { onClose: () => !done && resolve(false) },
    )
  })
}

export function fmtTime(t, fps = 30) {
  t = Math.max(0, t)
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const f = Math.floor((t - Math.floor(t)) * fps + 1e-6)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`
}

export function fmtDur(t) {
  if (!isFinite(t)) return ""
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

export function fmtBytes(n) {
  if (n < 1024) return n + " B"
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB"
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB"
  return (n / 1073741824).toFixed(2) + " GB"
}

export function ago(ms) {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return "just now"
  if (s < 3600) return Math.floor(s / 60) + " min ago"
  if (s < 86400) return Math.floor(s / 3600) + " h ago"
  if (s < 86400 * 7) return Math.floor(s / 86400) + " d ago"
  return new Date(ms).toLocaleDateString()
}

// A small shape with the aspect ratio of w×h, fitting a size×size box.
export function ratioBox(w, hh, size = 28) {
  const k = size / Math.max(w, hh)
  return h("span", {
    class: "ratio",
    style: { width: Math.round(w * k) + "px", height: Math.round(hh * k) + "px" },
  })
}

export const uid = (p = "") =>
  p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export const mod = isMac ? "⌘" : "Ctrl+"
