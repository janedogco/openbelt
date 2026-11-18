// The preview: keeps one media element per clip in step with the timeline clock,
// draws frames with the shared renderer, and lets you move, scale and rotate
// the selected clip on the canvas.
import { state, on, emit, commit, selectedClip, select, layerById } from "./store.js"
import { renderFrame, clipGeometry } from "./render.js"
import { isActive, srcTime, gainAt, projectDuration, setProp, hasVisual, propAt } from "./model.js"
import { mediaUrl } from "./media.js"
import { h, clamp } from "./ui.js"

export class Player {
  constructor(stage) {
    this.stage = stage
    this.canvas = h("canvas", { class: "preview" })
    this.ctx = this.canvas.getContext("2d")
    this.overlay = h("div", { class: "overlay" })
    this.guideV = h("div", { class: "guide v" })
    this.guideH = h("div", { class: "guide h" })
    this.frame = h(
      "div",
      { class: "stage-frame" },
      this.canvas,
      this.overlay,
      this.guideV,
      this.guideH,
    )
    stage.append(this.frame)
    this.els = new Map()
    this.images = new Map()
    this.dirty = true
    this.ac = null
    this.t0 = 0
    this.p0 = 0
    this.ro = new ResizeObserver(() => this.layout())
    this.ro.observe(stage)
    this.offs = [
      on("project", () => {
        this.cleanup()
        this.layout()
        this.dirty = true
      }),
      on("seek", () => {
        if (state.playing) this.restartClock()
        this.dirty = true
      }),
      on("selection", () => (this.dirty = true)),
      on("media", () => (this.dirty = true)),
    ]
    this.canvas.addEventListener("pointerdown", (e) => this.pickAt(e))
    this.overlay.addEventListener("pointerdown", (e) => this.pickAt(e))
    this.raf = requestAnimationFrame(() => this.tick())
    this.unlock = () => this.ensureAudio()
    addEventListener("pointerdown", this.unlock, { once: true })
    addEventListener("keydown", this.unlock, { once: true })
  }

  destroy() {
    removeEventListener("pointerdown", this.unlock)
    removeEventListener("keydown", this.unlock)
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.offs.forEach((f) => f())
    for (const e of this.els.values()) this.dropEl(e)
    this.els.clear()
    this.ac?.close()
  }

  ensureAudio() {
    if (!this.ac) {
      try {
        this.ac = new AudioContext({ latencyHint: "playback" })
        for (const e of this.els.values()) this.connect(e)
      } catch {}
    }
    if (this.ac?.state === "suspended") this.ac.resume()
  }

  connect(e) {
    if (e.gain || !this.ac) return
    try {
      const src = this.ac.createMediaElementSource(e.el)
      e.gain = this.ac.createGain()
      src.connect(e.gain).connect(this.ac.destination)
    } catch {}
  }

