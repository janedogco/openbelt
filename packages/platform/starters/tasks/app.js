import { db } from "/sdk.js"
import "./prompt.js"

const tasks = db.collection("tasks")

const me = await db.me()

const $ = (s) => document.querySelector(s)

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )

let byId = new Map()

let names = new Map()

const fromEmail = (email) =>
  String(email)
    .split("@")[0]
    .split(/[._-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

const who = (email, start) =>
  email === me?.email ? (start ? "You" : "you") : names.get(email) || fromEmail(email)

if (!me) $("#add").hidden = true

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

function row(d) {
  const t = d.data

  const meta = t.done
    ? t.note
      ? esc(t.note)
      : `Done by ${esc(who(d.updatedBy))}`
    : t.claimedBy
      ? `${esc(who(t.claimedBy, true))} ${t.claimedBy === me?.email ? "are" : "is"} on it`
      : `Added by ${esc(who(d.author))}`

  return `<li data-id="${d.id}" class="${t.done ? "done" : ""}">
    <button class="check" data-act="toggle" aria-label="${t.done ? "Mark open" : "Mark done"}" ${me ? "" : "disabled"}></button>
    <div class="body"><div class="title">${esc(t.title)}</div><div class="meta">${meta}</div></div>
    ${me && !t.done && !t.claimedBy ? `<button class="btn sm" data-act="take">Take</button>` : ""}
    ${me && d.author === me.email ? `<button class="del" data-act="delete" aria-label="Delete">×</button>` : ""}
  </li>`
}

function render(docs) {
  byId = new Map(docs.map((d) => [d.id, d]))
  names = new Map(
    docs
      .filter((d) => d.authorName && !d.authorName.includes("@"))
      .map((d) => [d.author, d.authorName]),
  )
  const open = docs.filter((d) => !d.data.done).reverse()
  const done = docs
    .filter((d) => d.data.done)
    .sort((a, b) => (b.data.doneAt ?? 0) - (a.data.doneAt ?? 0))
  $("#open").innerHTML = open.map(row).join("") || `<li class="empty">Nothing open</li>`
  $("#done").innerHTML = done.map(row).join("")
  $("#done-count").textContent = done.length
  $("#done-wrap").hidden = done.length === 0
}

$("#add").onsubmit = (e) => {
  e.preventDefault()
  const input = $("#title")
  const title = input.value.trim()

  if (!title) return
  busy($("#add button"), async () => {
    await tasks.add({ title, done: false, claimedBy: null, note: null, doneAt: null })
    input.value = ""
  })
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("li [data-act]")

  if (!btn) return
  const id = btn.closest("li").dataset.id
  const d = byId.get(id)
  const act = btn.dataset.act

  if (act === "toggle") {
    const done = !d.data.done
    busy(btn, () => tasks.update(id, { done, doneAt: done ? Date.now() : null }))
  }

  if (act === "take") busy(btn, () => tasks.update(id, { claimedBy: me.email }))

  if (act === "delete") busy(btn, () => tasks.delete(id))
})

tasks.watch(render)
