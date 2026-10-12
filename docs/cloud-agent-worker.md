# Portable cloud-agent worker

Status: proposed design. This document stacks on PR #1014. It changes no runtime behavior.

Derive is the home for cloud work. Its worker is a lightweight coordinator.
It runs on Node or Cloudflare Workers. A sandbox provider supplies the machine.
A harness supplies the model conversation and tools. Sift is an optional workload.

## Decisions

- Keep Derive's existing Agent and Job records. A task in the UI is a Job.
- Keep skills as versioned `SKILL.md` bundles. Skills describe work; connections grant access.
- Keep the worker in Derive. Do not call Sift's deployed cloud-agent API.
- Reuse Derive's scheduler, permissions, storage ports, claims, notifications, and task pages.
- Keep harness and sandbox adapters independent. T3 is optional.
- Ship the full journey with one qualified harness first. Add adapters after the same proof passes.
- Share one coordinator between Node and Workers. Add no required external orchestration service.
- Keep user-facing setup small. Put runtime details in Settings and task details.

## What the worker does

1. Accept an authorized task from the app, API, schedule, or Slack.
2. Freeze its skill version, model account, harness, model, repository revision, and access.
3. Check credentials, budget policy, harness capabilities, and environment readiness.
4. Ask the connected sandbox provider to create or wake a machine.
5. Start a harness turn in that machine. Store its operation and conversation IDs.
6. Collect progress, tool events, results, and usage. Keep them available after compute stops.
7. Route follow-ups, answers, cancellation, and recovery through the same task.
8. Stop idle compute. Reconcile cleanup and late receipts before releasing cleanup authority.

The worker does not implement virtualization, run shell commands in its host, or invent a model loop.
It sends commands through sandbox adapters. Harness processes run inside the sandbox.
The hosted control service remains lightweight while sandbox work can run for hours.

## Product primitives

| Primitive | Meaning | User-facing location |
| --- | --- | --- |
| Agent | Saved skill, default model account, harness, model, and allowed access | Agents |
| Task / Job | One requested outcome, with its starter, conversation, turns, result, and cost | Task page |
| Turn | One admitted user message and the harness work it causes | Task conversation |
| Skill | Versioned instructions and supporting files | Agent's Skill tab |
| Environment | Pinned repository setup and required tools | Agent Settings; task details |
| Connection | Model account, sandbox account, or external tool access | Settings |

A reply continues the same task. Run again creates a fresh task and conversation.
A schedule starts each admitted run with a fresh conversation. It never resumes yesterday implicitly.
Keep the existing one-waiting-run policy. If work is still queued, coalesce later windows instead of building a backlog.
If the host misses several windows, admit the latest eligible window. Record skipped or coalesced windows for inspection.
An agent can reuse its stopped sandbox under the existing exclusive holder policy.
New tasks still use distinct conversation namespaces. Files and repository state follow the declared environment policy.

## End-to-end experience

### 1. Connect once

Sign in to Derive. Use the existing identity system; GitHub and Google remain sign-in targets.
Choose Connect a plan or Add an API key in Model accounts.
Connect the company's Boat or Ortam account in Connections.
Show Ready, Needs reconnect, Checking access, and Access not checked as distinct states.

Every company supplies its own credentials. Private model accounts require explicit sharing before team use.
Check access through the selected provider's supported flow. A connection check has its own usage record.
Keep provider-specific device approval and gateway fields in the connection flow.
Do not promise identical login methods for every harness or sandbox.

### 2. Save an agent

New agent asks what the user wants done. Chat can draft the initial skill.
Show the skill and required access before saving. Reuse the existing source editor and version history.
The main action says Let's go. The default model account and company sandbox are already selected.

Settings holds harness and model choices. Show available models for the selected account and harness.
An unsupported combination stays unavailable with a short reason. Never substitute another harness silently.
Keep the workspace switcher beside the bottom profile.

### 3. Start work

Use the shared task composer on Agents. Choose a saved agent and describe the outcome.
Enter starts work. Shift+Enter adds a line. Failed admission preserves the request.
The API uses the same permission and preflight checks as the app.

An accepted task immediately opens its task page. Show queued or starting before model execution.
Resolve missing connections and incompatible settings before allocating compute.
Repository preparation runs deterministic commands before spending model tokens where possible.

### 4. Follow the work

