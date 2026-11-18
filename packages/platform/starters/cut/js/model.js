// The project's data shape and the pure functions over it: defaults, keyframes,
// transitions, filters, splitting. Shared by the preview and the exporter.
import { uid, clamp } from "./ui.js"

export const SIZES = [
  { id: "16:9", label: "Landscape", sub: "16:9 · YouTube", w: 1920, h: 1080 },
  { id: "9:16", label: "Portrait", sub: "9:16 · Reels, TikTok", w: 1080, h: 1920 },
  { id: "1:1", label: "Square", sub: "1:1 · Instagram", w: 1080, h: 1080 },
  { id: "4:5", label: "Vertical", sub: "4:5 · Feed", w: 1080, h: 1350 },
  { id: "4k", label: "4K", sub: "16:9 · 3840×2160", w: 3840, h: 2160 },
  { id: "720", label: "720p", sub: "16:9 · 1280×720", w: 1280, h: 720 },
]

export function newProject(name = "Untitled", w = 1920, h = 1080) {
  const now = Date.now()
  return {
    v: 1,
    name,
    created: now,
    updated: now,
    scene: { width: w, height: h, fps: 30, background: "#000000" },
    layers: [{ id: uid("l"), name: "Layer 1" }],
    clips: [],
    markers: [],
    thumb: null,
  }
}

export const ANIM = ["x", "y", "scale", "rotation", "opacity", "volume"]

export function defaultProps(scene) {
  return {
    x: scene.width / 2,
    y: scene.height / 2,
    scale: 1,
    rotation: 0,
    opacity: 1,
    volume: 1,
    fit: "contain",
    flipH: false,
    flipV: false,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    radius: 0,
    shadow: 0,
    blend: "source-over",
    bgBlur: false,
  }
}

export const FX_DEFAULT = {
  brightness: 100,
  contrast: 100,
  saturate: 100,
  hue: 0,
  blur: 0,
  grayscale: 0,
  sepia: 0,
  invert: 0,
  temperature: 0,
  vignette: 0,
  key: false,
  keyColor: "#00ff00",
  keySim: 40,
  keySmooth: 10,
  keySpill: 50,
}

export const PRESETS = [
  { id: "none", label: "Original", fx: {} },
  { id: "vivid", label: "Vivid", fx: { contrast: 112, saturate: 145 } },
  { id: "warm", label: "Warm", fx: { temperature: 35, saturate: 110 } },
  { id: "cool", label: "Cool", fx: { temperature: -35, contrast: 105 } },
  {
    id: "cinema",
    label: "Cinema",
    fx: { contrast: 120, saturate: 85, temperature: 12, vignette: 45 },
  },
  {
    id: "teal",
    label: "Teal & Orange",
    fx: { contrast: 115, saturate: 125, hue: -8, temperature: 18 },
  },
  { id: "fade", label: "Faded", fx: { contrast: 80, brightness: 112, saturate: 75 } },
  { id: "matte", label: "Matte", fx: { contrast: 85, brightness: 105, saturate: 90, sepia: 12 } },
  { id: "vintage", label: "Vintage", fx: { sepia: 45, contrast: 110, saturate: 80, vignette: 40 } },
  { id: "sepia", label: "Sepia", fx: { sepia: 90, contrast: 105 } },
  { id: "bw", label: "B&W", fx: { grayscale: 100, contrast: 115 } },
  {
    id: "noir",
    label: "Noir",
    fx: { grayscale: 100, contrast: 150, brightness: 90, vignette: 60 },
  },
  {
    id: "dramatic",
    label: "Dramatic",
    fx: { contrast: 140, saturate: 70, brightness: 92, vignette: 35 },
  },
  { id: "bright", label: "Bright", fx: { brightness: 118, contrast: 105, saturate: 110 } },
  {
    id: "night",
    label: "Night",
    fx: { brightness: 75, temperature: -45, saturate: 80, contrast: 110 },
  },
  { id: "dream", label: "Dream", fx: { blur: 1.5, brightness: 112, saturate: 120, contrast: 90 } },
  { id: "invert", label: "Negative", fx: { invert: 100 } },
  { id: "pop", label: "Pop", fx: { saturate: 200, contrast: 125, hue: 10 } },
]

