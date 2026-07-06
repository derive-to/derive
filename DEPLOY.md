# Deploying Derive

## Deployment tiers

Pick the tier that matches your scale and infrastructure:

| Tier | Runtime | Metadata | Blobs | Realtime | Good for |
|---|---|---|---|---|---|
| **Lite** | Single container | SQLite (built-in) | Local disk | In-process | Personal use, small teams, hobby projects |
| **Node Basic** | Container(s) | Postgres | S3/R2 | In-process | Production teams, managed hosting |
| **Node Scale** | Containers + load balancer | Postgres | S3/R2 | Redis | High-traffic, multi-instance, presence at scale |
| **Cloudflare Basic** | Workers + D1 + DO | D1 (SQLite on edge) | R2 | Durable Objects | Edge-first, global, no infra to manage |
| **Cloudflare Scale** | Workers + Postgres + DO | Postgres | R2 | Durable Objects | Edge serving + Postgres at scale (D1 limits exceeded) |

All tiers run the same codebase. Tiers are additive: Lite + `DATABASE_URL` = Node Basic; Node Basic + `REDIS_URL` = Node Scale.

---

## Lite: single container

One command gives you a complete, working Derive — sign-in, publish, comments, reviews,
notifications, the sandboxed viewer — all served from `http://localhost:8080`.

```bash
docker build -f deploy/Dockerfile -t derive .

docker run -d -p 8080:8080 -v derive_data:/data \
  -e DERIVE_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e BASE_URL="https://derive.example.com" \
  derive
```

Or with Compose:

```bash
docker compose -f deploy/compose.yml up -d
```

That's the whole thing. The image bundles the built SPA and the API serves it
same-origin, so there's nothing else to host. State (SQLite + artifact blobs) lives
in the `/data` volume — back that up and you've backed up the instance.

- **`BASE_URL`** is the public origin you'll reach it at. It signs auth cookies and
  builds artifact share links, so set it to your real URL (behind a proxy, the
  `https://…` domain — not `localhost`).
- **`DERIVE_AUTH_SECRET`** signs sessions. Set it (any 32-byte hex). If you don't, the
  container generates one and persists it in the volume, so logins survive restarts —
  but an explicit secret is what you want in production.

### Put it on the internet

Point a TLS-terminating proxy at the container and a domain at the proxy. Caddy is the
shortest path:

```caddyfile
derive.example.com {
  reverse_proxy localhost:8080
}
```

Cloudflare Tunnel, nginx, or any host's built-in HTTPS works the same way. Then set
`BASE_URL=https://derive.example.com` and you're live.

### On a managed host (Railway / Render / Fly)

Any host that builds a Dockerfile and gives you a persistent disk runs this as-is.

- **Railway**: New Project → *Deploy from GitHub repo*. `railway.json` points it at
  `deploy/Dockerfile`. Add a **Volume mounted at `/data`** for SQLite + blobs (or
  attach Railway Postgres and set `DATABASE_URL`).
- **Fly.io**: `fly launch --config deploy/fly.toml --dockerfile deploy/Dockerfile`
  then `fly deploy` — `fly.toml` already mounts `/data`.
- **Render**: a Docker web service + a persistent disk at `/data`.

`PORT` is read from the environment, and the public URL is auto-detected from the
host (`RAILWAY_PUBLIC_DOMAIN` / `RENDER_EXTERNAL_URL` / `FLY_APP_NAME`) so auth
cookies and share links work out of the box. Set `BASE_URL` only when you point a
custom domain at it. Set `DERIVE_AUTH_SECRET` once so sessions survive redeploys on
hosts with an ephemeral filesystem.

### First user

The first person to sign up becomes the workspace **owner**; everyone after joins at
the default role. Sign up at `/login`.

---

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | Public origin of the instance (cookies + share links) |
| `DERIVE_AUTH_SECRET` | generated, persisted | Session signing key (set in prod) |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/data` | SQLite + blob dir (single container) |
| `DATABASE_URL` | (SQLite) | Postgres for metadata + auth (scale-out) |
| `OBJECT_STORE_URL` | (local disk) | S3/R2 blob storage (scale-out) |
| `DERIVE_WEB_ORIGIN` | (none) | Comma-separated web origins for CORS (split deploy only) |
| `DERIVE_CROSS_SITE` | `false` | `true` for `SameSite=None; Secure` cookies (split deploy only) |
| `DERIVE_TOKEN` | (none) | Static bearer token for CI/agents. One of the two ways to write (the other is a sign-in session); anonymous callers are always read-only (public/link artifacts), never owners. |
| `DERIVE_WEB_DIR` | (auto) | Override the bundled SPA path |
| `DERIVE_PREVIEWS` | `false` | `true` to enable server-side Playwright screenshot generation for share cards (Docker image bundles Chromium; bare-Node hosts must run `playwright install chromium` once) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Google sign-in |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_ID` | (none) | Enterprise SSO |

### Preview screenshots (optional)

Set `DERIVE_PREVIEWS=true` to enable server-side screenshot generation for artifact
share cards (Open Graph images, link unfurls).

