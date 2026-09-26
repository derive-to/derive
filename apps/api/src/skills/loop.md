---
name: loop
summary: catch up, respond to comments, publish updates, pull queued work, and schedule standing work (catch_up, comment, clear_queue, list_automations, automate)
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
schedule or an event. Four actions share one schema, so pass only the parameters the action reads.
Reading what already exists is the separate `list_automations` tool, which writes nothing.

**Two gates, both refusing in the tool result rather than failing later.** Standing jobs need a
manage-level (owner) grant, which `list_automations` needs too. The workspace must also have
turned automations on (`automateBeta`, which ships off); that second gate binds `create` and
`run_now` only, so `list_automations` works either way and reports `automations_enabled`. Check
there before building a `create` that will be refused.

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
  - `context_id` binds the run to a Context. An Agent executes the work using that package. Omit it
    and Derive mints a managed execution connection for the automation.
  - `provider` picks the executing coding agent (`claude-code` by default, or `codex`).
- **`run_now`** fires one by `automation_id`. A disabled automation, or one whose workspace has
  no way to pay for the run, is refused here rather than queued and dropped.
- **`record`** logs a run this session executed LOCALLY, so it lands in the same ledger as hosted
  runs: `outcome`, an optional `note`, and `wrote` for the short_ids it published. Only
  `outcome:"failed"` marks the run failed.
- **`create_context`** wires a new Context to a manifest artifact (`name` + `manifest_short_id`),
  which needs share standing on that manifest. Skills load **only** from the manifest's
  frontmatter `skills:` list. Naming one in the body pins nothing, and the response says so
  when it spots that mistake. The Agent execution connection's `dk_agt_` token is deliberately not
  returned here.

`list_automations` takes no arguments and returns each automation's id, truncated instruction,
bound Context, provider and enabled flag, plus the beta-gate state described above.

Automations are not the way to answer a comment or ship one revision; that is the loop above.
Reach for one when the same instruction should run again without anyone remembering to start it.

## When review is requested

When `catch_up` returns `review.state === 'sent_back'`, read the open threads and the note.
If the note says it's good, stop: that is the go-signal. Otherwise revise and publish with
`request_review:true` to send the new version back. Include fixed thread ids in `addresses`
on that publish; the publish resolves those threads.

### Cloud workflow readiness

For a workflow that keeps working files, call `list_automations` with `workflow_id`
(the workflow’s Context ID). It returns the same readiness state, ordered reason
codes, permitted actions, configuration revision and evaluation time as the web
setup page. This is a read, not permission to execute. Editing and execution through
the management API require a management grant; read-only connections cannot acquire
those powers from a readiness result. Ready does not mean local project files have been transferred. The agent handles
dependencies during ordinary execution; no separate setup feature is required.

### Offload a local job to a persistent workflow

Use the `workflow_*` actions below for a cloud agent that retains its working environment.
`automate(create)` and `automate(run_now)` use the ordinary task path; attaching a Context
there does not select a persistent sandbox. Do not create an ordinary task as a substitute.

The caller needs an OAuth management grant (`derive:manage`) and a workspace seat permitted
to publish. Registered runner tokens cannot manage workflows. Pass `workspace` by ID or name
when it differs from the connection default. All operations reuse the web API's authorization,
revision checks, live access checks and execution queue. No temporary bearer is exposed.

Read with `list_automations(view: ..., workflow_id?: ..., workspace?: ...)`:

| view | ID? | Returns |
| --- | --- | --- |
| `workflows` | no | Available workflows and whether creation is available |
| `configuration` | yes | Draft or established schedule, selected source IDs, readiness and latest test request |
| `runs` | yes | Existing run history, schedule and execution state |
| `account` | yes | Assigned model account and its binding revision |
| `environment` | yes | Environment variable names mapped to credential IDs; never values |
| `accounts` | no | Your saved model accounts |
| `credentials` | no | Available credential names, IDs and use/manage permissions; never values |
| `connections` | no | Connected sources that can be assigned |

Write with `automate(action: ..., context_id?: ..., workflow: {...}, workspace?: ...)`.
Here `context_id` is the workflow ID. Omit it only for `workflow_create`. Put all operation
fields inside `workflow`; do not mix them with ordinary automation parameters. Each read or
write returns `{status, result}` with the HTTP result, including actionable failures.

