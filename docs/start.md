---
title: Getting started
description: Someone new to OpenBelt, or asking for a first tool: offer five picks, add the starter app they pick or build what they describe, send the link and what to do next.
---

# Getting started

When someone is new to OpenBelt or asks for their first tool, do this. Keep each message short.
The pick is the only question before the link: after it, don't ask anything until they have the
link.

## Offer a pick

Offer this, exactly, and wait for their reply:

```
What should we build first? Reply with a number, or describe your own.
1. Message board: you and your agents post and reply, live
2. Journal: a daily log your agents write to and you skim each evening
3. Task organizer: one list you and your agents both pick up and check off
4. Drawing board: a shared canvas everyone sketches on at once
5. Something else: tell me what you need
```

Picks 1-4 are starter apps. They already work and have example data. Don't build them. When
you're connected, add the starter app they picked with one call:

- `starter_add({ starter: "<name>" })`, or with the CLI:
  `~/.local/bin/openbelt call starter_add '{"starter":"<name>"}'`
- `<name>` is `messages` (1), `journal` (2), `tasks` (3) or `sketch` (4).

Then send the link and the next steps `starter_add` gives you, exactly.

If the workspace already has an app by that name, `starter_add` says so: add the starter app with
another `app` name, or send the link to the one that's there.

For pick 5, build it (below), even if what they described is short or unclear: build what you
think they mean.

## Build it

1. Read `docs({ page: "apps" })` and `docs({ page: "sdk" })`, then build the smallest version that
   works. Keep the UI simple and minimal: one screen, plain layout, only the controls it needs.
   Pick sensible defaults for anything they didn't say; don't ask about it.
2. Check it in a real browser with `check_app`, then make it live: `deploy_app`, or `promote_app`
   if you built it in a preview environment.
3. Send the link and four next steps in the same format as the pick, each fitted to the app:

   ```
   What next? Reply with a number, or tell me.
   1. <something you add to it while they watch, like a first post or entry>
   2. <a change to the app, like a new field or view>
   3. <something it does by itself: a schedule, or a notification on their phone>
   4. <someone to invite, to use it with them>
   ```

## What next

When they reply with a number, do it, then send the next steps again: the ones they didn't pick,
and a new one of the kind they did. Ask follow-up questions only now, after the link, and only if
you need them.

Change an app the way you change any app, and check it before it goes live: `app_files`, then
`deploy_app` with edits into a preview environment, `check_app` there as test people
(`people: ["alice", "bob"]`), then `promote_app`. Starter apps show their controls only to people
signed in, so a check without people sees no buttons.
