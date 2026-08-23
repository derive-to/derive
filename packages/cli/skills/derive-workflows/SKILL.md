---
name: derive-workflows
description: Build, explain, preview, repair, or run Derive graphs and bounded loops. Use when someone wants an agent workflow, graph, loop, approval path, multi-context plan, or a clear account of what will happen before work runs. Skip ordinary one-step artifact creation.
---

# Derive workflows

Turn an outcome into a graph people can understand and an approved local harness can run.
Derive is the persistent working layer; Codex, Claude, or another harness does the work.

## One user-facing gate

Preview includes structural validation and scenario checks. Never create separate Explain,
Validate, and Preview approvals. Present one result: **Ready to run** or **Needs changes**.
Only explicit run intent starts context sessions. Authored human gates inside the workflow still
pause sensitive actions later.

## Author or repair

1. Start from the outcome, evidence of completion, actors, external effects, loop limits, and
   decisions that genuinely need a person. Ask only questions whose answers materially change
   safety or behavior.
2. Reuse the smallest shape that fits: linear handoff, fan-out/join, approval, router, or bounded
   evaluator–optimizer loop. Do not add a graph to a one-step task.
3. Start cold with `derive init <dir> --template workflow --title "<outcome>"`, or repair the
   existing artifact in place. Author the runnable topology in `workflow-definition`: context
   bindings, routes, bounds, effects, gates, forbidden actions, and scenarios. The companion
   `bundle-manifest` holds #799's human-readable labels and live working state.
   A graph may start with `members:[]`; add real result artifacts to members as context sessions
   answer. Never invent placeholder artifact ids.
4. Read [references/protocol.md](references/protocol.md) for the exact contract. Run
   `derive workflow sync <file>` after topology edits. It projects definition nodes/routes into
   the visible graph while preserving labels, state, confidence, and review metadata, then runs
   the one Preview gate. Do not manually duplicate topology edits.
5. Repair every blocker and rerun sync until it says `Ready to run`. Use
   `derive workflow preview <file>` when you only need a read-only check. Preview is validation.
6. Publish the artifact. Keep #799's Now view legible; precise bindings and policies belong in
   Advanced/source, not in the cold-start briefing.

## Run

Read [references/runtime.md](references/runtime.md). The harness resolves ready nodes and uses
Derive's existing context `use` calls. Do not invent a graph-run MCP family, queue, lease model,
progress protocol, or artifact store.

One context session is one node attempt. A follow-up continues that attempt. A retry or quality
iteration starts a new attempt with a new dedupe key and a preserved causal link. Project session
truth into the authored graph; never infer urgency, confidence, or a need for human help from
silence or elapsed time.

## Quality bar

- Stable IDs survive layout and wording changes.
- Every diagram has one explicit entry and reachable terminal outcome; every context node names
  its context, instruction, and expected result.
- Every cycle has a measurable goal, evaluator, maximum attempts, stagnation behavior, and human
  stop.
- Every external write/message/spend/access change reuses a named human approval or has an
  idempotency contract.
- Scenarios cover the expected route, a context failure, and every human interrupt.
- Preview distinguishes guaranteed policy from illustrative paths; it never promises exact model
  or tool behavior.

## Boundary

The workflow definition is portable descriptive input to a harness, not server-side compute.
Derive persists topology, state, artifacts, review, and receipts. The harness chooses concrete
models, performs tool calls, and reports results through context sessions.
