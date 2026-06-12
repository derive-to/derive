# Deploying Dock

Two supported shapes. Pick one.

1. **Hosted split** (scales): web SPA on a CDN, API container, managed Postgres, S3/R2 blobs.
2. **Single container** (simplest): one box, SQLite + local disk on a persistent volume.

The same image and code serve both. Everything is driven by env vars; nothing is required for the single-container path.

---

## Shape 1: Hosted split

```
  browser
    |
    |  app.example.com  (static SPA, Cloudflare Pages)
    |  api.example.com  (Dock container: Fly / Hetzner / any host)
    v
  Postgres (Neon)        <- metadata: artifacts, versions, comments, users
  S3 / R2                <- blobs: artifact bytes (zero egress on R2)
```

### 1. Provision data

- **Postgres**: create a database (Neon, RDS, Supabase, self-hosted). Copy its `DATABASE_URL`.
- **Object storage**: create an S3 or R2 bucket plus an access key pair. Build the connection URL:
  - R2: `s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>?region=auto`
  - S3: `s3://<key>:<secret>@s3.<region>.amazonaws.com/<bucket>?region=<region>`

### 2. Deploy the API container

Fly is the reference; any container host works (the image is plain `node:22-slim`).

```bash
# from the repo root
fly launch --config deploy/fly.toml --dockerfile deploy/Dockerfile --no-deploy

fly secrets set \
  DATABASE_URL='postgres://...' \
  OBJECT_STORE_URL='s3://...' \
  DOCK_AUTH_SECRET="$(openssl rand -hex 32)" \
  BASE_URL='https://api.example.com' \
  DOCK_WEB_ORIGIN='https://app.example.com' \
  DOCK_CROSS_SITE='true'

fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

With `DATABASE_URL` + `OBJECT_STORE_URL` set the container holds no state: scale it
horizontally and remove the `[mounts]` volume from `fly.toml`.

`DOCK_CROSS_SITE=true` makes the session cookie `SameSite=None; Secure` so it rides
the cross origin SPA to API request. `DOCK_WEB_ORIGIN` allow lists the SPA for CORS.

### 3. Deploy the web SPA (Cloudflare Pages)

Connect the repo in the Cloudflare dashboard, or use Wrangler:

```bash
pnpm --filter @dock/web build      # VITE_DOCK_API is baked in at build time
npx wrangler pages deploy apps/web/dist --project-name dock
```

Build settings (dashboard):

| Setting | Value |
|---|---|
| Build command | `pnpm --filter @dock/web build` |
| Output directory | `apps/web/dist` |
| Environment variable | `VITE_DOCK_API = https://api.example.com` |

`apps/web/public/_redirects` already ships the SPA fallback (`/* /index.html 200`).

### 4. OAuth / SSO redirect URIs (optional)

If you set `GOOGLE_*` or `OIDC_*` secrets, register the callback with the provider:

```
https://api.example.com/api/auth/callback/google
https://api.example.com/api/auth/oauth2/callback/<OIDC_PROVIDER_ID>
```

---

## Shape 2: Single container

No external services. SQLite and local blobs live in one mounted volume.

```bash
docker build -f deploy/Dockerfile -t dock-api .
docker run -d -p 8080:8080 -v dock_data:/data \
  -e DOCK_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e BASE_URL='https://dock.example.com' \
  dock-api
```

Or `docker compose -f deploy/compose.yml up`. Put a TLS terminating proxy in front and
point a domain at it. The SPA can be served same origin via the dev proxy, or hosted
separately as in Shape 1 with `VITE_DOCK_API` pointed back at this container.

---

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (SQLite) | Postgres for metadata + auth |
| `OBJECT_STORE_URL` | (local disk) | S3/R2 blob storage |
| `DOCK_AUTH_SECRET` | dev secret | Session signing key (set in prod) |
| `BASE_URL` | `http://localhost:PORT` | Public origin of the API |
| `DOCK_WEB_ORIGIN` | (none) | Comma separated web origins for CORS |
| `DOCK_CROSS_SITE` | `false` | `true` for `SameSite=None; Secure` cookies |
| `DOCK_TOKEN` | (none) | Static bearer token for CI/agents |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Google sign in |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_ID` | (none) | Enterprise SSO |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `./data` | SQLite + blob dir (single container) |
