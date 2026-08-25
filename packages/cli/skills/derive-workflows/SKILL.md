---
name: derive-workflows
description: Build, explain, preview, repair, migrate, or run Derive graph and loop Contexts. Use for an agent workflow, graph, bounded loop, approval path, or multi-Context system. Skip ordinary one-step artifact creation.
---

# Derive graph and loop Contexts

Workflows is the product area. Context is the runnable identity. A Context pins an agent manifest
with kind `single`, `graph`, or `loop`; the latter two are agent-system shapes, not separate
workflow executors.

## Author or repair

1. Start from the outcome, completion evidence, reusable child Contexts, external effects, loop
   limits, and decisions that genuinely need a person.
2. Use the smallest shape that fits: linear handoff, fan-out/join, approval, conditional router,
   or bounded evaluator–optimizer loop.
3. Start with `derive init <dir> --template workflow --title "<outcome>"`. New scaffolds author
   one `derive.agent-manifest/v2` fact with one diagram. The companion `bundle-manifest` is only a
   visible projection using the same IDs.
4. Read [references/protocol.md](references/protocol.md), then run
   `derive workflow sync <file>`. Sync projects topology and runs the one Preview gate.
5. Repair until Preview says **Ready to run**. Existing `derive.workflow/v1` artifacts remain
   readable; adopt them from Workflows → Move existing instead of rewriting their bytes.
6. Publish and create/import the Context. Every execution target is that Context name or id.

## Run

Read [references/runtime.md](references/runtime.md). On explicit intent, call
`use({context, instruction, dedupe_key})` on the root graph/loop Context. The returned pinned
execution envelope is the source of truth for the whole run. Use ordinary child Context sessions
for node attempts and report explicit progress/result to the root. Do not invent another tool,
scheduler, queue, or state model.

## Quality bar

- One Context, one pinned manifest, one unambiguous diagram entry.
- Stable IDs; all nodes reachable; terminal result; exact and deterministic routes.
- Context nodes name Context, instruction, and result. Human options are distinct and explicit.
- Graph is acyclic. Loop has evaluator, integer attempt/stagnation bounds, optional time/cost
  bounds, and human stop.
- Consequential effects use a named human gate or replay-safe idempotency contract.
- Scenarios cover expected, context-failure, and every human-interrupt path.
- Silence never implies completion, approval, confidence, urgency, or help.

## Boundary

Derive persists immutable definitions, access, sessions, progress, results, and receipts. The
connected Codex, Claude, or other approved remote OAuth MCP harness performs local coordination.
The stdio compatibility server can inspect/publish but must refuse Context execution.