The task shows a conversation, a short status, and a result area.
Details contains the starter, current turn actor, skill version, repository revision, harness, model,
sandbox, environment version, event history, and usage coverage.
An initial progress line explains the current step. It never shows an invented percentage.
Results stay attached to their finished turns when new work starts. A follow-up never erases an earlier answer.

The result states what happened and links useful evidence or changes.
A routine check does not create an artifact automatically. A useful report can remain an artifact.
Run again and Make this daily remain available after a result.

### 5. Continue or recover

Send a follow-up in the task conversation. It records its own actor and immutable model choice.
If the harness supports live steering, deliver it through that adapter with a delivery key.
Otherwise queue it for the next turn. Show that it waits; never drop it.

Needs you shows the exact input or missing access. Keep the transcript and typed answer.
Field validation stays beside its field. It never recommends a fresh task or changes the task's outcome.
After admission, focus the next reply or status region. After reconnect, restore the saved request or answer.
Do not steal focus during background updates. Ignore Enter while an input method is composing text.
Tabs support arrows, Home, and End. All controls have accessible labels and visible focus.
Mobile supports start, reply, stop, reconnect, and result inspection. Keep primary task actions visible without the desktop rail.
If a checkpoint is safe, release compute while waiting. Otherwise show the temporary compute hold.
Before continuation, check current membership, access, account health, and budget again.

Resume means the original harness conversation continues. Disk restore is a separate fact.
Verify both the conversation checkpoint and expected environment before running another turn.
If continuity is unavailable, offer Start a fresh task. Link its source task and state what context it copies.
Never label reconstructed prompts or a new harness session as native resume.

### 6. Use Slack

Reuse Derive's existing Slack app and verified user link.
An explicit request such as `@derive run the docs agent` uses ordinary task admission.
An ambiguous request asks a short question before compute starts. A quick question can remain attended chat.

Map the Slack thread to one Derive task. Post a short acknowledgement and task link.
Replies continue that task. Stop cancels its active turn and pending follow-ups.
Needs you and completion notifications use the existing outbox and notification policy.
Repeated Slack events create no new task, follow-up, or notification.

Recheck the user's workspace rights for every action. Channel membership alone grants no Derive access.
Team follow-ups require the agent's existing ask permission and permission to use its model account.
The effective tool grant stays within the task's approved access and the current actor's rights.

### 7. Repeat and trigger

Make this daily uses the existing scheduler and timezone choice. Show the next run before saving.
Each admitted window has a stable submission key. Repeated delivery returns its retained admission receipt.
The schedule shows its last run and any coalesced windows. Do not replay an unbounded backlog after an outage.
Run again uses the same request and shows changes to settings or skill version before admission.
The admitted task records the actual versions; older turns never change retroactively.

A deployment webhook is another admission source. Verify its signature and map it to a workspace,
saved agent, allowed environment, and stable event key. Record the integration plus its configuring person.
For a schedule, record the schedule owner and schedule ID. Automated work has a clear origin.

### 8. Understand spend

Usage starts with cost per successful task, total AI spend, and receipt coverage.
Filter by agent, starter, harness, model, skill version, and time range.
Include failed attempts and retries. Count one receipt once even if its delivery repeats.

Keep provider-reported AI cost, API estimates, plan charges, and sandbox charges separate.
Unknown means unknown. Token usage cannot determine a subscription invoice.
Price estimates use a recorded price version and reported token categories, including cache usage when available.
A harness with no usage report shows incomplete coverage. It never produces a zero-cost result by default.

Existing budget gates remain active. Estimated or unknown usage does not imply provider billing enforcement.
Use explicit turn limits, duration limits, concurrency limits, and available provider budgets for plan accounts.
Optional trace exports can feed Langfuse. Derive remains the canonical task and cost view.

## Portable deployment

The normal deployment embeds the coordinator in Derive's API. No extra service is required.
The same bounded reconciliation pass runs under each host adapter.

| Host | Entry and wake-up | Durable state | Long-running work |
| --- | --- | --- | --- |
| Node | Existing Hono entry; timer or external scheduled invocation | Existing SQLite or Postgres MetaStore; filesystem or object BlobStore | Detached harness inside sandbox |
| Cloudflare Workers | Existing fetch entry; scheduled invocation and bounded background wake | Existing D1 or Postgres MetaStore; R2 BlobStore | Detached harness inside sandbox |

