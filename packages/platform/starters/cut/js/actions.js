// Editing operations, shared by the keyboard, menus, toolbars and panels.
import { state, commit, select, selectedClips, seek, emit } from "./store.js"
import { makeClip, splitClip, clipEnd, isActive, projectDuration, shiftKeys } from "./model.js"
import { uid, toast } from "./ui.js"

const fps = () => state.project.scene.fps

export function addLayer(at = 0, name) {
  return commit((p) => {
    const l = { id: uid("l"), name: name || `Layer ${p.layers.length + 1}` }
    p.layers.splice(at, 0, l)
    return l
  })
}

function layerFree(p, layerId, start, dur, ignore = new Set()) {
  return !p.clips.some(
    (c) =>
      c.layerId === layerId &&
      !ignore.has(c.id) &&
      c.start < start + dur - 1e-6 &&
      clipEnd(c) > start + 1e-6,
  )
}

// Put a clip on the first layer with room at `start`, making a layer if none has room.
function placeLayer(p, start, dur, audio) {
  const order = audio ? [...p.layers].reverse() : p.layers
  for (const l of order) if (!l.locked && layerFree(p, l.id, start, dur)) return l.id
  const l = { id: uid("l"), name: audio ? "Audio" : `Layer ${p.layers.length + 1}` }
  if (audio) p.layers.push(l)
  else p.layers.unshift(l)
  return l.id
}

export function addMediaClip(
  m,
  {
    time,
    layerIndex,
    select: doSelect = true,
    matchScene = true,
    inPoint = 0,
    outPoint = null,
  } = {},
) {
  if (!m.duration && m.kind !== "image") return toast("This file is still loading", "error")
  let resized = null
  const clip = commit((p) => {
    if (
      matchScene &&
      !p.sceneSet &&
      !p.clips.length &&
      (m.kind === "video" || m.kind === "image") &&
      m.width &&
      m.height
    ) {
      const w = Math.round(m.width / 2) * 2
      const hh = Math.round(m.height / 2) * 2
      if (w !== p.scene.width || hh !== p.scene.height) {
        resized = `${w}×${hh}`
        p.scene.width = w
        p.scene.height = hh
      }
    }
    const kind = m.kind === "image" ? "image" : m.kind === "audio" ? "audio" : "video"
    const start = Math.max(0, time ?? state.time)
    const c = makeClip(p, kind, {
      media: m,
      start,
      duration: m.kind === "image" ? 5 : (outPoint ?? m.duration) - inPoint,
    })
    c.in = m.kind === "image" ? 0 : inPoint
    if (layerIndex != null && p.layers[layerIndex]) c.layerId = p.layers[layerIndex].id
    else if (layerIndex === -1) {
      const l = { id: uid("l"), name: `Layer ${p.layers.length + 1}` }
      p.layers.unshift(l)
      c.layerId = l.id
    } else if (layerIndex >= p.layers.length) {
      const l = { id: uid("l"), name: `Layer ${p.layers.length + 1}` }
      p.layers.push(l)
      c.layerId = l.id
    } else c.layerId = placeLayer(p, start, c.duration, kind === "audio")
    p.clips.push(c)
    return c
  })
  if (resized) toast(`Canvas set to ${resized} to match ${m.name}`)
  if (doSelect) select([clip.id])
  return clip
}

// Add several media one after another on one layer (a new project's first files).
export function addSequence(list) {
  const visual = list.filter((m) => m.kind !== "audio")
  const audio = list.filter((m) => m.kind === "audio")
  let t = projectDuration(state.project)
  let first = true
  for (const m of visual) {
    const c = addMediaClip(m, { time: t, select: false, matchScene: first })
    first = false
    if (c) t = clipEnd(c)
  }
  for (const m of audio) addMediaClip(m, { time: 0, select: false })
  emit("fit")
}

