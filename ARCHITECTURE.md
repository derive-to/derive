# Architecture

Derive is a pnpm monorepo. One Hono-on-Node container is the product: it serves the
HTTP API, the artifact viewer, the sandboxed raw bytes, and (when bundled) the web
SPA. The same code self-hosts on SQLite + local disk or scales on Postgres + S3/R2.

```
derive.to/
├─ apps/
│  ├─ api/         Hono server: routes, auth, realtime, the container entrypoint
│  └─ web/         TanStack Start SPA (front-end; separate workstream)
├─ packages/
│  ├─ core/        runtime-agnostic domain — the MetaStore/BlobStore ports, ids,
│  │              mime, hashing, publish/propose/approve, permissions, markdown,
│  │              the viewer shell, diff, version sessions, anchors
│  ├─ db/          MetaStore adapters: sqlite (default), pg (scale), d1 (edge)
│  ├─ storage/     BlobStore adapters: fs (default), s3/r2 (hosted)
│  ├─ cli/         `derive` — init/publish/review from the terminal
│  └─ mcp/         Model Context Protocol server for agents
└─ deploy/         Dockerfile, compose, platform configs
```

## The dependency rule

`packages/core` depends on nothing in the repo. Everything else depends inward on
`core`. `core` defines the **ports** (`MetaStore`, `BlobStore` in
`packages/core/src/ports.ts`); `db` and `storage` provide the **adapters**; `apps/api`
wires a concrete adapter to the routes. Nothing imports a sibling app, and the
Workers/edge build never imports Node-only modules (see `packages/db/src/index.ts`).

## apps/api

`createApp(deps)` (`apps/api/src/app.ts`) builds the Hono app. It assembles a shared
**AppContext** (auth/authz helpers, the active-workspace resolver, rate-limit +
quota gates, the realtime bus, notification fan-out, response formatters) and mounts
one router per feature from `apps/api/src/routes/*`. Pure, dialect-free helpers live
in `apps/api/src/lib/*`. `node.ts` is the container entrypoint: it reads + validates
config, picks the SQLite or Postgres adapter (and fs or S3 blobs) from env, runs the
boot tasks (auth migrate, legacy-org rekey), starts the webhook worker, and serves
the bundled SPA when present.

- **Auth** is [Better Auth](https://better-auth.com) under `/api/auth/*`; a static
  `DERIVE_TOKEN` authorizes CI/agents. `packages/core/src/permissions.ts` is the one
  authorization gate (`can(actor, action, visibility, generalRole)`); every route
  resolves an `Actor` and asks it. `effectiveRole` there is the source of truth for the
  access matrix (anonymous is always view-only; see SECURITY.md).
- **Workspaces** are keyed by a real `org_id` (never a magic constant). Every
  signed-in user owns a personal workspace (provisioned on first login) and can
  create/switch; the active workspace is resolved per request (cookie → membership
  → provision) and scopes all workspace data. Collaboration is by per-artifact
  share or explicit workspace membership.
- **Realtime** is an in-process pub/sub (`bus.ts`) over SSE, plus ephemeral
  presence. **Webhooks** are an outbox with retries (`webhooks.ts`).
- **Origin isolation (A4):** artifact bytes (`/raw/*`) can be served from a separate
  registrable domain so untrusted HTML never shares the app's cookie origin; the
  iframe `sandbox` attribute is the single-origin fallback.

## packages/db — the adapters

All three drivers implement the single `MetaStore` interface from `core/ports.ts`.

- **sqlite** (`better-sqlite3`, synchronous) is the zero-config default.
- **d1** (Cloudflare, async) shares the exact same `sqliteTable` schema and drizzle
  sqlite query builder as sqlite — so the bulk of their query logic lives **once**
  in `packages/db/src/repos/*` and is composed by both, with a small per-driver
  `Executor` bridging sync vs async terminals.
- **pg** (`node-postgres`, async) is a different dialect (its own `pgTable` schema,
  `::int` casts, `for("update")` locks) and keeps a parallel repository set.

Per-table parity guards (`packages/db/src/parity.ts`) force every drizzle table to be
classified and assert each typed table's row shape matches its `core` Record, so the
schemas can't drift from the port. Type guards only catch type drift, so the pg adapter
is also run against the full `apps/api` suite (`pnpm test:pg`, a real Postgres in
Docker): behavioral drift in the parallel pg implementation fails CI, not just
signature drift.
Adapters are selected by env in `node.ts` (`DATABASE_URL` ⇒ Postgres, else SQLite);
the Workers entry can only reach `./d1` + `./schema`.

## Data model

Artifacts have versions (content-addressed blobs); comments anchor to text quotes
and survive republish; proposals are candidate versions awaiting review; collections
group artifacts and propagate a shared role to their items; memberships scope a user
to a workspace role. See `packages/core/src/ports.ts` for the full record shapes and
`packages/db/src/schema.ts` for the tables.

## Request lifecycle (publish)

1. `POST /v1/artifacts` (or `/:shortId/versions`) hits the `artifacts` router.
2. The router authorizes via the AppContext (`workspaceCan`/`authorize`), checks
   rate limits + storage quota, then calls `publish()` from `@derive/core`.
3. `publish()` stores bytes through the `BlobStore` and rows through the `MetaStore`,
   stamping the active `org_id`.
4. The route publishes a `version.published` event on the bus (SSE subscribers
   update live) and enqueues any matching webhooks.

## Conventions

Arrow functions, no semicolons, 100-char width, double quotes — enforced by Biome
(`biome.json`). No `any`. Inline `import type`. Kebab-case filenames. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full gate.
