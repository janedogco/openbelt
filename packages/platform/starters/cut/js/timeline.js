// The timeline: layers, clips with filmstrips and waveforms, the ruler and playhead.
// Drag clips to move them (across layers too), drag their edges to trim, drag the
// ruler to scrub, ⌘/Ctrl + wheel or pinch to zoom.
import { state, on, emit, commit, select, seek, layerById } from "./store.js"
import { clipEnd, allKeyTimes, projectDuration, shiftKeys } from "./model.js"
import { filmstrip, peaks, importFiles } from "./media.js"
import * as A from "./actions.js"
import { h, icon, iconBtn, menu, clamp, fmtTime, mod, confirmDialog, toast } from "./ui.js"

const LANE = 58
const RULER = 28
const KIND_ICON = {
  video: "film",
  audio: "music",
  image: "image",
  text: "text",
  shape: "shape",
  color: "palette",
}

export class Timeline {
  constructor(root, { player }) {
    this.root = root
    this.player = player
    this.clipEls = new Map()
    this.artKeys = new Map()

    this.timeLabel = h("div", { class: "tl-time" })
    this.snapBtn = iconBtn(
      "magnet",
      "Snapping",
      () => {
        state.snap = !state.snap
        this.snapBtn.classList.toggle("on", state.snap)
      },
      { class: "on" },
    )
    this.zoomRange = h("input", {
      type: "range",
      class: "zoom-range",
      min: 0,
      max: 100,
      step: 0.1,
      "aria-label": "Timeline zoom",
      oninput: () => this.setZoom(this.rangeToPps(+this.zoomRange.value)),
    })
    const bar = h(
      "div",
      { class: "tl-bar" },
      h(
        "div",
        { class: "tl-tools" },
        iconBtn("split", `Split at playhead (${mod}B)`, () => A.split()),
        iconBtn("trash", "Delete (⌫)", () => A.remove()),
        iconBtn("copy", `Duplicate (${mod}D)`, () => A.duplicate()),
        h("span", { class: "sep" }),
        this.snapBtn,
        iconBtn("layers", "Add layer", () => A.addLayer(0)),
      ),
      this.timeLabel,
      h(
        "div",
        { class: "tl-tools right" },
        iconBtn("zoomOut", "Zoom out (−)", () => this.zoomBy(1 / 1.5)),
        this.zoomRange,
        iconBtn("zoomIn", "Zoom in (+)", () => this.zoomBy(1.5)),
        iconBtn("fit", "Fit to window", () => this.fit()),
      ),
    )

    this.heads = h("div", { class: "tl-heads-inner" })
    this.rulerCanvas = h("canvas", { class: "tl-ruler" })
    this.lanes = h("div", { class: "tl-lanes" })
    this.playhead = h("div", { class: "tl-playhead" })
    this.snapLine = h("div", { class: "tl-snapline" })
    this.dropLine = h("div", { class: "tl-dropline" })
    this.content = h(
      "div",
      { class: "tl-content" },
      this.lanes,
      this.playhead,
      this.snapLine,
      this.dropLine,
    )
    this.scroll = h("div", { class: "tl-scroll" }, this.content)
    this.rulerWrap = h("div", { class: "tl-ruler-wrap" }, this.rulerCanvas)
    const corner = h("div", { class: "tl-corner" })
    this.grid = h(
      "div",
      { class: "tl-grid" },
      corner,
      this.rulerWrap,
      h("div", { class: "tl-heads" }, this.heads),
      this.scroll,
    )
    root.replaceChildren(bar, this.grid)

    this.scroll.addEventListener("scroll", () => {
      this.heads.style.transform = `translateY(${-this.scroll.scrollTop}px)`
      this.drawRuler()
    })
    this.scroll.addEventListener("wheel", (e) => this.onWheel(e), { passive: false })
    this.rulerWrap.addEventListener("wheel", (e) => this.onWheel(e), { passive: false })
    this.scroll.addEventListener("pointerdown", (e) => this.onEmptyDown(e))
    this.rulerWrap.addEventListener("pointerdown", (e) => this.scrub(e))
    this.scroll.addEventListener("contextmenu", (e) => this.onContext(e))
    this.setupDrop()
    this.setupPinch()

    this.ro = new ResizeObserver(() => {
      this.render()
      this.drawRuler()
    })
    this.ro.observe(this.scroll)
    this.offs = [
      on("project", () => this.render()),
      on("selection", () => this.renderSelection()),
      on("time", () => this.onTime()),
      on("strip", () => this.render()),
      on("fit", () => requestAnimationFrame(() => this.fit())),
    ]
    this.render()
    requestAnimationFrame(() => this.fit())
  }

