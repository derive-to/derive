# Check the Derive–Ortam lifecycle

This is the first integration check for running Derive agents on Ortam. It uses
Ortam's public API to create a Small sandbox, run a fixed `printf` command, save
its exit status and output, stop the sandbox, and delete the disposable test
resource. A pass requires successful command output, a successful stop operation,
and a successful delete operation. Accepting a shutdown request is not enough.

This check does not dispatch a Derive agent, pass Context secrets to Ortam,
install a coding agent, clone a repository, or run a schedule. It is an operator
check, separate from the existing hosted-run dispatcher. Its local receipt is
recovery evidence for this check, not the production job store.

## Run against Ortam

Use Node 24 and an Ortam Developer API key for the intended test organization.
Supply the key through `ORTAM_API_KEY` in the shell environment; do not put it in
command arguments or commit it. `ORTAM_API_URL` defaults to
`https://api.ortam.dev/v1`. An HTTPS test deployment or a loopback HTTP API can be
selected instead. There is no automatic fallback between environments.

From the repository root:

```sh
pnpm test:ortam --state tmp/ortam-smoke/receipt.json
```

This starts paid compute. The machine has a five-minute automatic stop limit once
ready; the command has a 30-second runtime limit. The check normally stops and
deletes it much sooner. No Context, database, GitHub, or model credentials are
sent to the machine. The API key is used only to authenticate control requests.

The receipt is private to the local user and contains resource IDs, request
identity, lifecycle progress, and the fixed command's result. It contains no
API key or access token. Keep it until `cleanup_confirmed` is true. A completed
receipt is not reused for new work: use a new path for another check.

## Recover an interrupted check

Run the same command with the same receipt to continue. To abandon the command
and finish cleanup:

```sh
pnpm test:ortam --state tmp/ortam-smoke/receipt.json --cleanup-only
```

The receipt pins the API URL and organization. Different credentials are fine
only if they still belong to that organization. Machine creation, stop, and
delete requests reuse their original idempotency keys when a response is lost.
A failed check still owns cleanup. A failed deletion leaves its operation ID in
the receipt; inspect that operation in Ortam and keep the receipt until resolved.
Each invocation allows up to 15 minutes for the check and another 15 for cleanup.
If Ortam stays unreachable, the command exits with cleanup explicitly unconfirmed;
it cannot guarantee deletion during an outage. Ortam's automatic stop is the
independent compute backstop, and does not delete saved storage.

`Ctrl-C` and termination requests enter cleanup. A hard kill or machine crash
leaves a `.lock` file beside the receipt. Read its PID and confirm the original
process is no longer running before removing **only the lock file**, then rerun
with the same receipt. Do not remove the receipt or invent a replacement ID.
The check will not steal a lock just because time has passed.

Ortam process starts currently have no idempotency key. Before sending that
request, the check records that the launch was consumed. If it crashes at that
point or loses the response, it does not send another start request. It reports
an unknown command outcome and cleans up. This can miss a check; it prevents a
retry from doing the same work twice. A production executor needs its own claim
or an Ortam process request identity before retrying arbitrary agent work.

## What is tested locally

`pnpm test` includes an HTTP peer that exercises the public request shapes and
injects lost responses, failed operations, and an actual caller-process crash.
It checks recovery, cleanup, credential omission from receipts, organization
binding, and single command submission. The peer is simulated: these tests do
not prove VM provisioning, file persistence, or cloud resource release. Only a
successful receipt from a real Ortam deployment qualifies that boundary.

## Live results — 21 September 2026

The basic lifecycle passed against `api.ortam.dev`: create a Small sandbox,
run the command, confirm stop, and confirm deletion. A fresh cycle took about
31 seconds. The initial live attempt exposed a missing
`X-Ortam-Confirm-Delete` header; the check and its HTTP peer now enforce it.
Recovery deleted that first sandbox, and a second fresh cycle passed.

A separate operator experiment verified saved files:

1. Write a unique file, stop, and retain a snapshot.
2. Resume and confirm the file contents are unchanged.
3. Change the file, stop, and restore the retained snapshot.
4. Confirm the original contents have returned.
5. Stop and delete the sandbox, then delete the retained snapshot.

