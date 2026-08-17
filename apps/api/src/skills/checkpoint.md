---
name: checkpoint
summary: save your working state to a resumable lineage so a later session continues cold, on any machine (checkpoint)
order: 7
---
# Checkpointing working state

Commit a compact, resumable snapshot of your working state so any later session (on any machine) continues cold.

- **First call for a piece of work:** pass `work` (a short name); the lineage is created and
  the result names its `short_id`. Record it, for example in a `.derive/lineage` file at the repo
  root) and pass it as `short_id` on every checkpoint after.
- **Each checkpoint REPLACES the page** (versions keep the history; each layer is a pinned
  named version), so restate what still matters and drop what does not. The tool rejects
  more than a page.
- **Prefer refs over restated detail.** Cite artifact short_ids, PR/issue URLs, and key file
  paths in `refs`: the layer is an index a cold session follows, not a container. A
  continuing session reads those refs (artifact short_ids via the `read` tool) to rehydrate.