export const TRANSITIONS = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade" },
  { id: "slideLeft", label: "Slide left" },
  { id: "slideRight", label: "Slide right" },
  { id: "slideUp", label: "Slide up" },
  { id: "slideDown", label: "Slide down" },
  { id: "zoomIn", label: "Zoom in" },
  { id: "zoomOut", label: "Zoom out" },
  { id: "pop", label: "Pop" },
  { id: "rise", label: "Rise" },
  { id: "blur", label: "Blur" },
  { id: "spin", label: "Spin" },
  { id: "wipe", label: "Wipe" },
  { id: "typewriter", label: "Typewriter", textOnly: true },
]

export const FONTS = [
  "Inter",
  "Montserrat",
  "Oswald",
  "Anton",
  "Bebas Neue",
  "Poppins",
  "Playfair Display",
  "Lobster",
  "Pacifico",
  "Permanent Marker",
  "Roboto Mono",
  "Caveat",
]

export const TEXT_STYLES = [
  {
    id: "title",
    label: "Title",
    text: { font: "Montserrat", size: 120, weight: 800, color: "#ffffff", shadow: true },
  },
  {
    id: "subtitle",
    label: "Subtitle",
    text: {
      font: "Inter",
      size: 56,
      weight: 600,
      color: "#ffffff",
      bg: "#000000b3",
      pad: 18,
      radius: 10,
    },
  },
  {
    id: "caption",
    label: "Caption",
    text: {
      font: "Inter",
      size: 64,
      weight: 800,
      color: "#ffffff",
      stroke: "#000000",
      strokeWidth: 8,
      upper: true,
    },
  },
  {
    id: "neon",
    label: "Neon",
    text: { font: "Bebas Neue", size: 150, weight: 400, color: "#7df9ff", glow: "#00e5ff" },
  },
  {
    id: "label",
    label: "Label",
    text: {
      font: "Oswald",
      size: 54,
      weight: 600,
      color: "#111111",
      bg: "#ffd23f",
      pad: 20,
      radius: 6,
      upper: true,
    },
  },
  {
    id: "hand",
    label: "Handwritten",
    text: { font: "Permanent Marker", size: 96, weight: 400, color: "#ffffff", shadow: true },
  },
]

export const TEXT_DEFAULT = {
  content: "Your text",
  font: "Inter",
  size: 96,
  weight: 700,
  italic: false,
  color: "#ffffff",
  align: "center",
  bg: "",
  pad: 16,
  radius: 8,
  stroke: "",
  strokeWidth: 0,
  shadow: false,
  glow: "",
  upper: false,
  lineHeight: 1.15,
  spacing: 0,
  maxWidth: 0,
}

export function makeClip(project, kind, { media, layerId, start = 0, duration, text, shape } = {}) {
  const scene = project.scene
  const clip = {
    id: uid("c"),
    kind,
    layerId,
    start,
    duration: duration ?? 5,
    in: 0,
    speed: 1,
    name:
      media?.name ||
      (kind === "text" ? "Text" : kind === "shape" ? "Shape" : kind === "color" ? "Color" : "Clip"),
    props: defaultProps(scene),
    kf: {},
    fx: { ...FX_DEFAULT },
    preset: "none",
    tin: { type: "none", dur: 0.5 },
    tout: { type: "none", dur: 0.5 },
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
  }
  if (media) clip.mediaId = media.id
  if (kind === "text") clip.text = { ...TEXT_DEFAULT, ...(text || {}) }
  if (kind === "shape")
    clip.shape = {
      type: "rect",
      w: 600,
      h: 340,
      fill: "#ffd23f",
      stroke: "",
      strokeWidth: 0,
      radius: 24,
      ...(shape || {}),
    }
  if (kind === "color") clip.color = "#1d4ed8"
  return clip
}

