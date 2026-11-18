type File = { readonly path: string; readonly content: string }

export type SeedApp = {
  readonly app: string
  readonly by: string
  readonly files: ReadonlyArray<File>
}

const STYLE = `:root { color-scheme: light dark; --bg: #f7f7f5; --card: #fff; --ink: #1b1b18; --muted: #6b6b63; --line: #e4e4de; --accent: #3b5bdb; --ok: #2b8a3e; --warn: #b35c00; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #151513; --card: #1e1e1b; --ink: #ecece6; --muted: #a0a097; --line: #33332e; --ok: #69db7c; --warn: #ffa94d; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); }
main { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; display: grid; gap: 20px; }
header h1 { margin: 0; font-size: 28px; line-height: 1.2; letter-spacing: -0.01em; }
header p { margin: 6px 0 0; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; display: grid; gap: 10px; min-width: 0; }
.card h2 { margin: 0; font-size: 16px; }
.card p { margin: 0; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.row { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; padding: 10px 0; border-top: 1px solid var(--line); min-width: 0; }
.row:first-child { border-top: 0; padding-top: 0; }
.row .what { min-width: 0; display: grid; gap: 2px; }
.row .what b { font-weight: 600; overflow-wrap: anywhere; }
.pill { flex: none; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.pill.open { color: var(--ok); border-color: currentColor; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; text-decoration: none; cursor: pointer; justify-self: start; }
.btn.quiet { background: transparent; color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: default; }
form.ask { display: grid; gap: 8px; }
input, textarea { font: inherit; font-size: 16px; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; width: 100%; min-width: 0; }
textarea { min-height: 72px; resize: vertical; }
.answer { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; }
.notice { color: var(--warn); }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: 8px 0; border-top: 1px solid var(--line); vertical-align: top; }
th { font-size: 13px; color: var(--muted); font-weight: 500; border-top: 0; }
`

const page = (title: string, accent: string, body: string, script = "") => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="style.css">
<style>:root { --accent: ${accent}; }</style>
<main>
${body}
</main>
${script === "" ? "" : `<script type="module">\n${script}\n</script>`}
</html>
`

type OpenBeltJson = {
  readonly description: string
  readonly tools?: Readonly<Record<string, "workspace" | "viewer">>
}

const openbelt = (fields: OpenBeltJson): File => ({
  path: "openbelt.json",
  content: `${JSON.stringify(fields, null, 2)}\n`,
})

const files = (html: string, json: File): ReadonlyArray<File> => [
  { path: "index.html", content: html },
  { path: "style.css", content: STYLE },
  json,
]

const IMPORT = `import { db, tools } from "/sdk.js"\n\n`

const prsScript = (heading: string) => `const $ = (id) => document.getElementById(id)
const say = (state, html) => { document.body.dataset.state = state; $("prs").innerHTML = html }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

const me = await db.me()
$("who").textContent = me === null ? "Nobody is signed in" : "${heading}, signed in as " + me.name

