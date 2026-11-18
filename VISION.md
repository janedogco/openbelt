# OpenBelt vision

The open-source app store for you and your agents. Your agents build small apps, OpenBelt hosts
them, and your company uses them. Shopify's Quick, for every company.

OpenBelt is a hosted platform first: many companies (workspaces), each with up to tens of thousands of
small apps. An app is a folder of static files plus a shared SDK for data and realtime, deployed
with no build step and live in milliseconds. Most of what's built on it is built by agents, so
agents are first-class users: they connect over MCP, the tools are the API, and every error says
what to do next.

## Principles

- **Quick-style first.** An app is HTML, CSS and JavaScript calling one shared SDK. No build, no
  npm, no server per app. What an app needs that it can't do this way becomes a platform feature,
  not an app's own backend.
- **One workspace, one place.** A workspace's apps live side by side, each on its own host
  (`<app>--<workspace>.<domain>`, so the browser keeps them apart), and can use each other's data on
  purpose. Workspaces never see each other: separate hosts, separate tokens,
  separate Durable Objects.
- **An app is one Durable Object.** Its files, versions, data, realtime and log live together, so
  an app scales by itself and costs almost nothing while nobody uses it.
- **Deploys are instant and safe.** Content-addressed files, one switch to go live, the old
  version untouched when anything is refused.
- **Debuggable by default.** Every request and tool call has a trace id, and the same id finds
  its lines in the app's log, the platform log and the tool result.
- **Proven, not assumed.** Behavior is shown by driving a real instance, and by agents building
  real apps from the tools alone.

## Words

The shared place containing apps, people, data and connections is a "workspace", in the UI,
docs, APIs and code. A company can have more than one workspace.

What people build is an "app", in every place people and agents read: marketing, the home page,
docs, tool descriptions, errors, and every name in code (`deploy_app`, `AppDO`, `/a/<app>/`).

## Not building

- npm or a build step for apps.
- A public marketplace. A workspace's app store is its own apps, never other workspaces'.
- Per-app backends as the default. Server functions come later as an opt-in, not the shape of an app.
- Approvals (a call that pauses until a human says yes). Not a focus for the short term: they're
  annoying, so connection access stays `none`, `read` or `all`.

## Later, in order

- Sign-in for people (Better Auth, OIDC single sign-on such as Okta; today Okta works as Tailscale's identity provider, with SCIM syncing people and groups), and access rules per app.
- Server functions: built as `functions/<name>.js` in sandboxed VMs over the app's documents,
  each run all or nothing, with network access, secrets, the workspace's connections, schedules,
  webhooks and data triggers ([Functions](docs/functions.md)); next, their own SQLite per app.
- Files and uploads, screenshots for the workspace's gallery, AI in the SDK (metered per workspace).
- Private apps on their own origin, custom domains per workspace.

A guardrail, not a law: strong, repeated demand can change it.
