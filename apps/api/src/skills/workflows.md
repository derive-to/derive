---
name: workflows
summary: typed graph/loop Contexts: author, preview, run
order: 5.5
---
# Typed graph and loop Contexts

Use this when a person asks for a workflow, graph, bounded loop, approval path, or multi-Context
agent system. Do not turn an ordinary one-step task into a graph.

## Mental model

- **Workflows** is the product area.
- **Context** is the only runnable address.
- A Context pins one `derive.agent-manifest/v2` with kind `single`, `graph`, or `loop`.
- Graph and Loop are agent-system shapes, not separate artifact or scheduler entities.
- Derive stores immutable definitions, access, sessions, progress, results, and receipts. The
  connected Claude, Codex, or other local OAuth MCP client coordinates graph/loop work.

Use the existing `use` tool. Never invent a graph-run tool family, server scheduler, second queue,
or parallel state model.

## Author

Create one HTML manifest artifact with an `agent-manifest` fact. A composite manifest owns exactly
one diagram, so one Context always has one unambiguous entry contract. `bundle-manifest` is an
optional visible projection using the same stable diagram/node IDs; it never controls routing.

```json
{
  "schema": "derive.agent-manifest/v2",
  "kind": "loop",
  "purpose": "Build and publish a reviewed weekly brief",
  "title": "Weekly brief",
  "labels": {
    "research": "Research signals",
    "evaluate": "Quality check",
    "publish": "Publish brief"
  },
  "forbidden": ["Publish outside this workspace", "Continue past loop bounds"],
  "diagram": {
    "id": "weekly-brief",
    "entry": "research",
    "nodes": [
      {
        "id": "research",
        "kind": "context",
        "context_ref": "signal-researcher",
        "instruction": "Produce this week's evidence-backed brief.",
        "result": "A cited draft brief"
      },
      {
        "id": "evaluate",
        "kind": "context",
        "context_ref": "brief-quality-checker",
        "instruction": "Return ready or revise with evidence.",
        "result": "A grounded ready-or-revise decision",
        "routing": "one"
      },
      {
        "id": "publish",
        "kind": "context",
        "context_ref": "brief-publisher",
        "instruction": "Publish the ready brief.",
        "result": "A published Derive artifact",
        "terminal": true,
        "effects": [{
          "kind": "write",
          "description": "Publish the weekly brief to Derive",
          "gate": "none",
          "idempotency": "One version for this node attempt"
        }]
      }
    ],
    "routes": [
      {"from":"research","to":"evaluate","when":"always"},
      {"from":"evaluate","to":"research","when":"revise","fallback":true},
      {"from":"evaluate","to":"publish","when":"ready"}
    ],
    "loops": [{
      "id": "brief-repair",
      "nodes": ["research", "evaluate"],
      "goal": "Reach the evidence and clarity bar",
      "evaluate": "Check evidence, clarity, and scope",
      "stop": {
        "max_attempts": 2,
        "stagnation_limit": 1,
        "max_minutes": 20,
        "human_stop": "The person stops or changes the brief"
      }
    }],
    "scenarios": [
      {"id":"expected","kind":"expected","path":["research","evaluate","publish"],"outcome":"Ready brief is published"},
      {"id":"failure","kind":"failure","path":["research"],"outcome":"Failure remains visible"},
      {"id":"revision","kind":"expected","path":["research","evaluate","research","evaluate","publish"],"outcome":"One bounded revision lands"}
    ]
  }
}
```

Run `derive workflow sync <file>` after topology edits. It projects nodes/routes into the visible
bundle while preserving labels and working state, then runs the one Preview gate. New CLI
scaffolds write v2; existing `derive.workflow/v1` artifacts remain readable and importable.

## Preview invariants

- Return one result: **Ready to run** or **Needs changes**. Preview starts no sessions.
- `context` nodes require `context_ref`, `instruction`, and `result`; `human` nodes require a
  decision, at least two distinct options, and resume instruction; terminal work declares result.
- One entry; all nodes reachable; at least one terminal; no routes out of terminals.
- Multiple unconditional routes use `routing:"all"`. Conditional choice uses `routing:"one"`,
  unique normalized predicates, and exactly one fallback.
- `kind:"graph"` is acyclic and carries no loop policy. `kind:"loop"` has a cycle covered by an
  evaluator, integer attempt/stagnation bounds, optional time/cost bounds, and human stop.
- External effects are explicit. Non-read effects require either a named human gate or an
  idempotency contract. Silence never implies approval, completion, or a need for help.
- Scenarios cover the expected path, context failure, and each human interruption.

## Run

Only explicit user intent starts a run. Call the root Context once:

```text
use({
  context: "Weekly brief",
  instruction: "Build the brief for the August launch",
  dedupe_key: "august-launch-weekly-brief"
})
```

For graph/loop Contexts, `use` returns `derive.local-workflow-run/v1`: the exact manifest version,
root instruction, diagram, bounds, forbidden actions, node dedupe template, and report contract.
That root session starts `working` and is driven only by the OAuth human who opened it.

Then:

1. Walk only nodes that are ready under the returned pinned diagram.
2. For each context-node attempt, call ordinary `use({context: node.context_ref, instruction,
   dedupe_key})`. A check/follow-up reuses its `session_id`; a retry increments the attempt.
3. Report honest root progress with `use({session_id: root, answer, progress:true})`.
4. Stop at human/effect gates and ask the person explicitly. Never infer a choice from silence.
5. Settle the root with `answer`, optional `result_artifact_id`, and state
   `answered|escalated|failed`.

The root remains pinned if the Context publishes a newer manifest mid-run. If the local harness
stops reporting, Derive fails the abandoned root explicitly; it never fabricates success.

## Migration and compatibility

Workflows lists Contexts and filters by single, graph, or loop. “Move existing” performs a dry
run, preserves artifact URLs/history, imports each legacy diagram as a Context, keeps invalid
items visible with blockers, and is safe to repeat. The old artifact facts remain a read-only
compatibility source until a later cleanup.

The local stdio MCP can inspect and publish manifests but does not expose `use`; it must refuse
execution and direct the person to the remote OAuth MCP at `https://derive.to/mcp`.
