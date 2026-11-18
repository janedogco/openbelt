---
title: Trying OpenBelt by hand
description: For people working on OpenBelt, bun run seed fills a running OpenBelt with people, groups, connections, apps, tokens and activity; bun run qa <state> puts you in each state its pages have (fresh, needs-consent, connected, contractor, admin, asks-again, invited-only-workspace, reset).
---

# Trying OpenBelt by hand

To see OpenBelt's pages in every state they have, seed a running OpenBelt once, then switch yourself
between states. Both work on `bun run dev` with no flags, and on any launched instance with
`--run <dir>`.

```sh
bun run dev            # in one terminal (a server: leave it running)
bun run seed           # people, groups, connections, apps, tokens, consents, activity (a few seconds)
bun run qa             # the states, one line each; * marks yours
bun run qa connected   # puts you in one, and prints what to open
bun run qa reset       # back to the seeded default (the same as bun run seed)
bun run seed stop      # stops the fake GitHub the seed started
```

You are whoever the front door says: on this machine (`http://acme.localhost:<port>`), you, the
person running `bun run dev` (your Tailscale login, or `<user>@localhost` without Tailscale); on
the tailnet URL (`https://acme.<domain>:<port>`), your Tailscale login. For the signed-out pages,
open the platform with no door in front, the address `bun run dev` prints as "Signed out" (port +
1000).

You may be Ada, the seeded admin (a run whose door signs everyone in as her): then the seed leaves
her as `reset` says you are, and the states that make you a member refuse. To seed another OpenBelt,
pass `--fakes <origin>` (fake servers already running, instead of starting one) and `--one-workspace`.

## What's seeded

Running it again changes nothing: it makes what's missing and puts back what moved. Data already
there stays, except what the seed owns (its people, groups, connections and apps).

| Who                   | Role and groups                   | What they have                                                     |
| --------------------- | --------------------------------- | ------------------------------------------------------------------ |
| You                   | admin, `eng`                      | your GitHub token, my-prs and pr-digest allowed, 2 more tokens     |
| Ada Lovelace (`ada@`) | admin                             | the seed works as her (a token for the run, revoked after it)      |
| Alice Chen (`alice@`) | member, `eng`                     | GitHub token, my-prs and pr-digest allowed; owns my-prs            |
| Bob Okafor (`bob@`)   | member, `eng`, GitHub `all` (his) | GitHub token, my-prs allowed, tokens "CI deploys" and "Old laptop" |
| Carol Diaz (`carol@`) | member, `contractors`             | GitHub token, but GitHub is `none` for contractors                 |
| Dave Kim (`dave@`)    | member                            | invited, never signed in                                           |
| Erin Walsh (`erin@`)  | member                            | removed                                                            |

All `@acme.test`. Connections:

- **github** (`person`): a fake GitHub (`scripts/verify/drive/dummy-mcp.ts --github`, or the
  `--fakes` ones) the seed starts in the background and keeps running; its pid is in the seed's folder
  (`.dev/seed/` for `bun run dev`, `<run>/seed/` for `--run`). Each
  person's token is `tok-gh-<login>`, and it answers with made-up pull requests. Everyone `read`,
  `contractors` `none`, Bob `all`; `merge_pull_request` disabled.
- **deepwiki** (`none`): the real DeepWiki. Everyone `read`, `eng` `all`; `ask_wiki_question`
  marked read.
- **linear** (`workspace`): the fake answering 401, as a server does once its token expired, so its
  refresh fails and Settings says it isn't working.

