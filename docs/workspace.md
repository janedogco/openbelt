---
title: Manage a workspace
description: Manage people, groups, connections, access, tokens, app consent and signed-in agents, and make another workspace, through MCP or the openbelt CLI, without opening Settings.
---

# Manage a workspace

Use the same MCP connection or CLI sign-in you use for apps. `whoami` gives your workspace,
role and groups. Search and CLI help show only the operations your role may use. Admins can
manage the workspace; everyone can manage their own connection settings, tokens and app consent.
After a role change, search again or reconnect. Every call checks your current permissions.

## Find operations

`search({ query: "effective access" })` gives the operations that match, each with its input
schema; `search({ query: "" })` lists every operation you may use. Run one with
`call({ tool: "connection_access_explain", args: { ... } })`. The operations this page names are
all run that way.

```sh
openbelt help
openbelt search effective access
```

## People and groups

Admins use `people_list`, `people_invite`, `people_remove` and `people_role_set`.
`workspace_join_requests` lists people waiting to join; invite a requester to admit them.
`group_create`, `group_member_add`, `group_member_remove`, `group_list` and `group_delete`
manage groups. Directory-synced memberships change in the directory.

```sh
openbelt people invite ada@example.com
openbelt group create support
openbelt group add support ada@example.com
openbelt workspace joining invite
openbelt workspace rename acme-labs
```

The last admin cannot be removed or demoted. See [People and groups](./people.md) for joining,
offboarding, renaming and directory sync.

## Apps that embed other apps

No app can show another in a frame (`frame-ancestors`, [Viewers](./viewers.md)), so no app can lay
another under a fake button. An app builder needs exactly that: its page shows the app it builds,
live or in a preview environment, beside its chat. `workspace_embed_set` names the apps that may
(at most 10; admin only); every other app stays unframeable. `[]` names none again, the default.
Every server picks a change up within 5 seconds.

```sh
openbelt workspace embed builder
```

## Make another workspace

`workspace_create` makes a new workspace, for example one for a client or a side project.
It works where people sign in with an email code; anyone signed in can use it, not only admins.
You become the new workspace's first admin, and it starts invite-only.
Your current connection stays on this workspace. The answer contains `workspace_url`, `mcp_url`
and a `token` that acts as you there. The token is shown once and doesn't expire; store it as a credential
and send it as `Authorization: Bearer <token>` to `mcp_url`: add it as an MCP server, or, if
your client can't add one mid-task, POST JSON-RPC to it. Send `initialize` first, then send the
`mcp-session-id` header from its answer with each `tools/call`. The answer's `next` has both
bodies. Then invite people and build apps there. The new workspace also appears in the list of workspaces you see when
you sign in.

A name is lowercase letters, digits and single dashes ("Studio Lab" becomes `studio-lab`).
A name another workspace has, or used to have, is refused: pick another. A trial must be claimed first.
One person can make 5 workspaces an hour.

```sh
openbelt workspace create studio-lab
```

## Connections and access

Search with `connections` before adding a service. Admins use `connection_add` for a catalog
provider, `connection_mcp_add` for a custom MCP server, or `connection_api_add` for OpenAPI or
GraphQL. `connection_admin_info` shows configuration and credential status, without secrets.

```sh
openbelt connection add github
openbelt connection info github --workspace
openbelt connection access github --workspace --who group:support --level read
openbelt connection access github --level read
```

Personal settings are the default: `connection_preferences_set` restricts your own access;
`connection_tool_preferences_set` turns a tool on or off for you. Workspace policy sets the
ceiling. `connection_access_set` and `connection_tool_policy_set` change that ceiling for the
workspace and require an admin. Workspace access changes require an explicit `who` target:
`person:<email>`, `group:<name>` or `everyone`. The CLI selects these separate tools with `--workspace`.
An unavailable workspace operation is refused; it never falls back to changing personal settings.

For more access, use `connection_access_request` with the connection, desired level and a note.
Admins review with `connection_access_requests`, then grant or close requests with
`connection_access_request_grant` or `connection_access_request_close`.
`connection_access_explain` explains a person's effective access to a tool;
`workspace_activity` shows recent calls and refusals. Pending requests include person-specific
`nextActions`; use only the actions authorized by the task. A group suggestion appears only when
it changes no non-requester's access. Permission explanations name the required `read` or `all`
level for the actual tool; use the named person rather than widening everyone's access.

`connection_connect` starts your connection's OAuth sign-in and returns a link for the person
to open. Admins use `connection_workspace_connect` for a shared account. Read the connection
again to check completion. Provider authorization can require the person; changing OpenBelt's
settings does not require dashboard clicks. Supply pasted credentials through secure input,
or pipe them into `openbelt connection token <connection>`; add `--workspace` for a shared token.

See [Connections](./connections.md) for credential ownership and how access levels combine.

## Tokens, consent and agent sign-outs

`token_create` makes an API token as you, returned once with the MCP address that accepts it: this
workspace's own `/mcp`, never the base host's one MCP address. Store both as a credential.
`token_list` returns ids and expiry, never token values; `token_revoke` revokes one of yours.
Admins can list and revoke workspace tokens with `workspace_token_list` and
`workspace_token_revoke`, mapped to `openbelt token list --workspace` and
`openbelt token revoke <id> --workspace`.

`connection_consent_list` lists apps you allowed and pending app requests.
`connection_consent_grant` allows an app to use your connection for an explicit list of tools;
`connection_consent_revoke` takes it back. An admin grants their own consent, never another
person's. `connection_consent_dismiss` dismisses a pending app request without granting it.

`agent_signins` lists agents signed in as you with OAuth. `agent_signout` revokes a grant,
including its access and refresh tokens. These are separate from API tokens.

### Limiting an agent to some apps

A sign-in or token can use every app its person can (what a new one gets), or only the apps you
pick. Limited, the agent can't see, open, make or change any other app: `app_list`, `search` and
`execute` show only its apps, a tool naming another app is refused with what to tell you, and
`check_app`'s browser is refused on every other app. An app it deploys reads only its apps too:
its pages' `db.app("<other>")` is refused (403) for everyone who opens it, until someone with every
app deploys it again. A limited agent is never a
workspace admin, can't make a workspace, and can't change any agent's access; `token_create` from
it makes a token with at most its own apps.

Pick them in Settings, Agents: Apps on each sign-in or token. Or with tools: `token_create` takes
`apps`, and `token_apps_set` and `agent_apps_set` change a token's or sign-in's apps (`apps: null`
for every app again); `token_list` and `agent_signins` say each one's. An agent that signs in again
keeps the apps its last sign-in had. Connections aren't limited by it: a limited agent uses your
connections as before.

```sh
openbelt token create --label laptop --days 30
openbelt token list
openbelt token revoke <id>
openbelt connection consent list
openbelt agent list
openbelt agent signout <id>
```

Admins use `scim_status`, `scim_token_create` and `scim_token_revoke` for directory sync.
The platform operator's credential is separate and is never needed for workspace management.