  destroy() {
    this.ro.disconnect()
    this.offs.forEach((f) => f())
  }

  // --- zoom ------------------------------------------------------------------

  rangeToPps(v) {
    return 2 * Math.pow(400, v / 100)
  }
  ppsToRange(p) {
    return (Math.log(p / 2) / Math.log(400)) * 100
  }
  setZoom(pps, anchorX) {
    const old = state.pps
    pps = clamp(pps, 2, 800)
    const ax = anchorX ?? this.timeX(state.time) - this.scroll.scrollLeft
    const t = (this.scroll.scrollLeft + ax) / old
    state.pps = pps
    this.render()
    this.scroll.scrollLeft = t * pps - ax
    this.drawRuler()
  }
  zoomBy(f, anchorX) {
    this.setZoom(state.pps * f, anchorX)
  }
  fit() {
    const dur = Math.max(5, projectDuration(state.project))
    const w = this.scroll.clientWidth - 40
    if (w <= 0) return
    this.setZoom(w / dur)
    this.scroll.scrollLeft = 0
  }
  onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const r = this.scroll.getBoundingClientRect()
      this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left)
    } else if (e.currentTarget === this.rulerWrap) {
      e.preventDefault()
      this.scroll.scrollLeft += e.deltaX || e.deltaY
    }
  }
  setupPinch() {
    const pts = new Map()
    let d0 = 0
    let p0 = 0
    this.scroll.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches
        d0 = Math.abs(a.clientX - b.clientX) || 1
        p0 = state.pps
      }
    })
    this.scroll.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 2) return
        e.preventDefault()
        const [a, b] = e.touches
        const d = Math.abs(a.clientX - b.clientX) || 1
        const r = this.scroll.getBoundingClientRect()
        this.setZoom((p0 * d) / d0, (a.clientX + b.clientX) / 2 - r.left)
      },
      { passive: false },
    )
    void pts
  }

  timeX(t) {
    return t * state.pps
  }
  xTime(clientX) {
    const r = this.scroll.getBoundingClientRect()
    return Math.max(0, (clientX - r.left + this.scroll.scrollLeft) / state.pps)
  }
  laneAt(clientY) {
    const r = this.scroll.getBoundingClientRect()
    return Math.floor((clientY - r.top + this.scroll.scrollTop) / LANE)
  }

  // --- rendering ---------------------------------------------------------------

  render() {
    const p = state.project
    if (!p) return
    const dur = projectDuration(p)
    const visible = this.scroll.clientWidth || 800
    const width = Math.max(visible, (dur + Math.max(10, (300 / state.pps) * 1)) * state.pps + 200)
    this.content.style.width = width + "px"
    this.content.style.height =
      Math.max(p.layers.length * LANE + LANE, this.scroll.clientHeight) + "px"
    this.zoomRange.value = this.ppsToRange(state.pps)

    // layer heads
    this.heads.replaceChildren(
      ...p.layers.map((l, i) =>
        h(
          "div",
          {
            class: "tl-head" + (l.hidden ? " is-hidden" : "") + (l.locked ? " is-locked" : ""),
            style: { height: LANE + "px" },
          },
          h(
            "span",
            {
              class: "tl-head-name",
              title: "Double-click to rename",
              ondblclick: () => this.rename(l),
            },
            l.name,
          ),
          h(
            "div",
            { class: "tl-head-btns" },
            iconBtn(
              l.hidden ? "eyeOff" : "eye",
              l.hidden ? "Show layer" : "Hide layer",
              () => commit((p) => (layerById.call(null, l.id).hidden = !l.hidden)),
              { size: 15, class: l.hidden ? "off" : "" },
            ),
            iconBtn(
              l.muted ? "mute" : "volume",
              l.muted ? "Unmute layer" : "Mute layer",
              () => commit(() => (layerById(l.id).muted = !l.muted)),
              { size: 15, class: l.muted ? "off" : "" },
            ),
            iconBtn(
              l.locked ? "lock" : "unlock",
              l.locked ? "Unlock layer" : "Lock layer",
              () => commit(() => (layerById(l.id).locked = !l.locked)),
              { size: 15, class: l.locked ? "on" : "" },
            ),
            iconBtn("more", "Layer options", (e) => this.layerMenu(e, l, i), { size: 15 }),
          ),
        ),
      ),
    )

    // lanes
    const laneEls = p.layers.map((l, i) => {
      let el = this.lanes.children[i]
      if (!el) {
        el = h("div", { class: "lane" })
        this.lanes.append(el)
      }
      el.dataset.layer = l.id
      el.style.top = i * LANE + "px"
      el.style.height = LANE + "px"
      el.classList.toggle("is-hidden", !!l.hidden)
      el.classList.toggle("is-locked", !!l.locked)
      return el
    })
    while (this.lanes.children.length > p.layers.length) this.lanes.lastChild.remove()

    // markers
    for (const mk of this.content.querySelectorAll(".tl-marker")) mk.remove()
    for (const mk of p.markers || [])
      this.content.append(
        h("div", { class: "tl-marker", style: { left: this.timeX(mk.t) + "px" } }),
      )

    // clips
    const seen = new Set()
    for (const c of p.clips) {
      const li = p.layers.findIndex((l) => l.id === c.layerId)
      if (li < 0) continue
      seen.add(c.id)
      let el = this.clipEls.get(c.id)
      if (!el) {
        el = this.makeClipEl(c)
        this.clipEls.set(c.id, el)
      }
      if (el.parentNode !== laneEls[li]) laneEls[li].append(el)
      this.updateClipEl(el, c)
    }
    for (const [id, el] of this.clipEls) {
      if (!seen.has(id)) {
        el.remove()
        this.clipEls.delete(id)
        this.artKeys.delete(id)
      }
    }
    this.renderSelection()
    this.onTime()
    this.drawRuler()
  }

  makeClipEl(c) {
    const el = h(
      "div",
      { class: "clip", "data-id": c.id },
      h("canvas", { class: "clip-art" }),
      h("div", { class: "clip-tin" }),
      h("div", { class: "clip-tout" }),
      h(
        "div",
        { class: "clip-label" },
        icon(KIND_ICON[c.kind] || "film", 12),
        h("span", { class: "clip-name" }),
        h("span", { class: "clip-badge" }),
      ),
      h("div", { class: "clip-kfs" }),
      h("div", { class: "trim l", "data-trim": "l" }),
      h("div", { class: "trim r", "data-trim": "r" }),
    )
    el.addEventListener("pointerdown", (e) => this.onClipDown(e, c.id))
    el.addEventListener("touchmove", (e) => this.armedTouch && e.preventDefault(), {
      passive: false,
    })
    el.addEventListener("dblclick", () => emit("open-inspector"))
    return el
  }

  updateClipEl(el, c) {
    const pps = state.pps
    const x = this.timeX(c.start)
    const w = Math.max(2, c.duration * pps)
    el.style.left = x + "px"
    el.style.width = w + "px"
    el.className =
      "clip k-" +
      c.kind +
      (state.sel.has(c.id) ? " sel" : "") +
      (c.muted && c.kind === "audio" ? " muted" : "")
    const m = c.mediaId ? state.media.get(c.mediaId) : null
    if (c.mediaId && !m) el.classList.add("missing")
    el.querySelector(".clip-name").textContent =
      c.kind === "text" ? c.text.content.replace(/\n/g, " ") : c.name
    const badges = []
    if (c.speed !== 1) badges.push(c.speed + "×")
    if (c.muted && c.kind === "video") badges.push("muted")
    el.querySelector(".clip-badge").textContent = badges.join(" · ")
    const tin = el.querySelector(".clip-tin")
    const tout = el.querySelector(".clip-tout")
    const tinW = c.tin?.type !== "none" ? c.tin.dur * pps : c.fadeIn * pps
    const toutW = c.tout?.type !== "none" ? c.tout.dur * pps : c.fadeOut * pps
    tin.style.width = Math.min(w / 2, tinW) + "px"
    tout.style.width = Math.min(w / 2, toutW) + "px"
    const kfs = el.querySelector(".clip-kfs")
    const times = allKeyTimes(c)
    kfs.replaceChildren(
      ...times.map((t) =>
        h("div", {
          class: "kf",
          style: { left: t * pps + "px" },
          title: "Keyframe " + fmtTime(c.start + t, state.project.scene.fps),
          onpointerdown: (e) => {
            e.stopPropagation()
            select([c.id])
            seek(c.start + t)
          },
        }),
      ),
    )
    this.drawArt(el.querySelector(".clip-art"), c, m, w)
  }

  drawArt(canvas, c, m, w) {
    const pps = state.pps
    const strip = m && (m.kind === "video" || m.kind === "image") ? m.strip || filmstrip(m) : null
    const pk =
      m && (c.kind === "audio" || (c.kind === "video" && m.hasAudio)) ? m.peaks || peaks(m) : null
    const vis = Math.min(w, 4000)
    const key = [
      vis | 0,
      pps,
      c.in,
      c.speed,
      c.duration,
      strip?.length || 0,
      pk ? 1 : 0,
      c.kind,
      c.muted,
      c.props?.volume,
      c.text?.color,
      c.shape?.fill,
      c.color,
    ].join("|")
    if (this.artKeys.get(c.id) === key) return
    this.artKeys.set(c.id, key)
    const H = LANE - 6
    const dpr = Math.min(2, devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(vis * dpr))
    canvas.height = Math.round(H * dpr)
    canvas.style.width = vis + "px"
    const ctx = canvas.getContext("2d")
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, vis, H)
    if (c.kind === "color") {
      ctx.fillStyle = c.color
      ctx.globalAlpha = 0.85
      ctx.fillRect(0, 0, vis, H)
      return
    }
    if (c.kind === "shape") {
      ctx.fillStyle = c.shape.fill || "#888"
      ctx.globalAlpha = 0.3
      ctx.fillRect(0, 0, vis, H)
      return
    }
    if (strip && strip.length) {
      const first = strip[0].img
      const th = c.kind === "video" && pk ? H - 16 : H
      const tw = Math.max(12, (first.width / first.height) * th)
      for (let x = 0; x < vis; x += tw) {
        const st = c.in + ((x + tw / 2) / pps) * c.speed
        let best = strip[0]
        for (const s of strip) if (Math.abs(s.t - st) < Math.abs(best.t - st)) best = s
        ctx.drawImage(best.img, x, 0, tw, th)
      }
    }
    if (pk) {
      const rate = m.peaksRate
      const top = c.kind === "video" ? H - 16 : 0
      const hh = c.kind === "video" ? 16 : H
      const mid = top + hh / 2
      const vol = c.muted ? 0.15 : Math.min(2, c.props.volume ?? 1)
      ctx.fillStyle = c.kind === "video" ? "rgba(0,0,0,0.45)" : "transparent"
      ctx.fillRect(0, top, vis, hh)
      ctx.fillStyle = c.kind === "video" ? "rgba(140,230,190,0.9)" : "rgba(140,240,200,0.85)"
      for (let x = 0; x < vis; x += 2) {
        const st = c.in + (x / pps) * c.speed
        const st2 = c.in + ((x + 2) / pps) * c.speed
        let mx = 0
        for (let i = Math.floor(st * rate); i <= Math.floor(st2 * rate) && i < pk.length; i++)
          if (pk[i] > mx) mx = pk[i]
        const a = Math.min(1, mx * vol) * (hh / 2 - 1)
        ctx.fillRect(x, mid - a, 1.4, Math.max(0.6, a * 2))
      }
    }
  }

  renderSelection() {
    for (const [id, el] of this.clipEls) el.classList.toggle("sel", state.sel.has(id))
  }

  onTime() {
    const x = this.timeX(state.time)
    this.playhead.style.transform = `translateX(${x}px)`
    this.timeLabel.textContent =
      fmtTime(state.time, state.project.scene.fps) +
      " / " +
      fmtTime(projectDuration(state.project), state.project.scene.fps)
    if (state.playing) {
      const sl = this.scroll.scrollLeft
      const vw = this.scroll.clientWidth
      if (x > sl + vw - 40 || x < sl) this.scroll.scrollLeft = x - 60
    }
    this.drawRuler()
  }

  drawRuler() {
    const c = this.rulerCanvas
    const w = this.rulerWrap.clientWidth
    if (!w) return
    const dpr = Math.min(2, devicePixelRatio || 1)
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(RULER * dpr)
      c.style.width = w + "px"
      c.style.height = RULER + "px"
    }
    const ctx = c.getContext("2d")
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, RULER)
    const pps = state.pps
    const sl = this.scroll.scrollLeft
    const fps = state.project.scene.fps
    const steps = [1 / fps, 2 / fps, 5 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
    const major = steps.find((s) => s * pps >= 90) || 600
    const minor = major / (major >= 1 && major % 5 === 0 ? 5 : 2)
    const css = getComputedStyle(this.root)
    ctx.strokeStyle = css.getPropertyValue("--ruler-tick") || "#555"
    ctx.fillStyle = css.getPropertyValue("--muted") || "#999"
    ctx.font = "500 10.5px Inter, system-ui, sans-serif"
    ctx.lineWidth = 1
    const t0 = Math.floor(sl / pps / minor) * minor
    ctx.beginPath()
    for (let t = t0; t * pps - sl < w; t += minor) {
      const x = Math.round(t * pps - sl) + 0.5
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
      ctx.moveTo(x, isMajor ? 12 : 20)
      ctx.lineTo(x, RULER)
      if (isMajor) ctx.fillText(major < 1 ? fmtTime(t, fps) : fmtLabel(t), x + 4, 11)
    }
    ctx.stroke()
    // markers
    ctx.fillStyle = "#4c8dff"
    for (const mk of state.project.markers || []) {
      const x = mk.t * pps - sl
      ctx.beginPath()
      ctx.moveTo(x - 4, RULER - 8)
      ctx.lineTo(x + 4, RULER - 8)
      ctx.lineTo(x, RULER - 2)
      ctx.fill()
    }
    // playhead head
    const px = state.time * pps - sl
    ctx.fillStyle = css.getPropertyValue("--playhead") || "#ffd23f"
    ctx.beginPath()
    ctx.roundRect(px - 6, 2, 12, 14, 3)
    ctx.moveTo(px - 6, 14)
    ctx.lineTo(px, RULER)
    ctx.lineTo(px + 6, 14)
    ctx.fill()
  }

  // --- interaction --------------------------------------------------------------

  scrub(e) {
    if (e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget
    target.setPointerCapture?.(e.pointerId)
    const wasPlaying = state.playing
    if (wasPlaying) this.player.pause()
    const go = (ev) => seek(this.snapTime(this.xTime(ev.clientX), ev))
    go(e)
    const move = (ev) => go(ev)
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
      target.removeEventListener("pointercancel", up)
      if (wasPlaying) this.player.play()
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
    target.addEventListener("pointercancel", up)
  }

  snapTime(t, ev) {
    if (!state.snap || ev?.altKey) return t
    const tol = 6 / state.pps
    let best = t
    let bd = tol
    for (const c of state.project.clips)
      for (const x of [c.start, clipEnd(c)])
        if (Math.abs(x - t) < bd) {
          bd = Math.abs(x - t)
          best = x
        }
    return best
  }

  onEmptyDown(e) {
    if (e.target.closest(".clip")) return
    if (e.pointerType === "touch") {
      // Touch scrolls the timeline; a tap selects nothing and seeks.
      const x0 = e.clientX
      const y0 = e.clientY
      const up = (ev) => {
        this.scroll.removeEventListener("pointerup", up)
        if (Math.abs(ev.clientX - x0) < 6 && Math.abs(ev.clientY - y0) < 6) {
          select([])
          seek(this.xTime(ev.clientX))
        }
      }
      this.scroll.addEventListener("pointerup", up)
      return
    }
    if (!e.shiftKey) select([])
    this.scrub(e)
  }

  onClipDown(e, id) {
    if (e.button === 2) return
    e.stopPropagation()
    const p = state.project
    const clip = p.clips.find((c) => c.id === id)
    if (!clip) return
    const layer = layerById(clip.layerId)
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    if (additive) select([id], { add: true })
    else if (!state.sel.has(id)) select([id])
    if (layer?.locked) return
    const trim = e.target.dataset?.trim
    const x0 = e.clientX
    const y0 = e.clientY
    const isTouch = e.pointerType === "touch"
    const moving = trim
      ? [clip]
      : p.clips.filter((c) => state.sel.has(c.id) && !layerById(c.layerId)?.locked)
    const orig = new Map(moving.map((c) => [c.id, structuredClone(c)]))
    const origLane = p.layers.findIndex((l) => l.id === clip.layerId)
    const key = "tl-" + Date.now()
    let started = false
    let pressTimer = null
    let armed = !isTouch || !!trim
    this.armedTouch = armed && isTouch
    if (isTouch && !trim) {
      // On touch, hold briefly to drag; a quick swipe scrolls the timeline.
      pressTimer = setTimeout(() => {
        armed = true
        this.armedTouch = true
        navigator.vibrate?.(8)
        e.target.closest(".clip")?.classList.add("lifted")
      }, 260)
    }
    const others = p.clips.filter((c) => !orig.has(c.id))
    const targets = [
      0,
      state.time,
      ...others.flatMap((c) => [c.start, clipEnd(c)]),
      ...(p.markers || []).map((m) => m.t),
    ]
    const el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)

    const snapDelta = (edges, d) => {
      if (!state.snap) return { d, at: null }
      const tol = 8 / state.pps
      let best = null
      for (const edge of edges)
        for (const t of targets) {
          const diff = t - (edge + d)
          if (Math.abs(diff) < tol && (!best || Math.abs(diff) < Math.abs(best.diff)))
            best = { diff, at: t }
        }
      return best ? { d: d + best.diff, at: best.at } : { d, at: null }
    }

    const move = (ev) => {
      const dx = ev.clientX - x0
      const dy = ev.clientY - y0
      if (!started) {
        if (!armed) {
          if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
            clearTimeout(pressTimer)
            cleanup()
          }
          return
        }
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
        started = true
        document.body.classList.add("dragging")
      }
      ev.preventDefault()
      let d = dx / state.pps
      let snapAt = null
      if (trim) {
        const o = orig.get(clip.id)
        const m = clip.mediaId ? state.media.get(clip.mediaId) : null
        const bounded = m && m.kind !== "image"
        const minDur = 1 / p.scene.fps
        if (trim === "l") {
          ;({ d, at: snapAt } = ev.altKey ? { d, at: null } : snapDelta([o.start], d))
          let lo = -o.start
          if (bounded) lo = Math.max(lo, -o.in / o.speed)
          d = clamp(d, lo, o.duration - minDur)
          commit(
            (proj) => {
              const c = proj.clips.find((x) => x.id === clip.id)
              c.start = o.start + d
              c.duration = o.duration - d
              c.in = o.in + d * o.speed
              c.kf = structuredClone(o.kf)
              shiftKeys(c, d)
            },
            { coalesce: key },
          )
        } else {
          ;({ d, at: snapAt } = ev.altKey ? { d, at: null } : snapDelta([clipEnd(o)], d))
          let hi = Infinity
          if (bounded) hi = (m.duration - o.in) / o.speed - o.duration
          d = clamp(d, minDur - o.duration, hi)
          commit(
            (proj) => {
              const c = proj.clips.find((x) => x.id === clip.id)
              c.duration = o.duration + d
            },
            { coalesce: key },
          )
        }
      } else {
        const oc = orig.get(clip.id)
        ;({ d, at: snapAt } = ev.altKey ? { d, at: null } : snapDelta([oc.start, clipEnd(oc)], d))
        const minStart = Math.min(...[...orig.values()].map((c) => c.start))
        d = Math.max(d, -minStart)
        const lane = this.laneAt(ev.clientY)
        const n = p.layers.length
        let dl = clamp(lane, 0, n - 1) - origLane
        const origIdx = [...orig.values()].map((c) => p.layers.findIndex((l) => l.id === c.layerId))
        dl = clamp(dl, -Math.min(...origIdx), n - 1 - Math.max(...origIdx))
        this.newLayerAt = lane < 0 ? "top" : lane >= n ? "bottom" : null
        this.dropLine.style.display = this.newLayerAt && orig.size === 1 ? "block" : "none"
        this.dropLine.style.top = (this.newLayerAt === "top" ? 0 : n * LANE) + "px"
        commit(
          (proj) => {
            for (const [cid, o] of orig) {
              const c = proj.clips.find((x) => x.id === cid)
              c.start = Math.max(0, o.start + d)
              const li = proj.layers.findIndex((l) => l.id === o.layerId)
              c.layerId = proj.layers[clamp(li + dl, 0, proj.layers.length - 1)].id
            }
          },
          { coalesce: key },
        )
      }
      this.snapLine.style.display = snapAt == null ? "none" : "block"
      if (snapAt != null) this.snapLine.style.transform = `translateX(${this.timeX(snapAt)}px)`
      this.autoScroll(ev)
    }
    const cleanup = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", cancel)
      clearTimeout(pressTimer)
      this.armedTouch = false
      el.classList.remove("lifted")
      document.body.classList.remove("dragging")
      this.snapLine.style.display = "none"
      this.dropLine.style.display = "none"
    }
    const cancel = () => cleanup()
    const up = (ev) => {
      cleanup()
      if (!started) {
        // A click: move the playhead there too, unless it already sits on the clip.
        if (!additive && !trim && (state.time < clip.start || state.time >= clipEnd(clip)))
          seek(this.xTime(ev.clientX))
        return
      }
      if (this.newLayerAt && orig.size === 1 && !trim) {
        const where = this.newLayerAt
        commit(
          (proj) => {
            const l = {
              id: "l" + Math.random().toString(36).slice(2, 10),
              name: `Layer ${proj.layers.length + 1}`,
            }
            if (where === "top") proj.layers.unshift(l)
            else proj.layers.push(l)
            proj.clips.find((x) => x.id === clip.id).layerId = l.id
          },
          { coalesce: key },
        )
      }
      this.newLayerAt = null
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", cancel)
  }

  autoScroll(ev) {
    const r = this.scroll.getBoundingClientRect()
    if (ev.clientX > r.right - 30) this.scroll.scrollLeft += 12
    else if (ev.clientX < r.left + 30) this.scroll.scrollLeft -= 12
  }

  onContext(e) {
    const el = e.target.closest(".clip")
    e.preventDefault()
    if (!el) {
      const t = this.xTime(e.clientX)
      const layer = state.project.layers[this.laneAt(e.clientY)]
      menu(
        e.clientX,
        e.clientY,
        [
          layer
            ? { label: "Close gap", icon: "fit", onClick: () => A.closeGap(layer.id, t) }
            : null,
          { label: "Paste", icon: "copy", kbd: mod + "V", onClick: () => (seek(t), A.paste()) },
          {
            label: "Add marker",
            icon: "diamond",
            kbd: "M",
            onClick: () => (seek(t), A.addMarker()),
          },
          { label: "Add layer", icon: "layers", onClick: () => A.addLayer(0) },
        ].filter(Boolean),
      )
      return
    }
    const id = el.dataset.id
    if (!state.sel.has(id)) select([id])
    const clip = state.project.clips.find((c) => c.id === id)
    const m = clip.mediaId ? state.media.get(clip.mediaId) : null
    menu(e.clientX, e.clientY, clipMenuItems(clip, m))
  }

  layerMenu(e, l, i) {
    const r = e.currentTarget.getBoundingClientRect()
    const p = state.project
    menu(r.left, r.bottom + 4, [
      { label: "Rename", icon: "text", onClick: () => this.rename(l) },
      {
        label: "Move up",
        icon: "stepBack",
        disabled: i === 0,
        onClick: () => commit((p) => p.layers.splice(i - 1, 0, p.layers.splice(i, 1)[0])),
      },
      {
        label: "Move down",
        icon: "stepFwd",
        disabled: i === p.layers.length - 1,
        onClick: () => commit((p) => p.layers.splice(i + 1, 0, p.layers.splice(i, 1)[0])),
      },
      { label: "Add layer above", icon: "plus", onClick: () => A.addLayer(i) },
      "-",
      {
        label: "Delete layer",
        icon: "trash",
        danger: true,
        disabled: p.layers.length <= 1,
        onClick: async () => {
          const n = p.clips.filter((c) => c.layerId === l.id).length
          if (
            n &&
            !(await confirmDialog(
              "Delete layer?",
              `${l.name} and its ${n} clip${n > 1 ? "s" : ""} will be removed.`,
            ))
          )
            return
          commit((p) => {
            p.layers = p.layers.filter((x) => x.id !== l.id)
            p.clips = p.clips.filter((c) => c.layerId !== l.id)
          })
        },
      },
    ])
  }

  rename(l) {
    const head = [...this.heads.children][state.project.layers.indexOf(l)]
    const name = head?.querySelector(".tl-head-name")
    if (!name) return
    const input = h("input", { class: "tl-rename", value: l.name })
    name.replaceWith(input)
    input.focus()
    input.select()
    const done = () => {
      const v = input.value.trim()
      if (v && v !== l.name) commit(() => (layerById(l.id).name = v))
      else this.render()
    }
    input.addEventListener("blur", done)
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur()
      if (e.key === "Escape") {
        input.value = l.name
        input.blur()
      }
      e.stopPropagation()
    })
  }

  setupDrop() {
    const s = this.scroll
    s.addEventListener("dragover", (e) => {
      const types = e.dataTransfer?.types || []
      if (!types.includes("application/x-cut-media") && !types.includes("Files")) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
      const lane = this.laneAt(e.clientY)
      const n = state.project.layers.length
      this.dropLine.style.display = "block"
      this.dropLine.style.top = clamp(lane, 0, n) * LANE + (lane >= n ? 0 : LANE / 2) + "px"
      this.snapLine.style.display = "block"
      this.snapLine.style.transform = `translateX(${this.timeX(this.snapTime(this.xTime(e.clientX)))}px)`
    })
    s.addEventListener("dragleave", () => {
      this.dropLine.style.display = "none"
      this.snapLine.style.display = "none"
    })
    s.addEventListener("drop", async (e) => {
      e.preventDefault()
      e.cutHandled = true
      this.dropLine.style.display = "none"
      this.snapLine.style.display = "none"
      const t = this.snapTime(this.xTime(e.clientX))
      const lane = this.laneAt(e.clientY)
      const n = state.project.layers.length
      const layerIndex = lane >= n ? n : clamp(lane, 0, n - 1)
      const id = e.dataTransfer.getData("application/x-cut-media")
      if (id) {
        const m = state.media.get(id)
        if (m) A.addMediaClip(m, { time: t, layerIndex })
        return
      }
      if (e.dataTransfer.files?.length) {
        const list = await importFiles([...e.dataTransfer.files])
        let at = t
        for (const m of list) {
          const c = A.addMediaClip(m, { time: at, layerIndex })
          if (c) at = clipEnd(c)
        }
      }
    })
  }
}

