An agent is a named worker in a Derive workspace. It has standing instructions (a page), the
sources it may use, a model account, and a machine to run on. Every piece of work it does is a
**job**: one ask, one scheduled run, or one run of a workflow. A job has a transcript, ends
`succeeded`, `failed`, `cancelled`, or `lost`, or stops at `needs_you` when it needs a person.

This page covers making an agent, running it, giving it work, and following that work.

## Make an agent

Agents are made from a coding agent connected to Derive over MCP, such as Claude Code or Codex.
If yours is not connected yet, follow [Connect your coding agent](/agents/connect/) first.

The quickest start is the **New agent** page in Derive (Agents, then New agent). Describe what
the agent should do, copy the prompt it builds, and paste it into Claude Code or Codex. The
prompt tells your coding agent to:

1. Read `derive://skills/agents`.
2. Publish the agent's instructions as a Derive page.
3. Call the `agents` tool with `action: "create"`, passing that page's short id.
4. Hand you back the runner command, and any link you need to open in a browser.

You can also ask for it in your own words. A create call looks like this:

```text
agents({ action: "create", name: "Weekly churn digest", instructions: "<short_id>",
         machine: "owner",
         schedule: { cron: "0 9 * * 1", tz: "America/New_York",
                     instruction: "Write this week's digest." } })
```

The reply carries the agent's key once. For an agent on your own machine it also carries
`runner_command`, the one line that starts it. When a step needs a person in a browser, the
reply lists it under `needs_browser` with a link. Today that is one case: an agent on a Derive
machine with no model account yet, which needs one connected under Settings, Accounts.

Making an agent needs a seat that can publish. The agent's role defaults to `editor`, so its
jobs can publish their reports; pass `role: "commenter"` for one that should only comment. Its
role can never be higher than your own seat.

Everything else can change later, with `agents({ action: "update" })` or on the agent's
**Settings** tab in Derive: its instructions page, schedule, model account, sources, who may ask
it, whether it publishes directly or asks for review first, and whether it is paused. Deleting
an agent cancels its open jobs and removes its schedules. Its pages and reports stay.

## Choose a machine

Each agent runs on one of two machines.

| Machine | Where jobs run | Model |
|---|---|---|
| `owner` | A computer you choose, running `derive runner serve` | A stored model account, or the Claude Code or Codex login already on that computer |
| `derive` | A Derive sandbox for this agent that keeps its files between jobs | Always a stored model account |

**Owner machine.** The agent works on your laptop, a server, or a container you run. Jobs wait
in the queue until a runner picks them up. This is the default, and it works in every
workspace.

**Derive machine.** Derive starts a sandbox for the agent the first time a job needs it and
stops it between jobs, so its files persist. There is nothing to start yourself, which suits
scheduled and unattended work. Derive machines are
only available in workspaces where they are turned on; elsewhere, creating one is refused with
a message saying so. A Derive machine has no login of its own, so the agent needs a model
account stored in Derive.

## Give it secrets

A job reads secrets, such as a database URL or an API key, as environment variables. Save the
value once, then bind it to a variable name on the agent:

```bash
derive secrets put INTEGRITY_DB_URL --agent ag_... < db-url.txt
```

The value comes from stdin, or from a prompt that does not echo when you run it in a terminal,
so it never lands in a chat, a transcript or shell history. If you already saved that exact
value, Derive hands back the existing secret instead of storing a copy; pass `--new` to store
another anyway. `--agent` binds it under the secret's name, or under `--as VAR` when the name
is not a valid variable name; the agent's other variables are left alone. `--shared` saves it
for the whole workspace (managers only). `derive secrets list` shows what is saved, never the
values.

You can do the same on the agent's **Settings** tab (Environment) after saving the value under
Settings, Sources, Secrets.

## Run the runner

For an `owner` agent, the agent's page and the `agents` tool give you the command to start it:

```bash
DERIVE_TOKEN=dk_agt_... npx -y @derive-to/cli runner serve --agent ag_... --server https://derive.to
```

The runner polls Derive for the agent's jobs, does each one in `--cwd` (default: the current
directory) with the agent's instructions and model, and reports the result. It keeps a
long job's claim alive while it works, so a job is never answered twice.

| Command | What it does |
|---|---|
| `derive runner serve --agent <id>` | Work the agent's jobs until you stop it |
| `derive runner once --agent <id>` | Take one pull of the agent's jobs (as many as its concurrency allows, one by default), work them, then exit (for cron or CI) |
| `derive runner run <dkjob_ token>` | Run the one job a Derive machine was handed, then exit. Derive machines use this; you do not need it. |