The coordinator uses explicit dependencies and Web-standard APIs such as fetch, URL, and crypto.
Node imports, filesystem access, process spawning, and Cloudflare bindings stay in their adapters.
Storage must provide the same conditional writes, unique keys, leases, and receipt semantics on both hosts.
Local filesystem storage is suitable only for a persistent Node host. Ephemeral hosts need durable storage.

An HTTP request persists admission before it returns. A wake-up is an optimization, not durable state.
An interrupted pass resumes from stored phases and provider operation receipts.
Each pass has a bounded number of transitions and external requests. It stores its next due time before yielding.
Workers never wait for the whole model run. Node never needs one in-memory process per task.
Missed wakes recover through the scheduler. Overlapping passes use conditional state changes and leases.

Start with the existing Node timer and Workers scheduled entry. Add faster host wake-ups only for a measured delay.
Do not require Durable Objects, Redis, Trigger.dev, or Temporal for coordinator correctness.
Hosts can replace their wake mechanism while preserving the same durable contract.

## Two independent adapter contracts

### Sandbox adapter

Reuse the existing SandboxClient for identity, create, inspect, launch, process status, stop, cleanup, and usage.
It currently has no file-transfer or process-output interface. Do not describe those methods as existing.
The owned runner fetches assigned input and returns observations over Derive HTTPS.
Use its authenticated protocol for checkpoints and large output. Extend the provider interface only for a proven need.
Extend it only for a real provider capability. Record the connected account identity and provider operation IDs.
Provider keys stay in the controller. A running task does not receive a sandbox control key.
Do not copy personal provider environments or a Sift snapshot into a generic default.

Replace the current unknown create body with a parsed portable creation request in the existing interface.
It names resources, the pinned base setup or provider snapshot, and permitted environment references.
Provider adapters translate that request and reject unsupported combinations before compute starts.
Declare what a snapshot preserves: files, memory, or neither. Declare stop and deletion semantics.
Readiness requires a command plus required runtime checks. Provider health alone is insufficient.
The runner and environment versions stay pinned for a turn. Verify checksums for downloaded runtimes.

### Harness adapter

The adapter translates a harness's native protocol into task turns and events.
Codex, Claude, and T3 are independent adapters. None is the canonical task store.

| Operation | Contract |
| --- | --- |
| describe | Supported accounts, models, native resume, live steering, cancellation, model switching, usage, and checkpoint behavior |
| start | Start one immutable turn with a stable operation key; return native process and conversation bindings |
| inspect | Reconcile an uncertain start or follow-up before retrying it |
| followUp | Continue a supported conversation; record whether delivery is live or queued |
| cancel | Target the exact native turn; report observed termination separately from requested cancellation |
| events | Return ordered, resumable events with a cursor and stable event IDs |
| checkpoint | Record verified conversation state or explicitly report unsupported |
| usage | Normalize reported categories and cost origin; preserve missing values |

The Linux runner handles local harness processes and credential files.
The coordinator reaches it through the sandbox API. Both Node and Workers use that same protocol.
If a harness is only a one-shot CLI, it can run tasks but cannot advertise native resume.
If model switching cannot preserve its conversation, offer a new task rather than relabeling a restart.
Capabilities are tested per adapter version and account type. A product name is not proof of a capability.

The first qualified path can be Codex's persistent conversation protocol.
Claude and T3 can follow after the same contract passes. Keep the current one-shot path honest during transition.

## Durable state and ownership

Derive owns one task record and its conversation transcript. Reuse existing Job messages and receipts.
Add a typed execution binding to the existing machine lifecycle rather than another user-visible job system.

The binding records task and workspace IDs, harness and adapter version, conversation ID,
checkpoint reference and freshness, sandbox generation, active turn ID, phase, event cursor,
lease revision, and the next reconciliation time.
Each turn records its actor, source event key, model account version, model, skill version,
access grant, repository revision, attempt IDs, outcome, and usage receipts.

Use existing MetaStore conditional writes and migrations for durable changes.
If the existing metadata cannot enforce unique keys or query required fields, add explicit schema fields.
Do not spread authoritative state across unrelated JSON slots. Do not promise that implementation needs no migration.

Derive owns turn admission and ordering. The harness owns the active model conversation and tool execution.
Only one turn owns the existing agent sandbox holder at a time.
Adapter-native queueing may deliver a turn, but it does not admit extra work outside Derive's durable turn order.
Only one coordinator path owns the sandbox lifecycle. Retire replaced launch paths after their callers move.

### A small interface with one owner per rule

