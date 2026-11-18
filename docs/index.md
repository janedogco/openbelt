---
title: OpenBelt
description: What OpenBelt is, how its pieces fit, and where to read next.
---

# OpenBelt

OpenBelt hosts small apps for companies (workspaces). Agents build them over MCP; people use them in the
browser. An app is a folder of static files that calls one shared SDK for data and realtime, so
there's no build step: a deploy is live at once, or goes into a named preview environment over
separate test data first, where several apps can be tested together.

- **[Quickstart](./quickstart.md)**: run OpenBelt on your machine and have an agent build an app.
- **[Getting started](./start.md)**: what an agent does for someone new or asking for their first
  tool: five picks, the starter app they pick or the smallest version of their own, the link, then
  four next steps.
- **[Apps](./apps.md)**: what an app is, deploys and patches, preview environments, promoting and rolling
  back, conflicts, versions, names and limits.
- **[SDK](./sdk.md)**: `/sdk.js`, the data and realtime API every page can import, and using
  another app's data.
- **[Who is viewing](./viewers.md)**: `db.me()`, sign-in, what a document's `author` proves, and
  testing as several people.
- **[Functions](./functions.md)**: an app's server code (`functions/<name>.js`), called from its
  pages, other apps and agents: atomic runs, live queries, schemas, the outside world (network,
  secrets, connections), schedules, webhooks, triggers and later runs.
- **[Code](./code.md)**: `execute`, an agent's JavaScript with the whole workspace in reach.
- **[Who can change what](./rules.md)**: openbelt.json rules, enforced on every page's read and
  write.
- **[MCP](./mcp.md)**: connecting an agent, tokens, and every tool.
- **[People and groups](./people.md)**: who is in a workspace, open or invite-only joining, workspace admins,
  removing someone, and `bun run workspace`.
- **[Connections](./connections.md)**: MCP servers the workspace's admins add (DeepWiki, Linear), whose
  tools agents call through OpenBelt: whose token, who may use which tool, explain and activity.
- **[Debugging](./debugging.md)**: check_app, browser errors in the app log, trace ids, the
  platform log.
- **[Architecture](./architecture.md)**: the gateway and the Durable Objects behind it, each with a SQLite file of its own.
- **[Running OpenBelt](./running.md)**: `bun run dev`, `try`, `verify`, and running it on a server.
- **[Trying OpenBelt by hand](./qa.md)**: `bun run seed` and `bun run qa <state>`, to see every
  state of OpenBelt's pages.
- **[OpenBelt on your tailnet](./tailnet.md)**: one Mac, always on, for everyone on your Tailscale
  tailnet.

## The shape of it

```
one server process (the gateway)
<workspace>.<domain>                 the workspace's host: OpenBelt's own
  /                            the gallery of its apps
  /mcp                         agents: deploy_app, collection_add, app_logs, ...
  /<app>/<path>                the app's page in the workspace's frame: the address people open
<app>--<workspace>.<domain>          each app's own host
  /...                         the app's files, its data (/_db) and realtime (/_ws); a browser's page load goes to the frame
  /_preview/<env>/             the app's version in a preview environment, over that environment's data
  /a/<other>/_db, /_ws         another app's data, as this app
  /sdk.js                      pages: import { db } from "/sdk.js"
```

Every app is one Durable Object: its files, versions, data (live and per preview environment),
sockets and log live together.
