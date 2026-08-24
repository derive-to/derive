# Context-session runtime

Read this only when the person explicitly asks to run a previewed workflow.

## Boundary

The current Codex, Claude, or approved agent session is the harness. Derive stores the graph,
authored state, artifacts, review, and context sessions. Do not create a second scheduler or MCP
run API.

## One node attempt

For a ready context node, open one context session with a deterministic attempt key:

```text
use({
  context: node.context_ref,
  instruction: render(node.instruction, inputs),
  dedupe_key: `${workflowArtifact}:${diagram}:${node}:${attempt}`
})
```

Then collect progress or settlement through the returned session:

```text
use({ session_id, wait: 50 })
```

A follow-up continues this attempt: `use({session_id, instruction})`. A retry or quality
iteration starts a new session with the next attempt number. Never reuse one session across loop
attempts; never create a new session for a mere check or follow-up.

## Project session truth

| Context session | Authored graph state | Harness action |
| --- | --- | --- |
| `open` | `waiting` | Keep the node queued; do not infer a person is needed. |
| `working` | `active` | Carry progress and any bound result artifact into the node note/member. |
| `answered` | `done` | Add `result_artifact_id` to bundle members, point `node.member` at its local id, then route. |
| `escalated` | `waiting` + explicit `help` | Pause with the exact question and resume event. |
| `failed` | `blocked` or a declared retry | Apply the authored failure/loop policy; never retry forever. |
| `closed` | stopped | End deliberately and explain why. |

Publish each result artifact and graph-state transition back to the same Derive workflow as normal
run bookkeeping. Do this by default with version/idempotency protection; it does not need a fresh
human approval.

Update only explicit authored fields. Silence, inactivity, low confidence, or an unavailable
artifact does not mean a person is needed.

## Ready-node rule

A diagram begins only at its declared `entry`. After that, a node is ready only when every
required predecessor has settled on a route whose condition is satisfied, no referenced human
approval is unresolved, and starting it would stay inside loop/effect policy.
Parallelize only nodes that do not share mutable state. When uncertain, run sequentially and say
why.

## Stop

Stop when a terminal result is reached, a loop bound/stagnation/time/cost limit is exhausted, a
human gate is waiting, a terminal failure occurs, or the person asks to stop. Report the current
artifact, completed nodes, remaining work, and any exact help request.
