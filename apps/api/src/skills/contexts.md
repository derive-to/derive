---
name: contexts
summary: give a workspace's live agents an instruction, or run one as its agent (find, use)
order: 4
---
# Contexts: give an instruction, or run as the agent

A CONTEXT is an agent a workspace owner wired up — a manifest (its instructions), its own data
and tools, a playbook. Think of it as a role you can step into. Every interaction is the same
shape: **(context, instruction)** — "with this context, do this." The instruction is a question
("what were refunds last week?") or a task ("build the walkthrough for Airbnb"); it always names
the target. `find` surfaces the contexts your user may use; `use` is the one tool for both
sides — GIVING a context an instruction, and (if you are its agent) RUNNING it.

## Discovering contexts with find

`find` (browse, or a query matching a context name) lists the contexts you may use in a
workspace — id, name, whether its agent is online (its last poll is recent), the manifest that
defines it, and your own still-open sessions so you can resume one. Access is granted per
context, so what `find` surfaces is EXACTLY what your user may use. Then call `use` with a
context's id or name.

## Giving an instruction (the common path)

Hand a context an instruction on your user's behalf, or continue an existing session:

- **GIVE** a new session: `use({ context, instruction })` (id or name + "with this context, do
  this"). Optionally pass a `dedupe_key`: a second give with the same key while one is still in
  flight JOINS the existing session instead of starting a duplicate — a double "do it for brand
  X" never runs twice.
- **FOLLOW UP**: `use({ session_id, instruction })` (it already knows its context — don't pass
  `context`).
- **CHECK / RESUME**: `use({ session_id })` alone reads the latest state + transcript.

The call waits up to `wait` seconds (default 25, max 50; 0 = return at once). Real runs take
MINUTES and STREAM: while the agent works the session sits in `working` and `use` returns
each `progress` tick (with a `result_url` once the agent binds a result page) instead of
blocking to timeout — keep re-calling with the `session_id` to watch it build. A still-working
response is NORMAL, not an error. A settled session is normally `answered`; it can come back
`escalated` (a draft went to a human reviewer — check back) or `failed` (the run crashed —
give it again). Results cite artifact short_ids you can then `read`. If the agent is offline,
the session waits and runs when it comes back.

## Running a context (you ARE its agent — bring your own agent)

If your token is a context's agent (a Claude Code or codex session wired up to run it), you run
it through the SAME `use` tool — no daemon. A give always carries an instruction, so a bare
`use({ context })` unambiguously means "I'm the agent — hand me my work." Loop:

- **PULL work:** `use({ context })` (a context you run, NO instruction). It atomically claims up
  to the next 10 waiting sessions (flips them to `working` and leases them, so two runners never
  double-run one) and returns each with its `session_id` + transcript. Nothing waiting ⇒
  `claimed: 0`.
- **Do the work** against your data/tools, publishing a result artifact if it warrants one (a
  `building…` page you refresh as stages land gives the requester a stable link from tick one).
- **REPORT:** `use({ session_id, answer })` — your `answer` is the agent turn. Add
  `progress: true` for a non-settling tick (stays `working`, streams to the requester);
  `state: "escalated"` when a draft went to a human, or `"failed"` on a crash;
  `result_artifact_id` to bind/refresh the result page; `answers` (the requester-message id
  from your pull snapshot) so a settle can't clobber a follow-up that landed mid-run.

Pulling is capped by the context's concurrency (default 1: you claim exactly what you work on
now, so a crash strands one session, not a batch). A crashed claim self-heals once its lease
lapses — the next pull re-serves it.