Every step passed. Cleanup was confirmed for both the sandbox and snapshot.
The private local receipt is
`tmp/ortam-smoke/persistence-2026-09-21.json`. This experiment is not part of
`pnpm test:ortam`; that maintained command still exercises the basic lifecycle.

The live image included Claude Code 2.1.273 and Codex CLI 0.154.0. Neither ran
an authenticated model task. `GET /agents` returned `403 session_required`
with the test API key. Ortam requires the owning user's browser session to
manage model connections and attach them to a sandbox. After attachment,
API keys owned by that same user can execute commands on that sandbox.
The pilot can therefore attach a connection in Ortam once, then use that
owner's API key for subsequent runs. Other users' keys cannot execute work
in a sandbox carrying that connection, even with lifecycle authority.

A subsequent live test ran the modified Derive runner with Codex through that
attached connection. It claimed a task from a local HTTP fixture, fetched one
selected test variable, launched real Codex, checked a file Codex wrote, and
verified report submission and successful completion. No Derive model-credential
lookup occurred. The sandbox was stopped and deleted, with cleanup confirmed in
`tmp/ortam-smoke/model-2026-09-21.json`.

The model connection and execution were real; the Derive API was a test fixture
inside the sandbox. This does not qualify the production dispatcher, hosted API
authorization, credential refresh over time, credential exclusion from snapshots,
or scheduled execution. Claude Code has local adapter coverage but has not been
run live in this test.

## Use Ortam's model connection

The local CLI now accepts `--model-auth ortam` on `derive runner run` (or
`RUNNER_MODEL_AUTH=ortam`). It requires a run-, session-, or runtime-attempt-scoped capability token.
Queue-draining and polling runners reject this mode. The default remains
`--model-auth derive`, with the existing per-task credential checks.

After an owning user's connection is attached to a sandbox, a dispatcher can
supply a fresh single-task token through the process environment and launch:

```sh
derive runner run --provider codex --model-auth ortam --cwd /home/ortam/work
```

The dispatcher supplies `DERIVE_TOKEN` and `DERIVE_SERVER`; no token belongs in
the command arguments. Ortam's administration key stays outside the sandbox.
This path requires CLI 0.7.0 or a build containing this change.

### Release order

Deploy the matching API before upgrading runners to CLI 0.7.0: runners now fetch
the task's selected variables from `/v1/agent/environment`, and fail closed if
that request cannot be authorized or served. Existing CLI 0.6.0 runners can keep
using the new API, but cannot deliver the new environment bindings.

The API and CLI 0.7.0 have shipped, and the hosted pilot has a pinned
`DERIVE_ORTAM_RUNNER_PATH`. The workspace allowlist limits dispatch and, together
with instance-operator authority, interactive pilot access. Install the pinned
CLI in a pilot sandbox before binding it, then qualify the hosted controller
with the procedure below.
Turning off workspace hosted
agents or disabling its runtime prevents new work while preserving cleanup.
Do not remove the worker's configuration while attempts still need shutdown.

In this mode the runner uses Ortam's supplied environment and login files and
never fetches or writes back Derive model credentials. Legacy run/session tokens
retain their existing repository-materialization behavior. The new attempt token
uses `/home/ortam/work` directly: it does not reset repositories or replace saved
files. The agent chooses which scripts to run and which repositories to fetch.

## Manual cloud runs

The original Cloud runs panel is operator pilot tooling. It is visible only to a
Context owner who is also an instance operator, in a workspace explicitly listed
in `DERIVE_HOSTED_RUNS_ALLOWLIST`. The API applies the same operator/workspace
boundary to runtime details, sandbox binding, runs, schedules, and disabling.
An authorized operator
connects an existing stopped sandbox, chooses Codex or Claude Code, writes an
instruction, and clicks **Run now**. The panel distinguishes receipt of the report
from confirmation that the sandbox stopped. The received report remains readable
while shutdown is pending; once settled, it also links to an owner-only Markdown
artifact. Disabling cloud runs stops new admission and sends active work into
cleanup.

