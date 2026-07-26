# Contributing to Derive

Thanks for helping build Derive. This guide covers local setup, the checks your change
must pass, and how we structure commits and PRs.

## Setup

Requires Node 24+ and pnpm 10+.

The dev stack is two servers — run both with one command:

```bash
pnpm install
pnpm dev:all      # API on :8090 + web UI on :3090 → open http://localhost:3090

# or run them separately:
#   pnpm dev       # API    → http://localhost:8090  (SQLite + local disk, zero config)
#   pnpm dev:web   # web UI → http://localhost:3090
```

The API alone serves only a placeholder page; the web UI proxies its API calls,
so open the web port. (Container/deploy builds serve both from one origin on 8080.)

By default the API uses embedded SQLite and the local filesystem — no external
services. Postgres + S3/R2 are opt-in via env: copy `.env.example` to `.env`
(git-ignored, auto-loaded in dev) and fill in what you need. See [DEPLOY.md](DEPLOY.md).

## The gate

Every change must pass all three before it's pushed. CI runs the same checks.

```bash
pnpm typecheck            # tsgo across all packages
pnpm exec biome ci .      # lint + format check — must report 0 errors
pnpm test                 # vitest across all packages
```

Quick fixes:

```bash
pnpm check:fix            # auto-fix lint + format
pnpm format               # format only
```

## Code style

Enforced by [Biome](https://biomejs.dev) (`biome.json`) — run `pnpm check:fix` and
it mostly takes care of itself:

- Arrow functions, **no semicolons**, 100-char line width, double quotes, 2-space indent.
- No `any`. Use `import type { … }` for type-only imports.
- Kebab-case filenames. Organized imports.
- Use the structured logger, not `console.log`.

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) first. Two rules matter most:

- **The dependency rule.** `packages/core` depends on nothing internal; everything
  depends inward on it. `core` owns the `MetaStore`/`BlobStore` ports; `db`/`storage`
  provide adapters. Don't import a sibling app, and never pull Node-only code into
  the Workers/edge path. Machine-enforced by `pnpm lint:boundaries` (see Guardrails).
- **One authorization gate.** All access checks go through
  `can(actor, action, visibility)` in `packages/core/src/permissions.ts`. Resolve an
  `Actor` and ask it; don't hand-roll role checks in routes.

Adding a `MetaStore` method? Declare it on the relevant feature sub-port in
[`ports.ts`](packages/core/src/ports.ts) (`ArtifactStore`, `CommentStore`, `ReviewStore`,
… — `MetaStore` composes all of them), then implement it once in the shared sqlite repos
(`packages/db/src/repos.ts`, covers SQLite + D1) and once in the Postgres driver
(`pg.ts`). The `implements MetaStore` annotation fails typecheck if a driver misses one.

## Guardrails (you don't have to remember these — the tooling does)

The invariants above are machine-enforced, so a mistake fails the gate instead of
shipping. If something below surprises you, that's the guardrail doing its job:

- **Forgotten `await`.** A floating promise in `apps/api` or the backend packages is a
  lint error (`noFloatingPromises`). `void` it deliberately or handle it.
- **`console.*` in the server.** Lint error outside the logger and the process entry —
  use `log` (`apps/api/src/log.ts`).
- **DB drivers in routes/lib.** Importing `drizzle-orm`, a driver, or `@derive/db/*` from
  `routes/*` or `lib/*` is a lint error. Reach the database through `ctx.meta` (the
  `MetaStore` port); add a store method instead.
- **Cross-package boundaries.** The dependency rule is machine-enforced by
  `pnpm lint:boundaries` (dependency-cruiser, `.dependency-cruiser.mjs`): `core` may import
  nothing in-repo, `db`/`storage` depend only on `core`, the clients (`web`/`cli`/`mcp`/
  `runner`) hold no runtime `@derive/core` import, and there are no import cycles. A
  violation — or a new cycle — fails the gate.
- **Config completeness.** `pnpm lint:env` (`scripts/check-env.mjs`) fails if a config var
  the server reads is missing from `.env.example`, or a var documented there is read
  nowhere. `.env.example` is therefore the full, honest list — it can't quietly go
  incomplete or advertise a setting the code ignores. A binding/platform var that isn't
  self-host config is listed in the script's `NON_CONFIG` set. (Half-configured optional
  features — an OAuth id without its secret — warn loudly at boot and fail `derive doctor`,
  from the capability model in `apps/api/src/capabilities.ts`.)
- **Schema parity + exhaustiveness.** Every drizzle table must be classified in
  `packages/db/src/parity.ts` (typed-and-shape-checked against its core Record, or named
  a junction). Add a table without classifying it and typecheck fails. A column that
  drifts from its Record fails too.
- **DDL drift.** `packages/db/test/schema-conformance.test.ts` boots a real DB from the
  raw `SCHEMA_STATEMENTS`/`MIGRATION_STATEMENTS` and asserts every drizzle column exists
  in the table that's actually created — so a column in the type but missing from the
  DDL goes red.