- **Docker image**: Chromium is already bundled. Set the env var and you're done — no
  extra steps.
- **Bare-Node host**: run once after install to download the browser binary:
  ```bash
  corepack pnpm --filter @derive/api exec playwright install chromium
  ```
- **`BASE_URL` is required**: the renderer fetches the artifact's `/raw` URL over HTTP, so
  `BASE_URL` must be set to the public origin of the instance (or at least the internal
  origin the Node process can reach itself on). Without it the renderer cannot build the
  absolute URL and previews will not be generated.

Preview rendering runs in the same Node process as the API (no sidecar needed).

### OAuth / SSO (optional)

If you set `GOOGLE_*` or `OIDC_*`, register the callback with the provider:

```
https://derive.example.com/api/auth/callback/google
https://derive.example.com/api/auth/oauth2/callback/<OIDC_PROVIDER_ID>
```

---

## Node Basic: containers + Postgres + S3/R2

When one box isn't enough: put Postgres + object storage behind the API and the
container holds no state — run as many as you like. Optionally serve the SPA from a CDN
on its own origin (then it's a cross-origin call, hence the CORS + cookie vars).

```
  browser
    |  app.example.com   static SPA on a CDN (optional — the container also serves it)
    |  api.example.com   Derive container(s): Fly / Hetzner / any host
    v
  Postgres (Neon, RDS, Supabase, self-hosted)   <- artifacts, versions, comments, users
  S3 / R2                                        <- artifact blobs (zero egress on R2)
```

### 1. Provision data

- **Postgres**: create a database, copy its `DATABASE_URL`.
- **Object storage**: create an S3/R2 bucket + access key pair, build the URL:
  - R2: `s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>?region=auto`
  - S3: `s3://<key>:<secret>@s3.<region>.amazonaws.com/<bucket>?region=<region>`

### 2. Deploy the API (Fly is the reference; any container host works)

```bash
fly launch --config deploy/fly.toml --dockerfile deploy/Dockerfile --no-deploy

fly secrets set \
  DATABASE_URL='postgres://...' \
  OBJECT_STORE_URL='s3://...' \
  DERIVE_AUTH_SECRET="$(openssl rand -hex 32)" \
  BASE_URL='https://api.example.com'

fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

With `DATABASE_URL` + `OBJECT_STORE_URL` set the container is stateless: scale it
horizontally and drop the `[mounts]` volume from `fly.toml`. Each instance must share
the same `DERIVE_AUTH_SECRET`.

### 3. (Optional) Serve the SPA from a CDN

The container already serves the web app, so this is only for putting it on a separate
cache/origin. Build with the API origin baked in and add the CORS vars to the API:

```bash
VITE_DERIVE_API='https://api.example.com' pnpm --filter @derive/web build
npx wrangler pages deploy apps/web/dist/client --project-name derive
```

```bash
# on the API:
fly secrets set DERIVE_WEB_ORIGIN='https://app.example.com' DERIVE_CROSS_SITE='true'
```

`DERIVE_CROSS_SITE=true` makes the session cookie `SameSite=None; Secure` so it rides the
cross-origin SPA→API request; `DERIVE_WEB_ORIGIN` allow-lists the SPA for CORS.
`apps/web/public/_redirects` already ships the SPA fallback.

## Node Scale: add Redis

When you're running multiple API containers and need shared realtime state across them,
add Redis. A single container (Lite / Node Basic) uses an in-process event bus for SSE
and presence — that breaks across multiple instances without a shared backplane.

```bash
fly secrets set REDIS_URL='redis://...'
# or with Compose:
# REDIS_URL=redis://redis:6379 in your env
```

What Redis adds:
- **Pub/sub backplane** for SSE events (comments, version publishes, presence) — so any
  instance receives events published by any other
- **Presence** — who's viewing what, live cursors, shared reading sessions
- **Caching** — artifact metadata and source read-back for high-read workloads
- **Webhook outbox drain** — shared queue across instances so deliveries don't duplicate

Redis is optional at any scale. Start without it; add it when you run more than one
container or start seeing presence/realtime gaps.

---

## Cloudflare Basic: Workers + D1 + R2 + Durable Objects (experimental)

Derive has a Cloudflare Workers entry (`apps/api/src/worker.ts`) that runs the whole app
on the edge: D1 for metadata, R2 for blobs, Better Auth on a Kysely D1 dialect, the
ArtifactRoom Durable Object for cross-instance realtime fan-out, and the web SPA served
same-origin via Workers Static Assets. It reuses the same runtime-agnostic `createApp`
as the Node entry, so the app logic is identical.

Treat it as **experimental**: there is no automated edge integration test in CI yet (the
entry is typecheck-covered).

First-time setup:

```bash
cd apps/api
wrangler d1 create derive                     # copy the database_id into wrangler.toml
wrangler r2 bucket create derive-blobs
wrangler secret put DERIVE_AUTH_SECRET        # a strong random secret
pnpm deploy                                 # build:web → app schema → auth schema → wrangler deploy
```

**Every deploy is just `pnpm deploy`.** It runs `build:web`, then `deploy:schema`
(`scripts/apply-d1-schema.mjs`, the app schema), then `migrate-auth-d1.ts --apply` (the
Better Auth schema), then `wrangler deploy`. Both schema steps bring D1 fully current
before the new Worker goes live, so a deploy can never ship code against a stale schema.
No one-shot setup SQL is needed: the two steps create the whole schema on a brand-new DB
and reconcile an existing one.

> Why this runs out of band: D1 forbids the `sqlite_master` introspection Better Auth's
> migrator runs at boot (`SQLITE_AUTH`), and the edge — unlike the Node tier, which
> re-applies schema on every boot — can't. So both schemas are applied at deploy time:
>
> - **App schema** — `deploy:schema` re-applies `deploy/d1-schema.sql`: it creates new
>   tables AND adds new columns (a plain `CREATE TABLE IF NOT EXISTS` re-apply never adds
>   columns to a table that already exists). Idempotent; run standalone with
>   `pnpm --filter @derive/api deploy:schema`. Regenerate the SQL from the shared schema
>   with `pnpm --filter @derive/db gen:d1-schema`.
> - **Auth schema** — `migrate-auth-d1.ts --apply` derives the desired Better Auth schema
>   from the live config (the single source of truth) and reconciles the remote D1:
>   missing tables, columns, and unique indexes, idempotently. So adding a Better Auth
>   `additionalField` (or a plugin table) can never leave D1 behind the deployed Worker —
>   the gap that broke signup with `FAILED_TO_CREATE_USER` (the live `user` table was
>   missing `username`/`discoverable`). Inspect the plan with
>   `pnpm --filter @derive/api migrate:auth` (dry run). (`gen-auth-schema.ts` remains a
>   one-shot dump of the full auth DDL for a brand-new DB; routine deploys don't need it.)

The worker serves the SPA (login, library, settings) same-origin with the API, so there
is no CORS or cross-site cookie config. `[assets]` in `wrangler.toml` points at
`apps/web/dist/client` with `not_found_handling = "single-page-application"`, and
`run_worker_first` routes `/v1`, `/api`, `/raw`, `/a/*`, and `/healthz` to the worker
while every other path serves a static file or the SPA shell. `pnpm build:web` builds
apps/web and preps the output (writes `index.html`, drops the Pages-only `_redirects`
catch-all that otherwise hijacks `/assets/*`); see `scripts/prep-edge-assets.mjs`.

---

## Cloudflare Scale: Workers + Postgres + Durable Objects

When D1 isn't enough (storage limits, regional writes, complex queries), keep Workers and
Durable Objects on the edge but move metadata to Postgres. R2 stays for blobs.

When to switch: D1 has a 10 GB storage limit per database and single-region writes. If
your workspace grows beyond that, or you need cross-region write performance, point the
Worker at a Postgres instance instead. This is the tier the hosted product runs.

The Worker reaches Postgres through [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
(Cloudflare's connection pooler — a Worker opens a fresh short-lived connection per
request, which raw Postgres handles badly; Hyperdrive holds the real server-side pool
and the per-request dial goes to a colo-local proxy). The binding's presence is the
switch: `HYPERDRIVE` bound ⇒ the Postgres path; unbound ⇒ D1.

```bash
wrangler hyperdrive create derive-pg --caching-disabled \
  --connection-string='postgres://user:pass@host/db?sslmode=require'
# put the returned id into [[hyperdrive]] in wrangler.toml
# --caching-disabled is required, not a tuning choice: Hyperdrive caches SELECT
# results (~60s) by default, and Derive reads its own writes — workspace
# resolution and artifact read-back return stale results under caching (on first
# login this provisioned a new workspace on every request until the TTL expired).
wrangler r2 bucket create derive-blobs   # if not already created
wrangler secret put DERIVE_AUTH_SECRET
pnpm --filter @derive/api deploy         # build:web → schemas (D1 + pg) → wrangler deploy → smoke
```

`deploy:pg-schema` (part of `deploy`, or standalone) brings Postgres fully current
before the new Worker goes live — the pg twin of the D1 deploy's two schema steps: it
applies the app DDL (idempotent) and reconciles the Better Auth schema, reading
`DATABASE_URL` from the environment or the repo-root `.env`. Like the D1 tier, the edge
never applies schema at runtime (the Node tier does, on boot).

Durable Objects (`ArtifactRoom`, `WebhookOutbox`, `RepoSyncRunner`) continue handling
realtime fan-out, the webhook outbox drain, and GitHub sync — those stay on the edge
regardless, and the outbox/sync DOs read the same Postgres through Hyperdrive.

The `[[d1_databases]]` binding in `wrangler.toml` is still required by the Workers
runtime even when `HYPERDRIVE` takes over at app startup. Leave the binding in place;
the D1 database itself will be idle.

PlanetScale note: its connection strings end in `sslrootcert=system`, which
node-postgres reads as a file path — drop that parameter (keep `sslmode`); the deploy
scripts already tolerate it.
