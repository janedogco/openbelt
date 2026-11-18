import { db } from "/sdk.js"
import "./prompt.js"

const strokes = db.collection("strokes")

const me = await db.me()

const $ = (s) => document.querySelector(s)

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )

const W = 1000

const H = 750

const COLORS = ["#1d1b18", "#e0457b", "#2f6fed", "#1f9d6b", "#f2a516"]

const canvas = $("canvas")

const ctx = canvas.getContext("2d")

const base = document.createElement("canvas")

const bctx = base.getContext("2d")

let docs = []

let pending = []

let current = null

let color = COLORS[0]

let size = 5

const fromEmail = (email) =>
  String(email)
    .split("@")[0]
    .split(/[._-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

function hue(s) {
  let h = 0

  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360

  return h
}

$("#colors").innerHTML = COLORS.map(
  (c, i) =>
    `<button data-color="${c}" aria-label="Colour ${i + 1}" class="${i ? "" : "on"}"><i style="background:${c}"></i></button>`,
).join("")

$("#colors").onclick = (e) => {
  const b = e.target.closest("button")

  if (!b) return
  color = b.dataset.color

  for (const x of $("#colors").children) x.classList.toggle("on", x === b)
}

$("#sizes").onclick = (e) => {
  const b = e.target.closest("button")

  if (!b) return
  size = Number(b.dataset.size)

  for (const x of $("#sizes").children) x.classList.toggle("on", x === b)
}

if (!me) $("#tools").hidden = true

function line(c, { points, color, size }) {
  if (!points?.length) return
  c.strokeStyle = color
  c.fillStyle = color
  c.lineWidth = size
  c.lineCap = "round"
  c.lineJoin = "round"

  if (points.length === 1) {
    c.beginPath()
    c.arc(points[0][0], points[0][1], size / 2, 0, Math.PI * 2)
    c.fill()

    return
  }

  c.beginPath()
  c.moveTo(points[0][0], points[0][1])

  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2)
  }

  const last = points[points.length - 1]
  c.lineTo(last[0], last[1])
  c.stroke()
}

function drawBase() {
  const s = base.width / W
  bctx.setTransform(1, 0, 0, 1, 0, 0)
  bctx.clearRect(0, 0, base.width, base.height)
  bctx.setTransform(s, 0, 0, s, 0, 0)

  for (const d of docs) line(bctx, d.data)

  for (const p of pending) line(bctx, p)
  draw()
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(base, 0, 0)

  if (current) {
    const s = canvas.width / W
    ctx.setTransform(s, 0, 0, s, 0, 0)
    line(ctx, current)
  }
}

function resize() {
  const r = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = base.width = Math.round(r.width * dpr)
  canvas.height = base.height = Math.round(r.height * dpr)
  drawBase()
}

new ResizeObserver(resize).observe(canvas)

const pos = (e) => {
  const r = canvas.getBoundingClientRect()

  return [
    Math.round(((e.clientX - r.left) / r.width) * W),
    Math.round(((e.clientY - r.top) / r.height) * H),
  ]
}

canvas.onpointerdown = (e) => {
  if (!me) return
  canvas.setPointerCapture(e.pointerId)
  current = { color, size, points: [pos(e)] }
  draw()
}

canvas.onpointermove = (e) => {
  if (!current) return
  const p = pos(e)
  const l = current.points[current.points.length - 1]

  if (Math.hypot(p[0] - l[0], p[1] - l[1]) < 3) return
  current.points.push(p)
  draw()

  if (current.points.length >= 1500) finish()
}

canvas.onpointerup = canvas.onpointercancel = () => finish()

async function finish() {
  if (!current) return
  const stroke = current
  current = null
  pending.push(stroke)
  drawBase()

  try {
    await strokes.add(stroke)
  } catch (e) {
    alert(e.message)
  } finally {
    pending = pending.filter((p) => p !== stroke)
    drawBase()
  }
}

async function busy(btn, work) {
  btn.classList.add("busy")
  btn.disabled = true

  try {
    await work()
  } catch (e) {
    alert(e.message)
  } finally {
    btn.classList.remove("busy")
    btn.disabled = false
  }
}

$("#undo").onclick = () => {
  const mine = [...docs].reverse().find((d) => d.author === me?.email)

  if (mine) busy($("#undo"), () => strokes.delete(mine.id))
}

$("#clear").onclick = () => {
  if (!docs.length || !confirm("Clear the board for everyone?")) return
  busy($("#clear"), async () => {
    const ids = docs.map((d) => d.id)

    for (let i = 0; i < ids.length; i += 20)
      await Promise.all(ids.slice(i, i + 20).map((id) => strokes.delete(id).catch(() => {})))
  })
}

function renderPeople() {
  const people = new Map()

  for (const d of docs)
    people.set(
      d.author,
      d.authorName && !d.authorName.includes("@") ? d.authorName : fromEmail(d.author),
    )
  $("#people").innerHTML = [...people]
    .slice(-5)
    .map(
      ([email, name]) =>
        `<span title="${esc(name)}" style="background:hsl(${hue(email)} 45% 48%)">${esc(name[0]?.toUpperCase())}</span>`,
    )
    .join("")
}

strokes.watch((all) => {
  docs = [...all].reverse()
  drawBase()
  renderPeople()
})
