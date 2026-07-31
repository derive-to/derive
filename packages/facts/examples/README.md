# Examples

Everything here was run against a live server, not sketched.

| File | What it demonstrates |
| --- | --- |
| `self-charting.html` | A page that fetches its own JSONL export and draws its own history. No backend, no build step. `self-charting.png` is the browser shot: 7 versions, 0 console errors. |
| `q.mjs` | DuckDB pointed straight at the export URL: schema inference, the trend, an aggregate, a window function. |
| `drift.mjs` | The realistic case — a series whose shape changes between versions. Union schema, NULLs for absent fields, no fabricated zeroes. |
| `duckdb-in-page.html` | DuckDB-WASM running **inside the sandboxed artifact**, querying the page's own export over HTTP. `duckdb-in-page.png` is the browser shot: cross-origin CDN import, a blob-URL Worker, `registerFileURL`, and a window function — all from an opaque origin. |
| `union.mjs` | Three artifacts, three URLs, one SQL table. The cross-record aggregation a host is tempted to build, obtained by publishing files. |

The DuckDB scripts need `@duckdb/node-api` and a `<id>` of a record that is **world-readable
with public history enabled** — see SPEC §6.1 for why both are required.
