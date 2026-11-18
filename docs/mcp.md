---
title: MCP
description: Connect an agent to OpenBelt over MCP, signed in with OAuth or with an API token, and every tool it gets.
---

# MCP

Agents use OpenBelt through its MCP server at `<workspace origin>/mcp`
(`https://acme.<your domain>:8445/mcp` from `bun run dev`, `http://acme.localhost:1337/mcp` on one machine), over Streamable HTTP. Protocol revisions from 2025-03-26 to 2026-07-28 work; pi and
Claude Code connect as they are.

Every MCP request needs `Authorization: Bearer <token>`: an access token the agent got by signing
in (OAuth, below), or an API token you made. Either belongs to one person in one workspace
([People and groups](./people.md)), and only that workspace accepts it. The agent's writes are that
person's (`author` is their email), and `whoami` says who it is; nothing else tells the two apart.

An agent sees two tools. `search({ query })` finds the operations for a task, each with its input
schema, and the workspace's apps and connections that match; `search({ query: "" })` lists every
operation you may use. `call({ tool, args })` runs one: `call({ tool: "deploy_app", args: { app,
files } })`. Every operation these pages name (`deploy_app`, `check_app`, `app_info`…) is run this
way, with the arguments they show as `args`. The harness composes calls, in its own code mode if it
has one; OpenBelt runs no second sandbox for it.

Workspace management uses the same sign-in. `search` offers the operations that person may use:
admins get workspace administration, members get their own connection settings and tokens. Each
call checks the current role, so after a promotion or demotion, search again; a remembered admin
operation cannot preserve access. Personal credentials and app consents always belong to the person
signed in, including when that person is an admin. The `openbelt` CLI lists every operation as a
command of its own.

## Which to use

- **An agent on your own machine (Claude Code, Codex, opencode, pi, a script)**: an API token in a
  header is the sturdiest. Nothing to refresh, nothing a client can lose; it lasts until you revoke
  it.
- **A cloud client (claude.ai, ChatGPT), or someone who can't paste a token**: sign in with OAuth.
  Local clients sign in fine too (all four above do); they're just one more moving part.

## Signing in (OAuth)

An MCP client that does OAuth needs only the address:

```sh
claude mcp add --transport http openbelt https://acme.<your domain>/mcp   # then /mcp, and sign in
```

