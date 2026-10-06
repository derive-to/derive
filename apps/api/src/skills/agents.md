---
name: agents
summary: make, ask, and run agents, and follow their jobs (agents, ask, jobs, pull)
order: 5.8
---
# Agents: named workers that take jobs

An AGENT is a named worker in a workspace: standing instructions (a page), the sources and
repositories it may use, a model account, and a machine to run on. Every piece of work it does is a
JOB: one ask, one scheduled run, or one graph. A job has a transcript, and ends `succeeded`,
`failed`, `cancelled`, or `lost`, or stops at `needs_you` when it needs a person.

The machine is one of two:

- **owner**: your computer. A runner you start (`runner_command`), or this session via `pull`.
  With no model account stored in Derive, it runs on the Claude Code or Codex login already
  on that machine.
- **derive**: a Derive sandbox that keeps its files between jobs. Nothing to start. Boots in
  15 to 30 seconds, so it suits scheduled and unattended work. Only workspaces with Derive
  machines turned on can choose it; elsewhere `create` refuses it and says so.

## Make one

Creation happens here, over MCP. Publish the instructions as a page first, then:

```
agents({ action: "create", name: "Weekly churn digest", instructions: "<short_id>",
         machine: "owner", schedule: { cron: "0 9 * * 1", tz: "America/New_York",
         instruction: "Write this week's digest." } })
```

The reply carries the agent's key once. For an `owner` agent it also carries `runner_command`: give
it to the person to run where the work should happen. The key rides `DERIVE_TOKEN` in that line;
never echo it anywhere else. `role` defaults to `editor`, so its jobs can publish their reports;
pass `commenter` for one that should only comment. It is capped at your own seat. An agent may use
only connections its creator could attach: their
own, or the workspace's if they manage it. A `derive` agent created while the workspace has no
model account yet comes back with `needs_browser`: a link where a person signs one in. Pass that
link on; do not try to do it yourself.

Everything else (pause, schedule, account, sources, environment, who may ask, delete) can be
changed later with `agents({ action: "update" })`, or by a person on the agent's Settings tab in
Derive.

## What it can reach

`agents({ action: "sources" })` lists what you can give an agent: your own connections and
secrets, and the workspace's. Each row says how to use it:

- `use_as: "sources"`: put its id in `sources`. A job calls it through tools named after it
  (`github.get`, `stripe.read`, …). A GitHub source reads repositories, pull requests, PR
  comments and workflow runs through the GitHub API; it does not clone the repository, and it
  does not read file contents. Code a job must run belongs on its instructions page.
- `use_as: "environment"`: a saved secret (a database URL, an API key). Bind it to a variable
  name with `environment: { DATABASE_URL: "<id>" }`; every job gets it as that environment
  variable. Only the name and the secret's id are ever shown back, never the value. `{}`
  clears them. Never ask a person to paste a value into the conversation: they run
  `derive secrets put NAME --agent <id> < file` (stdin or a hidden prompt), or use
  Settings › Sources › Secrets.

The same rule covers both: your own personal ones, or the workspace's if you manage it.

## Ask it

```
ask({ agent: "ag_...", instruction: "Summarize yesterday's cancellations", wait: 25 })
```

`ask` opens a job and waits up to `wait` seconds for it to settle. If it is still open, the reply
says so: check it later with `jobs({ job_id })`. To follow up in the same thread, and the same
session on the machine, pass `job_id` with a new instruction. A settled job reopens.

`dedupe_key` makes asking idempotent: while a job with that key is open, asking again returns it.

## Follow jobs

`jobs()` lists recent jobs in the workspace; `jobs({ agent })` narrows to one agent;
`jobs({ job_id })` returns one with its transcript. A job at `needs_you` carries `needs.question`
and maybe `needs.options`: answer with `jobs({ job_id, action: "answer", option | text })`. Cancel
an open job with `action: "cancel"`; run a failed or lost one again with `action: "retry"`.

## Run an owner agent from this session

`pull({ agent })` claims the agent's queued jobs (up to its concurrency) and returns each with its
instruction, transcript, instructions page, and tools. Do the work, then report each one:

```
pull({ report: { job_id, started_at, status: "succeeded", body_md: "What I did, briefly." } })
```

Echo `started_at` exactly as the pull returned it. A report from a superseded claim is refused, so a
job that timed out and was handed to another runner never gets two answers. For long work, report
`status: "progress"` now and then: it keeps the claim alive. Report `needs_you` with `needs` to stop
and ask a person; `failed` with `retryable: true` to have the job retried.
