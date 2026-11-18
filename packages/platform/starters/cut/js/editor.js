// The editor screen: top bar, media / text / elements panels, the preview with
// its transport, the inspector, the timeline, keyboard shortcuts, phone layout.
import {
  state,
  on,
  emit,
  commit,
  select,
  seek,
  undo,
  redo,
  canUndo,
  canRedo,
  saveNow,
  setThumbProvider,
  selectedClip,
  selectedClips,
  resetHistory,
} from "./store.js"
import { Player } from "./player.js"
import { Timeline, clipMenuItems } from "./timeline.js"
import { Inspector } from "./inspector.js"
import { openExport } from "./export.js"
import { importFiles, deleteMedia, record, mediaUrl, kindOf } from "./media.js"
import { TEXT_STYLES, projectDuration, clipEnd } from "./model.js"
import * as A from "./actions.js"
import { openCaptions } from "./captions.js"
import {
  h,
  icon,
  iconBtn,
  btn,
  menu,
  modal,
  toast,
  fmtTime,
  fmtDur,
  mod,
  isMac,
  confirmDialog,
  busy,
} from "./ui.js"

export function openEditor(root, { onHome }) {
  resetHistory()
  const offs = []
  let mediaGrid = null
  const nameInput = h("input", {
    class: "proj-name",
    value: state.project.name,
    "aria-label": "Project name",
    onchange: () => commit((p) => (p.name = nameInput.value.trim() || "Untitled")),
    onkeydown: (e) => {
      e.stopPropagation()
      if (e.key === "Enter") nameInput.blur()
    },
  })
  const saveEl = h("span", { class: "save-state" })
  const undoBtn = iconBtn("undo", `Undo (${mod}Z)`, () => undo())
  const redoBtn = iconBtn("redo", `Redo (${isMac ? "⇧⌘Z" : "Ctrl+Y"})`, () => redo())
  const exportBtn = h(
    "button",
    { class: "btn primary", type: "button", onclick: () => openExport(player) },
    icon("download", 16),
    h("span", {}, "Export"),
  )
  const top = h(
    "header",
    { class: "topbar" },
    iconBtn("back", "All projects", async () => {
      await saveNow()
      onHome()
    }),
    h("div", { class: "brand-dot" }),
    nameInput,
    saveEl,
    h("div", { class: "grow" }),
    undoBtn,
    redoBtn,
    iconBtn("keyboard", "Keyboard shortcuts (?)", () => shortcuts(), { class: "hide-phone" }),
    exportBtn,
  )

  // panels
  const leftTabs = ["media", "text", "elements"]
  let leftTab = "media"
  const leftBody = h("div", { class: "panel-body" })
  const tabBtns = leftTabs.map((t) =>
    h(
      "button",
      { class: "tab", type: "button", onclick: () => setLeft(t) },
      icon({ media: "film", text: "text", elements: "shape" }[t], 16),
      h("span", {}, { media: "Media", text: "Text", elements: "Elements" }[t]),
    ),
  )
  const left = h("aside", { class: "panel left" }, h("div", { class: "tabs" }, tabBtns), leftBody)
  function setLeft(t) {
    leftTab = t
    tabBtns.forEach((b, i) => b.classList.toggle("on", leftTabs[i] === t))
    leftBody.replaceChildren(
      t === "media" ? mediaPanel() : t === "text" ? textPanel() : elementsPanel(),
    )
  }

  const stage = h("div", { class: "stage" })
  const timeEl = h("span", { class: "tc" })
  const playBtn = iconBtn("play", "Play (Space)", () => player.toggle(), {
    class: "play",
    size: 20,
  })
  const loopBtn = iconBtn("loop", `Loop (${mod}L)`, () => {
    state.loop = !state.loop
    loopBtn.classList.toggle("on", state.loop)
  })
  const fps = () => state.project.scene.fps
  const transport = h(
    "div",
    { class: "transport" },
    h("div", { class: "tp-left" }, timeEl),
    h(
      "div",
      { class: "tp-mid" },
      iconBtn("start", "Go to start (Home)", () => seek(0)),
      iconBtn("stepBack", "Previous frame (←)", () => seek(state.time - 1 / fps())),
      playBtn,
      iconBtn("stepFwd", "Next frame (→)", () => seek(state.time + 1 / fps())),
      iconBtn("end", "Go to end (End)", () => seek(projectDuration(state.project))),
    ),
    h(
      "div",
      { class: "tp-right" },
      loopBtn,
      iconBtn("camera", "Save frame as PNG", () => screenshot()),
      iconBtn("full", "Full screen", () =>
        document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.(),
      ),
    ),
  )
  const center = h("div", { class: "center" }, stage, transport)
  const inspEl = h("div", { class: "panel-body insp-scroll" })
  const right = h("aside", { class: "panel right" }, inspEl)
  const tlEl = h("div", { class: "timeline" })
  const resizer = h("div", { class: "tl-resizer", title: "Drag to resize" })

  // phone navigation
  const sheetClose = iconBtn("x", "Close", () => setSheet(null), { class: "sheet-close" })
  const navBtns = {}
  const nav = h(
    "nav",
    { class: "mobile-nav" },
    [
      ["media", "film", "Media"],
      ["text", "text", "Text"],
      ["elements", "shape", "Elements"],
      ["edit", "settings", "Edit"],
    ].map(
      ([id, ic, label]) =>
        (navBtns[id] = h(
          "button",
          { class: "mnav", type: "button", onclick: () => setSheet(id) },
          icon(ic, 20),
          h("span", {}, label),
        )),
    ),
  )
  const clipBar = h(
    "nav",
    { class: "mobile-clipbar" },
    h(
      "button",
      { class: "mnav", type: "button", onclick: () => A.split() },
      icon("split", 20),
      h("span", {}, "Split"),
    ),
    h(
      "button",
      { class: "mnav", type: "button", onclick: () => setSheet("edit") },
      icon("settings", 20),
      h("span", {}, "Edit"),
    ),
    h(
      "button",
      { class: "mnav", type: "button", onclick: () => A.duplicate() },
      icon("copy", 20),
      h("span", {}, "Copy"),
    ),
    h(
      "button",
      { class: "mnav", type: "button", onclick: () => A.remove() },
      icon("trash", 20),
      h("span", {}, "Delete"),
    ),
    h(
      "button",
      { class: "mnav", type: "button", onclick: () => select([]) },
      icon("check", 20),
      h("span", {}, "Done"),
    ),
  )
  let sheet = null
  function setSheet(id) {
    sheet = sheet === id ? null : id
    root.classList.toggle("sheet-open", !!sheet)
    root.dataset.sheet = sheet || ""
    for (const [k, b] of Object.entries(navBtns)) b.classList.toggle("on", k === sheet)
    if (sheet && sheet !== "edit") setLeft(sheet)
  }

  const shell = h(
    "div",
    { class: "editor" },
    top,
    h("div", { class: "main" }, left, center, right, sheetClose),
    resizer,
    tlEl,
    nav,
    clipBar,
  )
  root.replaceChildren(shell)
  root.classList.add("in-editor")

  const player = new Player(stage)
  const emptyHint = h(
    "button",
    { class: "stage-empty", type: "button", onclick: () => fileInput.click() },
    icon("upload", 26),
    h("b", {}, "Add videos, music or images"),
    h("span", {}, "Drop files here or click to browse"),
  )
  stage.append(emptyHint)
  const syncEmpty = () => emptyHint.classList.toggle("on", !state.project.clips.length)
  offs.push(on("project", syncEmpty))
  requestAnimationFrame(syncEmpty)
  const timeline = new Timeline(tlEl, { player })
  const inspector = new Inspector(inspEl, { player })
  setThumbProvider(() => player.snapshot(320).url())
  setLeft("media")

  // resize the timeline
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault()
    resizer.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const h0 = tlEl.getBoundingClientRect().height
    const move = (ev) => {
      const nh = Math.max(140, Math.min(innerHeight - 260, h0 - (ev.clientY - y0)))
      shell.style.setProperty("--tl-h", nh + "px")
    }
    const up = () => {
      resizer.removeEventListener("pointermove", move)
      resizer.removeEventListener("pointerup", up)
      try {
        localStorage.setItem("cut.tlh", shell.style.getPropertyValue("--tl-h"))
      } catch {}
    }
    resizer.addEventListener("pointermove", move)
    resizer.addEventListener("pointerup", up)
  })
  try {
    const v = localStorage.getItem("cut.tlh")
    if (v) shell.style.setProperty("--tl-h", v)
  } catch {}

  // status
  const syncTop = () => {
    undoBtn.disabled = !canUndo()
    redoBtn.disabled = !canRedo()
    if (document.activeElement !== nameInput) nameInput.value = state.project.name
  }
  const syncSave = () => {
    saveEl.textContent = { saved: "Saved", dirty: "Edited", saving: "Saving…", error: "Not saved" }[
      state.save
    ]
    saveEl.dataset.s = state.save
  }
  const syncTime = () => (timeEl.textContent = fmtTime(state.time, fps()))
  const syncPlay = () => playBtn.replaceChildren(icon(state.playing ? "pause" : "play", 20))
  const syncSel = () => root.classList.toggle("has-sel", state.sel.size > 0)
  offs.push(
    on("project", syncTop),
    on("save", syncSave),
    on("time", syncTime),
    on("play", syncPlay),
    on("selection", syncSel),
    on("open-inspector", () => setSheet("edit")),
  )
  syncTop()
  syncSave()
  syncTime()
  syncSel()

  // --- media panel -------------------------------------------------------------------

  const fileInput = h("input", {
    type: "file",
    multiple: true,
    accept: "video/*,audio/*,image/*,.srt,.mov,.mkv",
    hidden: true,
    onchange: async () => {
      await importAny([...fileInput.files])
      fileInput.value = ""
    },
  })
  shell.append(fileInput)

  async function importAny(list) {
    const srt = list.filter((f) => f.name.toLowerCase().endsWith(".srt"))
    for (const f of srt) A.importSrt(await f.text())
    const media = list.filter((f) => kindOf(f))
    if (!media.length) return []
    const wasEmpty = !state.project.clips.length
    const added = await importFiles(media)
    if (wasEmpty && added.length) A.addSequence(added)
    return added
  }

  function mediaPanel() {
    mediaGrid = h("div", { class: "media-grid" })
    renderMedia()
    return h(
      "div",
      { class: "media-panel" },
      h(
        "div",
        { class: "panel-actions" },
        h(
          "button",
          { class: "btn primary block", type: "button", onclick: () => fileInput.click() },
          icon("upload", 16),
          "Import",
        ),
        iconBtn(
          "record",
          "Record camera or screen",
          (e) => {
            const r = e.currentTarget.getBoundingClientRect()
            menu(r.left, r.bottom + 4, [
              { label: "Record screen", icon: "monitor", onClick: () => startRecording("screen") },
              { label: "Record camera", icon: "camera", onClick: () => startRecording("camera") },
            ])
          },
          { class: "rec" },
        ),
      ),
      mediaGrid,
    )
  }

  function renderMedia() {
    if (!mediaGrid) return
    const list = [...state.media.values()].sort((a, b) => (a.created || 0) - (b.created || 0))
    if (!list.length) {
      mediaGrid.replaceChildren(
        h(
          "button",
          { class: "drop-hint", type: "button", onclick: () => fileInput.click() },
          icon("upload", 28),
          h("b", {}, "Drop videos, music or images"),
          h("span", {}, "or click to browse"),
        ),
      )
      return
    }
    const used = new Set(state.project.clips.map((c) => c.mediaId))
    mediaGrid.replaceChildren(
      ...list.map((m) => {
        const card = h(
          "div",
          {
            class:
              "mcard k-" +
              m.kind +
              (used.has(m.id) ? " used" : "") +
              (m.status === "error" ? " error" : ""),
            draggable: "true",
            title: m.name,
            ondragstart: (e) => {
              e.dataTransfer.setData("application/x-cut-media", m.id)
              e.dataTransfer.effectAllowed = "copy"
            },
            ondblclick: () => A.addMediaClip(m),
            onclick: () => {
              state.mediaSel = m.id
              select([])
              state.mediaSel = m.id
              emit("media-select")
              for (const c of mediaGrid.children)
                c.classList?.toggle("picked", c.dataset.id === m.id)
              if (root.dataset.sheet === "media") setSheet("edit")
            },
            oncontextmenu: (e) => {
              e.preventDefault()
              mediaMenu(e.clientX, e.clientY, m)
            },
          },
          h(
            "div",
            { class: "mthumb" },
            m.thumb
              ? h("img", { src: m.thumb, alt: "", draggable: "false" })
              : h(
                  "div",
                  { class: "mthumb-icon" },
                  icon(m.kind === "audio" ? "music" : m.kind === "image" ? "image" : "film", 26),
                ),
            m.kind !== "image" && m.duration
              ? h("span", { class: "mdur" }, fmtDur(m.duration))
              : null,
            m.status === "uploading"
              ? h(
                  "div",
                  { class: "mprog" },
                  h("div", { style: { width: (m.progress || 0) * 100 + "%" } }),
                )
              : null,
            h(
              "button",
              {
                class: "madd",
                type: "button",
                title: "Add to timeline",
                "aria-label": "Add to timeline",
                onclick: (e) => (e.stopPropagation(), A.addMediaClip(m)),
              },
              icon("plus", 18),
            ),
          ),
          h("div", { class: "mname" }, m.name),
        )
        card.dataset.id = m.id
        if (state.mediaSel === m.id) card.classList.add("picked")
        return card
      }),
    )
  }
  offs.push(
    on("media", () => leftTab === "media" && renderMedia()),
    on("media-progress", (m) => {
      const bar = mediaGrid?.querySelector(`.mcard[data-id="${m.id}"] .mprog > div`)
      if (bar) bar.style.width = (m.progress || 0) * 100 + "%"
    }),
    on("project", () => leftTab === "media" && renderMedia()),
  )

  function mediaMenu(x, y, m) {
    menu(x, y, [
      { label: "Add at playhead", icon: "plus", onClick: () => A.addMediaClip(m) },
      {
        label: "Add at end",
        icon: "end",
        onClick: () => A.addMediaClip(m, { time: projectDuration(state.project) }),
      },
      { label: "Open original", icon: "share", onClick: () => open(mediaUrl(m), "_blank") },
      "-",
      {
        label: "Delete",
        icon: "trash",
        danger: true,
        onClick: async () => {
          const n = state.project.clips.filter((c) => c.mediaId === m.id).length
          if (
            !(await confirmDialog(
              "Delete media?",
              n
                ? `${m.name} and its ${n} clip${n > 1 ? "s" : ""} on the timeline will be removed.`
                : `${m.name} will be removed.`,
            ))
          )
            return
          if (n) commit((p) => (p.clips = p.clips.filter((c) => c.mediaId !== m.id)))
          await deleteMedia(m)
          // Its file is gone, so no undo step may bring its clips back.
          if (n) {
            resetHistory()
            emit("project")
          }
        },
      },
    ])
  }

  async function startRecording(kind) {
    const feature = kind === "screen" ? "display-capture" : "camera"
    if (
      window.top !== window &&
      document.featurePolicy &&
      !document.featurePolicy.allowsFeature(feature)
    ) {
      // Embedded pages may not record: open the editor in its own tab.
      await saveNow()
      open(location.href, "_blank")
      toast("Opened the editor in its own tab, where recording works")
      return
    }
    let rec
    try {
      rec = await record(kind)
    } catch (e) {
      if (e.name !== "NotAllowedError") toast("Can't record: " + e.message, "error")
      return
    }
    const video = h("video", {
      class: "rec-preview",
      autoplay: true,
      muted: true,
      playsinline: true,
    })
    video.srcObject = rec.stream
    const time = h("span", { class: "rec-time" }, "0:00")
    const t0 = Date.now()
    const timer = setInterval(() => (time.textContent = fmtDur((Date.now() - t0) / 1000)), 500)
    let stopped = false
    const stop = async (e) => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      await busy(e?.currentTarget || stopBtn, async () => {
        const file = await rec.stop()
        m.close()
        await importAny([file])
      })
    }
    const stopBtn = h(
      "button",
      { class: "btn danger big", type: "button", onclick: stop },
      icon("record", 14),
      "Stop recording",
    )
    const m = modal(
      kind === "screen" ? "Recording screen" : "Recording camera",
      h(
        "div",
        { class: "rec" },
        video,
        h("div", { class: "row between" }, h("span", { class: "rec-dot" }, time), stopBtn),
      ),
      {
        onClose: () => !stopped && stop(),
      },
    )
    rec.stream.getVideoTracks()[0].addEventListener("ended", () => stop())
  }

  // --- text & elements -----------------------------------------------------------------

  function textPanel() {
    return h(
      "div",
      { class: "text-panel" },
      h(
        "div",
        { class: "text-styles" },
        TEXT_STYLES.map((s) =>
          h(
            "button",
            {
              class: "text-style",
              type: "button",
              onclick: () => {
                const sc = state.project.scene.height / 1080
                A.addClip("text", {
                  text: {
                    ...s.text,
                    size: Math.round(s.text.size * sc),
                    content:
                      s.label === "Caption"
                        ? "Add a caption"
                        : s.label === "Subtitle"
                          ? "A subtitle line"
                          : s.label,
                  },
                })
                if (s.id === "caption" || s.id === "subtitle")
                  commit((p) => (p.clips[p.clips.length - 1].props.y = p.scene.height * 0.82), {
                    coalesce: "newtext",
                  })
              },
            },
            h(
              "span",
              {
                style: {
                  fontFamily: `"${s.text.font}"`,
                  fontWeight: s.text.weight,
                  color: s.text.color,
                  background: s.text.bg || "transparent",
                  padding: s.text.bg ? "2px 8px" : "",
                  borderRadius: "4px",
                  textTransform: s.text.upper ? "uppercase" : "",
                  textShadow: s.text.glow
                    ? `0 0 10px ${s.text.glow}`
                    : s.text.shadow
                      ? "0 2px 6px rgba(0,0,0,.6)"
                      : "",
                  WebkitTextStroke: s.text.stroke ? `1.5px ${s.text.stroke}` : "",
                },
              },
              s.label,
            ),
          ),
        ),
      ),
      h(
        "button",
        { class: "btn primary block", type: "button", onclick: () => openCaptions() },
        icon("sparkles", 16),
        "Auto captions",
      ),
      h(
        "button",
        {
          class: "btn block",
          type: "button",
          onclick: () => {
            const i = h("input", {
              type: "file",
              accept: ".srt",
              onchange: async () => i.files[0] && A.importSrt(await i.files[0].text()),
            })
            i.click()
          },
        },
        icon("captions", 16),
        "Import captions (.srt)",
      ),
    )
  }

  function elementsPanel() {
    const sc = () => state.project.scene.height / 1080
    const shapes = [
      ["Rectangle", { type: "rect", radius: 0 }],
      ["Rounded", { type: "rect", radius: 40 }],
      ["Circle", { type: "ellipse", w: 400, h: 400 }],
      ["Bar", { type: "rect", w: 1600, h: 140, radius: 0, fill: "#000000b3" }],
    ]
    const colors = [
      "#000000",
      "#ffffff",
      "#111827",
      "#1d4ed8",
      "#16a34a",
      "#dc2626",
      "#f59e0b",
      "#9333ea",
      "#ec4899",
      "#0ea5e9",
    ]
    return h(
      "div",
      { class: "el-panel" },
      h("h4", {}, "Shapes"),
      h(
        "div",
        { class: "shape-grid" },
        shapes.map(([label, s]) =>
          h(
            "button",
            {
              class: "shape-btn",
              type: "button",
              onclick: () => {
                const k = sc()
                const shape = {
                  ...s,
                  w: (s.w || 600) * k,
                  h: (s.h || 340) * k,
                  radius: (s.radius || 0) * k,
                }
                A.addClip("shape", { shape })
              },
            },
            h("span", {
              class: "shape-ico",
              style: {
                borderRadius: s.type === "ellipse" ? "50%" : s.radius ? "8px" : "0",
                aspectRatio: `${s.w || 600}/${s.h || 340}`,
                background: s.fill || "#ffd23f",
              },
            }),
            h("small", {}, label),
          ),
        ),
      ),
      h("h4", {}, "Emoji"),
      h(
        "div",
        { class: "emoji-grid" },
        [
          "😂",
          "❤️",
          "🔥",
          "👍",
          "😍",
          "🎉",
          "😮",
          "😢",
          "👀",
          "💯",
          "✨",
          "🚀",
          "👉",
          "⭐",
          "✅",
          "❌",
          "😎",
          "🙌",
          "💡",
          "📍",
        ].map((e) =>
          h(
            "button",
            {
              class: "emoji-btn",
              type: "button",
              title: "Add " + e,
              onclick: () => {
                const c = A.addClip("text", {
                  text: {
                    content: e,
                    size: Math.round(state.project.scene.height * 0.18),
                    font: "Inter",
                    weight: 400,
                  },
                })
                commit((p) => (p.clips.find((x) => x.id === c.id).name = "Emoji " + e), {
                  coalesce: "emoji",
                })
              },
            },
            e,
          ),
        ),
      ),
      h("h4", {}, "Color backgrounds"),
      h(
        "div",
        { class: "color-grid" },
        colors.map((c) =>
          h("button", {
            class: "color-btn",
            type: "button",
            title: "Add a " + c + " background",
            style: { background: c },
            onclick: () => {
              const clip = A.addClip("color", { duration: 5 })
              commit(
                (p) => {
                  const x = p.clips.find((y) => y.id === clip.id)
                  x.color = c
                  // backgrounds go to the bottom layer
                  const li = p.layers.findIndex((l) => l.id === x.layerId)
                  if (li !== p.layers.length - 1) {
                    const bottom = p.layers[p.layers.length - 1]
                    if (
                      !p.clips.some(
                        (o) =>
                          o.id !== x.id &&
                          o.layerId === bottom.id &&
                          o.start < clipEnd(x) &&
                          clipEnd(o) > x.start,
                      )
                    )
                      x.layerId = bottom.id
                  }
                },
                { coalesce: "newcolor" },
              )
            },
          }),
        ),
      ),
    )
  }

  // --- drag & drop files anywhere --------------------------------------------------

  const dropMask = h(
    "div",
    { class: "drop-mask" },
    h("div", {}, icon("upload", 36), h("b", {}, "Drop to import")),
  )
  shell.append(dropMask)
  let dragDepth = 0
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files")
  const onEnter = (e) => {
    if (!isFiles(e)) return
    dragDepth++
    dropMask.classList.add("on")
  }
  const onLeave = (e) => {
    if (!isFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) dropMask.classList.remove("on")
  }
  const onOver = (e) => isFiles(e) && e.preventDefault()
  const onDrop = async (e) => {
    dragDepth = 0
    dropMask.classList.remove("on")
    if (!isFiles(e) || e.cutHandled) return
    e.preventDefault()
    await importAny([...e.dataTransfer.files])
  }
  shell.addEventListener("dragenter", onEnter)
  shell.addEventListener("dragleave", onLeave)
  shell.addEventListener("dragover", onOver)
  shell.addEventListener("drop", onDrop)

  // --- shortcuts -------------------------------------------------------------------

  function editPoints() {
    const s = new Set([0])
    for (const c of state.project.clips) {
      s.add(c.start)
      s.add(clipEnd(c))
    }
    for (const m of state.project.markers || []) s.add(m.t)
    return [...s].sort((a, b) => a - b)
  }

  const onKey = (e) => {
    const t = e.target
    if (t.closest?.("input, textarea, select, [contenteditable]") && !(t.type === "range")) return
    if (document.querySelector(".modal-back")) return
    const cmd = e.metaKey || e.ctrlKey
    const k = e.key
    const K = k.toLowerCase()
    let handled = true
    if (k === " " || (K === "k" && !cmd)) player.toggle()
    else if (cmd && K === "z" && !e.shiftKey) undo()
    else if ((cmd && K === "z" && e.shiftKey) || (cmd && K === "y")) redo()
    else if (cmd && K === "b") A.split()
    else if (!cmd && K === "s") A.split()
    else if (cmd && K === "d") A.duplicate()
    else if (cmd && K === "c") A.copy()
    else if (cmd && K === "x") A.cut()
    else if (cmd && K === "v") A.paste()
    else if (cmd && K === "a") A.selectAll()
    else if (cmd && K === "e") openExport(player)
    else if (cmd && K === "i") fileInput.click()
    else if (cmd && K === "s") saveNow().then(() => toast("Saved"))
    else if (cmd && K === "l") loopBtn.click()
    else if (cmd && k === "ArrowUp") selectedClip() && A.moveLayer(selectedClip(), -1)
    else if (cmd && k === "ArrowDown") selectedClip() && A.moveLayer(selectedClip(), 1)
    else if (k === "Delete" || k === "Backspace") A.remove({ ripple: e.shiftKey || cmd })
    else if (k === "ArrowLeft") seek(state.time - (e.shiftKey ? 1 : 1 / fps()))
    else if (k === "ArrowRight") seek(state.time + (e.shiftKey ? 1 : 1 / fps()))
    else if (k === "ArrowUp") {
      const p = [...editPoints()].reverse().find((x) => x < state.time - 1e-4)
      if (p != null) seek(p)
    } else if (k === "ArrowDown") {
      const p = editPoints().find((x) => x > state.time + 1e-4)
      if (p != null) seek(p)
    } else if (k === "Home") seek(0)
    else if (k === "End") seek(projectDuration(state.project))
    else if (K === "j") seek(state.time - (e.shiftKey ? 5 : 1))
    else if (K === "l") seek(state.time + (e.shiftKey ? 5 : 1))
    else if (K === "q") A.trimTo("start")
    else if (K === "w") A.trimTo("end")
    else if (k === ",") A.nudge(e.shiftKey ? -10 : -1)
    else if (k === ".") A.nudge(e.shiftKey ? 10 : 1)
    else if (K === "m") A.addMarker()
    else if (K === "t")
      A.addClip("text", {
        text: { content: "Your text", size: Math.round(96 * (state.project.scene.height / 1080)) },
      })
    else if (k === "=" || k === "+") timeline.zoomBy(1.5)
    else if (k === "-" || k === "_") timeline.zoomBy(1 / 1.5)
    else if (k === "\\") timeline.fit()
    else if (k === "?") shortcuts()
    else if (k === "Escape") select([])
    else handled = false
    if (handled) e.preventDefault()
  }
  addEventListener("keydown", onKey)

  async function screenshot() {
    const snap = player.snapshot((p) => p.scene.width, "image/png")
    snap.canvas.toBlob((b) => {
      const a = h("a", {
        href: URL.createObjectURL(b),
        download: `${state.project.name} ${fmtTime(state.time, fps()).replace(/[:.]/g, "-")}.png`,
      })
      a.click()
    }, "image/png")
  }

  return () => {
    removeEventListener("keydown", onKey)
    offs.forEach((f) => f())
    player.destroy()
    timeline.destroy()
    inspector.destroy()
    setThumbProvider(null)
    root.classList.remove("in-editor", "sheet-open", "has-sel")
  }
}

