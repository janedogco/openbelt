# OpenBelt

A platform for small apps: agents build them over MCP, people use them in the browser. An app is a
folder of static files plus a shared SDK (`/sdk.js`) for data and realtime, with no build step.

This repository is a published copy of OpenBelt's source. Issues are welcome; pull requests are not
accepted. Report vulnerabilities privately ([SECURITY.md](SECURITY.md)).

- What it's for and what it won't do: [VISION.md](VISION.md).
- How it's built: [docs/architecture.md](docs/architecture.md). What agents building apps read: `docs/`.
- Domain words: [GLOSSARY.md](GLOSSARY.md). Use them; never use its _Avoid_ words.
- Run it: `docker compose up -d` ([README.md](README.md#self-host)), or `bun install && bun run dev`.
- Check a change: `bun run check` (format, lint, types, repository rules, dead code, secrets).

The repository is public. Keep personal details, hostnames, IP addresses, tokens and real data out of
commits, issues and screenshots.
