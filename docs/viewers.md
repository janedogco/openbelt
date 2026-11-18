---
title: Who is viewing
description: How pages know who is viewing (db.me), who says so (Tailscale, or OpenBelt's email sign-in, never the app's own page), what a document's author proves, testing an app as several people, the installed workspace, and allowing notifications one app at a time.
---

# Who is viewing

An app has no sign-in page of its own. Whatever is in front of the workspace says who each viewer is, or
OpenBelt's own sign-in page does (email sign-in, [below](#email-sign-in)), and pages ask the SDK
instead of asking for a name:

```js
const me = await db.me() // { email, name } when someone is signed in, null when not
// a signed-in page's writes: doc.author is their email, doc.authorName their name
```

- The platform sets `author` and `authorName` from the session; a page can't send them (headers
  it sends are dropped). They stay the creator's when someone else updates the document;
  `updatedBy` is who wrote it last. Signed out, both are "anonymous"; over MCP they're the token's
  user.
- Verified: `author`, `authorName` and `db.me()`. Not verified: anything in `data` (a `name` or
  `votedBy` field is whatever the page sent).
- `db.me()` asks once per page load; `db.me({ refresh: true })` asks again.
- Who is in front of the workspace, which `deploy_app`'s `reach` says:
  - On a tailnet ([OpenBelt on your tailnet](./tailnet.md), and `bun run dev`): everyone is signed
    in as their Tailscale login. A tagged device (a server, an exit node) is signed out.
  - On the machine running `bun run dev` (`http://acme.localhost:<port>`): that person, with
    nothing to sign in to. Its signed-out port (`<port> + 1000`) has email sign-in.
  - With email sign-in ([below](#email-sign-in)): whoever signed in with a code sent to their
    email. Someone signed out who opens a page is sent to sign in first, and comes back to it.
  - On a public host with sign-in ([below](#sign-in-on-a-public-host)): everyone signs in with
    the company's identity provider (Okta, Entra ID, Google...) first, and is their email there.
  - Elsewhere (`OPENBELT_SIGNIN=off`): nobody is signed in.
  - In an invite-only workspace ([People and groups](./people.md)), only its members get in, so
    `db.me()` is always one of them; everyone else gets a page saying they aren't a member.
- Use `db.me()` and `author` for names; don't ask people to type one, and don't build a sign-in
  button or form: with email sign-in OpenBelt sends signed-out visitors to its own, and elsewhere
  there's nowhere to send them. Show signed-out viewers the page read-only. Their writes
  still work, as "anonymous", unless [rules](./rules.md) refuse them (`signedIn`).
- To test as several people, use test people (below), never a real person's email.

## Test as several people

In a preview environment, `check_app`'s `people` are made-up teammates: each gets a browser of
their own, already signed in as `<name>@<app>.test` (alice is "Alice"), with the page open before
step 1. A step's `as` says whose browser it runs in (default: the first person). Pages stay open,
so an expect as bob sees what alice just did. `save` keeps a step's result (eval's return value,
or the element's text for expect and wait); later steps use it as `{{name}}` in any of their
strings. To test a group gate, give a test person groups: `people: [{ "name": "ed", "groups":
["editors"] }, "viv"]`; the app's functions see them in `caller.groups`. They can be in only the
groups you're in, unless you own the app and every other app in its preview environment, or are
a workspace admin; apps the environment doesn't hold (another app's live query) see no groups.

<!-- example: polls-people -->

```js
check_app({
  app: "polls",
  preview: "close-rule",
  people: ["alice", "bob", "carol"],
  steps: [
    { as: "alice", action: "fill", selector: "#question", value: "Lunch?" },
    { as: "alice", action: "click", selector: "text=Create poll" },
    {
      as: "alice",
      action: "eval",
      save: "pollId",
      script: "return document.querySelector('.poll').dataset.id",
    },
    { as: "bob", action: "click", selector: ".poll[data-id='{{pollId}}'] .option" },
    { as: "alice", action: "expect", selector: ".poll .votes", text: "1 vote" },
    { as: "carol", action: "expect", selector: "text=Close poll", count: 0 },
    {
      as: "carol",
      action: "eval",
      script:
        "const { db } = await import('/sdk.js'); await db.collection('polls').update('{{pollId}}', { closed: true }).catch(() => {})",
    },
    { as: "carol", action: "expect", status: 403 },
  ],
})
```

- Steps come back labelled with the person:
  `[carol] ok: expect status=403 (PATCH /_db/polls/<id> answered 403 (rules.polls.update))`.
  Had the write gone through: `expected 403 from PATCH /_db/polls/<id>, got 200`. Console lines
  are labelled too. The report has each person's last page in `people` (their text and controls).
- expect with `status` (no selector) looks at the last data request the person's page sent since
  their previous step (its last write, if any); `path: "/_db/polls/{{pollId}}"` narrows it. Or,
  in the eval itself, `assert: "result.status == 403"`: with an assert, a thrown SDK error is
  `result` (message, status, rule) instead of failing the step, and a denial it passes on is
  expected.
- A rule denial is never a failed request: expected ones are in `expectedDenials`, others in
  `denied` (`{ person, method, path, rule }`), so check those were meant.
- A hidden button only proves the page; carol attempting the write (eval calls the SDK as her)
  proves the rule. Expect the 403, not just a missing button.
- Seed data from several people with `as` on `collection_add`, `collection_update` and
  `collection_delete`: `as: "alice"` with `preview` writes as alice@<app>.test. Without `as`, MCP
  writes are the token's user's and bypass rules.
- Test people only work in preview environments: on live, `check_app` and the collection tools
  refuse them, and a page's write as one is a 403.

## More on test people

- Any name of lowercase letters, digits and dashes (up to 30) is a test person. Up to 5 per check;
  `as: "alice"` alone is `people: ["alice"]`, and without `people` they're the ones the steps name.
- `{{name}}` is replaced as is: in a script, quote it (`'{{pollId}}'`). A `{{name}}` no earlier
  step saves is refused before the check starts.
- A test person's session counts only under `/_preview/<env>/` on an app's host (and `/_me?env=<env>`,
  which the SDK asks there). The refusal on live says `test people work in previews: deploy with
preview: "<env>"`.
- `check_app`'s own browser, with no `people`, is always signed out, even on a tailnet where it
  runs on the host.

## Who says so

`OPENBELT_SIGNIN` on the platform:

| Value       | Who is viewing                                                                                                                             | Where                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `tailscale` | The `Tailscale-User-Login` and `Tailscale-User-Name` headers the front door sets (and replaces): from Tailscale, or from the sign-in proxy | `bun run dev`, `bun run tailnet`, verify, `deploy/signin` |
| `email`     | Whoever signed in at `/_signin` with a code sent to their email; and, as under `tailscale`, whoever the front door names                   | `bun run dev`, a public host                              |
| `off`       | Nobody                                                                                                                                     | a server with no front door                               |

Under `tailscale`, only the front door says who is viewing. That's a proxy on the same machine,
which reaches OpenBelt over loopback (`tailscale serve`, `scripts/frontdoor.ts`, verify), or one
elsewhere (another container or machine) that adds `X-OpenBelt-Front-Door: <OPENBELT_FRONT_DOOR_SECRET>`
to every request it forwards. A request from anywhere else names nobody, and a person's pages and
data refuse it (403, saying to come through the front door), whatever the workspace's joining. What
carries its own credentials still answers it: `/mcp` and `/scim/v2` with a token, `/_admin` with
the admin token, webhooks, OAuth clients' token calls, `/_health` and `/_tls/ask`. So the port
being reachable doesn't let anyone be someone. Compose binds the port to `127.0.0.1` by default;
publishing it on another interface requires an explicit `OPENBELT_BIND`.

With `tailscale`, the front door (`scripts/frontdoor.ts`) sets those headers. On the tailnet it
asks Tailscale who each device is. On this machine, `bun run dev`'s owner door, on
`127.0.0.1:<port>`, names the person running it on every request (their Tailscale login, or
`<user>@localhost` without Tailscale). It answers only names under `localhost` (`acme.localhost`,
`<app>--acme.localhost`): a page whose own name points at 127.0.0.1 gets a 421, not them, and so
does bare `localhost` or `127.0.0.1`, which a function or connection on another local OpenBelt may
fetch. The platform itself, on port + 1000, has no door: nobody is signed in there unless a request
from this machine sends the headers itself, as `bun run seed` and checks do. So under `tailscale` the platform answers
only its own names (under `localhost` or `OPENBELT_HOST`, `OPENBELT_BASE_HOST`, `127.0.0.1`, `[::1]`, and tailnet names under `ts.net`); any other name gets a
421, so a page whose own name points at this machine can't send the headers and be someone.

`/_me` answers `{ "email", "name" }` or `null`; `/_me?env=<env>` is the same, asked from a page in
that preview environment. The only cookie is `__Host-openbelt_session`, which the platform signs with
`OPENBELT_SESSION_SECRET` (the admin token when unset) for one host: check_app's session (a test
person or, for its signed-out tab, no one, for 15 minutes; check_app's browser gets one for each
app host it opens), or an email sign-in's (below). Any other cookie, or one sealed for another
host, is nobody.

## Email sign-in

Under `OPENBELT_SIGNIN=email`, people sign in once on the base host with a 6-digit email code.
The heading is "Sign in". Each workspace still checks who may enter, and keeps its own host-only session.

- Opening a workspace or app link returns you to that destination after sign-in, without a workspace picker.
- Your person menu's theme choice is shared across workspaces and devices. System follows each device's appearance. An existing browser choice is imported on its first signed-in visit if you have no shared preference yet; later visits use the shared preference.
- Each workspace in the picker is one tap: no radio button, no Continue. A check marks the current one; an invite is marked **Join**, a colleague's workspace **Ask**. Click "Create a workspace" to show its name field and Create button.
- Choosing an existing workspace opens it directly when its browser session is active. Otherwise, OpenBelt carries your sign-in from the base host. An icon and a muted, theme-aware progress bar appear while it opens. Navigation starts as soon as the overlay paints, with no minimum animation delay or background sign-in request. The animation continues while the browser loads the destination; reduced motion uses a static bar. Returning to the picker restores its controls.
- The marketing page's Sign in link opens your last-used accessible workspace, or your only active workspace.
  With several workspaces and no remembered choice, it shows the picker. Invitations need an explicit choice.
  The remembered choice belongs to this email and browser; it never grants access.
- Click the workspace name in the sidebar, "Switch workspace", to open the picker directly on the base host, without a redirect through the current workspace. The browser can prepare its connection to the base host while you use the workspace. The link shows "Opening…" immediately when clicked, while the picker loads. This preparation does not fetch a picker or reuse membership data; the picker checks your current memberships when it opens. Switching needs no
  new code while your OpenBelt browser sign-in holds. The picker marks the workspace you opened it from. Agent consent still selects a workspace first (a check shows which), then Continue grants it.
- Data requests while signed out get a 401 saying where to sign in. API tokens, `/mcp`, `/_admin`
  and webhooks keep their own authentication.
- A host whose workspace nobody made (no people, no apps; the default workspace always exists) offers no
  sign-in: a page is a 404 "No workspace called X" with a link to start at the base host, anything else
  a JSON 404 saying the same, and so is any app host under it. Asking doesn't make the workspace's file.
  The operator's routes (`/_admin/*`, `/_health`, `/_tls/ask`) still answer for any name.
- The code page has a button that opens the inbox the code went to: "Open Gmail" (Gmail's newest
  OpenBelt code emails, spam included, in the browser's first Google account) or "Open Outlook" (its
  inbox), for Gmail and Outlook addresses and for domains whose MX record is Google Workspace or
  Microsoft 365. The MX lookup runs while the code is sent and gives up after 300 ms; another
  provider, a domain behind a mail filter, or a slow lookup gets no button.
- A code works once, for 10 minutes; a wrong one uses up a try, and five use it up. Another can be
  sent after 30 seconds, at most 10 an hour. One address (a network) may ask for at most 30 codes an
  hour across every host; the next is refused (429) with how long to wait.
- Email sign-in verifies identity, independently of workspace membership. An invite-only workspace still admits
  only its invited or active people. Someone without access sees a refusal after signing in, with
  directions to ask an admin or choose another workspace. Open joining lets anyone with a verified email in.
- With `OPENBELT_MAIL_TOKEN` (a Cloudflare API token with Email Sending: Edit) and
  `OPENBELT_MAIL_ACCOUNT` (its account), the code is emailed through Cloudflare Email Sending, from
  `OPENBELT_MAIL_FROM` (default `hello@` the base host, so it moves when the base host does; the
  sender's domain must be onboarded to Email Sending, and Cloudflare answers a bounce for a domain that isn't). The log says it was sent, or why it wasn't (an
  address that bounced), and never holds the code. The deploy's canary never emails.
- With `OPENBELT_GOOGLE_CLIENT_ID` and `OPENBELT_GOOGLE_CLIENT_SECRET` (a Google Cloud OAuth
  client, type Web application, its redirect URI `https://<base host>/_signin/google/callback`),
  the base host's sign-in page also offers **Continue with Google**, above the email form. Google's
  verified email signs the person in like a code would, under the same `OPENBELT_SIGNIN_ALLOW`. When
  the form held an email and Google vouches for another (another account picked at Google), nobody is
  signed in until the page asks: **Continue as** Google's email, or a code to the form's. The sign-in is OpenID Connect with PKCE and a nonce,
  works once within 10 minutes, and only in the browser that started it. Without both, there is no
  Google button. `OPENBELT_GOOGLE_ISSUER` points it at a stand-in for checks.
- `OPENBELT_SIGNIN_ALLOW` limits who gets a code at all: addresses and `@domains`, separated by
  commas or spaces (`ada@acme.com, @acme.com`; case doesn't matter). Anyone else is shown what
  anyone is shown and sent nothing, and the log says the list doesn't name them. Unset, anyone may,
  as joining allows. A private instance only its owner uses, or a soft launch, sets it.
- Without a mail token (`bun run dev`, verify), the code is only in the platform's log
  (`sign-in: mail to <email> ... your code for <workspace> is <code>`): `bun run drive logs`, or
  `docker compose logs openbelt`.
- The platform admin can make a link that signs someone in, once, within 15 minutes:
  `POST /_admin/signin-links` with `{"email": "..."}` and the admin token, or
  `bun run workspace signin-link <email>` (on `bun run dev`, with no other options). That's how to test
  as one of the workspace's people: open the link on the signed-out port.
- The session lasts 30 days. Its cookie is the workspace host's alone; an app's host gets its own the
  first time it's opened, through a one-time ticket good for a minute, and only in the browser that app's host sent to sign
  in (a nonce in its cookie), so nobody can hand someone a link that signs them in as somebody else.
  Every request checks the workspace session and its originating browser sign-in. Sign out, in the menu
  under your name, ends this browser sign-in and its derived sessions across workspaces and apps, closing
  their open sockets. Other browsers and separately authorized agents remain signed in. Removing
  a person ends their sessions in that workspace.
- The base host remembers the last email that signed in (with a code or Google) in this browser
  (`__Host-openbelt_email`, a year, `HttpOnly`). Signed out, its sign-in page says "Welcome back" with
  that email filled in the form, one tap from a code, and still editable; the code page's "Use another
  email" (`/_signin?another=1`) shows the empty form. Signing out keeps it; signing in with another
  email replaces it.
- Every signed-out visit to the base host's `/_signin` logs why this browser has to sign in:
  `sign-in: signed-out visitor at /_signin: <reason>; remembered email: yes|no`, with the browser's
  family (`Safari · macOS`) and the path it goes on to. The reasons: `no session cookie`, `bad signature`
  (the session secret changed), `cookie expired`, `cookie for another host`, `malformed cookie`,
  `session ended` (signed out, or removed). No session cookie with the email remembered is one cookie
  lost; with no email either, the browser's storage was cleared, or it never signed in here.
  `bun run drive logs --text "signed-out visitor"` finds them.
- Signed in on the base host, its marketing page's header shows Dashboard (`/_start`) in place of Sign in
  and Start building.
- Start building on the base host (`/_start`) signs you in there once and lands you on your workspace's
  host signed in, with no second code. If your remembered workspace session is still active, it opens
  the gallery directly. Otherwise, the workspace's host gives your browser a nonce
  in its cookie, the base host asks the workspace for a ticket made for that host and that nonce (only if
  you may sign in there), and the workspace's host takes it (`/_signin/return`) only in the browser
  holding the nonce. A ticket made for someone's own sign-in can't sign anyone else in (no login
  CSRF), it isn't an admin's link, and a link opened with a GET signs nobody in.
- The front door still counts: `bun run dev`'s owner door names you with no sign-in, and a
  session started with a code wins over it on the host where it was started. Someone a door
  signed in has no Sign out in the menu: there's no session here to end. For a Tailscale preview
  of email sign-in and sign-out, run `bun run dev --email`; its HTTPS listener uses email sign-in.
- The cookie is `Secure`, so browsers keep it only over HTTPS or on `localhost` names.

## Sign-in on a public host

On a server anyone can reach, people sign in with the company's identity provider before OpenBelt
shows them anything. `deploy/signin/` puts it in front of compose's OpenBelt, with no OpenBelt code
of its own: oauth2-proxy signs people in over OIDC, and Caddy asks it about every request and
tells OpenBelt who it is (the same two headers, as the front door).

```sh
docker compose -f compose.yaml -f deploy/signin/compose.yaml --profile tls up -d
```

with, beside compose's own settings, `OPENBELT_FRONT_DOOR_SECRET` (`openssl rand -hex 32`),
`OPENBELT_SSO_ISSUER`, `OPENBELT_SSO_CLIENT_ID` and `OPENBELT_SSO_CLIENT_SECRET` (an OIDC web app made at
the provider, redirecting to `https://<OPENBELT_HOST>/oauth2/callback`), `OPENBELT_SSO_COOKIE_SECRET`
(`openssl rand -hex 16`) and optionally `OPENBELT_SSO_EMAIL_DOMAIN` (who may sign in).

- One sign-in covers every workspace and app host (its cookie is for `.<OPENBELT_HOST>`), and signing
  out is `/oauth2/sign_out`.
- OpenBelt's port isn't published: everything comes in through Caddy, which drops any identity
  header a client sent before setting its own.
- What carries its own credentials skips the sign-in, as listed above: agents keep using `/mcp`
  with a token, and webhooks still arrive.
- `check_app`'s browser can't sign in. OpenBelt sends its requests for OpenBelt's own names to
  Caddy's second listener (`OPENBELT_CHECK_DOOR=caddy:8443`), which signs nobody in and isn't
  published; its own session cookie says who its test people are.
- The provider says who someone is, and the workspace still says whether they get in: under `"open"`
  joining, anyone the provider signs in joins on their first visit. Set `OPENBELT_SSO_EMAIL_DOMAIN`
  to your domain, or use `"invite"` joining or SCIM ([People and groups](./people.md)).
- One provider for every workspace. To let each customer sign in with their own (their Okta, their
  Entra ID), put a broker that holds several, such as Keycloak or Dex with a connector per
  customer, in as the one provider.
- Removing someone at the provider ends their access when their sign-in cookie next refreshes
  (oauth2-proxy's, up to 7 days by default); removing them in OpenBelt ends it at once.
- An email one-time code (as Cloudflare Access gives) needs a provider that sends one, such as
  Keycloak or Auth0.

## Every app on its own host

Each app is served on a host of its own, `<app>--<workspace>.<domain>`, so the browser keeps apps apart
the way it keeps websites apart: one app's page can't read another's, script it in a frame or a
popup, or send a request that OpenBelt takes as the other app's. OpenBelt knows which app a call is
from by the host it came to, and refuses a data call (`/_db`, `/_ws`, `/_log`) a page of another
origin sent (`403 cross_origin`; `Origin` and `Sec-Fetch-Site` are set by the browser, never the
page). Every response of an app's host carries `Content-Security-Policy: frame-ancestors 'self' https://<workspace>.<domain>`:
an app's pages may frame its own pages, the workspace's host may (`/<app>`), and no other app, nor any other
web page, can frame them, so nobody can lay an app under a fake button and have a viewer click through to calls
made as them. The one exception is an app the workspace's admin names (`workspace_embed_set`, an app builder
showing the app it builds): its origin joins every other app's `frame-ancestors`. Both are under the workspace's domain, so the
viewer is signed in inside the frame in every browser, Safari's included. The frame gives an app no camera,
microphone or location: a browser keeps those grants for the address bar's host, which in the frame is the workspace's, so one
app's grant would be every app's. So an app has no camera, microphone or location yet: a page
load of the app's host is sent to the frame. Only `check_app`'s browser stays, and a page the app opens itself (a popup, a print
view, or a tab it opens with `target="_blank"` to use the camera there, where the grant is its own). An app sets
no response headers of its own; a `<meta http-equiv="Content-Security-Policy">` in its page still
applies, but browsers ignore `frame-ancestors` there. To show another app, link to it
(`appUrl("<app>")`) or read its data (`db.app("<app>")`). The workspace's host, `<workspace>.<domain>`, is
OpenBelt's own: the gallery, `/mcp`, and each app's pages in the frame at `/<app>/<path>`. So app names `a`, `install`, `scim`
and `mcp` are reserved: the host's own routes use them.

Who is viewing works on every host the same way, with nothing handed from host to host:

- The front door says who each request is from, on whichever host it comes to: Tailscale's
  identity for the device (through `bun run dev`'s and `bun run tailnet`'s front door, which asks
  Tailscale for each peer).
- A test person's cookie is set by `check_app`'s browser itself, on each app's host it opens (the
  app's, and the other apps' in its preview environment). It's a `__Host-` cookie: the browser
  keeps it to the one host, so one app's page can't plant a cookie for another app's host.

So there's no OpenBelt sign-in to carry between hosts, and no handoff: if real sign-in (SSO) comes
from OpenBelt itself one day, it needs one (a one-time code from the workspace host, bound to the app's
host, traded for that host's own `__Host-` cookie).

## Installed workspace

In a browser, choose **Add to Home Screen** on mobile or **Install app** on desktop from the person
menu. App frames keep installation controls out of the app header. A supported browser opens its native install prompt. On iPhone, a drawing of Safari,
labeled OpenBelt, walks you through four steps: the ••• menu, Share, Add to Home Screen, and Add with Open as Web App
kept on. An arrow marks what to tap; tap it in the drawing, use Back and Next, or a progress
segment to move between steps. The installation happens in your browser's own controls.

Installation is per workspace: named **OpenBelt**, with the OpenBelt icon and the
workspace's gallery as its launch URL, on its own origin. You can
install several workspaces. After you open your first app and return to the gallery, it offers a
small install invitation on iPhone or when a native prompt is available. **Not now** remembers your
choice for this workspace; the menu action remains available. Other workspaces keep their own
invitations. Install controls are hidden in the installed window. The existing workspace switcher
stays available; another workspace can open outside the installed window because its origin differs.

Apps keep their separate origins inside the workspace frame. On phones, its header is 48px tall,
with a 44px-tall touch target for the OpenBelt icon.

Only the installed, standalone window shows **Refresh app** in the workspace person menu or sidebar. App frames show the OpenBelt logo symbol as the link back to all apps, followed by the app name, with no wordmark, refresh button or update notice.
It checks for OpenBelt updates when opened, brought to the foreground, reconnected, and every five
minutes while visible. **Update available → Refresh** reloads the current page when you choose.
The URL and page scroll are restored. Workspace edits block refresh.

Browser tabs keep their usual reload controls and show no refresh or update UI. Installation adds
no offline cache or background sync: opening, checking versions, and refreshing need a connection.
App deployments still follow the app SDK's existing reload behavior; this notice tracks OpenBelt's
platform code, not individual app versions.

## Notifications: each person allows them one app at a time

An app's function sends a notification with `ctx.notify` ([Functions](./functions.md)). It
reaches only people who allowed that app's notifications:

1. The first time an app notifies you, you get nothing. The next time you open the app, it asks
   at the bottom: **Get notifications from this app?**, **Allow** or **Not now**.
2. **Allow** asks the browser for permission, subscribes this device, and turns the app on.
   **Not now** keeps it off, and the app doesn't ask again.
3. The **Notifications** switch in the app's panel changes your answer later.

A tap on a notification opens the app's page in the workspace frame, at `/<app>/<path>`.

- Your answer is per app and holds on every device you allowed one on. A device takes
  notifications once you allow any app on it.
- Desktop Chrome, Edge, Firefox and Safari, and Android, ask in a browser tab. On iPhone and iPad
  (iOS 16.4 or later), only the installed workspace asks: add it to the Home Screen first.
- Each person keeps up to 10 devices per workspace; a new one past that drops their oldest.
  Removing a person from the workspace drops their devices and answers.

The workspace's one service worker, `/_pwa/sw.js`, registers when you allow an app. It only shows
notifications and opens their pages: it handles no requests, so pages load as they do without it.
