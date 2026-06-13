# Dock

**Manage and share AI artifacts. Self-hostable. CLI first.**

Dock gives any static artifact — an HTML page, a Markdown doc, or a whole built
site — a permanent URL with version history. Publish from the CLI or the HTTP
API; view it rendered and sandboxed. Self-host it, or use the hosted tier.

## Quickstart (dev)

```bash
pnpm install
pnpm dev                                  # api on http://localhost:8080

# scaffold a project (templates: md · html · slides)
node packages/cli/bin/dock.js init my-doc --template slides
cd my-doc

# publish — reads dock.json, so no flags; the id is saved for next time
node packages/cli/bin/dock.js publish
# edit, then publish again → new version, same URL, same artifact
node packages/cli/bin/dock.js publish --name "First draft"
```

`dock init` writes a `dock.json` (artifact id, title, visibility, spa, entry) and
an `AGENTS.md` describing the publish → review → revise loop. Without a project
you can still `dock publish <file|dir> [--title --spa --id …]` directly.
Authoring + the anchor-client protocol are documented in [STANDARD.md](STANDARD.md).

## Self-host

```bash
docker compose -f deploy/compose.yml up -d
# → http://localhost:8080 · SQLite + local blobs in one volume, zero config
```

Optional env vars (nothing is required):
`DATABASE_URL` → Postgres · `OBJECT_STORE_URL` → S3/R2 · `DOCK_TOKEN` → require a
bearer token for publishing and for reading gated artifacts · `BASE_URL`, `PORT`, `DATA_DIR`.

### The app & accounts

Open the web app and sign in at **`/login`**. Once signed in you get a library,
in-browser publishing, and the comment loop — comments are authored as you, and
Markdown/HTML artifacts can be edited inline to publish a new version.

Accounts are handled by [Better Auth](https://better-auth.com): email + password
works with zero config; set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for Google
sign-in, or `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` to wire enterprise
SSO (Okta, Entra, Auth0, Keycloak — anything OIDC). The user/session tables are
created automatically on first boot. See `.env.example` for the full list.

Writes are authorized by a login session **or** a static `DOCK_TOKEN` (for
CI/agents). Publish with `--visibility public|link|org|password` (default `link`);
when `DOCK_TOKEN` is set, gated artifacts 404 for anyone without a session or the
token.

## Architecture

One Node container is the whole product; storage is pluggable behind interfaces.

```
apps/api          HTTP API, sandboxed artifact serving, viewer
apps/web          web UI (TanStack Start, SPA mode — static bundle)
packages/core     domain: ports, publish, markdown render, viewer shell
packages/db       MetaStore: sqlite (default) · postgres · d1
packages/storage  BlobStore: fs (default) · s3/r2
packages/cli      dock init (md/html/slides) · dock publish <file|dir>
packages/mcp      MCP server: publish / read-back tools for agents
```

## Deploy

Single container (SQLite + local disk) or a hosted split (CDN web + API container +
Postgres + S3/R2). Both run the same image; everything is env driven. See
[DEPLOY.md](DEPLOY.md).

## MCP

Point an agent at a Dock server over MCP (stdio):

```bash
DOCK_SERVER=http://localhost:8080 pnpm --filter @dock/mcp start
```

Tools: `publish_artifact`, `publish_version` (with `resolves`), `get_artifact`
(source read-back), `list_versions`, `diff_versions`, `restore_version`,
`list_comments`, `add_comment` (with a `quote` anchor), `reply_comment`,
`resolve_thread`, `view_stats`. The `dock://guide` resource serves the full
publish → review → revise loop (also in [packages/mcp/SKILL.md](packages/mcp/SKILL.md)).

## Live updates

`GET /v1/artifacts/:id/events` is a Server-Sent Events stream emitting
`comment.created`, `comment.resolved`, `version.published`, and `presence`.
`POST /v1/artifacts/:id/presence {name}` records a heartbeat. Plain HTTP — no
WebSockets, no sticky sessions.

Every artifact is served with `Content-Security-Policy: sandbox` on an opaque
origin and rendered inside a sandboxed iframe — scripts run, but cannot reach
cookies, storage, or other artifacts.

## License

[Apache-2.0](LICENSE)
