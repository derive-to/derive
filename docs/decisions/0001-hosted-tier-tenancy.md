# ADR 0001 — Hosted tier: shared Postgres, central auth, DOs as utility compute

**Status:** accepted (2026-07-02)

## Decision

The hosted (cloud) tier runs as:

- **Compute:** Cloudflare Workers (the existing `apps/api/src/worker.ts` entry).
- **Metadata:** one shared **Postgres** for production (currently Neon, behind
  Cloudflare Hyperdrive). D1 stays as an adapter for local dev and staging (it is
  SQLite-flavored and cheap to spin up), not for prod.
- **Blobs:** one shared R2 bucket (unchanged).
- **Durable Objects:** utility compute only — realtime rooms, webhook outbox,
  sync runners. Nothing is hard-bound to a DO as a datastore.
- **Auth:** central. One account, many workspaces (unchanged from today's model).
- **Tokens:** workspace-bound. Credentials are minted under one account but each
  write token is scoped to a single workspace (extending the existing `agent`
  table pattern), and the CLI/MCP client keeps a local `workspace → token` map so
  an agent always writes to an explicitly chosen workspace.

## Rejected alternative: per-workspace Durable Object databases

Proposal: each workspace gets its own DO with a private SQLite database;
a central "control" D1 holds users/sessions/memberships and routes each request
to the right workspace DO. A complete reference implementation existed in
an earlier internal system (control D1 + a per-workspace DO, fail-closed router,
lazy additive-only per-DO migrations, hand-rolled daily snapshots to R2).

Why not for Derive:

- **Tenancy shape.** That system's tenant boundary came free from its
  Slack-shaped domain (one team = one workspace; users live in exactly one DO;
  no global identity). Derive is the
  inverse: users belong to multiple workspaces, everyone gets a personal
  workspace at signup, and the core surfaces are global — anonymous `/artifacts/:ref`
  links, `/users/` profiles, cross-workspace shares, eventually search. Each of those
  would need a control-plane index kept consistent with thousands of DOs.
- **Ops and global visibility** (the deciding argument in the thread): schema
  migrations are one statement on one database instead of a lazy fleet-wide
  rollout that must tolerate every historical schema version; support, billing
  metering, analytics, and one-off data fixes are single SQL queries instead of
  fan-outs or bespoke fleet tooling; managed Postgres gives point-in-time
  recovery out of the box (DO-SQLite has none — the earlier system had to build its own
  snapshot/restore).
- **Isolation was metadata-only anyway:** blobs stay in one shared R2 bucket in
  either design.
- **Ceilings:** a DO is single-threaded with a 10 GB cap; Derive's heaviest
  traffic is agent/CI publishing concentrated on a single workspace — the
  heaviest (paying) tenant hits the per-DO ceiling first.

What we adopted from the proposal: the workspace-bound token model
(per-workspace PAT semantics), which structurally prevents an agent publishing to the wrong
workspace — the failure actually observed while dogfooding.

## Revisit triggers

Reopen the per-workspace-DO (or other hard-isolation) question only when one of
these is concrete, not before:

1. An enterprise deal blocked on physically separated tenant data that a
   **dedicated single-tenant instance** (the existing Lite/Node container as a
   premium SKU) cannot satisfy.
2. A data-residency requirement (tenant data pinned to a region) that shared
   Postgres placement cannot satisfy.
3. Sustained Postgres scale pain (size, write throughput, or noisy-neighbor
   contention) that vertical scaling and read replicas do not resolve.

Nothing is thrown away if we shard later: central auth + memberships + routing
is exactly the control plane that architecture requires.

## Follow-ups

1. ~~Wire Postgres into the Workers entry.~~ Done 2026-07-02: Hyperdrive → Neon
   via `lib/edge-pg.ts`, live at derive.to; the deployment guide's "Cloudflare Scale" section documents
   it.
2. **Workspace-bound tokens, both halves.** Server: per-user workspace-scoped
   tokens (extend the `agent` token pattern; scope or retire the instance-wide
   `DERIVE_TOKEN`). Client: `workspace → token` config in the CLI and MCP server.
3. **CI for the hosted path.** A workerd/Miniflare D1 lane exists in `ci.yml`;
   extend coverage to the full worker entry and add a Workers+Postgres lane.