Its first request gets a 401 whose `WWW-Authenticate` names
`<workspace origin>/.well-known/oauth-protected-resource/mcp` (RFC 9728), which names the workspace host as
the authorization server (`/.well-known/oauth-authorization-server`, RFC 8414). The client
registers itself (`/_oauth/register`, RFC 7591), or uses the https URL of its Client ID Metadata
Document as its `client_id` (Claude Code, Codex and opencode do), and opens
`<workspace origin>/_oauth/authorize` in your browser. There, whoever the workspace's front door says you are
(Tailscale; on `bun run dev`'s `http://acme.localhost:<port>`, you) sees which
agent asks, which host it sends you back to, and Allow. Nobody signed in, or someone the workspace
doesn't let in, gets a page saying why, and no code. You're asked once per agent: the same agent
sending you back to the same place goes straight back next time, until you sign it out.

- Registering and metadata documents are open to anyone, so they are bounded: at most 5 redirect
  URIs of 512 characters each, a metadata document read as it arrives and refused past 10 KB, and
  at most 500 clients nobody has signed in with per workspace (the oldest go first, and any is deleted
  after a day). A client that has signed in is never one of them.
- PKCE with S256 is required; a client that sends no `code_challenge` or `code_verifier` is
  refused. The answer carries `iss` (RFC 9207).
- A client that knows who it signs in for adds `login_hint=<email>` to the authorize link: someone
  signed out finds that email filled in the sign-in form, one click from a code (the code still goes
  to that address, and the email can be changed).
- Redirect URIs: https anywhere, an app's own scheme, or http to this machine. `localhost`,
  `127.0.0.1` and `[::1]` are one machine, on any port: a client that registered
  `http://localhost/callback` may come back on `http://127.0.0.1:53124/callback`.
- A client with no browser of its own (a CLI on a server, over SSH) signs in with a device code
  (RFC 8628): it registers with `grant_types` holding `urn:ietf:params:oauth:grant-type:device_code`
  (no redirect URIs needed) and posts its `client_id` to `/_oauth/device_authorization`. You open
  `/_oauth/device` on any device, check that the code it shows is the one in the terminal (or type it
  in), and answer the same consent page as above; the client polls `/_oauth/token` with
  `device_code` every `interval` seconds (`authorization_pending` until you answer, `slow_down` if it
  asks sooner) and gets the same tokens. A code lasts 10 minutes and works once. On the base host the
  same page asks which workspace. Settings lists such a sign-in as made with a code.
- A sign-in is for the workspace it was made on: its tokens mean nothing on another workspace's host, and a
  `resource` that names another workspace's `/mcp` is refused (with or without a trailing slash).
- Signing out: Settings, Agents (`<workspace host>/_settings/agents`) lists the agents signed in as you
  (name, the host it sends you back to, when, last used), each with Sign out; a client signs itself
  out at `/_oauth/revoke` (RFC 7009); removing a person signs out all of theirs. The next request
  is a 401 that says why, and the agent's next sign-in asks you again.
- Limiting one to some apps: Apps on the same page picks the apps it may use (every app until you
  do); its next sign-in keeps them. [Workspace](./workspace.md), "Limiting an agent to some apps".
- Registered clients' names are their own word, so the consent page shows the host each one sends
  you back to beside it.

An agent that isn't connected yet reads `<workspace origin>/auth.md` (or the workspace host's home with
`Accept: text/markdown`): the address to add, the commands for Claude Code, Codex and the CLI,
and what to tell its human. The 401 for a request with no token says the same in its body, for an
agent whose client doesn't do OAuth by itself: what to tell the person it works for, and where
`/auth.md` is.

The base host's home hands a person one prompt to paste into their agent: "Read
`<base>/start.md`, then help me build a tool". `/start.md` is a first run for that agent:
offer five picks (a message board, a journal, a task organizer, a drawing board, or their own),
then connect if it isn't yet, then add the starter app they picked (`starter_add`) or build the
smallest version of their own, and send the link with four numbered next steps. No other question
comes before the link. The CLI install ends at once with the code the sign-in page shows, so the
agent can tell the person, then waits with `openbelt login --wait`. The connect steps
are in the page itself, the chat apps' among them, since they can't add a server themselves:
Claude's is a link to claude.ai's Add custom connector dialog with the name and address filled in
(`customize/connectors?modal=add-custom-connector&connectorName=…&connectorUrl=…`), ChatGPT's the
steps at chatgpt.com/plugins; either way the person comes back to the same chat. ChatGPT opens the
link a person pastes but not links it finds inside a page, so it can't follow one to `/auth.md`.
A chat app's commands run in a cloud sandbox, so `/start.md` sends it past the CLI install. The
pick and the build are the `docs` tool's start page ([Getting started](./start.md)), every section
of it, which the MCP
instructions point a connected agent to when someone asks for their first tool.

Claude Code and pi send a token over plain HTTP only to the host `localhost`, and `bun run dev`'s
door doesn't answer that name, so locally give them the `https://acme.<your domain>:8445/mcp`
address it prints. Codex, opencode and the MCP SDK take `http://acme.localhost:<port>/mcp` too.

### One address for every workspace

Under email sign-in (`OPENBELT_SIGNIN=email`), the base host (no workspace in its name: `https://<OPENBELT_HOST>`, or `OPENBELT_BASE_HOST` when it has a domain of its own,
`http://localhost:1337`) is one MCP address for every workspace, for someone who doesn't know their workspace's
host or has none yet:

```sh
claude mcp add --transport http openbelt https://<your domain>/mcp   # then /mcp, and sign in
```