| action | workflow fields |
| --- | --- |
| `workflow_create` | `name`, optional `model_connection_id`, stable UUID `request_id` |
| `workflow_save` | `instruction`, `provider` (`codex` or `claude-code`), numeric draft `revision` |
| `workflow_account` | `connection_id` (or null to unassign), binding `revision` (null before first assignment) |
| `workflow_environment` | `bindings`: complete map of environment variable names to saved credential IDs |
| `workflow_files` | `short_id`, exact numeric `version`, attachment `revision` (null before first selection); set both `short_id` and `version` to null to remove |
| `workflow_repositories` | `repositories`: complete list of `{connection_id, repository: "owner/name", access: "read" or "write"}`; numeric `revision` from `configuration.repository_revision` (starts at 0); empty list removes access; workspace owner required |
| `workflow_connections` | `connection_ids`: complete list of source connections to allow |
| `workflow_test` | `revision`: reviewed readiness hash; stable UUID `request_id` |
| `workflow_schedule` | `instruction`, `provider`, `cron` (or null for manual), IANA `timezone`, `enabled`, numeric schedule `revision` |
| `workflow_cancel_preparation` | empty object; cancels unfinished preparation through the existing cleanup path |
| `workflow_disable` | empty object; disables future runs; this is not a pause/resume switch |

1. Inspect the actual local job. Write self-contained instructions: the remote run does not
   inherit local conversation history. Identify the files and access it actually needs.
2. List workflows first so a resumed migration does not create a duplicate. Create a draft
   with a stable request UUID; save instructions using its returned draft revision.
3. List and assign a saved model account. If none exists, the human connects one in Derive.
   Reuse saved credentials by ID and bind only the required environment variables/sources.
   New secret values can be transferred through the management API using `stage(target:'api')`
   and a shell, with the user's authorization. Never put them in workflow instructions,
   artifacts, tool arguments, logs or an uploaded `.env` file.
4. Transfer local scripts/data as a ZIP with `stage(target:'doc')` and multipart
   `file_bundle=true`; see the publishing skill. Keep credentials and local caches out.
   Read `configuration.files.revision` (null before first selection), then attach the
   upload’s `short_id` and exact version with `workflow_files`. Uploading alone does not
   attach files. People allowed to run this workflow can use the selected files; the source
   artifact’s sharing stays unchanged. Share standing on the source is required.
   For Git repositories, use `workflow_repositories` with a workspace GitHub App connection
   from `connections` and an exact `owner/name`. Read access lets the agent clone/fetch over
   HTTPS; write access also allows pushes and creating PRs through `github.post`. The server
   verifies installation access and permissions before saving. Missing permission approval is
   completed in Settings → Integrations → GitHub. The agent clones only when needed and owns
   its saved working directory; there is no separate checkout or dependency setup phase.
   Once repository access is configured, cloud-run GitHub tools are confined to that selection;
   it does not grant Actions access. Repository grant changes invalidate old accepted runs.
   Tokens are issued for one repository, never placed in a remote URL or saved Git config.
   Removing access stops further issuance; an already issued token can live up to one hour.
   The ordinary `workflow_connections` GitHub source alone does not grant shell Git access.
5. Read `configuration`, resolve its blockers, and submit `workflow_test` with the readiness
   revision. Reuse the same request UUID after a lost response. This queues one durable run
   and automatically prepares the environment if needed; closing the client does not lose it.
   Poll configuration/runs to distinguish preparation, submission, actual success and saving.
6. The remote agent installs missing dependencies as part of its ordinary first run. There
   is no user-defined dependency setup stage. Inputs arrive in a verified version-specific
   directory before the agent starts. The agent copies/adapts files into its working directory;
   later runs resume those working files. A new upload or removal affects future accepted
   runs, never overlays working files, and cannot erase copies already made. Explicitly
   select a new version to update an input. Revoking the grantor’s source access blocks
   further delivery, including for an accepted run.
7. After checking the report and saved-state result, read the established schedule revision
   and use `workflow_schedule` to set the authorized cadence. Setting `enabled:false` pauses
   the schedule while preserving manual runs. Schedule editing also owns instruction updates
   after preparation; `workflow_save` is only for the pre-runtime draft. A 409 means reread
   and reconcile, never silently overwrite newer work. Cut over an existing local schedule
   deliberately so both schedulers do not perform the job at once.
