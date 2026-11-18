# anti-slop (vendored)

- Source: https://github.com/dmmulroy/anti-slop (MIT)
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10), copied from `skills/install-anti-slop/assets/anti-slop/`
  via `skills/install-anti-slop/scripts/install.mjs` on 2026-10-04
- Installed: `tools/oxlint/anti-slop/` (generic plugin `index.ts`, Effect plugin `effect/index.ts`)
- Dependency: `@oxlint/plugins` pinned to the repo's `oxlint` version (1.86.0)
- Config: `.oxlintrc.json` registers both plugins and enables every rule at `error`, plus the
  native companion `oxc/no-accumulating-spread`. `.oxfmtrc.json` and `.oxlintrc.json` ignore this dir.

## Deviations

- Rule sources are unmodified.
- Upstream `*.test.ts` files are not vendored (openbelt has no unit tests; the install skill's assets
  don't include them either).

## Updating

Install the upstream skill (`npx skills add dmmulroy/anti-slop --skill install-anti-slop`) and
follow its `references/update.md`: it three-way merges upstream changes with local edits. Then
update the commit above and run `bun run check`.
