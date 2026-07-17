# MCP Contexts: the ask surface

**Status:** design approved 2026-07-17 (Connor, via brainstorming session). Not yet implemented.

## What and why

Contexts are Derive's askable agent setups: a registered agent wired to a manifest
artifact, answering questions through an owner-operated runner. Today the only
askers are humans in the web console. Agents connected over MCP (Claude Code,
Cursor, and every other MCP client) cannot ask at all, even though the answers
are exactly the kind of grounding an agent needs mid-task.

This feature adds an asking surface to the MCP server: a connected agent can
discover the contexts its human may ask, open a session on that human's behalf,
and fold the answer (with artifact citations it can then `read`) into whatever
it is building.

Scope is deliberately the asking side only:

- The runner keeps draining its queue over REST. Polling is a deliberate
  Workers-era design and the runner works; MCP would add nothing.
- Management (create, rewire, delete, ask-access rosters) stays off the MCP.
  `managementPrincipal` refuses agent tokens today for a reason: a stolen
  runner token must not rewire ask surfaces. Nothing here loosens that.

## Decisions (made during brainstorming)

1. **Asking side only.** Runner and management surfaces unchanged.
2. **Wait-first, then resume.** `ask` long-polls up to ~50s (the same ceiling as
   `check_requests`); slower answers return a session id the caller re-checks.
3. **The human's grant is the only gate.** No new OAuth scope. An MCP connection
   may ask exactly what its acting human may ask, re-checked per call. A
   connection with no known human cannot ask.
4. **Tool surface: `list_contexts` + `ask`.** Two tools, no third session tool;
   `ask` with only a `session_id` covers the resume path.

## Tool surface

