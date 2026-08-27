---
name: contexts
summary: read a packaged Agent to load what it knows, or give it an instruction (find, read, use)
order: 6
---
# Agents: load the package, or give it work

An AGENT is a named, shareable worker: a manifest (what it is and how it works), the skills that
manifest pins, its bound sources, permissions, execution connection, and run history.

The product calls this an Agent. The current tool and storage contracts keep `context`,
`context_id`, `create_context`, and `derive://skills/contexts` for compatibility. In the examples
below, those names refer to the Agent being read or run; they are not a second product concept.

It has two modes, and they are equals:

- **Read it:** `read({ short_id: "ctx_..." })` loads the Agent package. One call, no run, no runner
  needed. This is how you get ORIENTED: what the thing is, its vocabulary, its procedures.
- **Use it:** `use({ context, instruction })` gives the Agent work, and an execution connection
  serves that session.

Reach for `read` when you want to KNOW what the Agent knows, and `use` when you want a job
done. A cold session almost always wants `read` first: it is cheaper than asking, it returns
the same thing every time, and it hands you the shape of the domain rather than answering one
question about it.

## Progressive opening

A package opens in layers, so loading it never costs more than it saves:

- **The manifest loads inline.** It is the small, always-read layer, sized to be
  worth loading before you know what you need.
- **Skills and sources come back as pointers:** short ids you `read` only when a task actually
  needs that procedure.

So the read that orients you stays cheap, and the corpus is there when you go looking. Write
manifests to match: the manifest carries the model and the vocabulary, the depth lives in
skills the manifest pins.

## Discovering Agents with find

`find` (browse, or a query matching an Agent name) lists the Agents you may use in a
workspace: id, name, whether its execution connection is online, the manifest that defines it,
and your own still-open sessions so you can resume one. Online means its last poll was recent; that
matters only for `use`, since reading never needs a runner. Access is granted per Agent, so what `find`
surfaces is exactly what your user may use. `read` checks the same grant, so it can
never open a package `find` would not have shown you. Then `read` it or `use` it, by id or name.

## Giving an instruction

Hand an Agent an instruction on your user's behalf, or continue an existing session. Every
session has the same shape: **(Agent, instruction)**, meaning "with this Agent, do this." The
instruction is a question ("what were refunds last week?") or a task ("build the walkthrough
for Acme"); it always names the target.

- **GIVE** a new session: `use({ context, instruction })` (id or name + "with this Agent, do
  this"). Optionally pass a `dedupe_key`: a second give with the same key while one is still in
  flight joins the existing session instead of starting a duplicate. A repeated "do it for brand
  X" never runs twice.
- **IN A WORKFLOW:** pass `workflow:{run_id,node_id,attempt}` on GIVE. Derive binds the Agent
  session to that exact step attempt and assigns its run-scoped dedupe key. After settlement, the
  workflow harness records the authored route as described in `derive://skills/workflows`; a retry
  starts the next attempt rather than reopening the settled session.
- **Follow up:** `use({ session_id, instruction })` (it already knows the Agent; do not pass
  `context`).
- **CHECK / RESUME**: `use({ session_id })` alone reads the latest state + transcript.

The call waits up to `wait` seconds (default 25, max 50; 0 = return at once). Real runs take
MINUTES and STREAM: while the execution connection works, the session sits in `working` and `use` returns
each `progress` tick (with a `result_url` once the agent binds a result page) instead of
blocking to timeout. Keep calling with the `session_id` to watch it build. A still-working
response is NORMAL, not an error. A settled session is normally `answered`; it can come back
`escalated` (a draft went to a human reviewer; check back) or `failed` (the run crashed; give it
again). Results cite artifact short ids you can then `read`. If the agent is offline,
the session waits and runs when it comes back.

## Running an Agent

Two principals can execute an Agent through the same `use` tool, with no daemon: its registered
execution connection (a Claude Code or Codex session connected with the Agent's `dk_agt_` token),
or an owner-run session whose user holds the owner seat in the Agent's workspace. The person who
wired it up can run it from the grant they already have, with no second token. A give always carries an
instruction, so a bare `use({ context })` means "I'm the runner. Hand me my
work." Loop:

- **PULL work:** `use({ context })` (an Agent you run, NO instruction). It atomically claims up
  to the next 10 waiting sessions (flips them to `working` and leases them, so two runners never
  double-run one) and returns each with its `session_id` + transcript. Nothing waiting ⇒
  `claimed: 0`.
- **Do the work** against your data/tools, publishing a result artifact if it warrants one (a
  `building…` page you refresh as stages land gives the requester a stable link from tick one).
- **Report:** `use({ session_id, answer })`. Your `answer` is the agent turn. Add
  `progress: true` for a non-settling tick (stays `working`, streams to the requester);
  `state: "escalated"` when a draft went to a human, or `"failed"` on a crash;
  `result_artifact_id` to bind/refresh the result page; `answers` (the requester-message id
  from your pull snapshot) so a settle can't clobber a follow-up that landed mid-run.

Pulling is capped by the Agent's concurrency (default 1: you claim exactly what you work on
now, so a crash strands one session, not a batch). A crashed claim self-heals once its lease
lapses. The next pull serves it again.

## Creating an Agent (owners)

`automate` with `action: "create_context"` wires a new Agent in one call: `name` +
`manifest_short_id` (the Agent's instruction artifact in this workspace), optional
`max_run_ms` (per-run budget) and `max_concurrency`. Derive creates a managed execution connection
automatically; its token is not returned because an MCP transcript is a bad place for a standing
secret. As an owner, you run the Agent directly via owner-run. A dedicated execution connection's
token comes from REST when needed. New Agents start `ask_policy: "invited"` (creator-only); widen
who may ask from the console.
