# Agent home and the Box pilot

An agent saves a skill, model account, model, and access. A task uses the existing Job record.
The skill is a versioned `SKILL.md` bundle. Connections grant access; instructions do not.

## Start an agent

1. Connect a plan or API key in Settings → Model accounts.
2. Open Agents → New agent.
3. Describe the work. Use Chat to write the skill if useful.
4. Choose an account. Add a daily schedule or run when asked.
5. Select **Let’s go**. The first task starts in the cloud.

The form waits while Chat writes the skill. Open the skill to edit it later.
Each new task reads the current skill version. Settings changes the model and account.
The first-task and task-dialog requests carry a deduplication key.

Codex plan accounts use the official CLI's `auth.json` file. The account value stays encrypted.
Cloud runners require memory-backed `/dev/shm` storage for login files and the model home.
They fail before model startup if that storage is unavailable. Saved sandbox disks do not retain it.
The runner also removes the private directory after a normal task return.
Owner runners use the operating system's temporary directory.
Codex OAuth-token accounts are not supported. This build does not add a hosted device-login flow.

Task code can read its assigned model credential and injected secrets during execution.
Use trusted skills and repositories for this pilot. Tmpfs prevents disk persistence across stops;
it does not hide the account from the active task. A credential proxy needs separate qualification
before running untrusted code with a personal plan account.

## Select the sandbox provider

The existing controller uses `SandboxClient`. Ortam and Box implement that interface.
Agents, jobs, claims, schedules, and permissions stay in Derive.

Keep the existing Ortam settings for Ortam. To use Box, configure:

```sh
DERIVE_SANDBOX_PROVIDER=box
DERIVE_BOX_API_URL=https://boat.dev/api/v1
DERIVE_BOX_API_KEY=<inject from your secret provider>
DERIVE_MANAGED_RUNS_ALLOWLIST=<owned workspace ID>
DERIVE_ORTAM_RUNNER_PATH=/home/ortam/derive-runtime/0.8.3/node_modules/@derive-to/cli/bin/derive.js
```

The runner-path setting retains its existing name. It selects the installed CLI path.
Box uses its public v1 API. It creates a Small sandbox in the connected account's personal wallet.
It withholds owner environment variables. Resume supplies only the task's scoped environment.
Commands never contain the task token. A command is submitted once.

A stop succeeds only when Box reports `archived` and its disk-save operation reports `completed`.
Retirement archives the Box and keeps its files. It does not permanently delete the Box.
The controller refuses a stored sandbox if the provider or API URL changes.

**Runner release:** the stock pinned CLI 0.8.3 does not include this branch's usage receipts or
skill-argument fix. Publish a matching CLI release and update `runtime-setup.ts` before enabling
this build on a hosted server. A custom self-host install can use this branch's CLI directly.
The live pilot installs current branch files over the pinned CLI for verification only.

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
Cancelled tasks with missing usage do not become free tasks.

Box usage covers the task's sandbox turn, from claim to observed stop. Cold setup is separate.
A missing usage endpoint or unsettled receipt produces unknown compute cost and does not block release.
Runners cannot submit compute receipts through the report endpoint.

## Live verification

The pilot runs a separate SQLite Derive server and real Box compute. It uses the native web UI,
a saved Codex plan account, AI skill authoring, real claim tokens, live HTTP checks, and real report
publication. A verification-only transport forwards the adapter's HTTP requests through the
connected Boat tools. It does not qualify direct bearer-key transport on a hosted server.

Keep evidence outside the private server data directory. Record task IDs, skill versions, actual
model receipts, report contents, and the verified stop. Never publish cookies or account files.
Before ending the pilot, pause its schedule, verify compute is stopped, and stop the local servers.

Hosted deployment, gateway execution, GitHub/Google sign-in, external notifications, secret-provider
sync, and credential refresh over time need separate live qualification.