// --- time ------------------------------------------------------------------

export const clipEnd = (c) => c.start + c.duration
export const projectDuration = (p) => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
export const isActive = (c, t) => t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6
export const srcTime = (c, t) => c.in + (t - c.start) * c.speed
export const hasVisual = (c, media) =>
  c.kind === "text" ||
  c.kind === "shape" ||
  c.kind === "color" ||
  c.kind === "image" ||
  (c.kind === "video" && media?.kind === "video")
export const hasAudio = (c, media) =>
  (c.kind === "video" || c.kind === "audio") &&
  media &&
  media.hasAudio !== false &&
  media.kind !== "image"

// --- keyframes ---------------------------------------------------------------

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

export function propAt(clip, prop, lt) {
  const ks = clip.kf?.[prop]
  if (!ks || !ks.length) return clip.props[prop]
  if (lt <= ks[0].t) return ks[0].v
  const last = ks[ks.length - 1]
  if (lt >= last.t) return last.v
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]
    const b = ks[i + 1]
    if (lt >= a.t && lt <= b.t) {
      const p = (lt - a.t) / (b.t - a.t || 1)
      const e = b.ease === "linear" ? p : b.ease === "hold" ? 0 : ease(p)
      return a.v + (b.v - a.v) * e
    }
  }
  return last.v
}

export function keyAt(clip, prop, lt, fps = 30) {
  const tol = 0.5 / fps
  return (clip.kf?.[prop] || []).findIndex((k) => Math.abs(k.t - lt) <= tol)
}

export function setKey(clip, prop, lt, v, fps = 30) {
  clip.kf ||= {}
  const ks = (clip.kf[prop] ||= [])
  const i = keyAt(clip, prop, lt, fps)
  if (i >= 0) ks[i].v = v
  else {
    ks.push({ t: lt, v, ease: "ease" })
    ks.sort((a, b) => a.t - b.t)
  }
}

export function removeKey(clip, prop, lt, fps = 30) {
  const i = keyAt(clip, prop, lt, fps)
  if (i >= 0) clip.kf[prop].splice(i, 1)
  if (clip.kf[prop] && !clip.kf[prop].length) delete clip.kf[prop]
}

// Set a property; with keyframes on it, set the key at the playhead instead.
export function setProp(clip, prop, v, lt, fps) {
  if (ANIM.includes(prop) && clip.kf?.[prop]?.length)
    setKey(clip, prop, clamp(lt, 0, clip.duration), v, fps)
  else clip.props[prop] = v
}

export function allKeyTimes(clip) {
  const s = new Set()
  for (const ks of Object.values(clip.kf || {}))
    for (const k of ks)
      if (k.t >= -1e-6 && k.t <= clip.duration + 1e-6) s.add(Math.round(k.t * 1000) / 1000)
  return [...s].sort((a, b) => a - b)
}

// Shift keyframes left by d seconds (after a trim of the start), dropping those outside.
export function shiftKeys(clip, d) {
  for (const [p, ks] of Object.entries(clip.kf || {})) {
    for (const k of ks) k.t -= d
  }
}

export function splitClip(project, clip, t) {
  const lt = t - clip.start
  if (lt <= 0.02 || lt >= clip.duration - 0.02) return null
  const right = structuredClone(clip)
  right.id = uid("c")
  right.start = t
  right.duration = clip.duration - lt
  right.in = clip.in + lt * clip.speed
  right.tin = { type: "none", dur: clip.tin.dur }
  right.fadeIn = 0
  clip.duration = lt
  clip.tout = { type: "none", dur: clip.tout.dur }
  clip.fadeOut = 0
  // Both halves keep every key (shifted for the right one), so the motion carries on across the cut.
  shiftKeys(right, lt)
  project.clips.splice(project.clips.indexOf(clip) + 1, 0, right)
  return right
}