Ordinary Derive users should never enter an Ortam key or sandbox ID. Automatic
provisioning is available in the operator pilot below; the managed flow described
at the end of this document also handles model sign-in inside Derive. Self-hosted
administrators configure infrastructure once for their deployment. Background
shutdown reconciliation is independent of interactive pilot access. Background
admission and guest claims recheck the workspace allowlist and the initiating
user’s operator status. Existing non-operator jobs cannot bypass the restriction
through saved schedules. Denied queued jobs are marked failed and cannot revive
when access is restored. Removing pilot access does not prevent saving an
accepted result or confirming shutdown.

Initial operator setup is explicit:

1. Install CLI 0.7.0 at a fixed path inside the sandbox, with its
   package dependencies. Keep that installation separate from `/home/ortam/work`.
   Use a pinned build; the worker does not install arbitrary latest packages.
2. Attach the owning user's model connection in Ortam. Set sandbox auto-stop to
   20 minutes or less, then stop it so this setup is saved.
3. Set `DERIVE_ORTAM_RUNNER_PATH` on the API deployment to the installed CLI's
   absolute `bin/derive.js` path.
   `DERIVE_ORTAM_API_URL` defaults to `https://api.ortam.dev/v1`.
   Enable hosted agents, agent writes, and the automations beta for the workspace.
   Both Node and Workers require an explicit workspace entry in
   `DERIVE_HOSTED_RUNS_ALLOWLIST` for pilot access; an unset or empty list denies
   interactive pilot access. Use an existing instance-operator account that can
   manage the Context. A manage-scoped OAuth grant can act for that operator
   within its allowed workspaces. Node also needs its background-worker switch.
4. In the Context's **Cloud runs** tab, enter that user's Ortam API key and click
   **Save Ortam key**, or choose an existing secret connection. The new key is
   stored encrypted for the controller and is not bound as an agent environment
   variable or source. Enter the sandbox ID and connect it. Binding checks the actual
   Ortam organization, account owner, sandbox state, and auto-stop setting.

Node reconciles every ten seconds; Workers uses the existing cron invocation.
Each pass does bounded work rather than waiting for a VM or model to finish.
The queue, ownership, launch intent, guest claim, accepted result, and confirmed
release live in the database. An expired owner is not replaced while its compute
release remains unconfirmed. A failed stop retains ownership for repair.

The controller reserves one owner per sandbox, resumes it with an idempotency
key, and records launch intent before submitting the process. Only that
controller may submit the non-idempotent process request. After a lost response,
it waits for an authenticated result or the deadline; it never repeats the
launch. The guest claims its attempt once. A lost claim response can miss work,
but cannot start a second model session. There is no automatic model retry.

The guest receives a separate `dkattempt_` capability. It cannot manage Contexts,
publish arbitrary artifacts, claim other jobs, or control Ortam. It can claim its
own pinned inputs, invoke the intersection of its original selected tools and
current grants, and submit one immutable result. Secret values are fetched at
claim time; removed or replaced bindings prevent execution, and new grants do
not widen an already-queued run. The runner uses Ortam's login and preserves its
working directory. Only identical result submissions can replay after a lost
response. Reports are capped at 16,000 characters in this first version.

Derive owns shutdown. Report acceptance does not release compute. A successful
stop operation, or observation of Ortam's authoritative `stopped` state after
its own auto-stop, proves the normal stop-and-save path completed. This path
uses Ortam's current saved filesystem; it does not create a retained named
Snapshot after each job. Ortam does not expose a named snapshot ID for normal
stop, so `saved_snapshot_id` can be null while `save_status` is `saved`.

The manual path was deployed in #933 on 21 September 2026. Execution remains
opt-in. Local coverage composes the actual Derive
routes, database and worker with a simulated Ortam HTTP peer, exercises the CLI
through a real child process with a test provider executable, and checks the
manual-run UI in a browser. The live controller qualification below uses the
actual API and worker, separately from the earlier fixture-based model test.

