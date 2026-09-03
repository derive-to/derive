---
name: dynamic-data
summary: update a table or figure without a new version (publish once, then PATCH)
order: 4.5
---
# Dynamic tables and figures

A document that an agent refreshes on a schedule has one write path today: publish a
version. Ten refreshes a day are ten versions, and the history stops meaning "the
document changed". A **dynamic table** or **dynamic figure** is data the document declares
but Derive owns: the value lives beside the version, changes through a small API, and every
served page (the viewer, screenshots, exports, a custom domain) shows the current value.

The model is PER VERSION. Publishing v(n+1) seeds each declared slot from v(n)'s latest data
(or from the inline placeholder for a brand-new name). Writes land only on the current
version. Older versions keep the data they had. A restore starts the new version from the
restored version's final data.

## Declare a binding

Markdown: a fence. The body is the placeholder and seeds a brand-new slot only; once the
slot exists, the store is the truth and the body is ignored. A pipe table or JSON works;
`--` or an empty cell means "not yet" (rendered as `--`).

````markdown
```derive-table results
| Model | PSNR | SSIM |
| --- | ---: | ---: |
| baseline | -- | -- |
| ours | -- | -- |
```

```derive-figure ablation
{"caption": "Ablation study", "alt": "TODO"}
```
````

HTML: the same two attributes on a table or a figure. The authored rows and the first
`<img>` / `<figcaption>` are the seed.

```html
<table data-derive-table="results">…</table>
<figure data-derive-figure="ablation"><img src="…" alt="…"><figcaption>…</figcaption></figure>
```

Names are lowercase letters, digits and dashes (up to 64 characters). A version holds up to
32 slots, a table up to 512 KB, 10,000 rows and 64 columns.

## Publish once, then write

Publish the document as usual. Then mint a REST credential and write to the slot:

```
stage({target:"api", access:"publish"})   → a 15-minute bearer for REST
curl -X PATCH $BASE/v1/artifacts/<short_id>/dynamic/results \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"kind":"table","expected_revision":3,
       "cells":[{"row":"ours","col":"psnr","value":34.2}],
       "note":"run 18 landed"}'
```

- `PATCH` is a batch: `cells`, `delete_rows`, then `append_rows`, applied atomically or not
  at all. Rows are addressed by the table's `key` column value when the table declares
  one (a duplicate value refuses), otherwise by 0-based index. Columns by key.
- `PUT` replaces a whole value (`{"kind":"table","table":{columns,rows,key}}`) or creates
  a slot that has no binding yet. `DELETE` removes one. `GET …/dynamic` lists a version's
  slots (`?v=n` for an older one) and `GET …/dynamic/<name>/history` its revisions.
- `expected_revision` is the compare-and-swap guard: read the slot, pass its revision,
  and a stale write gets 409 instead of overwriting someone else's. Omit it to retry
  against the live revision.
- A figure takes `{"kind":"figure","figure":{"url":"/blob/<sha256>.png","caption":"…"}}`.
  Stage the image first (`stage({target:"asset"})`, POST the bytes, use the returned
  `url`); a null `url` renders a placeholder box.

Writes need edit access on the artifact, exactly like a republish, and honor the
workspace's agent-write switch. Column keys in a fence come from the header labels
(`PSNR` becomes `psnr`); read the slot once to see them.

## Read it back

`read(short_id, data:"*")` lists a version's dynamic slots beside its facts;
`read(short_id, data:"results")` returns the current value (pass `version` for an older
one). Outside MCP: `GET /raw/<short_id>/dynamic/<name>.json` for the current version and
`/raw/<short_id>/v/<n>/dynamic/<name>.json` to pin one, readable by the artifact's own page.

Open viewers swap the table or figure in place when a write lands; nothing reloads.
