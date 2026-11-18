// Export: render every frame with the shared renderer, decode sources with
// Mediabunny (WebCodecs), mix audio offline, encode and mux in the browser.
import {
  Input,
  BlobSource,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  Output,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  Mp4OutputFormat,
  WebMOutputFormat,
  MovOutputFormat,
  WavOutputFormat,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
  canEncodeVideo,
  canEncodeAudio,
} from "../vendor/mediabunny.js"
import { GIFEncoder, quantize, applyPalette } from "../vendor/gifenc.js"
import { state, selectedClips, saveNow } from "./store.js"
import { renderFrame } from "./render.js"
import {
  isActive,
  srcTime,
  gainAt,
  projectDuration,
  hasVisual,
  hasAudio,
  clipEnd,
  FONTS,
} from "./model.js"
import { decodeAudio, mediaUrl, importFiles } from "./media.js"
import { h, icon, modal, btn, busy, toast, fmtTime, fmtBytes, fmtDur, clamp } from "./ui.js"

const FORMATS = [
  {
    id: "mp4",
    label: "MP4",
    sub: "H.264 · AAC",
    ext: "mp4",
    video: "avc",
    audio: ["aac", "opus"],
    kind: "video",
  },
  {
    id: "webm",
    label: "WebM",
    sub: "VP9 · Opus",
    ext: "webm",
    video: "vp9",
    audio: ["opus", "vorbis"],
    kind: "video",
  },
  {
    id: "mov",
    label: "MOV",
    sub: "H.264 · AAC",
    ext: "mov",
    video: "avc",
    audio: ["aac"],
    kind: "video",
  },
  {
    id: "hevc",
    label: "MP4",
    sub: "HEVC · AAC",
    ext: "mp4",
    video: "hevc",
    audio: ["aac", "opus"],
    kind: "video",
  },
  { id: "gif", label: "GIF", sub: "Animated", ext: "gif", kind: "gif" },
  { id: "m4a", label: "M4A", sub: "AAC audio", ext: "m4a", audio: ["aac", "opus"], kind: "audio" },
  { id: "wav", label: "WAV", sub: "Lossless audio", ext: "wav", audio: ["pcm-s16"], kind: "audio" },
  { id: "png", label: "PNG", sub: "This frame", ext: "png", kind: "png" },
]

const QUALITY = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  best: QUALITY_VERY_HIGH,
}