Scheduled admission uses the same execution path (see below). Automatic sandbox
provisioning, GitHub clone/push credential
delivery, review of learned script changes, and runtime replacement/re-enablement
are not part of this first manual-run path.

## Live controller qualification — 21 September 2026

Two successive Codex runs passed through this branch's actual Node API, SQLite
store, background worker and CLI. The API ran on a disposable Small Ortam
machine; the agent ran on a separate Small sandbox with the owning user's
Ortam-managed Codex connection. Setup and job admission used the signed-in
Derive HTTP routes. The test did not seed runs directly in the database or use
an API fixture. The Ortam administration key stayed on the API machine.

1. The first job received one selected test variable and wrote
   `persistence-proof.json` with a counter of 1.
2. Derive accepted its report, confirmed the sandbox stopped and saved, published
   a private Markdown report artifact, and settled the job as succeeded.
3. The second job resumed the same sandbox, read the first job's file, changed
   the counter to 2, and completed the same report and shutdown sequence.
4. Both report content endpoints rejected anonymous access. Both attempts had
   `save_status: saved` and a confirmed release time. Neither needed a named
   snapshot ID.
5. A final resume independently checked the file's counter was 2. The task
   variable was absent from a fresh process environment, and a scan of
   `/home/ortam/work` found neither the test secret nor an attempt-token marker.
6. The test disabled the runtime and confirmed deletion of both machines.

The private local receipt is `tmp/ortam-e2e/cloud/receipt.json`. These reports
belonged to the disposable API instance and were removed with it. The receipt
retains their text and lifecycle evidence. This operator qualification is not
part of `pnpm test:ortam`, which remains the maintained basic lifecycle check.

An earlier attempt using a laptop-hosted API produced no accepted report while
its HTTPS tunnel was losing connectivity. Derive marked the job failed with an
unknown result, confirmed stop/save, and released ownership. The test then
confirmed sandbox deletion. Runner diagnostics were not retained before that
deletion, so the tunnel failure is correlated evidence rather than a proved
root cause. The successful two-machine test removed that tunnel dependency.

This qualifies manual Codex execution through the Node/SQLite controller. It
does not qualify the hosted Workers/Postgres controller, the Workers/D1 fallback,
Claude Code, long-term
model-credential refresh, provider outages, schedules, or GitHub credential
delivery. The working-file scan is not a whole-disk or snapshot credential audit:
an agent can still write a delivered secret to other persistent files. Production
rollout and the anti-cheat pilot remain separate work.


## Context schedules

After connecting a prepared sandbox, open the Context's Cloud runs panel. Enter
its recurring task, choose Codex or Claude Code, and set a five-field cron
expression and IANA timezone. For example, `0 9 * * *` with `America/New_York`
runs daily at 9 AM local time, including daylight-saving changes. Enable the
workspace's automations beta as well as hosted agents and agent writes.

A Context has one schedule. Its definition is an Automation bound to the runtime;
ordinary automation runners cannot claim its work. The existing Node worker or
Workers cron queues the latest due occurrence as a normal runtime Run. That run
pins the current Context manifest and selected permissions. Secret values are
resolved when the agent claims the task, and Ortam continues to supply model
login. The report is private to the person who last saved the schedule.

Saving or resuming starts from that moment; it does not run an earlier occurrence.
If Derive misses several times, it queues only the latest due occurrence. A busy
runtime accepts no additional scheduled job; after it finishes, the next tick
can admit the latest due occurrence. Database constraints prevent duplicate
occurrences and multiple pending scheduled jobs across concurrent workers.

Pause or edit invalidates queued instructions. Work that has already claimed its
task finishes and saves normally. The claim checks the saved schedule revision
in the same database statement, so an edit between the controller's check and
the guest's claim prevents the old task from starting. This differs from disabling
cloud runs or revoking runtime access, which also stops active work.

The scheduler does not retry agent work automatically. Reports, stop confirmation,
and saved files follow the manual lifecycle described above. Each new run resumes
the sandbox's current saved filesystem; it does not create a named snapshot.
Schedule ownership and workspace membership are checked before unattended work.

