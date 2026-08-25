# Run Derive workflows from a local agent

A Derive workflow combines a graph, bounded loops, context work, gates, and result artifacts in
one durable artifact. Derive is the persistent control and evidence layer: it stores the authored
topology, explicit state, context sessions, results, reviews, and receipts. It does not run the
compute. The current Codex, Claude, or other approved local MCP harness executes the work.

## Required execution surface

Execution uses the remote Derive MCP's existing `use` tool. A local harness is still local: it
connects to `https://derive.to/mcp`, reads the pinned workflow artifact/version and diagram, calls
`use` for each approved context-node attempt, and publishes results and honest state transitions
back to that workflow. Do not invent a second scheduler, graph-run API, queue, or artifact store.

Only explicit run intent starts context sessions. Before running, confirm the workflow preview is
ready, preserve authored loop bounds and human/effect gates, and use a distinct context session
for every retry or quality-loop attempt. Continue an existing attempt by following up on its
session. A context answer should bind its result artifact to the corresponding graph node before
routing onward.

## If only the stdio compatibility server is connected

The stdio server exposes artifact read, review, organization, and publish tools. It does **not**
expose `use`, so it cannot execute workspace-context nodes. Do not guess a tool name, silently run
some other local command, or mark nodes complete. Tell the user:

> This stdio Derive connection can read and publish the workflow, but it cannot execute its
> workspace contexts. Connect the remote OAuth MCP, then retry the run.

Connect the complete remote surface:

```bash
# Claude Code (project-scoped)
claude mcp add --transport http --scope project derive https://derive.to/mcp

# Codex (user-scoped)
codex mcp add derive --url https://derive.to/mcp
```

Complete browser OAuth when prompted, start a fresh agent session if the client requires it, and
verify that the live tool surface includes `use`. Any open-source MCP client may use the same
Streamable HTTP endpoint if it supports the server's OAuth flow. If it cannot, workflow context
execution remains unavailable; stdio may still be used to inspect or revise artifacts.

## Minimal run contract

For each ready context node:

1. Open one `use` session with the authored `context_ref`, rendered instruction, and a stable
   dedupe key for workflow artifact, pinned version, diagram, node, and attempt.
2. Poll or continue that session with `use({session_id, ...})`; do not create a new session for a
   progress check or follow-up.
3. Project only explicit session truth into the graph. Never infer completion, confidence, or a
   need for human help from silence.
4. Publish the result artifact and version-protected graph-state transition back to Derive.
5. Stop at a terminal result, failed policy, loop bound, unresolved human gate, or user stop.

The workflow definition is portable input to the harness. Concrete models and tools may differ;
the pinned topology, limits, approvals, state, and evidence must not.
