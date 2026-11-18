import { db } from "/sdk.js"
import "./prompt.js"

const posts = db.collection("posts")

const me = await db.me()

const $ = (s) => document.querySelector(s)

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )

const fromEmail = (email) =>
  String(email)
    .split("@")[0]
    .split(/[._-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

const nameOf = (d) =>
  d.authorName && !d.authorName.includes("@") ? d.authorName : fromEmail(d.author)

function hue(s) {
  let h = 0

  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360

  return h
}

function ago(t) {
  const s = (Date.now() - new Date(t).getTime()) / 1000

  if (s < 60) return "now"

  if (s < 3600) return `${Math.floor(s / 60)}m`

  if (s < 86400) return `${Math.floor(s / 3600)}h`

  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`

  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

let docs = []

const open = new Set()

if (!me) $("#compose").hidden = true

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

function item(d, reply) {
  const name = nameOf(d)

  return `<div class="item${reply ? " reply" : ""}" data-id="${d.id}">
    <div class="avatar" style="background:hsl(${hue(d.author)} 45% 48%)">${esc(name[0]?.toUpperCase())}</div>
    <div class="body">
      <div class="head"><b>${esc(d.author === me?.email ? "You" : name)}</b><span class="time">${ago(d.created)}</span>
      ${me && d.author === me.email ? `<button class="del" aria-label="Delete">×</button>` : ""}</div>
      <p>${esc(d.data.text)}</p>
    </div>
  </div>`
}

const replyInput = (id) => document.querySelector(`article[data-post="${id}"] .reply-form input`)

function render() {
  const drafts = {}

  for (const f of document.querySelectorAll(".reply-form"))
    drafts[f.closest("article").dataset.post] = f.querySelector("input").value
  const focused = document.activeElement?.closest?.(".reply-form")?.closest("article")?.dataset.post

  const replies = new Map()

  for (const d of [...docs].reverse()) {
    if (!d.data.parent) continue

    if (!replies.has(d.data.parent)) replies.set(d.data.parent, [])
    replies.get(d.data.parent).push(d)
  }

  $("#posts").innerHTML =
    docs
      .filter((d) => !d.data.parent)
      .map((p) => {
        const rs = replies.get(p.id) ?? []

        const action = !me
          ? ""
          : open.has(p.id)
            ? `<form class="reply-form"><input placeholder="Reply" maxlength="2000" autocomplete="off"><button class="btn sm primary">Reply</button></form>`
            : `<button class="reply-btn">Reply</button>`

        return `<article data-post="${p.id}">${item(p)}${rs.length ? `<div class="replies">${rs.map((r) => item(r, true)).join("")}</div>` : ""}${action}</article>`
      })
      .join("") || `<p class="empty">No posts yet</p>`

  for (const [id, value] of Object.entries(drafts)) if (replyInput(id)) replyInput(id).value = value

  if (focused) replyInput(focused)?.focus()
}

async function post() {
  const text = $("#text").value.trim()
  const btn = $("#compose button")

  if (!text || btn.disabled) return
  busy(btn, async () => {
    await posts.add({ text, parent: null })
    $("#text").value = ""
  })
}

$("#compose").onsubmit = (e) => {
  e.preventDefault()
  post()
}

$("#text").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post()
}

document.addEventListener("click", (e) => {
  const reply = e.target.closest(".reply-btn")

  if (reply) {
    const id = reply.closest("article").dataset.post
    open.add(id)
    render()
    replyInput(id)?.focus()

    return
  }

  const del = e.target.closest(".del")

  if (del) busy(del, () => posts.delete(del.closest(".item").dataset.id))
})

document.addEventListener("submit", (e) => {
  const form = e.target.closest(".reply-form")

  if (!form) return
  e.preventDefault()
  const id = form.closest("article").dataset.post
  const text = form.querySelector("input").value.trim()

  if (!text) return
  busy(form.querySelector("button"), async () => {
    await posts.add({ text, parent: id })
    open.delete(id)
    render()
  })
})

document.addEventListener("keydown", (e) => {
  const form = e.key === "Escape" && e.target.closest?.(".reply-form")

  if (!form) return
  open.delete(form.closest("article").dataset.post)
  render()
})

posts.watch((all) => {
  docs = all
  render()
})

setInterval(render, 60000)
