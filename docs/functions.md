---
title: Functions
description: An app's server code (functions/<name>.js, in openbelt.json "functions"): ctx, notifications (ctx.notify), all-or-nothing runs, live queries (db.query), input and output schemas, calling one (db.fn, its own tool, call_function, keys), secrets (set_secret), network and connections (uses), previews, schedules, webhooks, triggers, ctx.later, testing without waiting, function_runs, limits.
---

# Functions

A function is an app's own code that runs on OpenBelt, not in the browser: `functions/<name>.js`,
listed in openbelt.json `"functions"`. Use one for what a page can't be trusted with (a capacity, a
check of who is calling), for logic other apps and agents should call instead of copying, and for
anything that needs a key, the network or nobody's page open.

```json
{ "functions": { "rsvp": "RSVPs the caller to a meetup. input { event }; returns { spots }" } }
```

```js
// functions/rsvp.js
export default async ({ event }, { db, caller }) => {
  if (caller === null) throw new Error("sign in to RSVP")
  const meetup = await db.collection("events").get(event)
  const spots = meetup?.data.spots ?? 0
  if (spots < 1) throw new Error("this meetup is full")
  await db.collection("events").update(event, { spots: spots - 1 })
  await db.collection("rsvps").set(`${event}:${caller.email}`, { event })
  return { spots: spots - 1 }
}
```

Twenty people RSVPing for the last 8 spots at once get exactly 8: a run is all or nothing, so this
plain read, check, write needs no locks.

## Writing one: a file and a line in openbelt.json

- The file is a JavaScript module (no TypeScript, no imports) whose default export is
  `async (input, ctx) => result`. Names: 1-40 lowercase letters, digits, `_` and `-`.
- Its openbelt.json entry is one line (what it does, its input, its result; up to 500 characters),
  or `{ "description", "kind": "query", "internal": true, "input", "output" }`. Agents and other
  apps read it before calling. `"internal": true` keeps it to the app's own code (below).
- `input` is the caller's JSON (`null` when none); the return value goes back as JSON, a throw is
  the caller's error with its message. Return the id of anything it creates.
- A deploy loads every listed function; if one fails to load, nothing deploys. A listed file is
  never served to browsers.

## ctx: what a function gets

- `db`: the app's documents, with the SDK's calls (`collection(name)`: `list`, `get`, `add`,
  `set`, `update`, `delete`; `collections()`). A failed call throws with the SDK's `status` and
  `code`. In a preview, that environment's data. Rules don't judge a function: check `caller`.
- `caller`: `{ email, name, groups }`, set by OpenBelt, so trust it
  (`caller?.groups.includes("hosts")`; a `check_app` test person's groups are only what whoever
  ran the check may give, [Viewers](./viewers.md)). `null` when nobody is signed in and for runs nobody called.
- `via`: `"page"`, `"app:<name>"`, `"agent"`, `"schedule"`, `"webhook"`, `"data"` or `"later"`.
  `env` (the preview, or `null`), `app`, `kind`, `run` (`{ id, attempt, key }`) and, on a
  schedule's run, `schedule` (`{ scheduledFor, lastOkAt, manual }`).
- `call(name, input)`, `later(name, input, options)`, `secrets`, `connections`: below. `fetch` is
  the global one.
- `files`: the app's own uploaded files ([Files](./sdk.md#files)), by id or by the object
  `files.put` gave. `await files.read(file)` is `{ id, name, type, size, bytes }` (`bytes` a
  `Uint8Array`, up to 10 MB: a fetch sends it whole). `await files.url(file, { expiresIn })` is
  `{ url, expires }`: a link anyone who has it opens without signing in, for a service that fetches
  the file itself (a social network posting a picture, say). `expiresIn` is ms or `"10m"`, `"2h"`,
  `"7d"`: an hour by default, a week at most. Each is a `db` call; another app's file is `missing`,
  and a query can't make a link.
