---
title: Apps
description: What an OpenBelt app is, the frame people open it in (keys, routes in the path, the tab's title, the person's theme), deploying it whole or changing it with edits, preview environments over separate data (one or several apps), promoting and rolling back, conflicts, versions, openbelt.json, skills (skills/<name>/SKILL.md and the one OpenBelt writes), link previews (card, color), public apps for anyone (openbelt.json public, <app>--<workspace>.<public host>), names and the limits.
---

# Apps

An app is a folder of static files (HTML, CSS, JavaScript modules, images) served at the root of a
host of its own, `<app>--<workspace>.<domain>` (`http://standup--acme.localhost:1337/` from `bun run dev`).
What you deploy is what's served: no build step, and no TypeScript yet. The workspace's own host,
`<workspace>.<domain>`, is OpenBelt's: the gallery of its apps, `/mcp`, and the one address people open an app at,
`<workspace>.<domain>/<app>/<path>`: the page at `<path>` on the app's host, in the workspace's frame. That's the `url`
the tools give (`host` is the app's own, for `curl` and `fetch`). A browser opening a page of the app's host is sent there;
`curl`, an agent's `fetch` or a link preview's bot asking for it is sent to the app's own page. The address bar follows
the page (links, `history.pushState`, the hash), so a link copied from it opens the same page ([In the frame](#in-the-frame)).

## Deploying

```js
deploy_app({
  app: "standup",
  description: "Daily updates and blockers",
  files: [
    { path: "index.html", content: "<!doctype html>..." },
    { path: "logo.png", base64: "iVBORw0..." },
  ],
})
```

- Without `edits` or `keep_others`, `files` is the whole app: a file you leave out isn't in the
  new version. A file is `{ path, content }` for text, or `{ path, base64 }` for its bytes in
  base64: use base64 for binary files or any text that must stay byte-exact.
- The result has the app's URL, the `version`, and `reach`: who can open the URL and who is
  signed in there (everyone on the tailnet as themselves, everyone Access lets in, or nobody). Open pages reload
  themselves when a version goes live.
- Link files relatively (`app.js`, not `/app.js`), so previews serve their own copies. Link to
  another app with `appUrl("home")` from `/sdk.js` (its host, and in a preview environment its
  page there); in the frame, the link opens it in the whole window.

## Files and names

- `index.html` is required. Paths are relative (`css/style.css`), without `..`; no part may start
  with `_` (`_db`, `_ws`, `_log`, `_shot` and `_preview` are the platform's), and the folder `a` is
  the platform's too (`/a/<app>/` is another app's data). Files are up to 1 MB each, and one MCP
  request is at most 64 MB (a bigger deploy is refused with 413: send it in several `deploy_app`
  calls, with `keep_others`). Send large deploys one at a time: past what a server holds at once,
  a request is refused with 503 `busy` and `Retry-After`; send it again then.
- A page without its own `<link rel="icon">` shows OpenBelt's icon in the tab.
- People open apps on phones too. Give fields (`input`, `textarea`, `select`) text of 16px or more
  there, or iOS Safari zooms into a field when it's tapped; don't stop that zoom with
  `maximum-scale` in the viewport tag, since it also stops people zooming the page.
- A page a browser opens gets `touch-action: manipulation` on `html` from OpenBelt (not in your
  files), so a double tap doesn't zoom; a pinch still does. Your CSS wins: `touch-action: none` on a
  canvas or map that handles its own gestures, `html { touch-action: auto }` to zoom on double tap.
- App names are 1-40 lowercase letters, digits and single dashes; a few (`mcp`, `api`, `docs`, ...) are
  reserved. An app's host, `<app>--<workspace>.<domain>`, is one DNS label, at most 63 characters: in a
  long workspace name, a long app name is refused, saying how long it may be. A name is yours once a deploy of it lands: someone else's is refused with a free suggestion
  (`standup-2`). A refused first deploy (a file over 1 MB, an invalid `openbelt.json`, a function
  that doesn't load) makes no app and leaves the name free. An app keeps a permanent id, so its data stays with it.

## In the frame

The workspace's frame and the app's page work as one page, with nothing to set up:

- Keys: the page has the keyboard as soon as it opens, so its shortcuts work with no click.
- Address: the address bar follows the page, and Back and Forward move through its pages. To route by
  the path, read the route from `location.pathname` and move with `history.pushState`. A page a browser
  opens at a path with no file of its own (`/issue/ENG-12`: no dot in its last part) gets the nearest
  `index.html` above it, so a link to any route opens that page. There it has a `<base>` (unless it has
  its own), so its relative files (`app.js`) load from its folder, `pushState(null, "", "issue/ENG-7")`
  goes to `/issue/ENG-7`, and a `#` link stays on the page. `curl` and a missing file still get a 404.
  Hash routes (`#/issue/ENG-12`) work too.
- Title: the tab shows the page's `document.title`. For a count, put it first: `(3) Inbox`.
- Theme: the person's OpenBelt theme is on the page's root before it paints, `<html data-theme="dark">`
  or `"light"` (unless the page has its own `data-theme`), and in the SDK as `theme`
  ([SDK](./sdk.md#theme)). Style dark with `:root[data-theme="dark"] { color-scheme: dark; ... }`.
  `prefers-color-scheme` follows the theme in Safari and Firefox; Chrome keeps it on the device's
  setting, so a page styled only by that media query matches there only when the theme is System.

The app's own host, opened outside the frame, gets the same theme and routes.

## Preview environments

Test in a preview environment before changing a live app with real data: name it after the
change, seed from live if you need realistic data, put every app the change touches in it,
check, then promote them together.

```js
deploy_app({ app: "bugbash", preview: "triage", seed: "live", note: "Duplicate status", files: [...] })
// → { live: false, env: "triage", previewUrl: "https://bugbash.acme.../_preview/triage/", seeded: { docs: 10, capped: false } }
deploy_app({ app: "home", preview: "triage", keep_others: true }) // home as it is, or changed
check_app({ app: "bugbash", preview: "triage", steps: [...] })
promote_app({ apps: ["bugbash", "home"], env: "triage" })
```

- Nothing live changes. Each app in the environment runs its version at `/_preview/<env>/` on its host
  over the environment's own data (it starts empty; `seed: "live"` copies the newest 5000 live
  documents in once). Add test documents, break things: live pages never see it.
- Apps in the same environment use each other's data there: `db.app("bugbash")` on home's page
  in "triage" reads and writes bugbash's triage data, under bugbash's openbelt.json there. An app
  that isn't in it is read live and refuses writes (403): deploy it in as it is with
  `keep_others: true` and no files. Only an app's owner deploys it, into an environment too: for an
  app someone else owns that's refused, so ask its owner (`app_info` names them) to deploy it
  in, or test without it. In a page, `import { env } from "/sdk.js"` is "triage" (null on live).
- A patch without `base_version` goes on the app's version in the environment, so fixes pile up.
- `collection_list`, `collection_add`, `collection_update`, `collection_delete` and `check_app`
  take `preview: "triage"`. `preview: true` is refused:
  name the environment.
- `promote_app({ apps, env })` takes every app live together, all or none; open pages reload. It never copies data. It's refused when an
  app's live version changed since (it says who and when): deploy into the environment again with
  `keep_others: true` to bring that change in, check, promote. `promote_app({ app, version })`
  is the rollback: promote any earlier version (`app_info` lists the last 20, and every result's
  `previous` is the version before).
- `app_info` shows the environments an app is in (`note`, the other apps, `lastWrite`, `by`). A
  name in use is someone's work in progress: a deploy into one that holds an app someone else
  owns warns you, so pick a new name unless your change is part of theirs. A refusal for an environment that
  doesn't exist names the ones that do. `preview_reset({ env })` empties an environment's
  data (`app` for one app's). An environment with no deploys or writes for 7 days is deleted.

## More on environments

- An environment's name is 1-40 lowercase letters, digits and dashes, not `live` (the live
  data's); it's made on first deploy.
  Its data has the whole SDK, with its own realtime. `seeded` says how many documents were
  copied, and `capped` whether there were more.
- A deploy's `previous` is the version the environment ran (null when the app is new there).
- If one app fails to switch during a promote, the ones already switched are put back. Bringing
  in a newer live change puts your version on top of it (refused with a diff if you both changed
  a file).
- `preview_reset` keeps the versions and reloads the environment's open pages. An expired
  environment's data is deleted too. A URL naming an environment that doesn't exist is a 404
  page, never live data.
- Apps have no gate of their own: whoever reaches an app's host can open it (`reach` says who
  that is on deploys and promotes).

## Changing an existing app

1. `app_files({ app: "standup" })` returns the live version's files and that version, e.g.
   "3f2a9c1e0b7d". Read before you change an app, even one you built. For just the part you'll
   change: `app_files({ app: "standup", paths: ["app.js"], around: "function render", context: 20 })`
   returns excerpts (`{ from, to, text }`) instead of content; `lines: "40-80"` takes a range.
2. Send edits, on top of the version you read. `find` is text copied exactly from the file and
   must occur once. Send whole files only for new files or rewrites:

```js
deploy_app({
  app: "standup",
  base_version: "3f2a9c1e0b7d",
  preview: "standup-fix",
  edits: [
    { path: "app.js", find: "const title = 'Standup'", replace: "const title = 'Daily standup'" },
  ],
  files: [{ path: "search.js", content: "..." }],
  delete: ["old.css"],
})
```

- Edits apply in order; a later one sees what earlier ones did. Copy `find` with its indentation
  and line breaks; a line or a few is enough. Only text files can be edited.
- If any `find` occurs zero times or several, nothing deploys. The refusal lists every bad edit:
  the closest lines (with numbers), or the line numbers of each match. Fix those finds and send
  all the edits again.
- Edits make the deploy a patch: files you don't edit or send stay. `delete` removes paths.
  `keep_others: true` makes a patch from `files` alone.
- The result's `diff` shows what your edits changed: read it before you check. Past 4 KB it's cut,
  and its last line is the `app_diff` call that pages through the rest. Lines past 400
  characters show a window around the change, marked `⟪… N chars⟫` (don't copy it into a `find`).
- `base_version` is the version you started from. Into a preview environment it defaults to the
  app's version there, so a fix keeps the earlier ones. If someone else changed the live app
  since, their changes are kept; the deploy is refused only when they changed a file you change
  too (for a full deploy, any file). The refusal names who deployed when, with a diff of their
  change; nothing changes. Read `app_files` again, re-apply your change, deploy with the new
  version.
- The result's `changed` lists the paths that differ from `base_version` (not from the live app).

## More on reading and patching

- Without `base_version` nothing is checked: a patch goes on the live version, and a full deploy
  replaces it. A patch is also refused when they changed a file your base preview changed.
- `app_files` takes `version` for any kept version and `paths` for some files. Binary files come
  back as `base64`; past about 400 KB of content per call a file has `omitted`: ask for it by
  path. Excerpts come with `lineCount` (`context` defaults to 10), and files with no match are
  left out.
- An edit's refusal also says when a `find` matches only if whitespace is ignored, when its lines
  are in the file but not together, and that a new file goes in `files`.
- `app_diff({ app, from, to, paths?, offset? })` pages through the diff between any two kept
  versions, 16 KB at a time (`next` is the following `offset`, null at the end).

## Versions

A version is the set of files a deploy made. Files are stored by content hash, so a redeploy
stores only what changed (`uploaded`), and the same files are always the same version. Going live
is one switch: if anything is refused, the old version keeps serving. `promote_app`'s result is
`{ promoted: [{ app, url, version, previous }] }`, with `reach` as a deploy's. `app_info` lists the last 20
versions, newest first (`version`, `kind`: full or patch, `by`, `deployedAt`, `promotedAt`,
`files`). Older ones are deleted; the live version and those environments run are always kept.

## openbelt.json: describe your data

An optional file at the app's root, deployed with the other files. Add one whenever an app keeps
data that another app or agent might use. A lunch app whose votes other apps' pages may add to,
one per person per day, each changed or taken back only by whoever cast it:

<!-- example: lunch -->

```json
{
  "description": "Lunch votes, one per person per day",
  "collections": { "votes": "one doc per person per day, id <day>:<email>: { day, place }" },
  "writable": ["votes"],
  "rules": {
    "votes": {
      "read": "anyone",
      "create": "signedIn && id == newDoc.data.day + ':' + me",
      "update": "doc.author == me && newDoc.data.day == doc.data.day",
      "delete": "doc.author == me"
    }
  }
}
```

- `description`: the app's line in `search`, the home page and `db.apps()` (it wins over `deploy_app`'s).
- `collections`: one line per collection saying what a document holds (fields, id scheme, units).
  It's shown as `about`, even while the collection is empty.
- `writable`: collections other apps' pages may write to. Without it, only this app's pages do.
- `rules`: who may read, create, update and delete in each collection ([Who can change what](./rules.md)).
- `aggregates`: up to 16 named `count` or `sumInteger` declarations over a source collection.
  OpenBelt maintains them on every write; pages read and watch them with
  [`db.aggregate(name)`](./sdk.md#maintained-counts-and-integer-totals-dbaggregate).
- `tools`: the workspace's connection tools its pages call with `tools.call`, each `"<connection>.<tool>"`
  bound to `"viewer"` (the viewer's own token, once they allow the app) or `"workspace"` (the workspace's),
  at most 100 ([SDK](./sdk.md#connections-toolscall)). A binding the workspace's connections can't
  serve (no such connection or tool, a token it doesn't take, a level nobody has) deploys with a
  warning naming it.
- `functions`: each server function, `functions/<name>.js`, with a line saying what it does, its
  input and its result, or `{ "description", "kind": "query", "input", "output" }`
  ([Functions](./functions.md)).
- `schedules`, `webhooks`, `triggers`: what else runs a function
  ([Functions](./functions.md#schedules-webhooks-triggers-and-later-runs-nobody-calls)).
- `network`, `secrets`, `uses`: what its functions may reach
  ([Functions](./functions.md#secrets-network-and-connections-the-outside-world)).
- `public`: the app for anyone, signed in or not, at `<app>--<workspace>.<public host>`, and exactly
  which of its collections and functions they reach ([Public apps](#public-apps-anyone-opens-them-on-the-public-host)).
- `card`: what a link to the app shows in Slack, iMessage, X and the like, whose previews never sign
  in. `"private"` (the default) shows the workspace's card, "An app in <workspace>", and nothing of the app.
  `"public"` shows its page's `<title>`, its `description` and a picture of it to anyone with the
  link ([Link previews](#link-previews)).
- `color`: its colour, a hex colour like `"#2563eb"`: its link preview card's, and the tint behind its picture
  in the workspace's gallery. Without it, OpenBelt takes the page's `<meta name="theme-color">`, else the
  strongest colour in its picture, else one of twelve made from its name (the same name, the same colour).
- `collections` and `rules` take a prefix ending in `*` as a key: `"v_*"` covers every collection
  whose name starts with `v_`.
- Limits: `description` up to 300 characters, each collection's and function's line up to 500.
- It takes effect when its version goes live (in a preview environment, for that environment's
  data). A bad openbelt.json (an unknown key, a bad collection name, a line over its limit, a rule
  that doesn't parse, not JSON) refuses the deploy with the shape it expects.
- After OpenBelt itself is rolled back to an older version, that version reads an openbelt.json a later
  one took: it skips the keys it doesn't know, and while it has any, it doesn't serve the app's
  `functions/` files (a later OpenBelt's functions are server code). When a key it knows has a shape
  it doesn't take, the app's pages can't read or write its data (a 403 with `rule` `"openbelt.json"`,
  also in `app_logs`, and `app_info`'s `unreadable` says why) and its functions don't run until the
  app is deployed again: a call is a 404 saying so, a webhook delivery a 503 (its sender sends it
  again), a schedule skips its runs, a pending trigger or `later` run waits, and a write triggers
  nothing. The workspace's tools still read and write its data. A deploy that would keep that unreadable
  openbelt.json as it is (`keep_others`, or only edits to other files) is refused: send a fixed
  openbelt.json with it.

### Link previews

A link to an app pasted into Slack, iMessage, X, LinkedIn, Discord or WhatsApp unfurls into a card,
1200×630, drawn a few seconds after the version goes live (with the picture for the workspace's home
page). The previewer never signs in, so what it shows, anyone with the link sees:

- By default, the workspace's card: OpenBelt's wordmark, the workspace's name, "An app in <workspace>". Nothing of the
  app: not its name, its description or what's in it.
- With `"card": "public"` in openbelt.json, the app's own card: its page's `<title>` (else its name),
  its `description`, and a picture of its first page, in the app's colour (`color` above). The title
  shrinks to fit; a very long one is cut. A description that starts with the title shows only the rest.
- A link to a published app's public name (`<app>--<workspace>.<public host>`, [Public apps](#public-apps-anyone-opens-them-on-the-public-host))
  always shows the app's own card, `"card"` or not: anyone with that link sees the app already.
- A very saturated colour is toned down on the card only (its OKLCH chroma cut to 0.12, hue and
  lightness kept), so a loud brand red unfurls as a calm red. A colour already calm is used as it is.
- A version keeps the colour its first card got, so data that changes the picture doesn't change it.
  Set `color` to choose it.
- The card is at `/_og.png` on the app's host, and answers signed out.

### An app without rules

A trip app whose expenses other apps' pages may add:

<!-- example: trip -->

```json
{
  "description": "Split the offsite's costs",
  "collections": {
    "expenses": "one doc per expense: { payer, cents, for: [names], title }",
    "members": "one doc per person on the trip, id = their email: { name }"
  },
  "writable": ["expenses"]
}
```

The description is the contract other apps build on: keep it true when you change what a
collection holds. How pages use another app's data: [SDK](./sdk.md#using-another-apps-data).

## Public apps: anyone opens them on the public host

An app is for its workspace. One whose live openbelt.json has `public` is also for anyone, with no
sign-in, at `<app>--<workspace>.<public host>` (`https://game--acme.openbelt.page/`), a domain of its
own beside the workspaces' (`OPENBELT_PUBLIC_HOST`; without it nothing is public). Its owner can also
make it public in the app's panel (Share, who can view it, Public, then Make public: `"public": {}`, its
pages only) and turn on each collection's ops and each function, and the OpenBelt bar, on What visitors
can use; each change deploys a new live version of openbelt.json with only `public` changed, and
Workspace (Turn off public link) takes `public` out. A high-score game:

```json
{
  "public": {
    "collections": { "scores": ["read", "create"], "posts": ["read"] },
    "functions": { "play": { "secrets": [], "uses": [] } }
  },
  "collections": {
    "scores": "one doc per game played: { name, score }",
    "posts": "the team's notes about the game: { text }"
  },
  "functions": { "play": "scores a move. input: { moves }; returns { score }" },
  "rules": {
    "scores": { "read": "anyone", "create": "anyone", "update": "nobody", "delete": "nobody" },
    "posts": {
      "read": "anyone",
      "create": "signedIn",
      "update": "doc.author == me",
      "delete": "doc.author == me"
    }
  }
}
```

- **All files are public**: every page, script and image, except `openbelt.json`, `skills/` and
  `functions/`. `"public": {}` publishes only them, with no data or functions.
- **Only listed ops on listed collections.** `collections` names each collection with the ops anyone
  may do there: `"read"`, `"create"`, `"update"`, `"delete"`. Anything else is refused there (a 403
  with `rule` `openbelt.json "public"`), whatever the collection's rules say. A listed op must also
  pass the collection's rules for nobody signed in (`me` is `null`, `signedIn` is false), so both must
  allow it: above, anyone reads and adds scores, reads posts, and adds no posts. A collection with no
  rules lets anyone do the listed ops on any document. A write there answers with the document only
  when anyone may also read it (`"read"` listed and the rules allow); otherwise with its `id` and
  `seq` alone, so a write-only inbox (`["create"]`) shows nobody what it holds. An aggregate answers
  there only over a collection listed with `"read"`.
- **Only listed functions**, each with the secrets and connections (`uses`) it may use there (`[]`
  for none). Anyone calls `play` with `ctx.caller` `null`. Another secret or connection is refused
  with an error naming the list. Every run that call leads to (`ctx.call`, `ctx.later`, the triggers
  its writes start) gets the same list and no more, and a trigger that a write on the public host
  starts gets no secrets or connections at all. A run that starts later (a `ctx.later` booking, a
  trigger) gets only what the live `public` block grants `play` when it starts: after a deploy that
  takes a secret out of `play`'s list, a run booked before no longer gets it, and after one that
  drops `play` or `public` it gets no secrets or connections; nor do the runs it books. A connection that needs a token refuses these runs,
  as it does anyone not signed in. Rules don't judge a function: `play` reads and writes all of the
  app's data, so check its input. The documents it reads show members as opaque ids (below), so what
  it returns doesn't carry their emails.
- **Under the OpenBelt bar.** A browser opening one of its pages there gets it under a bar with
  OpenBelt's logo, the app's name and Sign in (to its workspace, then back to the app there); the page
  itself loads in a frame at the same address, and the address bar follows it. `"bar": false` in
  `public` takes the bar off. `fetch`, `curl` and link previews always get the page itself.
- **Nobody, ever.** No sign-in and no cookie on the public host: `db.me()` is `null`, and anyone's
  writes have the author `"anonymous"`. Who wrote a document is shown there as an opaque id that stays
  the same for each member in this app (`"author": "member-3f9a…"`, `"authorName": "a member"`); the
  workspace host still shows emails. An email inside a document's data, or in an id you made from
  one (`<day>:<email>`), is shown as it is: keep those out of public collections.
- **Never** OpenBelt's pages (`/mcp`, sign-in, settings), another app (`db.app`, `/a/<other>/`), a
  preview, uploads (`files`), or the error log (`/_log`): each is a 404 there. A preview is never public, only the
  live version; deploying without `public` unpublishes the app (its public name is a 404), and so does
  a trial workspace nobody has claimed.
- **At the edge**: behind a CDN, the app's files other than its pages (scripts, styles, images) are kept
  there up to a minute; going live drops them at once, so a deploy shows its new files on the next load.
- **Limits there**: `OPENBELT_PUBLIC_APP_WRITES_PER_MINUTE` writes, function calls and live query
  runs a minute to one app (120 by default, a 429), of which one client address may use
  `OPENBELT_PUBLIC_ADDRESS_SHARE` percent (25 by default: 30), so one visitor can't use up the app's
  minute. Only work done counts: a request refused before any (no such function, an op or collection
  `public` doesn't list, the rules, a bad body) costs nothing, and a watched query that
  members', agents' or schedules' writes run again costs nothing. A watched query past the limit
  answers `rate_limited` and runs again when the limit allows (the error says in how many seconds)
  or on the next change; the refusal is never kept as its result, so the next page to watch it runs
  it. No new or changed documents once the app holds `OPENBELT_PUBLIC_DATA_SHARE` percent of its
  data cap (50 by default, a 507), so anyone can never fill it for its members.
- **Names.** `<app>--<workspace>` is one label, at most 63 characters: a deploy with `public` whose
  name would be longer is refused, and so is renaming the workspace to a name that would make one
  longer. After a rename the old public name sends a page to the new one (308).
- `deploy_app` and `app_info` return `public`: the URL, and each thing anyone reaches there, line by line.

## Skills

A skill is instructions for an agent: a `SKILL.md` and the files it refers to, in the
[Agent Skills](https://agentskills.io/specification) format. An app ships its own in
`skills/<name>/`, deployed with its other files:

```
skills/file-expense/SKILL.md
skills/file-expense/references/policy.md
```

```markdown
---
name: file-expense
description: "File an expense in the expenses app: who paid, how much, for whom. Use for a reimbursement, a receipt or splitting a bill."
---

# File an expense

Read [the policy](references/policy.md) first, then add one document to expenses.
```

A deploy is refused, with what to change, when a skill isn't valid: each folder in `skills/` needs
a `SKILL.md` that starts with YAML frontmatter, its `name` the folder's (1-64 lowercase letters,
digits and single dashes) and a `description` (at most 1024 characters: what it does and when to
use it; quote it when it has a `: ` in it, as YAML asks). `license`, `compatibility`, `metadata` (names to text) and `allowed-tools` are optional;
other fields are kept as written. A skill has at most 512 files and 16 MiB, every file sits in a
skill's folder (`skills/` holds skills only: an app that kept other files there moves them to
deploy again), and no skill is named as its app: that name is the one below's, so name yours for
the task it teaches (`file-expense`, not `expenses`).

OpenBelt also writes one skill for every live app, named as the app, at `skill://<app>/SKILL.md`:
what it is, its collections (with their rules), its functions (with their signatures), how an
agent and another app's page use them, and its own skills. It's written once per live version (the
first time it's asked for), so what a client checked is what it reads; a new live version writes
it again. So ship a
skill of your own only for what that can't know: a workflow (which function, in what order), the
values that are valid, who may do what, a policy to follow.

Only the live version's skills are served; a preview environment's aren't, until it's promoted.

Agents get them over MCP. A client that supports MCP's skills extension
(`io.modelcontextprotocol/skills`) lists and loads them itself: `skills/list` gives the skill of
each of your 20 newest apps and every skill an app ships, a page at a time; `skills/get` gives any
skill by its URI, listed or not; `resources/read` serves its files. Each entry lists every file
with its SHA-256 and size, so the client can check what it loads. Any other client uses the
`skills` tool: `skills()` lists the same, `skills({ uri })` reads a `SKILL.md` (and names its other
files) or one of its files. `app_info` lists an app's skills, and `search` finds an app by its
skills' words. The files are served on the app's host too, like any other file.

## The workspace's home page

Apps has two tabs: Yours, the workspace's apps, and Starters (`/?tab=starters`), the starter apps anyone in it can add.
Each starter's card opens its page (`/?tab=starters&starter=<name>`): its picture, its data, what agents get (its skills
and functions), what runs by itself and the prompt that built it. Add, on the card or the page, puts it in the workspace as
yours, with its first data, and opens it (`starter_add` does the same for an agent; [MCP](./mcp.md)); once added, its page
has Open and, for its owner or an admin, Remove, which deletes it. A workspace with no apps shows how to connect an
agent, and a link to Starters. Add app, in the bar, has Build with your agent (how to connect one) and Browse starter apps.
`<workspace>.<domain>/` shows the workspace's apps as a gallery: each card is the app's picture on a tint of
its colour (`color` in `openbelt.json`, above), its name, its description, its owner (You for your own apps,
otherwise the name before their email's @) and when it last changed. Sort by Updated, Newest or Name.
With four apps or more, the one updated last is shown large above the rest, under Just updated (its picture opens it),
and beside it the first starters not added yet, with See all; a search, or another sort, shows the cards alone.
Each card's ⋯ (at the end of its name, and beside the featured app's name) has Open in new tab, Copy link and, for the
app's owner and the workspace's admins, Delete. Delete asks first, then deletes the app for good: its versions, data,
files, functions' runs and logs, its preview environments, and who allowed it a connection. Its link stops working at once
and a new app can take its name. An agent deletes one with `app_delete`, giving the app's name twice
(`openbelt app delete <app> --confirm <app>`), with the same rule: the owner or an admin.
Above it, Jump back in lists the six apps you opened last (a page of the live version, in the frame), newest
first, each with when you opened it. Each app tells the workspace as it counts the open (at most once a minute for one person),
so the gallery reads them without waking any app; opens are kept 90 days, and only you see yours. With no opens, there's no row. A card opens `/<app>` on the workspace host, with the app in a rounded frame; `/<app>/<path>` opens that page of it, and `/<app>/_...` is OpenBelt's (the panel at `/<app>/_panel`).
Click the OpenBelt logo and wordmark to return to the gallery. The link gains a background on
hover or keyboard focus. The frame follows your saved Light, Dark or System theme;
the app keeps its own styling, with no separate background painted beneath its rounded corners.
On iPhone, the header and app frame stay inside the screen's safe area in portrait and landscape.
A link to the app's own host opens it here too, unless the app opened it itself (a popup, a print view, a tab of its own).
If your session ends inside the frame, click Sign in to continue to sign in in the full tab.
The frame's top right has the app's panel. Its first page has Share, the app's link (its public link once it's public),
and its header opens About (description, owner, live version). Every member who may open the app sees those; its owner
and the workspace's admins also see who can view it, Stats (below), History (its last 20 versions and its preview
environments), Data (its collections and how many documents each holds) and Logs (its newest lines). Only they change
who can view it: the row opens in place on Private (only them: any other member who opens the app, its pages or its
data on its own host is refused), Workspace (the default), and Public
([below](#public-apps-anyone-opens-them-on-the-public-host)); a pick changes nothing until its button (Make private,
Share with workspace, Make public, Turn off public link) saves it. A change that changes the link flashes the new one,
and Copy says Copy new link until it's used. Other apps and agents still reach a
private app's data, as the workspace's rules allow. On a phone the panel fills the screen. It shows what an agent already reads with `app_info` and `app_logs`; going back to an earlier version stays
with an agent (`promote_app`).

Stats is how much the app is used in the last 7, 30 or 90 days: the people who opened it (each once), its pages opened,
its functions' runs and how many failed, a chart of people a day, who opens it most and when they last did, and for a
public app its visitors and the hosts of the pages that linked to it. A page counts when it's opened in a tab or a frame of the live
version. Agents' calls, `check_app`, preview environments, scripts and other files, and link checkers don't count. A
visitor on the public host is counted once a day with no cookie (a hash of their address and the day, kept until the
day is over), so their visits on different days can't be joined. Where visitors came from counts each one's first open
of the day. Days are UTC days; people's opens are kept 90 days.
`app_info`'s `usage` gives an agent the last 7 and 30 days and the day it was last opened.
Search finds an app by its description and owner too. Beside Apps is how many match. It
shows 60 at a time, and Show more the next 60; the search and sort are answered by
the workspace (nothing is woken to answer them), so a workspace with thousands of apps opens as fast as one
with ten.
With no apps it says so, with a prompt to copy into an agent ("Build me a standup app on OpenBelt
(acme.example.com)": the workspace's host, whose `/auth.md` tells an agent how to connect) and Connect an
agent: one Claude Code command that adds the workspace's MCP address and signs in by itself (on plain
http under email sign-in, the base host's `http://localhost:<port>/mcp`, the one name Claude Code
signs in to over http; the rest are in Settings, Agents).
Apps in the sidebar clears the search.
The sidebar's foot is whoever is viewing: click it for a menu with their settings (`/_settings`:
connecting an agent and their API tokens, and for admins, People, Groups and Events;
[Connections](./connections.md#your-settings)) and the theme (System,
Light or Dark, kept in that browser). Signed out, the menu has only the theme. The button at the
sidebar's top (or `[`, or Cmd+B / Ctrl+B) folds it to a rail of icons, here and on Connections, and
that browser keeps the choice. Pages hold back vertical overscroll only, so a two-finger sideways
swipe still goes back in the browser's history. On a phone the sidebar is a drawer behind the menu button; a tap outside it or Esc
closes it, and signed out, a line under Apps says so. There the menu button, Apps and the count share one bar
that stays at the top, search and sort share the row under it, and the featured app's Open sits beside its name.

Sorted by name or newest, with more apps than one row of cards holds, Recently updated above them
shows what went live in the last 7 days, newest first.

The picture is the top 1280x800 of the live page, saved at 1.5x (1920x1200, so the gallery's zoom on it stays sharp), opened as `check_app` with `readonly: true`
opens it: nobody signed in, and writes never leave the browser. It's taken 10 to 15 seconds after
a version goes live (deploys in a row make one picture, of the last), and again at most every 5 minutes
while the live data changes. So a page that shows nothing until someone signs in, or that makes
its first data when it loads, looks empty in its picture. `app_logs` says why when a picture
isn't taken. The picture is at `/a/<app>/_shot` on the workspace's host, for a browser signed in
there; an agent or a service working as someone (paperbot showing their apps) gets it over MCP with
`app_picture({ app, theme })`: the image, with the version and when it was taken, or `picture: null`
before the first is taken (one is booked then).

Each picture is taken twice in the same page: first with the browser preferring light
(`prefers-color-scheme: light`), then switched to dark. The gallery shows the one that matches
its theme (Light, Dark, or System's choice). A page styled with `:root[data-theme="dark"]`,
`@media (prefers-color-scheme)`, `theme.watch` or a `matchMedia` change listener gets a dark picture
of its own; a page that reads the theme once when it loads shows the same as in light. The dark one is at `/a/<app>/_shot?theme=dark`. A picture taken before there were two, or at the smaller 800x500, is taken again as pictures are taken now, the next time the home page shows its card.

## Workspaces

Each workspace has its own host (`<workspace>.<domain>`), its own tokens and its own apps, each on a host
under it (`<app>--<workspace>.<domain>`). Two workspaces can both have a `standup`; neither can see the
other's. Inside a workspace, every app is open to everyone in it and apps can use each other's data:
that's the point of putting them side by side. The host is also what tells OpenBelt which app a
page belongs to, so one app's page can't write another's data as if it were that app's own (see
`db.app` in the SDK). An old link, `<workspace>.<domain>/a/<app>/...`, goes on to the app's host.
