---
title: Debugging
description: See what a page does with check_app, find errors from people's browsers in the app log, and follow one call by its trace id.
---

# Debugging

## Check your work

deploy (preview) → `check_app` with steps → `app_logs` for browser errors → fix with a patch →
promote

<!-- example: standup-check -->

```
check_app({ app: "standup", preview: "standup-fix", width: 390, steps: [
  { action: "fill", selector: "#name", value: "Ada" },
  { action: "select", selector: "#mood", value: "Happy" },
  { action: "click", selector: "text=Post" },
  { action: "expect", selector: ".post", count: 1 },
  { action: "expect", selector: ".post .mood", text: "Happy" }
]})
```

- `check_app` opens the page in a real headless browser and returns each step's outcome, `errors`
  (uncaught errors and rejections, with stacks), `console` errors and warnings, `failedRequests`
  (a `get(id)` that finds nothing isn't one), `dialogs`, the `title`, the visible `text`, and the
  `controls`: buttons, links and fields (with their values; a select with its options). Locations
  are your files as deployed: `app.js:12:5`, `index.html:1:345`.
- Each check starts a fresh Chromium browser through Playwright. Test people have separate
  cookies and storage. Service workers are disabled; offline and service-worker flows need a
  separate browser check. `readonly: true` also blocks writes from popups.
- Steps (up to 40) run in order in one call: click, fill, type, select (a `<select>`'s option by
  value, else label; fires change), check / uncheck (a checkbox or radio, or its label), hover,
  drag (`selector` onto `to`), scroll (`selector` into view, or `value` "top" / "bottom"), press
  (`value`: "Enter", "Tab", "Escape", an arrow key, one character, or a chord: "Shift+Enter",
  "Control+a"), wait (`selector` until `state`: visible (default), hidden, attached or detached;
  or `ms`), goto (`value`: a path in the app, or another app's page in a preview environment; its current preview prefix is also accepted), upload,
  expect and eval.
  Each says `ok` or `FAILED` with why; the check stops at the first failure.
- fill sets the field's value as a script does (input and change fire, no keys are pressed, so
  Enter-to-submit doesn't), for every input: a date takes "2026-10-26", a time "09:30", a color
  "#ff8800". It then reads the value back and FAILS with what the field holds if it isn't `value`.
  type clicks into the field and types `value` key by key after what it holds: use it when
  keystrokes matter (key handlers, autocomplete).
- upload chooses files for the `<input type=file>` at `selector` (hidden or not: point at the
  input, not the button over it) as a person picking them, then fires input and change. `value`
  names them, comma-separated, each made to fit: a real image for `.png`, `.jpg`, `.webp`, `.gif`,
  a one-page PDF for `.pdf`, text for `.txt`, `.csv`, `.md`, else random bytes; `"deck.pdf:20MB"`
  makes it that size (up to 200MB), to try a size limit. Its line says what it chose.
- drag scrolls both into view and grabs the element where no control inside it is (a `<select>` or
  button in a card would take the press). When nothing moved in the page, its line ends
  `(warning: nothing moved in the DOM; follow with expect)`. Follow every drag with an expect.
- Text assertions search the whole element; only the diagnostic excerpt is cut.
- Assert with expect, not by reading the text: it takes `text` (exact), `textIncludes`, `value`,
  `count` (0 for none), `visible`, `checked` and `attr: { name, value }`, retries for up to `ms`
  (default 3000), then fails saying what it found:
  `FAILED: expect .post .mood text="Happy": expected text "Happy", found "Sad" for .post .mood (after 3s)`
  With `status` and no selector, expect asserts the page's last data request instead (403 for a
  write the rules refuse); a 4xx it expected isn't in `failedRequests`.
- Selectors are CSS, as `document.querySelectorAll` takes it (`:has()` and `:nth-child()`
  included), or `text=Label`. Playwright and jQuery extensions (`:has-text()`, `:text-is()`,
  `:visible`, `:contains()`, `>>`, `role=`) and invalid CSS are refused before the check starts,
  naming the step.
- eval runs `script`, an async function body, in the page and puts its JSON result in the step's
  line; a throw fails the step (an SDK error with its status and rule). Use it for what steps
  can't say: a computed style, seeding data through the SDK. Any step can also take `assert`, a
  JS expression that must become true after it (checked until `ms`); `{ action: "wait", assert }`
  waits for one.
- Where you check decides what the check may change. A preview environment's data is test data:
  write freely. The live app's data is people's: pass `readonly: true`, and the page's writes get
  a 423, are listed in `blocked`, and nothing is saved. Its functions run, but only to read: one
  that writes, books a `later`, sends anything but a GET or HEAD, or calls a connection tool that
  isn't read-only gets a 423 too, with nothing kept or sent. No rule judged them: test rules in a
  preview.
- `screenshot: true` adds a JPEG of the page as an image (off by default); the CLI saves it to a
  file and prints its path as `screenshot`. `width: 390` checks a
  phone layout. `preview: "<env>"` checks the app in that environment, over its data; a goto to
  `/a/<other>/_preview/<env>/` follows a flow into another app there.
- Every check starts with empty storage: no cookies, no localStorage, nothing from an earlier
  check, so nobody is signed in. To check as people, pass `people`
  ([Test as several people](./viewers.md#test-as-several-people)). alert, confirm and prompt are
  accepted (OK) and listed. A check stops 30 seconds after its browser is up (10 more for
  each person after the first) and returns what it saw until then.
- `app_logs`: deploys, promotions, data writes, 404s, and errors from people's browsers (uncaught
  errors, rejections, console.error, failed SDK calls), each
  `browser error on <page>: <message> (<file:line>) (<browser>, version <v>, live|preview <env>)`;
  check_app's own say `check`. Pages
  report them by themselves: add nothing. When someone says the app is broken, look here first.
  Every tool result but docs's carries a `trace`; pass it as `trace` to see only what that call
  did.
- Browsers get the error reporter added to each page; curl and `app_files` get the file as
  deployed. Read sources with `app_files`.
- `app_info`: the live version and its files, the last 20 versions (`version`, `deployedAt`,
  `promotedAt`, `by`, `kind`), the live collections, each with `about`, `docs`, `lastWrite`,
  `writable` and a `sample`, and `environments`: the preview environments it's in, with its
  version and data there.
- `collection_list` / `collection_add` / `collection_update` / `collection_delete`: read and change
  the same data the pages use (`preview: "<env>"` for an environment's). MCP writes bypass rules
  unless `as` is given (`as: "alice"` in a preview writes as that test person). `collection_list`
  pages with `cursor` (up to 200 documents, default 50, or about 100 KB); `collection_delete` with
  `all: true` clears a collection. `collection_add` and `collection_update` take `docs: [...]` (up
  to 500) to write many in one transaction: all or none, each refused one listed.
  `collection_add` takes an `id` to create a document with that id (refused if it exists);
  `collection_update` takes `ifSeq` (0: create only). For moving data, writes without `as` may
  pass `author` and `updatedBy` per document: it keeps who wrote it.

## More on check_app

- Actions and expect use the first visible match, waiting up to `ms` (default 3000) for one. A step
  that didn't run reads `not run: ...`. An expect with no check is refused.
- fill also covers `datetime-local`, `month`, `week` and `range`; it fails when the field holds
  something else (a date in another format, a number past its max, a handler that rewrote it).
  type types after what's there (`fill` with `""` first to start empty); `\n` presses Enter.
- drag uses pointer events and the browser's own HTML5 drag and drop. If every point of the element
  is a control, or something covers it, the step fails saying so.
- expect's `text` is the visible text with whitespace collapsed; `text=Label` selects the innermost
  element whose text contains `Label`. `path` on a status expect matches that path or one under
  it.
- eval's result is cut at about 1500 characters. On an eval, the assert's `result` is what the
  script returned, or the error it threw (`{ message, status, rule, code }`), which then doesn't fail
  the step. A readonly check's 423 (`check_app is read-only`) fails a status-403 expect. Reads,
  sign-in and error reports still work under `readonly`.
- The report also has `denied` and `expectedDenials` (writes the rules refused), `blocked`,
  `refusedTools` (the page's `tools.call` refusals, each the tool and its code: answers, not
  failed requests), `status`, `url`, and `incomplete` when it stopped early.
- A check that can't start (a bad step or selector, no such app, no browser free) is a tool
  error (`isError: true`) whose text says what to fix. Its `structuredContent` is still a report,
  with the reason in `errors` and `incomplete` and every step `not run`. Checks can run in
  parallel; a server runs a few browsers at once (`OPENBELT_CHECKS_AT_ONCE`, 4), one workspace at
  most half of them (2), and a check waits up to 20 seconds for one, then is refused saying which
  was full.
- A page may hold 512 MB of JavaScript heap in check_app's browser. Past it the page crashes, and
  the check's `errors` says `Page crashed`: hold less in memory (page through data).
- check_app has no daily limit. It runs in the Chrome on the machine OpenBelt runs on
  (`OPENBELT_CHROME_PATH` names it when it isn't in the usual place).

## Errors from the browser

When a browser opens an app's page (a request with `Sec-Fetch-Dest: document`), OpenBelt puts a small
error reporter first in its `<head>`, after a `<link rel="modulepreload" href="/sdk.js">` that loads
the SDK beside the page's own scripts. It sends uncaught errors, unhandled rejections,
`console.error` calls, scripts and stylesheets that fail to load, and failed SDK calls to
`POST /_log` on the app's host, and each becomes an error line in the app log:

```
browser error on /standup/: Uncaught TypeError: list is null (app.js:12:5) (Chrome 141, version 3f2a9c1e0b7d, live)
```

- A failed SDK call is logged under that call's trace, and a check's errors under the check's.
- A page sends at most 20 distinct reports per load; an app logs at most 30 a minute, and the same
  one from the same page and browser once a minute.

## Trace ids and logs

- The gateway gives every request a trace id: HTTP responses carry it in `x-openbelt-trace`, error
  bodies and MCP results include it, SDK errors end with `(trace <id>)`, and every log line it
  causes carries it.
- Each app keeps its last 500 log lines: deploys (version, kind, files changed, who), promotions,
  refused deploys and why, data writes (`added preview triage cards/...` in an environment),
  seeding, resets and expiry of environment data, 404s with the version that served them, and
  browser errors. Without `trace`, `app_logs` shows the newest lines.
- Locally, `bun run dev` prints every log line, with `trace` and `app`; each run's log is also in
  `.dev/logs/dev.log`. `bun run verify` keeps each check's in
  `.verify/<run>/<check>/platform.log`. On a server, the lines go to the process's output
  (`docker compose logs openbelt`).

| Question                  | Look at                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| Did my deploy go live?    | The `deploy_app` result's `version`, and `x-openbelt-version` on the page |
| Why is the page blank?    | `check_app`, then `app_logs` for browser errors and 404s                  |
| Is it broken for people?  | `app_logs`: their browsers' errors, with the page, file:line and version  |
| Did the write happen?     | `collection_list`, or `app_logs` with the write's `trace`                 |
| What did this request do? | `x-openbelt-trace` from the response, then `app_logs` or the platform log |