Both tools are registered in `buildServer` (`apps/api/src/mcp.ts`) only when the
connection has an acting human (`actingFor`, resolved in `mountMcp` from the
OAuth grantor or the dk_agt_ token's creator). An ownerless legacy token never
sees them: the "askers are people" invariant stays structural, not an error
message. The server instructions gain one static sentence pointing at the tools.

### `list_contexts`

Input: `workspace` (optional, the same `wsArg` used by every roaming tool).

Returns, for the resolved workspace, the contexts the acting human may ask:

- `id`, `name`
- `online`: whether `runner_seen_at` is within 90s (the console's window)
- the manifest's `title` and `short_id`, so the agent knows what each context
  is for
- the caller's own non-closed sessions (`id`, context, `state`, `updated_at`),
  capped at 10 newest, so a fresh agent conversation can resume one opened
  before its context window reset

### `ask`

Input: `context` (id or name; names are unique per workspace), `question`,
`session_id`, `wait` (seconds, 1..50, default 25), `workspace`.

Three modes by argument shape:

- `context` + `question`: open a new session as the acting human, then wait.
- `session_id` + `question`: follow up on the caller's own session (re-opens
  it, same as the REST follow-up), then wait.
- `session_id` alone: wait/check only. This is the resume path after an earlier
  call timed out, and the transcript read.

Response: `session_id`, `state`, and, when the session has settled, the agent's
answer message: `body_md` plus its structured `meta` (confidence, caveats,
cited artifacts as short_ids the caller can then `read`). The check-only mode
(`session_id` alone) additionally returns the transcript's recent messages, so
a resumed caller regains its conversational footing. When the wait
expires with the session still open, the response says so and tells the caller
to re-call with `session_id`; real model runs take minutes, so this is the
normal path, not an error. The tool description sets that expectation.

## Auth model

- **Acting human:** `actingFor`. Sessions are keyed `asker_id = actingFor.id`,
  indistinguishable from a web ask: same privacy (asker + owner only), same
  console views, same follow-up semantics.
- **Per-call check:** the membership + policy core of `canAskContext` moves to a
  user-id-keyed helper in `apps/api/src/context.ts` (`canUserAskContext(userId,
  x)`); the Hono-context `canAskContext` delegates to it, and the MCP tools call
  it with `actingFor.id`. One source for the grant rule. Membership is
  re-checked on every call, so a human removed from the workspace or roster
  loses ask-through-agent at the same moment they lose ask-directly.
- **Workspace clamp:** `resolveWs` as everywhere else, so the grant's
  `boundWorkspaces` apply. A grant bound to workspace A cannot see or ask B's
  contexts.
- **Follow-up ownership:** `session_id` modes require `s.asker_id ===
  actingFor.id`. Anything else gets the same "no such session" a stranger gets
  from REST (404-shaped, never 403; existence must not leak).
- **Rate limit:** a dedicated `askLimiter` in `context.ts`, same construction as
  the existing publish/comment limiters, applied to MCP opens and follow-ups.
  Each ask triggers a model run on the owner's runner, and a looping agent is
  the realistic flood. The web path is unchanged.

## Answer flow and the wake signal

No session events exist today; the console polls. The MCP wait gets a real wake:

- The settle writes publish a small `session.settled` event on the asker's user
  channel (`u:<asker_id>`): the agent-answer branch of
  `POST /v1/sessions/{id}/messages`, the PATCH `failed` path, and the
  asker/owner `closed` path (any terminal transition wakes waiters, so a
  session closed from the console does not leave an MCP caller blocked until
  timeout).
- `ask` mirrors the `check_requests` pattern exactly: read the store; if still
  open and `wait` remains, `bus.waitFor` on the channel, then re-read fresh.
  The event is only a wake; the store read is always the answer, so a missed
  or raced wake is never a wrong answer. Where the backplane has no `waitFor`,
  the wait degrades to the immediate re-read, the same degradation
  `check_requests` accepts.
- The web console keeps polling. Adopting `session.settled` there is possible
  later but out of scope.

## Errors and edges

- Unknown context, or one the human may not ask: "no such context", plus the
  list of askable names (those are askable by definition, so naming them leaks
  nothing).
- Follow-up on a closed session: explicit "session is closed, open a new one".
- `state: escalated`: surfaced with `escalation_reason`; a human took it over,
  check back later.
- `state: failed`: the runner crashed; the owner sees the failure; ask again if
  needed.
- Runner offline: `list_contexts` shows `online: false`; `ask` still queues the
  question but the response warns that the runner looks offline and the answer
  arrives when it returns.
- Self-ask (a context-bound agent asking its own context): allowed. The asker
  is the human either way, and the runner daemon answers regardless of which
  client asked.
- The lost-turn race guard (`answers` on the agent's settle write) lives in the
  REST agent branch and is untouched; MCP writes only asker messages, which
  always set `open`, the same as the REST asker path.

## Out of scope, flagged for later

- **Mediating-agent provenance.** v1 records nothing about which agent asked on
  the human's behalf; the session record has no field for it and the console
  could not show it. Same gap publish had before `on_behalf_of`. When it
  matters: a `via_agent_id` column plus console display, as one change.
- **Console adoption of `session.settled`** to replace transcript polling.
- **Contexts in `catch_up`** (e.g. "you have an unread answer").

## Testing

- **MCP tool tests** (`apps/api/test/mcp.test.ts` pattern, `tools/call` over
  the stateless `/mcp` endpoint): list shows only askable contexts; ask opens a
  session keyed to the acting human; follow-up and resume modes; ownerless
  token sees neither tool; boundWorkspaces clamp; roster/membership removal
  cuts access; rate limit fires.
- **Wake test** (`mcp-inbox-wait.test.ts` pattern): a waiting `ask` returns in
  ~a beat when the agent's answer lands, not at timeout; a console-side close
  also wakes it.
- **REST parity** (`contexts.test.ts`): sessions opened over MCP are visible
  and closable in the console exactly like web-opened ones; the settle event
  publish does not change REST responses.
- **Grant-rule unit coverage** for `canUserAskContext` (creator, workspace
  policy, invited roster, non-member).