export function addClip(kind, opts = {}) {
  const c = commit((p) => {
    const start = state.time
    const dur = opts.duration ?? 4
    const c = makeClip(p, kind, { start, duration: dur, ...opts })
    if (kind === "color") {
      c.layerId =
        p.layers.find((l) => layerFree(p, l.id, start, dur) && !l.locked)?.id ||
        placeLayer(p, start, dur, false)
    } else {
      // Overlays go on top.
      const top = p.layers[0]
      if (top && layerFree(p, top.id, start, dur) && !top.locked) c.layerId = top.id
      else {
        const l = { id: uid("l"), name: kind === "text" ? "Text" : `Layer ${p.layers.length + 1}` }
        p.layers.unshift(l)
        c.layerId = l.id
      }
    }
    p.clips.push(c)
    return c
  })
  select([c.id])
  return c
}

const targetClips = () => {
  const sel = selectedClips()
  if (sel.length) return sel
  return []
}

export function split() {
  const t = state.time
  let sel = targetClips().filter((c) => isActive(c, t) && !locked(c))
  if (!sel.length) sel = state.project.clips.filter((c) => isActive(c, t) && !locked(c))
  if (!sel.length) return toast("Move the playhead over a clip to split it")
  const ids = sel.map((c) => c.id)
  const right = []
  commit((p) => {
    for (const id of ids) {
      const c = p.clips.find((x) => x.id === id)
      const r = c && splitClip(p, c, t)
      if (r) right.push(r.id)
    }
  })
  if (right.length) select(right)
}

const locked = (c) => state.project.layers.find((l) => l.id === c.layerId)?.locked

export function remove({ ripple = false } = {}) {
  const sel = targetClips().filter((c) => !locked(c))
  if (!sel.length) return
  const ids = new Set(sel.map((c) => c.id))
  commit((p) => {
    if (ripple) {
      // Close the gaps: pull each remaining clip left by the deleted time before it on its layer.
      const gone = p.clips
        .filter((c) => ids.has(c.id))
        .map((c) => ({ layerId: c.layerId, end: clipEnd(c), dur: c.duration }))
      for (const o of p.clips) {
        if (ids.has(o.id)) continue
        const shift = gone
          .filter((g) => g.layerId === o.layerId && g.end <= o.start + 1e-6)
          .reduce((n, g) => n + g.dur, 0)
        o.start = Math.max(0, o.start - shift)
      }
    }
    p.clips = p.clips.filter((c) => !ids.has(c.id))
  })
  select([])
}

export function duplicate() {
  const sel = targetClips()
  if (!sel.length) return
  const out = commit((p) => {
    const ids = []
    for (const c of sel) {
      const d = structuredClone(c)
      d.id = uid("c")
      d.start = clipEnd(c)
      if (!layerFree(p, c.layerId, d.start, d.duration))
        d.layerId = placeLayer(p, d.start, d.duration, c.kind === "audio")
      p.clips.push(d)
      ids.push(d.id)
    }
    return ids
  })
  select(out)
}

let clipboard = null
let clipboardProject = null
export function copy() {
  const sel = targetClips()
  if (!sel.length) return
  const t0 = Math.min(...sel.map((c) => c.start))
  clipboard = sel.map((c) => ({ ...structuredClone(c), start: c.start - t0 }))
  clipboardProject = state.id
  toast(`Copied ${sel.length} clip${sel.length > 1 ? "s" : ""}`)
}
export function cut() {
  copy()
  remove()
}
export function paste() {
  if (!clipboard) return
  if (clipboardProject !== state.id) return toast("Copy clips in this project to paste them here")
  const out = commit((p) => {
    const ids = []
    for (const c of clipboard) {
      const d = structuredClone(c)
      d.id = uid("c")
      d.start = state.time + c.start
      if (
        !p.layers.some((l) => l.id === d.layerId) ||
        !layerFree(p, d.layerId, d.start, d.duration)
      )
        d.layerId = placeLayer(p, d.start, d.duration, d.kind === "audio")
      p.clips.push(d)
      ids.push(d.id)
    }
    return ids
  })
  select(out)
}

