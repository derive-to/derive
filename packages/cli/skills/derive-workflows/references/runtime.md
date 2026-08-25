# Local graph/loop Context runtime

Read this only when the person explicitly asks to run a preview-ready graph or loop Context.

## Open the root

Use the remote OAuth MCP and the existing tool:

```text
use({
  context: "Weekly brief",
  instruction: "Build the brief for the August launch",
  dedupe_key: "august-launch-weekly-brief"
})
```

The response's `derive.local-workflow-run/v1` envelope is the run contract: exact manifest/version,
root instruction, diagram, forbidden actions, node dedupe template, and reporting instructions.
Do not reload the Context's current manifest mid-run. A later published version applies only to a
new root session.

## Drive nodes

Begin at `diagram.entry`. A node becomes ready only through explicit satisfied routes, resolved
human/effect gates, and remaining bounds.

For one context-node attempt:

```text
use({
  context: node.context_ref,
  instruction: render(node.instruction, root_instruction, prior_results),
  dedupe_key: `${rootSession}:v${manifestVersion}:${nodeId}:${attempt}`
})
```

- Check with `use({session_id, wait:50})`.
- Follow up on the same attempt with `use({session_id, instruction})`.
- Retry/refinement opens a new child session with the next attempt number.
- Parallelize only independent nodes with no shared mutable effect.

Map only explicit child truth: `open` waiting, `working` active, `answered` done, `escalated`
human-waiting, `failed` declared retry or block, `closed` stopped. Never infer state from prose,
silence, elapsed time, or canvas styling.

## Report the root

```text
use({session_id: root, answer: "Research done; evaluation running.", progress: true})
```

At terminal result:

```text
use({
  session_id: root,
  answer: "The reviewed brief is published.",
  result_artifact_id: "abc123",
  state: "answered"
})
```

Use `escalated` only for an explicit human decision/help request and `failed` for a terminal error
or exhausted policy. Progress keeps a long root alive; if the harness disappears, a later check
turns abandonment into an explicit failure.

## Stop

Stop at terminal result, terminal failure, exhausted attempt/stagnation/time/cost bound, unresolved
human/effect gate, forbidden action, or user stop. Report completed nodes, child sessions/results,
remaining work, and the exact reason. Stdio has no `use`; refuse execution and connect the remote
endpoint rather than pretending.
