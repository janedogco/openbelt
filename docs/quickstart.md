---
title: Quickstart
description: Run OpenBelt on your machine for your Tailscale tailnet, connect pi or Claude Code over MCP, and have an agent build a live app.
---

# Quickstart

## 1. Run it

On this Mac alone you need nothing else. For your tailnet, you need Tailscale running and logged in,
and a domain set up once ([A domain for the tailnet](./tailnet.md#a-domain-for-the-tailnet)):
every app has a host of its own, and OpenBelt's front door says who each viewer is.

```sh
bun install
bun run dev
```

`bun run dev` runs the platform with live reload at
`https://acme.<your domain>:8445`, the workspace "acme", for anyone on your tailnet, each signed in as
their Tailscale login, and at `http://acme.localhost:1337` on this Mac, signed in as you with
nothing to sign in to. It prints an API token and the commands to connect an agent.
Data stays between runs in this checkout's namespace of `~/.openbelt/data` (a folder per checkout).

## 2. Connect an agent

The fastest way is `bun run try:pi`: a fresh, isolated OpenBelt plus pi with only the openbelt MCP
server, in an empty folder. It stops OpenBelt when pi exits.

To connect your own agent to `bun run dev`, paste the command it printed, from any device on the
tailnet:

```sh
# pi
OPENBELT_TOKEN=pr_... pi mcp add openbelt --url https://acme.<your domain>:8445/mcp --bearer-token-env-var OPENBELT_TOKEN

# Claude Code
claude mcp add --transport http openbelt https://acme.<your domain>:8445/mcp --header "Authorization: Bearer pr_..."
```

Or with nothing printed: `http://localhost:1337` is OpenBelt's base host (email sign-in, as on a
public host). Start building there makes a workspace of your own, and an agent pointed at it reads
`/auth.md`, adds `http://localhost:1337/mcp`, and signs in by itself, asking which workspace
([MCP](./mcp.md#one-address-for-every-workspace)). The code it mails is in `bun run drive logs`.

## 3. Ask for an app

> Build and deploy a standup app where the team posts what they did and whether they're blocked,
> with new posts showing up live. Then add two example posts.

The agent reads the `docs` tool, calls `deploy_app` with the app's files, and `collection_add` for
the posts. Open the URL `deploy_app` returned, `https://standup--acme.<your domain>:8445/`: the page lists the posts, and a post added
by an agent or another tab shows up without a reload. A redeploy reloads the open page.

## 4. When something's off

Every tool result and HTTP response carries a trace id. `app_logs` with that `trace` shows what
the call did; see [Debugging](./debugging.md).
