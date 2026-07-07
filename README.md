# Derive

**Manage and share AI artifacts. Self-hostable. CLI first.**

Derive gives any static artifact — an HTML page, a Markdown doc, or a whole built
site — a permanent URL with version history. Publish from the CLI or the HTTP
API; view it rendered and sandboxed. Self-host it, or use the hosted tier.

## Quickstart (dev)

The dev stack is two servers — the API and the web UI:

```bash
pnpm install
pnpm dev:all                              # both servers → open http://localhost:3090

# or run them in separate terminals:
#   pnpm dev       # API    → http://localhost:8090
#   pnpm dev:web   # web UI → http://localhost:3090  ← open this

# scaffold a project (templates: md · html · slides)
node packages/cli/bin/derive.js init my-doc --template slides
cd my-doc

# publish — reads derive.json, so no flags; the id is saved for next time
node packages/cli/bin/derive.js publish
# edit, then publish again → new version, same URL, same artifact
node packages/cli/bin/derive.js publish --name "First draft"
```

`derive init` writes a `derive.json` (artifact id, title, visibility, spa, entry) and
an `AGENTS.md` describing the publish → review → revise loop. Without a project
you can still `derive publish <file|dir> [--title --spa --id …]` directly.
Authoring + the anchor-client protocol are documented in [STANDARD.md](STANDARD.md).

## Self-host

```bash
docker compose -f deploy/compose.yml up -d
# → http://localhost:8080 · the whole app (API + web), SQLite + blobs in one volume
```

The image bundles the web app and serves it same-origin, so one container is the
complete product — sign-in, publish, comments, reviews, the sandboxed viewer — at
one URL. Optional env vars (nothing is required):
`DATABASE_URL` → Postgres · `OBJECT_STORE_URL` → S3/R2 · `DERIVE_TOKEN` → require a
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
works with zero config. Add social sign-in by setting a provider's OAuth
credentials; the matching "Continue with…" button then appears on `/login`
automatically:

- **GitHub** (a natural fit, since Derive mirrors GitHub repos): create an OAuth app
  at GitHub → Settings → Developer settings → OAuth Apps → New, set the callback to
  `<BASE_URL>/api/auth/callback/github`, then set `GITHUB_LOGIN_CLIENT_ID` and
  `GITHUB_LOGIN_CLIENT_SECRET`. This is a plain OAuth app, separate from the
  repo-sync GitHub App you register in Settings → GitHub.
- **Google**: create an OAuth client (Web) in Google Cloud Console, set the
  redirect to `<BASE_URL>/api/auth/callback/google`, then set `GOOGLE_CLIENT_ID`
  and `GOOGLE_CLIENT_SECRET`.
- **Enterprise SSO**: set `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`
  (Okta, Entra, Auth0, Keycloak, anything OIDC).

Provide these as environment variables for the Node/Docker deploy, or as secrets
for the Worker deploy (`wrangler secret put GITHUB_LOGIN_CLIENT_ID`, and so on).
The user/session tables are created automatically on first boot; see
`.env.example` for the full list.

Writes are authorized by a login session **or** a static `DERIVE_TOKEN` (for
CI/agents). Publish with `--visibility public|link|org|password|private` — the
default is `private` (you and the people you invite; for an agent publish, the
user the agent acts on behalf of owns it), so nothing is visible to anyone else
unless you say so. When `DERIVE_TOKEN` is set, gated artifacts 404 for anyone
without a session or the token.

## Architecture

One Node container is the whole product; storage is pluggable behind interfaces.

```
apps/api          HTTP API, sandboxed artifact serving, viewer
apps/web          web UI (TanStack Start, SPA mode — static bundle)
packages/core     domain: ports, publish, markdown render, viewer shell
packages/db       MetaStore: sqlite (default) · postgres · d1
packages/storage  BlobStore: fs (default) · s3/r2
packages/cli      derive init (md/html/slides) · derive publish <file|dir>
packages/mcp      MCP server: the 5 agent tools (list_artifacts, read, catch_up, comment, publish)
```

## Deploy

Single container (SQLite + local disk) or a hosted split (CDN web + API container +
Postgres + S3/R2). Both run the same image; everything is env driven. See
[DEPLOY.md](DEPLOY.md).

## Agents: ship a page, get the review comments back

Derive is built for the loop where an agent publishes and a human (or another agent)
reviews. `derive init` scaffolds the on-ramp straight into your project: a Claude Code
skill (`.claude/skills/derive`) plus a project MCP config (`.mcp.json`), so an agent
can publish, read comments, revise, and resolve with no extra wiring.

One line to connect over MCP — Derive is itself a remote MCP server, OAuth-authenticated
(no static token):

```bash
claude mcp add --transport http derive <your-derive-server>/mcp
```

The first call opens a browser consent; the scope you grant maps to a role. The agent
then acts **at that role** — an agent granted publish access publishes directly, exactly
as you would; a lower-scoped one reads and proposes.

Or drive it from the CLI:

```bash
npm i -g @derive-to/cli
derive login       # OAuth sign-in — discovers every workspace you belong to
derive publish     # share a versioned URL
derive comments    # read the review threads, then revise and publish again
```

MCP tools (five): `list_artifacts` (find), `read` (content), `catch_up` (what changed
plus the open feedback and version history), `comment` (leave/reply/resolve), and
`publish` (save a revision). `publish` goes live if your role can publish (Creator/Admin),
otherwise (or with `for_review:true`) it files a proposal a human approves. Full loop in
[packages/mcp/SKILL.md](packages/mcp/SKILL.md).

> Both are on npm: `npm i -g @derive-to/cli` gives you the `derive` command, and
> `npx -y @derive-to/mcp` connects a local agent over stdio — no token to paste, it
> shares the same `derive login` as the CLI. `DERIVE_TOKEN` remains for a static
> bearer (CI, no local login).

### Multiple workspaces, multiple accounts

A Derive access token is scoped to you, not to one workspace — it already reaches
everywhere you're a member. `derive login` discovers the full roster in one browser
round trip; running it again shows what's signed in and offers to re-sync, switch
the default, add another account, or sign out — never a silent second login:

```bash
derive login --add                       # a second identity (e.g. a work account)
derive accounts                          # every signed-in account + its workspaces
derive workspace use "Acme Co"           # switch the default workspace
derive publish --workspace "Client Org" --account @work   # one-off override
```

Pin a project to a workspace by committing `workspace`/`account` in `derive.json`, or
an MCP server to one via `DERIVE_ACCOUNT`/`DERIVE_WORKSPACE` in `.mcp.json` — both
default to your stored default when unset.

## Embeds and unfurls

Every share link (`/artifacts/:ref`) unfurls as a rich card in Slack, Discord, X, and
Notion, and can be dropped into any page. The server adds OG/Twitter meta to the
artifact's `/artifacts/:ref` HTML and exposes:

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
Run, modify, and self-host Derive freely for any purpose **except** offering it as a
competing commercial product or service. Each release automatically converts to
Apache-2.0 two years after it ships.
