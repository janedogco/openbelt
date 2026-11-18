import { db } from "/sdk.js"
import "./prompt.js"

const entries = db.collection("entries")

const me = await db.me()

const $ = (s) => document.querySelector(s)

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

function dayLabel(day) {
  const now = new Date()

  if (day === localDay(now)) return "Today"
  now.setDate(now.getDate() - 1)

  if (day === localDay(now)) return "Yesterday"
  const [y, m, d] = day.split("-").map(Number)

  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  })
}

const fromEmail = (email) =>
  String(email)
    .split("@")[0]
    .split(/[._-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

const time = (t) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

function hue(s) {
  let h = 0

  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360

  return h
}

if (!me) $("#compose").hidden = true

function entry(d) {
  const name = d.authorName && !d.authorName.includes("@") ? d.authorName : fromEmail(d.author)

  return `<article data-id="${d.id}">
    <div class="avatar" style="background:hsl(${hue(d.author)} 45% 48%)">${esc(name[0]?.toUpperCase())}</div>
    <div class="body">
      <div class="head"><b>${esc(d.author === me?.email ? "You" : name)}</b><span class="time">${time(d.created)}</span>
      ${me && d.author === me.email ? `<button class="del" aria-label="Delete">×</button>` : ""}</div>
      <p>${esc(d.data.text)}</p>
    </div>
  </article>`
}

function render(docs) {
  const days = new Map()

  for (const d of docs) {
    const day = d.data.day || localDay(new Date(d.created))

    if (!days.has(day)) days.set(day, [])
    days.get(day).push(d)
  }

  const order = [...days.keys()].sort().reverse()
  $("#days").innerHTML =
    order
      .map(
        (day) =>
          `<section><h2>${dayLabel(day)}</h2><div class="entries">${days.get(day).map(entry).join("")}</div></section>`,
      )
      .join("") || `<p class="empty">No entries yet</p>`
}

async function post() {
  const text = $("#text").value.trim()
  const btn = $("#compose button")

  if (!text || btn.disabled) return
  btn.classList.add("busy")
  btn.disabled = true

  try {
    await entries.add({ text, day: localDay(new Date()) })
    $("#text").value = ""
  } catch (e) {
    alert(e.message)
  } finally {
    btn.classList.remove("busy")
    btn.disabled = false
  }
}

$("#compose").onsubmit = (e) => {
  e.preventDefault()
  post()
}

$("#text").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post()
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".del")

  if (!btn) return
  btn.classList.add("busy")
  btn.disabled = true

  try {
    await entries.delete(btn.closest("article").dataset.id)
  } catch (err) {
    alert(err.message)
    btn.classList.remove("busy")
    btn.disabled = false
  }
})

entries.watch(render)
