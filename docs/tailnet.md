---
title: OpenBelt on your tailnet
description: Run OpenBelt on one Mac for your Tailscale tailnet with bun run tailnet: always on, one workspace, everyone signed in as their Tailscale login, agents connected over MCP from any device; the domain it needs once, upgrading (tried on a copy first, snapshotted, rolled back by itself if it fails), rollback, stopping, where the data lives, and what it trusts.
---

# OpenBelt on your tailnet

`bun run tailnet up` runs OpenBelt on this Mac for everyone on your tailnet. Agents on any device
connect over MCP, people open apps in the browser, and nobody off the tailnet can reach it. It
needs Tailscale running and logged in, and a domain set up once (below). Nothing else to sign up for.

```sh
bun run tailnet up
# OpenBelt is up for your tailnet: https://acme.openbelt.example.com:8444 (you're you@example.com there; each app on https://<app>--acme.openbelt.example.com:8444, …)
# Claude Code: claude mcp add --transport http openbelt https://…/mcp --header "Authorization: Bearer pr_…"
```

## A domain for the tailnet

Every app is served on a host of its own (`<app>--acme.<domain>`: [Who is viewing](./viewers.md#every-app-on-its-own-host)
says why), and `tailscale serve` answers only this Mac's own name. So `bun run dev` and
`bun run tailnet` bring their own front door (`scripts/frontdoor.ts`): it does what `tailscale
serve` does (HTTPS on the tailnet, and who each request is from) for every host under a domain,
and holds requests while the platform restarts. Set the domain up once:

1. Pick a domain whose DNS you control, e.g. `openbelt.example.com`.
2. Add two DNS records, `openbelt.example.com` and `*.openbelt.example.com`: type A, the Mac's tailnet
   address (`tailscale ip -4`), DNS only (not proxied). The address reaches nothing off the
   tailnet, and MagicDNS passes the name on to public DNS, so every device on the tailnet finds it.
3. Put the domain and a Cloudflare API token that can edit the zone's DNS in
   `~/.config/openbelt/dev.env` (keep it readable only by you: `chmod 600`):

   ```sh
   CLOUDFLARE_DNS_API_TOKEN=…
   OPENBELT_DEV_DOMAIN=openbelt.example.com
   OPENBELT_DEV_CERT=~/.config/openbelt/dev-cert/certificates/openbelt.example.com.crt
   OPENBELT_DEV_KEY=~/.config/openbelt/dev-cert/certificates/openbelt.example.com.key
   ```

   `bun run dev` and `bun run tailnet` read the three `OPENBELT_DEV_*` keys from it themselves (set
   in your environment, they win); nothing goes in your shell profile.

4. Get a certificate for the domain and every workspace and app under it (`*.openbelt.example.com`: each is one
   label, `acme` or `<app>--acme`). Nothing public can reach the Mac, so use a DNS challenge,
   with [lego](https://go-acme.github.io/lego/) v5:

   ```sh
   brew install lego
   lego run --env-file ~/.config/openbelt/dev.env --path ~/.config/openbelt/dev-cert \
     --dns cloudflare --dns.propagation.wait 60s --accept-tos --email you@example.com \
     -d openbelt.example.com -d '*.openbelt.example.com'
   ```

   It writes the certificate and key under `~/.config/openbelt/dev-cert/certificates/`, named after
   the first domain. `--dns.propagation.wait 60s` waits a fixed minute for the challenge's record
   instead of looking it up, which fails on networks that intercept DNS (port 53). The
   certificate lasts 90 days: `bun run dev` and `bun run tailnet up` print when it expires, and
   from 14 days before, a warning with the command to renew it (the same `lego run`), then restart.
   They warn the same way when it isn't for `*.<domain>`: run that command once.

Then `bun run tailnet up` serves `https://acme.openbelt.example.com:8444` and `bun run dev` `https://acme.openbelt.example.com:8445`. The front
door also answers this Mac's own name, `https://<this-mac>.<tailnet>.ts.net:<port>`, with the
certificate Tailscale gives it, so an old link or MCP URL still lands: the workspace's pages there, and
an app's link goes on to its host. Without the domain, `bun run dev` runs on this Mac only
(`http://acme.localhost:1337`, each app on `http://<app>--acme.localhost:1337`, signed in as you).

An instance from before the domain, reached through `tailscale serve`, moves to the front door on
its next `bun run tailnet up`: `tailscale serve` on its port is turned off (and back on if the
upgrade goes back by itself).

Paste the printed command on any device on the tailnet. `bun run tailnet token <email>` mints a
token for someone else's agent.

## What it runs

- The same platform as `bun run dev` (one server process: the gateway, and the Durable Objects,
  each with a SQLite file of its own in its data directory), as two launchd services that start at
  login and restart within seconds if they stop: the platform, which keeps every app's data; and the
  front door in front of it, which also holds requests while the platform restarts. The data is
  this instance's own (not `bun run dev`'s).
- Each version from its own release folder, made from a clone of your checkout: editing your
  checkout never reloads it.
- The platform listens on `127.0.0.1` only. The front door (HTTPS on the Mac's tailnet address,
  port 8444 or the next free one) is the only way in from the tailnet.
- The workspace `acme`, at `acme.<domain>`, each app at `<app>--acme.<domain>`. Links in tool results
  are those `https://` URLs.
- `bun run dev` is the same thing from your checkout, with live reload, on port 8445.

## Who is signed in

Everyone who opens an app from a device on the tailnet is signed in as their Tailscale login:
`db.me()` is `{ email, name }` from Tailscale, and their writes carry it as `author`. There's no
sign-in page. A tagged device (an exit node, a server) has no login, so it's signed out and writes
as "anonymous". `check_app`'s browser is signed out too, as on any host; its `people` work in
preview environments as usual.

The front door asks Tailscale who each peer is (`tailscale whois` of the address it came from),
sets that in the headers `tailscale serve` would (`Tailscale-User-Login`, `Tailscale-User-Name`),
and replaces whatever a client sent, which is what makes this safe on the tailnet. A program running on the Mac itself can call `127.0.0.1` directly
and claim to be anyone, so run it on a Mac only you use.

## Commands

| Command                             | Does                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bun run tailnet up [ref] [--drop]` | Start it, or upgrade it to `ref` (a branch, tag or commit of your checkout; default `main`); see below |
| `bun run tailnet rollback [--data]` | Back to the version before the last `up`; `--data` also puts the data back as it was before that `up`  |
| `bun run tailnet status`            | Up or down, the commit it runs, how far behind `main` it is, the version `rollback` goes back to       |
| `bun run tailnet token [email]`     | An API token (default: your Tailscale login) and one-paste MCP commands                                |
| `bun run tailnet logs`              | Its log's last 50 lines (`--follow` keeps following; `~/Library/Logs/openbelt-tailnet.log`)            |
| `bun run tailnet down`              | Stop the services, the front door too; the data stays                                                  |

## Upgrading

Pull or merge into your checkout's `main`, then `bun run tailnet up`. It prints the commits between
the version running and the new one, then:

1. **Tries the new version on a copy of the data**: the new version's server on the copy, on spare
   ports, while the old one keeps serving. If it doesn't
   start, or it holds less than the old one (apps, live versions, documents, preview environments,
   tokens), nothing changes and you get its output. The copy and both processes are deleted after.
2. **Snapshots the data** with the old version stopped, then starts the new one. The front door
   holds requests meanwhile (`up` prints how long: a few seconds), so pages and agents see a slow
   request, not an error. Past 30 seconds a page gets an
   "Updating" page that reloads itself, and an API call a 503 that says to retry.
3. **Goes back by itself** to the old version and the snapshot when the new one doesn't answer
   within 2 minutes, or comes up without an app the copy had.

Open pages reconnect by themselves. One that loaded an older `/sdk.js` than the new version serves
reloads once, as it does when its app goes live in a new version.

A version can drop data on purpose: a rename that doesn't move what's stored under the old name,
listed in `packages/platform/storage.json` under `dropped`. `up` says what goes and stops; run it
again with `--drop` to go ahead. The snapshot keeps the data, and `bun run tailnet rollback --data`
brings it back.

`bun run tailnet rollback` goes back one `up`: the code, and with `--data` the data as it was before
that `up` (writes since are lost; the data it replaces is snapshotted first). `up` goes forward
again. Both refuse a version that neither runs nor drains a kind of alarm job that can be pending:
one the running version books. That version would retry those jobs
every 30s forever ([never roll back past a drain](./running.md#running-on-a-server)).
`rollback --data` isn't checked: the data goes back to what that version ran. The older version
skips openbelt.json keys it doesn't know (and doesn't serve such an app's `functions/` files); an app
whose openbelt.json it can't read at all refuses its pages' reads and writes and runs none of its
functions until it's deployed again (`app_logs` and `app_info` say so).

## Data and secrets

All under `~/.local/share/openbelt/`:

- `tailnet-data/data/`: apps, documents and tokens (every Durable Object's SQLite file, in the
  namespace folder `tailnet`). Copy it while it runs with `bun run data backup <dest> --data
~/.local/share/openbelt/tailnet-data/data` ([Backups](./running.md#backups)); delete it (after
  `down`) to start empty. An instance from before kept its data in a Rivet engine's directory
  (`tailnet-data/engine/`): `up` refuses it until it is exported
  ([Moving off the Rivet engine](./running.md#moving-off-the-rivet-engine)).
- `tailnet-snapshots/`: the data before each of the last 5 upgrades.
- `tailnet-releases/`: the current version and the one before it, each with its dependencies.
- `tailnet/`: the clone of your checkout that releases are made from.
- `tailnet-front.js` and `tailnet-front.json`: the front door's own copy, and what it serves.

The admin token, session secret, the key that seals connection tokens, the domain and ports are in
`~/.config/openbelt/tailnet.env` (readable only by you), made on the first `up` (the key is added to
one made before it). The
platform's service gets them in its launchd plist, which is readable only by you too.

`OPENBELT_TAILNET=<name> bun run tailnet ...` runs another instance beside it, with every path,
service and port of its own.

## Limits

- macOS only (launchd).
- One Mac: when it sleeps or is off, the apps are down.
- Port 443 is often held by something else on a Mac (a local proxy, OrbStack), so it serves on
  8444 or the next free port.
- No CPU limit per request. A bug in OpenBelt that loops forever hangs the platform (launchd
  restarts it only when it exits); run `bun run tailnet up` again.
