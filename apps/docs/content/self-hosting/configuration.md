# Deploying Derive

For a new single-container installation, follow the [self-hosting quickstart](quickstart.md). It covers the
released-image and source-build paths, creates the first operator while the service is offline,
waits for readiness, and verifies a first backup. This document is the reference for choosing a
topology and operating or extending an installation.

For the normal self-hosted path, start with [Install a published release](quickstart.md#install-a-published-release-recommended).
That path downloads the release Compose and environment files, pins the tested image digest,
and verifies `SHA256SUMS` before starting. The optional GitHub CLI checks also verify the
immutable release asset and its build attestation.

## Deployment tiers

Pick the tier that matches your scale and infrastructure:

| Tier | Runtime | Metadata | Blobs | Realtime | Good for |
|---|---|---|---|---|---|
| **Lite** | Single container | SQLite (built-in) | Local disk | In-process | Personal use, small teams, hobby projects |
| **Node Basic** | Container(s) | Postgres | S3/R2 | In-process | Production teams, managed hosting |
| **Node Scale** | Containers + load balancer | Postgres | S3/R2 | Per-instance¹ | High-traffic, stateless request scale |
| **Cloudflare Basic** | Workers + D1 + DO | D1 (SQLite on edge) | R2 | Durable Objects | Edge-first, global, no infra to manage |
| **Cloudflare Scale** | Workers + Postgres + DO | Postgres | R2 | Durable Objects | Edge serving + Postgres at scale (D1 limits exceeded) |

All tiers run the same codebase. Add `DATABASE_URL` to Lite for Node Basic. Put more
containers behind a load balancer for Node Scale.

¹ Realtime events for comments, presence, and cursors stay on one Node instance. A single
container fans out events in-process, but events do not cross containers yet. Use a
Cloudflare tier when you need cross-instance realtime. Its Durable Objects fan out events
globally.

---

## Lite: single container

One container runs sign-in, publishing, comments, reviews, notifications, and the sandboxed
viewer at `http://localhost:8080`.

Use the [self-hosting quick start](quickstart.md#choose-one-path) for a fresh install. The
commands there explicitly load the environment file, validate the rendered Compose model, create
the first operator before the service starts, wait for readiness, and prove the first backup.

The Compose file pulls the pinned release image from GHCR, persists `/data`, runs
as a non-root user with an init process, binds to `127.0.0.1` by default, and defines
a database/blob readiness health check. To
build the same image from a checkout instead:

```bash
docker compose --env-file deploy/.env \
  -f deploy/compose.yml -f deploy/compose.build.yml \
  up --build -d --wait
```

That's the whole thing. The image bundles the built SPA and the API serves it
same-origin, so there's nothing else to host. State (SQLite + artifact blobs) lives
in the `/data` volume. Use the online backup command below; copying a live WAL-mode
volume is not a consistent backup.

For upgrades, follow [Upgrade a published installation](quickstart.md#upgrade-a-published-installation).
The named data volume is retained and the new image applies SQLite and Better Auth schema changes
at boot. Back up and verify first, keep the previous digest and volume, and validate the upgraded
instance before removing anything.

- **`BASE_URL`** is the public origin you'll reach it at. It signs auth cookies and
  builds artifact share links, so set it to your real URL (behind a proxy, the
  public `https://…` domain, not `localhost`).
- **`DERIVE_AUTH_SECRET`** signs sessions. Set it (any 32-byte hex). If you don't, the
  container generates one and persists it in the volume so logins survive restarts.
  Set an explicit secret in production.

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
- **Fly.io**: `fly launch --config deploy/fly.toml --dockerfile deploy/Dockerfile`,
  then `fly deploy`. `fly.toml` already mounts `/data`.
- **Render**: a Docker web service + a persistent disk at `/data`.

`PORT` is read from the environment, and the public URL is auto-detected from the
host (`RAILWAY_PUBLIC_DOMAIN` / `RENDER_EXTERNAL_URL` / `FLY_APP_NAME`) so auth
cookies and share links work out of the box. Set `BASE_URL` only when you point a
custom domain at it. Set `DERIVE_AUTH_SECRET` once so sessions survive redeploys on
hosts with an ephemeral filesystem.

### Accounts and first user

Every new account gets its own personal workspace as **owner**. People join another
workspace only by accepting its invitation. `DERIVE_SIGNUP_MODE` controls who can
create an account: `open` (default), `invite` (the browser must first present a live
workspace/artifact invitation), or `closed` (offline bootstrap only). Existing users can
always sign in. Keep Internet-facing hosts on `invite`; invite admission is a short-lived,
signed HttpOnly capability minted from the invite token, not an email-address lookup.

`bootstrap-operator` is the normal first-user path. It creates the account through the
same Better Auth API as the app and stores instance-wide authority against the immutable
user id. It refuses an existing account or a second operator unless you pass the explicit
recovery flags shown by its usage error. `DERIVE_SUPERADMIN_EMAILS` is deprecated and only
migrates an already-verified legacy account to the user-id record; it never admits signup.

### Backup, restore, and password recovery

Create the host backup directory once (`mkdir -p deploy/backups`), then:

```bash
# Online and safe while Derive is serving: SQLite snapshot first, immutable blobs second.
docker compose --env-file deploy/.env -f deploy/compose.yml run --rm derive \
  backup /backups/derive-$(date +%F)
docker compose --env-file deploy/.env -f deploy/compose.yml run --rm derive \
  verify-backup /backups/derive-$(date +%F)

# Recovery without putting the new password in shell history or the process list.
read -rsp 'New password: ' DERIVE_RESET_PASSWORD
printf '%s' "$DERIVE_RESET_PASSWORD" | docker compose \
  --env-file deploy/.env -f deploy/compose.yml run --rm -T derive \
  reset-password --email owner@example.com --password-stdin
unset DERIVE_RESET_PASSWORD
```

Each backup contains a SQLite online snapshot, all content-addressed local blobs, the
Lite instance identity files, and an exhaustive checksum manifest. `verify-backup` rejects
unmanifested files, links and unexpected topology, checks every blob's content address,
and runs SQLite integrity checking. Copy the completed directory to an independent,
preferably immutable backup store. Checksums detect corruption; they are not signatures.
When an identity is supplied by `DERIVE_AUTH_SECRET` or `DERIVE_DEFAULT_ORG_ID` instead of
a data-volume file, the manifest records only its fingerprint and restore requires the
same environment value.
`restore-backup` only accepts a new, empty `DATA_DIR`, so a restore cannot overwrite a
running instance accidentally.

Restore into a new named volume and validate it before cutover. Keep the old volume until
you have signed in and opened representative artifacts on the restored instance:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml down

# Restore into a fresh volume; the existing derive-data volume is untouched.
DERIVE_DATA_VOLUME=derive-data-restored docker compose \
  --env-file deploy/.env -f deploy/compose.yml run --rm derive \
  restore-backup /backups/derive-2026-08-11

# Boot the restored copy on a temporary loopback port and test it.
DERIVE_DATA_VOLUME=derive-data-restored DERIVE_PORT=18080 \
  docker compose --env-file deploy/.env -f deploy/compose.yml up -d --wait
curl -fsS http://127.0.0.1:18080/readyz
```

After validation, stop it, set `DERIVE_DATA_VOLUME=derive-data-restored` in `deploy/.env`,
and start normally. Rollback is the inverse volume selection; neither volume is deleted by
`docker compose down` unless you explicitly add `--volumes`.

For Postgres + S3/R2, the built-in Lite commands refuse to run: a local SQLite file or
blob directory in that topology is not the source of truth. Take a provider-consistent
Postgres snapshot first, then snapshot/version/replicate the object-store bucket, and
retain the matching `DERIVE_AUTH_SECRET` and `DERIVE_DEFAULT_ORG_ID` in your secret
manager. Test recovery into a new database, bucket and deployment before promoting it.
Hybrid Postgres/local-blob and SQLite/S3 configurations are runtime-supported for
specialized deployments, but are intentionally not covered by the built-in backup tool.

---

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | Public origin of the instance (cookies + share links) |
| `DERIVE_AUTH_SECRET` | generated, persisted | Session signing key (set in prod) |
| `DERIVE_SIGNUP_MODE` | `open` | New-account admission: `open`, `invite`, or `closed` |
| `DERIVE_SUPERADMIN_EMAILS` | (none) | Deprecated migration only: binds matching verified legacy accounts to immutable-id operator records |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/data` | SQLite + blob dir (single container) |
| `DATABASE_URL` | (SQLite) | Postgres for metadata + auth (scale-out) |
| `OBJECT_STORE_URL` | (local disk) | S3/R2 blob storage (scale-out) |
| `DERIVE_WEB_ORIGIN` | (none) | Comma-separated web origins for CORS (split deploy only) |
| `DERIVE_CROSS_SITE` | `false` | `true` for `SameSite=None; Secure` cookies (split deploy only) |
| `DERIVE_TOKEN` | (none) | Static bearer token for CI/agents. One of the two ways to write (the other is a sign-in session); anonymous callers are always read-only (public/link artifacts), never owners. |
| `DERIVE_WEB_DIR` | (auto) | Override the bundled SPA path |
| `DERIVE_PREVIEWS` | `false` | `true` to enable server-side Playwright screenshot generation for share cards (Docker image bundles Chromium; bare-Node hosts must run `playwright install --with-deps chromium` once) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Google sign-in |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_ID` | (none) | Enterprise SSO |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` | (none) | Optional Slack app (all three required). Create it from **Settings → Integrations → Set up Slack app**; connect from Settings → Integrations. Bot tokens are encrypted at rest with `DERIVE_AUTH_SECRET`. |
| `STRIPE_SECRET_KEY` | (none) | Stripe secret key (`sk_test_`/`sk_live_`). Unset disables the billing routes entirely; self-host never needs it. |
| `STRIPE_WEBHOOK_SECRET` | (none) | Signing secret for the Stripe webhook endpoint (`whsec_...`). Required for `/v1/billing/webhook` to accept events. |
| `DERIVE_BILLING_ENFORCE_AT` | (none) | ISO instant after which free-tier boundaries enforce (3 editor seats, 1 GB). Unset means beta grace: nothing is blocked and white-label stays free. |

### Preview screenshots (optional)

Set `DERIVE_PREVIEWS=true` to enable server-side screenshot generation for artifact
share cards (Open Graph images, link unfurls).

- **Docker image**: Chromium is already bundled. Set the environment variable. No extra
  steps are needed.
- **Bare-Node host**: run once after install to download the browser binary **and its
  system libraries**. On Debian or Ubuntu, `--with-deps` installs the shared libraries
  Chromium needs, such as libnss3 and libatk. Without them, the browser fails to launch:
  ```bash
  corepack pnpm --filter @derive/api exec playwright install --with-deps chromium
  ```
  On a non-apt host, install the equivalent system libraries yourself.
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

### Slack app (optional)

Create one Slack app for each Derive instance. It can show link previews, mirror comments to
subscribed channels, and let people reply or resolve a comment from Slack. It also sends updates
for publishes and proposals, adds **Save to Derive** to message shortcuts, and can send direct
messages for mentions, review requests, and shares. Direct messages work reliably after a member
links their Slack account.

1. Open **Settings → Integrations → Set up Slack app** (or go to `/settings/slack/app/new`).
   Derive fills the app manifest with this instance's URL, event subscriptions,
   interactivity, and bot scopes. At [api.slack.com/apps](https://api.slack.com/apps), choose
   **Create New App → From a manifest**, paste the manifest, and create the app.
2. From the app's **Basic Information** page, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` (all three required, or Slack stays off). On Workers these are secrets: `wrangler secret put SLACK_CLIENT_ID` (and the other two).
3. Workspace admins connect from **Settings → Integrations → Add to Slack**. Subscribe a
   channel from Settings or run `/derive subscribe` in the channel. A subscription can cover
   one collection and filter events by type and by whether a person or agent authored them.
   For a private channel, invite the bot first. Workspaces connected before private-channel
   support must use **Add to Slack** again to grant the `groups:*` scopes.

Apps created from an older manifest may be missing newer features. These include Resolve and
Reopen buttons, the Slack sign-in redirect, the `/derive` command, the **Save to Derive**
shortcut, and uninstall or token-revocation events. Reapply the current manifest from
`/v1/slack/manifest.json` in **Slack app config → App Manifest**. These app configuration
changes do not require each workspace to reconnect.

`/derive <query>` searches the artifacts the linked member can see. Running `/derive` without
a query lists recent artifacts. `/derive subscribe`, `/derive unsubscribe`, and
`/derive settings` manage the current channel.

Link previews need one extra step beyond a manifest re-apply: the **app unfurl domain** is
registered on the app, and Slack only picks up a change to it when the app is **reinstalled** in
each workspace. The manifest registers this instance's host, which also covers every vanity
subdomain under it. A workspace serving artifacts on its own custom domain is out of
reach, because Slack caps an app at five unfurl domains and those hosts aren't known when the
manifest is built. Links on such a domain simply won't preview; share the instance URL instead.

Scope changes are different because Slack grants scopes at install time. Reapplying a manifest
cannot add them. Use **Add to Slack** again when adding `links:read`, `links:write`, `groups:*`,
or `commands`. Older installations without the `commands` scope must reconnect before
`/derive` will work.

Linking is per-user and optional: without it, DMs fall back to matching a member by their Derive account email; with it, DMs and Slack-reply attribution resolve to the member's exact Slack identity (so a Derive email that differs from the Slack email no longer drops the DM).

The manifest is served (filled) at `/v1/slack/manifest.json`; the setup page is the copy-paste
front end for it. Bot tokens are stored per workspace, encrypted at rest with `DERIVE_AUTH_SECRET`.

---

## Node Basic: containers + Postgres + S3/R2

When one box is not enough, put Postgres and object storage behind the API. The
container holds no state, so you can run more than one. You can also serve the SPA from a CDN
on its own origin (then it's a cross-origin call, hence the CORS + cookie vars).

```
  browser
    |  app.example.com   static SPA on a CDN (optional; the container also serves it)
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
  DERIVE_DEFAULT_ORG_ID='ws_choose-one-stable-id' \
  BASE_URL='https://api.example.com'

fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

With `DATABASE_URL` + `OBJECT_STORE_URL` set the container is stateless: scale it
horizontally and drop the `[mounts]` volume from `fly.toml`. Each instance must share
the same `DERIVE_AUTH_SECRET` and `DERIVE_DEFAULT_ORG_ID`; Node refuses to boot with
Postgres if either is missing rather than silently giving replicas different identities.

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

## Node Scale: multiple containers

Run several API containers behind a load balancer for request throughput. They are
stateless (session state lives in Postgres, blobs in S3/R2), so scaling out is just
adding instances.

One caveat: **realtime is per-instance.** Each container fans out SSE events (live
comments, version publishes, presence) only to the clients connected to *that* container.
There is no shared backplane yet, so an event on instance A does not reach a viewer on
instance B. If you need cross-instance realtime today, deploy a Cloudflare tier, where
Durable Objects own each artifact's stream and fan out globally.

A shared Node backplane, such as Redis pub/sub, is planned but not implemented. The
`Backplane` port in `apps/api/src/bus.ts` is where it will plug in.

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
(`apps/api/scripts/apply-d1-schema.mjs`, the app schema), then `migrate-auth-d1.ts --apply` (the
Better Auth schema), then `wrangler deploy`. Both schema steps bring D1 fully current
before the new Worker goes live, so a deploy can never ship code against a stale schema.
No one-shot setup SQL is needed: the two steps create the whole schema on a brand-new DB
and reconcile an existing one.

> Why this runs out of band: D1 forbids the `sqlite_master` introspection that Better Auth's
> migrator runs at boot (`SQLITE_AUTH`). Unlike the Node tier, the edge cannot reapply the
> schema on every boot. Both schemas are therefore applied at deploy time:
>
> - **App schema:** `deploy:schema` reapplies `deploy/d1-schema.sql`. It creates new
>   tables AND adds new columns (a plain `CREATE TABLE IF NOT EXISTS` re-apply never adds
>   columns to a table that already exists). Idempotent; run standalone with
>   `pnpm --filter @derive/api deploy:schema`. Regenerate the SQL from the shared schema
>   with `pnpm --filter @derive/db gen:d1-schema`.
> - **Auth schema:** `migrate-auth-d1.ts --apply` derives the desired Better Auth schema
>   from the live config (the single source of truth) and reconciles the remote D1:
>   missing tables, columns, and unique indexes, idempotently. This keeps D1 aligned when
>   you add a Better Auth `additionalField` or plugin table. A previous schema gap caused
>   signup to fail with `FAILED_TO_CREATE_USER` because the live `user` table lacked
>   `username` and `discoverable`. Inspect the plan with
>   `pnpm --filter @derive/api migrate:auth` (dry run). (`gen-auth-schema.ts` remains a
>   one-shot dump of the full auth DDL for a brand-new DB; routine deploys don't need it.)

The worker serves the SPA (login, library, settings) same-origin with the API, so there
is no CORS or cross-site cookie config. `[assets]` in `wrangler.toml` points at
`apps/web/dist/client` with `not_found_handling = "single-page-application"`, and
`run_worker_first` routes `/v1`, `/api`, `/raw`, `/a/*`, and `/healthz` to the worker
while every other path serves a static file or the SPA shell. `pnpm build:web` builds
apps/web and preps the output (writes `index.html`, drops the Pages-only `_redirects`
catch-all that otherwise hijacks `/assets/*`); see `apps/api/scripts/prep-edge-assets.mjs`.

### Upgrading an existing D1 database

New D1 databases get the current shape from `deploy/d1-schema.sql` and need nothing extra.
An **existing** one predating document chat still has `context_id NOT NULL` on
`context_session`. Chat sessions have no context, so they fail to insert
until you run the one-shot relaxation:

```
wrangler d1 execute <db> --remote --file=deploy/relax-context-session-d1.sql
```

Run it ONCE. It rebuilds the table (SQLite has no `ALTER COLUMN`), holding foreign keys
until COMMIT so a session whose context was deleted cannot abort the migration. Postgres
and self-host SQLite need no manual step: the former rides `deploy:pg-schema`, the latter
runs the same rebuild guarded at boot. Check whether you need it with:

```
wrangler d1 execute <db> --remote --command "SELECT sql FROM sqlite_master WHERE name='context_session'"
```

An existing D1 database also needs the inline-mention columns before it can store personal Slack
DM reply routes and agent thread-reply wakes. Apply this one-time additive migration first:

```
wrangler d1 execute <db> --remote --file=deploy/add-inline-mention-columns-d1.sql
```

Then re-key `slack_thread_link`, which lets a Derive thread mirror into every subscribed channel
(one Slack message **per channel** rather than the old one-thread/one-channel constraint):

```
wrangler d1 execute <db> --remote --file=deploy/rekey-slack-thread-link-d1.sql
```

The re-key is safe to re-run; the additive migration is not, so skip both on a new database.
Postgres and self-host SQLite need no manual step here either: the former swaps the constraint
during `deploy:pg-schema` (only when the stale one is present), the latter rebuilds the table
guarded at boot. Check with:

```
wrangler d1 execute <db> --remote --command "SELECT sql FROM sqlite_master WHERE name='slack_thread_link'"
```

### Chat (beta, off by default)

Chat is gated per workspace by `chatBeta` and ships **off**. The server enforces this: the
route 404s for a workspace that has not opted in, so a stray build cannot expose it. Turn
it on for one workspace with `PATCH /v1/workspace/settings {"chatBeta": true}`.

It also needs a model. Set all three as Worker secrets, or chat answers honestly that none
is configured:

```
wrangler secret put DERIVE_MODEL_BASE_URL   # e.g. https://api.fireworks.ai/inference/v1
wrangler secret put DERIVE_MODEL_API_KEY
wrangler secret put DERIVE_MODEL_NAME       # the provider's own model id
```

This key pays for every attended turn on the deployment, so it is an operator decision
rather than a per-user one.

**Streaming: the gateway should speak SSE, but need not.** When a browser is watching an
attended reply, the request carries `stream: true` and `stream_options: {include_usage: true}`
(the latter makes a streamed turn report its cost; a stream otherwise omits usage),
and the answer is rendered as it arrives. A gateway that rejects those fields, or answers with
ordinary JSON anyway, is **retried once without them** and the turn completes normally; the
person just sees the reply appear all at once. So streaming is an enhancement, never a
deployment requirement. Unattended runs and automations never ask for a stream at all. To check
whether yours streams:

```
curl -sN "$DERIVE_MODEL_BASE_URL/chat/completions" \
  -H "authorization: Bearer $DERIVE_MODEL_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"'"$DERIVE_MODEL_NAME"'","stream":true,"stream_options":{"include_usage":true},
       "messages":[{"role":"user","content":"hi"}]}'
```

**It pays for unattended runs too**, whenever they execute in-process (`DERIVE_LOOP_RUNS=1`):
the loop substrate takes the same gateway, and the schedule materializer then skips the payer
chain, because on a deployment that holds the key there is nothing for a chain to resolve and
no plan for anyone to connect. That is the hosted posture; the workspace is metered against
its tier allowance instead.

Only a deployment WITHOUT these three leaves unattended runs to resolve their own credential
per run through the payer chain. (An earlier version of this section said unattended runs were
unaffected. They are not, and believing it cost a release: the materializer kept demanding a
payer a hosted workspace never has, so scheduled automations silently never fired while
`Run now` worked.)

> `DERIVE_MODEL_NAME` is your **gateway's** model id and belongs only with the two vars
> above. Unattended in-process runs (`DERIVE_LOOP_RUNS=1`) talk to the Anthropic Messages
> API on each run's own resolved plan, so they take an **Anthropic** model id from the
> separate `DERIVE_LOOP_MODEL` (unset = `claude-sonnet-5`). Do not set `DERIVE_LOOP_MODEL`
> to a gateway path. `api.anthropic.com` will answer `model_not_found`.

#### The model library (Settings → Instance → Models)

These variables are the **floor**, not the whole story. An instance operator (`DERIVE_TOKEN`,
or an account listed in `DERIVE_OPERATORS`) manages the rest live, from Settings → Instance →
Models, with no redeploy and no restart:

| What | Where it lives | Needs a deploy? |
| --- | --- | --- |
| Add a model id on the gateway you already configured | the library | no |
| Rename a model for the picker | the library | no |
| Pin chat, or automations, to a model | the library | no |
| Probe a model: does it answer, and how fast | the library | no |
| A new gateway, or a second provider's key | `DERIVE_MODEL_*` | **yes** |

The line is the credential. A model added in the library rides the base URL and key this
deployment already holds, so it costs no new secret; a genuinely different provider needs a key
that only the environment can hold. The environment's ids are also the floor in a second sense:
an operator can add to them, relabel them, and pin to them, but cannot delete one. This prevents
a settings change from removing the last reachable model from a running deployment.

Pins take effect on the **next turn**, including in conversations that are already open. A pin
names the model and never who pays: automation runs that resolve a connected plan through the
payer chain keep their own Anthropic model id (`DERIVE_LOOP_MODEL`), because the library's ids
are the gateway's and the two namespaces are not interchangeable.

Each model shows two timings, which answer different questions. **Observed** is the median and
p95 of real turns, calculated from the answers Derive already stores. It is the more useful
number and is absent for a model nobody has used yet. **Probe** is one synthetic call through the path a turn
takes, so it is comparable across models and available immediately. Adding a model probes it
first and refuses an id the provider will not answer for.

### Automations (beta, off by default)

Automations are gated per workspace by `automateBeta` and ship **off**. The server checks the
gate wherever work is created or run. `POST
/v1/automations/:id/run` and the REST create route 404, the MCP `automate` tool refuses
`create` and `run_now`, and the deployment's cron tick will not materialize a due schedule
for a workspace that has not opted in. Reads and deletes stay open, so a workspace that
made automations before the gate can still see and remove them.

Turn it on for one workspace with `PATCH /v1/workspace/settings {"automateBeta": true}`.

### Semantic search (optional)

Workspace search uses SQLite or D1 FTS and Postgres `tsvector` by default. You can add
chunk-level embeddings and combine their results with lexical search through reciprocal-rank
fusion. This helps searches based on meaning. For example, "getting started" can match a document
about onboarding. The multilingual `bge-m3` model also handles CJK text better than the lexical
tokenizer.

Semantic search does not change access. The vector index suggests candidates, then
`listArtifacts` checks the viewer's access to every result.

Vectors live in **pgvector in your Postgres database**. You do not need a separate vector store,
and a committed vector is available to the next request because pgvector indexes synchronously.
The embedder depends on the deployment tier:

- **Cloudflare edge** (Workers + Hyperdrive Postgres): embeddings from the Workers AI `AI` binding.
  Activates when both `AI` and `HYPERDRIVE` are bound. The pgvector table (`artifact_vec`) + its
  HNSW index are created out of band by `deploy:pg-schema` as part of `pnpm deploy`. That command
  also sets `hnsw.ef_search` for the database.
- **Node self-host** (Postgres): set `DERIVE_EMBED_PROVIDER` to pick the embedder. `local` (the
  option that does not need Cloudflare) runs an in-process ONNX model (bge-small, about 30 MB,
  downloaded on first boot and cached). `workersai` embeds via Cloudflare Workers AI over
  REST and additionally needs `DERIVE_EMBED_CF_ACCOUNT_ID` + `DERIVE_EMBED_CF_API_TOKEN`. Either way
  the `artifact_vec` table is created at boot. With the embedded-SQLite default there's no pgvector,
  so `DERIVE_EMBED_PROVIDER` is ignored and search stays lexical (a warning is logged).

After enabling + deploying, backfill the existing corpus (new publishes index automatically):

```bash
# Sweep the existing corpus with the operator token, re-POSTing the returned nextCursor until it
# comes back null (bundle-dense? lower `limit`):
curl -XPOST -H "authorization: Bearer $DERIVE_TOKEN" https://<host>/v1/system/search-reindex
```

Embedding failures do not fail a publish. Query failures fall back to synchronous lexical search.
The feature is off by default, so deployments without an embedder continue to work.

Each artifact uses one vector per passage of about 1,800 characters, with at most 20 passages per
document. This creates about 5 to 20 times more rows than one vector per document. Re-run the
backfill after changing the chunking scheme or embedder model. If a new embedder changes the vector
dimension, drop the table first. The `ensureSchema` guard will not mix vector dimensions.

---

## Cloudflare Scale: Workers + Postgres + Durable Objects

When D1 isn't enough (storage limits, regional writes, complex queries), keep Workers and
Durable Objects on the edge but move metadata to Postgres. R2 stays for blobs.

When to switch: D1 has a 10 GB storage limit per database and single-region writes. If
your workspace grows beyond that, or you need cross-region write performance, point the
Worker at a Postgres instance instead. This is the tier the hosted product runs.

The Worker reaches Postgres through [Hyperdrive](https://developers.cloudflare.com/hyperdrive/),
Cloudflare's connection pooler. A Worker opens a short-lived connection for each request, while
Hyperdrive holds the server-side pool and directs each connection to a nearby proxy. The binding's presence is the
switch: `HYPERDRIVE` bound ⇒ the Postgres path; unbound ⇒ D1.

```bash
wrangler hyperdrive create derive-pg --caching-disabled \
  --connection-string='postgres://user:pass@host/db?sslmode=require'
# put the returned id into [[hyperdrive]] in wrangler.toml
# --caching-disabled is required, not a tuning choice: Hyperdrive caches SELECT
# results (~60s) by default. Derive reads its own writes, so workspace
# resolution and artifact read-back return stale results under caching (on first
# login this provisioned a new workspace on every request until the TTL expired).
wrangler r2 bucket create derive-blobs   # if not already created
wrangler secret put DERIVE_AUTH_SECRET
pnpm --filter @derive/api deploy         # build:web → schemas (D1 + pg) → wrangler deploy → smoke
```

`deploy:pg-schema` (part of `deploy`, or standalone) brings Postgres fully current
before the new Worker goes live. Like the D1 deploy's two schema steps, it
applies the app DDL (idempotent) and reconciles the Better Auth schema, reading
`DATABASE_URL` from the environment or the repo-root `.env`. Like the D1 tier, the edge
never applies schema at runtime (the Node tier does, on boot).

Durable Objects (`ArtifactRoom`, `WebhookOutbox`, `RepoSyncRunner`) continue handling
realtime fan-out, the webhook outbox drain, and GitHub sync. Those stay on the edge
regardless, and the outbox/sync DOs read the same Postgres through Hyperdrive.

The `[[d1_databases]]` binding in `wrangler.toml` is still required by the Workers
runtime even when `HYPERDRIVE` takes over at app startup. Leave the binding in place;
the D1 database itself will be idle.

PlanetScale note: its connection strings end in `sslrootcert=system`, which
node-postgres reads as a file path. Drop that parameter, keep `sslmode`, and the deploy
scripts already tolerate it.

### Billing (Stripe)

This is the tier the hosted product runs, so it is the one that turns billing on. Set
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as Worker secrets, same as the other
secrets above:

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

Leave both unset on a self-hosted deploy: the billing routes are disabled entirely
without `STRIPE_SECRET_KEY`, so nothing here is required outside the hosted tier.

1. **Seed the prices once per Stripe account** (test or live), idempotent to re-run:
   ```bash
   STRIPE_SECRET_KEY=sk_... node apps/api/scripts/stripe-seed.mjs
   ```
   Creates the four subscription prices (`team_monthly`, `team_annual`,
   `business_monthly`, `business_annual`) the checkout route resolves by lookup key.
   Existing lookup keys are left alone, so a re-run only fills in what's missing.
2. **Point a Stripe webhook endpoint** at `https://<host>/v1/billing/webhook` and
   subscribe it to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`

   Stripe issues a signing secret for the endpoint; that value is
   `STRIPE_WEBHOOK_SECRET`.
3. **Enforcement day runbook**: set `DERIVE_BILLING_ENFORCE_AT` to the ISO instant free-tier
   boundaries should start enforcing, and verify the announcement went out first.