Keep task commands in the existing jobs module. Keep compute reconciliation in the machine module.
The web app, MCP, API, Slack, and schedules call those owners. They do not implement a second queue.
Move current route-owned preflight and authorization decisions into the task command owner.
Route adapters verify transport identity, parse input, and call it. They retain their transport-level scope gate.
Schedules currently write Job rows directly. Route them through the same command contract with a verified schedule origin.

The control interface has three entry points. This is a proposed interface over existing modules, not a new forwarding class.

```ts
command(verifiedActor, { source, key, intent }) -> AdmissionReceipt
receive(verifiedRunner, { binding, events }) -> ReceiptAck
reconcile({ deadline, maxRecords, maxTransitions, maxRequests }) -> NextWake
```

Intents are start, message, answer, cancel, and fresh. They form a closed, parsed discriminated union.
Each intent has an agent or task ID and its required input. Callers never pass mutable database records.
AdmissionReceipt returns the task, turn, and durable command receipt IDs, plus queued, live, or held delivery.
Rejections distinguish denied access, missing connection, unsupported choice, budget exceeded, invalid state, and key conflict.
Human asks with missing access or an exceeded budget create no task or turn. Their drafts remain in the caller.
Keep the existing schedule policy: an otherwise valid scheduled window can admit a budget-held task without compute.
Only the verified origin policy permits that hold. A caller cannot choose held admission to bypass a rejection.
A connection lost after acceptance puts the existing task in Needs you. It is not a second admission result.
Retain rejected command receipts too. Replaying their key returns the same rejection after current authority checks.
After setup changes, an explicit retry uses a new key. It never silently changes a rejected command into an accepted command.
Task reads stay on the existing authorized job and message routes. Do not add another read wrapper.

| Rule | Existing owner | Callers | Planned change |
| --- | --- | --- | --- |
| Ask permission and task admission | jobs.ts: agentAccess, canAskAgent, askAgent | App, API, MCP; explicit Slack work | Reuse; freeze the execution selection at admission |
| Follow-up, answer, cancel, retry | jobs.ts: canSteerJob, followUpJob, answerJob, cancelJob, retryJob | Task page, API, Slack | Reuse; admit a durable turn without a parallel status machine |
| Due schedules and lease recovery | jobs.ts: materializeTriggers, jobTick | Node timer; Workers scheduled entry | Reuse; add the same turn and source receipt |
| Sandbox holder and lifecycle | job-machine.ts: advanceSandbox, advanceMachineJob, machinePass | Node and Workers | Extend with the harness binding; keep one lifecycle owner |
| Provider account and transport | runtime-connection.ts and SandboxClient | Machine module | Reuse Boat and Ortam adapters |
| Native model conversation | CLI provider registry and job-runner.js | Linux runner inside the sandbox | Add capability and native continuation contracts |
| Canonical task result and usage | jobs.ts: reportJob and accepted receipts | Runner callbacks; task and Usage pages | Extend turn receipts; retain the current budget owner |
| Notifications and Slack identity | notify-job.ts, slack-mention.ts, existing outbox | Task transitions and Slack entry | Reuse after task admission |

The machine module presents one bounded advance operation to either host.
Host code supplies storage and transport dependencies, a clock, and its execution budget.
The module returns a next wake time and an observed result. It does not own a permanent timer.

The harness interface stays private to the runner implementation. It normalizes native actions and events.
The qualification process publishes its parsed capability manifest with the runner release.
The coordinator reads that manifest by pinned release, harness, and account type before allocating compute.
The manifest contains data only. Workers never import Node subprocess or harness implementation code.
The active runner confirms the same manifest version. A missing qualification record or version mismatch blocks startup.
The sandbox interface stays at the existing provider seam. Neither adapter decides Derive permissions or pricing.
Use parsed discriminated unions for commands, phases, events, and outcomes. Infer types from their shared schemas.
These are proposed contracts. Existing exported names above are inspected source, not newly invented APIs.

### Durable records and query shape

Admission atomically writes the task, first turn, immutable selection, and submission-key receipt.
Follow-up admission atomically writes the message, actor, turn order, and delivery-key receipt.
If another admission wins, read its receipt and return the existing task or turn.