- `notify(to, { title, body, path })` sends a notification to the workspace's people (`to` is an
  email or a list of up to 50) who allowed this app's notifications, on each device they allowed
  one on ([Who is viewing](./viewers.md)). A tap opens this app at `path` (default `"/"`).
  `title` is 1-120 characters, `body` up to 500. It returns `{ devices, reached, notOptedIn }`:
  the devices the push services took it for, the people with at least one, and the people who
  haven't allowed it. Each of those is asked the next time they open the app, once. Someone
  outside the workspace is refused. Like a POST `fetch`, it goes out once: a run that notified doesn't re-run silently
  (below). A query can't notify, and a preview sends only when `preview_side_effects` lets it.

```js
// functions/ready.js: tell the person who ordered that it's ready
export default async ({ order }, { db, notify }) => {
  const { customer } = await db.collection("orders").get(order)
  return notify(customer, {
    title: `Order ${order} is ready`,
    body: "Pick it up at the front desk",
    path: `/?order=${order}`,
  })
}
```

Keep no state in module variables: the sandbox is reused and dropped at any time. An app's
functions share their code's sandbox within an environment, each file its own module. Live and
each preview have separate module state, as do different apps and workspaces. An idle sandbox
can be evicted to make room for other apps or versions; the next call loads its code again.
Neither eviction nor reuse is a place to keep a caller's private data.

## A run is all or nothing

A run's writes commit together when it returns; a throw or a limit writes nothing. If a document
it read, or a collection it listed, changed before it commits, it runs again on the new data (up to
6 attempts; `ctx.run.attempt` counts).

- Listing a collection ties the run to all of it, and `db.collections()` to all of the app's data.
  Get documents by id where you can, or keep a total in one document.
- What a `call` read ties the caller too, unless that call committed (then it's done, like a
  send): `const left = await call("left")`, then a write, is as safe as reading it yourself. What
  the caller read before a `call` that changed it is the old value: read it again before writing it.
- A `call` doesn't see the caller's uncommitted writes, so it may not read, list or write what
  the caller wrote (it throws): write it after the `call` returns, or pass what it needs as input.
- A fetch or write it didn't await still counts: the run waits for it before it commits.
- A run that did something outside (a fetch other than GET or HEAD, a connection tool that isn't
  read-only) can't re-run silently: it fails with kind `conflict`. Put the contended part in its
  own function and `await call("rsvp", input)`: that commits by itself, then the caller sends,
  once. If nothing but your code should run that part, mark it `"internal": true`.

```js
// functions/join.js: RSVP (atomic, may re-run), then email (once)
export default async (input, { call, caller, secrets }) => {
  const { spots } = await call("rsvp", input)
  await fetch("https://mail.example.com/send", {
    method: "POST",
    headers: { authorization: `Bearer ${secrets.MAIL_KEY}` },
    body: JSON.stringify({ to: caller.email, event: input.event }),
  })
  return { spots }
}
```

## Queries: read-only, and live on pages

`"kind": "query"` makes a function read-only (no writes, fetches, `call` or `later`), and pages can
watch it:

```js
const stop = db.query("attendees", { event }).watch((list) => render(list))
const once = await db.query("attendees", { event })
db.app("meetups").query("attendees", { event }).watch(render) // another app's
```

- A change re-runs only the watched queries that read it; an unchanged result isn't sent again.
- A query that reads the clock (`Date.now()`) also re-runs every minute, which keeps its app awake
  while a page watches it. For an exact cutoff, pass the time as input.
- `db.fn` runs either kind; `db.query` only queries.

## Contracts: input and output schemas