Its `/mcp` 401 and OAuth metadata name the base host. The person signs in there with an email
code, or with Google when it's set up ([Email sign-in](./viewers.md#email-sign-in)), then a page asks
which workspace the agent works in: one they're in, one they're invited to
(picking it accepts the invite), or a new one named from their work domain (`ada@initech.com`:
`initech`; personal mail: their own name), which they make there as its first admin, invite-only.

Signed out, the agent's link opens a sign-in page that names the agent the way the consent page
does ("Connect paperbot to OpenBelt", and where it sends you back), so continuing there allows it.
Then nothing more is asked when there is nothing to choose: someone in exactly one workspace goes
straight back to the agent in it, and someone in none (and with no colleague's workspace to ask to
join) gets one named for them, as its first admin. With an invite, a colleague's workspace or two of
their own, the picker asks as before. An agent that knows the person's email (`login_hint`) and a
person signed in to Google make this one tap.
The code and tokens carry the workspace they were made in, by its id (`initech~pra_...`; a renamed workspace
keeps it, [Renaming the workspace](./people.md#renaming-the-workspace)), so the base host's `/mcp`,
`/_oauth/token` and `/_oauth/revoke` pass each to that workspace's own: the agent is that person in that
workspace, as if it had signed in on the workspace's host, and Settings, Agents there lists it. Which workspaces to
offer comes from the base host's index of who is in which workspace (each workspace sends its people as
they're added), checked with each workspace when the page is made.

### Grok Bot and other cloud clients

A cloud client (Grok Bot, Cursor's cloud agents, claude.ai, ChatGPT) runs on its maker's servers,
so the workspace host has to be reachable from the internet: a deploy on a domain, not `bun run dev`
or a tailnet-only OpenBelt. Only signing in goes through your browser. Behind a sign-in proxy,
keep `/mcp`, the OAuth metadata, `/_oauth/token`, `/_oauth/register`,
`/_oauth/device_authorization` and `/favicon.*` open, and let `/_oauth/authorize` and
`/_oauth/device` ask the proxy who you are first.

In Grok Bot, ask in the chat: _"Add a custom MCP server called openbelt at
https://acme.<your domain>/mcp"_ (with "custom server", or it looks in its marketplace), then
Authorize on the card it shows and Allow on OpenBelt's page within about 15 minutes. Grok Bot signs
in as Cursor (it's Cursor's client), so the consent page and Settings, Agents say Cursor and send
you back to `www.cursor.com`. OpenBelt shows itself with its mark: `initialize`'s `serverInfo.icons` (to clients on
2025-11-25 or later), and `/favicon.ico`. The server icon uses the standard tile with a 54% mark;
browser favicons use a 62% mark for legibility at 16-32px.

### Refreshing, and how OpenBelt forgives clients

What goes wrong with OAuth for MCP is how clients keep tokens: several processes share one login
and refresh at once, a refreshed token's write gets lost and the old one comes back, some never
refresh. Measured on OpenBelt (each client signed in, calls spaced past a 60 second token, two
processes started together):

| Client                 | Refreshes                           | Two processes at once         |
| ---------------------- | ----------------------------------- | ----------------------------- |
| Codex 0.164            | before the token runs out           | one refresh, both use it      |
| Claude Code 2.1        | at every start, often several times | one after the other, no clash |
| pi 1.4                 | before the token runs out           | one refresh, both use it      |
| opencode 2.2           | after a 401                         | both refresh the same token   |
| MCP SDK 1.32 (scripts) | after a 401                         | up to the program             |

On a refresh that fails (`invalid_grant`), each tries once and asks you to sign in again; none
loops. So:

- An access token lasts 30 days unused (`OPENBELT_OAUTH_ACCESS_TTL_SECONDS`), and slides while it's
  used: an agent that never refreshes keeps working. Every request is checked against the sign-in,
  so signing out still stops it at once.
- Each refresh gives a new refresh token too, derived from the old one. The previous refresh token,
  until its successor is used, gets that same successor again: refreshes of one token at once all
  get one pair, and a second process or a lost write catches up. One older than that is refused
  (`invalid_grant`) without signing anyone out: the copy with the newest token goes on.
- Signed out on the spot: a refresh token presented by another client (it leaked), or a code used
  twice.

## Tokens

An API token suits any agent on your own machine, and anything that can't sign in (a script, a CI job), sent as
`Authorization: Bearer <token>`.

Make one in your settings (Agents, `<workspace host>/_settings/agents`, signed in through the workspace's
front door: it's shown once, with the `claude mcp add` command), or with a token, another for yourself
(`bun run workspace tokens create --label laptop`, or `POST /_me/tokens/create`); a workspace admin lists and
revokes anyone's. The platform's admin token
makes one for any email, adding them to the workspace when they're new:

```sh
curl -X POST http://acme.localhost:1337/_admin/tokens \
  -H "Authorization: Bearer $OPENBELT_ADMIN_TOKEN" -d '{"email": "ada@acme.com", "days": 30}'
# {"workspace": "acme", "user": "ada@acme.com", "person": "p_...", "id": "t_...", "token": "pr_...", "expires": "...", "mcp": "http://acme.localhost:1337/mcp"}
```

(`"user"` still works in place of `"email"`.) `bun run dev` prints one for you, and
`bun run try:pi` wires one into pi. Only the token's hash is stored, so it's shown once. A
refused token is a 401 that says why: not this workspace's, expired (when), or revoked (when, and by
whom, such as the person being removed).

Tokens made before people existed kept working: each one's user became a person (the email
lowercased; a user that wasn't an email became `<user>@legacy.invalid`), and the apps they own
name them.

## Tools

`tools/list` gives an agent `search` and `call`. Each operation below is run with
`call({ tool, args })`; `search` gives its description and input schema (the text is in
`packages/platform/src/mcp.ts`). A name that isn't an operation is refused with a pointer to
`search`. The `docs` operation is the guide agents read first: sections of
[Getting started](./start.md), [Apps](./apps.md), [SDK](./sdk.md), [Functions](./functions.md), [Code](./code.md), [Who can change what](./rules.md),
[Who is viewing](./viewers.md), [Debugging](./debugging.md) and [Connections](./connections.md),
as those pages have them. With no arguments it's an index (each page, a line on what it covers,
its sections); `docs({ page })` is one page and `docs({ page, section })` one section.

- Finding operations and what the workspace has: `search({ query: "expense reports" })` lists the
  operations that match (up to 6, each with its input schema) and the few apps (each with
  up to 4 functions, matching first, with their input schema and the exact `call_function` call,
  and the collections and skills that match, and its owner) and connections that fit, a few KB however big the
  workspace. Among apps that match as well, yours (you made it or ran its functions) and the ones more
  people run come first, so in a workspace of thousands the app everyone files expenses with outranks
  its look-alikes. It's also how an agent finds a function to run: there's no tool per function.
- Listing or counting apps: `app_list` gives every app in the workspace, a page at a time (default 20, at
  most 50): name, URL, description, owner and last update, with `total` and `nextOffset` (null on the
  last page). `owner` (an email, or `"me"`) lists one person's apps, `sort` is `updated` (newest
  first, the default), `created` or `name`. A page stays small however many apps there are.
