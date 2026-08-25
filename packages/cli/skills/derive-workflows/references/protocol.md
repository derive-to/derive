# Typed agent-manifest protocol

Read this when authoring or repairing a Derive graph/loop Context.

## One canonical definition

The artifact carries one `agent-manifest` fact. A composite manifest owns exactly one diagram;
the Context that pins it is the only runnable address. An optional `bundle-manifest` is a visible
projection and working-state view. Route conditions in the manifest are authoritative; canvas
labels are presentation only.

```html
<script type="application/derive-facts" data-fact="agent-manifest">
{
  "schema": "derive.agent-manifest/v2",
  "kind": "graph",
  "purpose": "Publish a reviewed release note",
  "title": "Release note",
  "labels": {"draft":"Draft","approve":"Approve","publish":"Publish"},
  "forbidden": ["Publish without approval"],
  "diagram": {
    "id": "release-note",
    "entry": "draft",
    "nodes": [
      {"id":"draft","kind":"context","context_ref":"release-writer","instruction":"Draft the note.","result":"A cited draft"},
      {"id":"approve","kind":"human","decision":"Ship this note?","options":["approve","revise"],"resume":"Use the selected route"},
      {"id":"publish","kind":"context","context_ref":"release-publisher","instruction":"Publish the approved note.","result":"Published note","terminal":true,"effects":[{"kind":"write","description":"Publish to Derive","gate":"human","approval_ref":"approve"}]}
    ],
    "routes": [
      {"from":"draft","to":"approve","when":"always"},
      {"from":"approve","to":"draft","when":"revise"},
      {"from":"approve","to":"publish","when":"approve"}
    ],
    "scenarios": [
      {"id":"expected","kind":"expected","path":["draft","approve","publish"],"outcome":"Approved note is published"},
      {"id":"failure","kind":"failure","path":["draft"],"outcome":"Failure remains visible"},
      {"id":"human","kind":"human","path":["draft","approve","publish"],"outcome":"Approval resumes publication"}
    ]
  }
}
</script>
```

## Rules

- Kind is `graph` or `loop`. A graph has no cycle or loop policy. A loop has at least one bounded
  cycle policy with goal, evaluator, integer max attempts, optional integer stagnation limit,
  optional time/cost bounds, and human stop.
- Node IDs and diagram ID are stable local IDs. One entry, all nodes reachable, at least one
  terminal result, no outgoing routes from terminal work.
- `context` requires `context_ref`, `instruction`, and `result`. `human` requires a decision,
  at least two distinct options, and resume behavior. `terminal` requires result.
- Multiple unconditional routes require `routing:"all"`. Conditional selection requires
  `routing:"one"`, unique normalized non-fallback conditions, and exactly one fallback.
- Every non-read effect requires either a human gate with `approval_ref` or replay-safe
  idempotency. Approval is reused only for the effect it explicitly describes.
- Scenarios begin at entry, follow real routes, and cover expected, context failure, and every
  human node.

Run `derive workflow sync <file>` after edits. It preserves visible labels/state, replaces only
the projected topology, and refuses to write until Preview is Ready. New writes use v2. Legacy
`workflow-definition` + `bundle-manifest` remains a dual-read import format.
