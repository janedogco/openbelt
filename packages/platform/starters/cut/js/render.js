// Draw one frame of the project at time t. The same code draws the preview and
// every exported frame, so what you see is what you export.
import { isActive, propAt, transitionAt, cssFilter, hasVisual } from "./model.js"

// ctx: a 2D context whose canvas is k × the scene size.
// getSource(clip) → { img, w, h } | null for media clips (video frame, image).
export function renderFrame(ctx, project, t, { getSource, media, k = 1, background = true }) {
  const { scene } = project
  ctx.setTransform(k, 0, 0, k, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = "source-over"
  ctx.filter = "none"
  if (background) {
    ctx.fillStyle = scene.background || "#000"
    ctx.fillRect(0, 0, scene.width, scene.height)
  } else ctx.clearRect(0, 0, scene.width, scene.height)

  for (let li = project.layers.length - 1; li >= 0; li--) {
    const layer = project.layers[li]
    if (layer.hidden) continue
    const clips = project.clips
      .filter((c) => c.layerId === layer.id && isActive(c, t))
      .sort((a, b) => a.start - b.start)
    for (const clip of clips) {
      const m = clip.mediaId ? media.get(clip.mediaId) : null
      if (!hasVisual(clip, m)) continue
      drawClip(ctx, project, clip, m, t, getSource, k)
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

const measureCtx = new OffscreenCanvas(4, 4).getContext("2d")

export function textFont(tx) {
  return `${tx.italic ? "italic " : ""}${tx.weight} ${tx.size}px "${tx.font}", Inter, system-ui, sans-serif`
}

function textLayout(tx, ctx = measureCtx) {
  ctx.font = textFont(tx)
  ctx.letterSpacing = (tx.spacing || 0) + "px"
  const content = tx.upper ? tx.content.toUpperCase() : tx.content
  const lines = []
  for (const para of content.split("\n")) {
    if (!(tx.maxWidth > 0)) {
      lines.push(para)
      continue
    }
    let line = ""
    for (const word of para.split(/\s+/)) {
      const next = line ? line + " " + word : word
      if (line && ctx.measureText(next).width > tx.maxWidth) {
        lines.push(line)
        line = word
      } else line = next
    }
    lines.push(line)
  }
  const widths = lines.map((l) => ctx.measureText(l).width)
  const tw = Math.max(1, ...widths)
  const lh = tx.size * (tx.lineHeight || 1.15)
  const th = lines.length * lh
  const pad = tx.bg ? tx.pad || 0 : 0
  return { lines, widths, tw, th, lh, w: tw + pad * 2, h: th + pad * 2, pad }
}

// The clip's untransformed box in scene px and how to draw its content into it.
export function clipBox(project, clip, m, src) {
  const { scene } = project
  if (clip.kind === "text") {
    const L = textLayout(clip.text)
    return { w: L.w, h: L.h, L }
  }
  if (clip.kind === "shape") return { w: clip.shape.w, h: clip.shape.h }
  if (clip.kind === "color") return { w: scene.width, h: scene.height }
  const nw = src?.w || m?.width || scene.width
  const nh = src?.h || m?.height || scene.height
  const c = clip.props.crop || { l: 0, t: 0, r: 0, b: 0 }
  const sw = nw * (1 - c.l - c.r)
  const sh = nh * (1 - c.t - c.b)
  const fit = clip.props.fit
  let w = sw
  let h = sh
  if (fit === "contain" || fit === "cover") {
    const f =
      fit === "contain"
        ? Math.min(scene.width / sw, scene.height / sh)
        : Math.max(scene.width / sw, scene.height / sh)
    w = sw * f
    h = sh * f
  } else if (fit === "fill") {
    w = scene.width
    h = scene.height
  }
  return { w, h, sx: c.l * nw, sy: c.t * nh, sw, sh }
}

// Where a clip sits on screen at time t: center, scaled size, rotation (deg).
export function clipGeometry(project, clip, m, src, t) {
  const lt = t - clip.start
  const tr = transitionAt(clip, lt, project.scene)
  const box = clipBox(project, clip, m, src)
  const s = propAt(clip, "scale", lt) * tr.scale
  return {
    cx: propAt(clip, "x", lt) + tr.dx,
    cy: propAt(clip, "y", lt) + tr.dy,
    w: box.w * s,
    h: box.h * s,
    rot: propAt(clip, "rotation", lt) + tr.rot,
    box,
    s,
    tr,
  }
}

function drawClip(ctx, project, clip, m, t, getSource, k) {
  const lt = t - clip.start
  const src = clip.kind === "video" || clip.kind === "image" ? getSource(clip) : null
  if ((clip.kind === "video" || clip.kind === "image") && !src) return
  const g = clipGeometry(project, clip, m, src, t)
  const { box, tr } = g
  const alpha = propAt(clip, "opacity", lt) * tr.alpha
  if (alpha <= 0.001 || g.s <= 0.0001) return
  const p = clip.props
  if (p.bgBlur && src) {
    // Fill the frame behind the clip with a blurred, zoomed copy of it.
    const { width: W, height: H } = project.scene
    const f = Math.max(W / box.sw, H / box.sh) * 1.1
    ctx.save()
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.filter = `blur(${Math.round(Math.max(W, H) * 0.03 * k)}px) brightness(80%)`
    ctx.drawImage(
      src.img,
      box.sx,
      box.sy,
      box.sw,
      box.sh,
      W / 2 - (box.sw * f) / 2,
      H / 2 - (box.sh * f) / 2,
      box.sw * f,
      box.sh * f,
    )
    ctx.restore()
  }
  ctx.save()
  ctx.globalAlpha = Math.min(1, alpha)
  ctx.globalCompositeOperation = p.blend || "source-over"
  ctx.translate(g.cx, g.cy)
  ctx.rotate((g.rot * Math.PI) / 180)
  ctx.scale(g.s * (p.flipH ? -1 : 1), g.s * (p.flipV ? -1 : 1))
  const w = box.w
  const h = box.h
  const r = Math.min(p.radius || 0, w / 2, h / 2)
  const needClip = r > 0 || tr.wipe < 1
  const fx = clip.fx || {}
  ctx.filter = cssFilter(fx, tr.blur, k)

  if (p.shadow > 0) {
    if (needClip) {
      ctx.save()
      ctx.shadowColor = "rgba(0,0,0,0.6)"
      ctx.shadowBlur = p.shadow * k * g.s
      ctx.shadowOffsetY = p.shadow * 0.3 * k * g.s
      ctx.fillStyle = "#000"
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w * tr.wipe, h, r)
      ctx.fill()
      ctx.restore()
    } else {
      ctx.shadowColor = "rgba(0,0,0,0.6)"
      ctx.shadowBlur = p.shadow * k * g.s
      ctx.shadowOffsetY = p.shadow * 0.3 * k * g.s
    }
  }
  if (needClip) {
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w * tr.wipe, h, r)
    ctx.clip()
  }

  if (clip.kind === "video" || clip.kind === "image") {
    if (fx.key) {
      const keyed = chromaKey(
        clip.id,
        src.img,
        box,
        Math.abs(w * g.s * k),
        Math.abs(h * g.s * k),
        fx,
      )
      ctx.drawImage(keyed, -w / 2, -h / 2, w, h)
    } else ctx.drawImage(src.img, box.sx, box.sy, box.sw, box.sh, -w / 2, -h / 2, w, h)
  } else if (clip.kind === "color") {
    ctx.fillStyle = clip.color
    ctx.fillRect(-w / 2, -h / 2, w, h)
  } else if (clip.kind === "shape") {
    drawShape(ctx, clip.shape)
  } else if (clip.kind === "text") {
    drawText(ctx, clip.text, box.L, tr.chars, k * g.s)
  }

  ctx.shadowColor = "transparent"
  ctx.filter = "none"
  if (fx.temperature) {
    ctx.globalCompositeOperation = "soft-light"
    const a = Math.min(1, Math.abs(fx.temperature) / 100) * 0.7
    ctx.fillStyle = fx.temperature > 0 ? `rgba(255,140,30,${a})` : `rgba(30,120,255,${a})`
    if (!needClip) {
      ctx.beginPath()
      ctx.rect(-w / 2, -h / 2, w, h)
      ctx.clip()
    }
    ctx.fillRect(-w / 2, -h / 2, w, h)
  }
  if (fx.vignette) {
    ctx.globalCompositeOperation = "source-over"
    const d = Math.hypot(w, h) / 2
    const grad = ctx.createRadialGradient(0, 0, d * 0.35, 0, 0, d)
    grad.addColorStop(0, "rgba(0,0,0,0)")
    grad.addColorStop(1, `rgba(0,0,0,${fx.vignette / 100})`)
    ctx.fillStyle = grad
    ctx.fillRect(-w / 2, -h / 2, w, h)
  }
  ctx.restore()
}

// Green screen: make pixels near the key color transparent (distance in the CbCr plane).
const keyCanvases = new Map()
function chromaKey(id, img, box, outW, outH, fx) {
  const sc = Math.min(1, 1280 / Math.max(outW, outH, 1))
  const W = Math.max(1, Math.round(Math.min(outW, box.sw) * sc))
  const H = Math.max(1, Math.round(Math.min(outH, box.sh) * sc))
  let c = keyCanvases.get(id)
  if (!c) keyCanvases.set(id, (c = new OffscreenCanvas(W, H)))
  if (c.width !== W || c.height !== H) {
    c.width = W
    c.height = H
  }
  const x = c.getContext("2d", { willReadFrequently: true })
  x.clearRect(0, 0, W, H)
  x.drawImage(img, box.sx, box.sy, box.sw, box.sh, 0, 0, W, H)
  const d = x.getImageData(0, 0, W, H)
  const px = d.data
  const kc = parseInt((fx.keyColor || "#00ff00").slice(1, 7), 16)
  const kr = (kc >> 16) & 255
  const kg = (kc >> 8) & 255
  const kb = kc & 255
  const kcb = -0.169 * kr - 0.331 * kg + 0.5 * kb
  const kcr = 0.5 * kr - 0.419 * kg - 0.081 * kb
  const sim = ((fx.keySim ?? 40) / 100) * 120
  const smooth = Math.max(1, ((fx.keySmooth ?? 10) / 100) * 120)
  const spill = (fx.keySpill ?? 50) / 100
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]
    const gg = px[i + 1]
    const b = px[i + 2]
    const cb = -0.169 * r - 0.331 * gg + 0.5 * b
    const cr = 0.5 * r - 0.419 * gg - 0.081 * b
    const dist = Math.hypot(cb - kcb, cr - kcr)
    if (dist < sim) px[i + 3] = 0
    else if (dist < sim + smooth) {
      const a = (dist - sim) / smooth
      px[i + 3] = px[i + 3] * a
      if (spill && kg > kr && kg > kb)
        px[i + 1] = Math.min(gg, (r + b) / 2 + (gg - (r + b) / 2) * (1 - spill))
    }
  }
  x.putImageData(d, 0, 0)
  return c
}