Coverage lives in the existing Context API, shared store contract, and Cloud runs
browser test. It checks concurrent admission, missed times, stale edits, pause,
timezones, and completion after pause. The store contract runs on SQLite,
Postgres and D1. The hosted pilot passed two scheduled Codex runs on 22 September
2026, preserving files across shutdowns and producing private reports. Its
[qualification evidence](https://derive.to/artifacts/rfc-scheduled-agents-that-keep-their-work-derive-ueg04djq#hosted-pilot-setup)
is recorded in the private RFC.

## Automatic sandbox setup (operator pilot)

The Cloud runs panel can create a Small sandbox from a saved Ortam secret
connection. `POST /v1/contexts/:id/runtime/setup` takes only `connection_id`;
`GET /v1/contexts/:id/runtime` includes the durable `setup` receipt. This remains
restricted to an instance operator in an allowlisted workspace with hosted
agents and agent writes enabled. Imported Contexts cannot provision a runtime.
The configured runner path must be
`/home/ortam/derive-runtime/0.7.0/node_modules/@derive-to/cli/bin/derive.js`.

Derive persists the exact creation request before submitting it, including the
CLI 0.7.0 installation script and a 1,200-second auto-stop limit. The existing
minute dispatcher repairs interrupted setup, replays ambiguous lifecycle
requests with their original idempotency keys, checks the create result, and
stops the sandbox before waiting for model authorization. No model runs during
setup. Ortam usage is charged to the controller account.

When the panel says **Attach your model account**, open the displayed sandbox
in Ortam and use **Settings → Attach my connections**. Leave it stopped. Derive
checks that the attached account belongs to the controller's Ortam user and
then connects the runtime automatically. Model delegation directly from Derive
is still pending; API-key authorization cannot impersonate this consent.

Setup has a 30-minute deadline. Cancellation through
`POST /v1/contexts/:id/runtime/setup/cancel`, expiry, a failed installation,
Context deletion, or revoked pilot access before handover sends the newly
created sandbox to deletion. An ambiguous creation is resolved before deleting
its exact sandbox. Cleanup remains active after rollout removal and can use the
retained encrypted controller credential after its Derive grant is revoked.
Do not remove the runtime deployment configuration or vendor credential until
cleanup finishes. A vendor outage or unconfirmed deletion remains `deleting`.
The dispatcher recognizes a successful delete operation or authoritative sandbox
deletion, including cleanup Ortam completes after the original operation fails.
An authentication failure, permission error or transport error never confirms
cleanup. Accepting a delete request alone does not mark cleanup done.

One permanent database admission slot prevents manual binding and provisioning
from both claiming the same Context. Cancellation and final handover compete
through the setup revision: after `binding`, the accepted runtime is retained,
and cancellation must use the normal runtime disable flow. If the Context was
deleted after handover admission, the runtime receipt is repaired as disabled.
A completed runtime keeps its saved filesystem; setup cancellation never deletes
it. Failed setup receipts are retained for diagnosis; use a new Context to retry.

Contract coverage lives in `apps/api/test/context-connections.test.ts` (public
routes and the Ortam HTTP boundary) and `packages/db/test/store-contract.ts`
(shared SQLite, PostgreSQL, and D1 admission/cancellation contracts). Live
qualification of this automatic flow is recorded separately from the earlier
manually provisioned scheduled pilot below.

## Hosted pilot: two scheduled runs

This is an operator procedure, not an automated test result. Run it in Ortam Pilot
(`ws_5b0iz1wp99ksykr7`), a dedicated workspace owned by the pilot operator.
The deployment change adds it to the execution allowlist and preserves QA Lab's
existing access. Ortam Pilot has private artifact defaults and no other members.
Use the normal CI deployment for the runner-path setting. A local Cloudflare
login for another account cannot configure the production Worker.

Before starting, check the pilot workspace's schedules and queued work, and record its
current settings. Enabling hosted agents, agent writes, or the automations beta
can also enable other work in that workspace. If it is not an isolated test
workspace, use a dedicated workspace and review an explicit allowlist change.
Do not widen the allowlist to a working team workspace just to get this test running.

### Prepare the sandbox

1. In Ortam, create a Small sandbox with **Use my agent connections** selected
   from the account that owns the testing API key. Confirm Codex is connected.
2. Record the sandbox ID in a private local receipt before running commands.
   Set its automatic stop limit to 1,200 seconds or less.
3. In the sandbox terminal, install the published package into the versioned path
   configured in `apps/api/wrangler.toml`:

   ```sh
   mkdir -p /home/ortam/derive-runtime/0.7.0 /home/ortam/work
   npm install --prefix /home/ortam/derive-runtime/0.7.0 \
     --omit=dev --ignore-scripts --no-audit --no-fund --save-exact @derive-to/cli@0.7.0
   node /home/ortam/derive-runtime/0.7.0/node_modules/@derive-to/cli/bin/derive.js --help
   ```

4. Stop the sandbox and wait for Ortam to confirm it is stopped. This saves the
   installation and working directory. Keep the package installation outside the
   agent's working directory.

### Create and observe the schedule

Create a Context in Ortam Pilot with a private manifest describing this bounded test.
Save the sandbox owner's Ortam API key in **Cloud runs**, bind the stopped
sandbox, and enable the required workspace settings after the
checks above. Keep the receipt free of API keys, bearer tokens and secret values.

Use Codex and this instruction for both occurrences:

> Work only in the current directory. If scheduled-pilot.json is absent, create
> it with {"count":1,"label":"derive-scheduled-pilot"}. Otherwise read it, verify
> that count is 1 and label is derive-scheduled-pilot, then change count to 2.
> If the file has any other contents, report PILOT_FAILED and leave it unchanged.
> Return a short Markdown report containing PILOT_COUNT_1 or PILOT_COUNT_2 to
> match the new count, and describe whether you created or read the previous file.
> Do not access other services, send messages, or change any other files.

Save a one-minute schedule (`* * * * *`, timezone `UTC`). Do not use **Run now**:
this qualification needs jobs admitted by the production cron. Observe the
Context's runtime response at `GET /v1/contexts/:id/runtime`. Record each run ID,
its `reason: schedule`, scheduled occurrence and attempt ID. A busy sandbox does
not accumulate a job for every missed minute.

Once the second attempt has a non-null `runner_claimed_at`, immediately pause the
schedule using its current revision. A claimed job finishes after pause; queued
jobs are invalidated. If observation is interrupted, pause on recovery and
inspect the history before doing anything else. The task refuses to increment
past 2, but that is not a replacement for pausing the schedule.

For both jobs, require all of these:

- Run status is `succeeded`, with the expected count marker in its report.
- Attempt `save_status` is `saved` and `released_at` is present.
- Report artifact is readable by its owner and rejects anonymous content access.
- Ortam independently reports the sandbox as stopped after the final job.

After the second job settles, observe at least two further cron ticks and confirm
there is no third scheduled job. A null named snapshot ID is expected: normal
stop saves the sandbox without creating a retained Snapshot.

### Verify persistence and finish

With the schedule paused and both attempts released, resume the sandbox for an
operator inspection. Read `/home/ortam/work/scheduled-pilot.json` and require
`count: 2` with the original label. Stop it again and confirm completion.

Disable this test Context's runtime, delete the disposable sandbox through
Ortam, and confirm the deletion operation succeeded. Retain the private reports
and a receipt containing the production build, CLI version, workspace, sandbox,
schedule and run IDs, assertions, and cleanup outcome. Remove the test-only
Ortam connection once no runtime needs it. Restore any workspace settings changed
for the test if doing so will not interfere with work started since the test.

If a run fails, capture its report or process diagnostics privately before
cleanup. Disable the runtime to stop new work and let Derive reconcile shutdown.
Keep the controller configured until every attempt is released; removing the
runner-path setting early would also remove its cleanup worker. Do not retry a
process start whose outcome is unknown.

A pass qualifies scheduled Codex execution through the hosted Workers/Postgres
controller and saved-file persistence. It does not qualify Claude Code, GitHub
credentials, reviewed script improvements, or model refresh over several days.

## Managed jobs inside Derive

The customer flow is separately enabled with `DERIVE_ORTAM_INTEGRATION_KEY` and
`DERIVE_MANAGED_RUNS_ALLOWLIST`, together with the existing pinned runner path and
workspace hosted-agent, agent-write and automation settings. The key must be an
Ortam **Service integration** key. Keep it on the deployment; no user connection
or runner environment receives it. Existing operator provisioning stays available
under its original gate. An empty managed allowlist disables new work; retain the
key until all active attempts and pending setup cleanup are settled.

A job keeps its configured runner, model connection and Context tools. Its Context
creator or a workspace manager connects an account in Derive through the provider's
sign-in page. This explicitly lets the job use that account for authorized manual
and scheduled runs. Model refresh authority stays in Ortam. Each workspace/Context
pair has a distinct external connection identity, even if Contexts reuse an internal
Derive agent ID. Same-owner service-key rotation preserves those identities.

The run permission is workspace publish access plus access to the Context (creator,
invited asker or workspace ask policy). Editing still requires Context management.
Manual runs consume the saved schedule's instruction, provider and revision rather
than parameters supplied by the triggerer. Edits invalidate queued stale definitions;
claimed work finishes against its pinned input and live tool-grant intersection.
Disconnecting an account prevents new runs and withdraws model delivery. Dispatch,
runner claims and every tool call share the live execution grant, including the saved
runtime's rollout mode, membership, Context access and controller status. Revocation
still permits result receipts and shutdown; it never converts a managed runtime into
an operator runtime, or the reverse.

Customers see provider sign-in, preparation, the job and run status. Service identities,
controller references and sandbox IDs are omitted from the managed status projection.
Reports retain the existing initiator privacy rule. Provisioning uses the existing
replayable setup state machine with automatic connection attachment. Legacy controller
references become nullable through receipt-preserving SQLite/D1 rebuilds and a Postgres
constraint relaxation; null denotes deployment-owned authority.

Local contract and browser checks qualify this implementation. The previous live
operator pilot does not establish live service-integration qualification: deployment
of the Ortam integration API, deployment configuration, fresh provider authorization
and two real scheduled runs remain the live acceptance check.

### Reusable model connection foundation

The replacement account API is `/v1/runtime-model-connections`. It gives a named
Codex or Claude account its own identity, independent of a Context. The owner can
create/list/read/rename the reference, start/poll/complete/cancel provider sign-in,
read `/status`, and disconnect it with `DELETE`. Only the connection owner may
manage its login; workspace membership or permission to edit an unrelated job does
not grant that authority. Infrastructure identifiers and provider credentials are
excluded from responses.

Creating a connection or starting/completing sign-in requires managed rollout and
publish access. An owner who still has workspace read access can inspect or cancel
an existing sign-in and disconnect the account after either gate is withdrawn.
Status responses recheck local revocation after reading the provider, so a slow
provider response cannot overwrite a completed disconnect with an active account.

A connection's immutable ID and workspace determine its integration subject, in
a namespace separate from legacy Context subjects. Its expected Ortam organization,
user identity and API origin are saved at creation. A configuration change cannot
silently transfer it to another service-key owner or backend. Credentials remain
in Ortam; Derive does not copy refresh tokens into jobs or its existing local-runner
model-credential store.

Disconnect permanently revokes the reference in Derive before contacting Ortam.
A remote failure returns an incomplete-cleanup error; retry `DELETE` using the
same ID. The revoked record remains readable by its owner for recovery and cannot
be reactivated. Reconnecting an active account keeps its identity; after explicitly
revoking a connection, create a new one. The backend must support disconnecting a
pending sign-in and retrying a completed disconnect before this flow is activated.

This is the first implementation slice. Job selection/grants, switching an existing
machine while stopped, the account picker, and a two-job live acceptance test are
still required. The existing managed setup continues to use its legacy Context
subject until those pieces land. Keep the managed allowlist disabled during that
transition; do not interpret this API as an enabled customer workflow or migrate
consent based on matching account email addresses.
