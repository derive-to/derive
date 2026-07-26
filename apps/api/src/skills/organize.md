---
name: organize
summary: make the library findable: browse the tag vocabulary + collections, and tag or collect artifacts (organize)
order: 6
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
