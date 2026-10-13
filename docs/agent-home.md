# Agent home and sandbox connections

For the proposed harness-independent worker and complete journey, see
[Portable cloud-agent worker](cloud-agent-worker.md). That design changes no runtime behavior.

An agent saves a skill, model account, model, and access. A task uses the existing Job record.
The skill is a versioned `SKILL.md` bundle or a standalone Markdown instructions page.
Connections grant access; instructions do not.

## Start an agent

1. Connect Boat or Ortam in Settings → Connections.
2. Connect a plan or API key in Settings → Model accounts.
3. Open Agents → New agent.
4. Describe the work. Use Chat to write the skill if useful.
5. Choose an account. Add a daily schedule or run when asked.
6. Select **Let’s go**. The first task starts in the cloud.

The form waits while Chat writes the skill. The agent’s Skill tab reads and edits the same artifact.
Use Write with AI for Chat, or Edit instructions for the existing source editor.
Saving creates a version. A plain SKILL.md bundle needs no Derive sidecar.
Standalone Markdown instructions stay Markdown when saved from the Skill tab.
Unsaved instructions and version notes require a choice before leaving the editor.
Saving checks the version atomically. A conflict keeps the draft and shows an inline error.
Each new task records its skill version. Settings changes the model and account.

Agents home has Your agents, Tasks, and Usage views. The shared composer starts a task on a saved agent.
New agent carries the typed brief into setup. Paused agents accept tasks that wait for resume.
Tasks supports search and status filters. Each task shows its result inline.
Usage and activity stay collapsed until opened. Useful artifacts remain linked on the task.
Routine runs create no report artifact. Unstructured replies stop at Needs you.
Usage separates reported spend from API estimates. It compares agents and models.
The first-task and composer requests carry a deduplication key.

The roster returns server-calculated ask and manage permissions from one membership read.
Task submission checks the same policy and the caller’s scope.
A read-only OAuth grant cannot start work. Narrow grants retain their existing management scope.

Connect with Codex opens a guided device approval. An isolated Boat runs the official Codex
app-server. The person approves on Codex, then a small model call checks access.
The connection becomes ready only after that check. The check uses plan allowance or API credit.
It is separate from the task cost ledger. Accounts stay private unless an owner selects sharing.
Importing a Codex login or API key uses the same check when Boat is enabled.
Other imports show Access not checked yet. Connecting accounts cannot be assigned to a new agent.

Reconnect keeps the account ID and agent assignments. Queued cloud tasks wait before compute
allocation. Cancel restores the previous encrypted credential. Expired attempts hide their code.
Retry replaces the attempt. Scoped callbacks cannot complete an expired or replaced attempt.
Connection sandboxes have a ten-minute TTL and archive after success, failure, or cancellation.

Codex plan accounts use the official CLI's `auth.json` file. The account value stays encrypted.
Cloud runners require memory-backed `/dev/shm` storage for login files and the model home.
They fail before model startup if that storage is unavailable. Saved sandbox disks do not retain it.
The runner also removes the private directory after a normal task return.
Owner runners use the operating system's temporary directory.
Codex OAuth-token accounts are not supported. Plan connections require a workspace Boat connection.
The runner saves changed Codex credentials before reporting. A claim and credential version fence
each write. A stale task cannot overwrite a reconnect or another refresh.

Task code can read its assigned model credential and injected secrets during execution.
Use trusted skills and repositories for this pilot. Tmpfs prevents disk persistence across stops;
it does not hide the account from the active task. A credential proxy needs separate qualification
before running untrusted code with a personal plan account.

## Select the sandbox provider

The existing controller uses `SandboxClient`. Ortam and Boat implement that interface.
Agents, jobs, claims, schedules, and permissions stay in Derive.

Set the default provider and pinned runner on the deployment. Workspace connections override the default:

```sh
DERIVE_SANDBOX_PROVIDER=boat
DERIVE_ORTAM_RUNNER_PATH=/home/ortam/derive-runtime/0.8.3/node_modules/@derive-to/cli/bin/derive.js
```

A workspace owner opens Settings → Connections → Connect sandbox, then selects Boat or Ortam.
Derive verifies the account and encrypts the key. The controller holds it; tasks never receive it.
Each workspace uses its own connection. The runner-path setting keeps its existing name.
No deployment secret is needed for a workspace connection.

Ortam requires a Developer API key with `sandboxes:read` and `sandboxes:write` scopes.
Its public API exchanges the key at `/v1/auth/token`. Resource requests carry the short-lived token.
Each request checks the same organization and user. A different account cannot replace an active key.
The public API creates a plain Small sandbox with a 20-minute automatic stop limit.
Public processes run as the workspace user. The adapter maps the saved runtime to `/workspace`.
If the image lacks Node 24+, it installs pinned Node 24.14.0 with verified release hashes.
The ordinary job launch installs the pinned Derive CLI. No custom environment or template is created.
Ortam compute cost remains unknown until a task-specific usage receipt is available.

