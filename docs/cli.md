---
title: CLI
description: The openbelt command: sign in once, set OpenBelt up in your agents, and use the workspace from a terminal or a script.
---

# CLI

`openbelt` is one small binary (about 2 MB, `cli/` in this repo). It does two jobs:

- **Setup.** `openbelt install <workspace url>` signs you in (below; or `--token` with an API
  token from `/_settings/agents`), then adds OpenBelt to the agents it finds on this machine: Claude
  Code, Codex, OpenCode, Cursor, Gemini CLI and pi. Each gets an MCP server entry that starts
  `openbelt mcp`, which passes MCP through with your sign-in, so no agent's config holds a token.
  Run it again to add an agent (`-a codex`); `-y` skips the picker.
- **Using the workspace.** Every other command is one of the workspace's MCP tools, such as
  `openbelt search`, `openbelt app deploy <folder>`, `openbelt fn run <app>.<function> '<input>'`,
  `openbelt data list <app>/<collection>` and `openbelt data update`. `openbelt` alone lists them;
  `openbelt <command> --help` gives a command's flags, from the tool's input schema.

```sh
curl -fsSL https://openbelt.com/install | sh        # the CLI, then openbelt install (it asks for your workspace)
openbelt search expense claims
openbelt fn run expenses.file '{"amount": 42, "what": "lunch"}' --key lunch-1108
openbelt data list expenses/claims --limit 50 | jq '.docs[].data'
openbelt app deploy ./standup
```

## Arguments and output

- Commands and help come from the tools your sign-in may use. Workspace admins get people,
  groups, workspace settings and connection management; members get their own settings and app tools.
  Each invocation reads the current tool list, so a role change applies to the next command.
- Personal connection settings and tokens are the default. `--workspace` selects a separate
  workspace operation where offered, such as `connection access` or `token list`. It requires an
  admin and never falls back to changing your own settings. Commands only admins use, such as
  `people invite` and `connection add`, need no scope flag.
- Words in a command line are the tool's arguments: `<app>/<collection>` and `<app>.<function>`
  are two in one word. Everything else is a `--flag`, named as in the tool's input schema.
- A value is text, a number, or JSON (`'{"a": 1}'`, `@file.json`, or `-` for stdin). A JSON array
  to `data add` adds several documents; to `data update`, an array of `{ "id", "data" }` changes
  them all in one call (up to 500, all or none), as a word or on stdin.
- `data list --all` follows the cursor and prints every document as one list, so a whole
  collection goes through `jq` and back:
  `openbelt data list shop/orders --all | jq '[.docs[] | select(.data.status == "open") | {id, data: {status: "late"}}]' | openbelt data update shop/orders`.
- In a terminal, results print as YAML-like text; piped (or with `--json`), as JSON.
- A result with an image (a check's screenshot, an app's picture) saves it to a file in the
  temp folder and names its path: `screenshot` for `app check --screenshot`, `image` for others.
- Exit codes: 0 done, 1 OpenBelt refused (the message says why and what to run next), 2 a usage
  mistake (it names the flags there are).
- `app deploy <folder>` sends every file in the folder but dotfiles and `node_modules`, as the
  app named after the folder (or `--app`). `app pull <app> [folder]` writes an app's files out.
- A tool with no command of its own is reached with `openbelt call <tool> '<json>'`: `execute`
  ([Code](./code.md)) has none, since a shell already chains commands.

## Getting it, and keeping it current

The platform hands out the CLI it was built with, so it always matches the server, from its own
address (`https://openbelt.com`, `OPENBELT_HOST`) and from each workspace's host:

- `curl -fsSL https://openbelt.com/install | sh` puts `openbelt` in `~/.local/bin`
  (`OPENBELT_INSTALL_DIR` picks another folder), checks it against its sha256, and runs
  `openbelt install`, which signs in to the OpenBelt the script came from without asking (under
  email sign-in, signing in there picks or creates your workspace; from a workspace's host,
  `curl -fsSL https://acme.openbelt.app/install | sh`, it's that workspace). The agents found on
  this machine are listed first, already ticked; `-y` takes them (or only the agent running the
  command) without asking, as an agent's shell needs. With `-y` (or with no terminal), a sign-in
  only starts: `install` prints the code the page shows and ends at once, so the agent running it
  can tell the person that code, then `openbelt login --wait` waits for them and sets up as
  `install` does.
  Arguments after `sh -s --` go on to `openbelt install` (a workspace, `--token`, `-y`, `-a codex`). On
  Windows, download `/_cli/openbelt-x86_64-pc-windows-gnu.exe`.
- `openbelt update` asks the workspace you're signed in to for its build (`/_cli/openbelt-<target>.sha256`)
  and, when it differs from yours, downloads it, checks the sha256, and puts it in place of this
  one. `--check` only says. Once a day another command checks too and says on stderr when there's
  a newer one.
- The image builds the CLI for macOS (Apple silicon and Intel), Linux (x86-64 and arm64, static)
  and Windows (x86-64) in its own stage (the `Dockerfile`), cached apart from the platform: a
  change elsewhere doesn't rebuild it, and a change to `cli/src` rebuilds only the CLI, not its
  dependencies. A checkout serves its own machine's build after `bun run cli:dist`
  (`OPENBELT_CLI_DIR`, default `cli/dist`).

## Signing in

`openbelt login [workspace url]` (and `install`) prints a link and a short code, like `BCDF-GHJK`,
and opens the link in your browser. Check that the page shows the same code, then Continue and
Allow. The link works in any browser, so on a server or over SSH (where no browser opens, nor with
`--no-open`) open it on your laptop or phone, or go to `<workspace>/_oauth/device` and type the code.
The CLI waits up to 10 minutes and saves the sign-in once you allow it. `openbelt install -y`
doesn't wait: it keeps the started sign-in in `pending.json` beside the credentials (yours alone)
until `openbelt login --wait` finishes it. Under the hood this is
OAuth's device sign-in (RFC 8628), described in [MCP](./mcp.md).

## Where it keeps things

The sign-in is `~/.config/openbelt/credentials.json` (or under `$XDG_CONFIG_HOME`), readable by you
alone: an API token, or OAuth tokens it renews by itself. `openbelt logout` signs out and revokes
them; `openbelt status` says which workspace you're in, as whom, and which agents have OpenBelt.

## For OpenBelt's own code

Commands come from each tool's `_meta["openbelt/cli"]` in `packages/platform/src/mcp.ts` (`cli(...)`):
a usage line and a one-line summary. A new tool gets its command there; one with none is reached
with `openbelt call <tool> '<json>'`. The server's hints name MCP calls (`function_runs({ app })`);
the CLI says them as the commands that make them.

The CLI lists every operation as a command (its session says it is `openbelt-cli`); an agent's
`tools/list` gives only `search` and `call` ([MCP](./mcp.md)).
