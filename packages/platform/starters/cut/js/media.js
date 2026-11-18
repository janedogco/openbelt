// Media: import (upload to OpenBelt files), probe, thumbnails, filmstrips, waveforms.
import { files } from "/sdk.js"
import {
  Input,
  BlobSource,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  AudioBufferSink,
  Output,
  WebMOutputFormat,
  BufferTarget,
  Conversion,
} from "../vendor/mediabunny.js"
import { state, emit, mediaCol } from "./store.js"
import { uid, toast } from "./ui.js"

export const mediaUrl = (m) => m.localUrl || m.file?.url || ""

export function kindOf(file) {
  const t = file.type || ""
  const n = file.name.toLowerCase()
  if (t.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v|avi)$/.test(n)) return "video"
  if (t.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/.test(n)) return "audio"
  if (t.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)$/.test(n)) return "image"
  return null
}

function inputFor(m) {
  const source = m.blob
    ? new BlobSource(m.blob)
    : new UrlSource(new URL(mediaUrl(m), location.href).href)
  return new Input({ source, formats: ALL_FORMATS })
}

// Loads the project's media records from OpenBelt.
export async function loadMedia(projectId) {
  state.media.clear()
  let cursor = null
  do {
    const page = await mediaCol.list({ limit: 1000, cursor })
    for (const d of page.docs)
      if (d.data.project === projectId)
        state.media.set(d.id, { ...d.data, id: d.id, status: "ready" })
    cursor = page.cursor
  } while (cursor)
  emit("media")
}

async function probe(m) {
  if (m.kind === "image") {
    const img = new Image()
    img.src = mediaUrl(m)
    await img.decode()
    m.width = img.naturalWidth
    m.height = img.naturalHeight
    m.duration = 5
    m.hasAudio = false
    const c = document.createElement("canvas")
    const s = Math.min(1, 320 / Math.max(m.width, m.height))
    c.width = Math.max(1, Math.round(m.width * s))
    c.height = Math.max(1, Math.round(m.height * s))
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height)
    m.thumb = c.toDataURL("image/jpeg", 0.75)
    return
  }
  try {
    const input = inputFor(m)
    const vt = m.kind === "video" ? await input.getPrimaryVideoTrack() : null
    const at = await input.getPrimaryAudioTrack()
    m.duration = await input.computeDuration()
    m.hasAudio = !!at
    if (vt) {
      m.width = vt.displayWidth
      m.height = vt.displayHeight
      if (await vt.canDecode()) {
        const sink = new CanvasSink(vt, { width: 320, poolSize: 0 })
        const first = await input.getFirstTimestamp([vt]).catch(() => 0)
        const wc = await sink.getCanvas(first + Math.min(1, m.duration * 0.1))
        if (wc) m.thumb = toDataUrl(wc.canvas)
      }
    } else if (m.kind === "video") m.kind = "audio"
    input.dispose?.()
  } catch (e) {
    // Formats Mediabunny can't read: ask the browser.
    await probeWithElement(m)
  }
}

function toDataUrl(canvas) {
  if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL("image/jpeg", 0.75)
  const c = document.createElement("canvas")
  c.width = canvas.width
  c.height = canvas.height
  c.getContext("2d").drawImage(canvas, 0, 0)
  return c.toDataURL("image/jpeg", 0.75)
}

function probeWithElement(m) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(m.kind === "audio" ? "audio" : "video")
    el.preload = "auto"
    el.muted = true
    el.src = mediaUrl(m)
    el.onloadedmetadata = () => {
      m.duration = el.duration
      m.width = el.videoWidth || 0
      m.height = el.videoHeight || 0
      m.hasAudio = true
      if (m.kind === "video" && !m.width) m.kind = "audio"
      if (m.kind !== "video") return resolve()
      el.currentTime = Math.min(1, el.duration * 0.1)
      el.onseeked = () => {
        const c = document.createElement("canvas")
        const s = 320 / Math.max(1, m.width)
        c.width = 320
        c.height = Math.round(m.height * s)
        c.getContext("2d").drawImage(el, 0, 0, c.width, c.height)
        m.thumb = c.toDataURL("image/jpeg", 0.75)
        resolve()
      }
    }
    el.onerror = () => reject(new Error("This file type can't be played in this browser"))
  })
}