`input` and `output` are JSON Schemas (`type`, `properties`, `required`, `items`, `enum`,
`const`, `anyOf`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`,
`additionalProperties`, `description`):

```json
{
  "functions": {
    "rsvp": {
      "description": "RSVPs the caller to a meetup",
      "input": {
        "type": "object",
        "properties": { "event": { "type": "string" } },
        "required": ["event"]
      },
      "output": { "type": "object", "properties": { "spots": { "type": "integer" } } }
    }
  }
}
```

- Input that doesn't fit is refused before the run (`bad_input`); unknown keys too, unless
  `additionalProperties` allows them. Webhook and trigger input isn't checked.
- A result that doesn't fit fails the run (kind `output`) and keeps none of its writes.
- Agents see it as a TypeScript signature (`app_info`; `search` gives its input schema).
  Without one they see the shape OpenBelt observed (`/* observed */`): of its input, only the
  keys the function read (of an array, its first 5 items; an object with over 24 keys counts as
  all read). An agent's call whose input has keys the function never read still runs, and its
  result's `note` names them, since a misspelt key changes nothing:
  `"note": "receive never read input.subjekt, so it changed nothing. It reads input.subject."`

## Calling one: pages, other apps and agents

- A page: `await db.fn("rsvp", { event })`; a failure rejects with `code` `"function_failed"` (or
  `"bad_input"`). A page in a preview runs the functions there, never live ones
  (`live_from_preview`).
- Another app's page: `db.app("meetups").fn("rsvp", input)` (`via: "app:<yours>"`, same viewer).
- An agent: `call_function({ app, function, input })` runs any app's, or `execute`
  ([Code](./code.md)). `search({ query: "rsvp to a meetup" })` finds a function by what it does,
  with its input schema and the exact call; `app_info` lists every function with its `call` (null
  for a webhook's, a trigger's or an internal one). `preview` runs the version there, on its data.
- A key makes a retry safe: `db.fn(name, input, { key })`, `call_function`'s `key`.
  The same key from the same caller within 24 hours answers from the run that went ok
  (`replayed: true`; another caller's key is theirs); the same key
  with other input is refused. Signed out, a key is refused (400): nobody's is theirs alone.

## Secrets, network and connections: the outside world

A function reaches only what openbelt.json grants, and OpenBelt makes, logs and counts each call:

```json
{
  "functions": { "join": "RSVPs the caller and emails a confirmation. input { event }" },
  "network": ["mail.example.com"],
  "secrets": { "MAIL_KEY": "the mail service's API key" },
  "uses": { "deepwiki": "answers questions about a repo's code" }
}
```

- `"network"`: the hosts `fetch` may reach (`"api.example.com"`), https and public only: never
  OpenBelt's own hosts (the workspace's and its apps': reach their data through `db` and `call`), a
  private or local address, or a name that points at one (`"localhost:4599"` works only under
  `bun run dev` and verify). Headers that say who a request is from (`Tailscale-*`, `Cf-*`,
  `X-Forwarded-*`, `X-OpenBelt-*`, `Host`) are dropped. `fetch` doesn't follow redirects, so a
  secret never goes on to another host: a 3xx comes back as it is, with its `Location`, and
  `app_logs` says where it points. Fetch that URL yourself, with its host in `"network"`.
- `"secrets"`: each `"NAME": "what it's for"`, or `{ "for", "hosts": [...] }` to pin where it may
  go. Deploy that first, then set the value (8 to 4000 characters, no whitespace at either end,
  no U+FFFD: copied exactly as issued) with
  `set_secret({ app, name, value })`, using what the person gives you: never in a file, page or
  code. The value goes only to the hosts openbelt.json
  sent it to when it was set (or `set_secret`'s `hosts`); a later deploy that sends it further
  stops it until it's set again. Only the app's owner or a workspace admin sets its secrets. `secrets.NAME` is a placeholder OpenBelt fills in on the way out, so
  the function's code never holds the value. It's a token for this run only
  (`{{secret:NAME:<nonce>}}`, the nonce new for each run): OpenBelt fills it only in this run's own
  `fetch`, so text that looks like a placeholder and comes in as data (the input, a document, a
  webhook's payload, a host's answer, `{{secret:NAME}}` written out) is sent as it is, never
  filled, and `app_logs` says so. Wherever else a run's placeholder goes (a `db` write, a
  `call`'s or `later`'s input, a connection call, the result, a log line), it becomes
  `{{secret:NAME}}`, which nothing fills: build the request in the run that sends it. Read
  `secrets.NAME` inside the run that sends the request, not once at the module's top or in a
  client kept there (`client ??= new Api({ key: secrets.KEY })`): runs of a file share its module,
  so a later run would send the first run's placeholder, and OpenBelt refuses that request
  ("secrets.KEY was read in an earlier run"), as it does one holding another run's placeholder or
  a placeholder in a header's name. An answer that has any of the app's secrets in it,
  as sent, JSON-escaped or URL-encoded, any character of it (`\/`, `\u0041`, `%41`: whatever
  one or two of `JSON.parse`, `decodeURIComponent` and form decoding, in any order, turn back into
  it, so a host that echoes the JSON body it got inside a JSON string is caught; not `decodeURI`,
  `unescape`'s `%uXXXX`, base64, a change of case or three encodings), in its body
  (byte for byte, whatever it is), its status text or a header (a
  connection tool's answer and error too), gets the placeholder back instead (an answer built to
  be slow to check, which only one made from the secret is, is withheld: the request was still
  sent, and the error says so). Each placeholder is filled in encoded for where it is, so the
  host decodes it to the exact value: percent-encoded in a URL and wherever the code encoded it
  (`encodeURIComponent`, `URLSearchParams`, `url.searchParams`), form-encoded in an
  `application/x-www-form-urlencoded` body, JSON-escaped in a string of a JSON body
  (`application/json`, `+json`; outside a string, or right after a `\`, it's refused), as it is
  in a header or any other body. A body is JSON or a form by its `content-type` header: a string
  body without one goes as `text/plain`, with the value as it is, so give a JSON or form body its
  header (`headers: { "content-type": "application/json" }`; `URLSearchParams` and a `Blob` with
  a type set it themselves). This run's placeholder in a form OpenBelt doesn't fill (encoded twice,
  `\u`-escaped, upper-cased, right after a `%` in a form) is refused, not sent as it is. A
  request to a host a secret isn't pinned to, or a connection call, that holds its value (as it
  is, or in any of the encodings redaction reads) is refused, naming the secret; code that changes
  it some other way first (base64, say) isn't caught, and neither is a value split across headers
  or requests, or put in a `db` write. A fetch that fails gets a fixed message (no answer, a timeout, refused):
  the runtime's own error, which could quote the request, is in `app_logs`, scrubbed. OpenBelt
  sets `Accept-Encoding` itself (gzip, br, which it decodes first) and refuses an answer in any
  other `Content-Encoding`. Pinning limits where a
  secret goes, not what those hosts answer: one that stores what it's sent and hands it back
  changed (base64, say) gets it into the function, so pin a secret only to its own API. Reading
  an answer for secrets costs the app's own CPU, outside the run's limit: up to about 175 ms for
  a 1 MB answer dense with escapes (`\u0041`, `%41`), so a `"network"` host that answers that
  way often slows the app's other requests.
  `await secrets.hmac("NAME", text)` is the hex HMAC-SHA256 of `text`; the code holds that
  signature and could send it to any host in `"network"`, so it signs only while the secret was
  set for every one of them (and isn't stopped), else it throws saying which host to drop or pin.
- `"uses"`: the workspace's connections (the `connections` tool lists them), called as
  `await connections.deepwiki.ask_wiki_question({ repoName, question })` (a name with a dash in
  brackets: `connections["cmp-deepwiki"]`), as the caller at their level. On a connection with both the workspace's credential and the caller's own (`credential`
  `both`), the workspace's runs unless the call says `{ as: "me" }` as its second argument
  (`connections.github.get_me({}, { as: "me" })`), which gets the caller's own under the rules
  below. A `later` or trigger run is judged as whoever started it (the run that booked the
  `later`, the person whose write fired the trigger), though its `caller` is `null`; a
  `call_function` with `as` gets what that trigger's run would (`"later"`, `"data"`: you, as the
  one who started it; `"schedule"`, `"webhook"`: no person). A person's own token is used only
  while they use the app themselves (its own page, their agent), and only once they
  allowed the app on Connections (`"uses"` asks for every tool there): another app's page, a
  `later` and a trigger run get the workspace's token only, and a connection that takes only people's
  own tokens refuses them. A schedule's or webhook's run (no person) gets the workspace's
  token at the stricter of everyone's level and the app owner's. Nobody signed in (on the page,
  or the one that started it) gets only a connection that takes no token (`signed_out`). It
  returns the tool's
  answer itself (its structured content, else its text, a file's body sent as an embedded resource
  included, parsed as JSON, else the text), not
  `connection_call`'s `{ text }`.
- In a preview environment, a fetch other than GET or HEAD and a connection tool that isn't
  read-only aren't sent: the function gets `{ previewed: true, ... }`, which isn't a real
  success, so check `previewed` before treating it as one. Only the person you work for
  decides a preview may send for real (`preview_side_effects`, by a person who owns every app
  in it, or a workspace admin), until another app joins it.

## Schedules, webhooks, triggers and later: runs nobody calls

```json
{
  "schedules": { "reminders": { "cron": "0 9 * * *", "timezone": "Europe/London" } },
  "webhooks": { "tickets": { "verify": "hmac-sha256" } },
  "triggers": { "welcome": { "on": "add:rsvps" } }
}
```

These runs have `caller: null`, and `via` says what started them. A webhook's, a trigger's or an
internal function can't be called directly (a page, another app, `call_function`, `execute`: 403
`not_callable`) and has no tool of its own: test it as below. A scheduled one can be, like a
"refresh now" button; your own code's `call` and `later` reach any of them.

- `schedules`: a 5-field cron (the shortest step a minute), an IANA `timezone` (any name `Intl.DateTimeFormat` takes, `"GMT"` too; default `"UTC"`)
  and an optional `input`. Only the live version's schedules run; `app_info` shows `next` and
  `last`. A schedule runs at about its time: up to a minute after it, at the same offset every time
  (from the app and the function), so every app's `* * * * *` doesn't arrive in the same second.
  A run missed while OpenBelt was down runs once. Daylight saving: a time the clocks skip in
  spring runs that much later (`30 2 * * *` runs at 3:30), but several times in the skipped hour
  run once, at 3:00; in the hour the clocks repeat in fall, a schedule whose minute or hour is `*`
  runs in both passes, one at a fixed time once, in the first.
- `webhooks`: `POST https://<app>--<workspace>.<host>/_hook/<function>`, checked before any code runs (a
  bad signature is a 401). `verify` is `"hmac-sha256"` (`X-Signature: sha256=<hex>`; `header`,
  `prefix`, `encoding` change it), `"github"`, `"stripe"`, `"token"` or `"none"`; `key` names a
  header that dedupes redeliveries (empty or missing: no dedupe; over 200 characters: a 400): the
  same key with the same raw body, whatever its other headers, answers 200 from the first run; with
  another body it's refused. Signatures are over the body's bytes as sent. A delivery cut off
  before its body ends is a 400 and runs nothing (its key stays free), so the sender's retry runs.
  `webhook_secret` makes the secret and URL for the sender. The
  function gets `{ body, headers, raw }`; its result is the 200 reply, a throw a 500. A delivery
  that didn't start (the workspace's runs busy past their line, or the server restarting) is a 503
  with `Retry-After`, so a sender that retries sends it again.
  **Reply fast.** The sender waits for the run, and many stop waiting early: GitHub after 10
  seconds, without sending it again. The run still finishes, but the sender records a failure, and
  one that retries runs it twice. Keep a webhook's own run to a check and a write, and hand slow
  work (an LLM, a slow API, many items) to a `later` run, which nobody waits on:

```js
// functions/tickets.js: the webhook replies at once; functions/triage.js does the slow part
export default async ({ body }, { db, later }) => {
  await db.collection("tickets").set(String(body.id), { ...body, state: "new" })
  await later("triage", { id: String(body.id) }, { in: "1s", key: String(body.id) })
  return { ok: true }
}
```

- `triggers`: `on` is `"<op>:<collection>"` or a list, op `add`, `update`, `delete`, `set` (add or
  update) or `write` (any). The run gets `{ op, collection, id, doc, before }` just after the write
  commits. A trigger's writes don't trigger it again, however it ran (a write, by hand, a `call`
  or a `later`); a chain stops at 4; a failure isn't retried. A run's writes trigger runs in its
  call tree (Limits): past 100 runs the trigger doesn't run, and `app_logs` says so.
- `ctx.later(name, input, { in, at, key })` books one run: `in` is ms or `"30s"`, `"10m"`, `"2h"`,
  `"1d"`; `at` a Date or ISO time; from 1 second to 30 days ahead. It's booked only if the run commits. A `key` is
  booked once while its run waits (again: `{ booked: false }`); once that run starts, the key is
  free, so a run can book itself again with its own key. Mark a function only `later` runs
  `"internal": true`, or anyone can run it early. To do something later unless something else
  happened first, book it now and have the later run check:

```js
// functions/followup.js, booked with later("followup", { event }, { in: "1d", key: event })
export default async ({ event }, { db }) => {
  const meetup = await db.collection("events").get(event)
  if (meetup?.data.cancelled) return { skipped: true }
  await db.collection("followups").set(event, { event, sent: false })
}
```

## Testing without waiting

- `call_function` with `as: "schedule" | "webhook" | "data" | "later"` runs it now as that trigger
  would (`as: "data"` takes `{ collection, id }`), in a preview too, with the access its run gets
  on connections: never your own token, and a schedule's or webhook's the workspace's only. It runs
  webhook, trigger and internal functions too: making one internal doesn't stop you testing it.
- `webhook_test({ app, function, body, sign: "good" | "bad" | "none" })` sends a delivery through
  the real signature check.
- Only the app's owner or a workspace admin does either (and `webhook_secret`), live or in a preview:
  a preview's functions have the real secrets.
- `call_function` with `inputs: [...]` (2-20) starts runs at the same moment, to test contention.
  Pass JSON values directly, for example `inputs: [{ sku: "A100", qty: 1 }, { sku: "A100", qty: 1 }]`,
  without stringifying objects.
- `function_runs({ app, function?, failed?, trace? })` lists every run, whatever started it: its
  trigger, caller, version, attempts, writes, outcome, error `kind` and message, logs and `trace`
  (for `app_logs`). Look there first when a schedule, webhook, trigger or later did nothing.
  `trace` gives one call's runs: the run and every run it started with `ctx.call`.

