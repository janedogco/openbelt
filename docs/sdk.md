---
title: SDK
description: The /sdk.js module every page can import: mutable JSON documents in collections (add, get, set, update, delete), paging, maintained counts and integer totals (db.aggregate), watch() and subscribe() for live changes, other apps' data and links, files people upload (files.put, a url for <img>), the workspace's connections (tools.call), preview environments, who is viewing, the person's theme, errors and limits.
---

# SDK

Every page on OpenBelt can import `/sdk.js`. It works on the app the page belongs to (the first
segment of the page's path), with no keys or setup:

```html
<script type="module">
  import { db } from "/sdk.js"

  const cards = db.collection("cards")
  const card = await cards.add({ title: "Ship login", column: "todo" }) // { id, data, seq, ... }
  await cards.update(card.id, { column: "doing" }) // move it: merge fields in
  await cards.delete(card.id)
  await db.collection("votes").set("ada", { place: "tacos" }) // your own id: one per person
  cards.watch((docs, change) => render(docs)) // every card now, then again after each change
</script>
```

## Documents

- Documents are mutable: keep one document per thing (a card, a vote) and change it in place;
  set(id) gives one-per-person. Don't add events and work out the latest state.
- To show or total a whole collection (a feed, a scoreboard, a board), use watch(). It reads
  every document (paging for you), then calls again after every add, update and delete, with no
  gap between the read and the live changes. `watch(listener, { onError })` returns a stop
  function. Render from `docs` on every call: when a write lands while the page is still
  connecting, watch() reads again and calls once more with `change` null.
- A document is `{ id, collection, data, author, authorName, updatedBy, created, updated, seq }`.
  `author` and `authorName` say who created it, `updatedBy` who wrote it last
  ([Who is viewing](./viewers.md)). `seq` is the app-wide write that last changed it, so it rises
  on every update. Lists are newest first by creation: an edited document keeps its place.
- `get(id)` resolves to the document or null. A miss is a 200 with null, not a failed request, so
  `check_app` doesn't list it (a plain HTTP GET of a missing id is still a 404). `set(id, data)`
  creates or replaces it; ids are 1-100 letters, digits and `_ . : @ + -`. `update(id, patch)`
  merges fields (shallow). `update` and `delete` of a missing id are a 404.
- `set(id, data, { ifSeq: doc.seq })`, `update(id, patch, { ifSeq })` and `delete(id, { ifSeq })`
  are refused with a 409 if someone changed the document since you read it; the error's `seq` is
  the current one. `{ ifSeq: 0 }` on set and update means "must not exist yet": it creates the
  document. On an existing id the rules are checked before `ifSeq`, so it's a 403 denial when the
  update rule refuses you, otherwise a 409 with the existing one's `seq` (two people creating the
  same id: the second is refused). Without `ifSeq`, the last write wins.
- `list({ limit, cursor })` is one page: `{ docs, cursor }`, `limit` 1-1000 (default 100). Pass the
  cursor back for the next page; it's null at the end.
- `subscribe(({ op, doc }) => ...)` is the raw feed of every change, by any page or agent: `op` is
  "add", "update" or "delete" (`doc` then has the delete's `seq` and `data: null`: keep what you
  need from a document before it goes). It
  returns a stop function. After a reconnect it first replays what it missed.
- Limits: documents up to 64 KB, collection names 1-40 lowercase letters, digits, `_` and `-`,
  starting with a letter or digit. A
  collection exists once something is written to it.

## Importing documents over MCP

For imports and seed data, call `collection_add` with `docs: [{ data }, ...]` in groups of 100,
up to 500 per call. Use one call per group instead of a loop of single-document calls or
`Promise.all` of individual writes. The browser SDK's `add(data)` still writes one document.

```json
{
  "app": "board",
  "collection": "cards",
  "docs": [
    { "id": "import-1", "data": { "title": "Ship login" } },
    { "id": "import-2", "data": { "title": "Write release notes" } }
  ]
}
```

Each group is one transaction: all documents are written or none are. The result contains
`written` and `docs` with each document's `id` and `seq`. If a later group fails, earlier groups
remain. Stop on a refusal, fix it, and resume from the failed group. After a lost response, read
back the supplied ids before retrying; an import with generated ids can duplicate documents.
Do not wait to accumulate a batch for a person's interactive write.