// Remove the empty space at time t on a layer by pulling later clips left.
export function closeGap(layerId, t) {
  const p = state.project
  const on = p.clips.filter((c) => c.layerId === layerId)
  if (on.some((c) => isActive(c, t))) return toast("There's no gap there")
  const before = on
    .filter((c) => clipEnd(c) <= t + 1e-6)
    .reduce((m, c) => Math.max(m, clipEnd(c)), 0)
  const after = on.filter((c) => c.start >= t - 1e-6)
  if (!after.length) return toast("There's no gap there")
  const gap = Math.min(...after.map((c) => c.start)) - before
  if (gap <= 1e-6) return
  commit((pp) => {
    for (const c of pp.clips) if (c.layerId === layerId && c.start >= t - 1e-6) c.start -= gap
  })
}

export function selectAll() {
  select(state.project.clips.map((c) => c.id))
}

// Q / W: trim the selected clip's start or end to the playhead.
export function trimTo(side) {
  const t = state.time
  const minLen = 1 / state.project.scene.fps
  const sel = targetClips().filter(
    (c) => isActive(c, t) && !locked(c) && t - c.start >= minLen && clipEnd(c) - t >= minLen,
  )
  if (!sel.length) return toast("Put the playhead inside a selected clip")
  commit((p) => {
    for (const s of sel) {
      const c = p.clips.find((x) => x.id === s.id)
      const lt = t - c.start
      if (side === "start") {
        c.in += lt * c.speed
        c.start = t
        c.duration -= lt
        shiftKeys(c, lt)
      } else c.duration = lt
    }
  })
}

export function detachAudio(clip) {
  const m = state.media.get(clip.mediaId)
  if (!m?.hasAudio) return
  const id = commit((p) => {
    const c = p.clips.find((x) => x.id === clip.id)
    const a = structuredClone(c)
    a.id = uid("c")
    a.kind = "audio"
    a.name = c.name + " (audio)"
    a.kf = c.kf.volume ? { volume: c.kf.volume } : {}
    a.layerId = placeLayer(p, a.start, a.duration, true)
    c.muted = true
    p.clips.push(a)
    return a.id
  })
  select([id])
  toast("Audio detached to its own layer")
}

export function moveLayer(clip, dir) {
  commit((p) => {
    const c = p.clips.find((x) => x.id === clip.id)
    const i = p.layers.findIndex((l) => l.id === c.layerId)
    const j = i + dir
    if (j < 0) {
      const l = { id: uid("l"), name: `Layer ${p.layers.length + 1}` }
      p.layers.unshift(l)
      c.layerId = l.id
    } else if (j >= p.layers.length) {
      const l = { id: uid("l"), name: `Layer ${p.layers.length + 1}` }
      p.layers.push(l)
      c.layerId = l.id
    } else c.layerId = p.layers[j].id
  })
}

export function nudge(frames) {
  const sel = targetClips().filter((c) => !locked(c))
  if (!sel.length) return seek(Math.max(0, state.time + frames / fps()))
  commit(
    (p) => {
      for (const s of sel) {
        const c = p.clips.find((x) => x.id === s.id)
        c.start = Math.max(0, c.start + frames / p.scene.fps)
      }
    },
    { coalesce: "nudge" },
  )
}

export function addMarker() {
  commit((p) => {
    p.markers ||= []
    const i = p.markers.findIndex((m) => Math.abs(m.t - state.time) < 0.5 / p.scene.fps)
    if (i >= 0) p.markers.splice(i, 1)
    else p.markers.push({ id: uid("k"), t: state.time })
  })
}