Require unique keys scoped to workspace and source, plus a canonical request fingerprint.
The same key and request returns its original receipt after success, failure, cancellation, or deletion.
The same key with different input returns a conflict. Redact deleted task content while retaining the replay tombstone.
Retain command receipts for the supported retry window. Publish that window in the API contract and expose expiry as a conflict.
Keep a compact tombstone after the full receipt expires, for the workspace's life.
It stores workspace, source, a keyed hash of the source key, request fingerprint, receipt ID, expiry,
and disposition. It stores no prompt, secret, transcript, or deleted task content.
The unique tombstone key rejects expired replay even after task deletion. A conflicting fingerprint remains a conflict.
Recheck current authority before replaying any receipt. The receipt cannot restore a former member's access.
Reject previously unseen stale integration events using their verified event time and source retry window.
Opaque API keys have no trusted age; their retained tombstones enforce expiry after first use.
Workspace deletion removes its keys and grants. Workspace IDs are never reused.
Bound admission rate and receipt payload size; paginate tombstone maintenance. Measure its index footprint before release.
Never let an expired source key silently create another task. A fresh task needs a new key.
Current task deduplication only finds open jobs and clears its key at settlement. It does not satisfy this contract.
Extend the existing storage owner with retained command receipts; do not rely on the current open-job index alone.
Use a unique task-and-turn sequence and a unique turn-and-adapter-event key.
Events and usage receipts are append-only. A terminal task can accept late usage without reopening.
Persist integer currency units and explicit currency and price origin. Avoid floating-point accumulation.

Reconciliation reads a bounded batch ordered by next wake time and a stable ID.
Its index narrows by workspace, eligible phase, and next wake time.
Event reads use task ID, monotonic sequence, cursor, and limit. Keep tool bodies in BlobStore when large.
Usage summaries aggregate the filtered receipt set. Lists batch account and actor reads instead of querying per task.
Retention and cleanup each use bounded batches and preserve outstanding cleanup authority.

Do not make a network call inside a transaction. Conditional writes fence each state transition.
Record an effect's stable ID before dispatch. Its retry owner reconciles that effect before another dispatch.
The storage adapter must implement these invariants on SQLite, Postgres, and D1.
Inspect their actual statement and transaction limits before selecting a migration shape.

### Effect ownership and lease fencing

| Effect | One retry owner | Stable receipt | Fence and recovery |
| --- | --- | --- | --- |
| Create or wake compute | Machine module | Sandbox generation + provider operation ID | Inspect provider outcome before repeating |
| Prepare environment | Machine module | Environment revision + preparation result | Idempotent setup commands; inspect pinned files and tools |
| Start harness turn | Runner adapter under machine supervision | Turn ID + native run ID or durable launch marker | A stale claim cannot admit work; inspect uncertain launches |
| Deliver follow-up | Task admission plus runner adapter delivery | Source key + turn ID + native acknowledgement | Deliver in turn order; reconcile acknowledgements |
| Stop model and tools | Machine module | Exact turn process group or native cancellation ID | Observe termination; stop the sandbox if containment fails |
| Store result and usage | reportJob owner | Turn, attempt, receipt ID, event sequence | Claim fence; deduplicate; retain late costs without changing outcome |
| Notify a person | Existing notification outbox | Task transition + recipient + channel | Durable delivery receipt; retry transport only |

The runner receives the claim's turn ID and fencing revision.
The attempt fence identifies one admitted attempt and stays fixed during lease renewal.
The lifecycle revision changes on conditional state transitions. It is separate from the attempt fence.
A replacement attempt gets a new fence. It invalidates old completion callbacks and command delivery.
Legitimate callbacks from the active attempt remain valid through ordinary phase changes and lease renewal.
The supervisor checks cancellation and claim validity before launch and on bounded heartbeats.
Every callback carries the same binding. A stale callback cannot overwrite a newer turn or restore state.
Lease expiry alone does not prove that the old process stops. Reconcile the old process before admitting a replacement.
External tool effects still require their own reconciliation. A claim token cannot undo an already completed external effect.

### The owned runner protocol

Use the existing detached process launch. It starts a runner with task and turn references.
The runner fetches its immutable input and pending commands from Derive over HTTPS.
It sends normalized events and checkpoint receipts back over HTTPS. No always-on runner HTTP daemon is required.
Keep prompts and credential values out of argv, provider command logs, and operation fingerprints.

The versioned envelope includes protocol version, workspace, task, turn, sandbox generation,
operation ID, fencing revision, adapter version, and the pinned input reference.
Commands are start, continue, answer, cancel, and inspect. The runner records a command acknowledgement before accepting another.
Each launch uses a durable marker for the same operation. Inspect it and native process identity after an uncertain launch.
Never rely on a PID alone; use process start identity or a native harness run ID to avoid PID reuse.

