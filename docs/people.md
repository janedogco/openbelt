---
title: People and groups
description: Who is in a workspace (people, roles, groups), how people join (open or invite-only), workspace admins, API tokens per person, removing someone, renaming the workspace, and bun run workspace.
---

# People and groups

Agents manage this through MCP and the installed `openbelt` CLI too:
[Manage a workspace](./workspace.md). Admin tools appear only for workspace admins.

A workspace's people are everyone who has used it: each has a permanent id (`p_3f9c0a1b2c3d4e5f`), an
email, a name, a role (`admin` or `member`) and a status (`invited`, `active` or `removed`).
OpenBelt still doesn't sign anyone in itself: the front door (Tailscale) says who
a page's viewer is, and an API token says who an agent is. People are what the workspace knows about
them.

- Emails are lowercased: `Dave@acme.com` and `dave@acme.com` are one person.
- A person's name comes from the front door on each visit (the email's first part when it gives
  none).
- A document's `author` is still the email, so the data apps read doesn't change.

## Who can do what

| Who                                         | Can                                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A member                                    | Open the workspace's apps; see who they are (`whoami`); make, list and revoke their own tokens; set their own connection tokens                                                                                        |
| A workspace admin                           | All of that, and invite and remove people, set roles, set joining, make groups, list and revoke anyone's tokens, manage [connections](./connections.md), rename the workspace, in Settings or with `bun run workspace` |
| The platform admin (`OPENBELT_ADMIN_TOKEN`) | Make a token for any email (`/_admin/tokens`) and name a workspace's admins (`/_admin/workspace-admins`)                                                                                                               |

A workspace has no admins until the platform admin names one. `bun run dev` and the instances
`bun run verify` launches make their user the admin of `acme`. A workspace's last admin can't be made a
member or removed: make someone else an admin first.

## Joining: open or invite-only

