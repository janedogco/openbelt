---
title: Architecture
description: How OpenBelt is built: the gateway, WorkspaceDO, AppDO, McpDO and ApexDO, each with a SQLite file of its own, what each owns, and why its runtime is its own and not workerd.
---

# Architecture

OpenBelt is one process, `packages/platform/src/server.ts`, written in Effect v4: a gateway that answers
HTTP, and four classes of Durable Object (WorkspaceDO, AppDO, McpDO, and the one ApexDO) that it runs itself
(`packages/platform/src/runtime/`: the object model, storage, jobs, sockets, sandboxes, the browser).
Each object keeps its data in a SQLite file of its own in the data directory (`OPENBELT_DATA`). For more
capacity the server runs as several processes on one port (`OPENBELT_PROCESSES`): each object lives in
the one its key hashes to, and any process serves any request, sending it to that one over loopback.

```
browser / agent
      │  <domain>,  <workspace>.<domain>  or  <app>--<workspace>.<domain>
      ▼
 Gateway (src/gateway.ts)              host → workspace (and app), a trace id per request
   base host (email sign-in; base.ts):
   ├─ /, /auth.md, /start.md, /llms.txt  the marketing pages (www/) and what agents read (welcome.ts)
   ├─ /_signin, /_oauth/*, /_start ─► ApexDO  its own sign-ins, OAuth clients, who is in which workspace
   ├─ /mcp, /_oauth/token ─► WorkspaceDO/McpDO  a token names its workspace (<workspace>~...): passed to that workspace's
   └─ /_trial, /claim/* ─► WorkspaceDO       trial workspaces (OPENBELT_TRIALS=on; trials.ts)
   workspace host:
   ├─ /mcp ──────► McpDO  (workspace/person) Effect McpServer; tools call WorkspaceDO and AppDO
   ├─ /.well-known/oauth-*, /_oauth/* ─► WorkspaceDO  OAuth for MCP clients (oauth.ts)
   ├─ /scim/v2/* ─► WorkspaceDO              directory sync: Okta, Entra provision people and groups (scim.ts, people.ts)
   └─ / , /_settings, /_workspace, /_me, /_admin ─► WorkspaceDO (workspace)  people, groups, tokens,
                                       │       connections, consents, app registry, previews
                                       └─► a connection's MCP server (DeepWiki, GitHub...)
   app host:
   ├─ /... ──────► AppDO (app id)      files, versions, data, sockets, log
   ├─ /_fn/<name> ───► AppDO           the app's function, in a sandbox (functions.ts)
   ├─ /a/<other>/_db, /_ws, /_fn ─► AppDO  another app's data and functions, as this app
   ├─ /_hook/<fn> ───► AppDO           a webhook from outside the workspace: no identity, signature checked
   ├─ /_tools, /_tools/call ─► WorkspaceDO   the workspace's connection tools, as this app, for the viewer
   └─ /sdk.js                          the SDK, served by the gateway
```

