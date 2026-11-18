---
title: Connections
description: MCP servers (and HTTP or GraphQL APIs) a workspace's admins add from OpenBelt's catalog or by address (DeepWiki, Linear, an OpenAPI spec), whose tools its people's agents and apps' pages call through OpenBelt; whose token a call uses, signing in with OAuth, who may use which tool, your settings, explain and activity.
---

# Connections

For setup, access changes and your own connection settings through MCP or the installed CLI,
see [Manage a workspace](./workspace.md). Admin operations appear only for workspace admins.

A connection is an MCP server the workspace's admins added, like DeepWiki or Linear, or an HTTP API
(an OpenAPI spec: each operation is a tool) or a GraphQL endpoint (each Query and Mutation field
is a tool). Your agent calls its tools through OpenBelt, which holds the token, decides whether you
may, and keeps a record:

- `connections({ search: "pokemon" })` finds the few connections an app or a task needs, however
  many the workspace has (below). Search before building an app.
- `connections` lists them as you see them: whose token each uses and whether yours is set, your
  level (`none`, `read` or `all`) and which setting gives it, and each tool, usable or not, and
  why. In a workspace of more than 25 connections it lists none, says how many, and to search.
  `connections({ connection: "deepwiki" })` adds each tool's input schema. A connection with more
  than 60 tools (an API's operations) lists none until you search it:
  `connections({ connection: "github", search: "latest release" })` gives the 10 that match
  best, with their input schemas.
- `connection_call({ tool: "<connection>.<tool>", input: { ... } })` calls one, with the input
  its schema asks for. The result is the server's own content (`isError` when its tool failed),
  then a line with the outcome, the time it took and the trace; `structuredContent` has the same,
  with `outcome` (whether it ran, failed, or OpenBelt refused it, and why). Some servers take 10-60
  seconds.

### Finding one

Before building an app, search for what it's about: its data or its service.

```js
connections({ search: "pokemon" }) // pokeapi, with pokemon_retrieve, pokemon_list, ...
connections({ search: "weather forecast" }) // weather-gov
connections({ search: "a team lunch poll" }) // none: build without one
```

- It searches every connection, MCP servers and APIs alike, and lists at most 5, best first, each
  with at most 3 of its tools that match, without input schemas (a few KB, however big the workspace).
  `connections({ connection, search })` then gives a tool's input schema.
- It matches whole words (`pet` finds `addPet` and `pet_list`, not `competitor`), in a
  connection's name and what its catalog entry says it is, its tools' names, and their
  descriptions' first lines. A word counts more the fewer connections have it: `list` and `get`,
  in nearly every API, count for little, `pokemon` for a lot. A connection is found only by a
  word few others have (1 in 20 or fewer, in its name or a tool's name; at most 2, in a
  description), so a request no connection is about finds none.
- When none of the workspace's connections fits, `notAdded` lists OpenBelt's catalog entries that may
  (`connections({ search: "dropbox files" })`: Dropbox, Google Drive): a workspace admin adds one in
  Settings, Connections. Ask the person; don't make up its data.
- Words mean what they say, not what they're like: `encyclopedia` finds Wikipedia because its
  catalog entry says so. A search that finds nothing is worth one more try in other words.

OpenBelt's own tool list stays the same whatever the workspace adds: connection tools are called by
name, `<connection>.<tool>`.

## Whose token

Each connection's credential belongs to one of:

| credential  | Who sets the token                                       | A call runs with                   |
| ----------- | -------------------------------------------------------- | ---------------------------------- |
| `none`      | nobody: the server takes none (DeepWiki)                 | no token                           |
| `workspace` | a workspace admin, once for everyone                     | the workspace's token              |
| `person`    | each person, their own                                   | your own token                     |
| `both`      | the workspace has one, and each person may set their own | whichever there is; `as` when both |

With both tokens there, `connection_call` needs `as: "workspace"` or `as: "me"`, and is refused
without it, naming both.

Most servers sign in with OAuth (below). For one that takes a pasted token, the person pastes
theirs on the connection's page, `<workspace host>/_connections/<name>`, or in a terminal
(`setYourToken` says how):

```sh
pbpaste | bun run workspace connections token linear --mine     # from an OpenBelt checkout
curl -X POST https://acme.example.com/_me/connections/linear/token \
  -H "Authorization: Bearer $OPENBELT_TOKEN" --data-binary @-    # paste it, then Ctrl-D
```

Never paste a token into a chat with an agent, and an agent never asks for one. A token is never
in a result, an error, a list or a log line; a server that echoes one back gets it replaced by
`***`.

### Signing in with OAuth

Most servers (Linear, Notion, GitHub, Gmail, Jira and Confluence) take no pasted token: the
person signs in to the service, in a browser, and allows OpenBelt. `connections` says
`signIn: "oauth"` for such a connection.

- If a connection signs in with OAuth and isn't connected, send the person its link (`connect`
  in `connections`, and in the refusal). They open it, sign in, and come back to the
  connection's page. Never ask anyone for a token.
- The link is the person's alone and works for 10 minutes. Calls then run as the account they
  signed in with, at their level.
- OpenBelt keeps the sign-in fresh by itself. A service that's down or busy only delays it; nobody
  has to do anything.
- When a service stops accepting a sign-in (the person revoked OpenBelt's access, or changed their
  password), `connections` says so in `reconnect`, and every call is refused with the same link
  to connect again. Their own: they connect again. The workspace's: an admin does.
