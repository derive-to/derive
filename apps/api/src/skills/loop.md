---
name: loop
summary: catch up, respond to comments, publish updates, pull queued work, and schedule standing work (catch_up, comment, clear_queue, automate)
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

## automate: standing work, on a clock or a trigger

`automate` is the same loop without a person starting it: a stored instruction that re-runs on a
schedule or an event. Five actions share one schema, so pass only the parameters the action reads.

**Two gates, both refusing in the tool result rather than failing later.** Standing jobs need a
manage-level (owner) grant, and the workspace must have turned automations on (`automateBeta`,
which ships off). `list` works either way and reports `automations_enabled`, so check there
before building a `create` that will be refused.

- **`create`** needs `trigger` + `instruction`.
  - `trigger` is `{kind:"manual"|"schedule"|"event"}`. A schedule carries `cron` and `tz`. An
    event carries `on`, an event name. The row accepts any name, but `on:"webhook"` is the
    only one anything dispatches today, so another value creates an automation that never
    fires. A webhook mints a fire secret returned **once**, on that response. There is no way
    to read it again.
  - `instruction` is re-run verbatim, with no chat history behind it. Name the artifact it acts
    on inside the instruction; a run cannot infer "the report we discussed".
  - `refs` says what it acts on: artifact short ids, `{kind:"artifact",id}`, or
    `{kind:"tag",tag}` for a set. A run's write publishes as a new version of its target.
  - `context_id` binds the run to a context, and that context's agent acts. Omit it and Derive
    mints a managed agent for the automation.
  - `provider` picks the executing coding agent (`claude-code` by default, or `codex`).
- **`list`** returns each automation's id, truncated instruction, bound context, provider and
  enabled flag, plus the beta-gate state described above.
- **`run_now`** fires one by `automation_id`. A disabled automation, or one whose workspace has
  no way to pay for the run, is refused here rather than queued and dropped.
- **`record`** logs a run this session executed LOCALLY, so it lands in the same ledger as hosted
  runs: `outcome`, an optional `note`, and `wrote` for the short_ids it published. Only
  `outcome:"failed"` marks the run failed.
- **`create_context`** wires a new context to a manifest artifact (`name` + `manifest_short_id`),
  which needs share standing on that manifest. Skills load **only** from the manifest's
  frontmatter `skills:` list. Naming one in the body pins nothing, and the response says so
  when it spots that mistake. The context's `dk_agt_` token is deliberately not returned here.

Automations are not the way to answer a comment or ship one revision; that is the loop above.
Reach for one when the same instruction should run again without anyone remembering to start it.

## When review is requested

When `catch_up` returns `review.state === 'sent_back'`, read the open threads and the note.
If the note says it's good, stop: that is the go-signal. Otherwise revise and publish with
`request_review:true` to send the new version back. Include fixed thread ids in `addresses`
on that publish; the publish resolves those threads.
