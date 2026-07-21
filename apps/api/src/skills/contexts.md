---
name: contexts
summary: use a workspace's live data agents (find, use)
order: 4
---
# Using workspace contexts

Workspaces can host CONTEXTS — askable live data agents a workspace owner wired up, each
answering questions against its own data and tools. `find` surfaces the ones your user may
use (as typed context rows in browse/search); `use` opens a session on your user's behalf —
a question or a commission — and returns the answer.

## Discovering contexts with find

`find` (browse, or a query whose text matches a context name) lists the contexts you may
use in a workspace — id, name, whether the runner is online (its last queue poll is recent),
the manifest doc that defines it, and your own still-open sessions so you can resume one with
`use`. Using happens on your user's behalf and is granted per context, so what `find`
surfaces is EXACTLY what your user may use, nothing more. Then call `use` with a context's id
or name.

## use: open, follow up, or check

Use a context on your user's behalf, or resume/follow up an existing session:

- **OPEN** a new session: pass `context` (id or name) + `question`.
- **FOLLOW UP** an existing session: pass `session_id` + `question` (it already knows its
  context, so don't also pass `context`).
- **CHECK / RESUME**: pass `session_id` alone (no question) to read the latest state and
  transcript.

The call waits up to `wait` seconds (default 25, max 50; 0 = return at once) for the runner's
answer and returns it inline when it lands. Real runs often take MINUTES, so a still-open
response is NORMAL, not an error: an expired wait leaves the session open — re-call `use`
with the returned `session_id` (+ `wait`) until it settles. Sessions resume across calls
and across your own sessions; a context row in `find` surfaces your still-open ones. If the
runner looks offline, the session is queued and answers when it comes back. Answers cite
artifact short_ids you can then `read`.

A settled session is normally `answered`; it can instead come back `escalated` (the runner handed a draft to a human reviewer, check back later) or `failed` (the run crashed, just ask again). Re-calling `use` always returns the current `state` and a one-line `note`.
