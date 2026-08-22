# Workflow definition protocol

Read this when authoring or repairing a Derive graph or loop.

## Two facts, one model

The artifact is ordinary single-file HTML. Its visible graph and working state remain the shipped
`bundle-manifest` contract. A companion `workflow-definition` fact adds preflight and execution
meaning without changing #799's state semantics.

Both facts must describe identical diagram IDs, node IDs, and edges/routes. `derive workflow
preview` refuses drift between them.

```html
<script type="application/derive-facts" data-fact="bundle-manifest">
{
  "schema": "derive.linked-bundle/v1",
  "purpose": "Publish a weekly signal brief after product review",
  "members": [{"id":"brief","ref":"abc12345","label":"Signal brief"}],
  "diagrams": [{
    "id": "weekly-signal",
    "title": "Weekly signal brief",
    "type": "graph",
    "nodes": [
      {"id":"research","label":"Research signals","state":"pending"},
      {"id":"review","label":"Product review","state":"pending"},
      {"id":"publish","label":"Publish brief","member":"brief","state":"pending"}
    ],
    "edges": [
      {"from":"research","to":"review","label":"draft ready"},
      {"from":"review","to":"research","label":"revise"},
      {"from":"review","to":"publish","label":"approved"}
    ]
  }]
}
</script>

<script type="application/derive-facts" data-fact="workflow-definition">
{
  "schema": "derive.workflow/v1",
  "purpose": "Publish a weekly signal brief after product review",
  "forbidden": ["Publish without product approval", "Add a new source without permission"],
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
        "id": "review",
        "kind": "human",
        "decision": "Approve the brief or request one bounded revision",
        "options": ["approve", "revise"],
        "resume": "The product lead chooses approve or revise"
      },
      {
        "id": "publish",
        "kind": "context",
        "context_ref": "brief-publisher",
        "instruction": "Publish the approved brief without changing its claims.",
        "result": "A published Derive artifact",
        "terminal": true,
        "effects": [{
          "kind": "write",
          "description": "Publish the approved brief",
          "gate": "human",
          "approval_ref": "review"
        }]
      }
    ],
    "routes": [
      {"from":"research","to":"review","when":"always"},
      {"from":"review","to":"research","when":"revise"},
      {"from":"review","to":"publish","when":"approve"}
    ],
    "loops": [{
      "id": "brief-repair",
      "nodes": ["research", "review"],
      "goal": "Reach an approvable, evidence-backed brief",
      "evaluate": "Product lead checks evidence, clarity, and scope",
      "stop": {
        "max_attempts": 2,
        "stagnation_limit": 1,
        "max_minutes": 20,
        "human_stop": "The product lead stops or changes the brief"
      }
    }],
    "scenarios": [
      {"id":"expected","kind":"expected","path":["research","review","publish"],"outcome":"Approved brief is published"},
      {"id":"context-failure","kind":"failure","path":["research"],"outcome":"Run stops with the failed session visible"},
      {"id":"revision","kind":"human","path":["research","review","research","review","publish"],"outcome":"One revision is incorporated before approval"}
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
`description` and `gate` (`none` or `human`). A non-read effect with no human gate must declare
`idempotency`. A human-gated effect names the existing human node that authorizes it with
`approval_ref`; it does not invent a second approval. Add `compensation` when undo behavior exists.

## Loops and scenarios

A directed cycle requires a loop policy. The policy names its nodes, goal, evaluator, integer
`max_attempts` (1–100), optional `stagnation_limit`, `max_minutes`, and `max_cost_usd`, plus a
plain-language `human_stop`.

Every diagram needs an `expected` scenario. A diagram with context nodes also needs `failure`; a
diagram with a human node also needs `human`, covering each human node. Scenarios start at the
declared entry and use real visible routes; non-failure scenarios end at a terminal node.
