---
name: workflows
summary: graphs and loops via contexts (publish, use)
order: 5.5
---
# Graphs and bounded loops

Use this when a person asks for a workflow, graph, loop, multi-context plan, approval path, or a
clear account of what will happen before work runs. Do not turn an ordinary one-step artifact into
a graph.

Derive is the persistent working layer. The connected Codex, Claude, or other approved harness
executes. Reuse the existing context `use` primitive; never invent a second graph-run tool family,
queue, lease model, progress protocol, or artifact store.

## One Preview gate

Preview includes explanation, structural validation, scenario checks, and repair guidance. Do not
ask for separate Explain, Validate, and Preview approvals. Present one result: **Ready to run** or
**Needs changes**. Only explicit run intent starts context sessions; authored human gates still
pause sensitive actions later.

## Author

1. Extract the outcome, evidence of completion, contexts/roles, external effects, loop bounds, and
   decisions that really need a person. Ask only questions whose answers change safety or behavior.
2. Choose the smallest useful shape: linear handoff, fan-out/join, approval, router, or bounded
   evaluator–optimizer loop.
3. Publish one ordinary HTML linked bundle with two facts generated from the same model:
   - `bundle-manifest` remains the visible topology and #799 authored working state.
   - `workflow-definition` adds context bindings, route conditions, bounds, effects, gates,
     forbidden actions, and scenarios.
4. Join the facts only by stable diagram/node IDs. Every visible node and edge must have exactly one
   matching workflow node and route.
   This is **same IDs, different jobs**. A graph may start with `members:[]`; add actual context
   result artifacts later. Never invent a placeholder artifact id. As the authoring agent, generate
   one concise, editable `note` for every visible node. Describe what happens in plain language,
   using the matching workflow `instruction` and `result` as source material. Do not make people
   reconstruct the note from owner, output, routing, or approval metadata.
5. Before any publish or `use` call, compile the facts in memory and present one Preview: what will
   happen, possible branches, human pauses, bounds, external effects, forbidden actions, scenarios,
   and either **Ready to run** or the exact blockers. Repair in memory until Ready.
6. Publish the Ready workflow artifact and subsequent Derive result/state updates by default; do
   not add a second approval merely because the action is a Derive publish. Treat workflow
   advisories as defense-in-depth blockers and repair them before run. Inspect the rendered
   artifact. Add a human gate only when the person requests one or an effect is consequential
   outside Derive.

The companion fact has this shape:

```json
{
  "schema": "derive.workflow/v1",
  "purpose": "Build and publish a weekly brief",
  "forbidden": ["Publish outside the current Derive workspace", "Continue past loop bounds"],
  "diagrams": [{
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
        "instruction": "Evaluate the brief against its stated evidence and clarity bar; return ready or revise.",
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
      "goal": "Reach the stated quality bar",
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
      {"id":"failure","kind":"failure","path":["research"],"outcome":"Failed session is visible and the run stops"},
      {"id":"revision","kind":"expected","path":["research","evaluate","research","evaluate","publish"],"outcome":"One bounded revision lands before publication"}
    ]
  }]
}
```

## Preview invariants

- `context` nodes require `context_ref`, `instruction`, and `result`; use `terminal:true` when the
  context result ends the diagram. Multiple routes require `routing:"all"` for unconditional
  fan-out or `routing:"one"` for conditional choice with one fallback.
- `human` nodes require a typed `decision`, at least two `options`, and `resume`.
- `terminal` nodes require `result`.
- Every diagram declares an `entry`; all nodes are reachable from it and at least one is terminal.
  Human routes match their options exactly and omit fallback; context fan-out and branching are
  explicit through `routing`.
- Effects are `read`, `write`, `message`, `spend`, or `access`. Derive artifact publication and
  state updates normally use `gate:"none"` with an idempotency contract. Reserve a `human` gate
  for explicitly requested review or consequential effects outside Derive.
- Every directed cycle has a loop with a goal, evaluator, integer `max_attempts` (1–100), optional
  stagnation/time/cost limits, and `human_stop`.
- Every diagram has an expected scenario. Context work adds a failure scenario; human work adds a
  human scenario covering each human node. Paths start at the declared entry and use real visible
  routes; non-failure paths end at a terminal node.
- Preview distinguishes guaranteed policy from illustrative paths; it does not promise exact model
  or tool behavior.

## Run through contexts

When the person explicitly says to run, begin at the diagram's declared `entry`, then start one
context session per ready node attempt:

```text
use({
  context: node.context_ref,
  instruction: render(node.instruction, inputs),
  dedupe_key: `${workflowArtifact}:${diagram}:${node}:${attempt}`
})
```

Collect it with `use({session_id, wait:50})`. A follow-up continues the same attempt with
`use({session_id, instruction})`; retry or refinement starts a new attempt/session.

Project session truth into the authored graph:

- `open` → `waiting` (queued; no inferred help)
- `working` → `active`
- `answered` → `done`; add `result_artifact_id` to bundle members and point `node.member` at its
  local member id, then evaluate routes
- `escalated` → `waiting` with explicit `help.question` and resume action
- `failed` → declared retry or `blocked`
- `closed` → stopped deliberately

Publish each result artifact and graph-state transition back to the same Derive workflow as normal
run bookkeeping. Do this by default with version/idempotency protection; it does not need a fresh
human approval.

An effect's `approval_ref` reuses that human node's decision; do not ask again when the approved
decision and the described effect match. Stop at a terminal result, exhausted loop/time/cost/stagnation bound, unresolved human gate,
terminal failure, or the person's stop request. Keep state explicit; silence or elapsed time never
implies low confidence, urgency, or a need for human help.
