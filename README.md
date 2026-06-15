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
# → http://localhost:8080 · the whole app (API + web), SQLite + blobs in one volume
```

The image bundles the web app and serves it same-origin, so one container is the
complete product — sign-in, publish, comments, reviews, the sandboxed viewer — at
one URL. Optional env vars (nothing is required):
`DATABASE_URL` → Postgres · `OBJECT_STORE_URL` → S3/R2 · `DOCK_TOKEN` → require a
bearer token for publishing and for reading gated artifacts · `BASE_URL`, `PORT`, `DATA_DIR`.

### Deploy to the cloud

The single-container image runs on any host with a persistent volume.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)
&nbsp;&nbsp;
[![Deploy to Fly.io](https://img.shields.io/badge/Deploy%20to-Fly.io-8B5CF6)](DEPLOY.md)

- **Railway** — New Project → *Deploy from GitHub repo* → this repo. `railway.json`
  builds `deploy/Dockerfile`; add a **Volume mounted at `/data`** so SQLite + blobs
  persist (or attach Railway Postgres and set `DATABASE_URL`).
- **Fly.io** — `fly launch --config deploy/fly.toml --dockerfile deploy/Dockerfile`,
  then `fly deploy`. The bundled volume keeps `/data`.

Both auto-detect their assigned URL for auth cookies + share links; set `BASE_URL`
only when you put a custom domain in front. Full guide: [DEPLOY.md](DEPLOY.md).

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

## Agents: ship a page, get the review comments back

Dock is built for the loop where an agent publishes and a human (or another agent)
reviews. `dock init` scaffolds the on-ramp straight into your project: a Claude Code
skill (`.claude/skills/dock`) plus a project MCP config (`.mcp.json`), so an agent
can publish, read comments, revise, and resolve with no extra wiring.

One line to connect over MCP — Dock is itself a remote MCP server, OAuth-authenticated
(no static token):

```bash
claude mcp add --transport http dock <your-dock-server>/mcp
```

The first call opens a browser consent; the scope you grant maps to a role. The agent
then acts **at that role** — an agent granted publish access publishes directly, exactly
as you would; a lower-scoped one reads and proposes.

Or drive it from the CLI:

```bash
node packages/cli/bin/dock.js login      # OAuth sign-in
node packages/cli/bin/dock.js publish    # share a versioned URL
node packages/cli/bin/dock.js comments   # read the review threads, then revise and publish again
```

MCP tools: `whoami`, `list_artifacts`, `read_artifact`, `read_section`, `list_versions`,
`diff`, `list_comments`, `catch_me_up`, `propose` (human-reviewed), and `publish`
(direct — Creator/Admin role). Publish vs. propose follows your role. Full loop in
[packages/mcp/SKILL.md](packages/mcp/SKILL.md).

> The `@dock/cli` / `@dock/mcp` npm packages aren't published yet — run the CLI from the
> repo (`node packages/cli/bin/dock.js`) and connect agents to the remote `/mcp` endpoint
> above until they land.

## Embeds and unfurls

Every share link (`/a/:ref`) unfurls as a rich card in Slack, Discord, X, and
Notion, and can be dropped into any page. The server adds OG/Twitter meta to the
artifact's `/a/:ref` HTML and exposes:

- `GET /v1/og/:ref` — the card image (1200×630 SVG; private artifacts get a
  no-leak locked card)
- `GET /v1/oembed?url=…` — an oEmbed `rich` document (a sandboxed iframe)
- `GET /v1/embed/:ref` — the embeddable view; copy a ready iframe snippet from the
  Share dialog

All honor visibility against the requester, so a crawler never sees a gated title.

## Live updates

`GET /v1/artifacts/:id/events` is a Server-Sent Events stream emitting
`comment.created`, `comment.resolved`, `version.published`, and `presence`.
`POST /v1/artifacts/:id/presence {name}` records a heartbeat. Plain HTTP — no
WebSockets, no sticky sessions.

Every artifact is served with `Content-Security-Policy: sandbox` on an opaque
origin and rendered inside a sandboxed iframe — scripts run, but cannot reach
cookies, storage, or other artifacts.

## License

[Functional Source License (FSL-1.1-ALv2)](LICENSE) — fair-code / source-available.
Run, modify, and self-host Dock freely for any purpose **except** offering it as a
competing commercial product or service. Each release automatically converts to
Apache-2.0 two years after it ships.
