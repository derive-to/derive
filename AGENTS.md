# Working in this repo (humans and agents)

Dock leans on a **deterministic gate** rather than on remembering conventions. The
rules that matter are machine-enforced, so a mistake fails the build instead of
shipping. Before you call a change done:

```bash
pnpm run ci        # biome + the design-token / frontend / test-id checks
pnpm typecheck     # tsgo across the workspace
pnpm test          # vitest (embedded SQLite) — includes the authz-coverage guard
```

A green gate is the bar. Don't work around a guardrail — fix the code it points at,
or use the rule's documented escape hatch (an inline comment such as `authz-exempt:`,
`tokens-ignore`, `frontend-ignore`, or `testid-ignore`) only when the exception is
genuinely correct, with a reason.

The full list of what's enforced and why is in
[CONTRIBUTING.md → Guardrails](CONTRIBUTING.md#guardrails-you-dont-have-to-remember-these--the-tooling-does).
Highlights:

- Every mutating route gates on auth; colors and text sizes come from the token system,
  not hardcoded; no non-null assertions; storage keys and interactive-control test-ids are
  centralized / required.
- The backend reaches the database only through `ctx.meta` (the `MetaStore` port), never a
  driver; server code logs through `log`, not `console`.

When you add a capability that a future change could silently regress, prefer adding a
guardrail (a Biome rule, a `scripts/check-*.mjs`, or a test) over a note in a doc. The
plan behind this approach is `docs/plans/ai-guardrails.html`.