The key is read from `--token`, `DERIVE_TOKEN`, or a file with `--token-file <path>` (or
`DERIVE_TOKEN_FILE`). A file keeps the key out of your shell history and the process list. The
runner never passes the key on to the model.

`serve` and `once` take these flags:

| Flag | What it sets |
|---|---|
| `--agent <id>` | The agent to work (or `DERIVE_AGENT`) |
| `--token <key>`, `--token-file <path>` | The agent's key (or `DERIVE_TOKEN`, `DERIVE_TOKEN_FILE`) |
| `--server <url>` | The Derive instance (or `DERIVE_SERVER`; default `https://derive.to`) |
| `--cwd <dir>` | Where jobs run (or `RUNNER_CWD`; default the current directory) |
| `--model <id>`, `--provider claude-code\|codex` | Override the agent's own model and provider |
| `--poll <ms>` | How often to ask for work (default 5000) |
| `--timeout <ms>` | The most one job may take (default 600000) |
| `--claude-bin <path>`, `--agent-bin <path>` | The coding agent binary to run |
| `--no-local-login` | Never use this machine's own login (or `RUNNER_LOCAL_LOGIN=0`) |
| `--mock` | Check the wiring without calling a model |

The key belongs to the agent. Its creator or a workspace owner can replace it on the agent's
Settings tab; the old key stops working at once, and you get a new runner command to start it
again.

### Model accounts and your own login

A job runs on a model account. Accounts live under **Settings, Accounts**: your own Claude or
Codex account (an API key, an OAuth token, or a pasted login file), or a shared one for the
workspace. An agent can be assigned one account. When it has none, a job on an owner machine
uses its creator's own account, then the workspace's shared one.

When no account is stored at all, a runner on an owner machine uses whatever Claude Code or
Codex login that computer already has, or a key in its environment. So a runner on your own
laptop works with the login you already use. Pass `--no-local-login`, or set
`RUNNER_LOCAL_LOGIN=0`, to require a stored account instead.

A stored account that cannot be read never falls back to the machine's own login. Derive may
try the next stored account in line (the creator's or asker's own, then the shared one), and
if none can be read, the job fails with an error.

### Keep a runner running

`runner serve` runs in the foreground. To keep it running across logouts and restarts, put it
under a service manager. Keep the key in a file only you can read:

```bash
mkdir -p ~/.config/derive && umask 077
printf '%s\n' 'dk_agt_...' > ~/.config/derive/weekly-digest.key
```

