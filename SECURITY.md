# Security

## Report vulnerabilities privately

Use GitHub's private vulnerability reporting (the repository's Security tab, **Report a
vulnerability**), or email **hello@openbelt.com**. Include the affected commit,
deployment settings, reproduction steps and expected versus observed behavior.
Use a disposable local instance and synthetic data for the reproduction.
Do not post credentials or exploit details in an issue, PR, screenshot or public log.

Contributions and pull requests are not currently accepted. Security reports are welcome
through the private contact above.

## Deploy with authentication

Compose binds OpenBelt's port to `127.0.0.1` and defaults to proxy authentication
(`OPENBELT_SIGNIN=tailscale`). For shared access, configure a trusted identity proxy or
HTTPS with email sign-in. Keep the platform's raw port behind that boundary.
`OPENBELT_SIGNIN=off` permits anonymous app access, including writes; use it only for an
explicitly isolated sandbox. An admin token does not authenticate people using apps.

Workspaces are the tenant boundary. Apps within a workspace can intentionally share data. App functions
and browser checks run untrusted code; the sandbox and egress restrictions are part of that
boundary. See [Architecture](docs/architecture.md), [Viewers](docs/viewers.md) and
[Running](docs/running.md) before changing deployment settings.

## Keep credentials out of evidence

Keep `.env`, private keys, data directories, backups and raw `.verify/` evidence private.
Rotate credentials that were shared, even after deleting the file or Git commit containing them.
`bun run secrets` scans HEAD, origin history, tags and non-ignored working files. It excludes
local-only checkpoint refs, which must not be pushed as a mirror of this checkout.
The pre-commit hook also scans staged changes.

Verification artifacts contain only check names and pass/fail values. Their raw logs,
screenshots, database files, tokens and result details remain on the runner. Reproduce
failures locally to inspect that evidence. Image builds also upload Docker build records;
review those records and workflow logs before making the repository public.

## Dependency audit limitation

`@google/design.md@0.4.0` embeds Zod 3.25.76 in its design-lint CLI. The registry reports
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) for that version.
The latest design-lint release has no compatible update that removes it. It checks the
repository's `brand/DESIGN.md` during development; it is not a platform production dependency.
Do not use this CLI on untrusted documents. Updating a separate Zod dependency does not
replace the bundled code. Remove this note when an upstream update fixes it.
