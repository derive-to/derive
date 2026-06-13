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
(`packages/db/src/repos/*`, covers SQLite + D1) and once in the Postgres repos. The
`Exact<>` guards will fail typecheck if a schema drifts from the port.

## Commits & PRs

- Branch off `main`; never commit to `main` directly.
- Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`). Keep messages imperative and scoped.
- Open one focused PR per change; fill in the PR template. A green gate is required.
- Prose style: no em-dashes; use colons, periods, or parentheses.

## Tests

API behavior is covered by `apps/api/test/*` (vitest against `app.request()`, no
network). New routes get tests; bug fixes get a regression test. Hit a real
in-memory SQLite store rather than mocking the DB layer.
