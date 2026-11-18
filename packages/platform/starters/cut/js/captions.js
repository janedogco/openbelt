// Auto captions: transcribe the timeline's audio with Whisper, in the browser
// (a worker; WebGPU when there is one), and add a caption clip per phrase.
import { state, commit, select } from "./store.js"
import { makeClip, projectDuration } from "./model.js"
import { mixAudio } from "./export.js"
import { h, icon, modal, toast, uid, busy } from "./ui.js"

const TF = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js"
const MODEL = "onnx-community/whisper-base_timestamped"

const WORKER = `
import { pipeline } from "${TF}";
let asr = null;
self.onmessage = async (e) => {
  const { audio, language } = e.data;
  try {
    if (!asr) {
      let device = "wasm";
      try { if (self.navigator.gpu && (await self.navigator.gpu.requestAdapter())) device = "webgpu"; } catch {}
      self.postMessage({ type: "device", device });
      asr = await pipeline("automatic-speech-recognition", "${MODEL}", {
        device,
        dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
        progress_callback: (p) => self.postMessage({ type: "progress", p }),
      });
    }
    self.postMessage({ type: "status", text: "Transcribing" });
    const opts = { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 };
    if (language) { opts.language = language; opts.task = "transcribe"; }
    const out = await asr(audio, opts);
    self.postMessage({ type: "done", out });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
`

let worker = null
function getWorker() {
  if (!worker)
    worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })), {
      type: "module",
    })
  return worker
}

const LANGS = [
  ["", "Detect language"],
  ["english", "English"],
  ["spanish", "Spanish"],
  ["french", "French"],
  ["german", "German"],
  ["italian", "Italian"],
  ["portuguese", "Portuguese"],
  ["dutch", "Dutch"],
  ["japanese", "Japanese"],
  ["chinese", "Chinese"],
  ["korean", "Korean"],
  ["hindi", "Hindi"],
  ["russian", "Russian"],
  ["vietnamese", "Vietnamese"],
]

export function openCaptions() {
  const p = state.project
  const dur = projectDuration(p)
  if (!dur) return toast("Add a video or audio clip first", "error")
  const lang = h(
    "select",
    {},
    LANGS.map(([v, l]) => h("option", { value: v }, l)),
  )
  const style = h(
    "select",
    {},
    [
      ["bold", "Bold white, black outline"],
      ["box", "White on a dark box"],
      ["yellow", "Yellow, black outline"],
    ].map(([v, l]) => h("option", { value: v }, l)),
  )
  const words = h(
    "select",
    {},
    [3, 5, 7, 10].map((n) => h("option", { value: n, selected: n === 5 }, `Up to ${n} words`)),
  )
  const bar = h("div", { class: "bar" })
  const status = h("div", { class: "export-status" })
  const run = h(
    "div",
    { class: "export-run", hidden: true },
    h("div", { class: "progress" }, bar),
    status,
  )
  const go = h(
    "button",
    { class: "btn primary big", type: "button", onclick: (e) => busy(e.currentTarget, start) },
    icon("sparkles", 16),
    "Generate captions",
  )
  const body = h(
    "div",
    { class: "captions" },
    h(
      "p",
      { class: "muted small" },
      "Transcribes the timeline's audio on this device. The first run downloads a speech model (about 80 MB).",
    ),
    h(
      "div",
      { class: "export-settings" },
      row("Language", lang),
      row("Length", words),
      row("Style", style),
    ),
    run,
    h("div", { class: "export-foot" }, h("div", { class: "grow" }), go),
  )
  const m = modal("Auto captions", body)

  function row(label, ctl) {
    return h(
      "div",
      { class: "row" },
      h("label", { class: "row-label" }, label),
      h("div", { class: "row-ctl" }, ctl),
    )
  }

  async function start() {
    const projectId = state.id
    run.hidden = false
    status.textContent = "Reading audio"
    const job = { cancelled: false, onCancel: [] }
    const mixed = await mixAudio(state.project, state.media, 0, dur, job, 16000, 1)
    if (!mixed) {
      status.textContent = "There's no audio on the timeline"
      return
    }
    const audio = mixed.getChannelData(0)
    const w = getWorker()
    const files = new Map()
    const result = await new Promise((resolve, reject) => {
      w.onmessage = (e) => {
        const d = e.data
        if (d.type === "progress" && d.p?.file) {
          if (d.p.status === "progress")
            files.set(d.p.file, { loaded: d.p.loaded, total: d.p.total })
          let a = 0
          let b = 0
          for (const f of files.values()) {
            a += f.loaded || 0
            b += f.total || 0
          }
          if (b) {
            bar.style.width = ((a / b) * 100).toFixed(1) + "%"
            status.textContent = `Downloading speech model · ${Math.round(a / 1048576)} of ${Math.round(b / 1048576)} MB`
          }
        } else if (d.type === "device") {
          status.textContent = d.device === "webgpu" ? "Loading model (GPU)" : "Loading model"
        } else if (d.type === "status") {
          bar.style.width = "100%"
          bar.classList.add("indeterminate")
          status.textContent = `Transcribing ${Math.round(dur)} seconds of audio`
        } else if (d.type === "done") resolve(d.out)
        else if (d.type === "error") reject(new Error(d.message))
      }
      w.onerror = (e) => reject(new Error(e.message || "The speech model failed to load"))
      w.postMessage({ audio, language: lang.value || null })
    }).catch((e) => {
      bar.classList.remove("indeterminate")
      status.textContent = "Couldn't transcribe: " + e.message
      worker?.terminate()
      worker = null
      return null
    })
    if (!result) return
    if (state.id !== projectId)
      return toast("Captions were ready, but you had opened another project", "error")
    const n = addCaptions(result.chunks || [], { maxWords: +words.value, style: style.value })
    m.close()
    toast(n ? `Added ${n} captions` : "No speech found", n ? "" : "error")
  }
}

