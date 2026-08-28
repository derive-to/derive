Hosted runs let an automation execute without leaving a laptop or polling runner online. Derive
queues the work, starts an isolated executor, gives it a short-lived capability for one run, and
records the outcome on the target artifact.

The feature is experimental and disabled by default on self-hosted installations. Leaving it off
does not disable automations: a separately operated `derive runner` can continue polling and
executing queued work.

## When to use a hosted run

Hosted execution fits recurring work whose inputs and destination are already explicit:

- refreshing a status report from connected sources;
- rebuilding a research brief on a schedule;
- responding to a trusted webhook or manual **Run now** action; or
- running a packaged Agent for a person who does not have its execution connection locally.

Keep high-risk, exploratory, or repository-wide work on a runner you control until its required
tools and review boundary are understood.

## What happens during a run

1. A schedule, trigger, or person creates a queued run.
2. Derive checks the workspace's concurrency and model-budget limits.
3. An executor claims exactly that run with a short-lived `dkrun_` capability.
4. Source calls execute through Derive's server-side broker; source credentials are not copied
   into the executor.
5. The executor writes within the automation agent's existing workspace standing and reports a
   structured outcome.
6. Retryable infrastructure or provider failures return to the queue with bounded backoff.

Dispatching does not itself claim the work. If two executors start, only one status-guarded claim
wins. A capability is pinned to one run, agent, and workspace and expires before an abandoned run
can be reclaimed, preventing two valid executors from writing the same job.

## Follow a run

Open **Workflows → Single-agent workflows** to see the run timeline. It distinguishes work that is:

- waiting for its scheduled time or retry;
- queued behind a concurrency or budget limit;
- actively running;
- completed with recorded writes; or
- failed, including whether retries were exhausted or the executor disappeared.

The ordinary first-attempt success stays compact. Retry count, next attempt, provider, execution
location, last error, and write receipts appear when they help explain what happened.

## Models, cost, and fairness

The selected coding-agent provider is snapshotted when the run is queued. Editing an automation
later does not reroute already accepted work, and one provider never silently falls back to
another.

Derive checks reported model cost against the workspace budget and caps concurrent runs per
workspace. A run delayed by a budget or concurrency limit remains queued instead of being marked
failed. Providers that report usage but not currency remain visible as unknown cost rather than
being recorded as free.

## Self-hosted execution choices

Self-hosters can choose between:

- **Polling runner:** the default. Execution stays on an owner-operated machine.
- **Node child process:** set `DERIVE_HOSTED_RUNS=true` so the API host starts the installed
  Derive executor for queued work.
- **Cloudflare Container:** an isolated scale-to-zero executor for Cloudflare deployments.
- **Worker loop:** a lightweight model-and-fetch lane for jobs that do not require a filesystem
  or coding-agent CLI.

CLI-backed modes use the same runner contract and image. The worker loop uses the same queue,
capability, payer, write, retry, and audit contracts; only the execution environment differs.

For a Node self-host, install the CLI where the API can execute it, set
`DERIVE_HOSTED_RUNS=true`, configure a model plan, and restart the API. Use
`DERIVE_RUNNER_BIN` when the executable is not on `PATH`. Deployment-specific environment and
storage settings remain in [Deployment and configuration](/self-hosting/configuration/).

## Failure behavior

Provider throttling, transient provider failures, timeouts, failed starts, and failed writes are
eligible for bounded retry. A completed agent turn that produced no revision is terminal: running
the same instruction again would spend the model plan without changing the result.

If an executor disappears without reporting, Derive reclaims the run after its lease expires.
Repeated loss eventually ends with a `lost` outcome so an unhealthy substrate cannot retry and
spend forever.

Hosted execution changes where an agent works; it does not change the review model. Agent work
remains attributable to the agent and its authorizing person, and only a directly signed-in human
can send a review round back.
