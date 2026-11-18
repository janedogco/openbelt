---
title: Who can change what
description: openbelt.json rules, which the platform enforces on every page's read and write: who may read, create, update and delete each collection, the vocabulary, the polls example, testing a denial, and what MCP writes do.
---

# Who can change what

Hiding a button in the page is not security: anyone in the workspace can call the routes the SDK uses.
openbelt.json rules are: the platform checks every page's read and write against them (this app's
pages, other apps', and anything else that calls the app's `/_db`). A poll only its author changes;
one vote per person on a poll that exists, changed or taken back only while the poll is open:

<!-- example: polls -->

```json
{
  "collections": {
    "polls": "one doc per poll: { title, options, closed }",
    "votes": "one doc per person per poll, id <poll>:<email>: { poll, choice }"
  },
  "rules": {
    "polls": {
      "read": "anyone",
      "create": "signedIn",
      "update": "doc.author == me",
      "delete": "doc.author == me"
    },
    "votes": {
      "read": "anyone",
      "create": "signedIn && id == newDoc.data.poll + ':' + me && get('polls', newDoc.data.poll) != null && get('polls', newDoc.data.poll).data.closed != true",
      "update": "doc.author == me && newDoc.data.poll == doc.data.poll && get('polls', doc.data.poll) != null && get('polls', doc.data.poll).data.closed != true",
      "delete": "doc.author == me && get('polls', doc.data.poll) != null && get('polls', doc.data.poll).data.closed != true"
    }
  }
}
```

```js
await db.collection("votes").set(poll.id + ":" + me.email, { poll: poll.id, choice }) // set: the rule checks the id
await db.collection("polls").update(poll.id, { closed: true }) // closing is an update: its author only
```

- Keys: a collection, or a prefix like `"v_*"`. A collection with rules states all four ops
  (read, create, update, delete; "anyone" for an open one): deploy refuses one left out, saying
  what to add. A collection with no rules is open to anyone. `set(id)` is a create when the id is new, and an
  update with `ifSeq: 0` is a create.
- Each clause above closes a gap: without `votes.delete` anyone deletes anyone's vote; without the
  poll check on update a voter moves their vote to another poll or changes it after closing.
- Close a poll rather than delete it. Once a poll is deleted, anyone signed in can create a poll
  with its id (and its old votes), and no rule can refuse that.

## The vocabulary