// --- transitions -------------------------------------------------------------

const easeOut = (p) => 1 - Math.pow(1 - p, 3)
const back = (p) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
}

// Returns modifiers for a clip at local time lt: { dx, dy, scale, rot, alpha, blur, wipe, chars }
export function transitionAt(clip, lt, scene) {
  const m = { dx: 0, dy: 0, scale: 1, rot: 0, alpha: 1, blur: 0, wipe: 1, chars: 1 }
  const apply = (type, p, dir) => {
    if (type === "none" || p >= 1) return
    const e = easeOut(clamp(p, 0, 1))
    switch (type) {
      case "fade":
        m.alpha *= e
        break
      case "slideLeft":
        m.dx += dir * (1 - e) * scene.width
        break
      case "slideRight":
        m.dx -= dir * (1 - e) * scene.width
        break
      case "slideUp":
        m.dy += dir * (1 - e) * scene.height
        break
      case "slideDown":
        m.dy -= dir * (1 - e) * scene.height
        break
      case "zoomIn":
        m.scale *= 0.4 + 0.6 * e
        m.alpha *= e
        break
      case "zoomOut":
        m.scale *= 1.8 - 0.8 * e
        m.alpha *= e
        break
      case "pop":
        m.scale *= Math.max(0, back(clamp(p, 0, 1)))
        break
      case "rise":
        m.dy += (1 - e) * scene.height * 0.15
        m.alpha *= e
        break
      case "blur":
        m.blur += (1 - e) * 30
        m.alpha *= e
        break
      case "spin":
        m.rot += (1 - e) * 180 * dir
        m.scale *= e
        break
      case "wipe":
        m.wipe = Math.min(m.wipe, e)
        break
      case "typewriter":
        m.chars = Math.min(m.chars, clamp(p, 0, 1))
        break
    }
  }
  const tin = clip.tin || { type: "none" }
  const tout = clip.tout || { type: "none" }
  if (tin.type !== "none" && tin.dur > 0 && lt < tin.dur) apply(tin.type, lt / tin.dur, 1)
  const rem = clip.duration - lt
  if (tout.type !== "none" && tout.dur > 0 && rem < tout.dur) apply(tout.type, rem / tout.dur, -1)
  return m
}

export function gainAt(clip, lt) {
  if (clip.muted) return 0
  let g = propAt(clip, "volume", lt)
  if (clip.fadeIn > 0 && lt < clip.fadeIn) g *= lt / clip.fadeIn
  const rem = clip.duration - lt
  if (clip.fadeOut > 0 && rem < clip.fadeOut) g *= Math.max(0, rem / clip.fadeOut)
  return Math.max(0, g)
}

// --- filters -----------------------------------------------------------------

export function cssFilter(fx, extraBlur = 0, k = 1) {
  const f = []
  if (fx.brightness !== 100) f.push(`brightness(${fx.brightness}%)`)
  if (fx.contrast !== 100) f.push(`contrast(${fx.contrast}%)`)
  if (fx.saturate !== 100) f.push(`saturate(${fx.saturate}%)`)
  if (fx.hue) f.push(`hue-rotate(${fx.hue}deg)`)
  if (fx.grayscale) f.push(`grayscale(${fx.grayscale}%)`)
  if (fx.sepia) f.push(`sepia(${fx.sepia}%)`)
  if (fx.invert) f.push(`invert(${fx.invert}%)`)
  const b = (fx.blur || 0) * 4 + extraBlur
  if (b > 0) f.push(`blur(${(b * k).toFixed(2)}px)`)
  return f.length ? f.join(" ") : "none"
}

export function presetFx(id) {
  const p = PRESETS.find((x) => x.id === id)
  return { ...FX_DEFAULT, ...(p?.fx || {}) }
}