function drawShape(ctx, s) {
  ctx.beginPath()
  if (s.type === "ellipse") ctx.ellipse(0, 0, s.w / 2, s.h / 2, 0, 0, Math.PI * 2)
  else ctx.roundRect(-s.w / 2, -s.h / 2, s.w, s.h, Math.min(s.radius || 0, s.w / 2, s.h / 2))
  if (s.fill) {
    ctx.fillStyle = s.fill
    ctx.fill()
  }
  if (s.stroke && s.strokeWidth > 0) {
    ctx.shadowColor = "transparent"
    ctx.lineWidth = s.strokeWidth
    ctx.strokeStyle = s.stroke
    ctx.stroke()
  }
}

function drawText(ctx, tx, L, chars, k) {
  if (tx.bg) {
    ctx.fillStyle = tx.bg
    ctx.beginPath()
    ctx.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, Math.min(tx.radius || 0, L.h / 2))
    ctx.fill()
    ctx.shadowColor = "transparent"
  }
  ctx.font = textFont(tx)
  ctx.letterSpacing = (tx.spacing || 0) + "px"
  ctx.textBaseline = "middle"
  ctx.textAlign = tx.align === "left" ? "left" : tx.align === "right" ? "right" : "center"
  const x = tx.align === "left" ? -L.tw / 2 : tx.align === "right" ? L.tw / 2 : 0
  let budget = chars < 1 ? Math.floor(L.lines.reduce((n, l) => n + l.length, 0) * chars) : Infinity
  const lines = L.lines.map((l) => {
    if (budget >= l.length) {
      budget -= l.length
      return l
    }
    const part = l.slice(0, Math.max(0, budget))
    budget = 0
    return part
  })
  const y0 = -L.th / 2 + L.lh / 2
  if (tx.stroke && tx.strokeWidth > 0) {
    ctx.save()
    ctx.shadowColor = "transparent"
    ctx.lineJoin = "round"
    ctx.miterLimit = 2
    ctx.lineWidth = tx.strokeWidth * 2
    ctx.strokeStyle = tx.stroke
    lines.forEach((l, i) => ctx.strokeText(l, x, y0 + i * L.lh))
    ctx.restore()
  }
  if (tx.glow) {
    ctx.save()
    ctx.shadowColor = tx.glow
    ctx.shadowBlur = tx.size * 0.35 * k
    ctx.fillStyle = tx.color
    lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * L.lh))
    ctx.restore()
  } else if (tx.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.55)"
    ctx.shadowBlur = tx.size * 0.12 * k
    ctx.shadowOffsetY = tx.size * 0.04 * k
  }
  ctx.fillStyle = tx.color
  lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * L.lh))
}
