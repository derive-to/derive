# derive-node (Node Basic + Node Scale)

Production deployment on managed container hosts. Two tiers:

- **Node Basic**: stateless containers + Postgres + S3/R2
- **Node Scale**: add Redis for multi-instance realtime (presence, SSE fan-out, caching)

For local development, see `running-locally/derive-self-host.md`.
For Cloudflare Workers, see `deploying/derive-cloudflare.md`.

---

## Node Basic: Postgres + S3/R2

Add two env vars to swap out SQLite and local disk:

```
DATABASE_URL=postgres://user:pass@host/db
OBJECT_STORE_URL=s3://key:secret@account.r2.cloudflarestorage.com/bucket?region=auto
```

Object store URL format:
- R2: `s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>?region=auto`
- S3: `s3://<key>:<secret>@s3.<region>.amazonaws.com/<bucket>?region=<region>`

With these set the container holds no state — drop the `/data` volume mount and scale
horizontally. Every instance must share the same `DERIVE_AUTH_SECRET`.

### Fly.io (reference host)

```bash
fly launch --config deploy/fly.toml --dockerfile deploy/Dockerfile --no-deploy

fly secrets set \
  DATABASE_URL='postgres://...' \
  OBJECT_STORE_URL='s3://...' \
  DERIVE_AUTH_SECRET="$(openssl rand -hex 32)" \
  BASE_URL='https://<app>.fly.dev'

fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

### Railway

New Project > Deploy from GitHub. `railway.json` points at `deploy/Dockerfile`.
Set `DATABASE_URL`, `OBJECT_STORE_URL`, `DERIVE_AUTH_SECRET`, `BASE_URL` as Railway variables.
No volume needed when using Postgres + S3/R2.

### Render

Docker web service. Set env vars in the Render dashboard. Persistent disk not needed
when `DATABASE_URL` + `OBJECT_STORE_URL` are set.

Public URL is auto-detected from `RAILWAY_PUBLIC_DOMAIN` / `RENDER_EXTERNAL_URL` /
`FLY_APP_NAME` — only set `BASE_URL` when using a custom domain.

---

## Node Scale: add Redis

When you're running multiple containers, add Redis for shared realtime state:

```
REDIS_URL=redis://user:pass@host:6379
```

What Redis enables across instances:
- **SSE fan-out**: a comment posted to instance A reaches clients connected to instance B
- **Presence**: who's viewing what, live cursors across all instances
- **Caching**: artifact metadata and source read-back
- **Webhook drain**: no duplicate delivery when multiple instances process the outbox

Start without Redis. Add it when you run more than one container or see realtime gaps.

---

## Optional: SPA on a CDN

The container serves the web app by default. This is only needed if you want the SPA
on a separate origin (e.g., Cloudflare Pages CDN):

```bash
VITE_DERIVE_API='https://api.example.com' pnpm --filter @derive/web build
npx wrangler pages deploy apps/web/dist/client --project-name derive
```

Then tell the API:

```bash
fly secrets set DERIVE_WEB_ORIGIN='https://app.example.com' DERIVE_CROSS_SITE='true'
```

`DERIVE_CROSS_SITE=true` makes the session cookie `SameSite=None; Secure` so it works cross-origin.

---

## Full env reference

| Var | Default | Purpose |
|---|---|---|
| `BASE_URL` | request origin | Public URL for cookies + share links |
| `DERIVE_AUTH_SECRET` | generated | Session signing key — always set in prod |
| `PORT` | 8080 | Listen port |
| `DATABASE_URL` | (SQLite) | Postgres connection |
| `OBJECT_STORE_URL` | (local disk) | S3/R2 blob URL |
| `REDIS_URL` | (none) | Redis for pub/sub, caching, presence |
| `DERIVE_WEB_ORIGIN` | (none) | SPA origin for CORS (split deploy only) |
| `DERIVE_CROSS_SITE` | false | SameSite=None cookies (split deploy only) |
| `DERIVE_TOKEN` | (none) | Static bearer for CI/agents |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Google sign-in |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_ID` | (none) | Enterprise SSO |

OAuth callbacks if using Google or OIDC:
```
https://derive.example.com/api/auth/callback/google
https://derive.example.com/api/auth/oauth2/callback/<OIDC_PROVIDER_ID>
```
