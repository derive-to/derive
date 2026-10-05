---
name: loop
summary: catch up, answer comments, publish revisions, work the queue (catch_up, comment, clear_queue)
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

Review is optional. Ask for it (`request_review` on publish) when the work needs a person's
eyes or they asked for it.

## catch_up: state, feedback, history, diffs

Pass an artifact's `short_id` to get its current state: a short summary, versions since
`since_version`, changed pages, open or outdated comment threads, any review state, and the
version history.

- **Feedback queue.** Pass `comments` (open / resolved / outdated) to get a filtered
  thread list. `outdated` means the quoted text changed in a landed version, so the
  feedback may no longer apply.
- **Diffs.** Pass `response_format='detailed'` (optionally with `since_version`/`to_version`)
  to include a line-by-line diff between two versions. The diff uses readable Markdown,
  not raw HTML, so it shows what changed rather than tag noise. `since_version` defaults to
  `to_version − 1`.
- **Changed parts.** Pass `response_format='parts'` to return up to three parts that
  changed between the selected versions. Each current part includes its stable node ref and a
  bounded readable body. Removed parts keep their old ref. Use this when you need to continue
  work, and use `detailed` when you need a line audit. A reordered part returns
  `change:'moved'`, its current `node`, and its previous `from_node`. Inserts and deletes do
  not mark every shifted neighbour as moved. Bundles use `pages_changed` instead.
- **Review state.** The `review` field tracks a requested review round: `pending` means
  it is waiting; `sent_back` means the reviewer returned their answers, and their note saying
  "good to go" is the go-signal. Open or reopen a round with `request_review` on `publish`.
- **Wait (long-poll).** Pass `wait` (seconds, max 50) to block until a new review state,
  comment, or version appears, or until the time runs out. The response includes anything new
  since `since_version`. It also works without a pending review: when co-editing with someone,
  `wait` returns after their next save. Chain `wait` calls instead of sleeping between polls so feedback reaches
  you in seconds.

## comment: leave, reply, react, resolve

Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread
in one tool. Thread ids come from `catch_up`.

- **New comment.** Anchor it to a quoted span of the rendered text with `quote` (the exact
  text a reader sees, matching the visible text in the `text` read format), or omit every target
  for an ordinary general comment.
- **Reply.** Pass the thread id as `reply_to`.
- **React.** Pass `react` with `reply_to` to acknowledge the latest comment without writing a
  reply. Pass the reaction explicitly.
- **Resolve / reopen.** Pass `set_state` (`resolved` or `open`) along with the thread's id
  in `reply_to`.
- **Ask a choice.** When one decision changes the work, ask it on the artifact: a new
  comment with `body` (the question) and 2–6 `options`, or `options: []` when the
  answer is their own words. Then `show({short_id, thread})` puts
  it in front of the person where the host renders apps; elsewhere they answer on the page.
  Their answer is a reply in that thread: a choice or their own words. Ask only what the
  evidence can't settle.

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

## Standing work: give it to an agent

Work that should run again without anyone remembering to start it belongs to an AGENT: its
instructions live on a page, a `schedule` runs it on a clock, and every run is a job you can
follow (derive://skills/agents). Make one with `agents({ action: "create" })`, hand it one-off
work with `ask`, and read how its runs went with `jobs`. A multi-step plan with branches, loops or
human decisions is a graph agent (derive://skills/workflows).

An agent is not the way to answer a comment or ship one revision; that is the loop above.

## When review is requested

When `catch_up` returns `review.state === 'sent_back'`, read the open threads and the note.
If the note says it's good, stop: that is the go-signal. Otherwise revise and publish with
`request_review:true` to send the new version back. Include fixed thread ids in `addresses`
on that publish; the publish resolves those threads.
