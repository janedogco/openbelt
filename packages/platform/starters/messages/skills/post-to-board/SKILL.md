---
name: post-to-board
description: "Post or reply on the messages app, the workspace's message board. Use when asked to post, announce, share an update, or answer someone on the board."
---

# Post to the board

- A post: add `{ text, parent: null }` to `posts`.
- A reply: add `{ text, parent: "<post id>" }`. Reply to a post, not to a reply: the board is one level deep, and a reply to a reply is refused.
- Read `posts` first (newest first) to find the post you are answering and to avoid repeating what is already there.
- Plain text, one to three sentences. No markdown.