function fmtLabel(t) {
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`
}

export function clipMenuItems(clip, m) {
  return [
    { label: "Split at playhead", icon: "split", kbd: mod + "B", onClick: () => A.split() },
    { label: "Duplicate", icon: "copy", kbd: mod + "D", onClick: () => A.duplicate() },
    { label: "Copy", icon: "copy", kbd: mod + "C", onClick: () => A.copy() },
    "-",
    {
      label: "Move to layer above",
      icon: "stepBack",
      kbd: mod + "↑",
      onClick: () => A.moveLayer(clip, -1),
    },
    {
      label: "Move to layer below",
      icon: "stepFwd",
      kbd: mod + "↓",
      onClick: () => A.moveLayer(clip, 1),
    },
    clip.kind === "video" && m?.hasAudio && !clip.muted
      ? { label: "Detach audio", icon: "unlink", onClick: () => A.detachAudio(clip) }
      : null,
    (clip.kind === "video" || clip.kind === "audio") && m?.hasAudio
      ? { label: "Remove silences", icon: "wand", onClick: () => A.removeSilence(clip) }
      : null,
    "-",
    { label: "Delete", icon: "trash", kbd: "⌫", danger: true, onClick: () => A.remove() },
    {
      label: "Ripple delete",
      icon: "trash",
      kbd: "⇧⌫",
      danger: true,
      onClick: () => A.remove({ ripple: true }),
    },
  ].filter(Boolean)
}
