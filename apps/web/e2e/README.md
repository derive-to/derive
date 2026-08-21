# e2e tests

Playwright end-to-end tests that drive the real web app against a real API.

## One suite: smoke

| Suite     | Path                | When            | Run                    |
| --------- | ------------------- | ---------------- | ----------------------- |
| **smoke** | `e2e/smoke.spec.ts` | manual (<2m)     | `pnpm test:e2e:smoke`  |

One file, a handful of independent tests, one fast critical path per surface:
auth, publish → comment → resolve → library, share, settings/theme. CI runs it
via `workflow_dispatch` only (`e2e-smoke.yml`) — not on every PR.

`pnpm test:e2e` runs it (plus the two special-purpose harnesses below). `pnpm
test:e2e:ui` opens the Playwright UI. `pnpm test:e2e:report` shows the last
HTML report.

## Running locally

Just run one of the commands above from `apps/web`. Each run boots its own API +
web servers, runs, and tears them down. No manual setup, and nothing touches your
`:3000` dev server.

Ports are derived from the worktree path (e.g. API `8769` / web `3769`), so every
worktree and agent gets its own and runs never collide. Override with
`PW_API_PORT` / `PW_WEB_PORT` if you ever need to pin them.

## How it stays stable

- **Isolation**: the API runs with `DERIVE_MULTI_WORKSPACE=true`, so every signup
  owns a private workspace. Workspace-scoped data never crosses between tests,
  which is what lets the whole thing run `fullyParallel`. See `playwright.config.ts`.
- **Fixtures** (`fixtures.ts`): `owner` (a fresh signed-up user) and `secondUser`
  (a second user in their own browser context) are the auth/seed layer. Tests
  declare what they need; no per-test signup boilerplate.
- **Helpers** (`helpers.ts`): `signUp`, `publishArtifact`, `openArtifact`,
  `addComment`, `activateThread`, `shareArtifact`. Unique-per-worker
  emails (UUID), and API calls wrapped in `expect(...).toPass()` for
  eventual-consistency, not arbitrary waits.
- **Test-ids everywhere**: selectors are `getByTestId(...)` against stable
  `data-testid`s, never brittle text/role/CSS lookups. `testIdAttribute` is set
  in the config.
- **Web-first assertions**: `await expect(locator).toBeVisible()` etc. auto-retry,
  so there are no manual `waitForTimeout`s.

## Conventions for new tests

1. Import `{ test, expect, ... }` from `./fixtures`, not `@playwright/test`.
2. Take the `owner` / `secondUser` fixture instead of signing up by hand.
3. Drive the UI through `getByTestId`. If a needed element has no test-id, add one.
4. Assert with web-first `expect`; never sleep.
5. This is deliberately a basic gate, not an exhaustive regression suite — a new
   test earns a spot here only if it's a fast, load-bearing happy path. Anything
   deeper (edge cases, one surface in depth) belongs in its own focused file
   rather than growing this back into a tiered smoke/deep split.

`pnpm test:e2e:typecheck` typechecks the specs (they have their own `tsconfig.json`).

## Other harnesses in this directory (not part of the smoke gate)

- **`render-fidelity/`** — pins the artifact sandbox CSP's real-world
  permissiveness against real fixture content. Hits a real external CDN, so it's
  CI-triggered on a narrow path scope (`e2e-fidelity.yml`), not every PR. Run:
  `pnpm test:e2e:fidelity`.
- **`screens/`** — a visual-QA capture harness (not a test gate): seeds a
  realistic workspace and screenshots the real, auth-walled dashboard across
  themes + viewports. Specs self-skip unless `SHOTS=1`, so a bare `playwright
  test` never runs them. Use: `SHOTS=1 npx playwright test --project=screens`.
