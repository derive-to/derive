---
name: contexts
summary: read a packaged Context or start work with it (find, read, use)
order: 6
---
# Contexts: load a package or use it in a run

A CONTEXT is a named, shareable package: a manifest (what this is and how to work with it), the
skills that manifest pins, its bound sources, and its permissions. An Agent is the actor that reads
the package or uses it while doing work.

The same package supports two operations:

- **Read it:** `read({ short_id: "ctx_..." })` loads the Context package. One call, no run, no runner
  needed. It tells you what the package is, its vocabulary, and its procedures.
- **Use it in a run:** `use({ context, instruction })` starts a session. An Agent executes the
  instruction using the Context.

Reach for `read` when you need the contents, and `use` when you want an Agent to do a job with them.
Read first when the package itself may answer your question: it is cheaper than a run, returns the
same result every time, and shows the shape of the domain instead of answering one narrow question.

## Progressive opening

A package opens in layers, so loading it never costs more than it saves:

- **The manifest loads inline.** It is the small, always-read layer, sized to be
  worth loading before you know what you need.
- **Skills and sources come back as pointers:** short ids you `read` only when a task actually
  needs that procedure.

So the read that orients you stays cheap, and the corpus is there when you go looking. Write
manifests to match: the manifest carries the model and the vocabulary, the depth lives in
skills the manifest pins.

## Discovering Contexts with find

`find` (browse, or a query matching a Context name) lists the Contexts you may use in a workspace:
id, name, whether its Agent connection is online, the manifest that defines it, and your open
sessions. Online means its last poll was recent; that matters only for `use`, since reading never
needs a runner. Access is granted per Context. `read` checks the same grant, so it cannot open a
package `find` would not show. Read a Context or start a run with it by id or name.

## Starting a run

Start an Agent session with a Context on your user's behalf, or continue an existing session. Every
session has the same shape: **(Context, instruction)**, meaning "with this Context, do this." The
instruction is a question ("what were refunds last week?") or a task ("build the walkthrough
for Acme"); it always names the target.

- **Start:** `use({ context, instruction })` (id or name + "with this Context, do
  this"). Optionally pass a `dedupe_key`: a second start with the same key while one is still in
  flight joins the existing session instead of starting a duplicate. A repeated "do it for brand
  X" never runs twice.
- **In a workflow:** pass `workflow:{run_id,node_id,attempt}` when starting the session. Derive
  binds the session to that exact Context step attempt and assigns its run-scoped dedupe key. After
  settlement, the workflow harness records the authored route as described in
  `derive://skills/workflows`; a retry starts the next attempt rather than reopening the settled
  session.
- **Follow up:** `use({ session_id, instruction })` (it already knows its Context; do not pass
  `context`).
- **Check or resume:** `use({ session_id })` alone reads the latest state and transcript.

The call waits up to `wait` seconds (default 25, max 50; 0 returns immediately). Runs can take
minutes. While the Agent works, the session remains `working`, and `use` returns each `progress`
update instead of blocking until timeout. A `result_url` appears once the Agent binds a result page.
Keep calling with the `session_id` to watch it build. A settled session is normally `answered`; it
can be `escalated` when a draft goes to a human reviewer or `failed` when the run crashes. Results
cite artifact short ids you can then `read`. If the Agent connection is offline, the session waits
and starts when it reconnects.

## Serving Context-backed work

Two principals can serve work for a Context through the same `use` tool, with no daemon: its
registered Agent connection (used by a Claude Code or Codex session with the Context's `dk_agt_`
token), or an owner-run session whose user holds the owner seat in the Context's workspace. The
person who wired it up can serve its queue from the grant they already have, with no second token.
A requester always supplies an instruction. A bare `use({ context })` therefore means "I'm the
runner. Hand me work."

- **Pull work:** `use({ context })` (a Context whose queue you serve, with no instruction). It
  atomically claims up to the next 10 waiting sessions (flips them to `working` and leases them, so
  two runners never double-run one) and returns each with its `session_id` + transcript. Nothing
  waiting ⇒ `claimed: 0`.
- **Do the work:** use the available data and tools, publishing a result artifact if warranted. A
  `building…` page you refresh as stages land gives the requester a stable link from tick one.
- **Report:** `use({ session_id, answer })`. Your `answer` is the Agent turn. Add
  `progress: true` for a non-settling tick (stays `working`, streams to the requester);
  `state: "escalated"` when a draft went to a human, or `"failed"` on a crash;
  `result_artifact_id` to bind/refresh the result page; `answers` (the requester-message id
  from your pull snapshot) so a settle can't clobber a follow-up that landed mid-run.

Pulling is capped by the Context's concurrency (default 1: you claim exactly what you work on
now, so a crash strands one session, not a batch). A crashed claim self-heals once its lease
lapses. The next pull serves it again.

## Creating a Context (owners)

`automate` with `action: "create_context"` wires a new Context in one call: `name` +
`manifest_short_id` (the Context's instruction artifact in this workspace), optional
`max_run_ms` (per-run budget) and `max_concurrency`. Derive creates a managed Agent connection
automatically; its token is not returned because an MCP transcript is a bad place for a standing
secret. As an owner, you can serve its queued work directly. A dedicated Agent connection's token
comes from REST when needed. New Contexts start `ask_policy: "invited"` (creator-only); widen who
may start runs from the console.
