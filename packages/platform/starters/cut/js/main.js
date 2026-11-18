// Routing between the projects screen and the editor (?p=<project id>).
import { db, files } from "/sdk.js"
import { state, projects, mediaCol, saveNow, emit } from "./store.js"
import { loadMedia, importFiles, kindOf } from "./media.js"
import { openEditor } from "./editor.js"
import { newProject, SIZES } from "./model.js"
import * as A from "./actions.js"
import {
  h,
  icon,
  iconBtn,
  btn,
  menu,
  modal,
  toast,
  ago,
  fmtDur,
  uid,
  confirmDialog,
  busy,
  ratioBox,
} from "./ui.js"
import { projectDuration } from "./model.js"

const root = document.getElementById("app")
let closeEditor = null

function route() {
  const id = new URLSearchParams(location.search).get("p")
  if (id) showEditor(id)
  else showHome()
}
addEventListener("popstate", route)

function go(id) {
  const url = new URL(location.href)
  if (id) url.searchParams.set("p", id)
  else url.searchParams.delete("p")
  history.pushState(null, "", url)
  // The prompt this app was built from (the starter page's "Built from" reads the same <pre>).
  function showPrompt() {
    const dlg = document.getElementById("prompt-dlg")
    const copy = dlg.querySelector(".copy")
    dlg.querySelector(".close").onclick = () => dlg.close()
    dlg.onclick = (e) => e.target === dlg && dlg.close()
    copy.onclick = async () => {
      await navigator.clipboard.writeText(dlg.querySelector("pre").textContent.trim())
      copy.textContent = "Copied"
      setTimeout(() => (copy.textContent = "Copy"), 1500)
    }
    dlg.showModal()
  }

  route()
}

async function leaveEditor() {
  if (state.project) await saveNow().catch(() => {})
  closeEditor?.()
}

async function showEditor(id, then) {
  await leaveEditor()
  closeEditor = null
  root.replaceChildren(h("div", { class: "loading-screen" }, h("div", { class: "spinner" })))
  try {
    const doc = await projects.get(id)
    if (!doc) {
      toast("That project doesn't exist any more", "error")
      return go(null)
    }
    state.id = id
    state.project = migrate(doc.data)
    state.sel.clear()
    state.time = 0
    state.playing = false
    state.save = "saved"
    await loadMedia(id)
    document.title = state.project.name + " · Cut"
    closeEditor = openEditor(root, { onHome: () => go(null) })
    then?.()
  } catch (e) {
    console.error(e)
    root.replaceChildren(
      h(
        "div",
        { class: "loading-screen" },
        h("p", {}, "Couldn't open this project: " + e.message),
        btn("All projects", () => go(null)),
      ),
    )
  }
}

function migrate(p) {
  p.markers ||= []
  for (const c of p.clips) {
    c.kf ||= {}
    c.fx ||= {}
    c.tin ||= { type: "none", dur: 0.5 }
    c.tout ||= { type: "none", dur: 0.5 }
  }
  return p
}

async function createProject(name, w, h_, files) {
  const id = uid("p")
  const p = newProject(name, w, h_)
  p.sceneSet = !files?.length
  await projects.set(id, p)
  history.pushState(null, "", "?p=" + id)
  await showEditor(id, async () => {
    if (files?.length) {
      const list = await importFiles(files, id)
      if (list.length) A.addSequence(list)
    }
  })
}