Observation batches carry ordered event IDs, native bindings, the acknowledged command ID,
an accepted cursor, and optional checkpoint and usage receipts.
The controller validates the claim binding and commits events and cursor together before acknowledging.
On response loss, the runner repeats that batch. The unique receipt keys make replay harmless.
Input reads and event batches are bounded by event count and byte size. Large tool output uses an authorized BlobStore reference.

Exact-turn cancellation is a runner command when the native adapter supports it.
The machine owner then confirms native termination or contained process-group termination.
If the runner is unreachable, use provider stop as containment. Do not infer termination from a cancelled Job row.
Bootstrap and cleanup commands are deterministic, keyed, and inspected before retry.

The runner periodically checks its claim and outstanding commands. Host wakes can request faster delivery without owning the command.
Start with queued follow-ups. Enable live steering only after ordered native acknowledgement and attribution pass qualification.
If protocol versions differ, block before execution with an upgrade action. Never silently translate an unknown event schema.

Late usage comes from an authenticated retained turn receipt or a controller-side provider lookup.
An expired or stale runner claim cannot submit a completion that reopens work.
Receipt ingestion and cost aggregation have their own unique keys and transactional writes.
The current cancelled-report addJobCost path is not sufficient; replace its unconditional addition when introducing turn receipts.

### A bounded pass on either host

The host supplies an absolute deadline, maximum eligible records, transitions, and external requests.
Count provider authentication, command delivery, and observation requests against that budget.
Stop before a deadline reserve, persist progress, and return the earliest next due time.
Each request has an abort timeout shorter than the remaining host budget.
An aborted request with an uncertain outcome stays in a reconciliation phase.

Use fair stable ordering by next due time and task ID. Persist a scan continuation where a phase requires paging.
Separate cleanup eligibility from new work so old cleanup cannot be starved by incoming tasks.
The current machinePass scans phase groups of up to 100 records. Add budget enforcement before calling it Workers-qualified.
Measure defaults against the host limits. Keep these as host configuration, not UI settings or scattered constants.

### Credentials and checkpoints

Native session storage can mix conversation state with authentication files.
Each harness adapter defines an allowlist for its persisted checkpoint and checks restoration explicitly.
Keep the active credential home in memory-backed storage. Never snapshot that credential directory.
Export only the harness's required conversation state to the task's encrypted checkpoint storage.
If a harness cannot separate its checkpoint from credentials, it does not qualify for managed resume.

Treat transcripts and tool results as sensitive workspace data. Enforce access on reads and exports.
Redact assigned credential values at ingestion where possible. Do not claim that redaction makes untrusted code safe.
The pilot runs trusted skills and repositories. A credential proxy is a separate qualification step for untrusted work.
A checkpoint has a format version, adapter version, checksum, last accepted event sequence, and retention policy.
The original task owns that checkpoint. A different account or harness cannot adopt it without an explicit supported transition.

### Data retention and environment reset

Reuse an agent's stopped sandbox only within the same workspace and approved environment policy.
Before a fresh task, reset the repository to its selected revision or explicitly keep its working changes.
If cleanup cannot remove old secrets or private files, create a fresh sandbox before another task.
Show the selected disk policy in Settings and record it on the task.

Conversation retention, repository retention, sandbox snapshot retention, and credential retention are separate policies.
Deletion immediately revokes task access and tool grants. Durable cleanup records survive until provider cleanup is confirmed.
Do not let a task disappear from the cleanup ledger while compute or a retained provider snapshot remains.

## Failure and recovery contract

| Failure | Expected result |
| --- | --- |
| HTTP response is lost after task admission | Same submission key returns the accepted task |
| Start times out after a process may launch | Inspect operation marker or native run ID; never spawn another blindly |
| Worker crashes or its request budget ends | New pass continues the stored phase under a fresh lease |
| Sandbox is healthy but cannot run commands | Needs setup; no model starts and no false success |
| Credential expires or is revoked | Needs reconnect; preserve the task and stop unneeded compute |
| Checkpoint is missing, stale, or corrupt | Resume is blocked; offer an explicit fresh task |
| Disk restores but conversation does not | Report the distinction; no native resume claim |
| Conversation restores but files are lost | Recover the pinned repo or report missing files before tools run |
| Model change cannot continue context | Explain the limit and offer a fresh task |
| Cancel races with startup or report | Late effects cannot reactivate the task; reconcile and terminate the exact process |
| Cleanup fails | Keep cleanup authority and retry visibly; show compute still active |
| Usage arrives after cancellation | Accept a deduplicated receipt without changing the cancelled outcome |
| Follow-up actor loses access | Deny delivery; do not inherit another person's account authority |
| Notification delivery repeats | Existing outbox deduplicates the delivery |