- **Postgres behavioral drift.** The full `apps/api` suite also runs against a real
  Postgres in CI (`pnpm test:pg`), so a pg driver bug (a wrong query, a missing org
  scope) fails a test, not just a typecheck.
- **Destructive DDL.** The schema sources are re-applied at boot, so a `DROP TABLE` /
  `DROP COLUMN` / `TRUNCATE` / `DELETE FROM` in `packages/db/src/schema.ts`
  (`SCHEMA_STATEMENTS`/`MIGRATION_STATEMENTS`) or `pg-schema.ts` (`PG_SCHEMA_STATEMENTS`)
  would wipe data on every restart — it fails `pnpm lint:schema`. Evolve by adding
  (expand/contract), deprecating a column in place; a deliberate, reviewed removal opts out
  with a `schema-ignore` comment. See [Database migrations](#database-migrations).
- **Event names.** Bus and webhook event names come from one list
  (`apps/api/src/events.ts`); a typo or a webhook event the bus doesn't know about is a
  compile error.
- **Missing auth check.** Every mutating route (`POST`/`PUT`/`PATCH`/`DELETE`) must gate on
  identity or permission. A handler that references no authz helper (`authorize`,
  `workspaceCan`, `collectionRole`, `ensureMembership`, `currentUser`, …) fails
  `apps/api/test/authz-coverage.test.ts`. A genuinely public mutation opts out with an
  `authz-exempt: <reason>` comment on its route line.
- **Hardcoded colors or text sizes.** In `apps/web`, a hex, an `rgb()`/`hsl()`, a raw
  Tailwind palette color (`bg-red-500`), an arbitrary color (`bg-[#abc]`), or an absolute
  font size (`text-[14px]`, inline `fontSize`) fails `pnpm lint:tokens`. Colors and sizes
  come from the token system in `apps/web/src/styles/globals.css` (semantic utilities + the
  `text-*` scale). Raw-color data files (the logo, the avatar palette, the theme swatches)
  are allow-listed; a one-off uses a `tokens-ignore` comment.
- **Non-null assertions.** `x!` is a lint error repo-wide (`noNonNullAssertion`) — narrow
  the value instead of asserting the null away.
- **Hardcoded storage keys.** A `localStorage`/`sessionStorage` call keyed by a string
  literal fails `pnpm lint:frontend`; keys live in `apps/web/src/lib/storage-keys.ts`
  (`STORAGE_KEYS`).
- **Raw full-page reloads.** `location.reload()`/`location.assign()` in `apps/web` fails
  `pnpm lint:reload` (`scripts/check-workspace-reload.mjs`). A hard navigation after the
  active workspace changes must flag the next boot to drop the persisted query cache —
  otherwise the restore rehydrates the old workspace's data — so it goes through
  `reloadAfterWorkspaceChange` (`apps/web/src/lib/persist.ts`). A genuinely
  non-workspace reload opts out with a `reload-ignore` comment. (Auth/external
  redirects via `location.href = url` are a different gesture and stay allowed.)
- **Untestable UI.** An interactive control (`button`/`input`/`select`/`textarea` or shadcn
  `Button`/`Input`/`Textarea`/`DropdownMenuItem`) in `pages/` or `components/shared/`
  without a `data-testid` fails `pnpm lint:testids`. Add a surface-scoped id, or
  `testid-ignore` a non-assertable control. (`ui/` primitives are exempt.)
- **Ad-hoc error responses.** A route that returns `c.json({ error }, status)` directly
  fails `pnpm lint:api`. Return `fail(c, status, message)` (`apps/api/src/lib/http.ts`) so
  the error shape stays one thing.
- **Unvalidated request bodies.** A route that reads `c.req.json()` directly fails
  `pnpm lint:api`. Parse + validate with `readJson(c, schema)` (`apps/api/src/lib/http.ts`,
  zod) so a new or renamed field can't slip past validation; it returns the typed data or a
  400 you return as-is (`if (body instanceof Response) return body`).
- **Dead code + unused dependencies.** `pnpm lint:deadcode` (knip) fails on an unused file
  or a dependency in a `package.json` that nothing imports. Entry points (the Workers entry,
  codegen scripts) and the `ui/` primitive library are declared in `knip.json`; it checks
  files + dependencies only (not every unused export, to leave the design-system surface
  alone).

The custom checks (`lint:tokens`, `lint:frontend`, `lint:testids`, `lint:api`, `lint:schema`,
`lint:hyperdrive`, `lint:boundaries`, `lint:env`, `lint:deadcode`) and Biome all run inside
`pnpm run ci`, so the one gate command covers them; `pnpm typecheck` and `pnpm test` (which
includes the authz-coverage test) complete it.

## Database migrations

Derive evolves the schema with **forward-only, idempotent DDL applied at boot** — no migration
framework, so a fresh self-host is one command. The trade-off is that the same statements
re-run on every start, so they must be additive (see the destructive-DDL guard above) and
idempotent. The model is small but spread across a few files; the guards below catch anything
you miss.

- **SQLite/D1** ([packages/db/src/schema.ts](packages/db/src/schema.ts)): tables in
  `SCHEMA_STATEMENTS` use `CREATE TABLE IF NOT EXISTS`; a new column on an existing table goes
  in `MIGRATION_STATEMENTS` as a plain `ALTER TABLE … ADD COLUMN` (SQLite has no per-column
  `IF NOT EXISTS`, so the boot runner swallows the "duplicate column" throw).
- **Postgres** ([packages/db/src/pg-schema.ts](packages/db/src/pg-schema.ts)):
  `PG_SCHEMA_STATEMENTS` mirrors it with `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE …
  ADD COLUMN IF NOT EXISTS`.
- **D1**: `deploy/d1-schema.sql` is generated from `SCHEMA_STATEMENTS` — never hand-edit it;
  run `pnpm --filter @derive/db gen:d1-schema`. D1 can't apply schema at boot (the edge forbids
  the `sqlite_master` introspection the Node tier uses), so `pnpm deploy` runs
  [apply-d1-schema.mjs](apps/api/scripts/apply-d1-schema.mjs) first: it creates missing
  tables/indexes, then diffs each live table's columns and `ADD COLUMN`s the missing ones — so
  an existing D1 (yours or a self-hoster's) picks up new columns on the next deploy.

**A new column must be nullable or carry a constant `DEFAULT`.** SQLite/D1 reject `ADD COLUMN`
of a `NOT NULL` column with no default on a populated table, so a `NOT NULL`-without-default add
would break every existing database. `apply-d1-schema.mjs` refuses such an add and aborts the
deploy before touching the DB (planning logic + tests:
[d1-schema-plan.mjs](apps/api/scripts/d1-schema-plan.mjs)). Need a non-null column? Add it
nullable (optionally backfill, then tighten in a later, separately-reviewed change).

**Adding a column:**

1. Add the field to the `@derive/core` Record (+ its `New*` input) in
   [packages/core/src/ports.ts](packages/core/src/ports.ts).
2. Add it to the drizzle table in **both** `schema.ts` and `pg-schema.ts` (the parity guard
   fails the typecheck if a dialect, or the Record, drifts).
3. Add the column to the DDL: `SCHEMA_STATEMENTS` + `MIGRATION_STATEMENTS` (sqlite) and
   `PG_SCHEMA_STATEMENTS` (pg). The conformance tests
   ([schema-conformance.test.ts](packages/db/test/schema-conformance.test.ts), and
   [pg-schema-conformance.test.ts](packages/db/test/pg-schema-conformance.test.ts) under
   `pnpm test:pg`) go red if the live table's columns don't match the drizzle defs.
4. Run `pnpm --filter @derive/db gen:d1-schema` to regenerate `deploy/d1-schema.sql`.

**Removing or renaming** is the unsafe path: prefer expand/contract — add the new shape,
move reads/writes over, and leave the old column unused — over a `DROP`. An actual drop is a
separate, deliberately-reviewed change that opts past `lint:schema` with a `schema-ignore`
comment.

## Commits & PRs

- Branch off `main`; never commit to `main` directly.
- Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`). Keep messages imperative and scoped.
- Open one focused PR per change; fill in the PR template. A green gate is required.
- Prose style: no em-dashes; use colons, periods, or parentheses.

A note on CI runners: workflows in this repo run on Ubicloud runners
(`runs-on: ubicloud-standard-*`), which are only available in the upstream repository. A
PR you open against this repo runs CI normally (a maintainer approves the first run for
new contributors), but pushes to your own fork will show those jobs queued forever:
that's expected, not a broken setup. Run the gate locally (`pnpm run ci`, `pnpm
typecheck`, `pnpm test:coverage`) instead — or, in a fork you control, swap the labels
for `ubuntu-latest`, which is the only coupling to the provider.

## Tests

API behavior is covered by `apps/api/test/*` (vitest against `app.request()`, no
network). New routes get tests; bug fixes get a regression test. Hit a real
SQLite store rather than mocking the DB layer.

```bash
pnpm test       # the suite on embedded SQLite (zero-config), the first CI job
pnpm test:pg    # the SAME suite on a real Postgres (ephemeral Docker container)
```

`pnpm test:pg` ([scripts/test-pg.sh](scripts/test-pg.sh)) points the harness at
Postgres with `DERIVE_TEST_DB=pg` + `TEST_DATABASE_URL` (each test app gets an isolated
schema), so the hosted-tier driver is verified by the full behavioral suite, not just
typecheck. CI runs both jobs. Requires Docker.