## Using another app's data

Apps in a workspace can read each other's data. Start with `search` for what you need: the
apps that match, with their matching collections. `app_info` gives one app's collections in full:
`about` (what a document holds, from its openbelt.json), `docs`, `lastWrite`, `writable`, `rules`
and the newest document of each as a sample. An openbelt.json description is
the contract; a sample is one document, not a promise about the rest. With no `about`, read the
app with `app_files` before you rely on a field.

```js
import { db } from "/sdk.js"

const votes = db.app("lunch").collection("votes") // the same API as db.collection()
votes.watch((docs) => render(docs)) // get, list, subscribe, watch

await db.apps() // [{ app, url, description, owner, env }]
await db.app("lunch").collections() // [{ name, about, docs, lastWrite, writable, rules }]
```

- Reads are open inside the workspace. A page's write (add, set, update, delete) to another app's
  collection is refused with a 403 unless that app's openbelt.json lists it under `"writable"`,
  and that app's rules judge it like its own pages' writes. `db.collections()` lists this app's.
- In a preview environment, `db.app(other)` uses other's data there when other is in it, else its
  live data, read-only (a page in an environment never changes live data). Link with
  `appUrl(other, path)`, which stays in the environment when other is in it.
- After a reconnect, another app's `subscribe` and `watch` replay what they missed, like your own.
  Another app going live doesn't reload your page.
- Which app a call comes from is the host it's sent to: each app is on its own host, and
  `db.app("lunch")` calls `/a/lunch/_db/...` on your app's host, so it's your app's. A page can't
  send a call as another app: a request to another app's host from your page (a `fetch`, a form,
  a WebSocket) is refused with a 403 (another origin), and headers a page sets don't count. Scripts
  (curl) aren't pages: a request to an app's host is that app's.
- Over MCP, `collection_add`, `collection_update` and `collection_delete` work on any app: check
  with its owner before you write to someone else's.

## Files

Pictures, PDFs, videos and other files people upload go to `files`, not into documents (a
document is at most 64 KB). Keep the file's record in a document, and use its `url` wherever the
file is shown:

```js
import { db, files } from "/sdk.js"

input.onchange = async () => {
  const file = await files.put(input.files[0]) // { id, url, name, type, size, sha256 }
  await db.collection("photos").add({ file, caption: "" })
}

db.collection("photos").watch((docs) => {
  grid.innerHTML = docs.map((d) => `<img src="${d.data.file.url}" alt="">`).join("")
})

await files.delete(file.id) // the bytes and the record; the workspace gets the room back
```