No transport can guarantee that arbitrary external tool effects happen exactly once.
Use stable provider keys where supported. Reconcile effects before retry and retain their receipts.
For effects with uncertain outcomes, show the uncertainty and require an explicit next action.

Credentials remain encrypted at rest. Inject only assigned credentials into the active sandbox turn.
The running task can read its assigned model credentials and tool secrets; tmpfs only limits disk persistence.
Recheck current policy after restore. Never treat restored credentials or a skill instruction as a new permission grant.

## Implementation in the stacked change

1. Define the typed execution and harness capability contract beside the existing machine controller.
2. Add persistent Codex conversation support in the CLI runner. Normalize turn events and usage.
3. Make the existing machine pass reconcile turns and checkpoints through that adapter.
4. Add any required MetaStore fields and regenerate schema artifacts through the repository's migration tools.
5. Add follow-up and recovery states to the existing task conversation and Settings.
6. Route explicit Slack task requests through ordinary admission and existing notifications.
7. Prove scheduled and webhook submissions use the same task, actor, and cost contracts.
8. Qualify Claude, T3, and each sandbox combination separately. Keep unsupported choices unavailable.

These are implementation steps, not claims that this design PR delivers them.
The first implementation should reuse the existing API and runner packages.
Extract another package only when a second caller needs the same module.

## Release proof

Use an isolated deployed Derive with owned storage and company connections.
The ordinary PR preview currently shares production storage and is unsuitable for task writes.
All fixtures and test credentials stay outside production.

| Case | Expected evidence |
| --- | --- |
| Generic task with no Sift files or secrets | Connect, start, file output, result, and receipt |
| Same task on Node and Workers | Same admission, state transitions, permissions, and result |
| Repository docs update | Pinned revision, check output, useful diff, and handoff |
| Follow-up while running and after completion | One task, ordered turns, same native conversation where supported |
| Stop and resume | Verified checkpoint, files, credential recheck, and same conversation |
| Owned sandbox loss | Explicit disk and conversation recovery; honest failure for stale backup |
| Cancel and duplicated delivery | No duplicate process or turn; confirmed compute stop |
| Missing tools or credentials | Input preserved; useful blocker before model execution |
| Change model or harness | Supported transition succeeds; unsupported transition stays explicit |
| Different workspace or unlinked Slack user | No task access or company credential use |
| Slack, daily run, and signed deployment event | Same admission path; correct origin, actor, task link, and deduplication |
| Late or missing usage | No double-counting; missing cost stays unknown |
| Mobile and keyboard | Start, read, reply, stop, and reconnect remain usable |
| Lost admission response after terminal outcome | Same key returns its original receipt; no new task |
| Replay after success, cancellation, deletion, and receipt expiry | Original receipt or redacted tombstone; expired and conflicting keys return conflict |
| Rejected key after setup changes | Same key returns the original rejection; an explicit new attempt succeeds with a new key |
| Lost command or event acknowledgement | Repeat the delivery; one turn, one committed event set, and one accepted cursor |
| Deadline expires during uncertain launch | Bounded exit, persisted next wake, and inspection before any relaunch |
| New work floods cleanup | Fair scans still retire old compute and retain cleanup authority |
| Lease renewal versus replacement attempt | Renewal preserves active callbacks; replacement rejects stale completion |
| Access revoked before queued delivery | Denied delivery; no inherited account or tool authority |
| Scheduler outage and queued backlog | Latest eligible window or coalesced status; no burst of missed runs |
| Atomic admission and cursor writes on each store | SQLite, Postgres, and D1 produce the same durable receipts under contention |
| Restore after model credential rotation | Same supported conversation; current credential grant; no old credential in checkpoint or snapshot |
| Qualification manifest differs from runner | Start blocked before model work; explicit upgrade action |

Record source commit, host setup, input, expected result, actual result, IDs, and useful screenshots.
Separate protocol fixtures from live-provider proof. A passing typecheck or suite does not prove recovery.
The prior Sift staging trial fails at Boat resume. Ortam still needs live qualification.

