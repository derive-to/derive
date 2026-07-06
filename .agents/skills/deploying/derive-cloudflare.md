# derive-cloudflare

Deploy Derive to Cloudflare Workers (Cloudflare Basic or Cloudflare Scale).
For Docker/Node deployment, see `derive-self-host.md`.

---

## Cloudflare Basic: Workers + D1 + R2 + Durable Objects

The whole app runs on the edge: metadata in D1, blobs in R2, realtime via Durable Objects,
SPA served same-origin via Workers Static Assets. No infra to manage.

Treat as **experimental** — typecheck-covered but no edge integration tests in CI yet.

### First-time setup

```bash
cd apps/api

# 1. Create D1 database — copy the database_id into wrangler.toml [[d1_databases]]
wrangler d1 create derive

# 2. Apply the app schema
wrangler d1 execute derive --remote --file=../../deploy/d1-schema.sql

# 3. Generate and apply Better Auth tables (D1 blocks sqlite_master introspection at boot)
pnpm exec tsx gen-auth-schema.ts > /tmp/auth-schema.sql
wrangler d1 execute derive --remote --file=/tmp/auth-schema.sql

# 4. Create R2 bucket for artifact blobs
wrangler r2 bucket create derive-blobs

# 5. Build SPA and deploy
pnpm build:web        # builds apps/web, preps dist/client for Workers
wrangler deploy       # or: pnpm deploy (runs build:web + deploy in one step)

# 6. Set secrets
wrangler secret put DERIVE_AUTH_SECRET   # openssl rand -hex 32
```

After deploy, the first person to sign up at `/login` becomes the workspace owner.

### Subsequent deploys

```bash
cd apps/api
pnpm deploy   # build:web + wrangler deploy
```

### Schema changes

Regenerate `deploy/d1-schema.sql` after touching `packages/db/src/schema.ts`:

```bash
pnpm --filter @derive/db gen:d1-schema
wrangler d1 execute derive --remote --file=deploy/d1-schema.sql
```

### How it works

- `apps/api/src/worker.ts` is the Workers entry; it reuses the same `createApp` as the Node entry
- `wrangler.toml` `[assets]` serves the SPA from `apps/web/dist/client` same-origin with the API
- `run_worker_first` routes `/v1/*`, `/api/*`, `/raw/*`, `/oauth/*`, `/a/*`, `/healthz`, `/mcp`, and `/.well-known/*` through the Worker; everything else is a static asset or SPA shell fallback
- `pnpm build:web` renames `_shell.html` to `index.html` and drops the Pages-only `_redirects` (see `scripts/prep-edge-assets.mjs`)
- `ArtifactRoom` Durable Object handles per-artifact realtime fan-out
- `WebhookOutbox` Durable Object drains the webhook queue with retries; a cron trigger fires every minute as a backstop

### Secrets reference

| Secret | Purpose |
|---|---|
| `DERIVE_AUTH_SECRET` | Session signing key — required |
| `BASE_URL` | Public origin override (defaults to request origin) |
| `DERIVE_TOKEN` | Static bearer for CI/agents |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_ID` | Enterprise SSO |

Set secrets with `wrangler secret put <NAME>`.

---

## Cloudflare Scale: Workers + Postgres + R2 + Durable Objects

Same as Cloudflare Basic but with Postgres replacing D1. Use this when D1's 10 GB limit
or single-region writes become a constraint.

```bash
wrangler secret put DATABASE_URL   # postgres://user:pass@host/db
wrangler r2 bucket create derive-blobs  # if not already created
wrangler secret put DERIVE_AUTH_SECRET
pnpm build:web
wrangler deploy
```

With `DATABASE_URL` set, the Worker uses the Postgres backend instead of D1.
Durable Objects still handle realtime (`ArtifactRoom`) and the webhook outbox — those
stay on the edge regardless of the metadata backend.

The `[[d1_databases]]` binding in `wrangler.toml` must stay even when Postgres is active
(the Workers runtime requires it at startup). The D1 database itself will be idle.

---

## Debugging

```bash
wrangler tail              # live log stream from the deployed Worker
wrangler dev               # local Worker with remote D1/R2 (add --remote for remote bindings)
```

D1 query failures often surface as `SQLITE_AUTH` (introspection blocked) or `SQLITE_ERROR`
(schema mismatch). Re-run the schema apply steps above if you see these after a schema change.