- `files.put(blob, { name, onProgress, signal })` streams a `File` or `Blob` (its `type` is the
  file's type; a `File` keeps its name). `onProgress({ loaded, total })` is called as the bytes go
  out, for a progress bar; `signal` (an `AbortController`'s) cancels it, rejecting with code
  `aborted`. An upload that fails or is cancelled keeps nothing: sending it again sends it whole.
  A dropped connection rejects with code `unreachable` (status 0); `busy` is retried for you,
  anything else is yours to retry.
- The `url` is `/a/<app>/_files/<id>`: it works on every app's host in the workspace, so another app's
  page shows the file too, as whoever is viewing. Anyone in the workspace can view a file whose `url`
  they have.
- Only the person who uploaded a file deletes it: anyone else's `files.delete` is a 403 `denied`
  with `rule` `"files.delete"`, like a rule's denial (not reported as a browser error). Show a delete button only on a person's own files (the document you keep
  for it has them as `author`). Only the app's own pages upload and delete (another app's is a
  403 `not_writable`).
- Upload the file, then write a document that names it (its `file` object, or its `id` or `url`
  in any field, or the file's `id` as the document's own: `set(file.id, ...)`). A file no document of its app names 24 hours after its upload is deleted, with
  a line in `app_logs`: one whose page closed before the document was written, or whose document
  was deleted without it. A copy of its `url` in another app's data doesn't keep it.
- Files come back with their type, ranges (a `<video>` seeks) and a cache that never expires. Images,
  video, audio, PDF and plain text show in the page; any other type (HTML, SVG, a script, a zip)
  downloads instead, and nothing a file holds ever runs as the app.
- Limits: 100 MB a file and 10 GB for the workspace's files together, unless whoever runs OpenBelt
  set others (`uploads.fileLimit` and `uploads.workspaceLimit` in `app_info`, in bytes; a MB here is
  1,048,576 bytes). Each refusal says what to do: `file_too_large` (413), `workspace_storage_full` (507, with
  the workspace's use), `busy` (503: too many uploads at once; the SDK tries again by itself), and an
  upload cut off midway (a closed tab) keeps nothing (400 `invalid`).
- A preview environment's files are its own; `preview_reset` and its deletion delete them.
- A function reads the app's files (`ctx.files.read`) and makes a link anyone opens without
  signing in, until it expires (`ctx.files.url`), for a service that fetches the file itself:
  [Functions](./functions.md#ctx-what-a-function-gets).
- `app_info` lists an app's uploads (`uploads`: how many, their bytes, the workspace's use and limit,
  the newest 20), and `app_logs` has a line for each upload, refusal, cut-off upload and delete.

## Maintained counts and integer totals: db.aggregate

Declare dashboard totals in `openbelt.json`. OpenBelt backfills existing records on the first read
and maintains the totals in the same transaction as every source write, including server functions,
MCP writes and imports. Pages do not update a separate totals document.

```json
{
  "aggregates": {
    "expense-count": { "collection": "expenses", "op": "count" },
    "expense-total": { "collection": "expenses", "op": "sumInteger", "field": "cents" }
  }
}
```

```js
const total = await db.aggregate("expense-total")
// { count: 42, value: 12345, approximate: false }
const stop = db.aggregate("expense-total").watch(render, { onError: console.error })
stop()
```

`count` returns the number of source documents in `value`. `sumInteger` sums a top-level field;
every visible source record must contain a safe integer there. Missing, fractional, nonnumeric
and unsafe integer values refuse the sum. Counts still work. Store money as integer cents.
`count` in either result is the number of visible source documents.

The collection's read rule controls the result: `anyone`, `signedIn`, `nobody`, or
`doc.author == me` (also `me == doc.author`). Owner totals include only the viewer's records.
Other read expressions refuse the aggregate; read the source records for those queries.
There are no aggregate writes or separate permissions to keep in sync.

An app declares at most 16 aggregates. Names follow collection names. Fields are identifiers of
1–64 letters, digits or underscores, beginning with a letter or underscore. Aggregates support
counts and integer sums, without filters or grouping. This API is in the browser SDK, including
`db.app(other).aggregate(name)` for another app; server functions keep using source collections.

Large intermediate totals fall back to a source scan with integer arithmetic. If the final total
exceeds JavaScript's safe integer range, `approximate` is true and `value` may be rounded.
Deleting or correcting records restores an exact result when its value fits. The first read scans
the collection and uses storage; later reads use maintained per-author totals unless that fallback
is needed. More distinct authors and declared aggregates add storage and write work.

Watches use the same reconnect and error handling as `db.query().watch`. Writes are coalesced for
25 ms before a watched total is refreshed. Preview environments have separate totals over their
own records. Removing or changing a declaration discards its old derived state; it never changes
the source records.

## Functions: db.fn and db.query

```js
const { counts } = await db.fn("vote", { option: "tacos" }) // this app's functions/vote.js
await db.app("poll").fn("vote", { option: "tacos" }) // another app's function, as this app
const stop = db.query("totals").watch((totals) => render(totals)) // a query, live
```

`db.fn(name, input, { key })` runs one of the app's functions for whoever is viewing and resolves
to what it returns; a failure rejects with `code` `"function_failed"` (or `"bad_input"`). It
rejects with `"invalid"` (400) when it's called with a `key` and nobody is signed in (signed out,
every visitor would share the key), and (413) when its input is over 100 KB.
`db.query(name, input)` runs a `"kind": "query"` function: await it, or
`.watch(cb, { onError })` for each new result (it returns a stop function). Keys and writing
them: [Functions](./functions.md).

## Connections: tools.call

A page calls the workspace's connections (MCP servers like Linear or DeepWiki,
[Connections](./connections.md)) with `tools`, for whoever is viewing it. OpenBelt holds every
token and decides each call; the page never sees a token. List each tool the app's pages call in
its openbelt.json `"tools"`, and whose credential it runs with:

<!-- example: issues -->

```json
{
  "description": "My open issues, and ask DeepWiki about a repo",
  "tools": {
    "linear.list_issues": "viewer",
    "deepwiki.ask_wiki_question": "workspace"
  }
}
```

- `"viewer"`: the signed-in viewer's own token, at their level. The first time, they connect
  theirs and allow the app on Connections (`<workspace host>/_connections`), which lists
  exactly the tools the app binds to `"viewer"`; a deploy that binds more asks them again. Each person
  sees their own data: Carol's page shows Carol's issues.
- `"workspace"`: the workspace's token (or none, for a server that takes none, like DeepWiki), at the
  viewer's level. A level of `none` refuses it like any other call.

```js
import { tools } from "/sdk.js"

try {
  const issues = await tools.call("linear.list_issues", { assignee: "me" })
  render(issues.structuredContent ?? JSON.parse(issues.text)) // { text, content, structuredContent, runsAs, ms, trace }
} catch (e) {
  if (e.code === "needs_token" || e.code === "needs_consent")
    show("Connect Linear to see your issues")
  else show(e.message) // not_allowed, signed_out, ...: the message says why and what to do
}

await tools.list() // [{ tool, binding, usable, description, input, runsAs | code, message, fix, url }]
```

- `tools.call(name, input)` resolves to the server's answer: `text` (its text content, joined),
  `content`, `structuredContent` (null when it sent none), `runsAs` (`me`, `workspace` or `none`), `ms`
  and `trace`. A tool that ran and failed rejects with code `tool_error` and the server's text.
- `tools.call(name, input, { fields: ["name", "types.type.name"] })` keeps only those parts of a
  JSON answer, by dot path through arrays, so a big answer (an API's 300 KB Pokémon) reaches the
  page as the few hundred bytes it shows.
- On `needs_token` and `needs_consent`, OpenBelt shows a small sheet of its own over the page,
  dimmed behind it, naming every account the app still needs ("This app wants to use your GitHub and
  Linear") with Review, linking to the app's review page, which comes back to the page once they
  allow it; it shows once per page load; Not now, Esc or a click on the page closes it. `tools.call(name, input, { prompt: false })` skips the sheet; `e.url` is the
  same link, for a button of your own.
- `tools.list()` says, before any call, which tools the viewer can use and why not: render a
  "connect yours" state instead of a failed call.
- A refusal rejects with `code`, `message`, `fix` (what to do), `url` (their settings, when the
  viewer fixes it there), `setting` (what refused it) and `trace`; it isn't reported as a browser
  error. Every call is a line in the app's log with its trace, and in the workspace's activity.
- Some servers take 10-60 seconds: show that something is on its way. `check_app` waits up to 30
  seconds in a `wait` or `eval` step (`ms`).
- Test people in `check_app` have no tokens of their own: a tool bound to `"viewer"` is refused
  with `test_person` (expect it: `assert: "result.code == 'test_person'"`; the report lists it in
  `refusedTools`, not `failedRequests`), and one bound to `"workspace"` runs. To see a `"viewer"`
  tool's answer, call it yourself with `connection_call` (your own token, the same tool). Signed out (`check_app` on a live app without people, the gallery's picture),
  only a tool that takes no token runs; `readonly: true` blocks every call (423).

## Errors

A failed call rejects with an `Error` that has `status`, `code` and `trace`; its message says what
to change and ends with `(trace <id>)`. Branch on `e.code`, one word ("invalid", "denied",
"missing", "conflict", ...), not on the message, whose wording changes. Bad names, ids and
parameters are a 400. A write openbelt.json rules refuse is a 403 with code "denied", `rule`
(`"rules.polls.update"`) and the rule in the message (for an `&&` chain, the clause that failed);
it isn't reported as a browser error. When this OpenBelt can't read the app's openbelt.json (it was
rolled back to an older version), every read and write is that 403, with `rule` `"openbelt.json"`:
deploy the app again. A 409's `seq` is the document's current one.

### Every code

