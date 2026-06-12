# Dock

**Manage and share AI artifacts. Self-hostable. CLI first.**

Dock gives any static artifact — an HTML page, a Markdown doc, or a whole built
site — a permanent URL with version history. Publish from the CLI or the HTTP
API; view it rendered and sandboxed. Self-host it, or use the hosted tier.

## Quickstart (dev)

```bash
pnpm install
pnpm dev                                  # api on http://localhost:8080

# publish a file
node packages/cli/bin/dock.js publish ./README.md

# publish any static build output (a dist/ folder)
node packages/cli/bin/dock.js publish ./dist --title "My site" --spa

# new version, same URL
node packages/cli/bin/dock.js publish ./README.md --id <short_id> --message "v2"
```

## Self-host

```bash
docker compose -f deploy/compose.yml up -d
# → http://localhost:8080 · SQLite + local blobs in one volume, zero config
```

Optional env vars (nothing is required):
`DATABASE_URL` → Postgres · `OBJECT_STORE_URL` → S3/R2 · `DOCK_TOKEN` → require a
bearer token for publishing and for reading gated artifacts · `BASE_URL`, `PORT`, `DATA_DIR`.

### Access

Publish with `--visibility public|link|org|password` (default `link`). When
`DOCK_TOKEN` is set, writes require `Authorization: Bearer <token>`, and reading
anything other than `public`/`link` requires it too — gated artifacts 404 without
it. (Per-user accounts and SSO come later; this is the zero-dependency gate.)

## Architecture

One Node container is the whole product; storage is pluggable behind interfaces.

```
apps/api          HTTP API, sandboxed artifact serving, viewer
apps/web          web UI (TanStack Start) — coming later
packages/core     domain: ports, publish, markdown render, viewer shell
packages/db       MetaStore: sqlite (default) · postgres · d1
packages/storage  BlobStore: fs (default) · s3/r2
packages/cli      dock publish <file|dir>
packages/mcp      MCP server — publish / read-back tools for agents
```

## MCP

Point an agent at a Dock server over MCP (stdio):

```bash
DOCK_SERVER=http://localhost:8080 pnpm --filter @dock/mcp start
```

Tools: `publish_artifact`, `publish_version` (with `resolves`), `get_artifact` (source read-back), `list_versions`, `list_comments`, `reply_comment`.

Every artifact is served with `Content-Security-Policy: sandbox` on an opaque
origin and rendered inside a sandboxed iframe — scripts run, but cannot reach
cookies, storage, or other artifacts.

## License

[Apache-2.0](LICENSE)
