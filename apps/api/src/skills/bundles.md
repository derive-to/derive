---
name: bundles
summary: group artifacts around authored loops or graphs (publish, read)
order: 5
---
# Linked bundles

A linked bundle is an ordinary single-file HTML artifact with one authored
`bundle-manifest` fact. It gives related artifacts a shared purpose and optional visual
loop/graph diagrams. Every member remains an independent artifact with its own URL,
versions, comments, and permissions.

Derive presents and coordinates the bundle. It does not execute a loop, schedule a graph,
score work, or create run records. The agent or external harness does the work and updates
the member artifacts normally.

## Build one

1. Resolve or publish the member artifacts first. Reuse existing artifacts; never copy one
   merely to put it in a bundle.
2. Build one in-memory manifest using the contract below.
3. Render the visible member links and the manifest from that same object. Every member
   must appear as a normal `/artifacts/<short-id>` link in the page.
4. Publish the HTML as one file. A valid manifest types it as
   `text/x-derive-linked-bundle` and turns on native member/diagram chrome.
5. Inspect the render and return the one bundle URL. Revise that same artifact when its
   composition changes.

```json
{
  "schema": "derive.linked-bundle/v1",
  "purpose": "Make the launch decision-ready while preserving the evidence.",
  "members": [
    { "id": "brief", "ref": "abc12345", "label": "Product brief", "role": "output" },
    { "id": "evidence", "ref": "def67890", "label": "Evidence", "role": "input" }
  ],
  "diagrams": [
    {
      "id": "improve",
      "title": "Improve until confident",
      "type": "loop",
      "goal": "Make the brief decision-ready",
      "evaluate": "Check material claims against evidence and reviewer feedback",
      "stop": "No material objections remain",
      "nodes": [
        {
          "id": "revise",
          "label": "Revise",
          "member": "brief",
          "role": "draft owner",
          "tier": "expert",
          "state": "active",
          "basis_version": 4,
          "note": "Address the open evidence objection",
          "confidence": {
            "level": "medium",
            "basis": "The current brief covers the known evidence, but one objection is unresolved."
          },
          "help": {
            "needed": true,
            "question": "Which source resolves the open evidence objection?",
            "can_continue": "Tighten the uncontested sections while that source is located."
          }
        },
        { "id": "check", "label": "Evaluate", "member": "evidence" }
      ],
      "edges": [
        { "from": "revise", "to": "check" },
        { "from": "check", "to": "revise", "label": "improve" }
      ]
    }
  ]
}
```

Embed it inertly in the HTML:

```html
<script type="application/derive-facts" data-fact="bundle-manifest">
  { ...the manifest JSON... }
</script>
```

## Make the diagram reviewable

Give every visible loop/graph part the stable target derived from its manifest identity:

- policy: `derive-<diagram>-policy-<goal|evaluate|stop>`
- node or step: `derive-<diagram>-node-<node>`
- edge or transition: `derive-<diagram>-edge-<index>-<from>-<to>`

Put that value in both `id` and `data-derive-review-id`, then add
`data-derive-review-kind` (`loop-step`, `loop-policy`, `loop-transition`, `graph-node`,
or `graph-edge`) and a concise `data-derive-review-label`. Derive's Map tab focuses these
targets, and Pin comment captures them through the ordinary durable comment-anchor system.
Agents can use the same target with `comment(visual_target:"...")`; no coordinates or run
record are involved.

Keep these ids stable across visual redesigns. A comment then stays attached to the named
semantic part while normal version history records every revision.

Member `id` and diagram/node ids are stable bundle-local names: letters, numbers,
underscores, and hyphens. Member `ref` is an artifact short id or artifact URL; Derive
normalizes it to the short id. Diagram nodes may point at a member id. Edges point at node
ids in the same diagram.

Node state is optional and explicitly authored: `pending`, `active`, `waiting`, `blocked`, or `done`.
Never infer it from prose or a version count. When a node names a member, set
`basis_version` to the member version the state was based on. If that artifact later moves
past the basis, Derive shows “artifact updated” until an agent or editor reconciles the
state. `note` is a short explanation of what the state means right now. A diagram may set a
default `tier` (`utility`, `fast`, `balanced`, `expert`, or `frontier`); a node's `tier`
overrides it. `role` names the node's responsibility, not a person or a concrete model.

For an `active`, `waiting`, or `blocked` node, use `confidence:{level,basis}` when a
confidence judgment materially affects the next decision. Use
`help:{needed,question?,can_continue?}` when outside input would help: ask one concise
question and say what can proceed in parallel. These are handoff cues, not a task tracker:
author or refresh them only at meaningful transitions (activation, a new wait/blocker,
material confidence change, resolution, or handoff). Agents maintain them as part of their
work; never ask humans to keep node state, tier, confidence, or help metadata current.

## Recipe: create or update a loop

Use this when the user says “make me a loop,” “loop until confident,” or describes
repeated evaluation and revision.

1. Read or publish the small set of living input/output artifacts.
2. Create one `type:"loop"` diagram with an explicit goal, evaluation condition, stop
   condition, and at least one directed cycle.
3. Link steps to artifacts where that helps orientation. Mark only the current step
   `active`; use `basis_version` when its state depends on a linked artifact.
4. Execute repetition in the agent or harness. Revise the same member artifacts on every
   pass; update the bundle only when policy, topology, or visible state changes.
5. Stop only under the authored stop condition. Derive never imposes an iteration limit.

## Recipe: create or update a graph

Use this when the user asks to map dependencies, branch work, coordinate agents, or show
how artifacts relate.

1. Reuse existing artifacts and assign stable member ids.
2. Create one `type:"graph"` diagram whose nodes name work/artifacts and whose directed,
   labelled edges state the actual dependency or relationship.
3. Author `pending` / `active` / `waiting` / `blocked` / `done` only from what the agent actually
   knows. Put the reason in `note`; set `basis_version` for artifact-backed state.
4. Update the relevant member artifacts, then the graph state. Pin review to the exact
   node or edge when feedback changes the route.
5. Keep handing off the same bundle short id. A collection can contain many graphs; it is
   still only a folder.

## Loops and graphs are different

- A `loop` describes repetition: state the goal, evaluation, stop condition, and cycle.
  It may run once or indefinitely; Derive imposes no iteration count.
- A `graph` describes topology: nodes and directed edges. It does not imply repetition.
- A loop can be drawn as a graph. Keep its type `loop` so the repeating policy remains
  explicit and inspectable.

The manifest is descriptive. Never hide prompts, thresholds, or stopping logic behind a
Derive-managed runtime.

## Work through a bundle

Read `bundle-manifest` to orient before editing:

```
read(short_id:"<bundle>", data:"bundle-manifest")
```

Then read and revise only the relevant member artifacts. During a self-improvement loop:

1. Execute the user's loop in the agent/harness.
2. Update the real output/evidence artifacts as they improve.
3. Use their existing version histories instead of iteration artifacts or run records.
4. Update the bundle only when its purpose, membership, or diagrams change.
5. Keep review comments on the artifact they concern; use the bundle for orientation and
   whole-system decisions.

An artifact may appear in many linked bundles. A collection may hold many bundle artifacts;
collections remain folders/navigation, not the semantic relationship model.

## Failure behavior

- Unavailable members stay visible by their authored label but expose no title or metadata.
- A malformed manifest does not break the HTML artifact; publish advisories explain the
  contract error and native bundle chrome stays off.
- If visible links and manifest members drift, republish from one model rather than patching
  the two representations separately.
