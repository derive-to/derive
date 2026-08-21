# Working in this repo (humans and agents)

Derive leans on a **deterministic gate** rather than on remembering conventions. The
rules that matter are machine-enforced, so a mistake fails the build instead of
shipping. Before you call a change done:

```bash
pnpm verify        # exactly what CI's `check` job runs, in the same order
```

which is these three, and you can run them one at a time while iterating:

```bash
pnpm run ci        # biome + every custom guardrail, run concurrently (~5s)
pnpm typecheck     # tsgo across the workspace
pnpm test          # vitest against the embedded SQLite store
```

The pre-push hook runs `pnpm verify:affected`: the same gate, with typecheck and tests
scoped to the packages your branch changed and their dependents. CI runs the full
`pnpm verify` on every push.

`check` is the big gate but not the only one: CI also runs a gitleaks secret scan,
the Postgres and D1 store contracts against real engines, and the bundle and runner
image builds. Those need services or a network, so they stay in CI. A green
`pnpm verify` means the check job will pass, not that every job will. A test fixture
that reads like a credential is the usual way the secret scan bites; mark it with an
inline `gitleaks:allow` and say why.

A green gate is the bar. Don't work around a guardrail. Fix the code it points at,
or use the rule's documented escape hatch (an inline comment such as `authz-exempt:`,
`tokens-ignore`, `frontend-ignore`, or `testid-ignore`) only when the exception is
genuinely correct, with a reason.

The full list of what's enforced and why is in
[CONTRIBUTING.md → Guardrails](CONTRIBUTING.md#guardrails-enforced-by-the-tooling).
Highlights:

- Every mutating route gates on auth; colors and text sizes come from the token system,
  not hardcoded; no non-null assertions; storage keys and interactive-control test-ids are
  centralized / required.
- The backend reaches the database only through `ctx.meta` (the `MetaStore` port), never a
  driver; server code logs through `log`, not `console`.

When you add a capability that a future change could silently regress, prefer adding a
guardrail (a Biome rule, a `scripts/check-*.mjs`, or a test) over a note in a doc: an
agent can ignore an instruction or a review comment, but it cannot ignore a red build.

The bar for a test is in [CONTRIBUTING.md → Tests](CONTRIBUTING.md#tests): it pins a
contract through the surface a user or agent actually uses, and it lives in the file
that already owns the feature. A new test file per change is the wrong default: in
`apps/api` every store-backed file re-boots the whole app, so file count, not case
count, is what makes the suite slow.