// Cut the quiet parts out of a clip and close the gaps on its layer.
export async function removeSilence(clip, { db = -38, minSilence = 0.45, pad = 0.12 } = {}) {
  const m = state.media.get(clip.mediaId)
  if (!m?.hasAudio) return toast("This clip has no audio", "error")
  const { decodeAudio } = await import("./media.js")
  const buf = await decodeAudio(m)
  const sr = buf.sampleRate
  const win = Math.round(sr * 0.03)
  const a = Math.floor(clip.in * sr)
  const b = Math.min(buf.length, Math.floor((clip.in + clip.duration * clip.speed) * sr))
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
  const thr = Math.pow(10, db / 20)
  const loud = []
  for (let i = a; i < b; i += win) {
    let sum = 0
    const n = Math.min(win, b - i)
    for (const d of chans) for (let j = i; j < i + n; j++) sum += d[j] * d[j]
    loud.push(Math.sqrt(sum / (n * chans.length)) > thr)
  }
  // keep ranges in source seconds
  const keep = []
  let runStart = null
  const step = win / sr
  for (let i = 0; i <= loud.length; i++) {
    const t = clip.in + i * step
    if (i < loud.length && loud[i]) {
      if (runStart == null) runStart = t
    } else if (runStart != null) {
      keep.push([runStart, t])
      runStart = null
    }
  }
  // merge ranges separated by short silences, then pad
  const merged = []
  for (const r of keep) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] < minSilence) last[1] = r[1]
    else merged.push([...r])
  }
  const srcEnd = clip.in + clip.duration * clip.speed
  const ranges = merged
    .map(([s, e]) => [Math.max(clip.in, s - pad), Math.min(srcEnd, e + pad)])
    .filter(([s, e]) => e - s > 0.05)
  if (!ranges.length) return toast("The whole clip is quiet", "error")
  const removed = clip.duration - ranges.reduce((n, [s, e]) => n + (e - s) / clip.speed, 0)
  if (removed < 0.1) return toast("No silences found")
  const ids = commit((p) => {
    const c = p.clips.find((x) => x.id === clip.id)
    const end = clipEnd(c)
    const idx = p.clips.indexOf(c)
    p.clips.splice(idx, 1)
    let t = c.start
    const out = []
    for (const [i, [s, e]] of ranges.entries()) {
      const piece = structuredClone(c)
      piece.id = uid("c")
      if (i > 0) {
        piece.tin = { type: "none", dur: c.tin.dur }
        piece.fadeIn = 0
      }
      if (i < ranges.length - 1) {
        piece.tout = { type: "none", dur: c.tout.dur }
        piece.fadeOut = 0
      }
      piece.in = s
      piece.duration = (e - s) / c.speed
      piece.start = t
      piece.kf = {}
      t += piece.duration
      p.clips.push(piece)
      out.push(piece.id)
    }
    const shift = end - t
    for (const o of p.clips)
      if (o.layerId === c.layerId && !out.includes(o.id) && o.start >= end - 1e-6) o.start -= shift
    return out
  })
  select(ids)
  toast(
    `Removed ${removed.toFixed(1)}s of silence in ${ranges.length - 1 || 1} cut${ranges.length > 2 ? "s" : ""}`,
  )
}

// Import an .srt file as text clips.
export function importSrt(text) {
  const blocks = text.replace(/\r/g, "").split(/\n\n+/)
  const toSec = (s) => {
    const [h, m, rest] = s.trim().split(":")
    return +h * 3600 + +m * 60 + parseFloat(rest.replace(",", "."))
  }
  const items = []
  for (const b of blocks) {
    const lines = b.split("\n").filter(Boolean)
    const ti = lines.findIndex((l) => l.includes("-->"))
    if (ti < 0) continue
    const [a, z] = lines[ti].split("-->")
    items.push({
      start: toSec(a),
      end: toSec(z),
      text: lines
        .slice(ti + 1)
        .join("\n")
        .replace(/<[^>]+>/g, ""),
    })
  }
  if (!items.length) return toast("No captions found in that file", "error")
  commit((p) => {
    const l = { id: uid("l"), name: "Captions" }
    p.layers.unshift(l)
    for (const it of items) {
      const c = makeClip(p, "text", {
        start: it.start,
        duration: Math.max(0.1, it.end - it.start),
        text: {
          content: it.text,
          font: "Inter",
          size: Math.round(p.scene.height * 0.05),
          weight: 700,
          stroke: "#000000",
          strokeWidth: Math.round(p.scene.height * 0.004),
          color: "#ffffff",
        },
      })
      c.name = it.text.slice(0, 40)
      c.layerId = l.id
      c.props.y = p.scene.height * 0.85
      p.clips.push(c)
    }
  })
  toast(`Added ${items.length} captions`)
}