## Current source seam

The design builds on source `c6aef61a2a27a8b0bc49e7d0c507cd49f83bb516` in PR #1014.

- `apps/api/src/node.ts` runs jobTick and machinePass from its timer.
- `apps/api/src/worker.ts` runs the same functions from its scheduled entry.
- `apps/api/src/lib/job-machine.ts` owns phased sandbox creation, stop, launch, and cleanup.
- `apps/api/src/lib/jobs.ts` owns task admission, messages, claims, schedules, and settlement.
- `apps/api/src/lib/sandbox-client.ts` is the provider interface.
- `packages/cli/src/job-runner.js` runs admitted work inside the sandbox.
- `packages/cli/src/providers/codex.js` currently returns no resumable session.
- `apps/api/src/lib/chat-tools.ts` excludes agent-start tools from attended chat.
- `apps/api/src/lib/slack-mention.ts` resolves Slack identity and conversation mapping.

Sift's service contributes reviewed lifecycle lessons, not a runtime dependency.
Reuse its readiness, durable-event, and verified-restore patterns where the existing Derive owner needs them.
Do not copy its global credentials, global agent index, Sift boot paths, or required T3 services.

## Reference patterns

- [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk): execution, workspace, conversation, and UI boundaries.
- [OpenHands persistence](https://docs.openhands.dev/sdk/guides/convo-persistence): explicit saved conversation state.
- [Devin Slack](https://docs.devin.ai/integrations/slack): linked users and shared session threads.
- [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/): stated snapshot contents and prepared environments.
- [Trigger.dev idempotency](https://trigger.dev/docs/idempotency): submission keys and separate external-effect keys.
- [Langfuse cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking): reported usage and cost origins.

These references inform the contract. None is required infrastructure in this design.

## Open decisions

1. Qualify which native Codex protocol supports the selected plan and API account types.
2. Decide the repository disk retention policy for tasks that reuse an agent's sandbox.
3. Set checkpoint retention and explicit deletion behavior for each provider.
4. Measure wake-to-start delay on Workers before adding a faster wake mechanism.
5. Decide when team follow-ups may use a private account; keep explicit sharing as the default gate.

Resolve each decision during its acceptance case. Keep it visible until evidence supports the answer.

## Architecture review

Two independent reviews grade this plan's completeness at 100/100. They grade the written contract and proof plan.
They do not grade implemented code or establish parity with Cursor's running service.

| Category | Review A | Review B | Evidence |
| --- | --- | --- | --- |
| Ownership and DRY | 20/20 | 20/20 | Rule-to-owner matrix; one task command owner; transport adapters retain only transport policy |
| Leanness | 20/20 | 20/20 | Three control entry points; existing storage and scheduler; no new mandatory orchestration platform |
| Durable data design | 20/20 | 20/20 | Atomic admission; retained receipts; tombstones; indexed bounded reads; no remote calls in transactions |
| Interface and failure clarity | 20/20 | 20/20 | Qualified capability data; deterministic admission dispositions; attempt fences; native acknowledgement and recovery |
| Verification plan | 20/20 | 20/20 | Explicit fault cases for replay, host deadlines, cancellation, access loss, store contention, and credential-free restore |

The reviews first score the draft at 93 and 94. The final revision resolves their concrete deductions.
Full receipt expiry now retains a compact tombstone. Accepted-held and rejected commands have distinct policies.
Qualified capability data is available before compute. Attempt fences remain stable during lease renewal.
The proof matrix names each crash window and recovery contract.

Three interface designs are compared:

| Design | Depth and locality | Decision |
| --- | --- | --- |
| command, receive, reconcile; existing reads | Hides policy, turn order, effects, receipts, and recovery behind three entry points | Selected. Keeps the current read owner and the Linux runner seam clear |
| dispatch, read, reconcile | Gives every caller a uniform read projection as well as commands | Keep its closed intents and replay rules. Reuse existing authorized reads instead of another wrapper |
| start, send, read, cancel | Makes normal caller intent very clear | Keep the simple product actions. Map transport routes into the selected command owner |

The decision uses the existing jobs and machine modules. It does not create a forwarding coordinator class.
The selection is judged by behavior hidden from callers and locality for future changes, not file count.

Implementation remains unqualified. Native continuation, provider restore, storage changes, and host budgets must pass the release proof.
