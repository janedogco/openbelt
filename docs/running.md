---
title: Running OpenBelt
description: The commands for working on OpenBelt: dev, try, verify, check, the data and its backups, and running it on a server.
---

# Running OpenBelt

| Command                                                            | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`                                                      | The platform from this checkout with live reload, at `http://acme.localhost:1337` signed in as you with no sign-in ([viewers.md](./viewers.md#who-says-so)), and on your tailnet at `https://acme.<domain>:8445` once a domain is set up ([tailnet.md](./tailnet.md#a-domain-for-the-tailnet)); a worktree: its own ports; prints a token. Data persists in this checkout's namespace of `~/.openbelt/data` ([The data](#the-data)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bun run data backup\|restore`                                     | A copy of a data directory taken while the platform runs (15 ms on a Mac), and one put back with it stopped. See [Backups](#backups).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bun run seed`, `bun run qa [<state>]`                             | Fill a running OpenBelt (`bun run dev` with no flags, or `--run <dir>`) with people, groups, connections, apps, tokens and activity; then put yourself in each state its pages have (fresh, needs-consent, connected, contractor, admin, ...). See [Trying OpenBelt by hand](./qa.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `bun run try:pi`                                                   | A fresh isolated platform plus pi connected to it, in an empty folder; stops when pi exits. Pass pi's own flags after `pi`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bun run tailnet up\|rollback\|status\|token\|logs\|down`          | OpenBelt on this Mac for your Tailscale tailnet: always on, everyone signed in as their Tailscale login; `up` upgrades it, tried on a copy of the data first. See [OpenBelt on your tailnet](./tailnet.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bun run deploy deploy\|rollback\|status\|smoke\|token\|logs prod` | Prod, on a server of your own, deployed over ssh with no client errors: main's newest commit checked, a canary on a copy of prod's data, then the platform restarted on the new image behind Caddy, which holds requests meanwhile (about a second), rolled back if its smoke test fails. See [Production](#production).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `bun run www`                                                      | The marketing site (`www/`) at `http://localhost:4321`. The platform serves it only on a domain, so `bun run dev` doesn't.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `bun run drive doctor\|tools\|call\|oauth\|scim\|as\|trace`        | One MCP call, a browserless OAuth sign-in (`oauth <email>`, 0.1 s), a directory's SCIM request (`scim <METHOD> <path>`), or a person's page request, against a running OpenBelt (`--run <dir>`, or `--mcp`/`--token`); `trace <id>` puts OpenBelt's side of one trace beside the test providers' (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `bun run world`                                                    | An isolated OpenBelt with test OAuth providers shaped like Linear, Notion, Google and GitHub, each connected and called once, in about 5 seconds. See [Iterating on connections](#iterating-on-connections).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `bun run providers list\|probe [id]`                               | OpenBelt's catalog of connections (`packages/platform/providers/`): `list` prints each provider's sign-in and defaults; `probe` asks each live server, without an account, how it signs in today and prints where its file no longer matches (exits 1 on drift).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun run verify [name...] [--all]`                                 | The checks this checkout's change needs: its commits since `--base` (default `origin/main`) and what's uncommitted, picked by `scripts/verify/select.ts` (a changed checks file; `docs/` → `doc-examples`; code → the checks that share its rare words; the harness, dependencies, or code no check matches → all; `www/`, `brand/`, skills → none). With names, the checks files whose name contains one; `--all`, every one. Each against its own fresh platform, in its own namespace of the verify data (`.verify/data`); evidence in `.verify/<run>/`. `--shard 2/4` runs the second of four shares, balanced by each file's time in `scripts/verify/durations.json` (CI's, as each share prints them in its log: refresh it from there when a share grows long). CI runs a PR's picks on as few machines as fit (`--plan`), and everything on every push to main, in four shares, one check at a time on each. |
| `bun run verify:list [words] [--changed]`                          | What each checks file proves (its `about` export and its behaviors), searched by words, best first; `--changed`: what `bun run verify` would pick for this change, why, and the closer calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `bun run check`                                                    | Format, lint, typecheck, guard, brand, dead code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bun run verify:upgrade [base]`                                    | The base commit (default: where this branch left `origin/main`) given an app and data, then this checkout started on the same namespace: fails when anything is lost that `packages/platform/storage.json` doesn't drop on purpose. CI runs it on every PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bun run verify:before-after <pr>`                                 | The PR's base and head, each launched by its own scripts, driven by one scenario; evidence published into the PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Iterating on connections

For work on how OpenBelt signs in to MCP servers (OAuth, refresh, revoke), `bun run world` gives you
a world of fake providers that behave like real ones, from cold:

```sh
bun run world --keep                       # OpenBelt + linear, notion, google, github; returns
bun run world --providers google,entra     # just those; stays up until Ctrl-C
bun run world --once                       # start, connect, call, print the timings, stop
bun run world stop --run .verify/world-…   # what --keep left running
```

It launches an isolated OpenBelt (as `bun run verify` does), starts a test provider per preset
(`scripts/verify/drive/dummy-mcp.ts --preset <name>`), adds a connection for each with
`bun run workspace`, signs `verify@acme.test` (the instance's token) in to each without a browser
(registering OpenBelt's app by hand at providers without dynamic registration, as an admin would),
and makes one call through each. It prints OpenBelt's URL and token, each provider's URL, ledger
and the call's trace, the commands to look closer, and how long each step took. Everything lives
in the run dir (`.verify/world-<time>/`, or `--run`): `instance.json`, `world.json`,
and `platform.log`. Stop a world
before `bun run verify`: verify's last check counts any running platform server as left behind.

**Presets** are real providers' behavior as settings, in `dummy-oauth.ts` `PRESETS`. Measured
against the real server: `linear`, `notion`, `google`. From the provider's docs: `github` (an
OAuth app), `github-app`, `entra`, `slack`, `slack-rotating`. A preset made from a catalog file
(`linear`, `notion`, `google` from `google-gmail.json`, `github`) takes its token lifetimes,
rotation, quirks and registration from that file (one place says each), and `bun run world` adds
it with `--provider <file>`, so the file's defaults and quirks are what's exercised.

| Preset   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linear` | DCR and CIMD advertised; tokens last as `linear/mcp.json` measured; refresh tokens rotate; a replayed one is `invalid_grant` and the grant lives on; RFC 7009 revoke.                                                                                                                                                                                                                                                              |
| `notion` | 8h tokens; rotation and replay as Linear; the token answer's scope is `default`; revocation at the token URL.                                                                                                                                                                                                                                                                                                                      |
| `google` | `initialize` and `tools/list` answer 200 without a token; `tools/call` 401s with an `isError` result and metadata per tool; URL `/mcp/v1`, resource `/mcp`; the metadata names the issuer with a slash; OIDC metadata only; no DCR or CIMD; refresh token only for `access_type=offline`, never rotated, lasting 604800s; granular consent; 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`; revoking one token ends every grant to the app. |
| `github` | No DCR or CIMD; metadata at `/login/oauth`; errors as HTTP 200; a client secret even with PKCE; tokens that never expire. `github-app`: 8h tokens and a rotating refresh token.                                                                                                                                                                                                                                                    |
| `entra`  | A tenant's issuer with OIDC metadata only; a `.default` scope; a refresh token only for `offline_access`, and the scope again on every refresh; `resource` refused beside `scope`; no revocation endpoint.                                                                                                                                                                                                                         |
| `slack`  | `client_secret_post` only; errors as 200 `{ok: false}`; tokens that never expire. `slack-rotating`: 12h tokens and a rotating refresh token.                                                                                                                                                                                                                                                                                       |

Change a provider while it runs: `curl '<provider>/control/oauth?preset=notion&expiry=60'` (every
setting's name is in `dummy-oauth.ts`; an unknown one is refused), `curl -X POST
<provider>/control/expire-now` (the next call refreshes first), `/control/stats`.

**Faults** are one-off failures, in [emulate](https://github.com/UsefulSoftwareCo/emulate)'s
shape: the next matching requests get your answer instead of the real one.

```sh
curl -X POST <provider>/control/faults -d '{"match": {"pathPattern": "/token", "grant": "refresh_token"},
  "response": {"status": 503, "body": {"error": "temporarily_unavailable"}}, "times": 1}'
curl <provider>/control/faults             # what's still armed
curl -X DELETE <provider>/control/faults   # disarm them all (?id=f1: one)
```

`match` takes `method`, `pathPattern` (`*` for any characters), `grant` (a token request's
`grant_type`), `rpc` (a JSON-RPC method) and `tool`; `delayMs` holds the answer (with no
`response`, the real one, late); `times` defaults to 1.

**The ledger**: every provider records each request it answers: method, path, status, a one-line
summary (never a token, code or secret), the `X-Correlation-Id` OpenBelt sent (its trace id), how
long it took and the fault that answered it. `curl '<provider>/control/ledger?trace=<id>&limit=50'`;
`curl -X DELETE <provider>/control/ledger` empties it.

**One trace, both sides**: every connection call's result ends with its trace
(`(openbelt: linear.whoami ok in 5ms as me, trace 8fe81a27436a)`), and

```sh
bun run drive trace 8fe81a27436a --run .verify/world-…
```

prints the trace's spans as a tree (each object, sandbox run and SQL call it went through, when it
started and how long it took), then OpenBelt's log lines and connection calls beside every
provider's ledger entries under the same id, in time order: "OpenBelt asked X, the provider answered
Y". `--provider <origin>` adds a provider that isn't in `world.json`. Without `--run`, it traces
this checkout's `bun run dev` (its `dev.json`): OpenBelt's side only, since real providers keep no
ledger. "Reading the logs" below has the rest.

## Upgrading to workspace terminology

This release uses workspace names throughout the browser, MCP, HTTP, CLI, configuration and code.
Workspace IDs, people, app hosts, API tokens and documents keep their identities.

Before upgrading, take a backup with `bun run data backup <dest>`. Stop the previous platform
before starting this release. At first start, the supervisor migrates the namespace before it
starts any platform processes. It moves workspace object files, directory tables, metadata and
shared connection credentials, including their encryption bindings. Keep the same
`OPENBELT_SECRETS_KEY`. A key that cannot decrypt a credential stops startup without discarding it.
Each database migration is transactional and retryable; the namespace gets a `.workspace-v1`
marker only after every database finishes. Original database snapshots are kept in the namespace's
`.before-workspace-v1` directory.

Update integrations to the new contracts together:

- Use `bun run workspace` and HTTP routes under `/_workspace`.
- Use `workspace` in `execute` code, such as `workspace.apps.notes.collection("posts").list()`.
- Use `"workspace"` for a shared connection credential, an explicit connection call's `as`,
  and an app's `openbelt.json` tool binding. Stored app manifests are migrated with new content
  hashes and version pointers; custom JavaScript that supplies an account type must use the new value.
- Use `OPENBELT_DEFAULT_WORKSPACE`, `OPENBELT_DATA_WORKSPACE_MB` and
  `OPENBELT_FILES_WORKSPACE_MB` in operator configuration.
- Reconnect agent clients so they load the current MCP schemas and instructions.

There are no aliases for the previous API or code names. Third-party scopes and service names
keep their provider's spelling. To return to a release from before this migration, stop the
platform and restore the pre-upgrade backup before starting that release. An old image cannot
read the migrated workspace files.

## The data

OpenBelt's objects (every workspace, app and MCP session) run in the platform's own processes, and each
keeps its data in a SQLite file of its own (`runtime/actor.ts`, `runtime/localdb.ts`): an app's
documents, versions, runs, logs, schedules and secrets in one file, a workspace's people, tokens,
connections and directory of apps in another. The files live in one directory, `OPENBELT_DATA`, one
folder per namespace: `<data>/<namespace>/<object>-<key hash>.sqlite`, each with its `-wal` beside
it. An object lives in the process its key hashes to (`OPENBELT_PROCESSES`, below): it starts on its
first request, opens its file, and is put to sleep after 10 minutes with nothing to do and no page
open (`OPENBELT_ACTOR_SLEEP_SECONDS`, 600), which closes it. A job it books (a schedule, a `later`,
a retry) is a timer in that process and a row in the process's wake file, so a restart arms it
again.

- **Durability.** A commit is written to the file's WAL but not synced to the disk by itself;
  each file written to is synced about once a second (`OPENBELT_LOCAL_DB_SYNC`, `SECOND` by default;
  `FULL` syncs each commit). A process that crashes loses nothing acknowledged (the `crash-recovery`
  check: kill -9 under 24,187 acknowledged writes lost none); a kernel panic or power cut loses
  at most about the last second. Measured: 3 hard resets of a Hetzner VM under 128 writers lost
  384 to 512 of about 6,400 acknowledged writes each, about half a second. Each object being its own file, a sync per commit was a disk
  sync per write: about 2,000 a second at 500 requests a second, and the disk was the limit.
- **Off the event loop.** The app files run on worker threads (`OPENBELT_DB_THREADS`, 4 per process), with one additional
  thread per process for ApexDO, WorkspaceDO and McpDO, so a commit's
  fsync never holds up a request.
- **One process per file.** A process holds a lock on each file it has open, so two never write
  one; a second waits for it (15 s, `OPENBELT_LOCAL_DB_WAIT_MS`) and then refuses.
- **Where.** `bun run dev`: `~/.openbelt/data`, a namespace per checkout (`dev-<slot>-<folder>`), so
  a worktree has its own apps and tokens; delete its folder to start over. Verify: `.verify/data`,
  a namespace per launch. Compose: a volume (`openbelt-data`, `OPENBELT_DATA=/data`). Back it up
  ([Backups](#backups)).
- **Disk.** The data is what the apps hold (their documents, versions, runs and logs), with each
  file's WAL on top until it is checkpointed (every 1,000 commits). Size the volume for that plus
  room to grow.

## Files

What people upload to apps (`files.put` in [the SDK](./sdk.md#files)) isn't in the objects' SQLite:
the gateway streams it to a file store, and an app's object keeps only each file's record (its
`files` table) and the workspace's object each app's bytes (`file_usage`). Downloads come from the store
alone and wake no object.

- **Off unless `OPENBELT_UPLOADS=on`.** Who may read a file's url, limits per workspace, taking a file
  down and backing files up aren't settled, so a server takes no uploads by default: a page's
  upload or delete is a 403 `uploads_off`, files already stored are still served, and nothing an
  agent reads mentions uploads (the MCP instructions, the docs tool's sdk page and its Errors, and
  `app_info`), so agents don't build apps around them. `bun run dev` turns them on; prod
  (`OPENBELT_PROD_UPLOADS`) leaves them off.

- **Where.** Unset, `OPENBELT_FILES` is the disk: `<data>/<namespace>/files/<workspace>/<app>/<id>`,
  inside the data directory, so [Backups](#backups) carry them. For a bucket, set
  `OPENBELT_FILES=s3://<key>:<secret>@<host>/<bucket>` (`?region=us-east-1`; `auto` by default, as
  R2 wants; `?tls=off` for plain HTTP, a local MinIO or RustFS). As it starts, each process writes,
  reads and deletes a file there; if it can't, it stops with a line saying which part is wrong
  (the key or secret, the bucket, the host), not each upload later.
