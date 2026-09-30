---
name: workflows
summary: graphs and loops as graph agents (publish, agents, ask)
order: 5.5
---
# Graphs and bounded loops

Use this when a person asks for a workflow, graph, loop, multi-agent plan, human-decision path, or a
clear account of what will happen before work runs. Do not turn an ordinary one-step artifact into
a graph.

A workflow is an AGENT whose instructions page holds the definition (see derive://skills/agents).
Asking that agent, or its schedule firing, opens a `graph` job that Derive walks: each step becomes
a child job for the agent the step names, a human step stops the graph at `needs_you` with the
authored options, and a terminal step ends its branch. The agents that do the steps run on their
own machines, as they would for any ask.

A step binds an agent through `kind:"context"` and `context_ref`: the agent's id or name in this
workspace. That agent does the step with its own instructions, sources, and permissions.

## One Preview gate

Preview includes explanation, structural validation, scenario checks, and repair guidance. Do not
ask for separate Explain, Validate, and Preview steps. Present one result: **Ready to run** or
**Needs changes**. Only explicit run intent starts a graph job; authored human gates still pause
sensitive actions later.

## Author

1. Extract the outcome, evidence of completion, agents/roles, external effects, loop bounds, and
   decisions that really need a person. Ask only questions whose answers change safety or behavior.
2. Choose the smallest useful shape: linear handoff, fan-out/join, human decision, router, or bounded
   evaluator–optimizer loop.
3. Publish one ordinary HTML linked bundle with two facts generated from the same model:
   - `bundle-manifest` remains the visible topology and #799 authored working state.
   - `workflow-definition` adds agent bindings, route conditions, bounds, effects, gates,
     forbidden actions, and scenarios.
4. Join the facts only by stable diagram/node IDs. Every visible node and edge must have exactly one
   matching workflow node and route.
   This is **same IDs, different jobs**. A graph may start with `members:[]`; add actual step
   result artifacts later. Never invent a placeholder artifact id. As the authoring agent, generate
   one concise, editable `note` for every visible node. Describe what happens in plain language,
   using the matching workflow `instruction` and `result` as source material. Do not make people
   reconstruct the note from owner, output, routing, or gate metadata.
5. Before any publish or `ask` call, compile the facts in memory and present one Preview: what will
   happen, possible branches, human pauses, bounds, external effects, forbidden actions, scenarios,
   and either **Ready to run** or the exact blockers. Repair in memory until Ready.
6. Publish the Ready workflow artifact and subsequent Derive result/state updates by default; do
   not add a human gate merely because the action is a Derive publish. Treat workflow
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

- `context` nodes require `context_ref` (an agent), `instruction`, and `result`; use
  `terminal:true` when the step's result ends the diagram. Multiple routes require `routing:"all"` for unconditional
  fan-out or `routing:"one"` for conditional choice with one fallback.
- `human` nodes require a typed `decision`, at least two `options`, and `resume`.
- `terminal` nodes require `result`.
- Every diagram declares an `entry`; all nodes are reachable from it and at least one is terminal.
  Human routes match their options exactly and omit fallback; step fan-out and branching are
  explicit through `routing`.
- Effects are `read`, `write`, `message`, `spend`, or `access`. Derive artifact publication and
  state updates normally use `gate:"none"` with an idempotency contract. Reserve a `human` gate
  for explicitly requested review or consequential effects outside Derive. A human-gated effect
  belongs on a `context` node so Derive can check approval before opening the step. That node must
  sit directly and only behind its `approval_ref` human node.
- Every directed cycle has a loop with a goal, evaluator, integer `max_attempts` (1–100), optional
  stagnation/time/cost limits, and `human_stop`.
- Every diagram has an expected scenario. Agent steps add a failure scenario; human work adds a
  human scenario covering each human node. Paths start at the declared entry and use real visible
  routes; non-failure paths end at a terminal node.
- Preview distinguishes guaranteed policy from illustrative paths; it does not promise exact model
  or tool behavior.

## Run it as an agent

When the person explicitly says to run, make the workflow artifact an agent's instructions page,
then ask that agent. Derive walks the graph from the diagram's `entry`:

```text
agents({ action: "create", name: "Weekly brief", instructions: workflow.short_id,
         machine: "owner" })
ask({ agent: "<the graph agent>", instruction: "Build this week's brief",
      dedupe_key: "<stable id for this run intent>" })
```

Only the first diagram of the definition runs. The definition is pinned to the page version the
graph job started on: an edit changes the next run, not this one. Reuse the same `dedupe_key` after
a timeout and Derive returns the same job. A `schedule` on the graph agent starts a run on a clock.

Each step opens a child job for the agent its `context_ref` names, with the step's `instruction`.
Follow the graph with `jobs({ job_id })`: its `result.route` records every step taken
(`node_id`, `attempt`, the routes it selected), and `jobs({ agent })` on a step's agent lists its
child jobs. A step with `routing:"one"` picks its next step from its own reply: the step's agent
ends its report with a line `ROUTE: <node id>`, and a missing or unknown one takes the fallback
route. Loops are bounded by their `max_attempts`.

A `human` step stops the graph at `needs_you` with the authored options. Answer with
`jobs({ job_id, action: "answer", option })` and the graph continues from that step. Cancel with
`jobs({ job_id, action: "cancel" })`: it cancels the running steps too. `action: "retry"` runs a
failed or lost graph again.

A step's agent publishes what it makes as it would for any job. Nothing needs attaching to the
graph: the child job's report names the versions it made.