| Piece       | Keyed by                   | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway     | (stateless)                | Finding the workspace and app from the host, the trace id, routing, the SDK, who is viewing (the front door, or check_app's signed session cookie), letting them in (asks WorkspaceDO on every page and data request, on any host, in the call that finds the app), passed to AppDO                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| WorkspaceDO | workspace id               | People (permanent id, email, name, role, status), groups, who may join (open or invite), API token hashes by person ([People and groups](./people.md)), MCP clients' OAuth sign-ins (clients, codes, token hashes, each grant; [MCP](./mcp.md#signing-in-oauth)), connections (their servers' tool lists, sealed tokens, levels, which apps each person allowed, the last 500 calls) and the upstream MCP sessions, per credential ([Connections](./connections.md)), sign-ins to connections' servers (`signins/`: one registration per authorization server, a background refresh sweep and revocation jobs), the app registry (name, permanent id, owner, description) and its directory (each app's card and the words it's found by, sent by the app: the home page and search read it and wake no app; `directory.ts`), preview environments (apps, note, last use) and their expiry |
| AppDO       | the app's permanent id     | Files by content hash, manifests and the live pointer, its version and data in each preview environment, documents, the change log, WebSockets, the log, its usage (who opened it each day, its runs: `usage.ts`), and its functions' runs, each in a sandbox (QuickJS in WASM) with no network of its own: AppDO answers its `db` calls, fetches and connection calls and commits a run's writes together. Its sealed secrets, live queries, schedules, triggers, `ctx.later` runs and gallery picture (durable callbacks: jobs in the object's own SQLite, woken by one timer)                                                                                                                                                                                                                                                                                                           |
| ApexDO      | one, for the platform      | The base host's own email sign-ins, the OAuth clients registered there and the sign-ins waiting on its workspace picker, which workspaces each email is in (each WorkspaceDO sends its people as they're added, as a job), the workspaces made there (by whom, for which work domain), trial workspaces started per address ([MCP](./mcp.md#one-address-for-every-workspace)), and the workspace directory: every name a renamed workspace has had, and its current one                                                                                                                                                                                                                                                                                                                                                                                                                    |
| McpDO       | workspace id and person id | The MCP server for one person (the functions of their own newest apps as tools, and `execute`'s sandboxes, as that person); 2025-era sessions live here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Why one Durable Object per app

An app's files, data, realtime and log are always used together, so they live together: one hop
serves a page, one transaction makes a version live, and an app with no visitors costs only its
storage. Apps don't share a database, so one busy app can't slow another.

## The runtime

`src/runtime/` is what platform code is written against, so the classes read as they always did
(`Runtime.DurableObject`, `state.storage.sql.exec`, `Runtime.makeCallback`), on objects the
process hosts itself (`actor.ts`). The parts worth knowing:

- **One event at a time per object** (`events.ts`). A request, a call, a timer or a socket message to
  an object runs to its end before the next begins, except while it waits on something outside itself
  (another object, a sandbox, the network, `Runtime.idle`): there another event may run. That is the
  rule the code relies on (a read-modify-write in one event can't be torn by another). A call an object
  makes to itself runs inline.
- **Storage** (`storage.ts`, `localdb.ts`): `sql.exec` over the object's SQLite file (on worker
  threads, synced about once a second; [running.md](./running.md#the-data)), a synchronous `kv` that is a table in
  the same database, and `transaction`, which is a savepoint: it covers both, and a rollback undoes
  both.
- **Jobs** (`jobs.ts`): `makeCallback` books work for later as a row in the object's database, so
  booking one joins the transaction that decides to. The object's one timer is armed for the earliest;
  delivery is at least once (a job is leased when it starts and deleted only when its handler
  succeeds). The process keeps a timer for it and a row in its wake file, so a restart arms it again
  with nothing requesting the object.
- **Sockets** (`socket.ts`, `serve.ts`): a page's WebSocket is bridged by the gateway to the object that
  holds it, over loopback when another process holds it.
- **Sandboxes** (`sandbox.ts`, `sandbox-process.ts`, `sandbox-confine.ts`, `sandbox-globals.ts`): an app's functions and an
  agent's `execute` run in QuickJS compiled to WASM, in sandbox processes (a few per workspace, never shared
  with another). Each starts with a clean environment (as nobody in the image) and confines itself
  before it takes code (Landlock and a seccomp filter on Linux, `sandbox_init` on macOS): no files, no
  processes, no sockets, no signals to other processes. In it a function has the language and the web globals it uses. A box (a WASM instance of its own, its memory
  capped) takes one run at a time and keeps the code loaded; runs that overlap get boxes of their own.
- **Browser** (`browser.ts`): check_app drives a headless Chrome the process starts itself.
- **Objects** (`actor.ts`, `supervisor.ts`): an object starts on its first request and sleeps after
  10 minutes with nothing to do and no page open. Each platform instance is a namespace (a folder) of
  the data directory, which is what keeps instances' data apart and makes starting one cheap.

## Why not workerd

The runtime keeps the Durable Object model of workerd, Cloudflare's open-source Workers runtime, so the platform code still
runs there. In November 2026 a 619-line shim ran the real gateway and objects on workerd 1.20261115.1 (functions and
check_app stubbed): deploy, pages, documents and live updates all worked. On one Hetzner CCX33, 3 runs each, the Bun
runtime was ahead on every real path:

| Measured                             | Bun runtime | workerd  |
| ------------------------------------ | ----------- | -------- |
| App pages a second, 32 clients       | 1,748       | 704      |
| Their slowest 1% (p99)               | 29 ms       | 91 ms    |
| Document writes a second, 32 clients | 551         | 282      |
| p99 at a steady 1,000 pages a second | 2 ms        | 42 ms    |
| One broadcast to 10,000 sockets, p99 | 137 ms      | 1,264 ms |
| Restart with 2,000 objects on disk   | 409 ms      | 27 ms    |
| Memory while serving pages           | 638 MB      | 392 MB   |

workerd starts objects about twice as fast, restarts 15 times faster and uses about a third less memory. It syncs each
commit to disk, which `OPENBELT_LOCAL_DB_SYNC=FULL` does here. What it can't do is run what OpenBelt runs beside the
objects. Standalone workerd doesn't enforce a loaded Worker's CPU limit: a `while (true) {}` blocks the whole process. A
memory bomb aborts that process. So functions stay in QuickJS sandbox processes, and check_app's Chrome, backups and
upgrades stay in Bun: switching would mean two runtimes instead of one.

## Workspaces and hosts

The workspace is the first label of the host: `acme.localhost` locally, `acme.<OPENBELT_HOST>` deployed.
Each app has a host of its own under it, `<app>--<workspace>.<OPENBELT_HOST>` (`src/hosts.ts`), so the
browser's origin is the app: the gateway tells AppDO which app a request is from by the host it
came to (`x-openbelt-caller`), and answers an app's data routes only for its own origin. The workspace
host serves only OpenBelt's own pages; an old `/a/<app>/...` link there is a redirect to the app's
host. A host without a workspace label (a bare machine name, a tailnet name) is `OPENBELT_DEFAULT_WORKSPACE`'s
workspace host. A few labels are never workspaces
(`www`, `staging`, `api`, `admin`, `docs`, `status`, `mail`, `dev`, `pr`). Workspaces share nothing but the
code: separate WorkspaceDOs, AppDOs and tokens.

### Workspace names and ids

A workspace's id is the name it was made with, and never changes; its objects are keyed by it (WorkspaceDO,
McpDO's `<workspace>/<person>`, an app's workspace), and so are the codes and tokens the base host gives out
(`<workspace>~...`). Its name is what its hosts say, and an admin can change it
([Renaming the workspace](./people.md#renaming-the-workspace)). In code they are two branded types,
`WorkspaceId` and `WorkspaceName` (`src/model.ts`), and WorkspaceDO's stubs take only an `WorkspaceId`
(`Runtime.keyedBy`), so passing a name where an id is meant is a type error.

ApexDO keeps the directory: `workspace_names` (every name a renamed workspace has had: its id, its old names,
its current one, each pointing at the id, so nobody else takes them; at most 10 a workspace,
`MAX_WORKSPACE_NAMES`), `workspace_current` (each renamed workspace's current name) and `workspace_ids` (names a first
visit made a workspace under). A rename is one transaction there, and running it again changes nothing.
It refuses any name some workspace was made under: in the directory, made on the base host, the default
workspace's, a first visit's, or an object's file. A workspace never renamed has no rows: its id is its name, so workspaces made before ids existed
needed no migration.

Each process holds the whole directory (`src/workspace-names.ts`; it holds only renamed workspaces, so it
stays small) and the gateway finds a request's workspace in it once, with no call: the id for objects,
the current name for addresses. A host on an old name answers pages with a `308` to the current
one and everything else as the workspace. Every 2 s (`DIRECTORY_FRESH_MS`) the next request asks ApexDO
whether the directory changed (one call, answered "same" when it didn't), so a rename reaches the
other processes within 2 s; the process that renamed reads it at once. A name with no workspace (no
file, not in the directory) may be one another process just renamed a workspace to. Under tailscale
sign-in, where a first visit makes the workspace, ApexDO claims it first (`firstUse`, in the same event a
rename checks names in), so the two can't race. Under email sign-in, where a stranger's made-up hosts
are a 404, the directory is read again first, at most every 250 ms (`MISS_FRESH_MS`).

## Configuration

| Setting                                 | Default            | What                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENBELT_HOST`                         | `localhost`        | The domain whose subdomains are workspaces (`<workspace>.`) and their apps (`<app>--<workspace>.`)                                                                                                                                                                                                                                         |
| `OPENBELT_APP_PAGES`                    | `frame`            | Where a browser's page load of an app's own host goes: `frame`, the workspace's `/<app>/<path>` (people's one address), or `host`, it stays there                                                                                                                                                                                          |
| `OPENBELT_BASE_HOST`                    | `OPENBELT_HOST`    | The base host (marketing pages, sign-in, the one MCP address) under email sign-in, on a domain of its own beside the workspaces' (`openbelt.com` beside `openbelt.app`), so no app shares a registrable domain with the sign-in                                                                                                            |
| `OPENBELT_PUBLIC_HOST`                  | none               | Public apps' registrable domain (`openbelt.page`), under email sign-in only: an app whose live openbelt.json has `public` answers anyone, signed in or not, at `<app>--<workspace>.<public host>` ([apps.md](./apps.md#public-apps-anyone-opens-them-on-the-public-host)); refused at start beside `OPENBELT_HOST` or `OPENBELT_BASE_HOST` |
| `OPENBELT_PUBLIC_APP_WRITES_PER_MINUTE` | `120`              | Writes, function calls and live query runs done for anyone on the public host in one app a minute, from every address together; past it, 429. A request refused before any work and a watched query re-run by a write from outside the public host don't count                                                                             |
| `OPENBELT_PUBLIC_ADDRESS_SHARE`         | `25`               | The percent of `OPENBELT_PUBLIC_APP_WRITES_PER_MINUTE` one client address may use in one app (30 of 120), so one visitor can't use up an app's minute; past it, 429 for that address only                                                                                                                                                  |
| `OPENBELT_PUBLIC_DATA_SHARE`            | `50`               | The percent of an app's data cap (`OPENBELT_DATA_APP_MB`) past which the public host adds or changes no documents (507), so anyone can never fill an app for its members                                                                                                                                                                   |
| `OPENBELT_DEFAULT_WORKSPACE`            | `acme`             | The workspace for hosts without a workspace label                                                                                                                                                                                                                                                                                          |
| `OPENBELT_ADMIN_TOKEN`                  | none: required     | Mints API tokens (`/_admin/tokens`) and names workspace admins (`/_admin/workspace-admins`); every script that starts OpenBelt sets one                                                                                                                                                                                                    |
| `OPENBELT_PORT`                         | `1337`             | The port the server listens on                                                                                                                                                                                                                                                                                                             |
| `OPENBELT_DATA`                         | `~/.openbelt/data` | The data directory: a folder per namespace, a SQLite file per object ([running.md](./running.md#the-data))                                                                                                                                                                                                                                 |
| `OPENBELT_UPLOADS`                      | `off`              | Whether apps' pages may upload files (`on`/`off`): off, an upload is refused and agents' instructions and docs leave uploads out ([running.md](./running.md#files))                                                                                                                                                                        |
| `OPENBELT_WEB_ANALYTICS`                | none               | A Cloudflare Web Analytics token (32 hex digits): its cookieless beacon on the marketing pages (`www/*.html`), never on sign-in, a workspace's pages or an app's                                                                                                                                                                           |
| `OPENBELT_INTERNAL_EMAILS`              | nobody             | Our own addresses and `@domains` (commas or spaces between): their steps in the sign-up funnel are `kind=internal`, left out of its counts ([running.md](./running.md#the-sign-up-funnel))                                                                                                                                                 |
| `OPENBELT_FILES`                        | the disk           | Where apps' uploaded files go: unset, `<OPENBELT_DATA>/<namespace>/files`; `s3://<key>:<secret>@<host>/<bucket>` (`?region=`, `?tls=off`) for an S3-compatible bucket (R2, AWS, MinIO). Checked as OpenBelt starts ([running.md](./running.md#files))                                                                                      |
| `OPENBELT_FILES_MAX_MB`                 | `100`              | The largest file an app's page may upload                                                                                                                                                                                                                                                                                                  |
| `OPENBELT_FILES_WORKSPACE_MB`           | `10240`            | A workspace's files together (`0`: no limit)                                                                                                                                                                                                                                                                                               |
| `OPENBELT_FILES_DISK_FLOOR_MB`          | `2048`             | On the disk store, uploads stop while less than this is free, so a full disk never stops the objects' SQLite                                                                                                                                                                                                                               |
| `OPENBELT_FILES_IN_FLIGHT`              | `16`               | Uploads one process streams at once (each holds up to 32 MB to S3); past it, 503 `busy`                                                                                                                                                                                                                                                    |
| `OPENBELT_FILES_ORPHAN_HOURS`           | `24`               | How long after its upload a file no document of its app names is deleted                                                                                                                                                                                                                                                                   |
| `OPENBELT_FILES_SWEEP_SECONDS`          | `3600`             | How often each process clears what uploads left half done (a disk's temporary files, a bucket's unfinished multipart uploads)                                                                                                                                                                                                              |
| `OPENBELT_CLI_DIR`                      | `cli/dist`         | The openbelt CLI builds the workspace host hands out (`/install`, `/_cli/*`; [cli.md](./cli.md)): the image's own, or `bun run cli:dist`'s                                                                                                                                                                                                 |
| `OPENBELT_NAMESPACE`                    | `openbelt`         | The folder in it this instance's objects are in                                                                                                                                                                                                                                                                                            |
| `OPENBELT_PROCESSES`                    | `1`                | How many processes serve the port (`auto`: one per 2 CPUs, at most 4; compose sets `auto`)                                                                                                                                                                                                                                                 |
| `OPENBELT_CHROME_PATH`                  | found              | Chrome's executable, for check_app; otherwise the usual places for the OS                                                                                                                                                                                                                                                                  |
| `OPENBELT_DOOR_PORT`                    | none               | `bun run dev`'s owner door, where every request is the person running it: like `OPENBELT_PORT`, a connection or a function's `fetch` can't go there                                                                                                                                                                                        |
| `OPENBELT_HTTPS_PORT`                   | none               | `bun run dev`'s https port on the tailnet (`https://<workspace>.<OPENBELT_HOST>:<port>`): a page seen over http on this machine shows that address for agents to sign in at                                                                                                                                                                |
| `OPENBELT_SIGNIN`                       | `off`              | Who says who is viewing: `tailscale` (the headers a front door sets, as `tailscale serve` does: `bun run tailnet`, verify), `email` (a code sent to their email, and the front door: `bun run dev`) or `off` (nobody)                                                                                                                      |
| `OPENBELT_SESSION_SECRET`               | the admin token    | Signs session cookies                                                                                                                                                                                                                                                                                                                      |
| `OPENBELT_SIGNIN_ALLOW`                 | anyone             | Under email sign-in, the only addresses and `@domains` that get a code (commas or spaces between); anyone else is sent none ([viewers.md](./viewers.md#email-sign-in))                                                                                                                                                                     |
| `OPENBELT_MAIL_TOKEN`                   | none               | A Cloudflare API token with Email Sending: Edit: sign-in codes are emailed (from `OPENBELT_MAIL_FROM`, default `hello@` the base host; account `OPENBELT_MAIL_ACCOUNT`); without one they are only in the log                                                                                                                              |
| `OPENBELT_SECRETS_KEY`                  | none: required     | Seals connection tokens, apps' secrets and webhook secrets (AES-GCM); keep it, since what's sealed under one doesn't open under another. `bun run dev` keeps one in `.dev/`                                                                                                                                                                |
| `OPENBELT_ALLOW_LOCAL_CONNECTIONS`      | off                | `1` lets a connection use `http://localhost` (an MCP server on this machine): `bun run dev` and verify only                                                                                                                                                                                                                                |
| `OPENBELT_PREVIEW_TTL_SECONDS`          | 7 days             | A preview environment with no deploys or writes for this long is deleted                                                                                                                                                                                                                                                                   |
| `OPENBELT_HIDDEN_SOCKET_SECONDS`        | 5 minutes          | How long a page's tab may stay hidden before `/sdk.js` closes its socket, so the app it holds can sleep; shown again, it reconnects and replays what it missed                                                                                                                                                                             |
| `OPENBELT_CHECK_TIME_LIMIT_SECONDS`     | 30                 | How long one check_app may run before it stops and returns what it saw                                                                                                                                                                                                                                                                     |
| `OPENBELT_FUNCTION_SECONDS`             | 30                 | How long a function's run may take before OpenBelt stops waiting and refuses its db calls                                                                                                                                                                                                                                                  |
| `OPENBELT_SANDBOX_WARM_SECONDS`         | 30                 | How long idle sandboxes past the four kept warm per set of code stay before they're dropped                                                                                                                                                                                                                                                |
| `OPENBELT_LIVE_CLOCK_SECONDS`           | 60                 | How often a live query that reads the clock runs again                                                                                                                                                                                                                                                                                     |
| `OPENBELT_REFRESH_HOLD_SECONDS`         | 60                 | After a server turns down the token a refresh just got, how long OpenBelt holds off refreshing for a 401                                                                                                                                                                                                                                   |
| `OPENBELT_REFRESH_BACKOFF_SECONDS`      | 30                 | The first wait after a refresh that failed (doubling each time, at most 15 minutes)                                                                                                                                                                                                                                                        |
| `OPENBELT_OAUTH_ACCESS_TTL_SECONDS`     | 30 days            | How long an MCP client's OAuth access token lasts unused (it slides while used)                                                                                                                                                                                                                                                            |

## Not built yet

SSO sign-in (Okta), workspaces people make for themselves, private
apps (a sign-in gate on who can open an app), files and uploads, edge caching for app files, custom
domains, more than one machine per deployment (its data is on one machine's disk; more processes on
that machine work today). See VISION.md for the order.