async function showHome() {
  await leaveEditor()
  closeEditor = null
  state.id = null
  state.project = null
  document.title = "Cut"
  const grid = h("div", { class: "proj-grid" })
  const fileIn = h("input", {
    type: "file",
    multiple: true,
    accept: "video/*,audio/*,image/*,.mov,.mkv",
    hidden: true,
    onchange: () => startWith([...fileIn.files]),
  })
  const newBtn = h(
    "button",
    { class: "btn primary", type: "button", onclick: () => newDialog() },
    icon("plus", 16),
    "New project",
  )
  const promptBtn = h(
    "button",
    { class: "btn", type: "button", id: "prompt-btn", onclick: () => showPrompt() },
    "Prompt",
  )
  const hero = h(
    "button",
    { class: "hero-drop", type: "button", onclick: () => fileIn.click() },
    h("div", { class: "hero-icon" }, icon("upload", 30)),
    h("b", {}, "Drop a video to start editing"),
    h("span", {}, "or click to choose files. Everything stays in your workspace."),
  )
  const page = h(
    "div",
    { class: "home" },
    h(
      "header",
      { class: "home-top" },
      h("div", { class: "logo" }, h("span", { class: "logo-mark" }, icon("split", 18)), "Cut"),
      h("div", { class: "grow" }),
      promptBtn,
      newBtn,
    ),
    h(
      "main",
      { class: "home-main" },
      hero,
      h(
        "div",
        { class: "size-row" },
        SIZES.slice(0, 4).map((s) => sizeCard(s)),
      ),
      h("h2", { class: "home-h" }, "Projects"),
      grid,
    ),
    fileIn,
  )
  root.replaceChildren(page)

  function sizeCard(s) {
    return h(
      "button",
      {
        class: "size-card",
        type: "button",
        onclick: (e) => busy(e.currentTarget, () => createProject("Untitled", s.w, s.h)),
      },
      h("span", { class: "ratio-wrap" }, ratioBox(s.w, s.h)),
      h("span", {}, h("b", {}, s.label), h("small", {}, s.sub)),
    )
  }

  function startWith(list) {
    const media = list.filter(kindOf)
    if (!media.length) return toast("Drop a video, audio or image file", "error")
    const name = media[0].name.replace(/\.[^.]+$/, "")
    createProject(name, 1920, 1080, media)
  }

  // drop anywhere on the home page
  page.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) {
      e.preventDefault()
      hero.classList.add("over")
    }
  })
  page.addEventListener("dragleave", (e) => {
    if (e.target === page || !page.contains(e.relatedTarget)) hero.classList.remove("over")
  })
  page.addEventListener("drop", (e) => {
    e.preventDefault()
    hero.classList.remove("over")
    if (e.dataTransfer.files?.length) startWith([...e.dataTransfer.files])
  })

  grid.replaceChildren(h("div", { class: "spinner small" }))
  let docs = []
  try {
    let cursor = null
    do {
      const pg = await projects.list({ limit: 200, cursor })
      docs.push(...pg.docs)
      cursor = pg.cursor
    } while (cursor && docs.length < 1000)
  } catch (e) {
    grid.replaceChildren(h("p", { class: "muted" }, "Couldn't load projects: " + e.message))
    return
  }
  docs.sort((a, b) => (b.data.updated || 0) - (a.data.updated || 0))
  if (!docs.length) {
    grid.replaceChildren(h("p", { class: "muted empty" }, "No projects yet"))
    return
  }
  grid.replaceChildren(
    ...docs.map((d) => {
      const p = d.data
      const card = h(
        "div",
        {
          class: "proj-card",
          tabindex: 0,
          role: "link",
          onclick: () => go(d.id),
          onkeydown: (e) => e.key === "Enter" && go(d.id),
        },
        h(
          "div",
          { class: "proj-thumb" },
          p.thumb
            ? h("img", { src: p.thumb, alt: "" })
            : h("div", { class: "proj-empty" }, icon("film", 28)),
          h("span", { class: "mdur" }, fmtDur(projectDuration(p))),
        ),
        h(
          "div",
          { class: "proj-meta" },
          h(
            "div",
            {},
            h("b", {}, p.name),
            h("small", {}, `${p.scene.width}×${p.scene.height} · ${ago(p.updated || d.updated)}`),
          ),
          iconBtn("more", "Project options", (e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            menu(r.left - 140, r.bottom + 4, [
              { label: "Open", icon: "folder", onClick: () => go(d.id) },
              { label: "Rename", icon: "text", onClick: () => rename(d) },
              { label: "Duplicate", icon: "copy", onClick: () => duplicate(d) },
              "-",
              { label: "Delete", icon: "trash", danger: true, onClick: () => remove(d) },
            ])
          }),
        ),
      )
      return card
    }),
  )

  async function rename(d) {
    const input = h("input", { class: "text-in", value: d.data.name })
    const m = modal(
      "Rename project",
      h(
        "form",
        {
          class: "stack",
          onsubmit: async (e) => {
            e.preventDefault()
            await projects.update(d.id, { name: input.value.trim() || "Untitled" })
            m.close()
            showHome()
          },
        },
        input,
        h(
          "div",
          { class: "row end" },
          h("button", { class: "btn primary", type: "submit" }, "Save"),
        ),
      ),
    )
    input.focus()
    input.select()
  }

  async function duplicate(d) {
    const id = uid("p")
    const media = await allMedia()
    const mine = media.filter((m) => m.data.project === d.id)
    const map = new Map()
    for (const m of mine) {
      const nid = uid("m")
      map.set(m.id, nid)
      await mediaCol.set(nid, { ...m.data, project: id })
    }
    const p = structuredClone(d.data)
    p.name = p.name + " copy"
    p.updated = Date.now()
    for (const c of p.clips) if (c.mediaId) c.mediaId = map.get(c.mediaId) || c.mediaId
    await projects.set(id, p)
    toast("Project duplicated")
    showHome()
  }

  async function remove(d) {
    if (
      !(await confirmDialog(
        "Delete project?",
        `${d.data.name} and its media will be deleted for good.`,
      ))
    )
      return
    const media = await allMedia()
    const mine = media.filter((m) => m.data.project === d.id)
    const others = new Set(media.filter((m) => m.data.project !== d.id).map((m) => m.data.file?.id))
    for (const m of mine) {
      await mediaCol.delete(m.id).catch(() => {})
      if (m.data.file?.id && !others.has(m.data.file.id))
        await files.delete(m.data.file.id).catch(() => {})
    }
    await projects.delete(d.id)
    toast("Project deleted")
    showHome()
  }
}

async function allMedia() {
  const out = []
  let cursor = null
  do {
    const pg = await mediaCol.list({ limit: 1000, cursor })
    out.push(...pg.docs)
    cursor = pg.cursor
  } while (cursor)
  return out
}

function newDialog() {
  const m = modal(
    "New project",
    h(
      "div",
      { class: "new-grid" },
      SIZES.map((s) =>
        h(
          "button",
          {
            class: "size-card",
            type: "button",
            onclick: (e) =>
              busy(e.currentTarget, async () => {
                await createProject("Untitled", s.w, s.h)
                m.close()
              }),
          },
          h("span", { class: "ratio-wrap" }, ratioBox(s.w, s.h)),
          h("span", {}, h("b", {}, s.label), h("small", {}, s.sub)),
        ),
      ),
    ),
    { wide: true },
  )
}

route()
void db
void saveNow
void emit
