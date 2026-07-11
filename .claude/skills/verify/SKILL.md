# verify (local runtime for apps/api)

Run the real Node server against a throwaway SQLite to observe API behavior end-to-end
(no Docker needed — faster than `deploy/compose.yml` for a verification loop):

```bash
DATA_DIR=<scratch-dir> PORT=8791 DERIVE_TOKEN=devtok BASE_URL=http://localhost:8791 \
  pnpm --filter @derive/api exec tsx src/node.ts
```

- Health: `curl localhost:8791/healthz` → `{"ok":true}`. The boot log's `meta:` line names
  the exact SQLite path — always confirm it's your scratch dir, never a remote DB.
- Publish via HTTP: `curl -X POST localhost:8791/v1/artifacts -H "authorization: Bearer devtok" -F 'file=@-;filename=index.html;type=text/html' -F 'title=T' <<< '<h1>x</h1>'`
- Preview screenshots: add `DERIVE_PREVIEWS=true` (needs Playwright Chromium — usually
  already in `~/Library/Caches/ms-playwright`; else `pnpm --filter @derive/api exec playwright install chromium`).
  The worker ticks every 1.5s; `/v1/og/<short_id>` flips from SVG fallback to PNG when the
  render lands. `version.preview_status` / `render_job` in the scratch `derive.db` show pipeline state.
- The bundled SPA serves at `/` but needs a signup; API-level checks (`/v1/artifacts`,
  `/v1/og/:id`) cover most verification without a browser session.
