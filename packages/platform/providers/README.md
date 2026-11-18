# Providers

OpenBelt's catalog of MCP servers and APIs: a folder per service (its family), a JSON file per
server or API in it, bundled with the Worker through `index.ts`:

```
providers/
  google/family.json   what Google's entries share: one Google OAuth app, its quirks
  google/gmail.json    google-gmail, with what's its own (name, about, url, scopes)
  google/sheets-api.json  google-sheets-api: an API people sign in to (an "api" block, oauth)
  linear/mcp.json      linear: a family's one entry, or its MCP server, has the family's name
  pokeapi/rest.json    pokeapi: an API (an "api" block, below)
```

An entry is its `family.json` with its own file over it (its own key wins). An admin adds one by
its id (`bun run workspace connections add linear`, or Add a connection in Settings' Connections) and
gets its defaults. `src/providers.ts` decodes them;
[docs/connections.md](../../../docs/connections.md#from-the-catalog) says what admins see. Hundreds
of entries cost the Worker little: 500 entries bundle to about 600 KB and load in 10 to 16 ms.

## Add one

1. Write `<family>/<entry>.json` (below), and a `family.json` beside it for what its family's
   entries share. Start from a file with the same sign-in (`linear/mcp.json` for OAuth with dynamic
   registration, `github/mcp.json` for an OAuth app an admin registers, `deepwiki/mcp.json` for
   none, `pokeapi/rest.json` for an API).
2. `bun run providers index`: writes `index.ts` from the folder (never edited by hand).
3. `bun run providers probe <id>`: asks the live server, with no account, how it signs in (with
   OpenBelt's own discovery), and prints what doesn't match the file. Fix those, then
   `bun run providers probe <id> --write` sets `probed` to today.
4. `bun run check`: the guard holds every file to the rules below and says the fix.

## The format

| key             | required     | what                                                                                                                                                                                     |
| --------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | yes          | its family's name (a family's one entry, or its MCP server) or `<family>-<entry>`; the connection's name when the admin gives none (`a-z`, digits, `-`, up to 30)                        |
| `name`          | yes          | as its maker writes it: `GitHub`, `monday.com`                                                                                                                                           |
| `maker`         | no           | whose account people sign in with, when it isn't `name`: `Google` for Gmail                                                                                                              |
| `about`         | yes          | what it holds, a few words: `Issues, projects and cycles`                                                                                                                                |
| `url`           | yes          | the MCP endpoint, https on a public host; an API's base URL, or its GraphQL endpoint                                                                                                     |
| `api`           | none: an API | an HTTP API or GraphQL endpoint, not an MCP server (below); with `signIn` `none`, or `oauth` (people sign in, at `issuer` unless the API's own metadata says otherwise)                  |
| `docs`          | yes          | the maker's page about its MCP server                                                                                                                                                    |
| `signIn`        | yes          | `none` (no account), `oauth` (people sign in) or `token` (people paste one)                                                                                                              |
| `credential`    | oauth, token | whose account by default: `person` (each their own), `workspace` (one for everyone) or `both`                                                                                            |
| `tokenAt`       | token        | where someone makes the token to paste: the provider's page for personal tokens                                                                                                          |
| `level`         | yes          | what everyone can do by default: `read` or `all`                                                                                                                                         |
| `readOnlyTools` | no           | exact tool names to mark read when the server doesn't mark them `readOnlyHint` (DeepWiki)                                                                                                |
| `issuer`        | oauth        | its authorization server's issuer, as its metadata says                                                                                                                                  |
| `registration`  | oauth        | `{"kind": "dcr"}` (OpenBelt registers itself), `{"kind": "cimd"}` (client metadata document only), or `{"kind": "admin", "registerAt": "<url>"}` (an admin registers an OAuth app there) |
| `scopes`        | oauth        | what a sign-in asks for by default: read-only where the server offers that; `[]` asks for what its challenge names                                                                       |
| `quirks`        | no           | what its sign-in server needs beyond the standard (below)                                                                                                                                |
| `measured`      | no           | what a real sign-in showed, on a day (below)                                                                                                                                             |
| `probed`        | yes          | the last day `bun run providers probe` found the file matches the server                                                                                                                 |
| `note`          | no           | one thing an admin should know first, shown on its Add page (240 characters)                                                                                                             |

`quirks` (each has a default): `authorize` (extra authorize parameters, `{}`), `sendResource` (RFC
8707's `resource`, `true`), `scopeOnRefresh` (the granted scope sent on a refresh, `true`),
`clientAuth` (`client_secret_basic` or `client_secret_post`, when the metadata doesn't say),
`revokeEndsAllGrants` (revoking one token ends every grant to the app, `false`). Servers that share
an `issuer` share their quirks: `quirksFor({ issuer, url })` in `src/providers.ts` finds them by
the connection's URL, then its issuer, for the OAuth engine.

`measured`: `on` (the day), `accessTokenSeconds`, `refreshRotates` (a refresh gives a new refresh
token; also what `quirksFor` says as `refreshRotates`), `refreshTokenSeconds`, `replay`
(`refused-grant-kept` or `refused-grant-ended`: what a spent refresh token sent again gets),
`note`.

`api`: `kind` (`openapi` or `graphql`), `spec` (the OpenAPI spec's https URL, JSON or YAML, or a
Google Discovery document's; none for GraphQL), `groups` (the tags a workspace gets when the admin
picks none; GraphQL's are `query` and `mutation`, a Discovery document's its methods' scopes
without Google's prefix, like `gmail.send`; left out: all), `fixes` (below), and, for `signIn:
none`, `test`: `{"tool", "input", "expect"}`, a read call and text its answer has. Adding the entry makes the test call and says how it went; `bun run
providers probe` makes it too, reads the spec with its groups, and says which fix names a tool the
spec no longer has.

`fixes`, in order, after every read of the spec, so they outlive its changes:
`{"tool": "get_info_0_json", "rename": "latest_comic"}`, `{"tool": "logoutUser", "readOnly": false}`
(a GET that changes things), `{"tool": "addPet", "require": ["body.id", "body.name"]}` (what its
server needs that its spec doesn't say), `{"tool": "admin_purge", "hide": true}`.

## The guard's rules

Every entry decodes with no unknown key, `index.ts` is what `bun run providers index` writes, each
entry's `id` is its family's name or `<family>-<entry>`; every URL (an API's `spec` too) is https to
a public host (a test server goes in a check,
added by URL with `"provider"` for the defaults: `scripts/verify/checks/catalog.ts`); no two files share a `url`; a
file whose `level` is `read` asks for no scope that changes things (`write`, `manage`, `delete`,
`repo`, a Google scope that isn't `.readonly`, ...); files that share an `issuer` share quirks.
