# e2e tests

Playwright end-to-end tests that drive the real web app against a real API.

## Two suites

| Suite     | Path          | When                  | Run                       |
| --------- | ------------- | --------------------- | ------------------------- |
| **smoke** | `e2e/smoke/`  | post-merge gate (<2m) | `pnpm test:e2e:smoke`      |
| **deep**  | `e2e/deep/`   | nightly / pre-deploy  | `pnpm test:e2e:deep`       |

- **smoke**: one critical happy path per surface. Fast, broad, shallow.
- **deep**: every surface in depth (comment system, review flow, settings tabs,
  share roles, library search/favorites/collections) plus a responsive pass.

`pnpm test:e2e` runs both. `pnpm test:e2e:ui` opens the Playwright UI.
`pnpm test:e2e:report` shows the last HTML report.

## How it stays stable

- **Isolation**: the API runs with `DOCK_MULTI_WORKSPACE=true`, so every signup
  owns a private workspace. Workspace-scoped data never crosses between tests,
  which is what lets the whole thing run `fullyParallel`. See `playwright.config.ts`.
- **Fixtures** (`fixtures.ts`): `owner` (a fresh signed-up user) and `secondUser`
  (a second user in their own browser context) are the auth/seed layer. Tests
  declare what they need; no per-test signup boilerplate.
- **Helpers** (`helpers.ts`): `signUp`, `publishArtifact`, `openArtifact`,
  `addComment`, `proposeEdit`. Unique-per-worker emails (UUID), and API calls
  wrapped in `expect(...).toPass()` for eventual-consistency, not arbitrary waits.
- **Test-ids everywhere**: selectors are `getByTestId(...)` against stable
  `data-testid`s, never brittle text/role/CSS lookups. `testIdAttribute` is set
  in the config.
- **Web-first assertions**: `await expect(locator).toBeVisible()` etc. auto-retry,
  so there are no manual `waitForTimeout`s.

Stability is validated by running each suite repeatedly: `--repeat-each=5` (smoke)
and `--repeat-each=3` (deep) come back fully green.

## Conventions for new tests

1. Import `{ test, expect, ... }` from `../fixtures`, not `@playwright/test`.
2. Take the `owner` / `secondUser` fixture instead of signing up by hand.
3. Drive the UI through `getByTestId`. If a needed element has no test-id, add one.
4. Assert with web-first `expect`; never sleep.
5. A new file goes in `smoke/` only if it is a fast, load-bearing happy path;
   everything else is `deep/`.

`pnpm test:e2e:typecheck` typechecks the specs (they have their own `tsconfig.json`).