// Import files into the open project. Resolves to the new media records once probed
// (uploads keep going in the background).
export async function importFiles(fileList, projectId = state.id) {
  const out = []
  for (const file of fileList) {
    const kind = kindOf(file)
    if (!kind) {
      toast(`${file.name}: not a video, audio or image file`, "error")
      continue
    }
    const m = {
      id: uid("m"),
      project: projectId,
      name: file.name,
      kind,
      size: file.size,
      blob: file,
      localUrl: URL.createObjectURL(file),
      status: "uploading",
      progress: 0,
      created: Date.now(),
    }
    state.media.set(m.id, m)
    emit("media")
    try {
      await probe(m)
    } catch (e) {
      state.media.delete(m.id)
      emit("media")
      toast(`${file.name}: ${e.message}`, "error")
      continue
    }
    emit("media")
    out.push(m)
    upload(m, file)
  }
  return out
}

async function upload(m, file) {
  try {
    const f = await files.put(file, {
      onProgress: ({ loaded, total }) => {
        m.progress = total ? loaded / total : 0
        emit("media-progress", m)
      },
    })
    m.file = { id: f.id, url: f.url, name: f.name, type: f.type, size: f.size }
    await mediaCol.set(m.id, docOf(m))
    m.status = "ready"
  } catch (e) {
    m.status = "error"
    m.error = e.message
    toast(`Upload of ${m.name} failed: ${e.message}`, "error")
  }
  emit("media")
}

export function docOf(m) {
  return {
    project: m.project,
    name: m.name,
    kind: m.kind,
    size: m.size,
    duration: m.duration,
    width: m.width || 0,
    height: m.height || 0,
    hasAudio: !!m.hasAudio,
    thumb: m.thumb || null,
    file: m.file,
    created: m.created,
  }
}

export async function deleteMedia(m) {
  state.media.delete(m.id)
  emit("media")
  try {
    await mediaCol.delete(m.id)
  } catch {}
  try {
    if (!m.file?.id) return
    // A duplicated project shares the file: keep it while another record uses it.
    let cursor = null
    do {
      const page = await mediaCol.list({ limit: 1000, cursor })
      if (page.docs.some((d) => d.id !== m.id && d.data.file?.id === m.file.id)) return
      cursor = page.cursor
    } while (cursor)
    await files.delete(m.file.id)
  } catch {}
}

// --- filmstrips --------------------------------------------------------------

const stripJobs = new Map()
export function filmstrip(m) {
  if (m.strip) return m.strip
  if (m.kind === "image") {
    if (!stripJobs.has(m.id)) {
      const img = new Image()
      img.src = m.thumb || mediaUrl(m)
      stripJobs.set(
        m.id,
        img.decode().then(() => {
          m.strip = [{ t: 0, img }]
          emit("strip", m)
        }),
      )
    }
    return null
  }
  if (m.kind !== "video" || stripJobs.has(m.id)) return null
  stripJobs.set(
    m.id,
    (async () => {
      try {
        const input = inputFor(m)
        const vt = await input.getPrimaryVideoTrack()
        if (!vt || !(await vt.canDecode())) return
        const n = Math.max(2, Math.min(90, Math.ceil(m.duration / 0.5)))
        const step = m.duration / n
        const sink = new CanvasSink(vt, { height: 72, poolSize: 0 })
        const first = await input.getFirstTimestamp([vt]).catch(() => 0)
        const times = Array.from({ length: n }, (_, i) => first + i * step + step / 2)
        const strip = []
        let i = 0
        for await (const wc of sink.canvasesAtTimestamps(times)) {
          if (wc) strip.push({ t: times[i] - first, img: wc.canvas })
          i++
          if (i % 12 === 0) {
            m.strip = strip.slice()
            emit("strip", m)
          }
        }
        m.strip = strip
        emit("strip", m)
      } catch (e) {
        console.warn("filmstrip", e)
      }
    })(),
  )
  return null
}

// --- audio -------------------------------------------------------------------

