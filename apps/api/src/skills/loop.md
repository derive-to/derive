---
name: loop
summary: catch up on an artifact, respond to comments, publish updates, and pull queued work (catch_up, comment, clear_queue)
order: 1
---
# Comments and updates

Start with `catch_up`, read the relevant work, respond where a comment needs an answer, and
publish the next version. Call `catch_up` without a `short_id` to see work that people have handed
to you.

## The normal workflow

1. Call `catch_up` with the artifact's `short_id`.
2. Read the sections needed for the task.
3. Reply when a comment needs an answer. A reaction is enough for a simple acknowledgement.
4. Publish the update and include fixed thread ids in `addresses`.
5. Repeat when more feedback arrives.

Formal review is optional. Use it only when someone asks for a recorded decision or permissions
require a proposal.

## catch_up: state, feedback, history, diffs

Pass an artifact's `short_id` to get its current state: a short summary, versions since
`since_version`, changed pages, open or outdated comment threads, any formal review state, and the
version history.

- **Feedback queue.** Pass `comments` (open / addressed / resolved / outdated) to
  get a filtered thread list. `outdated` means the quoted
  text changed in a landed version, so the feedback may no longer apply; `addressed` means a
  proposal is already pending for it (don't re-address).
- **Diffs.** Pass `response_format='detailed'` (optionally with `since_version`/`to_version`)
  to include a line-by-line diff between two versions. The diff uses readable Markdown,
  not raw HTML, so it shows what changed rather than tag noise. `since_version` defaults to
  `to_version − 1`.
- **Formal review state.** The `review` field tracks a requested review round:
  `pending` means it is waiting; `sent_back` means the reviewer returned comments;
  `approved` records approval. Open or reopen a round with `request_review` on `publish`.
- **Wait (long-poll).** Pass `wait` (seconds, max 50) to block until a new review state,
  comment, or version appears, or until the time runs out. The response includes anything new
  since `since_version`. It also works without a pending review: when co-editing with someone,
  `wait` returns after their next save. Chain `wait` calls instead of sleeping between polls so feedback reaches
  you in seconds.

## comment: leave, reply, react, resolve

Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread
in one tool. Thread ids come from `catch_up`.

- **New comment.** Anchor it to a quoted span of the rendered text with `quote` (the exact
  text a reader sees, matching the visible text in the `text` read format).
- **Reply.** Pass the thread id as `reply_to`.
- **React.** Pass `react` with `reply_to` to acknowledge the latest comment without writing a
  reply. Pass the reaction explicitly.
- **Resolve / reopen.** Pass `set_state` (`resolved` or `open`) along with the thread's id
  in `reply_to`.

## catch_up (no short_id): your work queue

Call `catch_up` without a `short_id` for your work queue: pending requests teammates handed you
by @mentioning you in a comment (the ask-agent and Rework buttons land here). Each entry
names the artifact, comment thread, and requested work. An OAuth connection without an
@mentionable inbox returns a note instead of a queue.

- **Handle, then clear.** Read the artifact, make the requested change, and publish with the
  thread id in `addresses`. Then call `clear_queue` with
  `ack:[id,…]` to clear what you finished. Clear it after the work lands (a publish or a
  reply), not on read. Unknown or already cleared ids are skipped. Unacknowledged requests stay
  queued for the next session. `clear_queue` is separate so `catch_up` remains read-only.
- **Wait (long-poll).** Pass `wait` (seconds, max 50). When the queue is
  empty, the call blocks until a new request lands or the time runs out, then returns it.
  Chain `wait` calls to react in seconds instead of polling on a cadence.

## When formal review is requested

When `catch_up` returns `review.state === 'sent_back'`, read the open threads and revise the
artifact. Reply where an answer will help. Publish with `request_review:true` to send the new
version back for review. Include fixed thread ids in `addresses` on that publish. A live publish
resolves those threads; a proposal marks them addressed until approval.
