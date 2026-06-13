# Deploying Dock

One image, two shapes:

1. **Single container** (start here): one box runs the API *and* the web app on one
   origin, with SQLite + local blobs on a mounted volume. No CORS, no external services.
2. **Scale-out split**: web SPA on a CDN, stateless API containers, managed Postgres,
   S3/R2 blobs. Same image — just add env vars.

---

## Single container

One command gives you a complete, working Dock — sign-in, publish, comments, reviews,
notifications, the sandboxed viewer — all served from `http://localhost:8080`.

```bash
docker build -f deploy/Dockerfile -t dock .

docker run -d -p 8080:8080 -v dock_data:/data \
  -e DOCK_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e BASE_URL="https://dock.example.com" \
  dock
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
- **`DOCK_AUTH_SECRET`** signs sessions. Set it (any 32-byte hex). If you don't, the
  container generates one and persists it in the volume, so logins survive restarts —
  but an explicit secret is what you want in production.

### Put it on the internet

Point a TLS-terminating proxy at the container and a domain at the proxy. Caddy is the
shortest path:

```caddyfile
dock.example.com {
  reverse_proxy localhost:8080
}
```

Cloudflare Tunnel, nginx, or any host's built-in HTTPS works the same way. Then set
`BASE_URL=https://dock.example.com` and you're live.

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
custom domain at it. Set `DOCK_AUTH_SECRET` once so sessions survive redeploys on
hosts with an ephemeral filesystem.

### First user

The first person to sign up becomes the workspace **owner**; everyone after joins at
the default role. Sign up at `/login`.

---

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | Public origin of the instance (cookies + share links) |
| `DOCK_AUTH_SECRET` | generated, persisted | Session signing key (set in prod) |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/data` | SQLite + blob dir (single container) |
| `DATABASE_URL` | (SQLite) | Postgres for metadata + auth (scale-out) |
| `OBJECT_STORE_URL` | (local disk) | S3/R2 blob storage (scale-out) |
| `DOCK_WEB_ORIGIN` | (none) | Comma-separated web origins for CORS (split deploy only) |
| `DOCK_CROSS_SITE` | `false` | `true` for `SameSite=None; Secure` cookies (split deploy only) |
| `DOCK_TOKEN` | (none) | Static bearer token for CI/agents |
| `DOCK_WEB_DIR` | (auto) | Override the bundled SPA path |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Google sign-in |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_ID` | (none) | Enterprise SSO |

### OAuth / SSO (optional)

If you set `GOOGLE_*` or `OIDC_*`, register the callback with the provider:

```
https://dock.example.com/api/auth/callback/google
https://dock.example.com/api/auth/oauth2/callback/<OIDC_PROVIDER_ID>
```

---

## Scale-out split

When one box isn't enough: put Postgres + object storage behind the API and the
container holds no state — run as many as you like. Optionally serve the SPA from a CDN
on its own origin (then it's a cross-origin call, hence the CORS + cookie vars).

```
  browser
    |  app.example.com   static SPA on a CDN (optional — the container also serves it)
    |  api.example.com   Dock container(s): Fly / Hetzner / any host
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
  DOCK_AUTH_SECRET="$(openssl rand -hex 32)" \
  BASE_URL='https://api.example.com'

fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

With `DATABASE_URL` + `OBJECT_STORE_URL` set the container is stateless: scale it
horizontally and drop the `[mounts]` volume from `fly.toml`. Each instance must share
the same `DOCK_AUTH_SECRET`.

### 3. (Optional) Serve the SPA from a CDN

The container already serves the web app, so this is only for putting it on a separate
cache/origin. Build with the API origin baked in and add the CORS vars to the API:

```bash
VITE_DOCK_API='https://api.example.com' pnpm --filter @dock/web build
npx wrangler pages deploy apps/web/dist/client --project-name dock
```

```bash
# on the API:
fly secrets set DOCK_WEB_ORIGIN='https://app.example.com' DOCK_CROSS_SITE='true'
```

`DOCK_CROSS_SITE=true` makes the session cookie `SameSite=None; Secure` so it rides the
cross-origin SPA→API request; `DOCK_WEB_ORIGIN` allow-lists the SPA for CORS.
`apps/web/public/_redirects` already ships the SPA fallback.

## Cloudflare Workers + D1 (experimental)

`packages/db` ships a Cloudflare D1 driver (`@dock/db/d1`) for an edge deployment, but
this path is **experimental and unverified**. It reuses the same SQLite repositories and
schema as the default driver, so the query logic and DDL are covered by the test suite,
but the D1-specific runtime has no integration test yet and Dock ships no Worker
entrypoint. Don't expect production parity with the SQLite or Postgres tiers.

To experiment, the bootstrap schema is generated for you from the shared source of truth:

```bash
wrangler d1 create dock
wrangler d1 execute dock --file=deploy/d1-schema.sql
# d1-schema.sql is generated; after a schema change run: pnpm --filter @dock/db gen:d1-schema
```

Then wire `createD1Store(env.DB)` from `@dock/db/d1` into your Worker's fetch handler.
Closing the gap to "supported" means a Miniflare-backed smoke test of the driver; the
shared half is already covered by the SQLite suite.