Disconnect before changing providers. The controller retains the old key for cleanup.
Replacement waits until all agent sandboxes finish retirement and pending model sign-in is cancelled.
Ortam retirement deletes agent sandboxes and their saved files. Boat retirement archives them.
The disconnect confirmation explains this difference. Provider, API URL, identity, and connection
stay pinned for the sandbox's life. Each sandbox retains an encrypted cleanup credential so a
replacement race cannot strand it. Same-account rotation uses the current key. Existing deployment-managed Ortam sandboxes keep their original
integration credential; a workspace connection cannot take over that identity.

Codex device sign-in currently needs a Boat connection. Saved plan logins and model API keys run
on either provider. Ortam users import their login or model key in Model accounts.
Existing allowlisted Ortam service integrations remain available under their deployment settings.

Boat creates a Small sandbox in the connected account's personal wallet.
Runner setup accepts an optional company snapshot for new agents. The controller freezes its
name before create, so retries and recovery send the same request. Existing agents keep their files.
The workspace owner must approve the snapshot's code, tools, and saved files for that workspace.
Derive withholds the account's environment. Resume supplies only the task's scoped environment.
Commands never contain the task token. A command is submitted once.

A stop succeeds only when Boat reports `archived` and its disk-save operation reports `completed`.
Retirement archives the Boat and keeps its files. It does not permanently delete the Boat.
The controller refuses a stored sandbox if the provider or API URL changes.

**Runner release:** the stock pinned CLI 0.8.3 does not include this branch's usage receipts,
skill-argument fix, or refresh handoff. This branch releases CLI 0.8.5 through trusted publishing after merge.
After npm confirms that release, update `runtime-setup.ts` and the deployed runner path before enabling
this build on a hosted server. A custom self-host install can use this branch's CLI directly.
The live pilot installs current branch files over the pinned CLI for verification only.

## Preview setup

Each PR preview owns a D1 database and R2 bucket. It has no production Hyperdrive binding.
The preview does not pass the Boat runtime settings. Configure the runner path and connect
the company Boat key in the isolated workspace before checking task writes.
Keep `DERIVE_AUTH_SECRET` stable; it encrypts accounts and signs callbacks.
The existing secret names cover this connection flow. Each person supplies their own plan approval
or provider key. A workspace owner supplies the company Boat key.

The owned HTTPS preview uses the native Boat bearer transport and matching branch CLI.
Publish and pin the matching runner release before enabling ordinary hosted tasks.
The preview has no cron or queue consumer for daily runs. Add a scheduler to that isolated
environment before testing daily execution. A local controller tick proves the pilot only.

## Read AI cost

Each accepted runner report records its actual provider, model, skill version, duration, and tokens.
The runner adds usage from internal retries. Derive keeps reports from each accepted attempt.
Existing dollar costs continue to accumulate across attempts.

The UI keeps three facts separate:

- The reported AI subtotal adds the dollar costs the runner reports. Missing attempt costs stay unknown.
- API estimates compare measured Codex tokens with published Standard text rates.
- Sandbox spend comes from the provider after compute stops.

The API estimate uses rates checked on October 11, 2026. It supports exact `gpt-6-luna` and
`gpt-6.1-sol` IDs. It excludes tool fees, cache writes, regional fees, and other service tiers.
Unknown models, missing tokens, and input totals above 272,000 produce no estimate.
An estimate never updates billed cost or the workspace budget.

Compare models on the same task and skill version. Read the report before choosing a cheaper model.
The summary covers loaded tasks. It does not claim all-time totals. It shows receipt coverage.
The completed-task estimate includes every recorded attempt of each measured completed task.
An attempt without a receipt makes the whole-task estimate unknown.
Receipt indexes continue across manual retries and follow-ups. The retry budget resets separately.
Older tasks without that baseline have an unknown whole-task estimate. Per-run estimates remain visible.
Cancelled tasks with missing usage do not become free tasks.

Boat usage covers the task's sandbox turn, from claim to observed stop. Cold setup is separate.
A missing usage endpoint or unsettled receipt produces unknown compute cost and does not block release.
Runners cannot submit compute receipts through the report endpoint.

## Live verification

The pilot runs a separate SQLite Derive server over HTTPS and real Boat compute.
It uses the native web UI, a saved Codex plan account, real claim tokens, live HTTP checks,
inline results, saved skill versions, and native direct Boat HTTPS calls. A preview-only bootstrap
installs the pinned branch CLI archive for new and resumed sandboxes. It does not change credentials
or forward Boat operations through another gateway.

Keep evidence outside the private server data directory. Record task IDs, skill versions, actual
model receipts, report contents, and the verified stop. Never publish cookies or account files.
Stop local servers started for a check. Leave explicitly requested preview workflows available.
Verify task compute releases after each run. Do not disable the existing daily scheduler.

The guided device approval, verified login import, and a task on the new account pass live.
The refresh route passes real claim and stale-version checks. Long-lived provider token rotation
still needs qualification. Hosted deployment, gateway execution, GitHub/Google sign-in, external
notifications, and secret-provider sync also need separate live qualification.