- Names: `anyone`, `nobody`, `signedIn`, `me` (the viewer's email, null when signed out), `id` (the
  document's), `doc` (stored: `doc.author`, `doc.updatedBy`, `doc.id`, `doc.data.<field>`),
  `newDoc` (after the write, for create and update), `get('coll', id)` (another document here, or
  null; at most 2 distinct (collection, id) pairs per rule: the same get twice is one).
  Operators: `== != && || ! + ( )`, and `'text'`, numbers, `true`, `false`, `null`. A missing
  field is null.
- `author` is the creator and never changes; `updatedBy` is the last writer. Both come from the
  session; anything in `data` is whatever the page sent, so compare it with `me`.
- Rules can't name the workspace's groups. For "only people in a group may do this", make the write a
  function that checks `caller.groups` ([Functions](./functions.md)) and make the rule `"nobody"`.
  On live, an agent's direct write that a `"nobody"` rule covers is refused too: call the function.

## More on the vocabulary

- A collection's own name wins over a prefix key; of two prefixes, the longer.
- `id` for `add()` is the new random id. `doc.data` reaches deeper (`doc.data.owner.email`). An
  update's `newDoc.data` is the stored data with the patch merged in. `get()` reads the same data
  (live, or the preview environment's).
- `+` adds numbers and joins text, null if either side is. A rule allows when its value is true
  as in JavaScript (`null`, `false`, `0` and `""` aren't). Any field of null is null:
  `get('polls', x).data.closed != true` holds for a poll that doesn't exist. No loops, regular
  expressions or other functions.
- Signed-out writes are stored as "anonymous", which never equals `me`: start a rule with
  `signedIn &&` when a signed-out viewer mustn't pass.
- The id `<poll>:<email>` alone, without the rule that checks it, proves nothing: a page could
  write any id. `"delete": "nobody"` on polls makes closing the only way.
- Rules say who may write which document, not what's in it: `choice` can be any value. Check the
  shape in the page.

## Denials

- A refused write is a 403 and changes nothing:
  `{ error: "denied by rules.polls.update: doc.author == me", code: "denied", hint }`, and the
  SDK's error has `e.status`, `e.code` and `e.rule`; for an `&&` chain it names the clause that failed: "denied by rules.votes.update
  (failed: get('polls', ...).data.closed != true)". It's logged as "rule denied ..." and isn't a
  browser error. A read rule leaves documents out of lists, get (null) and watch.
- Rules are checked before `ifSeq`: `set(id, data, { ifSeq: 0 })` on an existing id is a 403 when
  the update rule refuses, a 409 otherwise.
- A bad rule refuses the deploy (`doc.title` instead of `doc.data.title`, `=` instead of `==`).
  Where nobody can sign in, a deploy whose rules use `me`, `signedIn`, `author` or `updatedBy`
  warns that they refuse everyone. `app_info` shows each
  collection's rules.
- Test a denial: in a preview, `check_app` as another test person
  ([Test as several people](./viewers.md#test-as-several-people)), eval the write through the SDK,
  then `{ action: "expect", status: 403 }`.

## Testing a denial

One test person creates a poll and another, who isn't its author, tries to close it:

<!-- example: polls-denial -->

```json
{
  "app": "polls",
  "preview": "rules",
  "people": ["alice", "carol"],
  "steps": [
    {
      "as": "alice",
      "action": "eval",
      "save": "pollId",
      "script": "const { db } = await import('/sdk.js'); return (await db.collection('polls').add({ title: 'Lunch?', closed: false })).id"
    },
    {
      "as": "carol",
      "action": "eval",
      "script": "const { db } = await import('/sdk.js'); await db.collection('polls').update('{{pollId}}', { closed: true }).catch(() => {})"
    },
    { "as": "carol", "action": "expect", "status": 403 }
  ]
}
```

The `expect` passes when the write was refused (`answered 403 (rules.polls.update)`) and fails
with `expected 403 from PATCH /_db/polls/<id>, got 200` when it went through. Write to a poll
that exists: an update or delete of one that doesn't is a 404, before any rule.

Deploy also refuses `doc` in a create rule (use `newDoc`) and a third distinct `get()`. Rules take
effect with their version: a preview environment uses the rules deployed there, so test a rule
change in a preview before promoting it. A read rule can leave a page of a list with fewer than
`limit` documents while `cursor` isn't null; when a change hides a document from a viewer, their
page gets a delete for it, with `data` null.

## MCP writes

Without `as`, `collection_add`, `collection_update` and `collection_delete` write as the token's
user and bypass rules: use them to seed and fix data. With `as: "carol"` and `preview`, the write
is that test person's, and the rules judge it as they would her page's.

For moving data (merging duplicates, re-keying documents), MCP writes without `as` may pass
`author` and `updatedBy` per document: it keeps who wrote it, so bob can still delete the vote you
moved for him. They're refused together with `as`. A batch (`docs: [...]`, up to 500) is one
transaction: if any document is refused, none is written and the refusal lists each one.

<!-- example: polls-move -->

```js
// bob's vote moves from duplicate poll p1 to p2, still his
collection_update({
  app: "polls",
  collection: "votes",
  docs: [
    {
      id: "p2:bob@acme.com",
      data: { poll: "p2", choice: "Tacos" },
      replace: true,
      ifSeq: 0,
      author: "bob@acme.com",
      updatedBy: "bob@acme.com",
    },
  ],
})
```
