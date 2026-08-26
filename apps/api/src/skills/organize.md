---
name: organize
summary: make the library findable: browse tags + collections, tag, collect, retire, delete (browse_library, organize, shelve)
order: 8
---
# Organizing the library (tags + collections)

The library's findability layer is TAGS (lightweight labels) and COLLECTIONS (a set treated
as a unit), across three tools that share one set of rules:

- **`browse_library`** reads. It never writes, so a client can run it without asking you.
- **`organize`** tags and collects. Reversible: nothing it does loses an artifact.
- **`shelve`** retires, restores, and deletes. The one destructive verb on the library.

Tag freely and reuse the vocabulary. A well-tagged library is findable. Reach for a
collection only when a set is a real unit, not for plain findability. Tags can also be set at
publish time via publish's `tags` param.

## Reading (`browse_library`)

- **No `short_ids`:** returns the workspace's tag vocabulary (tag → count) and its
  collections. Call this BEFORE tagging so you reuse an existing tag over a near-duplicate.
- **With `short_ids`:** returns those artifacts' current tags + collections, plus
  `suggested` tags drawn from the most semantically-similar docs (when a single id is given).

## Tagging and collecting (`organize`: `short_ids` plus any of these)

- **`add`:** add to the existing tags without removing any.
- **`remove`:** remove these tags.
- **`set`:** replace the whole tag set and override `add` or `remove`.
- **`collection`:** add the artifacts to a collection by id or name; a new name creates one.

Tags are normalized (trimmed, lowercased, deduped, capped 20). Each artifact is authorized on
its own; ones you can't edit come back as `skipped`, never failing the batch.

## Cleaning up after yourself (`shelve`)

One tool retires, restores, and deletes, so restoring is not a separate workflow to
discover. Pass `short_ids` plus `state`:

- **`state:'archived'`:** hide it from ordinary library views and search while keeping
  its URL, content, versions, comments and shares intact. The response hands you the exact
  undo call. Use this for experiments and transient work.
- **`state:'live'`:** restore an archived artifact to the library.
- **`state:'deleted'`:** **permanent**. Every version and comment is deleted. Contexts
  running from the artifact go with it, and there is no undo. The response says so and
  carries no reversing call, because there isn't one.

Two things worth knowing before reaching for `deleted`:

- It needs a **manage-level** grant on the artifact, a higher bar than publishing to it.
  A publish-grade connection gets `needs_manage` back with the reversible alternative
  named. That is deliberate: creating an artifact and destroying one are different acts.
- Prefer `archived` unless permanence is the actual goal. "I want this out of the library"
  is almost always `archived`; `deleted` is for content that must not exist.

From a shell, the same three live on the CLI: `derive delete <short_id…>` (which asks you
to type the id back, or takes `--yes`).