- `invalid` (400): a bad name, id, parameter or body.
- `denied` (403): openbelt.json rules refused it.
- `not_writable` (403): another app's collection that doesn't list it as writable.
- `cross_origin` (403): a page called an app's data on another app's host; use `db.app(name)`.
- `live_from_preview` (403): a page in a preview environment, or a test person, writing live data.
- `missing` (404): no such document, app, environment or file. `method` (405).
- files: `file_too_large` (413), `workspace_storage_full` (507), `disk_low` (507, the server's disk is
  nearly full), `busy` (503, retried by the SDK), `storage` (502, the file store failed).
- `conflict` (409): an `ifSeq` that no longer matches.
- `rate_limited` (429): more requests (or changes) a minute came from this address than the
  server takes; `retryAfter` (and the Retry-After header) says how many seconds to wait.
- `storage_full` (507): the app's data, its workspace's, or the server's disk is at its limit; the
  message says which. Nothing was written; reads and deletes still work, and deleting frees room.
- `check_readonly` (423): `check_app` with `readonly: true` blocked the write (or a function that
  tried to write, book a `later` or send anything but a GET or HEAD, or a connection tool that
  isn't read-only; whatever only reads runs).
- `bad_input` (400): a function's input doesn't fit its openbelt.json input schema; it didn't run.
- `not_callable` (403): the function runs only on its webhook's deliveries or its data trigger,
  or it's internal (openbelt.json `"internal": true`: only its app's own code runs it).
- `function_failed` (500): `db.fn` ran the function and it threw, ran past its limits or returned
  too much; the message is its error ([Functions](./functions.md)).
- `busy` (503, from `db.fn`): the workspace's runs were busy, or the server was restarting, so the
  function didn't start; call it again after the Retry-After header's seconds.
- tools.call: `not_bound` (403, the app's openbelt.json doesn't list the tool), `needs_token` (403,
  the viewer hasn't connected theirs: `url`), `needs_consent` (403, they haven't allowed this
  app: `url`), `not_allowed` (403, a workspace setting: the tool, a disabled tool, their level, no workspace
  token), `signed_out` (403), `test_person` (403), `not_member` (403), `upstream_failed` (502, the
  server didn't answer), `tool_error` (the tool ran and failed).
- `unreachable` (status 0): OpenBelt couldn't be reached. `aborted` (status 0): the call's
  `signal` cancelled it (not reported as a browser error).

## Sign-in

`db.me()`: [Who is viewing](./viewers.md).

## Examples

watch() with an error handler. It subscribes first, then reads, so a write that lands during the
read isn't missed or counted twice. Added documents come first; updated ones keep their place.

```js
const stop = db.collection("bugs").watch(
  (docs, change) => render(docs), // change is null the first time, then { op, doc }
  { onError: (error) => showError(error.message) }, // without it, the console hears
)
```

Each person signs up for a slot once; a second sign-up by the same person is refused:

```js
try {
  await signups.set(slot + ":" + me.email, { slot }, { ifSeq: 0 })
} catch (e) {
  if (e.status !== 409) throw e // 409: already signed up; e.seq is that document's seq
}
```

Reading a collection a page at a time:

```js
let cursor = null
do {
  const page = await posts.list({ limit: 1000, cursor })
  show(page.docs)
  cursor = page.cursor
} while (cursor !== null)
```

The cursor is opaque: pass it back as it came. A limit over 1000 is a 400, not a silent cap.

## Realtime and preview environments

The SDK keeps one WebSocket to the app (`/_ws` on its host), and one to each other app a page
subscribes to or watches. When it drops, it reconnects within a second and first replays what it
missed, in order: each changed document's latest version once (an `add` if it's new, else an
`update`), and each delete. When a new version of the page's own app goes live, the page reloads,
and so does a page whose viewer was removed from the workspace (it then shows why: [People and groups](./people.md)).
It also reloads, once, when it reconnects after OpenBelt itself was updated with a new `/sdk.js`.
A tab hidden for 5 minutes closes its sockets, so an app nobody is looking at can sleep; shown
again, it reconnects and replays what it missed the same way. Live updates pause while it's hidden:
code that has to act on a change with nobody looking belongs in a trigger or a schedule, not a page.

Under `/_preview/<env>/` every call uses that environment's data, and the socket hears only
its changes. Nothing in the page has to change; it can tell where it is:

