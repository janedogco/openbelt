import { db, appUrl } from "/sdk.js"
import "./prompt.js"

const me = await db.me()

const $ = (s) => document.querySelector(s)

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )

const ms = (t) => new Date(t).getTime()

const DAY = 86400000

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

const APPS = {
  tasks: { name: "Tasks", color: "#2f6fed", collection: "tasks" },
  journal: { name: "Journal", color: "#c27a1e", collection: "entries" },
  sketch: { name: "Sketch", color: "#e0457b", collection: "strokes" },
  messages: { name: "Messages", color: "#7c5cd6", collection: "posts" },
}

const data = {}

const urls = {}

for (const app of Object.keys(APPS)) urls[app] = await appUrl(app)

const present = new Set((await db.apps()).map((a) => a.app))
const shown = Object.keys(APPS).filter((app) => present.has(app))
const and = (parts) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`

$("#about").innerHTML =
  shown.length === 0
    ? "Pulse shows Tasks, Journal, Sketch and Messages live, once you add them."
    : `Pulse reads ${and(shown.map((app) => `<a href="${urls[app]}">${APPS[app].name}</a>`))} live, as they change.`

const names = new Map()

const fromEmail = (email) =>
  String(email)
    .split("@")[0]
    .split(/[._-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

const who = (email, start = true) =>
  email === me?.email ? (start ? "You" : "you") : names.get(email) || fromEmail(email)

function ago(t) {
  const s = (Date.now() - t) / 1000

  if (s < 60) return "now"

  if (s < 3600) return `${Math.floor(s / 60)}m`

  if (s < 86400) return `${Math.floor(s / 3600)}h`

  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`

  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function stats() {
  const out = []
  const week = Date.now() - 7 * DAY

  if (data.tasks) {
    const open = data.tasks.filter((d) => !d.data.done).length
    const done = data.tasks.filter((d) => d.data.done && (d.data.doneAt ?? 0) > week).length
    out.push(["tasks", open, `open · ${done} done this week`])
  }

  if (data.journal) {
    const today = localDay(new Date())
    const n = data.journal.filter(
      (d) => (d.data.day || localDay(new Date(d.created))) === today,
    ).length
    out.push(["journal", n, n === 1 ? "entry today" : "entries today"])
  }

  if (data.sketch) {
    const people = new Set(data.sketch.map((d) => d.author)).size
    out.push([
      "sketch",
      data.sketch.length,
      `${data.sketch.length === 1 ? "stroke" : "strokes"} · ${people} ${people === 1 ? "person" : "people"}`,
    ])
  }

  if (data.messages) {
    const posts = data.messages.filter((d) => !d.data.parent).length
    const replies = data.messages.length - posts
    out.push([
      "messages",
      posts,
      `${posts === 1 ? "post" : "posts"} · ${replies} ${replies === 1 ? "reply" : "replies"}`,
    ])
  }

  return out
}

function feed() {
  const items = []

  for (const d of data.tasks ?? []) {
    const t = d.data

    if (t.done)
      items.push([
        "tasks",
        t.doneAt ?? ms(d.updated),
        `${who(d.updatedBy)} checked off "${t.title}"`,
      ])
    else if (t.claimedBy)
      items.push(["tasks", ms(d.updated), `${who(t.claimedBy)} took "${t.title}"`])
    else items.push(["tasks", ms(d.created), `${who(d.author)} added "${t.title}"`])
  }

  for (const d of data.journal ?? [])
    items.push(["journal", ms(d.created), `${who(d.author)}: ${d.data.text}`])

  for (const d of data.messages ?? [])
    items.push([
      "messages",
      ms(d.created),
      `${who(d.author)} ${d.data.parent ? "replied" : "posted"}: ${d.data.text}`,
    ])
  const lastStroke = new Map()

  for (const d of data.sketch ?? [])
    if (!lastStroke.has(d.author)) lastStroke.set(d.author, ms(d.created))

  for (const [author, t] of lastStroke)
    items.push(["sketch", t, `${who(author)} drew on the sketch`])

  return items.sort((a, b) => b[1] - a[1]).slice(0, 12)
}

function render() {
  for (const docs of Object.values(data))
    for (const d of docs)
      if (d.authorName && !d.authorName.includes("@")) names.set(d.author, d.authorName)
  $("#stats").innerHTML = stats()
    .map(
      ([app, num, sub]) =>
        `<a class="stat" href="${urls[app]}"><div class="name"><span class="dot" style="background:${APPS[app].color}"></span>${APPS[app].name}</div><div class="num">${num}</div><div class="sub">${sub}</div></a>`,
    )
    .join("")
  const items = feed()
  $("#feed").innerHTML =
    items
      .map(
        ([app, t, text]) =>
          `<li><a href="${urls[app]}"><span class="dot" style="background:${APPS[app].color}"></span><span class="text">${esc(text)}</span><span class="when">${ago(t)}</span></a></li>`,
      )
      .join("") || `<li class="empty">Nothing yet</li>`
}

for (const app of shown) {
  db.app(app)
    .collection(APPS[app].collection)
    .watch(
      (docs) => {
        data[app] = docs
        render()
      },
      {
        onError: () => {
          delete data[app]
          render()
        },
      },
    )
}

setInterval(render, 60000)

render()