- **Memory.** An upload streams through: on disk as it arrives, to S3 as 8 MB parts (3 in flight).
  A download reads 8 MB ranges, 4 ahead. One upload or download holds at most about 32 MB, so 16
  at once per process (`OPENBELT_FILES_IN_FLIGHT`) is about 512 MB.
- **Limits.** `OPENBELT_FILES_MAX_MB` (100) a file, `OPENBELT_FILES_WORKSPACE_MB` (10240) a workspace, and on
  the disk store `OPENBELT_FILES_DISK_FLOOR_MB` (2048): uploads stop before the disk fills, since a
  full disk stops every object's SQLite too. A workspace's room is taken before the bytes are read and
  given back if the upload doesn't finish, so uploads at once can't go past it.
- **Sweeps.** An app with files books a job (`files`, in its own SQLite, so it outlives a restart)
  that deletes the files no document of the app names `OPENBELT_FILES_ORPHAN_HOURS` (24) after
  their upload, bytes and record, and gives the workspace their room back; it reads each environment's
  documents once for the file ids in them, then books itself again while the app has files. Each
  process also clears what uploads left half done more than a day ago (a disk's `.partial`
  files, a bucket's unfinished multipart uploads) every `OPENBELT_FILES_SWEEP_SECONDS` (3600).
- **Watching it.** `openbelt_file_uploads_total{outcome}` (stored, too_large, workspace_full, disk_low,
  busy, cut_off, store_error), `openbelt_file_bytes_total{direction}`,
  `openbelt_file_upload_seconds`, `openbelt_file_uploads_in_flight` and
  `openbelt_file_store_errors_total{op}` and `openbelt_files_swept_total` at `/_admin/metrics`; an
  upload's trace has its `files.put` span; the app's log (`app_logs`) has a line for each upload,
  refusal and delete, the sweep's included.

## Running on a server

`compose.yaml` runs the platform from one image (`Dockerfile`: Bun, Playwright's pinned Chromium for check_app, the
code), its data on a volume:

```sh
OPENBELT_ADMIN_TOKEN=$(openssl rand -hex 24) \
OPENBELT_SECRETS_KEY=$(openssl rand -hex 32) \
OPENBELT_HOST=openbelt.example.com docker compose up -d
```

- **Access defaults.** Compose binds the platform port to `127.0.0.1` and uses
  `OPENBELT_SIGNIN=tailscale`, which requires a trusted identity proxy for people's pages.
  For an anonymous local sandbox, explicitly set `OPENBELT_SIGNIN=off`. To expose the port,
  explicitly set `OPENBELT_BIND`; keep authentication enabled on a shared network. An admin
  token protects administrative routes, not anonymous app reads and writes.
- **Keep the keys** (in a `.env` beside `compose.yaml`, which compose reads). `OPENBELT_SECRETS_KEY`
  seals connection tokens, apps' secrets and webhook secrets: what's sealed under one doesn't open
  under another. `OPENBELT_ADMIN_TOKEN` mints API tokens (`/_admin/tokens`).
- **Hosts.** Workspaces are `<workspace>.<OPENBELT_HOST>` and apps `<app>--<workspace>.<OPENBELT_HOST>`: point
  `OPENBELT_HOST` and a wildcard DNS record (`*.<OPENBELT_HOST>`) at the machine. Every workspace and
  app is one label under `OPENBELT_HOST` (neither name holds `--`, and the two together fit a DNS
  label's 63 characters: a deploy or rename that wouldn't is refused), so that one record, and one
  wildcard certificate, `*.<OPENBELT_HOST>`, covers them all.
  Under email sign-in the base host itself (`OPENBELT_HOST`, no workspace in it) is where someone without
  a workspace starts: the marketing pages (`www/`, in the image), `/auth.md` and `/llms.txt` for agents,
  one MCP address for every workspace, and Start building in the browser ([MCP](./mcp.md)); its
  `/_admin/*`, `/_health` and `/install` answer as before.
- **The base host on a domain of its own.** `OPENBELT_BASE_HOST` (under email sign-in) moves the
  base host off `OPENBELT_HOST`: `openbelt.com` for the marketing pages, sign-in and the one MCP
  address, beside workspaces and apps under `openbelt.app`. An app is HTML its workspace's agents wrote, and on
  the same registrable domain as the sign-in a browser would treat the two as one party (cookies
  it can set there, requests its SameSite rules let through); on a domain of its own it never is. Point
  `OPENBELT_BASE_HOST` at the machine too. Names under the base host's domain other than itself
  aren't OpenBelt's (421, no certificate), and one domain under the other is refused at start.
  Sessions are per host either way, and a sign-in on the base host is carried to a workspace's host by a
  one-time ticket, so nothing needs a cookie shared across the two domains (a sign-in at the front,
  `deploy/signin`, does: it keeps one domain).
- **Public apps on a domain of their own.** `OPENBELT_PUBLIC_HOST` (under email sign-in) serves an app
  whose live openbelt.json has `public` to anyone at `<app>--<workspace>.<public host>`
  ([Apps](./apps.md#public-apps-anyone-opens-them-on-the-public-host)): `openbelt.page` beside
  `openbelt.app`, so a public page's cookies and reputation never reach the workspaces or the sign-in.
  One label per app means one wildcard certificate, `*.<public host>`, covers them all; Let's Encrypt
  issues it only by DNS challenge, so the front's Caddy needs a DNS-challenge build and a token that can
  edit the public host's zone (`CLOUDFLARE_DNS_API_TOKEN`). Point a wildcard record, `*.<public host>`,
  A and AAAA, at the machine. `/_tls/ask` says no for every name there. Other names under it are a 404,
  and one domain under or over `OPENBELT_HOST` or `OPENBELT_BASE_HOST` is refused at start. On the
  public host nobody is ever signed in, whatever the request carries, and no cookie is set.
- **HTTPS.** `docker compose --profile tls up -d` with `OPENBELT_BIND=127.0.0.1` puts Caddy
  (`deploy/Caddyfile`) on ports 80 and 443 and keeps OpenBelt's own port off the network. Each name
  gets a Let's Encrypt certificate on its first visit, and only OpenBelt's names do: Caddy asks
  `/_tls/ask` first, which says yes for `OPENBELT_HOST`, `OPENBELT_BASE_HOST`, the default workspace, a workspace that is set up (it
  has people or apps), and an app that exists in one, so a stranger's handshakes for made-up names spend nothing. Let's Encrypt
  issues 50 new certificates a week per registered domain; past a few dozen apps, use the one wildcard
  certificate, `*.<OPENBELT_HOST>`, from a DNS-challenge build of Caddy, instead (as `bun run deploy`
  does). Behind Cloudflare's proxy its free certificate covers `*.<OPENBELT_HOST>`, so every
  workspace and app is covered. Tried on a fresh Ubuntu VM with
  `*.<ip>.sslip.io` as the domain and `OPENBELT_TLS=internal` (Caddy's own authority, which works
  without a public address): from `compose up` to serving took 98 s, and deploy, functions,
  realtime over `wss`, the `https://` links OpenBelt gives out, the refusals and the redirect from
  `http` all worked. check_app's browser trusts only public authorities, so under
  `OPENBELT_TLS=internal` it refuses the apps' certificates.
- **Another proxy.** Forward the `Host` header and set `X-Forwarded-Proto: https`; OpenBelt makes its
  links from both. The address apps are reached at has to work from inside the container too:
  check_app's browser opens them there.
- **Browser installation.** The image installs the full Chromium revision pinned by `playwright-core`.
  For local development, run `bun packages/platform/node_modules/playwright-core/cli.js install --no-shell chromium`.
  `OPENBELT_CHROME_PATH` overrides it; otherwise an installed system Chrome is the fallback.
  Each check uses a fresh browser, with a separate context per test person. Service workers are blocked.
  A watchdog terminates the browser process group if the platform dies.
- **check_app's browser** runs pages agents wrote, on this machine, so it reaches only OpenBelt's own
  names (on OpenBelt's port, or 80 and 443 under `OPENBELT_HOST`) and public addresses
  (`runtime/egress.ts`, the `check-egress` check): never the cloud's metadata service
  (169.254.169.254) or anything else on the machine or its private network, and the identity
  headers a front door sets are dropped from what it sends. A page that tries gets a refusal, and
  the platform logs `check_app's browser: ... refused`. In the image (as root) Chrome runs as a
  user of its own (uid 990), with none of the platform's environment, inside Chrome's own sandbox;
  the data directory is the platform's alone (0700). Chrome's sandbox needs user namespaces, which
  Docker's default seccomp profile refuses: both compose files run the container with
  `deploy/seccomp.json`, which is Docker's default profile (moby, Apache-2.0) with `clone`,
  `clone3`, `unshare` and `setns` allowed. On Ubuntu 24.04, which restricts user namespaces through
  AppArmor, this works under Docker's own AppArmor profile (the default); a container run with
  `apparmor=unconfined` falls under the restriction. Without either, Chrome runs without its own
  sandbox, still as its own user, and the platform logs `browser: Chrome's own sandbox can't start here`.
- **Memory.** compose caps the platform's container, with its sandboxes and check_app's browsers,
  at 4 GB (`OPENBELT_MEMORY_LIMIT`), so a runaway among them is stopped there instead of starving the
  machine. Raise it on a bigger machine. A server deploy (`compose.server.yaml`) defaults to 6 GB, for
  an 8 GB machine: its front and Docker use about 1 GB beside it.
- **Linux.** The function sandbox confines itself with Landlock (Linux 5.13 or later; TCP from 6.7,
  signals between processes from 6.12) and a seccomp filter on every kernel (no sockets at all,
  signals to itself only, no ptrace): the platform logs which it got, `sandbox: a process for <workspace>
is up (...)`.
- **Compression and caching.** OpenBelt gzips its text answers of 1 KB or more itself, to any method
  (pages, `/sdk.js`, JSON, MCP's answers; not event streams or a part of a file, a 206) for a client
  that accepts it, and answers `If-None-Match` with a 304 (`runtime/serve.ts`, the `transfer` check): a
  proxy in front needs no `encode` of its own. Caddy's `encode` would also compress a 206, whose
  `Content-Range` counts the plain bytes.
- **Trial workspaces** (`OPENBELT_TRIALS=on`, under email sign-in; off by default). An agent with no
  account starts one on the base host (`POST /_trial`; `/auth.md` then says how) and builds in it
  with the admin API token it gets; the person it works for opens the claim link it hands them,
  signs in on the base host, and claims it: they become that admin, and the agent's token goes on
  working, as them. Unclaimed, a trial lets nobody in: its token can't invite anyone or open
  joining, every page and data request (workspace host and app hosts) is a "trial until someone claims
  it" refusal, and its apps open only in `check_app`; it gets
  no TLS certificate (`/_tls/ask`), and its token stops after a day; one address may start 5 an
  hour (`429` with `Retry-After` after that). Don't turn it on for a public host yet: trials want
  a domain of their own (they're anyone's to start) and limits that hold across machines and
  proxies (the count trusts `X-Forwarded-For`).
- **Who is viewing.** `OPENBELT_SIGNIN=off` means nobody is signed in (everyone is anonymous, and app writes are anonymous too). To know
  who is viewing, run `OPENBELT_SIGNIN=email`, where people sign in with a code sent to their email
  ([viewers.md](./viewers.md#email-sign-in); it's emailed with `OPENBELT_MAIL_TOKEN` and
  `OPENBELT_MAIL_ACCOUNT` set, else it's in `docker compose logs openbelt`, and
  `bun run workspace signin-link <email>` makes a link instead; with `OPENBELT_GOOGLE_CLIENT_ID` and
  `OPENBELT_GOOGLE_CLIENT_SECRET` set, they can also continue with Google), or put
  OpenBelt behind something that sets Tailscale's identity headers (`tailscale serve` does, on a
  tailnet) and run `OPENBELT_SIGNIN=tailscale`, where OpenBelt must be reachable only through it;
  [viewers.md](./viewers.md#who-says-so) says what each mode trusts.
- **More capacity.** One process serves about 1,700 app page requests or 550 document writes a
  second (one app, 32 clients, a Hetzner CCX33 in November 2026). More processes help only when the
  load spans many objects: a request for an object another process owns crosses loopback, so one
  app's pages ran at 1,671, 1,783 and 1,377 a second on 1, 2 and 4 processes, and with one client at
  a time at 1,232, 730 and 612. The platform runs as several processes on one port
  (`OPENBELT_PROCESSES`; compose's `auto` is one per 2 CPUs, at most 4), under a supervisor
  (`runtime/supervisor.ts`) that:
  - lets them serve once all of them are ready; each object lives in the process its key hashes to,
    and a request that lands on another process goes to it over loopback;
  - starts one again that ends (back in 1.4 s), and exits after 5 in a minute so compose starts it
    all again;
  - holds the machine's one pool of sandboxes, which every process's runs go to (a pool per process
    started each workspace's sandboxes 4 times);
  - passes SIGTERM on and waits for each process's ordered stop.

  The kernel spreads connections over the processes (`SO_REUSEPORT`, Linux; a Mac sends them all to
  one). Past what a process can serve, it answers new requests 503 with `Retry-After` at once
  instead of queueing them (`runtime/admission.ts`; `/sdk.js` retries them). Measured on one 8-vCPU
  VM with 4 processes: 500 requests a second of a mix of 50 workspaces' pages, writes, functions, deploys
  and 1,000 live sockets, 0 errors from a cold start, p50 7 ms, at 40% of the machine. More than one
  machine means more than one deployment: the data is on the machine's disk, so workspaces are split
  between them.

- **Upgrading.** `docker compose pull && docker compose up -d` replaces the platform container; the
  data stays on its volume. `bun run verify:upgrade` proves a change keeps it.

`.github/workflows/ci.yml` builds the image on every push to main and publishes it to the
repository's container registry by commit, then as `:latest` once every check passed on that commit; a deployment
pulls the tag it wants.

## Production

There is one deployed stage, prod, and no staging: a change goes from main to prod, and the canary
runs it on a copy of prod's own data first. A stage is a platform on a server, on a data directory of
its own (`~/openbelt-<stage>/data`), from `deploy/compose.server.yaml`; its name picks its settings
(`~/.config/openbelt/<stage>.env`). In front of every stage on a server is
one front (`deploy/compose.front.yaml`, in `~/openbelt-front`): Caddy on ports 80 and 443, sending
each stage's names to its platform's port, and a helper (`scripts/deploy/front.ts`) that answers
Caddy's questions. `bun run deploy` drives it over ssh (`scripts/deploy.ts`):

| Command                                          | What                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run deploy deploy prod [commit] [--fast]`   | From a terminal: main's newest commit (or one on main), checked, built on the server, made live ([Deploying from a terminal](#deploying-from-a-terminal)). CI runs the deploy itself once its checks passed. |
| `bun run deploy recheck prod`                    | The full checks on the commit prod runs, in a worktree of their own; nothing deployed.                                                                                                                       |
| `bun run deploy rollback prod`                   | Back to the image that ran before the last deploy. Shipping an older commit on main is the other way back.                                                                                                   |
| `bun run deploy status\|smoke\|token\|logs prod` | The commit its front door serves; the smoke test against it; an API token and the commands that add it to an agent; the platform's last 50 lines (`--follow` streams).                                       |

A deploy:

1. Builds the image on the server from the commit's files (or pulls CI's, with a registry token).
2. Puts the front as it should be: Caddy (built once on the server with the Cloudflare DNS module,
   `deploy/caddy.Dockerfile`) and the helper started if they aren't, this stage's names in
   `caddy/stages/<stage>.caddy`, and Caddy reloaded only if they changed.
3. Runs a canary: the image in a container of its own, on a copy of the stage's data taken as it
   runs (`bun run data backup`, consistent while the platform writes; milliseconds for prod's few
   megabytes). It is smoke-tested from inside (`scripts/deploy/smoke.ts`: health with the commit, a
   token, `deploy_app` with a function, its page, `call_function`, `check_app` writing through the
   SDK and seeing it live, `search` finding it), then checked to hold every workspace's apps, live
   versions, live files, documents, environments and tokens as the stage held them just before the
   copy (`scripts/deploy/carried.ts`, reading `/_admin/inventory`). A change that breaks on data an
   older version wrote stops here; an empty data directory would have let it through. The copy is
   real data, so the canary does nothing outside: an internal Docker network (its schedules, OAuth
   refreshes, webhooks and fetches reach nobody), no backups (its writes never mix into the stage's
   backup) and no mail. The copy is deleted after. A failure stops here with nothing changed.
4. Stops the platform and starts the new image on the same data. Caddy holds each request meanwhile
   (`scripts/deploy/proxy.ts`: it checks `/_health` every 250 ms and holds a request up to 30 s)
   and sends it once the new one answers; the old one answers `/_health` 503 first, so Caddy stops
   sending to it before it stops taking connections, and its requests under way finish. Then a
   quick smoke test through its own port.
5. Smoke-tests through the front door from where it runs. A failure goes back to the image before.
   `--drill-rollback` does the same after a passing deploy, to practice one.

Every step can run again. The stage's `state.json` says what runs and what ran before; a deploy
first puts the front and the platform back to what it says, and holds a lease so two deploys of one
stage don't overlap. The lease names one run (its user, host and process), so two agents on one
machine are two holders. A deploy from a terminal waits for another one's lease (up to 45 minutes),
then starts again from main as it is then; when the stage already runs a commit that holds the
main it started with, it stops there with nothing to do. A dead run's lease lapses at once on the
machine that ran it, and after an hour elsewhere; `--force` takes one over.

The `deploy-swap` check runs the same Caddy block in front of a platform restarted twice under an
agent's calls and a page's writes: 231 calls and 2,460 writes, none failed, the longest held for
2.5 s, and the agent's MCP session carried on through both restarts. `deploy-burst` holds 192
deploys at once, 8 at a time over one session, answering in 4.4 s.

**Names and certificates** (`OPENBELT_TLS`). `OPENBELT_HOST` and `*.OPENBELT_HOST` point at the server.
The bare host serves the marketing site (`www/`); every name under it is OpenBelt's. With
`OPENBELT_BASE_HOST` (a base host on a domain of its own), that one name serves the marketing site
instead, and `OPENBELT_HOST`'s bare name sends there (308); the deploy smoke-tests it too.

- Unset or `dns`: every workspace and app (`<workspace>.<host>`, `<app>--<workspace>.<host>`, one label
  each) shares one wildcard certificate, `*.<host>`, by DNS challenge, so a new app never waits for a
  certificate and none counts against Let's Encrypt's 50 a week. The bare host (and the base host) get
  their own from Let's Encrypt, by DNS challenge under `dns` (a server nothing public can reach, a
  tailnet). It needs `CLOUDFLARE_DNS_API_TOKEN` (a token that can edit the zone's DNS) once; the deploy
  that has it keeps it in the front's `caddy.env`.
- `internal` (Caddy's own authority) and `off` (plain http behind something else).

**Who is viewing.** `OPENBELT_SIGNIN=tailscale` with `OPENBELT_FRONT_CADDY=tailscale`: the helper asks
the server's tailscaled who each request's address is, and Caddy adds the `Tailscale-User-*` headers
it answers, as `tailscale serve` would; a tagged device (CI) is nobody. Or `OPENBELT_FRONT_CADDY` is
a file with a Caddy snippet that signs people in (`deploy/signin`; [viewers.md](./viewers.md#who-says-so)).
Either way Caddy drops any `Tailscale-User-*` header a client sends first, and adds the front door's
secret (`OPENBELT_FRONT_DOOR_SECRET`, made on the stage's first deploy) to every request it forwards.
With a secret set, the platform believes only requests that carry it, loopback ones included:
whatever else runs on the machine reaches loopback too.
A stage with no sign-in is refused, prod too (`OPENBELT_PUBLIC=yes` if it's meant to be public).

**The operator's routes** (`/_admin/*`: tokens, sign-in links, logs, the inventory) answer through
the front only from the server itself and the tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`,
which CI joins to deploy): anyone else gets a 403 from Caddy before the platform sees the request,
the admin token or not. The token itself is compared in constant time. Sessions are signed with
`OPENBELT_SESSION_SECRET`, which a stage's first deploy makes and keeps in its `state.json`, not
with the admin token, so a leaked token can't forge sessions (a stage deployed before it gets one
on its next deploy, and everyone signs in again once).

**Settings** come from the environment, or from `~/.config/openbelt/<stage>.env` when you deploy from
your own machine: `OPENBELT_DEPLOY_SSH` (`user@host`), `OPENBELT_HOST`, `OPENBELT_ADMIN_TOKEN`,
`OPENBELT_SECRETS_KEY`; and optionally `OPENBELT_SIGNIN`, `OPENBELT_FRONT_CADDY`, `OPENBELT_TLS`,
`OPENBELT_DEFAULT_WORKSPACE`, `OPENBELT_TELEMETRY` (below), `OPENBELT_IMAGE`, `OPENBELT_DEPLOY_DIR` (default `openbelt-<stage>` in the ssh
user's home), `OPENBELT_HOST_PORT` (the platform's port on the server, default 1401), `OPENBELT_PROCESSES` and `OPENBELT_MEMORY_LIMIT`. Keep `OPENBELT_SECRETS_KEY`:
what's sealed under one key doesn't open under another.

### Grafana on the server

`OPENBELT_TELEMETRY=grafana` runs Grafana beside the front (Tempo for traces, Loki for logs,
Prometheus for metrics: `grafana/otel-lgtm`, the image compose's telemetry profile runs) and sends
the stage's spans, log lines and metrics to it, served at `https://grafana.<host>`. The stage is
named by `deployment.environment.name` (`prod`), which Tempo, Loki and Prometheus all filter by.
Prod itself has no sign-in at the front, so it sends to a Grafana on another machine instead
([Prod](#prod-a-server-with-a-public-address), 6).

- **Who gets in.** Grafana is behind the stage's sign-in (`OPENBELT_FRONT_CADDY`), and Caddy refuses
  anyone it doesn't name (403). Grafana believes the `Tailscale-User-Login` header the sign-in sets
  (its auth proxy) and makes everyone it names an admin; it has no login form, basic auth or anonymous access,
  and only Caddy reaches its port. Without a sign-in the deploy refuses.
- **What it keeps.** Traces and log lines 7 days, metrics 15, in the front's `telemetry-data`
  volume; Grafana's container has at most 2 GB. In a lab it used about 200 MB idle and 1.2 GB under
  500 requests a second; a request is about 2 KB of traces.
- **Dashboards.** Dashboards > OpenBelt > OpenBelt: one stage (pick it at the top) at a glance, then its
  requests (and those still open, sockets too), agents' tool calls (by tool, the ones that weren't ok, time, each tool's error share,
  and traces of defects), function runs, calls outside, sandboxes (their CPU and memory, and CPU by
  workspace) and storage, warn and error lines, and failed and slow traces. They're code: `scripts/grafana/dashboards.ts` (the Grafana Foundation SDK),
  written to `deploy/grafana/dashboards/` by `bun run grafana build` (`bun run check` fails while
  they differ), and copied to the server by each deploy; Grafana reads them every 30 s. A change
  made in Grafana's UI can't be saved: export its JSON, and make the change in code.
- **Finding a request.** Explore, Tempo, TraceQL:
  `{resource.deployment.environment.name="prod" && duration > 500ms}`; a trace's "Related
  logs" shows its lines. Loki: `{deployment_environment_name="prod"}`. Prometheus:
  `sum by (deployment_environment_name) (rate(openbelt_http_requests_total[5m]))`. A gauge's name ends in
  `_ratio` there (`openbelt_sandbox_wasm_bytes_ratio`), and the `openbelt_sandbox_` ones come once from each
  platform process and the supervisor, the same numbers: take `max`, not `sum`.
- **How it reaches it.** Each stage's platform is on the `openbelt-telemetry` Docker network with
  the front's OTLP proxy, `http://otlp:4318`, which passes OTLP on to Grafana's container; a deploy
  creates the network. Grafana, Tempo, Loki and Prometheus are on a network of their own, so another
  stage's platform can't query them or pose as a signed-in person. The canary checks its export
  settings but sends nowhere.

To send elsewhere instead (Grafana Cloud, Honeycomb), leave `OPENBELT_TELEMETRY` empty and set
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` for the stage
([Keeping traces and logs](#keeping-traces-and-logs)). Both at once is refused.

### The tailnet

Prod has a public address for its names, and is on the tailnet for SSH, deploys and `/_admin` only:

- **The tailnet policy** lets CI reach only the prod machine, and only to deploy:

  ```jsonc
  "tagOwners": { "tag:ci": ["autogroup:admin"], "tag:openbelt-prod": ["autogroup:admin"] },
  "grants": [
    { "src": ["tag:ci"], "dst": ["tag:openbelt-prod"], "ip": ["tcp:22", "tcp:443"] },
    { "src": ["autogroup:member"], "dst": ["tag:openbelt-prod"], "ip": ["tcp:443"] },
  ],
  "ssh": [
    { "action": "accept", "src": ["tag:ci"], "dst": ["tag:openbelt-prod"], "users": ["deploy"] },
  ],
  ```

  A rule with `"src": ["*"]` would let CI reach everything: tagged devices match `*`.

- **CI** joins the tailnet for each job as a short-lived `tag:ci` device
  (`.github/actions/server-access`), signed in by workload identity federation: a Tailscale trust
  credential for GitHub's OIDC issuer, this repository only, scope `auth_keys`, tag `tag:ci`, so
  there is no secret to leak (the secrets `TS_CLIENT_ID` and `TS_AUDIENCE`; an OAuth client's
  `TS_CLIENT_ID` and `TS_OAUTH_SECRET` work too).

### Deploying from a terminal

Prod runs main. `bun run deploy deploy prod` does what CI's push to main does, from a machine on the
tailnet with `~/.config/openbelt/prod.env`, with nothing to confirm:

1. Fetches `origin/main` and checks its newest commit out in a worktree of its own (a commit given
   instead must be on main; anything else is refused). If prod already runs it, it stops there.
2. In that worktree: `bun run check`, `bun run verify --all`, the checks on several processes
   (`OPENBELT_PROCESSES=4`, as ci.yml's `processes` job), and `bun run verify:upgrade` from the
   commit prod runs. A failure deploys nothing and leaves the worktree, with its evidence. About
   7 minutes. `--fast` runs `check` and the upgrade only (about 20 seconds), for a change you're sure of;
   `bun run deploy recheck prod` later runs the full checks on what prod runs, deploying nothing.
3. Deploys with that commit's own `scripts/deploy.ts`. With no registry token, the deploy builds the
   image on the server from the commit's files instead of pulling it: about 2 minutes, 15 when `cli/`
   or the `Dockerfile` changed (the CLI's stage is kept as `openbelt-build-cache:cli`).

The deploy itself is the one above: the canary on a copy of prod's data, swap, smoke test, back to
the image before on failure.

### Prod: a server with a public address

Prod is one VM of its own with a public address (4 vCPUs and 8 GB, with the provider's daily backups on). It is on the tailnet for SSH and deploys only ([The tailnet](#the-tailnet)):

1. **The machine.** Ubuntu 24.04 from `deploy/cloud-config.yml` (its header has the commands), behind
   the provider's firewall: 80/tcp, 443/tcp and udp, ICMP and Tailscale's 41641/udp, and 2222/tcp from
   your address alone until the machine is on the tailnet.
2. **The tailnet.** `tag:openbelt-prod`, in the policy (above): CI's ssh
   as `deploy` and https, members' https, and your own ssh as `deploy`. Then SSH is the tailnet's alone
   (the header's last commands).
3. **DNS** (Cloudflare, DNS only): `OPENBELT_HOST`, `*.<OPENBELT_HOST>`, `OPENBELT_BASE_HOST` and
   `*.<OPENBELT_PUBLIC_HOST>` (`*.openbelt.page`), A and AAAA, the machine's public addresses.
   `OPENBELT_TLS` unset: Caddy gets each name's certificate from Let's Encrypt on its first visit, so
   the zones' CAA records must allow Let's Encrypt. Public apps' names are the exception: one wildcard,
   `*.<OPENBELT_PUBLIC_HOST>`, by DNS challenge, with `CLOUDFLARE_DNS_API_TOKEN` (a token that can edit
   that zone) in `prod.env` once (the deploy keeps it in the front's `caddy.env`); it refuses without it.
   `*.openbelt.page` is proxied through Cloudflare (orange cloud, SSL "Full (strict)", the free
   certificate covers one label). The front believes the visitor's address in `CF-Connecting-IP` only from
   Cloudflare's ranges (`scripts/deploy/proxy.ts`, `CLOUDFLARE`) and passes on that one address as
   `X-Forwarded-For`, so the per-address limits count each visitor, not each Cloudflare server.
   Update `CLOUDFLARE` when https://www.cloudflare.com/ips/ changes.
   **Public apps behind a CDN:** a public app's files other than its pages (not `text/html`, not `/_...`)
   answer with `CDN-Cache-Control: public, max-age=60`, so the edge keeps them a minute while browsers
   still ask each time (`Cache-Control: no-cache`); pages, `/sdk.js` and data always reach the platform.
   Cloudflare keeps only the file types it caches by default (scripts, styles, images, fonts), and the
   zone's Browser Cache TTL is "Respect Existing Headers". Each time a public app goes live (or stops
   being public) the platform purges its name there, with `OPENBELT_CDN_TOKEN` (a token with Cache
   Purge on the public host's zone) and `OPENBELT_CDN_ZONE` (that zone's id) in `prod.env`; without
   them a file at the edge is at most a minute old. A purge that fails is a warning in the log.
4. **`~/.config/openbelt/prod.env`**: `OPENBELT_DEPLOY_SSH` (`deploy@<tailnet address>`),
   `OPENBELT_FRONT_ADDRESS` (the tailnet address: `/_admin` answers only from the tailnet),
   `OPENBELT_HOST`, `OPENBELT_BASE_HOST`, `OPENBELT_PUBLIC_HOST=openbelt.page`, `OPENBELT_SIGNIN=email`, `OPENBELT_SIGNIN_ALLOW`,
   `OPENBELT_MAIL_TOKEN` and `OPENBELT_MAIL_ACCOUNT`, optionally `OPENBELT_GOOGLE_CLIENT_ID` and
   `OPENBELT_GOOGLE_CLIENT_SECRET` ([viewers.md](./viewers.md#email-sign-in)), `OPENBELT_ADMIN_TOKEN` and
   `OPENBELT_SECRETS_KEY`, the backup's three ([Backups](#backups)), the telemetry's endpoint
   (6) and `OPENBELT_INTERNAL_EMAILS` ([The sign-up funnel](#the-sign-up-funnel)). Keep a copy somewhere other than the laptop: a backup restored without its
   `OPENBELT_SECRETS_KEY` comes back with every secret sealed for good.
5. **Deploy.** `bun run deploy deploy prod` from a terminal ([Deploying from a terminal](#deploying-from-a-terminal)).
   The first build on a new machine takes about 10 minutes (the CLI's stage), later ones about 2.
6. **Telemetry on another machine.** `OPENBELT_TELEMETRY=grafana` needs a sign-in at the front, which
   a public prod doesn't have, so Grafana (`grafana/otel-lgtm`) runs on a tailnet-only VM of its own:
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://<its tailnet address>:4318` in `prod.env`, and the tailnet
   policy lets `tag:openbelt-prod` reach that port and nothing else there.
7. **Backups.** Continuous (`OPENBELT_BACKUP_URL`, to a bucket of its own), nightly
   (`deploy/nightly.sh`, to another bucket, kept by its lifecycle rule) and the provider's snapshots
   of the whole disk ([Backups](#backups)).

**Rebuilding it on a new machine** from the continuous copy (not yet drilled end to end; the restore
itself is, `bun run data restore-backup` from the bucket alone):

1. Steps 1 and 2, then 4 with the new tailnet address, and 5: prod starts on an empty data directory.
2. On the server, as `deploy`, put the bucket's copy in place of it:

   ```sh
   cd ~/openbelt-prod && docker compose -p openbelt-prod stop openbelt
   docker run --rm -e OPENBELT_BACKUP_KEY_ID=... -e OPENBELT_BACKUP_SECRET=... -v "$PWD:/stage" \
     "$(sed -n 's/^OPENBELT_IMAGE=//p' .env)" bun run data restore-backup '<OPENBELT_BACKUP_URL>' /stage/restored
   mv data data.empty && mv restored data && docker compose -p openbelt-prod start openbelt
   ```

3. Point DNS (3) at the new addresses. Install `deploy/nightly.sh` again.

### CI

`ci.yml` builds and publishes the image on every push to main and every PR from this repository
(layers cached, so a change to code alone rebuilds in seconds). On main, the `prod` job deploys it
once every check passed, with the same canary on a copy of prod's data. Prod's uptime is checked off
GitHub ("Uptime", below). Until prod has a server, the job is skipped (`prod-off` says so). What the
repository needs:

- prod: variables `OPENBELT_PROD_SSH` (`deploy@<tailnet name>`), `OPENBELT_PROD_HOST`,
  `OPENBELT_PROD_BASE_HOST`, `OPENBELT_PROD_SIGNIN`, `OPENBELT_PROD_SIGNIN_ALLOW` (unset, anyone),
  `OPENBELT_PROD_TLS`, `OPENBELT_PROD_FRONT_CADDY`, `OPENBELT_PROD_TELEMETRY`,
  `OPENBELT_PROD_UPLOADS`, `OPENBELT_PROD_TAILNET_NAME` (the machine's tailnet name, waited for
  before deploying); secrets `OPENBELT_PROD_ADMIN_TOKEN`, `OPENBELT_PROD_SECRETS_KEY`, and the
  tailnet's (above); for a server off a tailnet the secret `OPENBELT_PROD_SSH_KEY` (an ed25519 key it
  accepts) and the variable `OPENBELT_PROD_KNOWN_HOSTS`;
- sign-in email: the secret `OPENBELT_MAIL_TOKEN` (a Cloudflare token with Email Sending: Edit) and
  the variable `OPENBELT_MAIL_ACCOUNT` (its account id);
- continuous backups (optional): the variable `OPENBELT_PROD_BACKUP_URL` and the secrets
  `OPENBELT_PROD_BACKUP_KEY_ID` and `OPENBELT_PROD_BACKUP_SECRET` (below, "Backups").

The server pulls the image with the job's own token, which lasts only for that run.

### Uptime

A Cloudflare Worker, `openbelt-uptime` (`scripts/uptime/`), checks prod every 5 minutes from outside the server and
outside GitHub. It loads three pages: a workspace's `/_health` (`acme.openbelt.app`), the marketing page
(`openbelt.com`), and a public app (`uptime--acme.openbelt.page`, a static page in `acme` with `"public": {}`). It
checks paperbot too (`app.paperbot.ca/v1/ping`), which connects its owners to OpenBelt, as a service of its own.
A page that fails is loaded again 20 seconds later. A page that fails twice makes its service "down".
When a service goes down, the Worker emails `hello@openbelt.com` (Email Sending, from `uptime@openbelt.com`;
Email Routing forwards it). When it is back, it emails again. It keeps each service's last state in the KV
namespace `openbelt-uptime`. Change the pages in `worker.ts`, then deploy:

```sh
bunx wrangler@4 deploy -c scripts/uptime/wrangler.jsonc
```

Its runs and errors are in the Cloudflare dashboard (Workers > `openbelt-uptime` > Logs).

### Alerts

The ops machine's Grafana watches prod's logs and metrics, and mails what it finds through the same Worker: `POST
/alert` on `openbelt-uptime.<account>.workers.dev`, with the Worker's secret `ALERT_TOKEN` as a Bearer token, takes
Grafana's webhook (`{title, message}`) or `{subject, text, html?}` (HTML with its plain copy) and emails it to `hello@openbelt.com`. The rules are files
in the ops repo (`grafana/alerting.yaml`), each a Loki query over `{service_name="openbelt"}`:

| Alert                               | When                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OpenBelt is answering errors        | over 10 requests answered 5xx in 10 minutes, not counting prod's own `127.0.0.1` health checks while it starts                        |
| OpenBelt refused writes for storage | any `507` in 15 minutes: an app's or workspace's cap, or the disk floor                                                               |
| OpenBelt sign-ups spiked            | over 20 new workspaces in an hour (`made the workspace`), test people (`*.test`) left out                                             |
| A public app went live              | every `public app: <host> is live at version <v>` line: a version with `"public"` went live, so a page anyone can open is up. Open it |
| OpenBelt is rate-limiting a lot     | over 50 `rate limit:` refusals in 15 minutes                                                                                          |

Each mails once, then again every 6 hours while it lasts; "resolved" isn't mailed. The ops machine also mails a
digest every morning (15:00 UTC): new workspaces, public apps that went live, sign-ins, deploys, errors and limits hit.
Whether prod is up at all is the Worker's own check: when the ops machine is down, these alerts and the digest stop
with it, and the uptime mails don't.

### The sign-up funnel

Each step towards using OpenBelt logs one `funnel: <step>` line (`funnel.ts`), for the ops machine's Glance page and digest:

| Step              | When                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `landing`         | the marketing home page (`/` as HTML)                                                   |
| `start`           | `/_start` (Start building)                                                              |
| `signin`          | the base host's sign-in page                                                            |
| `code`, `google`  | a code mailed, or Continue with Google                                                  |
| `signed_in`       | a person signed in on the base host, by code or Google                                  |
| `workspace`       | a person made a workspace on the base host (the picker, or an agent's sign-in)          |
| `mcp`             | an agent reached the base host's `/mcp` with no token (the 401 that starts its sign-in) |
| `authorize`       | the page that asks a person to let an agent in                                          |
| `agent_signed_in` | a person let an agent in                                                                |

After that, an agent's `tool call:` lines (with `agent`) are its steps. Each line carries:

- `visitor`: an HMAC, under the session secret, of the day, the address and the User-Agent. It counts a visitor once a day,
  and changes every day; the address is never logged.
- `kind`: `person`, `agent` (`mcp`), `bot` (no User-Agent, a headless browser, a crawler, a link
  preview, an HTTP library: `check_app`'s browser too), `internal` (an email on `OPENBELT_INTERNAL_EMAILS`, given or remembered by the
  browser) or `test` (`*.test`). Count `person` alone for people.
- `source`: `?utm_source=` or `?ref=` on the link, else the linking page's host, else `direct`. The cookie
  `__Host-openbelt_from` keeps it (the name alone) for 7 days, so the later steps carry it.
- `browser`, and `agent` on an agent's steps: the OAuth client's name, else what its `initialize` named, else its
  User-Agent's product.

People per step in the last day, in Loki: `count(sum by (visitor) (count_over_time({service_name="openbelt"} |= "funnel: start" | kind="person" [1d])))`.
Tag every link we share: `https://openbelt.com/?ref=<where>`.

### Closing sign-ups

To stop new people at once (a flood of sign-ups, abuse): list who may still sign in in `OPENBELT_SIGNIN_ALLOW`
(addresses and `@domains`, separated by commas) in `~/.config/openbelt/prod.env`, then deploy (`bun run deploy deploy
prod --fast`, about 30 s). It applies to email codes and Google alike; people already signed in stay signed in.
Empty or unset, anyone may sign in.

## Reading the logs

Every line the platform prints (on stderr) is one JSON object: `at`, `level`, `msg`, the `trace` and `span` it
happened in, `in` (the span's name, like `AppDO.execute`), its context (`workspace`, `app`, `actor`,
`ms`, ...) and, for a failure, `cause` (the full Effect cause, with the spans it passed through).
That covers OpenBelt's own lines and what libraries print (`from: "console"`). `bun run dev`
prints them readably and keeps the JSON in `.dev/logs/dev.log`; a verify or world run keeps them
in its `platform.log`; compose keeps each container's in rotated files (`docker compose logs`).

A running instance also keeps its newest lines and every finished span in memory, and answers for
them with the admin token (`Authorization: Bearer $OPENBELT_ADMIN_TOKEN`, on the workspace host):

| Ask                               | What                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run drive logs`              | `GET /_admin/logs`: the newest lines, filtered by `--trace`, `--workspace`, `--app`, `--level warn` (that and worse), `--since 5m` (or an ISO time), `--text`, `--limit`                   |
| `bun run drive trace <id>`        | `GET /_admin/trace?id=`: one trace's spans as a tree (a span still running says so: what a stuck request waits in), with its log lines (and connection calls, and test providers' ledgers) |
| `bun run drive actors`            | `GET /_admin/actors`: every object with data, `awake` (held by one of this machine's processes) or `asleep`, with its id; `--state`, `--object`                                            |
| `bun run drive actors sleep <id>` | `POST /_admin/actors/sleep?id=`: put one object to sleep; its next call wakes it                                                                                                           |
| `bun run drive metrics`           | `GET /_admin/metrics`: the metrics below, in Prometheus' text format; `--text` filters                                                                                                     |

Each takes `--run <dir>` (a launched instance), `--url <workspace url> --admin-token <token>` (any
instance), or neither (this checkout's `bun run dev`); `--json` prints the JSON. A trace id is
either OpenBelt's (`x-openbelt-trace`, the `trace` in a tool's result, `function_runs`) or the span
trace's: both find the same request. When the instance has stopped, `logs` and `trace` read its
log file instead (lines, no spans).

Settings: `OPENBELT_LOG_LEVEL` (`info` by default; `debug` adds a line for every request),
`OPENBELT_KEEP_LOGS` and `OPENBELT_KEEP_SPANS` (how many lines and spans are kept in memory: 20,000
and 50,000). Every setting the platform reads is checked when it starts: one that isn't a value it
can use (`OPENBELT_SANDBOX_PROCESSES=eight`, `OPENBELT_LOG_LEVEL=verbose`) stops it with a line naming the
setting; unset or empty is the default.

Metrics (`/_admin/metrics`), each with few labels and never a workspace, app or path:

| Metric                                                                  | What                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openbelt_http_requests_total`, `openbelt_http_request_seconds`         | requests answered, by `status` class (`2xx` ... `5xx`), and how long they took                                                                                             |
| `openbelt_function_runs_total`, `openbelt_function_run_seconds`         | function runs, by `outcome` (`ok`, `error`) and `via` (page, agent, call, schedule, webhook, ...), and how long                                                            |
| `openbelt_mcp_tool_calls_total`, `openbelt_mcp_tool_call_seconds`       | agents' calls to OpenBelt's MCP tools, by `tool` (a name that isn't one: `unknown`) and `outcome` (below), and how long                                                    |
| `openbelt_outbound_requests_total`, `openbelt_outbound_request_seconds` | requests to the outside, by `kind` (`mcp`, `oauth`, `api`, `client-document`, a function's `function`) and `outcome` (a status class, `timeout`, `unreachable`, `refused`) |
| `openbelt_object_turn_wait_seconds`                                     | how long an event waited for its object's turn                                                                                                                             |
| `openbelt_object_commits_total`                                         | durable commits of objects' writes: under load, several events' writes share one                                                                                           |
| `openbelt_sandbox_processes`, `openbelt_sandbox_boxes`                  | sandbox processes running, and the boxes (a QuickJS instance each) they hold, busy or idle                                                                                 |
| `openbelt_sandbox_boxes_made_total`                                     | sandbox boxes made: a burst that finds them warm makes none                                                                                                                |
| `openbelt_sandbox_processes_ended_total`                                | processes ended, by `why`: `idle`, `stuck` (didn't stop a run when told), `failed`                                                                                         |
| `openbelt_sandbox_cpu_seconds_total`                                    | CPU the sandbox processes used (user and system), ended ones too: what each says every 5 s, and the rest when it exits                                                     |
| `openbelt_sandbox_wasm_bytes`, `openbelt_sandbox_process_peak_bytes`    | the boxes' WASM memory (most of what the sandboxes hold), and the most any running sandbox process has held                                                                |
| `openbelt_http_requests_open`, `openbelt_http_websockets_open`          | requests under way (open streams, an MCP session's, among them) and WebSockets open, read from Bun's server every 5 s                                                      |

What to look for:

- `request: GET <host><path> answered 503 in 12 ms`, with `trace`: every request that answered 400
  or more, or took over a second (and every request at `debug`). The trace is the thread:
  `bun run drive trace <id>` shows where the time went and what failed, `app_logs` the app's own
  lines, `function_runs` with `trace` every function run in it (a run and those it started with
  `ctx.call`).
- `slow: McpDO/acme/p_x waited 1.4 s for its turn (3 events ahead of it)`, and `held its turn for
6.2 s`: an object makes its callers wait (an object runs one event at a time). The second names
  how long it held the turn, not counting its waits on the outside.
- `actor: AppDO/<id> awake` with `ms`, and `asleep`: when an object was started or let go. A slow
  first request after quiet is a wake, and this says how long it took.
- `sandbox: a process for <workspace> is up (<how it confined itself>)`, `ended (<why>)`, and `used 12.4 s
of CPU, at most 140 MB` (with `cpu_seconds` and `peak_mb`) as it exits, however it ended: functions and
  `execute` run in QuickJS compiled to WASM, in sandbox processes (`runtime/sandbox.ts`,
  `sandbox-process.ts`), 2 per workspace (`OPENBELT_SANDBOX_PROCESSES`), never shared with another workspace, ended
  when the workspace has been idle for 10 minutes. Each starts with nothing of the platform's environment
  (as nobody when the platform is root, in the image) and, once QuickJS is loaded, confines itself
  (`sandbox-confine.ts`): on Linux, Landlock (no files, no exec, no TCP; Linux 5.13 or later, TCP from
  6.7) and a seccomp filter on every thread (no sockets at all, so no UDP either; signals to itself
  only; no ptrace or other processes' memory), `sandbox_init` on macOS. One that can't confine itself exits, saying why, and
  the runs given it fail. In a process a version's code runs in boxes: each a WASM instance of its own
  with its memory capped (128 MB, `OPENBELT_SANDBOX_RUN_MB`), the code loaded once, one run at a time.
  A box takes under a millisecond to make (QuickJS's WASM is compiled once per process); runs at
  once get boxes of their own. Each sandbox process keeps at most 128 MiB of idle WASM memory
  across all apps, function versions and preview environments (`OPENBELT_SANDBOX_IDLE_MB`, a positive
  whole number). When a run finishes, the least recently used idle boxes are discarded until
  they fit; a box larger than this budget is discarded too. Active runs are never evicted.
  This bounds cached WASM memory, not the process's total memory or its running functions.
  Raise the budget to retain more warm code; lower it to use less idle memory at the cost of
  reloading evicted code on the next call. Within this budget, a version's idle extras (past 4
  a process) are dropped after 30 s (`openbelt_sandbox_boxes`). Live and each preview use distinct
  boxes even when their function code is identical. A run past its memory or its 10 s of CPU is stopped where it is and its
  box dropped; one past its wall time, or whose caller gives up, is told to stop, and a process that
  doesn't within 2 s is ended with its other runs; the workspace's next run starts another.
- `shutdown: <step>` with `ms`: SIGTERM or SIGINT stops the platform in order (`runtime/shutdown.ts`):
  `/_health` answers 503 for 2 s while it still serves, then no new requests and those under way
  finish (5 s at most), this process's objects put to sleep (each finishing what it was doing; 6 s at
  most), the sandbox processes ended, the OTLP export flushed, then exit; about 2 to 5 s, 22 s at most
  (`past its deadline`). A second signal exits at once.
- An object's answer waits for its writes to be durable after it has given its turn up, so the next
  event runs meanwhile and shares the commit: a busy app writes several times faster than one
  writer at a time. A commit waits 10 ms to be shared only when other events are under way.

### Agents' tool calls

Workspace admins open **Events** in the settings sidebar (`/_settings/events`) to browse
OpenBelt MCP calls and connection calls together, newest first. Each row shows the person,
client, result and duration. Expand it for the trace, exact time, error and shortened arguments.
Search by tool, person, app, client or trace; filter by source, result, person, tool and app. Pages show 50 events;
Refresh loads new calls. The page keeps the latest 5,000 MCP calls and 500 connection calls,
across restarts. A connection call made through MCP appears in both sources, showing each
call's own duration. Scheduled function runs and ordinary HTTP requests are not included.
Expand a refused call for its recorded reason. Change access on People, Groups or Connections.
Access requests on Connections groups the outstanding requests for more access.

Every call an agent makes to OpenBelt's own MCP tools (`deploy_app`, `execute`, `search`, ...) is
kept, whatever the tool, by McpDO as it answers (`tool-calls.ts`), with one of five outcomes:
`ok`; `failed` (the agent's code, a function or a connection's server ran and failed:
`execute`'s `ok: false`, a `call_function` run that failed, a connection's `tool_error`);
`refused` (the tool said no, and why); `invalid` (arguments that don't fit, a tool that doesn't
exist, a request the server turned away); `defect` (OpenBelt failed inside: look here first). A call
on a session that can't be resumed isn't kept: no tool ran, and it's sent again on a new session.
Each is:

- a row in the workspace's activity (`bun run workspace activity`, `POST /_workspace/activity`, workspace admins): when,
  who, the client (`claude-code 2.1.3`, from its `initialize`), the tool, its app, the arguments
  (strings past 200 characters and lists past 20 cut, 2,000 characters at most, the value of any
  key like `token`, `secret`, `password`, `api_key`, `x-api-key`, `private_key` or `auth`, and
  `set_secret`'s value, taken out), the
  outcome, how long, the error and the trace. The newest 5,000 per workspace are kept.
  `--tool deploy_app`, `--person`, `--app` and `--outcome refused` narrow it.
- a log line, `tool call: deploy_app refused in 3 ms by bob@acme.com (claude-code 2.1.3): <why>`,
  with `tool`, `outcome`, `ms`, `app` and `agent` (`drive logs --text "tool call"`); a defect's is a warning.
  `agent` is who to count people by: the OAuth client the token was given to, by the name its
  metadata document (served from its own domain) or its registration gave, less a trailing `(…)`;
  with an API token, the name the client gave at `initialize`, which is only its word; else `unknown`.
- `openbelt_mcp_tool_calls_total` and `openbelt_mcp_tool_call_seconds` (above).
- a span, `McpDO.tool <name>`, with `openbelt.tool`, `openbelt.person`, `openbelt.client`,
  `openbelt.agent` and `openbelt.outcome`: in Tempo, `{span.openbelt.outcome="refused" && span.openbelt.tool="deploy_app"}`.

A tool's error, and a JSON-RPC error answering a call, ends with `(trace <id>)`, the id
`drive trace` and `app_logs` take, so whoever reads an error can hand it on.

### Database queue and execution time

`OPENBELT_DB_TRACE=sampled` (the default) adds database timing to 1 in 16 request traces,
selected by trace id consistently across processes. `all` records it for every traced request;
use it temporarily when diagnosing a slow request. `off` disables database timing. Restart the
platform after changing the setting. Full recording costs more than sampling.

`drive trace <id>` and OTLP show `db.count`, `db.errors`, `db.sqlQueueMs` (waiting until the
first worker dispatch), `db.queueMs` (waiting for the worker), `db.executionMs` (SQLite work)
and `db.transportMs` (return delivery), summed on the calling span. Within selected traces,
slow SQL queue waits, worker waits or executions (10 ms or more), failures and 1 in 64 fast operations also get
`SQLite.exec` child spans with the worker index. These fields contain no SQL text or bindings.
An unsampled request has no database timings; request and actor spans remain available.

The extra control worker keeps app SQL from occupying all database threads. Control queries
still share a worker, and app HTTP requests that need a busy WorkspaceDO can still wait for it.
`OPENBELT_DB_THREADS` continues to mean app workers; it never includes the additional control
worker. Object filenames and the app worker hash stay the same across upgrades.

### Keeping traces and logs

The memory above is gone when the platform stops. To keep traces and log lines, and search them
across days and instances, point the platform at an OpenTelemetry backend (Grafana, Honeycomb,
Datadog, any OTLP collector) with the standard variables:

| Setting                       | What                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the collector's base URL (`/v1/traces` and `/v1/logs` are added); unset or empty: no export             |
| `OTEL_EXPORTER_OTLP_HEADERS`  | `name=value` pairs, comma separated: a hosted backend's key (Grafana Cloud's `Authorization=Basic ...`) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (the default) or `http/json`                                                            |
| `OTEL_SERVICE_NAME`           | what it is filed under: `openbelt` unless set                                                           |
| `OTEL_RESOURCE_ATTRIBUTES`    | more about where it runs, `key=value` pairs: a deploy sets `deployment.environment.name=<stage>`        |

`OPENBELT_COMMIT` is sent as the service's version, so a trace says which commit served it.

Then every span, log line and metric also goes there, batched in the background (a backend that is down
costs requests nothing), and what is still batched is sent when the platform is sent SIGTERM. One
request is one trace, across the objects it calls, with a span for each request OpenBelt or a function
sends outside (`POST mcp.linear.app`, `fetch api.github.com`, with
`openbelt.outbound` and `openbelt.status`). Only OpenBelt's
own span attributes (`openbelt.function`, `openbelt.workspace`, ...) leave the process; a log line goes as it
is, with its fields, its span trace (`trace_id`) and OpenBelt's (`trace`). `/_admin/*` and
`bun run drive` answer as before.

On one machine, compose runs Grafana for it (Tempo for traces, Loki for logs, Prometheus), kept in
a volume, with Grafana at `http://localhost:3000` (`GRAFANA_PORT`), on this machine only:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://telemetry:4318 docker compose --profile telemetry up -d
```

It has the server's dashboards ([Grafana on the server](#grafana-on-the-server)), and takes OTLP at
`http://localhost:4318` (`OTLP_PORT`) too, so `bun run dev` can send to it; `bun run grafana
traffic` makes up a few minutes of use (people, an app with fast, slow, failing and scheduled
functions and a slow service outside) so the dashboards have something to show:

```sh
docker compose --profile telemetry up -d telemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=local bun run dev
bun run grafana traffic --url http://acme.localhost:<port> --token <adminToken from .dev/dev.json> --minutes 10
```

Then pick the stage `local` at the top of the OpenBelt dashboard.

Loki stops taking log lines while its disk is over 90% full (Docker's disk, on a Mac): the log
panels go empty while traces and metrics carry on, and with `ENABLE_LOGS_LOKI=true` on the
container it says "disk usage exceeded threshold, throttling writes". Free Docker's disk
(`docker system df`).

In Grafana, Explore finds a request by its span trace in Tempo, or with TraceQL
(`{span.openbelt.function="read" && duration > 50ms}`), and its lines in Loki
(`{service_name="openbelt"} | trace="<OpenBelt's trace id>"`).

A server's stages get the same Grafana with `OPENBELT_TELEMETRY=grafana`
([Grafana on the server](#grafana-on-the-server)).

### Page loads

A request's spans say how long the platform took, not how long a person waited. Each OpenBelt page
and each app page a browser opens (the script OpenBelt adds to it) reports its own load once: after
`load`, when no new file has started for a second, or when the page is left first. It posts to
`/_timing` on its own host, and the platform keeps it as a trace of its own, `page <host><path>`:

- the page's span, with the browser's connection type, round trip and bandwidth estimates
  (`openbelt.browser.connection`, `.rtt`, `.downlink`), its user agent, whether the page was hidden
  while it loaded, and its paint, `DOMContentLoaded` and `load` as events;
- a span for the document and each file it fetched (`script /app.js`, `fetch /_db/notes`), with
  their phases as children: `redirects` (sign-in redirects included), `dns`, `connect`, `tls`,
  `stalled`, `waiting` (the round trip and the platform's time) and `download`;
- on each file, `openbelt.server.trace`, the trace the platform answered it in, linked. Every
  answer carries it in `Server-Timing: traceparent;desc="00-<trace>-<span>-01"`.

A `page load: <host><path> in <ms> ms` line goes with it. In Tempo, `{name="page acme.openbelt.app/notes"}`
finds a page's loads, and `{span.openbelt.browser.ms > 3000}` the slow ones. Only a page's own origin,
from someone the workspace admits, is kept: anything else is answered 204 and dropped. The public host
(`openbelt.page`) has no report. WebSockets aren't files, so a socket's opening isn't in it.

## Abuse

### Storage caps

An app's data (its documents, in its own SQLite file) and a workspace's total are capped, and writes stop
before the disk fills:

| Setting                       | Default | What                                                  |
| ----------------------------- | ------- | ----------------------------------------------------- |
| `OPENBELT_DATA_APP_MB`        | 1024    | one app's data (0: no cap)                            |
| `OPENBELT_DATA_WORKSPACE_MB`  | 10240   | a workspace's apps together (0: no cap)               |
| `OPENBELT_DATA_DISK_FLOOR_MB` | 1024    | free disk kept: writes stop there, in every workspace |

A write that would add data past one (a page's, a function's, `collection_add`'s) is refused with a 507
`storage_full` that says which, how much is used and the setting; reads and deletes go on. A deleted
document's last version is kept on the server (the rules decide from it who is told it went; pages
get only its id) until the app reaches a cap: then those go first, so deleting frees room, and a page reconnecting from before that reloads.
Retained deploy files have a separate 256 MiB per-app budget (`OPENBELT_VERSIONS_APP_MB`; 0 disables it).
When necessary, a deploy removes the oldest unpinned history to fit. The new live version, the previous
live version and active previews are protected. If those cannot fit, the deploy is refused atomically
and the live and preview versions remain unchanged. Identical file hashes count once. Deploys also
respect the disk floor. An app's size is
its file's pages in use. A growing data commit, seed or deploy checks the resulting size inside
its transaction and atomically reserves that size in the workspace before committing. An oversized batch
commits nothing. A failed transaction can leave a conservative reservation; the app reconciles its
actual size on its next write. Existing apps are accounted as they are used. `openbelt_refused_total{why="storage"}` counts refusals. Uploads have
their own caps (`OPENBELT_FILES_*`, [Files](#files)).

Public apps have three more: `OPENBELT_PUBLIC_APP_WRITES_PER_MINUTE` (120) writes, function calls and live query runs a
minute to one app from the public host, every address together (429); `OPENBELT_PUBLIC_ADDRESS_SHARE` (25): the percent
of that one client address may use (by the address the per-address request limit counts; a request straight to the port,
with no `x-forwarded-for`, counts toward the app's limit only); and `OPENBELT_PUBLIC_DATA_SHARE` (50): past that percent
of `OPENBELT_DATA_APP_MB`, the public host adds and changes no documents in the app (507), while its members still
write. A request refused before doing any work (no such function, an op `public` doesn't list, the rules, a bad body) is not counted, nor is a watched query that a write from outside
the public host runs again.

### Request limits

| Setting                                 | Default | What                                                          |
| --------------------------------------- | ------- | ------------------------------------------------------------- |
| `OPENBELT_RATE_PER_MINUTE`              | 3000    | requests per signed-in person/workspace, or anonymous address |
| `OPENBELT_RATE_WRITES_PER_MINUTE`       | 600     | of those, methods other than GET, HEAD and OPTIONS            |
| `OPENBELT_RATE_IP_EMERGENCY_PER_MINUTE` | 30000   | emergency request ceiling per address for everyone            |
| `OPENBELT_DEPLOYS_PER_HOUR`             | 300     | deploy attempts per person/workspace                          |

Signed-in browsers and agents share the person's permanent workspace identity, not their token, session,
app or address. Their refilling buckets are persisted in their McpDO, so opening another session,
changing address or reaching another platform process does not reset the allowance. Colleagues
behind one office address have separate allowances. MCP initialization and notification requests
count too. Refusals answer 429 with `Retry-After` and a message naming the setting and when to retry.

Anonymous traffic uses address buckets in each gateway process. Every address also has the higher
emergency ceiling, including signed-in traffic; a large office can still reach that ceiling.
These address limits can multiply by the number of processes and reset on restart. The person's
request and deploy limits do not. The operator's routes are exempt; anonymous loopback requests
without forwarded headers are exempt for local tooling. Signed-in local requests still count.

Only a trusted front door's `X-Forwarded-For` supplies the address; otherwise the peer address is
used. On hosted servers the platform port binds to localhost and Caddy supplies forwarding headers.
Keep that port private when self-hosting. The hosted deploy passes these settings and the storage
settings through to the container. Uploads retain their separate `OPENBELT_FILES_*` limits.

### Runs, browsers and request sizes

Function, query and `execute` runs, check_app's browsers and request bodies are bounded so that one
person can't take the machine's memory, at any number of workspaces:

| Setting                              | Default | What                                                                                         |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `OPENBELT_SANDBOX_RUNS`              | 16      | sandbox runs under way at once on the machine; the rest wait in line                         |
| `OPENBELT_SANDBOX_TENANT_RUNS`       | 6       | of those, one workspace's                                                                    |
| `OPENBELT_SANDBOX_PARKED`            | 16      | runs waiting on a `ctx.call` at once (each keeps its heap); past it, refused                 |
| `OPENBELT_SANDBOX_TENANT_PARKED`     | 8       | of those, one workspace's                                                                    |
| `OPENBELT_SANDBOX_MACHINE_PROCESSES` | 16      | sandbox processes kept (about 60 MB each at rest); the longest idle ends                     |
| `OPENBELT_SANDBOX_RECYCLE_MB`        | 160     | a sandbox process that grew past this ends once idle (its heap stays)                        |
| `OPENBELT_CHECKS_AT_ONCE`            | 4       | check_app browsers at once (about 150 MB each), half per workspace; a check waits up to 20 s |

A page in check_app's browser (or a deploy's picture) holds at most 512 MB of JavaScript heap; past
it the page crashes and the check says so.

Each run may hold `OPENBELT_SANDBOX_RUN_MB` (128) of heap, so `OPENBELT_SANDBOX_RUNS` plus
`OPENBELT_SANDBOX_PARKED` times that, plus the processes and browsers, bounds the container's memory
(`OPENBELT_MEMORY_LIMIT`; runs rarely use all of their heap); raise them together. A run waiting on a
`ctx.call` gives its place to the run it called, which goes ahead of new runs. Should the container
still run out of memory, the kernel ends a sandbox process first, then a browser, never the
platform's processes before them (`oom_score_adj`); the supervisor outlives a platform process that
ends with runs in flight.

An MCP request is at most 64 MB (413 past it, read no further), and a connection's server's reply at
most 16 MB (the call fails, saying so). Each platform process holds at most 192 MB of MCP requests at
once, and 80 MB of one person's (by email, across their workspaces), from before the first byte is
read until the answer; past either, 503 `busy` with `Retry-After: 5`, read no further. 60 requests of
63 MB at once from one person took a 4 GB container through its swap until the kernel ended a
platform process. Before these, 40 parallel `execute` calls of 96 MB, one
1 GB MCP request, or a connection answering `tools/list` with 1.2 GB each ended a platform process
on a 4 GB container, and the supervisor with it.

## Stopping and crashes

Measured on a Mac, from the kill to the first answer (the `crash-recovery` check holds these rows):

| What dies                                                           | What happens                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The platform, stopped with SIGTERM (`docker stop`, a host shutdown) | It stops in order (below) in about 2 to 5 seconds, nothing lost; started again, it answers in under a second.                                                                                                                                                                                           |
| The platform, killed (SIGKILL, OOM, power loss of the process)      | Started again on the same data, it answers in 466 ms. Nothing acknowledged is lost (kill -9 under 24,187 acknowledged writes: none). An app that only its schedule wakes runs again with nothing requesting it: each process arms the wake-ups in its wake file when it starts, and runs what came due. |
| One of its processes (`OPENBELT_PROCESSES` above 1)                 | The supervisor starts it again: its objects answer again in 1.4 s, the other processes' all along.                                                                                                                                                                                                      |
| The machine (a kernel panic, a power cut, the disk kept)            | As a kill, but the last second of acknowledged writes may be lost: each file is synced once a second ([The data](#the-data)).                                                                                                                                                                           |

**Losing the machine** loses its disk, and the data with it. Keep the data directory on a volume that
outlives the machine (EBS, a Hetzner Volume, a Persistent Disk) and attach it to the next one: what was
synced is there. Without one, restore from what was copied off it: the continuous copy loses about
the last second or two, a backup what came after it ([Backups](#backups)).

The platform, sent SIGTERM, stops in order (`shutdown:` lines, below): `/_health` answers 503 for 2
seconds while it still serves, so a proxy in front moves on; then it stops taking requests and lets
those under way finish (5 seconds at most); each object finishes its events under way (6 seconds at
most) and is put to sleep, which syncs and closes its file; about 2 to 5 seconds in all, 22 at most.

**Let stops finish.** `compose.yaml` gives the platform `stop_grace_period: 30s` (Docker's default 10
seconds can cut a stop short, which is a kill). If your supervisor has its own timeout, set it above
22 seconds.

### Deploys without client errors

A deploy stops the platform and starts the new version on the same data, behind a proxy that holds
each request while it restarts (about a second) and sends it once `/_health` answers. With Caddy:

```
https:// {
	reverse_proxy openbelt:1337 {
		lb_try_duration 30s
		lb_try_interval 100ms
		health_uri /_health
		health_interval 250ms
		health_timeout 1s
		health_passes 1
		health_fails 1
		fail_duration 1s
	}
}
```

The old platform answers `/_health` 503 for its first 2 seconds of stopping, so the proxy stops
sending to it before it stops taking connections; each object it held finishes what it was doing
first, and wakes in the new one on its next request. A page's socket closes and the SDK opens it
again with `?since=`, getting what changed meanwhile; an MCP session carries on. The `deploy-swap`
check proves it with this block ([Production](#production)), and `bun run
deploy` deploys this way.

### Backups

`bun run data backup <dest> [--data <dir>]` copies the data directory while the platform runs: it holds
`<data>/.snapshot.lock`, which keeps every platform from checkpointing or closing an object's file
meanwhile, so each file's database stays as it was and its WAL only grows, and the copy opens like a
file after a crash, with every write acknowledged before the copy began. A clone where the
filesystem can (APFS, btrfs, XFS): 15 ms on a Mac for a test's data. `bun run data restore <backup>
[--data <dir>]` puts one back with the platform stopped, setting what was there aside beside it. A
standby is a restore into its own directory: the `standby` check restores one and answers in 455 ms,
holding every write made before the backup. `--data` defaults to `OPENBELT_DATA`, else `~/.openbelt/data`.

**Continuous copies off the machine** come from the platform itself (`runtime/replicate.ts`), when
`OPENBELT_BACKUP_URL` is set (`s3://<bucket>/<prefix>?endpoint=<host>` with `OPENBELT_BACKUP_KEY_ID` and
`OPENBELT_BACKUP_SECRET`, or `file:///<dir>`): after each commit an object's thread reads what its WAL
gained, and each process uploads all of it as one gzipped object every `OPENBELT_BACKUP_SECONDS` (1),
whatever the number of files; a changed file is also uploaded whole when it opens, when it closes and
every `OPENBELT_BACKUP_SNAPSHOT_SECONDS` (300), and older batches are deleted once every file in them has
a newer snapshot. It lists nothing while it runs and never holds up a commit. Losing the machine loses
about the last second or two: the `replication` check kills the platform mid-write, restores from the
bucket alone into an empty directory, and finds every write acknowledged more than 3 s before the kill
(measured: the losses, when any, all within 0.41 s of it). On a laptop with 20,000 files: about one PUT
a second per process, no LIST or GET, and a restore in 35 to 64 seconds.

- **On a server.** `bun run deploy` passes `OPENBELT_BACKUP_URL`, `OPENBELT_BACKUP_KEY_ID` and
  `OPENBELT_BACKUP_SECRET` to the stage (from its env file, or CI's variables and secrets), never
  to the canary. On Cloudflare R2, with a token for that bucket alone:
  `s3://<bucket>/<prefix>?endpoint=https://<account>.r2.cloudflarestorage.com`.
- **Nightly, with history.** The continuous copy keeps only the newest state. `deploy/nightly.sh`
  (installed on the server as its header says, run from `deploy`'s crontab) takes `bun run data backup`
  in a container of the stage's image, tars it and puts it in a bucket of its own as
  `<stage>/<when>.tar.gz`; the bucket's lifecycle rule says how long each is kept (30 days for prod).
- **Where to.** Any S3-compatible bucket. On Backblaze B2 uploads and deletes are free, so the bill is
  storage (about $6 to $7 a TB a month); your own MinIO or RustFS works too. At one upload a second per
  process, per-request billing (AWS S3, Cloudflare R2) costs little either way.
- **Restore.** On a new machine: `bun run data restore-backup <url> <dir>` makes the data directory
  (the newest snapshot of each file and what came after it, each file checked), then start OpenBelt on it
  and point DNS at it.
- **Not yet.** A new bucket gets every file once before the platform serves (12 to 18 s at 20,000
  files); an object deleted from OpenBelt comes back on a restore; batches a restarted process left
  behind aren't cleaned up; what waits for upload isn't capped while the bucket can't be reached.
- **Not Litestream.** It was measured for this and doesn't fit: it watches each file on its own, and at
  20,000 files it held 8.6 GB and 120,000 open files, uploaded nothing, and listed the bucket about
  360 times a second (on Backblaze B2, about $3,000 a month in list calls).

## Moving off the Rivet engine

Before this version, OpenBelt ran its objects on a [Rivet](https://rivet.dev) engine, which kept their
data (or, at the end, placed them while their data was already in files). This version reads only its
data directory: `bun run tailnet` and `bun run deploy` refuse a setup whose data is still in an engine
(the tailnet's `engine` directory, a server's `state.json` from the blue and green slots) and point
here; `verify:upgrade` and `verify:rollback` skip a base that kept its data there. An export from an
engine to a data directory is pending; until it lands, keep such an instance on the last Rivet build
(`805f486`).

## Working in parallel

Every checkout of the repo runs on its own, side by side: the main one, a `git worktree add`, a
`claude --worktree` or a subagent's worktree, a [herdr](https://herdr.dev) worktree.

- **Setup**: a new worktree installs its dependencies by itself (`bun install`, a few seconds,
  linked from Bun's cache): git's `post-checkout` hook (lefthook) for `git worktree add`, a Claude
  Code `SessionStart`/`SubagentStart` hook for worktrees Claude Code makes (it skips git hooks),
  herdr's JavaScript Worktree Bootstrap plugin for herdr's. Whichever runs second finds
  `node_modules` and does nothing.
- **Git hooks** are installed from the main checkout only (`scripts/prepare.ts`): they live in the
  shared `.git`, and installing from a worktree would point every checkout's hooks into it.
  Pre-commit checks the staged files; pre-push runs `bun run check` (seconds). Run
  `bun run verify <check>` for what you changed; CI runs the whole suite.
- **`bun run dev`**: the main checkout on `127.0.0.1:1337` and, with the tailnet's domain, port
  8445 of the tailnet address; a worktree on a pair of its own in 1340-1389 and 8450-8499, picked
  from its folder, so its URL is the same every run (the next pair when one is taken). Both are its
  front door (it holds requests while the platform reloads); the platform itself is on the first
  port + 1000. It fails instead of moving to another port, and stops its front door when it stops.
  Each checkout has its own data (its namespace) and its own tokens. `bun run dev --email` uses
  email sign-in on the tailnet's HTTPS listener, so you can preview sign-in, workspace switching and
  sign-out. The local owner door still names you without sign-in.
- **`bun run verify`**, `bun run try:pi` and `bun run verify:before-after` already use a free port
  and their own folders and namespaces per run.
- **Cleanup**: a `bun run dev` that didn't stop cleanly (kill -9, a crash, its worktree removed
  while it ran) is cleaned up by the next `bun run dev` anywhere: an orphaned dev server whose
  folder is gone or whose `bun run dev` died is stopped, and a dev `tailscale serve` with nothing
  behind it is turned off (`scripts/sweep.ts`; `bun scripts/sweep.ts` runs it alone).
  `bun run worktrees` lists the repo's worktrees and why each stays; `bun run worktrees prune`
  shows which are done (folder gone, or clean with its work merged into `origin/main`, squash
  merges too) and `--yes` removes them, herdr's through herdr, with their branches. A worktree
  with changes, unmerged commits, a running `bun run dev` or a live lock is never removed; a new
  one with no work yet is kept (`--empty` removes those after 7 idle days).
- **Disk**: nothing to do by hand. `node_modules` costs a worktree a few MB of real disk (Bun clones
  its cache's files, so `du` overcounts; `df` tells the truth). Cargo builds into one build directory
  in the shared `.git` (`scripts/cargo.ts`): the CLI's dependencies build once for every checkout, and
  a checkout's `cli/target` holds only its own binary. A passed
  verify check keeps its logs and results but not its databases or its platform's data; a failed one
  keeps all. Once a day `bun run dev`, `verify` and `check` clear the build output (cargo targets,
  `.verify/`, `.fallow/`) of each worktree idle 7 days, never its work (`scripts/tidy.ts`;
  `bun run worktrees tidy` does it now), and say so when the disk has under 20 GB free.
- **Shared on purpose**: the data directories (`~/.openbelt/data` for dev, the repo's `.verify/data`
  for verify, a namespace per checkout or run in each), the tailnet instance (`bun run tailnet`, its
  own clone and data), `~/.config/openbelt`, and git's stash (use a WIP
  commit, not `git stash`, in a worktree).

## How a local instance is isolated

`scripts/verify/launch.ts` starts the server (`packages/platform/src/server.ts`) on a free port in a
new namespace of the verify data (`OPENBELT_DATA=.verify/data`, `OPENBELT_NAMESPACE=verify-<random>`: a
folder of its own), with a test token. It prints `{url, mcp: {url, token}, namespace, ...}`;
`scripts/verify/stop.ts <runDir>` stops it and everything it started (a check's Chrome). The data
stays in the namespace's folder: launch again with `--namespace` to carry on from it, as an upgrade
does.

## Local and deployed differ in a few ways

- Locally every workspace is `<workspace>.localhost` and every app `<app>--<workspace>.localhost`; deployed, both need
  a wildcard domain (`OPENBELT_HOST`), with a certificate for `*.<OPENBELT_HOST>` (or one per name on demand).
- A function's wall time (30 seconds) and CPU time (10 seconds) are limited: a run that spins is
  stopped at 10. Functions share the machine with the platform: each workspace's spinners use at most its
  2 threads' cores, and its other runs wait behind them while both spin. Compute is QuickJS's, an
  interpreter: about 10 times slower than V8 at a tight loop (30 million steps: 1.5 s).
- One machine: there is no failover. A deployment's data is on its machine's disk; losing the
  machine means restoring it on another ([Stopping and crashes](#stopping-and-crashes)).

## Updating marketing artwork

The homepage film's source lives in `brand/film/`. Its intro uses the CC0 metal
clasp recording documented in `brand/film/sounds/README.md`, embedded in both
the player and exported score. `bun run brand film --page` builds the local player;
`bun run brand film` renders both video sizes. Follow `brand/AGENTS.md` to upload
them under a new media folder and update the homepage sources.

The platform serves marketing assets with ETags and `Cache-Control: no-cache`: unchanged assets
return 304, while edits are checked on the next visit. `bun run brand sync` bundles the brand
stylesheet's imports into `www/brand/css/openbelt.css`. The homepage preloads its two main fonts
and waits until the story is near the viewport to load its poster; distant logos load lazily.
The homepage uses Speculation Rules to prefetch `/_signin` on hover or pointer press in supporting
browsers. Other browsers follow the Sign in link normally. The rule covers only that destination.
Workspace pages also hover-prefetch Connections, Settings and its tabs, and the connection catalog.
These rules match exact links, excluding query strings, OAuth actions and app cards. They prefetch
HTML without running the destination's scripts; browsers without support navigate normally.

Keep third-party artwork in `www/assets/` separate from OpenBelt's own `brand/` assets.
Record the owner's source, permitted treatment and any required attribution in
[`www/assets/README.md`](../www/assets/README.md). Preserve supplied colors and proportions;
a collection's license does not settle trademark permission. Pending reviews are listed there.

The compact logo rows move on touch screens. Tap an icon to show its name and pause its row;
tap elsewhere to dismiss it. A swipe does not leave a name selected.
On a keyboard, Tab reveals each name, stops its row, and brings the focused icon into view.
Animated duplicate icons stay hidden from assistive technology and cannot receive focus.

After changing the artwork, run `bun run design:shots artwork --only marketing --launch`
to check the homepage at desktop and phone sizes, then run `bun run check`.

## OpenBelt brand assets

OpenBelt's own pages use the prebuilt tiles and wordmarks in `brand/logo/`, copied to
`www/brand/logo/` by `bun run brand sync`. Choose the asset from
[the brand asset table](../brand/DESIGN.md). Standard tiles contain a centered 54% mark; only
16–32px browser favicons use the larger 62% mark. MCP server icons and animations use the
standard tile. User apps may use their own branding.