export function shortcuts() {
  const C = mod
  const groups = [
    [
      "Playback",
      [
        ["Space / K", "Play or pause"],
        ["← / →", "Previous / next frame"],
        ["⇧← / ⇧→", "Back / forward 1 second"],
        ["J / L", "Back / forward 1 second"],
        ["↑ / ↓", "Previous / next edit point"],
        ["Home / End", "Start / end"],
        [C + "L", "Loop"],
      ],
    ],
    [
      "Editing",
      [
        ["S / " + C + "B", "Split at playhead"],
        ["Q / W", "Trim start / end to playhead"],
        ["⌫", "Delete"],
        ["⇧⌫", "Ripple delete"],
        [C + "D", "Duplicate"],
        [C + "C / " + C + "X / " + C + "V", "Copy / cut / paste"],
        [C + "A", "Select all"],
        [", / .", "Nudge clip one frame"],
        [C + "↑ / " + C + "↓", "Move clip to layer above / below"],
        ["T", "Add text"],
        ["M", "Add marker"],
      ],
    ],
    [
      "Project",
      [
        [C + "Z", "Undo"],
        [isMac ? "⇧⌘Z" : "Ctrl+Y", "Redo"],
        [C + "I", "Import"],
        [C + "E", "Export"],
        [C + "S", "Save now"],
        ["+ / − / \\", "Zoom timeline in / out / fit"],
        ["⌥ drag", "Move without snapping"],
        ["?", "Shortcuts"],
      ],
    ],
  ]
  modal(
    "Keyboard shortcuts",
    h(
      "div",
      { class: "shortcuts" },
      groups.map(([title, rows]) =>
        h(
          "div",
          { class: "sc-group" },
          h("h4", {}, title),
          rows.map(([k, d]) => h("div", { class: "sc-row" }, h("span", {}, d), h("kbd", {}, k))),
        ),
      ),
    ),
    { wide: true },
  )
}

void selectedClips
void clipMenuItems
void emit
void btn
