# Dynamic tables and figures

A results table that fills in as experiments finish, or a figure that gets replaced when a
better plot lands, used to cost a new artifact version per update. Dynamic tables and
figures let a document declare a named slot whose value Derive owns: the value changes
through a small API, every served page shows the current value, and no version is minted.

The model is per version. Publishing a new version seeds each declared slot from the
previous version's latest data (or from the inline placeholder for a brand-new name).
Updates land only on the current version. Older versions keep the data they had. A restore
starts the new version from the restored version's final data.

## Declare a binding

In Markdown, a fenced block names the slot. Its body is the placeholder shown until the
slot exists and the seed for a brand-new slot; after that the stored value is the truth.

````markdown
```derive-table results
| Model | PSNR | SSIM |
| --- | ---: | ---: |
| baseline | -- | -- |
| ours | -- | -- |
```

```derive-figure ablation
{"caption": "Ablation study"}
```
````

In HTML, the same two attributes on a table or a figure. The authored rows and the first
image and caption are the seed.

```html
<table data-derive-table="results">…</table>
<figure data-derive-figure="ablation"><img src="…" alt="…"><figcaption>…</figcaption></figure>
```

A missing or null cell renders as `--`; a figure without an image renders a placeholder
box. Names use lowercase letters, digits and dashes.

## The API

- `GET /v1/artifacts/:id/dynamic` lists a version's slots (`?v=n` for an older version);
  `GET …/dynamic/:name` returns one (`&format=html` adds the rendered fragment);
  `GET …/dynamic/:name/history` returns its retained revisions.
- `PATCH …/dynamic/:name` applies a batch to the current version: `cells`
  (`{row, col, value}`), `delete_rows`, then `append_rows`, atomically or not at all. Rows
  are addressed by the table's `key` column value when it declares one (a duplicate value
  is refused rather than guessed), otherwise by 0-based index. A figure patch merges
  `{"url", "caption", "alt", "width", "height"}`.
- `PUT …/dynamic/:name` replaces a whole value or creates a slot; `DELETE` removes one.
- `expected_revision` on a write is a compare-and-swap guard: a stale value answers 409.
  Omit it to retry against the live revision.
- The artifact's own page can read a slot at `/raw/:id/dynamic/:name.json` (current
  version) or `/raw/:id/v/:n/dynamic/:name.json`, with the same access as the artifact.

Agents write through the same routes: the MCP `stage` tool mints a short-lived bearer
(`target: "api"`), and the `read` tool lists and returns slots beside a version's facts.
Figure images are ordinary assets: upload one to `POST /v1/assets` (or stage it) and put
the returned URL in the slot.

## Versions

Every version has its own start point and its own revisions, so `v3` always renders what
`v3` carried, even after `v4` moved on. Publishing a version whose document drops a
binding simply leaves that version without the slot; earlier versions are untouched.

## Permissions

A slot is document content, so writes follow publish access: whoever could republish the
table may change a cell, and nobody else can. Viewers and commenters read. The workspace's
agent-write switch binds these writes as it binds publishes.

## Limits

A version holds up to 32 slots. A table holds up to 512 KB, 10,000 rows and 64 columns;
a patch up to 2,000 operations. Each slot keeps its seed plus the last 50 revisions. This
is a data channel for a document's own numbers and images, not a database.
