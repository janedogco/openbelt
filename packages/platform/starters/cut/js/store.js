// Editor state, undo history, events and autosave to OpenBelt.
import { db } from "/sdk.js"
import { toast } from "./ui.js"

export const projects = db.collection("projects")
export const mediaCol = db.collection("media")

export const state = {
  id: null,
  project: null,
  media: new Map(), // id → runtime media record
  sel: new Set(), // selected clip ids
  time: 0,
  playing: false,
  loop: false,
  snap: true,
  pps: 80, // timeline pixels per second
  save: "saved",
}

const listeners = new Map()
export function on(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set())
  listeners.get(ev).add(fn)
  return () => listeners.get(ev).delete(fn)
}
export function emit(ev, ...args) {
  for (const fn of listeners.get(ev) || []) fn(...args)
}

// --- history -----------------------------------------------------------------

let undoStack = []
let redoStack = []
let lastKey = null
let lastAt = 0

export function resetHistory() {
  undoStack = []
  redoStack = []
  lastKey = null
}

// Change the project. Calls with the same `coalesce` key within 1.2s share one undo step
// (a slider drag, a nudge).
export function commit(fn, { coalesce = null } = {}) {
  const before = JSON.stringify(state.project)
  const result = fn(state.project)
  const now = performance.now()
  if (!(coalesce && coalesce === lastKey && now - lastAt < 1200)) {
    undoStack.push(before)
    if (undoStack.length > 200) undoStack.shift()
  }
  lastKey = coalesce
  lastAt = now
  redoStack = []
  changed()
  return result
}

export const canUndo = () => undoStack.length > 0
export const canRedo = () => redoStack.length > 0

export function undo() {
  if (!undoStack.length) return
  redoStack.push(JSON.stringify(state.project))
  state.project = JSON.parse(undoStack.pop())
  lastKey = null
  pruneSelection()
  changed()
}
export function redo() {
  if (!redoStack.length) return
  undoStack.push(JSON.stringify(state.project))
  state.project = JSON.parse(redoStack.pop())
  lastKey = null
  pruneSelection()
  changed()
}

function pruneSelection() {
  const ids = new Set(state.project.clips.map((c) => c.id))
  for (const id of [...state.sel]) if (!ids.has(id)) state.sel.delete(id)
  emit("selection")
}

function changed() {
  state.project.updated = Date.now()
  scheduleSave()
  emit("project")
}

// --- selection & time ----------------------------------------------------------

export function select(ids, { add = false } = {}) {
  if (!add) state.sel.clear()
  for (const id of ids) {
    if (add && state.sel.has(id)) state.sel.delete(id)
    else state.sel.add(id)
  }
  emit("selection")
}
export const selectedClips = () => state.project.clips.filter((c) => state.sel.has(c.id))
export const selectedClip = () =>
  state.sel.size === 1 ? state.project.clips.find((c) => state.sel.has(c.id)) : null
export const clipById = (id) => state.project.clips.find((c) => c.id === id)
export const layerById = (id) => state.project.layers.find((l) => l.id === id)

export function seek(t) {
  state.time = Math.max(0, t)
  emit("seek")
  emit("time")
}

// --- autosave ------------------------------------------------------------------

let saveTimer = null
let saving = Promise.resolve()
export let thumbProvider = null
export const setThumbProvider = (fn) => (thumbProvider = fn)
let lastThumb = 0

function setSave(s) {
  state.save = s
  emit("save")
}

export function scheduleSave() {
  setSave("dirty")
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 700)
}

export function saveNow() {
  clearTimeout(saveTimer)
  if (!state.project || !state.id) return saving
  saving = saving.then(async () => {
    if (state.save !== "dirty" && state.save !== "error") return
    setSave("saving")
    try {
      if (thumbProvider && Date.now() - lastThumb > 8000) {
        lastThumb = Date.now()
        const t = await thumbProvider()
        if (t) state.project.thumb = t
      }
      const id = state.id
      await projects.set(id, state.project)
      if (state.id === id && state.save === "saving") setSave("saved")
    } catch (e) {
      setSave("error")
      toast("Couldn't save: " + e.message, "error")
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        setSave("dirty")
        saveNow()
      }, 4000)
    }
  })
  return saving
}

addEventListener("beforeunload", (e) => {
  const uploading = [...state.media.values()].some((m) => m.status === "uploading")
  if (uploading || state.save === "dirty" || state.save === "saving" || state.save === "error") {
    saveNow()
    e.preventDefault()
  }
})