export function openExport(player) {
  const p = state.project
  const dur = projectDuration(p)
  const opts = {
    format: "mp4",
    res: 1,
    quality: "high",
    fps: p.scene.fps,
    range: "all",
    from: 0,
    to: dur,
  }
  const sel = selectedClips()
  if (!dur) return toast("Add something to the timeline first", "error")
  player.pause()

  const body = h("div", { class: "export" })
  const m = modal("Export", body, { wide: true, onClose: () => job?.cancel() })
  let job = null

  const fmtGrid = h(
    "div",
    { class: "fmt-grid" },
    FORMATS.map((f) =>
      h(
        "button",
        {
          class: "fmt",
          type: "button",
          "data-id": f.id,
          onclick: () => {
            opts.format = f.id
            if (f.id === "gif") {
              opts.res = Math.min(
                opts.res,
                Math.min(1, 480 / Math.max(p.scene.width, p.scene.height)),
              )
              opts.fps = Math.min(opts.fps, 15)
            } else opts.fps = p.scene.fps
            draw()
          },
        },
        h("b", {}, f.label),
        h("small", {}, f.sub),
      ),
    ),
  )
  const settings = h("div", { class: "export-settings" })
  const footer = h("div", { class: "export-foot" })

  function row(label, ctl) {
    return h(
      "div",
      { class: "row" },
      h("label", { class: "row-label" }, label),
      h("div", { class: "row-ctl" }, ctl),
    )
  }
  function sel_(options, value, onchange) {
    const s = h(
      "select",
      { onchange: () => onchange(s.value) },
      options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)),
    )
    return s
  }

  function draw() {
    for (const b of fmtGrid.children) b.classList.toggle("on", b.dataset.id === opts.format)
    const f = FORMATS.find((x) => x.id === opts.format)
    const rows = []
    if (f.kind === "video" || f.kind === "gif" || f.kind === "png") {
      const resOpts = [1, 0.75, 0.5, 0.25]
      if (p.scene.width < 3840 && p.scene.width <= 1920 && f.kind !== "gif") resOpts.unshift(2)
      if (f.kind === "gif")
        resOpts.push(
          Math.min(1, 480 / Math.max(p.scene.width, p.scene.height)),
          Math.min(1, 320 / Math.max(p.scene.width, p.scene.height)),
        )
      const uniq = [...new Set(resOpts.map((r) => +r.toFixed(4)))].sort((a, b) => b - a)
      rows.push(
        row(
          "Resolution",
          sel_(
            uniq.map((r) => [
              r,
              `${even(p.scene.width * r)}×${even(p.scene.height * r)}` +
                (r === 1 ? " (original)" : ""),
            ]),
            +opts.res.toFixed(4),
            (v) => ((opts.res = +v), draw()),
          ),
        ),
      )
    }
    if (f.kind === "video") {
      rows.push(
        row(
          "Quality",
          sel_(
            [
              ["low", "Small file"],
              ["medium", "Medium"],
              ["high", "High"],
              ["best", "Best"],
            ],
            opts.quality,
            (v) => (opts.quality = v),
          ),
        ),
      )
    }
    if (f.kind === "video" || f.kind === "gif") {
      const list = f.kind === "gif" ? [10, 12, 15, 20, 25] : [24, 25, 30, 50, 60]
      if (!list.includes(opts.fps)) list.push(opts.fps)
      rows.push(
        row(
          "Frame rate",
          sel_(
            list.sort((a, b) => a - b).map((v) => [v, v + " fps"]),
            opts.fps,
            (v) => (opts.fps = +v),
          ),
        ),
      )
    }
    if (f.kind !== "png") {
      const ranges = [["all", `Whole video (${fmtDur(dur)})`]]
      if (sel.length)
        ranges.push([
          "sel",
          `Selected clips (${fmtDur(Math.max(...sel.map(clipEnd)) - Math.min(...sel.map((c) => c.start)))})`,
        ])
      ranges.push(["custom", "Custom range"])
      rows.push(
        row(
          "Range",
          sel_(ranges, opts.range, (v) => ((opts.range = v), draw())),
        ),
      )
      if (opts.range === "custom") {
        const a = h("input", {
          class: "num",
          value: opts.from.toFixed(2),
          onchange: () => (opts.from = clamp(parseFloat(a.value) || 0, 0, dur)),
        })
        const b = h("input", {
          class: "num",
          value: opts.to.toFixed(2),
          onchange: () => (opts.to = clamp(parseFloat(b.value) || dur, 0, dur)),
        })
        rows.push(row("From / to (s)", h("div", { class: "pair-inline" }, a, b)))
      }
    }
    settings.replaceChildren(...rows)
    footer.replaceChildren(
      h("div", { class: "export-est" }, estimate(f)),
      h(
        "button",
        { class: "btn primary big", type: "button", onclick: (e) => busy(e.currentTarget, start) },
        icon("download", 16),
        "Export",
      ),
    )
  }

  function estimate(f) {
    const [a, b] = range()
    const len = b - a
    if (f.kind === "png")
      return `${even(p.scene.width * opts.res)}×${even(p.scene.height * opts.res)} PNG`
    if (f.kind === "audio") return `${fmtDur(len)} of audio`
    const w = even(p.scene.width * opts.res)
    const hh = even(p.scene.height * opts.res)
    return `${fmtDur(len)} · ${w}×${hh} · ${opts.fps} fps`
  }

  function range() {
    if (opts.range === "sel" && sel.length)
      return [Math.min(...sel.map((c) => c.start)), Math.max(...sel.map(clipEnd))]
    if (opts.range === "custom") return [Math.min(opts.from, opts.to), Math.max(opts.from, opts.to)]
    return [0, dur]
  }

  async function start() {
    const f = FORMATS.find((x) => x.id === opts.format)
    const [a, b] = range()
    if (b - a <= 0) return toast("The range is empty", "error")
    const prog = h("div", { class: "progress" }, h("div", { class: "bar" }))
    const status = h("div", { class: "export-status" }, "Preparing…")
    const cancelBtn = btn("Cancel", () => job?.cancel())
    body.replaceChildren(
      h(
        "div",
        { class: "export-run" },
        h("h3", {}, `Exporting ${f.label}`),
        prog,
        status,
        h("div", { class: "row end" }, cancelBtn),
      ),
    )
    const t0 = performance.now()
    job = makeJob()
    try {
      const out = await runExport(
        { ...opts, from: a, to: b, f },
        job,
        (frac, msg) => {
          prog.firstChild.style.width = (frac * 100).toFixed(1) + "%"
          const el = (performance.now() - t0) / 1000
          const eta = frac > 0.02 ? el / frac - el : null
          status.textContent = msg + (eta != null && frac < 1 ? ` · ${Math.ceil(eta)}s left` : "")
        },
        player,
      )
      done(out, f, (performance.now() - t0) / 1000)
    } catch (e) {
      if (job.cancelled) {
        m.close()
        toast("Export cancelled")
        return
      }
      console.error(e)
      body.replaceChildren(
        h(
          "div",
          { class: "export-run" },
          h("h3", {}, "Export failed"),
          h("p", { class: "err" }, e.message || String(e)),
          h(
            "div",
            { class: "row end" },
            btn("Back", () => (body.replaceChildren(fmtGrid, settings, footer), draw())),
          ),
        ),
      )
    } finally {
      job = null
    }
  }

  function done(blob, f, secs) {
    const url = URL.createObjectURL(blob)
    const name = (p.name || "Untitled").replace(/[\\/:*?"<>|]+/g, "-") + "." + f.ext
    const preview =
      f.kind === "video"
        ? h("video", { src: url, controls: true, playsinline: true, class: "export-preview" })
        : f.kind === "audio"
          ? h("audio", { src: url, controls: true, class: "export-preview audio" })
          : h("img", { src: url, class: "export-preview", alt: "Exported image" })
    const file = new File([blob], name, { type: blob.type })
    const actions = [
      h(
        "a",
        { class: "btn primary big", href: url, download: name },
        icon("download", 16),
        "Download",
      ),
    ]
    if (navigator.canShare?.({ files: [file] }))
      actions.push(
        h(
          "button",
          {
            class: "btn big",
            type: "button",
            onclick: () => navigator.share({ files: [file], title: p.name }).catch(() => {}),
          },
          icon("share", 16),
          "Share",
        ),
      )
    if (f.kind !== "png")
      actions.push(
        h(
          "button",
          {
            class: "btn big",
            type: "button",
            onclick: (e) =>
              busy(e.currentTarget, async () => {
                await importFiles([file])
                toast("Added to media")
              }),
          },
          icon("plus", 16),
          "Add to media",
        ),
      )
    body.replaceChildren(
      h(
        "div",
        { class: "export-done" },
        preview,
        h(
          "div",
          { class: "export-meta" },
          h("b", {}, name),
          h("span", {}, `${fmtBytes(blob.size)} · rendered in ${secs.toFixed(1)}s`),
        ),
        h("div", { class: "row end wrap" }, actions),
      ),
    )
  }

  body.append(fmtGrid, settings, footer)
  draw()
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2)

function makeJob() {
  const j = {
    cancelled: false,
    onCancel: [],
    cancel() {
      if (j.cancelled) return
      j.cancelled = true
      j.onCancel.forEach((f) => f())
    },
  }
  return j
}

function inputFor(m) {
  const source = m.blob
    ? new BlobSource(m.blob)
    : new UrlSource(new URL(mediaUrl(m), location.href).href)
  return new Input({ source, formats: ALL_FORMATS })
}

async function loadFonts(p) {
  const fams = new Set(
    p.clips
      .filter((c) => c.kind === "text")
      .map((c) => `${c.text.italic ? "italic " : ""}${c.text.weight} 40px "${c.text.font}"`),
  )
  await Promise.all([...fams].map((f) => document.fonts.load(f).catch(() => {})))
}

export async function runExport(o, job, progress, player) {
  const p = structuredClone(state.project)
  const media = state.media
  const f = o.f
  await saveNow()
  await loadFonts(p)

  if (f.kind === "png") {
    const snap = player.snapshot((pp) => even(pp.scene.width * o.res), "image/png")
    progress(1, "Done")
    return await new Promise((r) => snap.canvas.toBlob(r, "image/png"))
  }

  const W = even(p.scene.width * o.res)
  const H = even(p.scene.height * o.res)
  const k = W / p.scene.width
  const fps = o.fps
  const t0 = o.from
  const t1 = o.to
  const n = Math.max(1, Math.round((t1 - t0) * fps))

  // ---- audio mix
  let mixed = null
  const needAudio = f.kind === "video" || f.kind === "audio"
  if (needAudio) {
    progress(0, "Mixing audio…")
    mixed = await mixAudio(p, media, t0, t1, job)
    if (job.cancelled) throw new Error("cancelled")
  }

  if (f.kind === "audio") {
    if (!mixed) throw new Error("There's no audio in this range")
    const format = f.id === "wav" ? new WavOutputFormat() : new Mp4OutputFormat()
    const output = new Output({ format, target: new BufferTarget() })
    const codec = f.id === "wav" ? "pcm-s16" : await pickAudio(f.audio)
    if (!codec) throw new Error("This browser can't encode audio for " + f.label)
    const src = new AudioBufferSource({ codec, bitrate: QUALITY_HIGH })
    output.addAudioTrack(src)
    await output.start()
    await src.add(mixed)
    src.close()
    await output.finalize()
    progress(1, "Done")
    return new Blob([output.target.buffer], { type: f.id === "wav" ? "audio/wav" : "audio/mp4" })
  }

  // ---- video sources
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext("2d", { alpha: false })
  const iters = new Map() // clip id → { it, cur }
  const images = new Map()
  const inputs = []
  const visibleLayers = new Set(p.layers.filter((l) => !l.hidden).map((l) => l.id))
  const frameT = (i) => t0 + i / fps
  for (const c of p.clips) {
    if (!visibleLayers.has(c.layerId)) continue
    const m = c.mediaId ? media.get(c.mediaId) : null
    if (!m || !hasVisual(c, m)) continue
    if (m.kind === "image") {
      if (!images.has(m.id)) {
        const img = new Image()
        img.src = mediaUrl(m)
        await img.decode()
        images.set(m.id, img)
      }
      continue
    }
    const times = []
    for (let i = 0; i < n; i++) {
      const t = frameT(i)
      if (isActive(c, t)) times.push(clamp(srcTime(c, t), 0, Math.max(0, m.duration - 1 / 120)))
    }
    if (!times.length) continue
    const input = inputFor(m)
    inputs.push(input)
    const vt = await input.getPrimaryVideoTrack()
    if (!vt) continue
    if (!(await vt.canDecode())) throw new Error(`This browser can't decode ${m.name}`)
    const first = await input.getFirstTimestamp([vt]).catch(() => 0)
    const sink = new CanvasSink(vt, { poolSize: 3 })
    iters.set(c.id, { it: sink.canvasesAtTimestamps(times.map((t) => t + first)), cur: null })
  }

  const getSource = (clip) => {
    const m = media.get(clip.mediaId)
    if (!m) return null
    if (m.kind === "image") {
      const b = images.get(m.id)
      return b ? { img: b, w: b.naturalWidth || m.width, h: b.naturalHeight || m.height } : null
    }
    const s = iters.get(clip.id)
    return s?.cur ? { img: s.cur.canvas, w: s.cur.canvas.width, h: s.cur.canvas.height } : null
  }

  // ---- GIF
  if (f.kind === "gif") {
    const gif = GIFEncoder()
    const delay = Math.round(1000 / fps)
    for (let i = 0; i < n; i++) {
      if (job.cancelled) throw new Error("cancelled")
      await advance(p, iters, frameT(i))
      renderFrame(ctx, p, frameT(i), { getSource, media, k })
      const data = ctx.getImageData(0, 0, W, H).data
      const palette = quantize(data, 256, { format: "rgb565" })
      const index = applyPalette(data, palette, "rgb565")
      gif.writeFrame(index, W, H, { palette, delay })
      if (i % 2 === 0) {
        progress(i / n, `Frame ${i + 1} of ${n}`)
        await new Promise((r) => setTimeout(r))
      }
    }
    gif.finish()
    progress(1, "Done")
    return new Blob([gif.bytes()], { type: "image/gif" })
  }

  // ---- encoded video
  const format =
    f.id === "webm"
      ? new WebMOutputFormat()
      : f.id === "mov"
        ? new MovOutputFormat({ fastStart: "in-memory" })
        : new Mp4OutputFormat({ fastStart: "in-memory" })
  const output = new Output({ format, target: new BufferTarget() })
  job.onCancel.push(() => output.cancel().catch(() => {}))
  if (!(await canEncodeVideo(f.video, { width: W, height: H }))) {
    throw new Error(
      `This browser can't encode ${f.video === "hevc" ? "HEVC" : f.video === "vp9" ? "VP9" : "H.264"} at ${W}×${H}. Try another format or a smaller resolution.`,
    )
  }
  const vsrc = new CanvasSource(canvas, {
    codec: f.video,
    bitrate: QUALITY[o.quality],
    keyFrameInterval: 2,
    latencyMode: "quality",
  })
  output.addVideoTrack(vsrc, { frameRate: fps })
  let asrc = null
  if (mixed) {
    const codec = await pickAudio(f.audio)
    if (codec) {
      asrc = new AudioBufferSource({ codec, bitrate: QUALITY_HIGH })
      output.addAudioTrack(asrc)
    }
  }
  await output.start()
  if (asrc) {
    await asrc.add(mixed)
    asrc.close()
  }
  for (let i = 0; i < n; i++) {
    if (job.cancelled) throw new Error("cancelled")
    const t = frameT(i)
    await advance(p, iters, t)
    renderFrame(ctx, p, t, { getSource, media, k })
    await vsrc.add(i / fps, 1 / fps)
    if (i % 5 === 0) progress(i / n, `Frame ${i + 1} of ${n}`)
  }
  vsrc.close()
  progress(0.99, "Finishing…")
  await output.finalize()
  for (const inp of inputs) inp.dispose?.()
  progress(1, "Done")
  return new Blob([output.target.buffer], {
    type: f.id === "webm" ? "video/webm" : f.id === "mov" ? "video/quicktime" : "video/mp4",
  })
}

// Pull the next decoded frame for every video clip active at t.
async function advance(p, iters, t) {
  const pending = []
  for (const c of p.clips) {
    const s = iters.get(c.id)
    if (!s || !isActive(c, t)) continue
    pending.push(
      s.it.next().then((r) => {
        if (!r.done && r.value) s.cur = r.value
      }),
    )
  }
  await Promise.all(pending)
}

async function pickAudio(list) {
  for (const c of list)
    if (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000 })) return c
  return null
}