function group(chunks, maxWords) {
  const out = []
  let cur = null
  for (const c of chunks) {
    const [s, e] = c.timestamp
    const text = c.text.trim()
    if (!text || s == null) continue
    const end = e ?? s + 0.4
    const gap = cur ? s - cur.end : 0
    if (!cur || cur.words >= maxWords || gap > 0.7 || /[.!?]$/.test(cur.text)) {
      if (cur) out.push(cur)
      cur = { start: s, end, text, words: 1 }
    } else {
      cur.text += " " + text
      cur.end = end
      cur.words++
    }
  }
  if (cur) out.push(cur)
  // Hold each caption until the next one starts when the gap is short.
  for (let i = 0; i < out.length - 1; i++)
    if (out[i + 1].start - out[i].end < 0.4) out[i].end = out[i + 1].start
  return out
}

function addCaptions(chunks, { maxWords, style }) {
  const items = group(chunks, maxWords)
  if (!items.length) return 0
  const ids = []
  commit((p) => {
    const H = p.scene.height
    const l = { id: uid("l"), name: "Captions" }
    p.layers.unshift(l)
    const base = Math.round(Math.min(p.scene.width, H) * 0.075)
    const text =
      style === "box"
        ? {
            font: "Inter",
            size: base,
            weight: 700,
            color: "#ffffff",
            bg: "#000000b3",
            pad: Math.round(base * 0.3),
            radius: Math.round(base * 0.2),
          }
        : {
            font: "Montserrat",
            size: base,
            weight: 900,
            color: style === "yellow" ? "#ffe14d" : "#ffffff",
            stroke: "#000000",
            strokeWidth: Math.max(2, Math.round(base * 0.09)),
            upper: true,
            shadow: true,
          }
    for (const it of items) {
      const c = makeClip(p, "text", {
        start: it.start,
        duration: Math.max(0.3, it.end - it.start),
        text: { ...text, content: it.text, maxWidth: Math.round(p.scene.width * 0.86) },
      })
      c.name = it.text.slice(0, 40)
      c.layerId = l.id
      c.props.y = H * 0.78
      c.tin = { type: "pop", dur: 0.18 }
      p.clips.push(c)
      ids.push(c.id)
    }
  })
  select([])
  return ids.length
}
