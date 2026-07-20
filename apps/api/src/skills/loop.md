---
name: loop
summary: catch up on an artifact, work a review round, respond to feedback, and pull queued work (catch_up, comment)
order: 1
---
# The Derive working loop

Start a session with `catch_up`, respond to feedback with `comment`, and pull queued work
with `catch_up` (no short_id). This is the read → respond → revise (revise via publish) rhythm around a Derive artifact.

## catch_up: state, feedback, history, diffs

START HERE on an artifact (pass its `short_id`). Its state in one call: a one-line summary, the versions that
landed since `since_version`, which pages changed, the open (and outdated) comment threads,
the review round you're waiting on, and the full version history.

- **Feedback queue.** Pass `comments` (open / addressed / resolved / outdated) to instead
  get that filtered thread list — your feedback to-do queue. `outdated` means the quoted
  text changed in a landed version, so the feedback may no longer apply; `addressed` means a
  proposal is already pending for it (don't re-address).
- **Diffs.** Pass `response_format='detailed'` (optionally with `since_version`/`to_version`)
  to include a line-by-line diff between two versions — of their READABLE Markdown form,
  not raw HTML, so it shows what changed rather than tag noise. `since_version` defaults to
  `to_version − 1`.
- **Review state.** The `review` field tracks the round this agent is waiting on:
  `pending` = still waiting for the human; `sent_back` = the human returned answers, read
  the open threads and revise; `approved` = the go-signal to proceed. (A round is opened or re-opened with publish's `request_review` — see the publishing skill.)
- **Wait (long-poll).** WAITING ON SOMETHING? Pass `wait` (seconds, max 50): the call blocks
  until the human sends back / approves / comments / publishes a new version (or the time
  runs out), then returns the fresh state — including anything new since `since_version`.
  Works with no pending review too: co-editing live with a human, `wait` blocks until THEIR
  next save lands. Chain `wait` calls instead of sleeping between polls — feedback reaches
  you in seconds.

## comment: leave, reply, react, resolve

Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread
— all in one tool. Thread ids come from catch_up.

- **New comment.** Anchor it to a quoted span of the rendered text with `quote` (the exact
  text a reader sees — the same visible text the `text` read format shows).
- **Reply.** Pass the thread id as `reply_to`.
- **React (the lightweight ack).** Pass `react` (with `reply_to`) to acknowledge the latest
  human comment in a thread without the noise of a reply — the minimum ack the loop
  requires. 👍 is the conventional ack; pass it explicitly.
- **Resolve / reopen.** Pass `set_state` (`resolved` or `open`) along with the thread's id
  in `reply_to`.

## catch_up (no short_id): your work queue

Call `catch_up` with NO short_id for your work queue: pending requests teammates handed you
by @mentioning you in a comment (the ask-agent and Rework buttons land here). Each entry
names the artifact, the comment thread, and what to do. (A connection with no @mentionable
inbox — an OAuth grant — gets an explicit note instead of a queue.)

- **Handle then ack.** Work a request on its artifact — usually read it, do the asked
  revision, and publish with the thread id in `addresses` — then call catch_up (no short_id)
  again with `ack:[id,…]` to clear what you finished. Ack AFTER the work lands (a publish or
  a reply), not on read; an unknown or already-acked id is skipped, never an error. Unacked
  requests stay queued for your next session.
- **Wait (long-poll).** WAITING FOR WORK? Pass `wait` (seconds, max 50): when the queue is
  empty the call blocks until a new request lands (or the time runs out), then returns it —
  chain `wait` calls to react in seconds instead of polling on a cadence.

## Review-round etiquette

When the human sends a review back (`review.state === 'sent_back'` in catch_up), sweep the
open threads and acknowledge each as you address it — a `react` is the minimum the loop
requires (👍 by default), or a reply where a threaded answer helps. Then revise and
re-request review (publish with `request_review:true`). Cite the threads a revision fixes as publish's `addresses` on the SAME
publish that resolves them, so they resolve (on a live publish) or flip to `addressed` (on a
proposal) rather than being closed in a separate step.