Groups: `eng`, `contractors`, and `support` with nobody in it (a group's page as it starts).
The workspace at scale (`scripts/seed/scale.ts`): 32 more people in `design`, `data`, `sales`,
`success` and `finance`, 19 more connections (made-up servers from `scripts/seed/catalog.ts`,
served by the fake GitHub at `/catalog/<name>/mcp`), what some chose for themselves (Carol read
only on Notion, Eli with Google Calendar's create_event off), 31 asks for more (Vercel, Snowflake,
Sentry, GitHub...), agents' calls that ran and were refused, and answers Ada keeps.

Directory sync (People): one SCIM token, Okta, that checked the connection, looked up Alice, Bob
and Carol, and was refused once (a userName that isn't an email). Its secret is kept in the seed's
folder, so a second seed sends nothing again; any other SCIM token is revoked.

Apps, each with an owner, and a picture once the gallery takes one: my-prs (your pull
requests, GitHub as the viewer, DeepWiki as the workspace; also in the preview environment
`redesign`), pr-digest, repo-qa (DeepWiki as the workspace), ship-it (binds the disabled
`merge_pull_request`, so its deploy warns), lunch, oncall, handbook, okrs. Events gets agents'
and pages' calls that ran and that were refused. A second workspace, globex, is invite-only and has
Ada but not you.

## The states

Each moves only you (your role, groups, GitHub token, consents and the seed's tokens of yours)
and keeps the token you have. `reset` also puts back everything else.

| State                    | You are                                                 | Look at                                                                                                                                               |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset`                  | admin in `eng`, GitHub connected, apps allowed          | the gallery and its person menu; my-prs lists your pull requests                                                                                      |
| `fresh`                  | member in no group, no GitHub token, nothing allowed    | my-prs: Connect GitHub and OpenBelt's sheet; Settings, Agents with one token                                                                          |
| `needs-consent`          | member in `eng` with your token, my-prs not allowed     | my-prs's sheet; Connections with `?connect=github&app=my-prs`: Allow                                                                                  |
| `connected`              | member in `eng`, token set, my-prs allowed              | my-prs lists your pull requests; Connections lists it under apps you allowed                                                                          |
| `contractor`             | member in `contractors` (GitHub `none`)                 | my-prs: GitHub is off for you, naming the admins                                                                                                      |
| `admin`                  | admin (only you change)                                 | Settings, People and Groups (support is empty); Events: filter calls by person, tool and result; GitHub's Who has access; Linear not working; ship-it |
| `asks-again`             | you allowed pr-digest, then a deploy bound another tool | pr-digest asks again, for `get_me` too                                                                                                                |
| `invited-only-workspace` | not invited to globex (acme stays as it was)            | `https://globex.<domain>:<port>/`: not a member, ask Ada                                                                                              |

`bun run qa <state>` prints each page's URL.

## Screenshots of any page

Agents can't open a browser by hand, so one command gives them a page in a state:

```sh
bun run shot /_settings/people --as admin                 # dark and light, desktop and phone; prints the PNGs
bun run shot / --step "click #you-button" --size phone    # after a click (repeat --step, in order)
bun run shot / --host app:my-prs --as fresh               # an app's host: OpenBelt's sheet over my-prs
bun run shot /_signin --host signed-out --launch          # on a fresh seeded platform of its own
bun run shot --scene consent                              # one of the design council's scenes
```

It shoots `bun run dev` (seeded) unless given `--run <dir>` or `--launch`, puts you back in `reset`
after `--as`, and writes to `.verify/shots/<page>/<theme>.<size>.png`. `bun run design:shots <label>`
shoots every scene the design council scores (`--list` names them); see `brand/COUNCIL.md`.

The gallery's newest app is large under Just updated (four apps or more, sorted by Recently updated, not
searching), then the rest, two per row on a phone. Each card is the app's picture in a panel tinted with its
colour, cut off at the bottom, and under it the app's name, description (two lines at most), owner and
last-updated time (for example, `2h`). Apps without a live version show Not live; apps awaiting their
directory entry show Not published.
When checking the gallery, compare the compact OpenBelt wordmark in the desktop sidebar and
phone drawer. The phone header shows only the menu button. Its drawer has rounded corners without a border,
with a 50% dark backdrop; tapping the backdrop closes it. The tile is 16px and the wordmark capitals
are 12px. Sign-in and consent pages use the larger 32px icon and 24px wordmark, with 32px below the logo.

## How it works

Everything goes through the doors the product has, so what you see is what people get:

- The platform admin's `/_admin/tokens` and `/_admin/workspace-admins` (with `OPENBELT_ADMIN_TOKEN`),
  which name Ada an admin and mint her a token for the run.
- A workspace admin's `/_workspace` routes, as Ada: people, groups, roles, connections, levels, tools.
- Each person's own settings pages and `/_me` routes: tokens, consents, API tokens. The front
  door's headers say who is viewing; a local OpenBelt takes them as sent on 127.0.0.1, which is why
  the seed sends them to the platform's own address, not through the front door (where every
  request is you).
- MCP for deploys (as each app's owner) and agents' calls.

`bun run dev` writes `.dev/dev.json` (where you open it, its own address
`http://127.0.0.1:<port>`, your token and the platform admin's) for the seed to read. For another
OpenBelt, pass `--url <workspace url as you open it> --token <yours> --admin-token <OPENBELT_ADMIN_TOKEN>`,
and, behind a front door, `--via http://127.0.0.1:<port>`: the seed sends people's requests there
with the URL's host, as the front door would.

If a state ever leaves you unable to do something, `bun run qa reset` makes you an admin again
with the platform admin's token. `bun run verify qa` proves all of this on a fresh platform:
seeding twice ends the same, each state shows what the table says, and a browser shows my-prs in
them.
