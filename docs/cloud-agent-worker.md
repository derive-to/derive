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
A schedule creates a fresh task for each due window. It never resumes yesterday implicitly.
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

The result states what happened and links useful evidence or changes.
A routine check does not create an artifact automatically. A useful report can remain an artifact.
Run again and Make this daily remain available after a result.

### 5. Continue or recover

Send a follow-up in the task conversation. It records its own actor and immutable model choice.
If the harness supports live steering, deliver it through that adapter with a delivery key.
Otherwise queue it for the next turn. Show that it waits; never drop it.

Needs you shows the exact input or missing access. Keep the transcript and typed answer.
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
Each due window has a stable submission key and creates one new task.
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

Reuse the existing SandboxClient for create, inspect, command, file transfer, stop, cleanup, and usage.
Extend it only for a real provider capability. Record the connected account identity and provider operation IDs.
Provider keys stay in the controller. A running task does not receive a sandbox control key.
Do not copy personal provider environments or a Sift snapshot into a generic default.

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
