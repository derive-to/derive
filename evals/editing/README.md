# Editing self-improvement loop

This eval turns failures found in real artifacts into permanent, executable editing
contracts. It covers the whole save path for Markdown, HTML, decks, videos, and
element operations without treating a cleared toolbar as proof that source was saved.

## Run it

```bash
pnpm test:editing                 # deterministic core + API lanes
pnpm test:editing:regression      # important cases across core + API + real browser
pnpm test:editing -- --lane core  # one lane while iterating
pnpm test:editing:full            # every regression + extended chaos case in every lane
pnpm test:editing -- --list       # manifest inventory
pnpm test:editing -- --json       # machine-readable result for an agent/reviewer
```

`corpus.json` is the ledger. Every scenario has a stable id, risk tier, surface,
oracle, cadence, and executable source file. The runner refuses duplicate ids, missing source
files, or scenarios whose id is absent from their owning test. A scenario therefore
cannot be documented without also being enforced.

`regression` cadence is for deterministic P0/P1 cases that should stay cheap enough to
run continuously. `extended` cadence is for scale, fuzz, and expensive chaos probes. The
default command keeps the tight core/API loop; the regression command adds important real
browser behavior; the full command runs both cadences across all lanes.

## Loop policy

- Goal: make rendered editing preserve user intent and unrelated source bytes across
  every supported artifact language.
- Evaluate: run the deterministic lanes, then have independent Luna agents explore one
  surface each and return minimized counterexamples with source, edit payload, expected
  result, actual result, and risk.
- Improve: reproduce a finding locally, add its stable scenario id to the manifest and
  a failing test, make the smallest safe fix, then rerun the affected lane.
- Promote: a finding enters the corpus only when it is deterministic, minimized, and
  has an oracle stronger than “the UI looked right.” Prefer exact source equality,
  atomic no-change, stable identity, or a specific refusal reason.
- Stop: two consecutive exploration rounds find no new reproducible P0/P1/P2 failures,
  every manifest scenario passes, the browser lane passes, and `pnpm verify` is green.

There is deliberately no arbitrary iteration count. The evaluator stops on evidence,
not because a loop counter expired.

## Luna roles

Use `gpt-5.6-luna` for the high-volume exploration passes. Run at least three roles in
parallel when the work divides cleanly:

1. Markdown explorer: source/render mapping, GFM, Unicode, duplicate context, and scale.
2. HTML explorer: inline/structural boundaries, malformed markup, sanitization, and DOM
   selection behavior.
3. Deck explorer: text plus slide/scene/element operations, identity, order, and stale
   versions.

Each explorer is read-only until it reports a reproducible counterexample. A separate
implementer owns the fix. After a change, rotate surfaces or prompts so the same agent
does not merely confirm its own assumptions.

## Required finding format

```json
{
  "surface": "markdown | html | deck | video | element | pipeline | browser",
  "risk": "P0 | P1 | P2 | P3",
  "source": "complete minimal source",
  "operation": "complete edit payload or browser gesture",
  "expected": "exact source/result/refusal",
  "actual": "exact source/result/error",
  "invariant": "why this must always hold",
  "minimized": true
}
```

Reject findings that depend on timing sleeps, private production data, a visual hunch,
or an edit that the product explicitly does not support. Recreate real reports with a
small synthetic fixture and keep the original artifact untouched.
