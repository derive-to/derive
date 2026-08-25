# Typed graph and loop Contexts

Workflows is Derive's product area. Context is the only runnable address. A Context pins one
`derive.agent-manifest/v2` whose kind is `single`, `graph`, or `loop`; graphs and loops are agent
system shapes, not separate executors.

Derive persists immutable definitions, access, sessions, progress, results, and receipts. The
current Codex, Claude, or another approved local MCP harness coordinates a graph/loop through the
remote Derive MCP. Never invent a second scheduler, graph-run tool, queue, or state store.

## Remote execution contract

Only explicit run intent starts work. Call the root Context through existing `use`:

```text
use({
  context: "Weekly brief",
  instruction: "Build the brief for the August launch",
  dedupe_key: "august-launch-weekly-brief"
})
```

A composite Context returns a `derive.local-workflow-run/v1` envelope with the exact pinned
manifest/version, root instruction, diagram, loop bounds, forbidden actions, node dedupe template,
and report instructions. The OAuth human who opens that root is its only driver.

For each ready context node:

1. Open one child `use` session with the authored `context_ref`, rendered instruction, and the
   envelope's stable node/attempt dedupe key.
2. Check or follow up using that `session_id`; a retry increments the attempt and opens a new
   child session.
3. Report honest root progress with `use({session_id: root, answer, progress:true})`.
4. Honor exact routes, bounds, forbidden actions, and human/effect gates. Never infer completion,
   approval, or help from silence.
5. Settle the root with `answer`, optional `result_artifact_id`, and
   `state: answered|escalated|failed`.

The root stays on its original manifest version if a new one publishes mid-run. Derive marks an
abandoned root failed rather than leaving it working forever.

## If only stdio is connected

The stdio compatibility server can read, review, organize, and publish definitions. It does not
expose `use`, so it cannot execute Context nodes. Do not guess a tool name or mark anything done.
Tell the person:

> This stdio Derive connection can inspect and publish the graph/loop Context, but it cannot run
> workspace Contexts. Connect the remote OAuth MCP, then retry.

```bash
# Claude Code
claude mcp add --transport http --scope project derive https://derive.to/mcp

# Codex
codex mcp add derive --url https://derive.to/mcp
```

Any open-source MCP client may use the same Streamable HTTP endpoint if it supports the OAuth
flow. If it cannot, Context execution remains unavailable.

## Authoring and migration

New definitions use one `agent-manifest` fact. A composite owns exactly one diagram and one entry.
An optional `bundle-manifest` is only its visible projection; canvas labels never control routing.
Existing `workflow-definition` artifacts remain readable and can be adopted through Workflows →
Move existing. The dry run preserves URLs/history, imports invalid items visibly with blockers,
and is safe to repeat.