- Apps: `app_info`, `app_files` and `app_diff` read them; `deploy_app`,
  `promote_app` and `preview_reset` change them and their preview environments, and `app_delete`
  deletes one for good (`confirm` repeats its name; its owner or an admin). `starter_list` lists the
  starter apps (tested apps with their first data and a skill: messages, journal, tasks, sketch, pulse, cut)
  and `starter_add` adds one as yours, live at once; `search` lists the ones that match and aren't added
  yet under `starters`. `deploy_app` and
  `app_info` return `public`: null, or a public app's URL for anyone and what it reaches there
  ([Apps](./apps.md#public-apps-anyone-opens-them-on-the-public-host)).
- Data: `collection_list`, `collection_add`, `collection_update` and `collection_delete`.
- Functions: `call_function` runs any app's live function (but a webhook's, a trigger's or an
  internal one: `not_callable`); `function_runs` lists their runs, `set_secret`, `webhook_secret`, `webhook_test` and
  `preview_side_effects` serve them ([Functions](./functions.md)).
- Code: `execute` runs your JavaScript with the workspace in reach as `workspace` ([Code](./code.md)).
- Skills: `skills` lists the workspace's skills and reads one ([Apps](./apps.md#skills)). The server
  also declares MCP's skills extension (`io.modelcontextprotocol/skills`) and answers
  `skills/list`, `skills/get` and `resources/read` of a `skill://` URI, for clients that load
  skills themselves.
- Seeing it: `check_app` (a real browser), `app_picture` (the picture the home page shows on an app's
  card, as an image, for a client that shows apps without a browser of its own) and `app_logs`.
- Who you are: `whoami` (the token's person, role and groups, the workspace, how people join it, its
  admins).
- Telling OpenBelt's team about a problem: `feedback_submit` (`category` bug, not_possible, confusing
  or other, a one-line `summary`, the person's `goal`, the `details`, and the `tool` involved) keeps
  the report with your last 20 tool calls as the workspace's activity records them, and returns its
  id (`FB-12`). A workspace sends at most 20 a day. The guide names it, with its arguments, so an
  agent reports without a search first; the CLI's command is `openbelt feedback`.
- Connections, the MCP servers the workspace's admins added: `connections` (which you can use, and
  why) and `connection_call` (call one's tool through OpenBelt). See [Connections](./connections.md).

Every result but `docs` (which is the guide's text) carries `trace`, the id to pass to `app_logs`,
and every error ends with `(trace <id>)`: give it to whoever looks into it. The workspace's admins see
each call in its activity ([Agents' tool calls](./running.md#agents-tool-calls)).

A result is JSON, given once as text and once as `structuredContent`, as the MCP spec asks of a
tool with an output schema. Clients show the model one of the two: Claude Code shows the text,
Codex and opencode `structuredContent`, so neither can be dropped without hiding the result from
some agent. Only a client that hands the model the whole result (pi's code mode) sees it twice;
read `structuredContent` there. Results stay small instead: `app_files` takes `paths`, `around`
and `lines`, a deploy's diff is cut at 4 KB (`app_diff` pages it), and tool descriptions are
short. The server's instructions are short too (Codex repeats them in every tool its tool search
returns); the full introduction opens `docs()`.

Refusals come back as tool errors (`isError: true`) whose text says what to change (`check_app`'s
also carry a report as `structuredContent`, with the reason in `errors`): a missing
`index.html`, a name someone else owns (with a free one to use), an app that doesn't exist (with
the tool that lists them), a deploy that conflicts with a newer one (with a diff of it).

In search results, a connection's `matchedToolCount` counts this query's matches.
`schemasExpanded: false` means its tool schemas have not been loaded. Follow `inspect` to
read the connection; an empty `tools` array does not establish that the connection has no tools.

## Sessions

Each person gets their own MCP server instance (a Durable Object, by their id). It keeps
2025-era sessions, and saves each one's `initialize` request: an idle instance sleeps
after ten minutes (`OPENBELT_ACTOR_SLEEP_SECONDS`), which loses the sessions in memory,
and the next request on a saved session starts it again under the id the client already has, once
however many requests arrive together. So an agent can idle as long as it likes. A session that
can't be started again (one this instance never issued, or one older than the person's newest 50)
gets a 404, and the client starts a new session, as the MCP spec says (one from before people,
when instances were by email, is moved over first). The 404's body is a JSON-RPC error (code
-32001) that names the session, says why, and says to send `initialize` again, and the platform
log has the same line (`MCP session <id> can't be resumed: <why>`), with the trace.
2026-07-28 clients are sessionless, and OpenBelt's tool list never changes, so it takes no
subscriptions: `subscriptions/listen` is refused (-32601, method not found). Every request is checked against its token, so a session id
alone grants nothing, and a removed person's session is refused on its next request.
