# Workflow definition protocol

Read this when authoring or repairing a Derive graph or loop.

## Two facts, one model

The artifact is ordinary single-file HTML. Its visible graph and working state remain the shipped
`bundle-manifest` contract. A companion `workflow-definition` fact adds preflight and execution
meaning without changing #799's state semantics.

`workflow-definition` is the authoring source for diagram IDs, node IDs, and routes. Run
`derive workflow sync <file>` to project that topology into `bundle-manifest`; it preserves
human-readable labels and authored working state on matching stable IDs, then runs Preview.
`derive workflow preview` is the read-only check and refuses any remaining drift.

Think **same IDs, different jobs**: `bundle-manifest` is what people see; `workflow-definition` is
what the harness needs. A graph may begin with `members:[]`. Add real result artifacts to members
and set `node.member` only after a context returns one—never use a fake placeholder id.

The authoring agent writes one concise `note` for every visible node. Generate it from that node's
job, instruction, and result, but phrase it as a standalone description a person can edit. Workflow
metadata remains available to the harness; the note is the only explanation the detail panel needs.

```html
<script type="application/derive-facts" data-fact="bundle-manifest">
{
  "schema": "derive.linked-bundle/v1",
  "purpose": "Build and publish a weekly signal brief",
  "members": [],
  "diagrams": [{
    "id": "weekly-signal",
    "title": "Weekly signal brief",
    "type": "graph",
    "nodes": [
      {"id":"research","label":"Research signals","state":"pending","note":"Find and organize the strongest evidence for this week's brief."},
      {"id":"evaluate","label":"Quality check","state":"pending","note":"Check the draft against the evidence and clarity bar, then choose ready or revise."},
      {"id":"publish","label":"Publish brief","state":"pending","note":"Publish the approved brief to the current Derive workspace."}
    ],
    "edges": [
      {"from":"research","to":"evaluate","label":"draft ready"},
      {"from":"evaluate","to":"research","label":"revise"},
      {"from":"evaluate","to":"publish","label":"quality bar met"}
    ]
  }]
}
</script>

<script type="application/derive-facts" data-fact="workflow-definition">
{
  "schema": "derive.workflow/v1",
  "purpose": "Build and publish a weekly signal brief",
  "forbidden": ["Publish outside the current Derive workspace", "Continue past loop bounds"],
  "diagrams": [{
    "id": "weekly-signal",
    "entry": "research",
    "nodes": [
      {
        "id": "research",
        "kind": "context",
        "context_ref": "signal-researcher",
        "instruction": "Produce this week's evidence-backed signal brief.",
        "result": "A cited draft brief"
      },
      {
        "id": "evaluate",
        "kind": "context",
        "context_ref": "brief-quality-checker",
        "instruction": "Evaluate the brief against its evidence and clarity bar; return ready or revise.",
        "result": "A grounded ready-or-revise decision",
        "routing": "one"
      },
      {
        "id": "publish",
        "kind": "context",
        "context_ref": "brief-publisher",
        "instruction": "Publish the ready brief to the current Derive workspace.",
        "result": "A published Derive artifact",
        "terminal": true,
        "effects": [{
          "kind": "write",
          "description": "Publish the weekly brief to Derive",
          "gate": "none",
          "idempotency": "Publish one version for this workflow node attempt"
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
      "goal": "Reach the stated evidence and clarity bar",
      "evaluate": "Quality checker evaluates evidence, clarity, and scope",
      "stop": {
        "max_attempts": 2,
        "stagnation_limit": 1,
        "max_minutes": 20,
        "human_stop": "The person stops or changes the brief"
      }
    }],
    "scenarios": [
      {"id":"expected","kind":"expected","path":["research","evaluate","publish"],"outcome":"Ready brief is published"},
      {"id":"context-failure","kind":"failure","path":["research"],"outcome":"Run stops with the failed session visible"},
      {"id":"revision","kind":"expected","path":["research","evaluate","research","evaluate","publish"],"outcome":"One bounded revision is incorporated before publication"}
    ]
  }]
}
</script>
```

## Node kinds

- `context`: requires `context_ref`, `instruction`, and `result`; set `terminal:true` when it ends
  the diagram. With multiple outgoing routes, set `routing:"all"` for an unconditional fan-out or
  `routing:"one"` for conditional choice with exactly one fallback.
- `human`: requires `decision`, at least two `options`, and `resume`.
- `terminal`: requires `result`; use only when completion is not itself context work.

Every diagram declares one `entry`. Every node must be reachable from it, at least one node must
be terminal, and terminal nodes have no outgoing route. Human routes match their options exactly
and omit fallback; context fan-out and branching are explicit through `routing`.

## Effects

Effects are `read`, `write`, `message`, `spend`, or `access`. Every effect names a human-readable
`description` and `gate` (`none` or `human`). Publishing artifacts and run-state updates to Derive
normally uses `gate:"none"` with `idempotency`; do not add a human gate merely because publishing
is a write. A human-gated effect names the existing human node that authorizes it with
`approval_ref`; reserve it for requested review or consequential effects outside Derive. Add
`compensation` when undo behavior exists.

## Loops and scenarios

A directed cycle requires a loop policy. The policy names its nodes, goal, evaluator, integer
`max_attempts` (1–100), optional `stagnation_limit`, `max_minutes`, and `max_cost_usd`, plus a
plain-language `human_stop`.

Every diagram needs an `expected` scenario. A diagram with context nodes also needs `failure`; a
diagram with a human node also needs `human`, covering each human node. Scenarios start at the
declared entry and use real visible routes; non-failure scenarios end at a terminal node.