try {
  const r = await tools.call("github.list_pull_requests", { state: "all" })
  const prs = JSON.parse(r.text)
  const open = prs.filter((p) => p.state === "open")
  say("ok", prs.length === 0
    ? '<p class="muted">You have no pull requests.</p>'
    : '<p class="small muted">' + open.length + " open, " + (prs.length - open.length) + " closed</p>" +
      prs.map((p) => '<div class="row"><div class="what"><b>' + esc(p.title) + '</b><span class="small muted">' + esc(p.repo) + " #" + p.number +
        (p.reviewers.length === 0 ? " · no reviewers yet" : " · review: " + esc(p.reviewers.join(", "))) +
        '</span></div><span class="pill ' + p.state + '">' + p.state + "</span></div>").join(""))
} catch (e) {
  if (e.code === "needs_token" || e.code === "needs_consent")
    say("connect", "<p>Connect your GitHub to see your pull requests here. OpenBelt keeps the token; this page never sees it.</p>" +
      '<a class="btn" id="connect" href="' + esc(e.url) + '">Connect GitHub</a>')
  else if (e.code === "signed_out" || e.code === "check_readonly")
    say("signed-out", '<p class="muted">Open this from a device signed in to the workspace to see your own pull requests.</p>')
  else if (e.code === "not_allowed")
    say("blocked", '<p class="notice">GitHub is off for you here.</p><p class="small muted">' + esc(e.message.replace(/ \\(trace \\w+\\)$/, "")) + "</p>")
  else say("failed", '<p class="notice">Couldn\\'t load them (' + esc(e.code) + ').</p><p class="small muted">' + esc(e.message) + "</p>")
}
`

const askScript = (tool: string) => `$("ask").addEventListener("submit", async (event) => {
  event.preventDefault()
  const button = $("ask").querySelector("button")
  button.disabled = true
  $("answer").textContent = "Asking DeepWiki: this takes 10 to 60 seconds."
  try {
    const r = await tools.call("${tool}", { repoName: $("repo").value.trim(), question: $("question").value.trim() })
    $("answer").textContent = r.text
  } catch (e) {
    $("answer").textContent = e.message
  } finally {
    button.disabled = false
  }
})
`

const ASK_FORM = `<form class="ask" id="ask">
<input id="repo" value="UsefulSoftwareCo/executor" aria-label="Repository" placeholder="owner/repo">
<textarea id="question" aria-label="Question">How does it store each person's tokens?</textarea>
<button class="btn" type="submit">Ask DeepWiki</button>
</form>
<div class="answer small" id="answer"></div>`

const myPrs = (heading: string, note: string) =>
  page(
    heading,
    "#3b5bdb",
    `<header><h1>${heading}</h1><p id="who">Loading</p></header>
${note}<section class="card"><h2>Pull requests</h2><div id="prs"><p class="muted">Loading</p></div></section>
<section class="card"><h2>Ask about a repo</h2><p class="small muted">DeepWiki answers as the workspace, for anyone.</p>${ASK_FORM}</section>`,
    `${IMPORT}${prsScript("Your pull requests")}\n${askScript("deepwiki.ask_wiki_question")}`,
  )

const MY_PRS_JSON = openbelt({
  description: "Your open pull requests across repos, and ask DeepWiki about one",
  tools: {
    "github.list_pull_requests": "viewer",
    "github.get_me": "viewer",
    "deepwiki.ask_wiki_question": "workspace",
  },
})

export const MY_PRS: SeedApp = {
  app: "my-prs",
  by: "alice",
  files: files(myPrs("My pull requests", ""), MY_PRS_JSON),
}

export const MY_PRS_REDESIGN: SeedApp = {
  app: "my-prs",
  by: "alice",
  files: files(
    myPrs(
      "My pull requests",
      `<section class="card"><p><b>Redesign preview.</b> <span class="muted">Alice is trying a new layout here; the live app hasn't changed.</span></p></section>\n`,
    ),
    MY_PRS_JSON,
  ),
}

export const prDigest = (grown: boolean): SeedApp => ({
  app: "pr-digest",
  by: "alice",
  files: files(
    page(
      "PR digest",
      "#7048e8",
      `<header><h1>PR digest</h1><p id="who">Loading</p></header>
<section class="card"><h2>This week</h2><div id="prs"><p class="muted">Loading</p></div></section>`,
      `${IMPORT}${prsScript("This week's pull requests")}`,
    ),
    openbelt({
      description: "A weekly digest of your pull requests",
      tools: grown
        ? { "github.list_pull_requests": "viewer", "github.get_me": "viewer" }
        : { "github.list_pull_requests": "viewer" },
    }),
  ),
})

export const REPO_QA: SeedApp = {
  app: "repo-qa",
  by: "bob",
  files: files(
    page(
      "Repo Q&A",
      "#0c8599",
      `<header><h1>Repo Q&amp;A</h1><p>Ask DeepWiki anything about a public GitHub repo. It runs as the workspace: nobody connects anything.</p></header>
<section class="card">${ASK_FORM}</section>`,
      `${IMPORT}const $ = (id) => document.getElementById(id)\n${askScript("deepwiki.ask_wiki_question")}`,
    ),
    openbelt({
      description: "Ask DeepWiki about any public repo, as the workspace",
      tools: { "deepwiki.ask_wiki_question": "workspace" },
    }),
  ),
}

