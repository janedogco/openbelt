---
title: Code
description: The execute tool: your JavaScript on OpenBelt with the workspace as workspace (every app's functions and data, the workspace's connections, workspace.search), to use several apps in one call, or to test contention (Promise.all) and a webhook end to end (fetch).
---

# Code

`execute({ code })` runs your JavaScript on OpenBelt as you, with the workspace in reach as `workspace`. Send a
body that awaits and returns what you want back:

```js
const [found] = await workspace.search("rsvp to a meetup")
const done = await workspace.apps.meetups.fn.rsvp({ event: "intro" })
const { docs } = await workspace.apps.meetups.collection("rsvps").list({ limit: 100 })
return { found: found.path, done, rsvps: docs.length }
```

## What workspace has

- `workspace.search("words")` finds functions (with their signatures), collections and connection
  tools; `workspace.describe("<path>")` says how to call one. Names can't be listed, only searched.
- `workspace.apps.<app>.fn.<name>(input)`: a run, as `call_function` makes one.
- `workspace.apps.<app>.collection(name)`: `list`, `get`, `add`, `set`, `update`, `delete`, as the
  collection tools do.
- `workspace.connections.<connection>.<tool>(input)`, as `connection_call` would. `workspace.me()`: you.
- A name that isn't a JavaScript identifier (a dash, a leading digit) goes in brackets:
  `workspace.apps["hourly-joke"].fn.create_joke(input)`, `workspace.connections["cmp-deepwiki"].ask_question(input)`.
  `search` and `describe` print paths that way, and `describe` takes either form.
- `fetch` reaches only the workspace's app hosts, as an outside sender would: to test a webhook end to
  end, sign a body with `crypto.subtle` and POST it.
- `Promise.all` runs calls at once, to test contention. `preview: "<env>"` uses the apps deployed
  there, on its data.

Code has no app, secrets or network of its own: what an app needs every time belongs in a
[function](./functions.md).

For imports and seed data, use `collection_add` batches instead of looping over `add` here.
See [Importing documents over MCP](./sdk.md#importing-documents-over-mcp).

## Limits

60 seconds, 300 `workspace` calls, 100 KB of code; a result over 24 KB of JSON comes back cut. An error
has `kind` (syntax, runtime, timeout, limit, sandbox), `message` and the `line` of your code.