## Limits

- Runs at once: 6 per workspace and 16 on the server (`OPENBELT_SANDBOX_TENANT_RUNS`,
  `OPENBELT_SANDBOX_RUNS`); past that a run (a function's, a query's or `execute`'s) waits in line
  for one to end. A function's 30 seconds start when it has its turn, not while it waits; it
  waits at most 60 seconds (`OPENBELT_SANDBOX_LINE_MS`), and not at all while the server
  restarts: then it's refused before it starts, error kind `busy` (a 503 with `Retry-After`;
  `db.fn` rejects with code `busy`), and sending it again is safe. A run waiting on a `ctx.call` gives its
  place to the run it called (which goes ahead of new runs), so runs that call runs don't wait on
  each other; it keeps its memory meanwhile, so at most 8 of a workspace's runs (16 on the server)
  wait on `ctx.call`s at once (`OPENBELT_SANDBOX_TENANT_PARKED`, `OPENBELT_SANDBOX_PARKED`). A
  `ctx.call` past that throws at once, saying so: a wide tree of nested calls hits it before the
  100 runs of its call tree.
- Per attempt: 30 seconds of wall time (the sandbox is stopped then) and 10 seconds of CPU time
  (a loop that never yields ends at 10, saying so), 200 `db` calls (`list` up to 1000 per call), 50 fetches, connection calls and
  `ctx.call`s (10 seconds per fetch, a 10 MB body out and a 1 MB answer back), 50 console lines.
- Per call tree (a run, whatever started it, and every run it `call`s or its writes trigger, theirs
  too, together, attempts run again included): 100 runs, 2000 `db` calls, 200 fetches and
  connection calls; `call`s nest 4 deep. Past one, that `call` (or `db` call or fetch) throws, and a
  trigger doesn't run: call once with a list instead of once per item, write one document holding
  a list, or spread the work over `later` runs.
- Input up to 100 KB of JSON, result up to 256 KB.
- In the sandbox (QuickJS, an interpreter): 128 MB of memory (an allocation loop ends within a
  second, naming the heap limit); the language and the web's globals (`fetch`, `URL`,
  `URLSearchParams`, `Request`, `Response`, `Headers`, `crypto` with digests and HMAC,
  `TextEncoder`, `atob`, `Intl`, timers, `structuredClone`), no Node (`Buffer`, `process`,
  `node:` modules), no files, no processes. Compute is about 10 times slower than V8: fine for
  shaping data, not for heavy number crunching.
- Per app: 50 functions, 10 schedules, 20 webhooks, 20 triggers, 20 secrets (8 to 4000 characters
  each), 20 network hosts, 10
  connections in `uses`, 1000 booked `later` runs (each preview its own; `preview_reset` unbooks
  a preview's), the last 1000 runs kept.