export const SHIP_IT: SeedApp = {
  app: "ship-it",
  by: "carol",
  files: files(
    page(
      "Ship it",
      "#e8590c",
      `<header><h1>Ship it</h1><p>Merge your green pull requests in one click.</p></header>
<section class="card"><h2>Ready to merge</h2><div id="prs"><p class="muted">Loading</p></div></section>`,
      `import { tools } from "/sdk.js"

const box = document.getElementById("prs")
const [merge] = await tools.list()
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
document.body.dataset.state = merge.usable ? "ok" : merge.code
box.innerHTML = merge.usable
  ? '<p>Nothing is waiting to merge.</p>'
  : '<p class="notice">Merging is off for you.</p><p class="small muted">' + esc(merge.message) + "</p>"`,
    ),
    openbelt({
      description: "Merge green pull requests in one click",
      tools: { "github.merge_pull_request": "viewer" },
    }),
  ),
}

const table = (head: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`

const plain = (
  app: string,
  by: string,
  title: string,
  accent: string,
  lead: string,
  body: string,
  description: string,
): SeedApp => ({
  app,
  by,
  files: files(
    page(title, accent, `<header><h1>${title}</h1><p>${lead}</p></header>\n${body}`),
    openbelt({ description }),
  ),
})

export const POKEDEX: SeedApp = {
  app: "pokedex",
  by: "alice",
  files: files(
    page(
      "Pokédex",
      "#e8590c",
      `<header><h1>Pokédex</h1><p>Look a Pokémon up on PokeAPI: its types, stats and sprite.</p></header>
<section class="card"><form class="ask" id="find"><input id="name" value="pikachu" aria-label="Pokémon"><button class="btn">Look up</button></form></section>
<section class="card" id="mon"><p class="muted">Loading…</p></section>`,
      `${IMPORT}const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const show = async (name) => {
  $("mon").innerHTML = '<p class="muted">Loading…</p>'
  try {
    const r = await tools.call("pokeapi.pokemon_retrieve", { id: name.toLowerCase() }, {
      fields: ["name", "types.type.name", "stats.base_stat", "stats.stat.name", "sprites.front_default"],
    })
    const p = JSON.parse(r.text)
    document.body.dataset.state = "ok"
    $("mon").innerHTML = '<div class="row"><div class="what"><b>' + esc(p.name) + '</b><span class="small muted">' +
      p.types.map((t) => esc(t.type.name)).join(", ") + "</span></div>" +
      (p.sprites.front_default ? '<img alt="" width="96" height="96" src="' + esc(p.sprites.front_default) + '">' : "") + "</div>" +
      "<table>" + p.stats.map((s) => "<tr><td>" + esc(s.stat.name) + "</td><td>" + s.base_stat + "</td></tr>").join("") + "</table>" +
      '<p class="small muted">' + r.text.length + " bytes reached this page, trace " + esc(r.trace) + "</p>"
  } catch (e) {
    document.body.dataset.state = "failed"
    $("mon").innerHTML = '<p class="notice">' + esc(e.message) + "</p>"
  }
}
$("find").addEventListener("submit", (event) => { event.preventDefault(); show($("name").value.trim()) })
show("pikachu")
`,
    ),
    openbelt({
      description: "Look up a Pokémon on PokeAPI: types, stats and sprite",
      tools: { "pokeapi.pokemon_retrieve": "workspace" },
    }),
  ),
}

export const PET_SHOP: SeedApp = {
  app: "pet-shop",
  by: "bob",
  files: files(
    page(
      "Pet shop",
      "#5f3dc4",
      `<header><h1>Pet shop</h1><p id="who">The pets for sale, from the Petstore API.</p></header>
<section class="card"><form class="ask" id="add"><input id="name" value="Biscuit" aria-label="Name"><button class="btn">Add a pet</button></form><p id="said" class="small muted"></p></section>
<section class="card" id="pets"><p class="muted">Loading…</p></section>`,
      `${IMPORT}const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const load = async () => {
  try {
    const r = await tools.call("petstore.findPetsByStatus", { status: "available" }, { fields: ["id", "name"] })
    const pets = JSON.parse(r.text).filter((p) => p.name).slice(-15).reverse()
    document.body.dataset.state = "ok"
    $("pets").innerHTML = pets.map((p) => '<div class="row"><div class="what"><b>' + esc(p.name) + '</b><span class="small muted">#' + p.id +
      '</span></div><button class="btn quiet" data-id="' + p.id + '" data-name="' + esc(p.name) + '">Mark sold</button></div>').join("")
  } catch (e) {
    document.body.dataset.state = "failed"
    $("pets").innerHTML = '<p class="notice">' + esc(e.message) + "</p>"
  }
}
const write = async (what, call) => {
  $("said").textContent = what + "…"
  try { await call(); $("said").textContent = what + ": done"; await load() }
  catch (e) { $("said").textContent = e.code === "not_allowed" ? e.message.replace(/ (trace w+)$/, "") : what + " failed: " + e.message }
}
$("add").addEventListener("submit", (event) => {
  event.preventDefault()
  // Petstore's own server needs an id, though its spec says it's optional.
  write("Adding " + $("name").value, () => tools.call("petstore.addPet", { body: { id: Date.now() % 1e9, name: $("name").value.trim(), status: "available", photoUrls: [] } }))
})
$("pets").addEventListener("click", (event) => {
  const b = event.target.closest("button[data-id]")
  if (b) write("Selling " + b.dataset.name, () => tools.call("petstore.updatePet", { body: { id: Number(b.dataset.id), name: b.dataset.name, status: "sold", photoUrls: [] } }))
})
load()
`,
    ),
    openbelt({
      description: "The pets for sale, from the Petstore API: eng add and sell them",
      tools: {
        "petstore.findPetsByStatus": "workspace",
        "petstore.addPet": "workspace",
        "petstore.updatePet": "workspace",
      },
    }),
  ),
}

export const PLAIN: ReadonlyArray<SeedApp> = [
  plain(
    "lunch",
    "alice",
    "Lunch this week",
    "#2f9e44",
    "Where the office eats, and who's in.",
    `<section class="card">${table(
      ["Day", "Place", "Going"],
      [
        ["Monday", "Tacos El Gordo", "Alice, Bob, Carol"],
        ["Tuesday", "Pho Saigon", "Ada, Bob"],
        ["Wednesday", "The salad place", "Alice"],
        ["Thursday", "Pizza Friday, a day early", "Everyone"],
      ],
    )}</section>`,
    "Where the office eats this week, and who's in",
  ),
  plain(
    "oncall",
    "bob",
    "On call",
    "#c92a2a",
    "Who to page this week, and who's next.",
    `<section class="card">${table(
      ["Week", "Primary", "Secondary"],
      [
        ["Oct 20", "Bob", "Alice"],
        ["Oct 27", "Alice", "Ada"],
        ["Nov 3", "Ada", "Bob"],
      ],
    )}</section>
<section class="card"><h2>Runbooks</h2><p class="muted">The API is slow · The deploy is stuck · A customer can't sign in</p></section>`,
    "Who's on call this week, and the runbooks",
  ),
  plain(
    "handbook",
    "ada",
    "Team handbook",
    "#5f3dc4",
    "How we work: shipping, reviews, time off.",
    `<section class="card"><h2>Shipping</h2><p>Small changes, reviewed by one person, live the same day.</p></section>
<section class="card"><h2>Reviews</h2><p>Ask for one when it's ready; answer within a working day.</p></section>
<section class="card"><h2>Time off</h2><p>Put it in the calendar and tell your team. No approval needed.</p></section>`,
    "How we work: shipping, reviews and time off",
  ),
  plain(
    "okrs",
    "ada",
    "Q4 goals",
    "#1971c2",
    "What we said we'd do this quarter, and how it's going.",
    `<section class="card">${table(
      ["Goal", "Owner", "Status"],
      [
        ["Every team has an app it uses daily", "Ada", "On track"],
        ["Connections for GitHub and Linear", "Bob", "Shipped"],
        ["Onboarding under ten minutes", "Alice", "At risk"],
      ],
    )}</section>`,
    "This quarter's goals and how each is going",
  ),
]