- `open` (the default): anyone the front door lets in, or who signs in with an email code
  ([email sign-in](./viewers.md#email-sign-in)), becomes a member on their first visit.
- `invite`: only people an admin invited. Anyone else gets a 403 page saying they aren't a member
  of the workspace and which admins to ask, with a button that emails them; the SDK's requests get
  `{"code": "not_member"}`. A signed-out
  visitor is refused too, since nobody can say they were invited.

Both apply on the workspace host and on every app's host, to pages and data alike. Under both, a
removed person is refused. `check_app`'s browser gets in either way, signed out or as its test
people: it carries a session cookie OpenBelt seals for that check (`__Host-openbelt_session`, one per
host it opens, good there alone for 15 minutes, unreadable by the page).

A workspace made on the base host ([One address for every workspace](./mcp.md#one-address-for-every-workspace))
starts invite-only, with whoever made it as its only admin. Someone at the same work domain (their
email's, unless it's personal mail like gmail.com) who signs in there sees it under Other workspaces, marked **Ask**:
asking lets nobody in. The workspace's admins see the ask on People (Asked to join, with Invite) and as a
line on the home page, until someone invites them; an agent waiting on that sign-in is sent back
with `access_denied` naming the admins who must invite them.

## Removing someone

`people remove` does it all at once, in about as long as the request takes (a few ms on a
launched platform):

- Their tokens are revoked and the agents they signed in with OAuth are signed out: their agent's
  next MCP call is a 401 saying why.
- Their page requests are refused, with a page saying who removed them and when.
- Their open pages' sockets are closed (code 4403): the SDK reloads the page, which then says why.
  Only the apps they've opened are asked, so this stays quick in a workspace with many apps.
- They leave their groups.
- Their own tokens for the workspace's [connections](./connections.md) are deleted.

Invite them again (`people invite`) to undo it; their old tokens stay revoked.

## Renaming the workspace

An admin renames the workspace on the People page in Settings (Workspace name), or with
`bun run workspace rename acme-labs`. The workspace's host becomes `acme-labs.<domain>` and its apps'
`<app>--acme-labs.<domain>`. Nothing moves: a workspace keeps the id it was made with, and its people,
apps, data, tokens and connections are keyed by that.

- Its old names keep reaching it, for good. A page opened on an old host (the workspace's or an app's)
  answers `308` to the same path on the new one. Everything else is answered there as the same
  workspace: an agent's `/mcp` and its OAuth sign-in, an app's data, sockets, functions and webhooks, a
  connection's sign-in coming back from its provider. Agents and the CLI need no change.
- Tool results and pages show the new addresses from then on.
- Nobody else can take any name the workspace has had, or the default workspace's (`OPENBELT_DEFAULT_WORKSPACE`), even
  before anyone has visited it. Renaming it to one of its own old names works.
- A workspace holds at most 10 names, its first one included. Past that, rename it to one of its old
  names.
- A trial workspace can't be renamed until someone claims it.
- Someone signed in with an email (`OPENBELT_SIGNIN=email`) signs in again on the new host:
  browsers keep sign-ins per host. Under the front door (Tailscale) there's nothing to do.
- With several platform processes (`OPENBELT_PROCESSES`), the others learn of a rename within 2 s;
  until then an old host may answer a page without moving it.
- An app's own record of its address (its `SKILL.md`, its messages about secrets) changes at its
  next deploy; the old address it gives still works.

Renaming to the name the workspace has changes nothing and says so (`"renamed": false`). A name another
workspace has or had, the default workspace's, or an 11th name is a `409`; an unclaimed trial is a `403`.

## Groups

A group is a named list of people, made by an admin: 1-40 lowercase letters, digits and dashes
(`support`). Its `source` is `openbelt`; groups synced from a directory ([SCIM](#directory-sync-scim))
say `scim` and can't be changed here. `whoami` shows a person's groups.

## In Settings

Admins manage all of this in a browser too, under Workspace in Settings (`<workspace host>/_settings`):

- **People** (`/_settings/people`): everyone, with their groups. Invite someone (email and role).
  Open a person for their role, their exceptions (a level on one connection that beats their
  groups), and removing them, which asks first. Who can join (open or invite-only) and the workspace's
  name are at the foot.
- **Groups** (`/_settings/groups`): each group, what it can use in a line, and how many people
  are in it. Make one here.
- **A group's page** (`/_settings/groups/<name>`): its members first (add, take out), then what
  it can use, one level per connection. Under a connection, one line names the members who get
  something else and why ("Cy and Milo get all tools, via eng"); nothing when everyone gets the
  setting. Deleting the group is at the foot. A group synced from a directory shows its members
  locked; its levels are still yours to set.

Each change is the `/_workspace` route of its name, run as you, so it does exactly what `bun run workspace`
does and is refused the same way (a bad name, the last admin). The page says what changed and
whose level moved: "GitHub for contractors: can't use it. That changes carol@acme.com on GitHub
read → none." Deleting a group deletes its levels too, so a new group of the same name starts
with none. Members get a 403 naming the admins.

## Directory sync (SCIM)

Okta, Microsoft Entra or any SCIM 2.0 directory can add and remove a workspace's people and sync its
groups, at `<workspace host>/scim/v2`. What it buys: **offboarding that doesn't wait for anyone to log
in.** Deactivate someone in the directory and, in the time of the request, their API tokens are
revoked, their agents' OAuth sign-ins are signed out (the refresh token too), their pages close and
they leave their groups. Without it, OpenBelt only learns someone left when they next try to sign in,
and an agent's sign-in lasts 30 days unused.

Sign-in is a different thing and stays with the front door. For Okta, that is Tailscale with
Okta as its identity provider ([Who is viewing](./viewers.md)). SCIM and the front door meet at the email: a SCIM user's
`userName` is the email the front door will say.

Set it up:

1. As a workspace admin, People > Directory sync > Make a token (or `bun run workspace scim token --label okta`).
   It's shown once, with the base URL.
2. In the directory: a SCIM 2.0 app with base URL `https://<workspace host>/scim/v2`, authentication
   HTTP Header or OAuth bearer token, the token you made. Set the application username to the
   email (Okta: Email). Turn on push for new users, profile updates and deactivation; turn on
   group push for the groups you want here.
3. `/scim/v2` is open to the directory's servers: the SCIM token is the credential there.

What it does:

- **Users.** A SCIM user is a person. `userName` must be an email; they're created as a member,
  `invited` until they first open the workspace (so in an invite-only workspace the directory is who may join).
  `active: false` removes them as `people remove` does, and the user stays findable (a client that
  looks them up gets `active: false`). `active: true` brings back a member the directory itself deactivated, as a member, and their old
  tokens stay revoked; someone an admin removed in OpenBelt stays removed (a 409 that says so), because
  profile updates say `active: true` all the time. `DELETE` is the same as deactivating. `userName` can't change, since everything a
  person wrote is signed with their email: provision the new email as a new user.
- **Roles are OpenBelt's.** SCIM has no role here; the directory never makes an admin. The last admin
  can't be deactivated: the request is a 409 that says to name another admin first.
- **Groups.** A pushed group arrives with its members and says `source: scim`: members and the
  group itself change only from the directory, but you set what it can use
  ([Connections](./connections.md)) as for any group. Its OpenBelt name is the display name as a slug
  (`Support Team` is `support-team`), and that is also its SCIM `id`. A group that can't be an OpenBelt
  name, or collides with one you made in OpenBelt, is a 400 or 409 that says so. Renaming a group in
  the directory is a 400: access levels name it, so make a new one and move the people.
- **Filters and patches.** `userName eq`, `id eq` and `externalId eq` on users, `displayName eq`
  on groups; PATCH as Okta (`{"op": "replace", "value": {"active": false}}`) and Entra
  (`{"op": "Replace", "path": "active", "value": "False"}`) send it; members by `add`, `remove`
  (including `members[value eq "<id>"]`) and `replace`. A group change is all or nothing: one that
  can't be made (an unknown person, members that aren't a list of `{"value": id}`) changes nothing.
  Anything else is a SCIM error that says what to send.

### When a sync fails

Every request is kept (the last 200, bodies cut at 1000 characters) with what it did, its status and
a trace. People shows the last 10 under Last requests from your directory, each in words ("Looked
up Alice Chen", "Couldn't add someone" with the reason), and its request, status and trace under
Technical details; `bun run workspace scim` lists the last 30 and the tokens (when each was last used). The trace is the response's `x-openbelt-trace`, and finds the same
line in the platform log. A request that fails says what to change in `detail`, which is what the
directory's provisioning log shows. A request with no token, a wrong one, or a revoked one is a 401
that says which; those aren't kept (anyone can send them), only logged.

### Trying it without a directory

`bun run drive scim <METHOD> </path> [json] --run <dir>` sends one request as a directory would, with
a token it makes. `scripts/verify/drive/scim.ts` has what Okta and Entra send as functions (assign a
user, deactivate, push a group, add and remove members), and `bun run verify scim` replays them
against a fresh platform in about 5 seconds: provisioning, an invite-only workspace, a user's agent signed
in with OAuth and then deactivated (every credential ends), groups, the last admin, and the debug
trail. Not tried here: a real Okta or Entra tenant, which needs a public URL for `/scim/v2`.

| Route                                                                            | Notes                                                          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET`/`POST /scim/v2/Users`                                                      | `?filter=userName eq "..."`, `startIndex`, `count` (max 200)   |
| `GET`/`PUT`/`PATCH`/`DELETE /scim/v2/Users/<id>`                                 | `<id>` is the person id                                        |
| `GET`/`POST /scim/v2/Groups`                                                     | the directory's groups only (`source: scim`)                   |
| `GET`/`PUT`/`PATCH`/`DELETE /scim/v2/Groups/<id>`                                | `<id>` is the group's name                                     |
| `GET /scim/v2/ServiceProviderConfig`, `/ResourceTypes`                           | what's supported (PATCH and filter yes, bulk and sort no)      |
| `GET /_workspace/scim`, `POST /_workspace/scim/token`, `/_workspace/scim/revoke` | workspace admin: tokens, what the directory sent, make, revoke |

## Tokens

A token belongs to one person in one workspace (see [MCP](./mcp.md#tokens)). Each has an id
(`t_1a2b3c4d5e6f`) to list and revoke it by; the token itself is shown once, when it's made.
Anyone makes and revokes their own in their settings (Agents, `<workspace host>/_settings/agents`),
where the agents they signed in with OAuth are listed too, each with Sign out
([MCP](./mcp.md#signing-in-oauth)).
Their connection tokens and the apps they allowed are on Connections (`<workspace host>/_connections`,
[Connections](./connections.md#your-settings)).

## bun run workspace

The CLI for all of it, against a launched instance (`--run <dir>`, with `--as <email>` for someone
else's token) or a real one (`--url <workspace url> --token <token>`). It never prompts, and prints the
server's message when it's refused.

```sh
bun run workspace whoami --url https://acme.example.com --token $OPENBELT_TOKEN
bun run workspace people list
bun run workspace people invite dave@acme.com --role member
bun run workspace people remove dave@acme.com
bun run workspace people role dave@acme.com admin
bun run workspace joining invite
bun run workspace rename acme-labs            # the workspace's new name; its old ones keep working
bun run workspace groups create support
bun run workspace groups add support dave@acme.com
bun run workspace tokens create --label laptop --days 30
bun run workspace tokens list --workspace            # everyone's, for admins
bun run workspace tokens revoke t_1a2b3c4d5e6f --workspace
bun run workspace admins add ada@acme.com --admin-token $OPENBELT_ADMIN_TOKEN
bun run workspace scim token --label okta     # directory sync: a token for Okta or Entra
bun run workspace scim                        # its tokens, and what the directory last sent
```

## HTTP

Each command is one request with `Authorization: Bearer <token>` and, for POST, a JSON body.
These routes take a token only, on the workspace host (`<workspace>.<domain>`; an app's host answers them
404): a request carrying a cookie, an `Origin` or `Sec-Fetch-Mode` (anything a browser sends) is
a 401, so no app page can use them.

| Route                                                         | Who             | Body                                                           |
| ------------------------------------------------------------- | --------------- | -------------------------------------------------------------- |
| `GET /_me/whoami`                                             | anyone          |                                                                |
| `GET /_me/tokens`                                             | anyone          |                                                                |
| `POST /_me/tokens/create`                                     | anyone          | `{"label": "laptop", "days": 30}`                              |
| `POST /_me/tokens/revoke`                                     | anyone          | `{"id": "t_..."}` (theirs)                                     |
| `GET /_workspace/people`                                      | workspace admin |                                                                |
| `POST /_workspace/people/invite`                              | workspace admin | `{"email": "dave@acme.com", "name": "Dave", "role": "member"}` |
| `POST /_workspace/people/remove`                              | workspace admin | `{"person": "dave@acme.com"}` (or the id)                      |
| `POST /_workspace/people/role`                                | workspace admin | `{"person": "dave@acme.com", "role": "admin"}`                 |
| `GET`/`POST /_workspace/joining`                              | workspace admin | `{"joining": "invite"}`                                        |
| `POST /_workspace/rename`                                     | workspace admin | `{"to": "acme-labs"}`                                          |
| `GET /_workspace/groups`                                      | workspace admin |                                                                |
| `POST /_workspace/groups/create`, `/_workspace/groups/delete` | workspace admin | `{"name": "support"}`                                          |
| `POST /_workspace/groups/add`, `/_workspace/groups/remove`    | workspace admin | `{"group": "support", "person": "dave@acme.com"}`              |
| `GET /_workspace/tokens`                                      | workspace admin |                                                                |
| `POST /_workspace/tokens/revoke`                              | workspace admin | `{"id": "t_..."}`                                              |
| `POST /_admin/workspace-admins`                               | platform admin  | `{"email": "ada@acme.com"}`                                    |

Errors have `error` (what happened and what to do), `code` (`unauthorized`, `not_admin`,
`invalid`, `missing`, `conflict`) and `trace`, which finds the request's line in the platform log.