const audioJobs = new Map()
// Full decoded audio of a media item (cached), for waveforms and export.
export function decodeAudio(m) {
  if (audioJobs.has(m.id)) return audioJobs.get(m.id)
  const job = (async () => {
    try {
      const input = inputFor(m)
      const at = await input.getPrimaryAudioTrack()
      if (!at || !(await at.canDecode())) throw new Error("no decodable audio")
      const chunks = []
      let sr = at.sampleRate || 48000
      let ch = 1
      let end = 0
      for await (const wb of new AudioBufferSink(at).buffers()) {
        chunks.push(wb)
        sr = wb.buffer.sampleRate
        ch = Math.max(ch, Math.min(2, wb.buffer.numberOfChannels))
        end = Math.max(end, wb.timestamp + wb.buffer.duration)
      }
      const first = chunks.length ? Math.min(...chunks.map((c) => c.timestamp)) : 0
      const len = Math.max(1, Math.ceil((end - Math.min(0, first)) * sr))
      const buf = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: sr })
      for (const wb of chunks) {
        const off = Math.max(0, Math.round(wb.timestamp * sr))
        for (let c = 0; c < ch; c++) {
          const data = wb.buffer.getChannelData(Math.min(c, wb.buffer.numberOfChannels - 1))
          const n = Math.min(data.length, len - off)
          if (n > 0) buf.getChannelData(c).set(n === data.length ? data : data.subarray(0, n), off)
        }
      }
      return buf
    } catch (e) {
      // Fall back to the browser's decoder.
      const ab = await (m.blob
        ? m.blob.arrayBuffer()
        : fetch(mediaUrl(m)).then((r) => r.arrayBuffer()))
      const ac = new OfflineAudioContext(1, 1, 48000)
      return await ac.decodeAudioData(ab)
    }
  })()
  audioJobs.set(m.id, job)
  job.catch(() => audioJobs.delete(m.id))
  return job
}

const PEAKS_PER_SEC = 60
export function peaks(m) {
  if (m.peaks || m.peaksPending || !m.hasAudio) return m.peaks || null
  m.peaksPending = true
  decodeAudio(m)
    .then((buf) => {
      const n = Math.ceil(buf.duration * PEAKS_PER_SEC)
      const per = buf.sampleRate / PEAKS_PER_SEC
      const out = new Float32Array(n)
      const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))
      for (let i = 0; i < n; i++) {
        let mx = 0
        const a = Math.floor(i * per)
        const b = Math.min(buf.length, Math.floor((i + 1) * per))
        for (const d of chans)
          for (let j = a; j < b; j += 4) {
            const v = d[j] < 0 ? -d[j] : d[j]
            if (v > mx) mx = v
          }
        out[i] = mx
      }
      m.peaks = out
      m.peaksRate = PEAKS_PER_SEC
      emit("strip", m)
    })
    .catch((e) => {
      m.hasAudio = false
      console.warn("waveform", e)
    })
  return null
}

// --- recording -----------------------------------------------------------------

export async function record(kind) {
  const stream =
    kind === "screen"
      ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true })
      : await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: true,
        })
  const mime = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ].find((t) => MediaRecorder.isTypeSupported(t))
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 })
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const done = new Promise((resolve) => (rec.onstop = resolve))
  rec.start(500)
  stream.getVideoTracks()[0].addEventListener("ended", () => rec.state !== "inactive" && rec.stop())
  return {
    stream,
    async stop() {
      if (rec.state !== "inactive") rec.stop()
      await done
      stream.getTracks().forEach((t) => t.stop())
      const raw = new Blob(chunks, { type: mime.split(";")[0] })
      const name =
        (kind === "screen" ? "Screen recording " : "Camera ") +
        new Date().toLocaleTimeString().replace(/:/g, ".")
      // MediaRecorder's WebM has no index, so players can't seek it: remux it.
      try {
        const input = new Input({ source: new BlobSource(raw), formats: ALL_FORMATS })
        const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
        const conv = await Conversion.init({ input, output })
        await conv.execute()
        return new File([output.target.buffer], name + ".webm", { type: "video/webm" })
      } catch (e) {
        console.warn("remux", e)
        return new File([raw], name + (mime.includes("mp4") ? ".mp4" : ".webm"), { type: raw.type })
      }
    },
  }
}
