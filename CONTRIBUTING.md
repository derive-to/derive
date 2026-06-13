# Contributing to Dock

Thanks for helping build Dock. This guide covers local setup, the checks your change
must pass, and how we structure commits and PRs.

## Setup

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev          # API on http://localhost:8080 (SQLite + local disk, zero config)
```

By default the API uses embedded SQLite and the local filesystem — no external
services. Postgres + S3/R2 are opt-in via env (see [DEPLOY.md](DEPLOY.md)).

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
  the Workers/edge path.
- **One authorization gate.** All access checks go through
  `can(actor, action, visibility)` in `packages/core/src/permissions.ts`. Resolve an
  `Actor` and ask it; don't hand-roll role checks in routes.

Adding a `MetaStore` method? Implement it once in the shared sqlite repos
(`packages/db/src/repos.ts`, covers SQLite + D1) and once in the Postgres driver
(`pg.ts`). The `implements MetaStore` annotation fails typecheck if a driver misses one.

## Guardrails (you don't have to remember these — the tooling does)

The invariants above are machine-enforced, so a mistake fails the gate instead of
shipping. If something below surprises you, that's the guardrail doing its job:

- **Forgotten `await`.** A floating promise in `apps/api` or the backend packages is a
  lint error (`noFloatingPromises`). `void` it deliberately or handle it.
- **`console.*` in the server.** Lint error outside the logger and the process entry —
  use `log` (`apps/api/src/log.ts`).
- **DB drivers in routes/lib.** Importing `drizzle-orm`, a driver, or `@dock/db/*` from
  `routes/*` or `lib/*` is a lint error. Reach the database through `ctx.meta` (the
  `MetaStore` port); add a store method instead.
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
- **Untestable UI.** An interactive control (`button`/`input`/`select`/`textarea` or shadcn
  `Button`/`Input`/`Textarea`/`DropdownMenuItem`) in `pages/` or `components/shared/`
  without a `data-testid` fails `pnpm lint:testids`. Add a surface-scoped id, or
  `testid-ignore` a non-assertable control. (`ui/` primitives are exempt.)

The frontend checks (`lint:tokens`, `lint:frontend`, `lint:testids`) and Biome all run
inside `pnpm run ci`, so the one gate command covers them; `pnpm typecheck` and `pnpm test`
(which includes the authz-coverage test) complete it.

## Commits & PRs

- Branch off `main`; never commit to `main` directly.
- Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`). Keep messages imperative and scoped.
- Open one focused PR per change; fill in the PR template. A green gate is required.
- Prose style: no em-dashes; use colons, periods, or parentheses.

## Tests

API behavior is covered by `apps/api/test/*` (vitest against `app.request()`, no
network). New routes get tests; bug fixes get a regression test. Hit a real
SQLite store rather than mocking the DB layer.

```bash
pnpm test       # the suite on embedded SQLite (zero-config), the first CI job
pnpm test:pg    # the SAME suite on a real Postgres (ephemeral Docker container)
```

`pnpm test:pg` ([scripts/test-pg.sh](scripts/test-pg.sh)) points the harness at
Postgres with `DOCK_TEST_DB=pg` + `TEST_DATABASE_URL` (each test app gets an isolated
schema), so the hosted-tier driver is verified by the full behavioral suite, not just
typecheck. CI runs both jobs. Requires Docker.
