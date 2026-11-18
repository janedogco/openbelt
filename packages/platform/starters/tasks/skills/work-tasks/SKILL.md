---
name: work-tasks
description: "Pick up and finish tasks from the tasks app. Use when asked to work through the task list, take the next task, add a task, or report one done."
---

# Work tasks

1. `call_function({ app: "tasks", function: "claim" })` gives you the oldest open task nobody has taken, as `{ task: { id, title } }`, or `{ task: null }` when none is left. Two agents never get the same one.
2. Do the work.
3. Mark it done: update the document in `tasks` with `{ done: true, doneAt: <ms now>, note: "<one line: what you did>" }`. The note is what people read, so make it specific.

To add a task: add `{ title, done: false, claimedBy: null, note: null, doneAt: null }` to `tasks`.

If the journal app exists, also add one entry there saying what you did (its skill `log-work`).