  layout() {
    const p = state.project
    if (!p) return
    const { width: W, height: H } = p.scene
    const r = this.stage.getBoundingClientRect()
    const pad = 16
    const s = Math.min((r.width - pad * 2) / W, (r.height - pad * 2) / H)
    const cw = Math.max(1, Math.floor(W * s))
    const ch = Math.max(1, Math.floor(H * s))
    this.frame.style.width = cw + "px"
    this.frame.style.height = ch + "px"
    this.display = s
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const k = Math.min(1, (cw * dpr) / W)
    const pw = Math.round(W * k)
    const ph = Math.round(H * k)
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
    }
    this.k = k
    this.dirty = true
  }

  // --- transport ---------------------------------------------------------------

  play() {
    if (state.playing) return
    this.ensureAudio()
    const dur = projectDuration(state.project)
    if (dur <= 0) return
    if (state.time >= dur - 0.01) state.time = 0
    state.playing = true
    this.restartClock()
    emit("play")
  }
  pause() {
    if (!state.playing) return
    state.playing = false
    for (const e of this.els.values()) if (!e.el.paused) e.el.pause()
    this.dirty = true
    emit("play")
  }
  toggle() {
    state.playing ? this.pause() : this.play()
  }
  restartClock() {
    this.t0 = state.time
    this.p0 = performance.now()
  }

  // --- elements ----------------------------------------------------------------

  elFor(clip, m) {
    let e = this.els.get(clip.id)
    const url = mediaUrl(m)
    if (e && e.mediaId !== m.id) {
      this.dropEl(e)
      e = null
    }
    if (!e) {
      const el = document.createElement(
        clip.kind === "audio" || m.kind === "audio" ? "audio" : "video",
      )
      el.preload = "auto"
      el.playsInline = true
      el.preservesPitch = false
      el.src = url
      el.addEventListener("seeked", () => (this.dirty = true))
      el.addEventListener("loadeddata", () => (this.dirty = true))
      e = { el, mediaId: m.id, gain: null, url }
      this.els.set(clip.id, e)
      this.connect(e)
    }
    return e
  }
  dropEl(e) {
    e.el.pause()
    e.el.removeAttribute("src")
    e.el.load()
  }
  cleanup() {
    const ids = new Set(state.project.clips.map((c) => c.id))
    for (const [id, e] of this.els) {
      const c = state.project.clips.find((x) => x.id === id)
      if (!ids.has(id) || !c || c.mediaId !== e.mediaId) {
        this.dropEl(e)
        this.els.delete(id)
      }
    }
  }
  image(m) {
    let img = this.images.get(m.id)
    if (!img) {
      img = new Image()
      img.decoding = "async"
      img.src = mediaUrl(m)
      img.onload = () => (this.dirty = true)
      this.images.set(m.id, img)
    }
    return img.complete && img.naturalWidth ? img : null
  }

  source = (clip) => {
    const m = state.media.get(clip.mediaId)
    if (!m) return null
    if (m.kind === "image") {
      const img = this.image(m)
      return img ? { img, w: img.naturalWidth, h: img.naturalHeight } : null
    }
    let e = this.els.get(clip.id)
    if (!e || e.el.readyState < 2 || !e.el.videoWidth) {
      // A freshly split clip: borrow a loaded element of the same media that's at the same moment.
      const want = srcTime(clip, state.time)
      e = null
      for (const o of this.els.values())
        if (
          o.mediaId === clip.mediaId &&
          o.el.readyState >= 2 &&
          o.el.videoWidth &&
          Math.abs(o.el.currentTime - want) < 0.15
        )
          e = o
      if (!e) return null
    }
    return { img: e.el, w: e.el.videoWidth, h: e.el.videoHeight }
  }

  // --- the loop ------------------------------------------------------------------

  tick() {
    this.raf = requestAnimationFrame(() => this.tick())
    const p = state.project
    if (!p) return
    if (state.playing) {
      let t = this.t0 + (performance.now() - this.p0) / 1000
      const dur = projectDuration(p)
      if (t >= dur) {
        if (state.loop && dur > 0) {
          t = 0
          this.t0 = 0
          this.p0 = performance.now()
          for (const e of this.els.values()) e.el.pause()
        } else {
          t = dur
          state.time = t
          this.pause()
        }
      }
      state.time = t
      emit("time")
    }
    this.sync()
    if (state.playing || this.dirty) {
      this.dirty = false
      this.draw()
    }
  }

  sync() {
    const p = state.project
    const t = state.time
    const fps = p.scene.fps
    for (const clip of p.clips) {
      if (clip.kind !== "video" && clip.kind !== "audio") continue
      const m = state.media.get(clip.mediaId)
      if (!m || m.kind === "image" || !mediaUrl(m)) continue
      const layer = layerById(clip.layerId)
      const active = isActive(clip, t)
      const upcoming = !active && clip.start > t && clip.start - t < 2
      if (!active && !upcoming) {
        const e = this.els.get(clip.id)
        if (e && !e.el.paused) e.el.pause()
        continue
      }
      const e = this.elFor(clip, m)
      const el = e.el
      if (!active) {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - clip.in) > 0.05 && !el.seeking) el.currentTime = clip.in
        continue
      }
      const target = clamp(srcTime(clip, t), 0, Math.max(0, (m.duration || 0) - 0.02))
      const audible = !layer?.muted
      const g = audible ? gainAt(clip, t - clip.start) : 0
      if (e.gain) {
        e.gain.gain.value = g
        el.muted = false
      } else {
        el.volume = clamp(g, 0, 1)
        el.muted = g === 0
      }
      if (state.playing) {
        if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed
        if (target >= (m.duration || 0) - 0.03) {
          if (!el.paused) el.pause()
        } else if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target
          el.play().catch(() => {})
        } else if (Math.abs(el.currentTime - target) > 0.25 * Math.max(1, clip.speed)) {
          el.currentTime = target
        }
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - target) > 0.5 / fps && !el.seeking)
          el.currentTime = target + 0.001
      }
    }
  }

  draw() {
    const p = state.project
    renderFrame(this.ctx, p, state.time, { getSource: this.source, media: state.media, k: this.k })
    this.drawOverlay()
  }

  // Render the current frame at a given width, for thumbnails and screenshots.
  snapshot(width = (p) => p.scene.width, type = "image/jpeg", q = 0.7) {
    const p = state.project
    const w = typeof width === "function" ? width(p) : width
    const k = w / p.scene.width
    const c = document.createElement("canvas")
    c.width = Math.round(p.scene.width * k)
    c.height = Math.round(p.scene.height * k)
    renderFrame(c.getContext("2d"), p, state.time, {
      getSource: this.source,
      media: state.media,
      k,
    })
    return { canvas: c, url: () => c.toDataURL(type, q) }
  }

  // --- on-canvas editing ---------------------------------------------------------

  drawOverlay() {
    const clip = selectedClip()
    const p = state.project
    const m = clip?.mediaId ? state.media.get(clip.mediaId) : null
    if (
      !clip ||
      !isActive(clip, state.time) ||
      !hasVisual(clip, m) ||
      layerById(clip.layerId)?.locked
    ) {
      this.overlay.replaceChildren()
      this.selBox = null
      return
    }
    const src = clip.kind === "video" || clip.kind === "image" ? this.source(clip) : null
    const g = clipGeometry(p, clip, m, src, state.time)
    const s = this.display
    if (!this.selBox) {
      this.selBox = h(
        "div",
        { class: "sel-box" },
        ["nw", "ne", "sw", "se"].map((c) => h("div", { class: "handle " + c, "data-h": c })),
        h("div", { class: "rot-arm" }),
        h("div", { class: "handle rot", "data-h": "rot" }),
      )
      this.selBox.addEventListener("pointerdown", (e) => this.startDrag(e))
      this.selBox.addEventListener("dblclick", () => emit("focus-text"))
      this.overlay.replaceChildren(this.selBox)
    }
    Object.assign(this.selBox.style, {
      width: Math.abs(g.w * s) + "px",
      height: Math.abs(g.h * s) + "px",
      transform: `translate(${g.cx * s - Math.abs(g.w * s) / 2}px, ${g.cy * s - Math.abs(g.h * s) / 2}px) rotate(${g.rot}deg)`,
    })
  }

  scenePoint(e) {
    const r = this.frame.getBoundingClientRect()
    return { x: (e.clientX - r.left) / this.display, y: (e.clientY - r.top) / this.display }
  }

  // Click on the canvas: select the topmost clip under the pointer.
  pickAt(e) {
    if (e.target !== this.canvas && e.target !== this.overlay) return
    const p = state.project
    const pt = this.scenePoint(e)
    for (const layer of p.layers) {
      if (layer.hidden || layer.locked) continue
      const clips = p.clips
        .filter((c) => c.layerId === layer.id && isActive(c, state.time))
        .sort((a, b) => b.start - a.start)
      for (const clip of clips) {
        const m = clip.mediaId ? state.media.get(clip.mediaId) : null
        if (!hasVisual(clip, m)) continue
        const src = clip.kind === "video" || clip.kind === "image" ? this.source(clip) : null
        const g = clipGeometry(p, clip, m, src, state.time)
        const a = (-g.rot * Math.PI) / 180
        const dx = pt.x - g.cx
        const dy = pt.y - g.cy
        const lx = dx * Math.cos(a) - dy * Math.sin(a)
        const ly = dx * Math.sin(a) + dy * Math.cos(a)
        if (Math.abs(lx) <= Math.abs(g.w) / 2 && Math.abs(ly) <= Math.abs(g.h) / 2) {
          select([clip.id])
          this.dirty = true
          requestAnimationFrame(() => {
            this.drawOverlay()
            if (this.selBox) this.startDrag(e, "move")
          })
          return
        }
      }
    }
    select([])
  }

  startDrag(e, forced) {
    const clip = selectedClip()
    if (!clip) return
    e.preventDefault()
    e.stopPropagation()
    const kind = forced || e.target.dataset?.h || "move"
    const p = state.project
    const lt = state.time - clip.start
    const m = clip.mediaId ? state.media.get(clip.mediaId) : null
    const src = clip.kind === "video" || clip.kind === "image" ? this.source(clip) : null
    const g0 = clipGeometry(p, clip, m, src, state.time)
    const start = this.scenePoint(e)
    const x0 = propAt(clip, "x", lt)
    const y0 = propAt(clip, "y", lt)
    const s0 = propAt(clip, "scale", lt)
    const r0 = propAt(clip, "rotation", lt)
    const d0 = Math.hypot(start.x - g0.cx, start.y - g0.cy) || 1
    const a0 = Math.atan2(start.y - g0.cy, start.x - g0.cx)
    const key = "canvas-" + kind + "-" + Date.now()
    const W = p.scene.width
    const H = p.scene.height
    const move = (ev) => {
      const pt = this.scenePoint(ev)
      commit(
        (proj) => {
          const c = proj.clips.find((x) => x.id === clip.id)
          if (!c) return
          if (kind === "move") {
            let nx = x0 + (pt.x - start.x)
            let ny = y0 + (pt.y - start.y)
            const snap = 8 / this.display
            const cx = nx + (g0.cx - x0)
            const cy = ny + (g0.cy - y0)
            let sv = false
            let sh = false
            if (!ev.altKey) {
              for (const target of [W / 2, Math.abs(g0.w) / 2, W - Math.abs(g0.w) / 2])
                if (Math.abs(cx - target) < snap) {
                  nx += target - cx
                  sv = target === W / 2
                  break
                }
              for (const target of [H / 2, Math.abs(g0.h) / 2, H - Math.abs(g0.h) / 2])
                if (Math.abs(cy - target) < snap) {
                  ny += target - cy
                  sh = target === H / 2
                  break
                }
            }
            this.guideV.classList.toggle("on", sv)
            this.guideH.classList.toggle("on", sh)
            setProp(c, "x", Math.round(nx * 10) / 10, lt, proj.scene.fps)
            setProp(c, "y", Math.round(ny * 10) / 10, lt, proj.scene.fps)
          } else if (kind === "rot") {
            let a = r0 + ((Math.atan2(pt.y - g0.cy, pt.x - g0.cx) - a0) * 180) / Math.PI
            if (ev.shiftKey) a = Math.round(a / 15) * 15
            else for (const sn of [-180, -90, 0, 90, 180]) if (Math.abs(a - sn) < 3) a = sn
            setProp(c, "rotation", Math.round(a * 10) / 10, lt, proj.scene.fps)
          } else {
            const d = Math.hypot(pt.x - g0.cx, pt.y - g0.cy)
            let ns = Math.max(0.02, (s0 * d) / d0)
            if (Math.abs(ns - 1) < 0.03) ns = 1
            setProp(c, "scale", Math.round(ns * 1000) / 1000, lt, proj.scene.fps)
          }
        },
        { coalesce: key },
      )
    }
    const up = () => {
      removeEventListener("pointermove", move)
      removeEventListener("pointerup", up)
      this.guideV.classList.remove("on")
      this.guideH.classList.remove("on")
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
  }
}
