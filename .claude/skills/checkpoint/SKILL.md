# checkpoint (commit a layer of working state)

Commit a one-page layer of this session's working state to the work's Derive lineage,
so any later session — yours tomorrow, a teammate's, another machine — continues cold
without re-explaining. Uses the Derive MCP `checkpoint` tool.

## When to fire

- A task the user asked for is complete (the natural boundary).
- Before a risky or destructive step (the layer is the restore point).
- Wrapping up a session, or the user says "checkpoint".

Don't wait for a clean ending — sessions get interrupted; checkpoint at the boundary
you're at, not the one you hoped to reach.

## How

1. **Find the lineage.** Read `.derive/lineage` at the repo root. If it exists, its
   content is the lineage's `short_id` — pass it. If not, this is the first
   checkpoint: call `checkpoint` with `work` (a short name — the feature or branch
   name) and NO `short_id`, then write the returned `short_id` to `.derive/lineage`
   so every later session finds it.
2. **Call `checkpoint`** with:
   - `state` — where the work stands, a few plain sentences a cold reader gets.
   - `decisions` — each with its why, including approaches rejected (so the next
     session doesn't re-propose them).
   - `open` — unresolved questions/threads that must not be dropped.
   - `next` — concrete next steps, most immediate first.
   - `refs` — pointers over prose: artifact short_ids, PR/issue URLs, key file paths.
3. **Replace, don't append.** Each checkpoint rewrites the whole page; versions keep
   the history. Restate only what still matters. If the tool rejects the size, trim —
   move detail into refs.

The lineage page is tool-maintained: humans should comment on it, not hand-edit it —
the next checkpoint replaces the page wholesale (comments survive; edits don't).

## Resuming

A session continuing the work reads the lineage first — the artifact's own
"Continue from here" section carries the paste-able command. If `.derive/lineage`
exists at session start and the task relates to ongoing work, read that artifact
before doing anything else.