export async function mixAudio(p, media, t0, t1, job, SR = 48000, channels = 2) {
  const len = Math.max(1, Math.ceil((t1 - t0) * SR))
  const mutedLayers = new Set(p.layers.filter((l) => l.muted).map((l) => l.id))
  const clips = p.clips.filter(
    (c) =>
      !c.muted &&
      !mutedLayers.has(c.layerId) &&
      c.start < t1 &&
      clipEnd(c) > t0 &&
      hasAudio(c, media.get(c.mediaId)),
  )
  if (!clips.length) return null
  const ctx = new OfflineAudioContext(channels, len, SR)
  let any = false
  for (const c of clips) {
    if (job.cancelled) return null
    const m = media.get(c.mediaId)
    let buf
    try {
      buf = await decodeAudio(m)
    } catch {
      continue
    }
    any = true
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.playbackRate.value = c.speed
    const gain = ctx.createGain()
    node.connect(gain).connect(ctx.destination)
    const a = Math.max(c.start, t0)
    const b = Math.min(clipEnd(c), t1)
    const when = a - t0
    const offset = srcTime(c, a)
    // gain curve, 100 points a second
    const steps = Math.max(2, Math.ceil((b - a) * 100))
    const curve = new Float32Array(steps)
    for (let i = 0; i < steps; i++) curve[i] = gainAt(c, a - c.start + ((b - a) * i) / (steps - 1))
    gain.gain.setValueCurveAtTime(curve, when, Math.max(0.001, b - a))
    node.start(when, Math.max(0, offset), (b - a) * c.speed)
  }
  if (!any) return null
  return await ctx.startRendering()
}

void FONTS
void fmtTime