- What the person allows can be less than OpenBelt asked for (Google lets you untick each
  service). `scopes` shows what's missing, and a tool that needs it is refused with a link that
  asks for it again.
- An app's page that needs it sends the person to connect the same way, and they allow the app
  after ([In apps](#in-apps)).

## Who may use what

Each connection has a level for everyone, and an admin may set one for a group or a person:

- `none`: no tools.
- `read`: the tools the server marks read-only (`readOnlyHint`), and the tools an admin or
  OpenBelt's catalog marked read (DeepWiki's three, from the catalog).
- `all`: every tool.

Your level is your own if an admin set one, else the lowest among your groups that have one,
else everyone's. On top, an admin can turn a tool off for everyone.

That level is the most you can use. You can choose less for yourself, on the connection's page:
read only, off, or one tool off. What you get is the stricter of the two, so an admin's limit
always wins and nobody can choose their way past it; your own choice is yours alone to undo (an
admin can't), and one made under a lower level is kept for when it rises. A refusal says which
setting refused the call, whose it is (`own` for your own choice), and who can change it: to an
admin, the command that does it; to anyone else (a member's agent, a person viewing an app's
page), which admins to ask, by email, and no command. The `connections` tool shows both layers:
`level` (the workspace's), `ownLevel` and `ownOff` (yours), `gets`, and `asked` while you've asked for
more.

## In apps

An app's pages call connection tools with `tools.call` from `/sdk.js`, for whoever is viewing
([SDK](./sdk.md#connections-toolscall)). Its openbelt.json `"tools"` lists each one and binds it:

- `"viewer"`: the viewer's own token, at their level. Before the first call runs, they connect
  theirs (if they haven't) and allow the app on Connections (`/_connections`), which lists
  exactly the tools the app binds to `"viewer"` there. Consent is for one person, one app, one
  connection, and those tools: a deploy that binds more asks again. They take it back on the
  same page. On a server that signs in, whose tools nobody has listed yet (nobody connected it),
  the first viewer is asked to connect theirs too, and is back on the review page once they have.
- `"workspace"`: the workspace's token, or none for a server that takes none, at the viewer's level. No
  consent: the workspace's admins set the token and the levels.

Nobody signed in gets only a tool that takes no token. A removed member gets nothing. A level of
`none` refuses an app's call as it refuses an agent's. The caller app is the host the page is on
(`<app>--<workspace>.<domain>`), so one app's page can't call as another, and another origin's request
to an app's `/_tools/call` is refused.

### What's refused, and why

A refused call rejects with `code`, `message`, `fix`, `url` (Connections, for `needs_token`
and `needs_consent`), `setting` and the trace. It's a line in the app's log (`app_logs` with the
trace) and in the workspace's activity with the app's name; an admin's explain with `app` runs the same
decision as a page of that app. Deploying warns about a binding that can't work, naming it: no
such connection or tool, `"workspace"` on a connection that takes only people's own tokens (or
`"viewer"` on one that takes only the workspace's), a disabled tool, a level nobody has, a workspace token
not set yet.

`check_app`'s test people have no tokens: a tool bound to `"viewer"` is refused `test_person`,
one bound to `"workspace"` runs at the level of the person whose agent ran the check (never more than
they could use themselves). An app that binds tools gets 30 more seconds per check.

An app's functions (openbelt.json `"uses"`) are held to the same levels: a run is judged as whoever
started it, even a `later` or trigger run it booked, and a schedule's or webhook's (no person) at
the stricter of everyone's level and the app owner's ([Functions](./functions.md)). `"uses"` asks
for every tool of the connection (`<connection>.*` on Connections), with the same consent as the
page's `"viewer"` tools. A function runs with a person's own token only while they use the app
themselves: from its own page, from their agent (`call_function`), or by hand as its owner or an
admin, and only once they allowed the app all of what it asks for there. Another app's page
calling the function, and a `later` or trigger run they started, get the workspace's token only (on a
connection that takes only people's own tokens, the call is refused, saying so).

## Google's APIs

Google's Calendar, Sheets, Docs, Drive and Gmail APIs are in the catalog (`google-calendar-api`,
`google-sheets-api`, `google-docs-api`, `google-drive-api`, `google-gmail-api`), read from
Google's Discovery documents. Each person signs in with their own Google account, at the workspace's one
Google OAuth app ([below](#signing-in-what-admins-set-up)). None needs Google's preview program,
and none asks for a scope Google gives only apps that pass its yearly security assessment, so a
Google app that's in production works for any Google account:

- Calendar, Sheets and Docs ask to read. With everyone's level at `all`, a person's first change
  answers with a link that asks Google for it (`calendar.events`, `spreadsheets`, `documents`).
- Sheets and Docs reach any sheet or document the person can open, by its ID: the part of its
  link after `/d/` (`https://docs.google.com/spreadsheets/d/<id>/edit`). A person who pastes a
  link has given you the ID.
- Drive asks for `drive.file`: it sees only the files made through the workspace's Google app (sheets
  and documents made with Sheets and Docs too), not the rest of the person's Drive, so it can't
  search it.
- Gmail only sends (`gmail.send`): `google-gmail-api.gmail_users_messages_send` with
  `{"userId": "me", "body": {"raw": "<the RFC 2822 message, base64url>"}}`, built in code. Reading
  mail needs a scope from that yearly assessment.

A tool is named for Google's method after the connection's name, which is the catalog's id unless
an admin gave it another: `calendar.events.list` is `google-calendar-api.calendar_events_list`. A
range names its tab by title; a link's `gid` is the tab's `sheetId`, which
`google-sheets-api.sheets_spreadsheets_get` lists:

```js
connection_call({
  tool: "google-sheets-api.sheets_spreadsheets_get",
  input: { spreadsheetId: "<the ID from its link>" },
  fields: ["sheets.properties.sheetId", "sheets.properties.title"],
})
connection_call({
  tool: "google-sheets-api.sheets_spreadsheets_values_get",
  input: { spreadsheetId: "<the ID from its link>", range: "Requests!A1:D50" },
})
```

## Marks

A connection's tile in Connections is its service's logo on the service's brand color (GitHub,
Figma, Linear, Notion, Stripe and about twenty more), or, with none, its first letter on a tint of
one of twelve colors made from its name: the same connection is the same color everywhere. OpenBelt looks for a
logo by the catalog provider the connection is, then by its name (`figma`, `github-api`,
`google-calendar`), so a connection added by address under a service's name gets its logo too. A
near-black brand (GitHub, Vercel) takes the page's own text color, so it shows in light and dark.
The logos are Simple Icons' (CC0), in `packages/platform/src/marks.ts`; Slack and Salesforce aren't
in that set, so theirs are letters.

A workspace admin can put their own icon in its place, for everyone in the workspace: click the tile beside
the name on the connection's page and pick an image (it's uploaded at once), or
`bun run workspace connections icon <name> <image file>`
(`POST /_workspace/connections/<name>/icon` with `{"type": "image/png", "base64": "..."}`). It's a PNG,
JPEG, GIF, WebP or SVG up to 64 KB; a square one looks best. The x on the tile's corner (or
`--clear`, `/icon/clear`) goes back to the logo or letter. Anyone signed in to the workspace gets it at
`/_connections/<name>/icon`; an SVG's scripts never run there.

## Your settings

Connections (`<workspace host>/_connections`), beside Apps in the gallery's sidebar, puts what needs
you first, so it reads the same with 3 connections or 300:

- Needs you: a sign-in that stopped working, saying when ("Notion stopped accepting your sign-in
  yesterday"), with Connect again; and a card for each app whose page asked for your connections
  and is still waiting: its name, what it wants ("Wants to use your GitHub and Linear"), Review and
  Not now. Review opens the app's review page; Not now takes the card off until the page asks
  again. No card takes a token: that happens only on OpenBelt's own pages.
- A line naming what isn't working, and which admins to ask about it.
- You can use: what your workspace gives you, each with what you get and where it comes from ("Read
  only · workspace default", "All tools · eng group") or what you chose.
- Your workspace hasn't given you: folded; open one to ask for it. A search (`/`) looks through both.
- The apps you allowed, with their tools (revoke).

Each connection has its own page (`/_connections/<name>`):

- At the top, its state and the one thing to do: Connect, or Connect again. When you didn't allow
  everything on the service's own screen, it says what's missing in words ("You didn't allow
  Gmail on Google's screen") with one button that asks for it again.
- For an admin, what the workspace set (whose account, what people can do), and anything left to set
  up: the OAuth app for a service that needs one, or the workspace's own sign-in.
- What you use: All, Read only or Off, the ones above your workspace's level locked. When your workspace
  gives you less than all, ask for more there, saying why (optional): your admins see it in
  Events, Requests, and you can take it back. Nothing given: which setting has it off, said once
  under the name, then Ask for read only, and the tools read only would give you (the rest under
  Technical details).
- Its tools in words ("See your pull requests", the id in the tooltip), each on or off for you; one an admin
  turned off, or above what you get, is locked and says why.
- Whose account it runs with, your own (paste it, or disconnect), and the apps you let use it.
- For an admin, Who has access: everyone's level, then each group and each person's exception that
  sets one. Change a group's on its page in Groups, a person's on People.

An app's page sends you here when a call needs your sign-in or your consent: OpenBelt's sheet in
the page ("This app wants to use your GitHub and Linear", Review) links to the app's review page,
`/_connections?connect=<connection>&app=<app>`. It asks once for every account the app's
`openbelt.json` binds to `"viewer"`: the app's tile and the accounts' marks, "Allow this app to use
your accounts", the app's name under it, then a row each (its tools under "3 tools"):

- Connect, when you haven't: a server that signs in signs you in and brings you back; one that takes
  a token opens a step of its own for it (`&step=token`), then comes back.
- Connected, Allowed (already), or Off for you (an admin's level; ask them).

Allow, once every account it needs is connected, allows the app on all of them at once and takes
you back to its page.

`<workspace host>/_settings`, from the menu at the sidebar's foot where your name is, has the rest.
Both are OpenBelt's own pages, for whoever the front door says is viewing: an app can't frame
them, and only they can change them (a POST from anywhere else is refused).

- Agents (`/_settings/agents`): the address to give your agent, the agents signed in as you, and
  your tokens for an agent that can't sign in: make one (shown once, with the `claude mcp add`
  command filled in), revoke.
- People, Groups, Connections and Events, for admins: who is in which group and what each group
  can use ([People and groups](./people.md#in-settings)), the workspace's connections and adding one
  (From the catalog, below), and Events, below under For admins.

Settings is one centered page with its own list of pages beside it (on a phone, a menu at its
top), and Back at the top of that list goes to the workspace's apps. The old `/_account`,
`/_settings/connections` (with a query, or for a member), `/_connections?c=<name>`, `/_access` and
`/_settings/access` links still work: they go to Connections, the connection's page and Events,
query and all.

## For admins

Workspace admins manage connections in Settings (From the catalog, below), or with their own API token
through `bun run workspace` or the HTTP routes below ([People and groups](./people.md#bun-run-workspace) says
how to point it at your OpenBelt).

### From the catalog

OpenBelt has a catalog of MCP servers it knows (Linear, Notion, Jira and Confluence, Sentry, Asana,
Stripe, Supabase, monday.com, Dropbox, Zendesk, GitHub, Gmail, Google Calendar, Google Drive,
DeepWiki, Cloudflare docs), of APIs people sign in to (Google's Calendar, Sheets, Docs, Drive and
Gmail APIs, [above](#googles-apis)), and of APIs that need no sign-in (PokeAPI, Countries, the
National Weather Service, Frankfurter's exchange rates, Wikipedia, xkcd, and Swagger's Petstore
sandbox).
Each knows its address, how people sign in, and good defaults: whose account (each person's own,
mostly), read only for everyone, the read-only scopes to ask for, and which tools only read when
the server doesn't say. An API also knows its spec, the parts of it a workspace gets, fixes to what
the spec gets wrong (Petstore's `addPet` needs an `id`; xkcd's tools get names), and one call it
makes when added, to show it answers. So adding one is its name:

```sh
bun run workspace connections add linear                                   # the catalog's defaults
bun run workspace connections add stripe --credential person --everyone all  # any flag overrides one
bun run workspace connections add linear-eng --provider linear             # a second one, another name
bun run workspace connections add pokeapi                                  # an API: "test call pokemon_retrieve: ok"
bun run providers list                                               # what's in it
```

Over HTTP it's `POST /_workspace/connections/add` with `{"provider": "linear"}`, and any of `name`,
`url`, `credential`, `everyone`, `signIn`, `scopes`, `authorizeParams` (and an API's `spec`) to
override. An id the catalog doesn't have is refused, naming the closest. An API's answer has
`tested`: its test call's tool, whether it answered as expected, and the start of what it said.

In a browser, Settings > Connections (`<workspace host>/_settings/connections`, admins only) lists the
workspace's connections, each with its state: Ready, Needs setup (an OAuth app to register), the workspace's
sign-in stopped working, or how many people connected theirs. Add a connection opens the catalog
(search it with `/`; Gmail, Google Calendar and Google Drive are together under Google
Workspace). A service's page asks two things, whose account and what people can do, then adds it
and opens its page. A server not in the catalog is added by its address there too.

The catalog is data: a folder per service in `packages/platform/providers/`, a file per server or
API in it (its [README](../packages/platform/providers/README.md) has the format). `bun run check`
holds every file to it, and `bun run providers probe` asks each live server, without an account,
whether it still signs in the way its file says, and reads each API's spec, applies its fixes and
makes its test call.

### Signing in: what admins set up

Most services need nothing: OpenBelt registers itself with the service's sign-in server when you
add the connection. A few need more:

- GitHub, Asana and Google don't let OpenBelt register itself. You register an OAuth app (the
  service's name for a client of its sign-in) there once: their Add page, and the connection's
  page until it's done, say where, show the callback URL to give it, and take its client ID and
  secret. GitHub's OAuth apps need the secret even with PKCE. The callback URL is the same for
  every connection at that sign-in server, so all of Google's (its MCP servers and its APIs)
  share one Google OAuth app: once one has it, adding the others asks for nothing. To replace it, use the connection's
  page, or `bun run workspace connections client <name> --client-id <id> < secret.txt`.
- Google's Workspace MCP servers are a preview: the Google Cloud project that owns your OAuth app
  must be in the [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview),
  and from 11 November 2026 its client must have "Use this client for an AI-powered agent" ticked
  (set when the client is made: an older one is replaced). Google's APIs need neither.
- Zendesk reads OpenBelt's client metadata document from your workspace host, so the workspace host has to be
  reachable from the internet: https, with no tailnet in front of it.
  Linear and some others refuse an `http://` callback: connect from an https workspace host
  (a server on a public domain).
- One account for everyone: after adding, connect the workspace's sign-in on the connection's page
  (Connect for the workspace), or `bun run workspace connections connect <name> --workspace`, which prints the
  link. `--mine` prints yours.
- Scopes: a catalog connection asks for the catalog's (read-only where the service has them). One
  added by address asks for what the server's 401 challenge names, else the scopes its metadata
  offers that read (`read`, `gmail.readonly`; never Gmail's whole-mailbox
  `https://mail.google.com/`), else all it offers, plus `offline_access` when it offers that.
  `--scopes "read"` asks for exactly those. `--authorize-params "key=value"` adds or overrides
  any authorize parameter for one connection.
- `bun run workspace connections renew <name> --mine` (or `--workspace`) refreshes a sign-in now, to check it
  still works (`POST .../signin/refresh` over HTTP). `connections show` says where it signs in,
  where OpenBelt is registered, and whose sign-in needs connecting again.
- An admin who'd rather paste a token adds the connection with `--sign-in token`.

Everything else is the same for a signed-in credential as for a pasted one: levels, explain,
activity, apps' consent and functions' `"uses"`.

### By address

```sh
bun run workspace connections add deepwiki https://mcp.deepwiki.com/mcp --credential none
bun run workspace connections add linear https://mcp.linear.app/mcp --credential both --everyone read
bun run workspace connections connect linear --workspace                         # signs in with OAuth: prints the link
bun run workspace connections renew linear --workspace                           # refresh the workspace's sign-in now
bun run workspace connections add gh https://api.githubcopilot.com/mcp/ --credential person --scopes "read:user"
bun run workspace connections client gh --client-id Ov23li... < secret.txt # GitHub: an OAuth app you registered
bun run workspace connections add sentry https://... --credential workspace --sign-in token
bun run workspace connections token sentry --workspace < sentry-token.txt      # or --from-env SENTRY_TOKEN
bun run workspace connections list                                         # --mine: as you see them
bun run workspace connections show linear
bun run workspace connections refresh linear                               # list its tools again
bun run workspace connections remove linear
bun run workspace access linear everyone all
bun run workspace access linear group:contractors none
bun run workspace access linear person:dave@acme.com all
bun run workspace access linear person:dave@acme.com unset
bun run workspace access linear disable delete_issue
bun run workspace access linear read <tool>                                # mark it read; unread undoes it
bun run workspace explain bob@acme.com linear.create_issue         # --with workspace|me
bun run workspace explain bob@acme.com linear.get_me --app my-issues        # as a page of that app
bun run workspace activity --connection linear --person bob@acme.com
bun run workspace activity --app my-issues                                     # one app's pages' calls
bun run workspace activity --tool deploy_app --outcome refused                 # agents' refused deploys
```

In a browser, a group's page in Settings (`<workspace host>/_settings/groups/<name>`) sets what the
group can use, and People sets one person's exceptions ([People and groups](./people.md#in-settings)).
Search events and press Enter, or choose Person, Tool, App, Result or Source below the search field. Each picker searches its values; active filters appear as removable chips. Removing one preserves the others.

Settings, Events (`<workspace host>/_settings/events`) is for admins only (members have no Workspace
pages):

- OpenBelt MCP calls and calls agents and apps made to connections, newest first: who, which
  tool, client or app, result and duration. Search by person, tool, app or trace; filter by source
  and result. Each page shows 50 events, from the latest 5,000 MCP calls and 500 connection calls.
- Expand a call for its recorded error, arguments and trace. Filter by Person, Tool and App
  to narrow the history. A link `/_settings/events?person=<email>&tool=<connection>.<tool>`
  (with `&app=<app>`) opens that filtered history. Change access on People, Groups or the
  connection's page.
- Access requests on Connections (`/_settings/events/requests`) groups people's asks for more by connection and level,
  biggest first, each with where its askers' levels come from, their reasons, and the one change
  that answers the most of them while changing the fewest who didn't ask (its counts open who
  asked and who else it changes). Or give just them an exception each, or not now. Each person
  asks once per connection; a request closes itself once a change answers it, or after 30 days.

- A connection's name is 1-30 lowercase letters, digits and dashes, starting with a letter. Its
  URL is https to a public host: an address of this machine or a private network (`10.x`,
  `192.168.x`, `169.254.x`, `100.64.x`, `fd00::`, `localhost`, `*.internal`, `*.ts.net`) is
  refused, and so is a name that resolves to one, or one of OpenBelt's own hosts (its workspace and app
  hosts). `bun run dev` and verify also take `http://localhost` on another port than OpenBelt's or its
  owner door's (`OPENBELT_ALLOW_LOCAL_CONNECTIONS`), for an MCP server on your machine. A function's `fetch`
  follows the same rule.
- A new connection's everyone level is `read` unless `--everyone` says.
- Adding one asks the server, without a token, whether it signs in with OAuth
  ([How it works](#sign-ins-oauth)), and registers OpenBelt with its sign-in server if it does;
  every URL its metadata names is held to the rule above. `--sign-in oauth` refuses one that
  doesn't; `--sign-in token` skips asking. Its tools are listed once someone connects.
- Adding one lists its tools at once (names, descriptions, input schemas, annotations), with the
  workspace's token if it has one, else yours. Setting the workspace's token lists them again; so does
  `refresh`. A refresh that fails keeps the last list, and says why in `connections show` and in
  everyone's `connections`; Connections shows it as not working, with the reason on its page.
- A server that adds tools never widens what anyone can call: a tool a later list has that the
  last one didn't is off for everyone (disabled) until an admin turns it on
  (`bun run workspace access linear enable <tool>`). `refresh` names them. The first list isn't held:
  you review it when you add the connection.
- A token is read from stdin or `--from-env VAR`, never a command-line argument (your shell keeps
  those), and the CLI never prompts. `--clear` removes one.
- Removing a person deletes their tokens ([People and groups](./people.md#removing-someone)).
- `explain` runs the same decision a call does and prints each step: the tool, whether it's
  disabled, the person's level and where it comes from, whose token.
- `activity` lists the last 500 calls, newest first: when, who, as whom, the tool, the outcome,
  how long, the trace and why a refused or failed one didn't run. Each call is also one line in
  the platform log with its trace. It lists agents' calls to OpenBelt's own tools first (`tools`
  in `/_workspace/activity`): `--connection` shows only connections' calls, `--tool deploy_app` only
  OpenBelt's ([Agents' tool calls](./running.md#agents-tool-calls)); `--outcome` narrows both.

### APIs (OpenAPI and GraphQL)

An API that has no MCP server is added from its spec. Its tools then work like any connection's:
levels, `read` (an operation that's GET, HEAD or OPTIONS, or a GraphQL query, is read-only),
disabled tools, explain, activity, apps' `tools` and code's `workspace.connections`.

```sh
bun run workspace connections add petstore --kind openapi --spec https://petstore3.swagger.io/api/v3/openapi.json --credential none
bun run workspace connections add xkcd https://xkcd.com --kind openapi --spec https://api.apis.guru/v2/specs/xkcd.com/1.0.0/openapi.json --credential none
bun run workspace connections add github --kind openapi --spec <api.github.com.json URL> --credential workspace --tags repos,users
gh auth token | bun run workspace connections token github --workspace
bun run workspace connections add internal --kind openapi --spec https://internal.example.com/openapi.yaml --credential workspace --auth header:x-api-key
bun run workspace connections add countries https://countries.trevorblades.com --kind graphql --credential none
bun run workspace connections add ghql https://api.github.com/graphql --kind graphql --credential workspace --tags query
```

- The spec is OpenAPI 3 or Swagger 2, JSON or YAML, or a Google Discovery document
  (`https://www.googleapis.com/discovery/v1/apis/<api>/<version>/rest`), at a URL (`--spec`,
  fetched again on every `refresh`), up to 32 MB. A Discovery document's methods are named by
  their ids (`calendar.events.list` is `calendar_events_list`) and tagged with the scopes that
  allow them, short (`gmail.send`), so `--tags gmail.send` takes what that scope can do. Its
  local `$ref`s are resolved into each tool's input schema, less deep where that would pass
  16,000 characters.
- A tool's name is the operation's `operationId` (`repos/list-for-user` is `repos_list_for_user`),
  or its method and path when it has none. Its input is the path, query and header parameters by
  name, and `body` for the request body: `{ "petId": 3 }`, `{ "body": { "name": "Rex" } }`.
- Calls go to the spec's first server (a relative one against the spec's URL); the URL after the
  name overrides it (xkcd's spec says http, which OpenBelt doesn't send to).
- The token goes where the spec's security scheme says (an API key header or query parameter,
  HTTP basic, else a bearer header); `--auth bearer|basic|header:<name>|query:<name>` says
  otherwise. An API added by its spec takes a pasted token; one from the catalog that people sign
  in to ([Google's](#googles-apis)) signs in with OAuth like an MCP server: where its protected
  resource metadata says, else at its catalog entry's issuer. Its token is refreshed once when the
  API answers 401, and a 403 for a missing scope hands the person a link that asks for it.
- A spec of more than 300 operations isn't added until you pick its tags: the refusal lists them
  with their counts. `--tags repos,users` takes those; `--tags '*'` takes all. Adding again with
  more tags is your review of them; what a refresh finds that's new in tags you already took is
  off until you turn it on, as for any connection.
- A GraphQL tool's input is the field's arguments and `select`, a selection set
  (`"name countries { name capital }"`); without it OpenBelt picks the field's scalars and one level
  of its objects'. A `select` must open and close its own braces: one that would end the field is
  refused, nothing sent. Its tags are `query` and `mutation`.
- The result is the API's answer body: up to 1 MB for apps and code; an answer past 10 MB isn't
  read at all (the call is refused, saying to ask for less). A status past 2xx is the tool's error,
  with the status and body; a 401 says to set the token again; a 429, to try later. A GraphQL
  answer's `errors` are the tool's error.
- Each request carries the call's trace as `X-Correlation-Id`.

#### Big answers: fields

An agent's `connection_call` shows at most 24,000 characters of an answer, still JSON when it
was JSON (a list keeps its first items, an object leaves out its biggest fields), with a line
saying what was left out. To get what you need instead, name it with `fields`, OpenBelt's option
beside `input` (never in it), by dot path through arrays:

```js
connection_call({
  tool: "pokeapi.pokemon_retrieve",
  input: { id: "pikachu" },
  fields: ["name", "types.type.name", "sprites.front_default"],
})
// {"name":"pikachu","types":[{"type":{"name":"electric"}}],"sprites":{"front_default":"https://..."}}
```

A page does the same with `tools.call(name, input, { fields })` ([SDK](./sdk.md)), so only those
parts reach the browser. A tool error's answer is kept whole.

#### Read-only, and what a refresh holds

GET, HEAD and OPTIONS operations and GraphQL queries are read-only; every other operation needs
`all`, and its refusal says so. A refresh holds a tool (off until an admin turns it on, as for a
new one) when it's new, when it's now sent another way (getItem, now a PUT), or when it now says
it's read-only and didn't before. That last one goes for MCP servers too: a server that starts
marking `delete_thing` read-only doesn't open it to everyone at `read`.

## HTTP

Each is one request with `Authorization: Bearer <token>`; like the rest of `/_workspace` and `/_me`,
anything a browser sends (a cookie, an `Origin`) is a 401, so no app page can reach a token.

| Route                                                           | Who             | Body                                                                                                                                                                    |
| --------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_me/connections`                                          | anyone          |                                                                                                                                                                         |
| `POST /_me/connections/<name>/token`, `/token/clear`            | anyone          | the token, raw (or `{"token": "..."}`); `/token/clear` also disconnects a sign-in                                                                                       |
| `POST /_me/connections/<name>/connect`                          | anyone          | none, or `{"scope": "..."}` to ask for a scope a tool needed: answers `{"url"}`, the sign-in link to open (a server that signs in with OAuth)                           |
| `POST /_me/connections/<name>/signin/refresh`                   | anyone          | none: refreshes your sign-in now (`renew --mine`)                                                                                                                       |
| `POST /_me/connections/<name>/own`                              | anyone          | `{"level": "read"}`: less for yourself (`all` undoes it)                                                                                                                |
| `POST /_me/connections/<name>/own/tool`                         | anyone          | `{"tool": "create_issue", "on": false}`                                                                                                                                 |
| `POST /_me/connections/<name>/ask`, `/ask/cancel`               | anyone          | `{"want": "all", "note": "why you need it"}`                                                                                                                            |
| `GET /_workspace/connections`, `/_workspace/connections/<name>` | workspace admin |                                                                                                                                                                         |
| `POST /_workspace/connections/add`                              | workspace admin | `{"provider": "linear"}` (the catalog), or `{"name": "deepwiki", "url": "https://...", "credential": "none", "everyone": "read"}`, and `"signIn": "oauth"` or `"token"` |
| `POST /_workspace/connections/remove`, `/refresh`               | workspace admin | `{"name": "deepwiki"}`                                                                                                                                                  |
| `POST /_workspace/connections/<name>/token`, `/token/clear`     | workspace admin | the token, raw (or `{"token": "..."}`)                                                                                                                                  |
| `POST /_workspace/connections/<name>/connect`                   | workspace admin | none, or `{"scope": "..."}`: answers `{"url"}`, the workspace's sign-in link                                                                                            |
| `POST /_workspace/connections/<name>/signin/refresh`            | workspace admin | none: refreshes the workspace's sign-in now (`renew --workspace`)                                                                                                       |
| `POST /_workspace/connections/<name>/client`                    | workspace admin | `{"clientId": "...", "secret": "..."}`: an OAuth app you registered at the service                                                                                      |
| `POST /_workspace/access`                                       | workspace admin | `{"connection": "linear", "who": "group:contractors", "level": "none"}`                                                                                                 |
| `POST /_workspace/access/tool`                                  | workspace admin | `{"connection": "linear", "tool": "delete_issue", "change": "disable"}`                                                                                                 |
| `GET /_workspace/access/asks`                                   | workspace admin |                                                                                                                                                                         |
| `POST /_workspace/access/asks/grant`, `/asks/close`             | workspace admin | `{"connection": "linear", "want": "all", "people": "bob@acme.com,carol@acme.com"}`                                                                                      |
| `POST /_workspace/explain`                                      | workspace admin | `{"person": "bob@acme.com", "tool": "linear.get_me", "as": "me"}` (or `"app": "my-issues"`)                                                                             |
| `POST /_workspace/activity`                                     | workspace admin | `{"connection": "linear", "person": "bob@acme.com", "app": "my-issues", "limit": 50}` (or `"tool"`, `"outcome"`)                                                        |

`who` is `everyone`, `group:<name>` or `person:<email>`; `level` is `none`, `read`, `all`, or
`unset` (a group's or person's). `change` is `disable`, `enable`, `read` or `unread`. A tool is
named with or without its connection (`create_issue` or `linear.create_issue`). An ask's `want`
is `read` or `all` (the next level up when left out) and its `note` at most 200 characters, on
one line. `asks/grant` gives each asker an exception at the level they asked for and closes their
asks; `asks/close` closes them; `people` (emails or ids, comma-separated) limits either to those
people, and leaving it out takes every open ask for that level. An exception for someone removed
from the workspace is refused, and explain says they were removed.

## How it works

- WorkspaceDO keeps the connections, their tool lists, the sealed tokens, the settings and the last
  calls, and makes every call: OpenBelt reaches the server from there, never from a page.
- Tokens are sealed with AES-GCM under the Worker secret `OPENBELT_SECRETS_KEY`, each bound to its
  connection and owner. Every deploy needs one (the launchers make theirs); keep it, since tokens
  sealed under one don't open under another.
- The client speaks Streamable HTTP: JSON or SSE replies, `Mcp-Session-Id` kept (and the session
  opened again when the server forgets it), and each request on its own for a server without
  sessions (2026-07-28). It doesn't follow redirects.
- Sessions are per connection and per credential: the workspace's token has one, each person's own has
  theirs, and a server that takes no token still gets one per person. One person's call never
  runs on a session another's token opened.
- A tool call has 60 seconds; listing tools has 20. A result past 100,000 characters is cut, with
  a note saying how long it was. A reply past 16 MB isn't read at all: the call fails, saying so.

### Sign-ins (OAuth)

The engine is `oauth-discovery.ts` (finding a server's sign-in), `oauth-client.ts` (registering,
grants, revocation), `providers.ts`'s `quirksOf` (what a provider needs beyond the standard, by the
provider id kept on the connection) and `signins/` in WorkspaceDO: `store.ts` (credential rows, a pasted
token or a sign-in), `registrations.ts`, `refresh.ts` (a refresh once per credential, and the
background sweep), `revocation.ts` and `flow.ts` (discovery, Connect and the way back).

Finding out:

- OpenBelt finds out whether a server signs in with OAuth when an admin adds the connection, the
  way the MCP authorization spec says. The server answers 401 with a `WWW-Authenticate: Bearer`
  challenge, its protected resource metadata (RFC 9728) names an authorization server, and that
  server's metadata (RFC 8414) has PKCE.
- A server that answers without a token but publishes protected resource metadata at its
  well-known URL is found the same way when it's added (Google's Workspace servers do this).
- A server that publishes none and asks only when a tool is called (a 401 naming per-tool
  metadata) is found on that call. The connection signs in with OAuth from then on, and a pasted
  token it turned down goes.
- The sign-in page a server sends people to is held to the same rule as the connection's URL
  (https, a public host).

Registering: OpenBelt has one registration per authorization server and workspace host, shared by every
connection that signs in there. It's made in MCP's order:

1. An OAuth app an admin registered (`connections client`).
2. Else its client metadata document, `<workspace host>/_oauth/clients/<registration>.json`, when the
   server takes one and can reach the workspace host (https, with no front door: not a tailnet or
   Access).
3. Else dynamic client registration (RFC 7591).

A server that can't use the document (`invalid_client` on the way back) gets OpenBelt registered the
other way. Sign-ins come back to their registration's callback,
`<workspace host>/_oauth/callback/<registration>` (the authorization server's host and a hash of its
issuer: `accounts_google_com-1a2b3c4d5e6f`). There's one per authorization server, so Gmail and
Calendar on one Google OAuth app share it.

Refreshing:

- OpenBelt refreshes the access token a minute before it expires (halfway, for one that lasts under
  two minutes). It does this in the background for a sign-in used in the last 7 days (one idle
  longer is refreshed by its next call), and when the server answers 401. However many calls need
  it at the same time, there's one refresh.
- A refresh sends back the scope the sign-in was granted, and the client secret the server gave at
  registration, the way it said. A server that refuses the `resource` parameter gets the request
  once more without it, and isn't sent it again (Entra).
- A refresh the server doesn't answer (a 503, a timeout) or rate-limits (429, or "User rate limit
  exceeded" in whatever words) changes nothing. Calls go on with the token while it lasts, and the
  next try waits: 30 seconds, doubling to 15 minutes, or longer when its `Retry-After` says. Once
  the token has expired, a call is refused saying when OpenBelt tries again.
- A tool call the server rate-limits says so, and when to try again; the sign-in is untouched.
- A server that turns down (401) the token a refresh just got for its 401 gets no refresh for its
  next 401 for a minute. The call is refused saying so, instead of a refresh on every call.
- A refresh the server refuses (the sign-in was revoked, or expired; Google's session control,
  `invalid_rapt`, asking you to sign in again) stops that sign-in, once: nothing tries it again.
  OpenBelt keeps why and when, which `connections` (`reconnect`) and Connections say.
- A server that says it doesn't know OpenBelt anymore (`invalid_client`: some drop idle
  registrations) stops the sign-in, and Connect registers OpenBelt there again. So does a server
  whose metadata names another authorization server than before, once an admin adds it again.
- A server that gives no expiry (or 0) is refreshed when it answers 401. One that says an expiry
  as a string (`"3600"`) is read as a number; one past a year counts as a year. A server that
  doesn't rotate refresh tokens (it gives none back) keeps the one it has.

Keeping it safe:

- A sign-in's access and refresh tokens are sealed like a pasted token, on the same credential
  row, with when to refresh it and the client it was given to. A refresh stores the new tokens in
  one write. One WorkspaceDO per workspace makes every call, so one refresh at a time per credential is
  enough: the calls that find it stale meanwhile wait on that one.
- A sign-in on its way keeps its PKCE verifier sealed until it comes back or 10 minutes pass. One
  that comes back to someone else connects nothing.
- One that comes back to another server's callback connects nothing, and its code is sent nowhere.
  So a connection's server can't send you on to another's sign-in and get that one's code (a
  mix-up). A server that names itself on the way back (RFC 9207 `iss`) must name the one you were
  sent to, and one that says it always does must.
- New tokens are saved before they're used. If what a refresh brought back can't be saved, the
  sign-in stops (connect again) rather than going on with a token that isn't saved. The spent
  refresh token is never sent again: a rotating server ends the whole grant on a replay.
- A refresh is marked on the sign-in before its refresh token is spent (a write that also proves
  the sign-in can be saved). One still marked after OpenBelt restarted was cut short, and its
  refresh token is sent once more. A server that doesn't rotate, or keeps the old one good a
  while, takes it. One that spent it refuses, and the sign-in stops once, saying the refresh was
  cut short. What nothing can save: the new tokens a server sent to an OpenBelt that stopped before
  reading them.
- A refresh stores what comes back only over the row it read, so one answered late never brings
  back a sign-in that ended meanwhile. A refresh the server answers after the sign-in ended (you
  disconnected, connected again, were removed, or an admin removed the connection or moved it to
  another server) is never kept: what it brought is revoked at the server, and that call has no
  token. OpenBelt reads at most 256 KB of an authorization server's answer.
- Disconnect tells the server the sign-in is done with (RFC 7009 revocation, when it takes that)
  and deletes it. Removing a person or a connection deletes their sign-ins and revokes them at the
  server once the removal is done (a job, tried again three times when the server doesn't
  answer).
- Several connections signed in with one OAuth app (Gmail, Calendar and Drive on one Google app):
  revoking any one token at Google ends all of them. So disconnecting or removing one only deletes
  it here while another still uses the app, whatever the server (OpenBelt can't know a revocation
  ends only that grant); the last one revokes.

Quirks: servers that need more than the standard are handled as data (`quirksFor`, from the
catalog's files). OpenBelt adds Google's `access_type=offline prompt=consent
include_granted_scopes=true` and leaves out the `resource` parameter there. A `.default` scope
(Entra) is asked for alone, with `offline_access`.