**macOS (launchd).** Save this as `~/Library/LaunchAgents/to.derive.runner.weekly-digest.plist`,
with your own paths, agent id, and working directory. A LaunchAgent runs as you, so it can use
your Claude Code or Codex login. Set `PATH` so the runner can find `npx` and your coding agent
(Claude Code's installer puts it in `~/.local/bin`). Use the `npx` path that `command -v npx`
prints.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>to.derive.runner.weekly-digest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/npx</string>
    <string>-y</string>
    <string>@derive-to/cli</string>
    <string>runner</string>
    <string>serve</string>
    <string>--agent</string><string>ag_...</string>
    <string>--server</string><string>https://derive.to</string>
    <string>--token-file</string><string>/Users/you/.config/derive/weekly-digest.key</string>
    <string>--cwd</string><string>/Users/you/agents/weekly-digest</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/derive-weekly-digest.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/derive-weekly-digest.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/to.derive.runner.weekly-digest.plist
```

**Linux (systemd).** Save this as `~/.config/systemd/user/derive-weekly-digest.service`. Put
the path `command -v npx` prints in `ExecStart`. A user service does not read your shell
profile, so set `PATH` to include `~/.local/bin` (where Claude Code installs) and the directory
holding `npx`. With nvm, that is the version's own `bin` directory, such as
`~/.nvm/versions/node/v22.11.0/bin`; it changes when you switch Node versions.

```ini
[Unit]
Description=Derive runner for weekly-digest

[Service]
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npx -y @derive-to/cli runner serve --agent ag_... --server https://derive.to --token-file %h/.config/derive/weekly-digest.key --cwd %h/agents/weekly-digest
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now derive-weekly-digest
loginctl enable-linger "$USER"   # keep it running while you are logged out
```

**Docker Compose.** [`deploy/runner.compose.example.yml`](../../../deploy/runner.compose.example.yml)
runs one runner service per agent, built from `deploy/runner.Dockerfile`, with a volume for the
agent's working directory. Its build context is the repository root (`..`), so keep your copy in
`deploy/` and run it from there. Copy it, rename the service, and set `DERIVE_AGENT`. Its env file
holds the agent's key (`DERIVE_TOKEN`) and the model credential (`ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`), plus `GH_TOKEN` when the agent needs
private repositories. A container has no login of its own, so give it one of those or assign
the agent a stored account.

```bash
cd deploy
docker compose -f runner.compose.example.yml up -d analytics
```

## Give it work

Anyone the agent lets ask can give it work. **Who can ask**, on its Settings tab, is either
everyone in the workspace or only the agent's maker and workspace owners.

- **Ask over MCP.** `ask({ agent: "ag_...", instruction: "Summarize yesterday's cancellations" })`
  opens a job and waits up to `wait` seconds (25 by default) for it to settle. If it is still
  open, check it later with `jobs`. To follow up in the same thread, pass `job_id` with a new
  instruction; a settled job reopens. `dedupe_key` makes an ask idempotent: while a job with
  that key is open, asking again returns it.
- **Ask from a page.** Any page's activity panel starts with an Ask box. Pick an agent, and the
  job it opens is about that page.
- **Put it on a schedule.** A schedule is a cron expression, a time zone, and what to do each
  time. Set it when you create the agent, or on its Settings tab. Each time it fires, it opens a
  job. While the runner is offline, a schedule keeps one job queued rather than piling up one per
  window.

## Follow its jobs

`jobs()` lists recent jobs in the workspace, `jobs({ agent })` one agent's, and
`jobs({ job_id })` one job with its transcript. The agent's **Jobs** tab in Derive shows the same
list. Cancel an open job with `action: "cancel"`, and run a failed or lost one again with
`action: "retry"`.

**Reports.** A job the CLI runner does leaves a report page: what was asked, what the agent did,
what it flagged, what it made, and its evidence. The page is private to the workspace (members
only, no link, not listed), and a follow-up rewrites the same page as a new version. A comment on
a report page reopens its job, with the comment as the next message.

**When a job needs you.** An agent can stop a job at `needs_you` with a question, and maybe a
few options. Answer it with `jobs({ job_id, action: "answer", option })` (or `text`), or in
Derive. The job continues from there.

**Inbox.** The Inbox in the sidebar lists the jobs waiting on you: the ones you asked, and the
ones on agents you manage. Answer each in place, or open the page when it asks for a review.
Below them are the pages agents published in the workspace today.

**Notifications.** When a job needs you or finishes, the person who asked hears about it (the
agent's creator, for a scheduled job), and the agent's manager hears when it needs someone. You
are never told about your own action.

- The bell, always.
- Email, when your workspace sends email and you turn on "Email me review requests and agent
  jobs" under Settings, Notifications.
- A Slack direct message, when the workspace has Slack connected and your Slack account is
  linked.
- Workspace webhooks, subscribed to `job.needs_you` or `job.finished` by name.

Email and Slack only fire for work someone asked for, or for a job that needs someone. A
scheduled job that finishes rings the bell only.

## Run it from your coding session

You do not need a separate runner to work an owner agent. From a coding session connected to
Derive, `pull({ agent })` claims the agent's queued jobs and returns each with its instruction,
transcript, instructions page, and tools. Do the work, then report each one:

```text
pull({ report: { job_id, started_at, status: "succeeded", body_md: "What I did." } })
```

Echo `started_at` exactly as the pull returned it. Report `progress` now and then on long work to
keep the claim, `needs_you` with a question to stop and ask a person, or `failed` with
`retryable: true` to have the job tried again.

## Workflows are agents too

A workflow is an agent whose instructions page holds a `derive.workflow/v1` definition. Asking
it, or its schedule firing, opens one graph job that Derive walks on the server:

- Each step asks the agent it names, as a child job on that agent's own machine.
- A human step stops the graph at `needs_you` with the options it was written with, and waits in
  the Inbox.
- A step with a choice of next step picks one with a line `ROUTE: <step>` anywhere in its
  reply. A missing or unknown route takes the fallback route, or the first route when there is
  no fallback.
- A loop that reaches its `max_attempts` fails the graph.

`derive init --template workflow` starts a page with the definition, and
`derive://skills/workflows` covers writing and running one.

## Pause agent work

Each workspace has one switch for agent work, **Agents can write**, which a workspace owner
finds under Settings, Machines. Turn it off and agents stop writing: no job is claimed,
dispatched, or started by a schedule, and their jobs wait until it is back on. Pausing a
single agent on its Settings tab does the same for that agent.
