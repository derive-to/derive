---
name: organize
summary: make the library findable: browse the tag vocabulary + collections, and tag or collect artifacts (organize)
order: 8
---
# Organizing the library (tags + collections)

`organize` is the library's findability layer: browse TAGS (lightweight labels) and
COLLECTIONS (a set treated as a unit), in one tool. Tag freely and reuse the vocabulary — a
well-tagged library is findable. Reach for a collection only when a set is a real unit, not
for plain findability. Tags can also be set at publish time via publish's `tags` param.

## Read mode

- **No `short_ids`:** returns the workspace's tag vocabulary (tag → count) and its
  collections. Call this BEFORE tagging so you reuse an existing tag over a near-duplicate.
- **With `short_ids`:** returns those artifacts' current tags + collections, plus
  `suggested` tags drawn from the most semantically-similar docs (when a single id is given).

## Write mode (pass `short_ids` plus any of these)

- **`add`** — union onto existing tags (never drops what's there).
- **`remove`** — drop these tags.
- **`set`** — replace the whole tag set (overrides add/remove).
- **`collection`** — fold the artifacts into a collection, by id or by name (created if new).

Tags are normalized (trimmed, lowercased, deduped, capped 20). Each artifact is authorized on
its own; ones you can't edit come back as `skipped`, never failing the batch.

## Cleaning up after yourself (`state`)

The same tool retires, restores, and deletes — so the way back is never a separate thing to
discover. Pass `short_ids` plus `state`:

- **`state:'removed'`** — retire from the library. The url reads as removed, **nothing is
  deleted**, and the response hands you the exact call that undoes it. This is the one to
  reach for by default: experiments you made should not become permanent litter, and a
  reversible cleanup needs no deliberation.
- **`state:'live'`** — put a retired artifact back.
- **`state:'deleted'`** — **permanent**. Every version, comment and proposal goes, contexts
  running from the artifact go with it, and there is no undo. The response says so and
  carries no reversing call, because there isn't one.

Two things worth knowing before reaching for `deleted`:

- It needs a **manage-level** grant on the artifact, a higher bar than publishing to it.
  A publish-grade connection gets `needs_manage` back with the reversible alternative
  named. That is deliberate: creating an artifact and destroying one are different acts.
- Prefer `removed` unless permanence is the actual goal. "I want this out of the library"
  is almost always `removed`; `deleted` is for content that must not exist.

From a shell, the same three live on the CLI: `derive delete <short_id…>` (which asks you
to type the id back, or takes `--yes`).