```js
import { env, appUrl } from "/sdk.js"

env // "triage" in the triage environment, null on the live app
link.href = appUrl("home") // "https://home.acme.../_preview/triage/" if home is in triage, else "https://home.acme.../"
```

There the SDK first asks which apps are in the environment (one request as the module loads), so
`appUrl()` answers at once. The page reloads when its app gets a new version in the environment,
or the environment's data is reset (`preview_reset`) or deleted. See
[Apps](./apps.md#preview-environments).

On the public host (`<app>--<workspace>.<public host>`) the same page works for anyone, with what its
openbelt.json `public` lists: `db.me()` is `null`, `appUrl("home")` is `"https://home--acme.<public host>/"`
(a 404 unless home is public too), and `db.app()`, `files` and `tools.call` are refused. See
[Apps](./apps.md#public-apps-anyone-opens-them-on-the-public-host).

## Theme

The person's OpenBelt theme, `"light"` or `"dark"` (with System, the device's, as it changes):

```js
import { theme } from "/sdk.js"

theme.current // "dark"
const stop = theme.watch((t) => chart.setTheme(t)) // now, then on each change
```

OpenBelt also puts it on the page's root before it paints, `<html data-theme="dark">`, unless the
page has its own `data-theme`: CSS can use `:root[data-theme="dark"]` with no script. See
[Apps](./apps.md#in-the-frame).

## Under the hood

The SDK is plain HTTP and WebSocket on the app's host (`<app>--<workspace>.<domain>`), so anything can
use it. Another app's routes are the same under `/a/<other>/` on your app's host:

- `/_db`: `GET` lists the collections (`[{ name, about, docs, lastWrite, writable, rules }]`).
- `/_db/<collection>`: `GET` lists (`?limit=&cursor=`), `POST` with a JSON body adds.
- `/_db/<collection>/<id>`: `GET` reads, `PUT` sets, `PATCH` merges, `DELETE` deletes;
  `PUT`, `PATCH` and `DELETE` take `?ifSeq=<seq>`. A `GET` for a missing document is a 404;
  `get(id)` sends `x-openbelt-missing: null`, which turns it into a 200 with the body `null` (and the
  same header back), so neither the browser, `check_app` nor the error reporter counts it.
- Errors are JSON: `{ "error", "code", "trace" }`, plus `"seq"` on a 409 and `"rule"` and `"hint"`
  on a 403 from the rules. Unknown parameters are a 400 that names the ones the route takes.
- The same routes under `/_preview/<env>/` (and `/a/<other>/_preview/<env>/`) use that
  environment's data (or, for an app that isn't in it, its live data, read-only).
- The host is the app a request is from: a write to another app's collection that isn't writable
  is a 403 `not_writable`, and one from a page of another origin (its `Origin`, or
  `Sec-Fetch-Site`, which the browser sets) is a 403 `cross_origin`. A page in an environment
  writing live data is a 403 `live_from_preview` (told by its `Referer`). Writes carry the viewer ([Who is viewing](./viewers.md)) as `author` and `updatedBy`, and the rules
  judge reads and writes as that viewer.
- `/_files`: `POST` with the file as the body (`Content-Type` its type, `Content-Length` its size,
  `x-openbelt-file-name` its name, URL-encoded) stores it: `{ id, url, name, type, size, sha256 }`.
  `/_files/<id>`: `GET` and `HEAD` (with `Range`) read it, `DELETE` deletes it. Another app's are
  under `/a/<other>/_files/<id>`, read-only.
- `/_apps` lists the workspace's apps (`?env=<name>`: with URLs inside that environment for the apps
  in it, and `env` set on those); `/_me` (`?env=<env>` in a preview environment) is
  `{ "email", "name" }` or `null` ([Who is viewing](./viewers.md)).
- `/_ws?since=<seq>` replays changes after `seq` (or sends `{"type": "reload"}` when the
  data was reset since), then sends `{"type": "hello", "seq": ...}`, then live
  `{"type": "change", "op": "add" | "update" | "delete", "doc": ...}` and
  `{"type": "reload", "version": ...}` messages.

Signed-in browser requests share a per-person/workspace request allowance with that person's agents.
A 429 includes `Retry-After`; wait before retrying. Other people behind the same office address
have separate allowances, with a higher shared emergency ceiling for floods.
