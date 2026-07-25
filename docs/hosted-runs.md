# Hosted automation runs (experimental)

Run an automation with **no machine on**: Derive itself materializes due schedules, mints a
short-lived credential, and boots a disposable executor that pulls from bound sources and writes
the artifact. Off by default on every deployment; opt in per host.

> **Experimental.** It spawns processes (or containers) and spends the run initiator's model
> plan. Leave it off and nothing changes: runs stay queued for a polling `derive runner`.

## How it works

One tick does three idempotent things, then gets out of the way:

1. **Materialize** — due cron automations become `queued` runs (deduped per cron window).
2. **Reclaim** — runs whose executor died (`running` past the lease) return to `queued`; past
   the attempt cap they finish `failed` with outcome `lost`.
3. **Dispatch** — each due queued run gets a **per-run capability token** and is handed to the
   **substrate**, which boots an executor for exactly that run.

Dispatch never claims. The *executor* claims (`queued → running`, status-guarded), so a double
dispatch is harmless: the second one finds nothing and exits. That is the whole concurrency
story — no locks, no leader election, no second queue.

The queue of record is Postgres (or SQLite on a small self-host): the `run` table already holds
status, the claim, and the ledger. There is no job system.

### The lifecycle clock (a safety invariant)

    RUN_TIMEOUT_MS  <  RUN_TOKEN_TTL_MS  <  RUN_LEASE_MS
         15m                 20m                25m

Reclaiming a run mints a **second** executor for it. The claim is status-guarded, but a *write*
is an ordinary agent write and the claim does not gate it — so if the first executor's token were
still valid at reclaim time, two processes could write the same artifact. The lease therefore
outlasts the **token**, not merely the timeout. The token in turn outlasts the timeout, so a run
that uses its full budget can still write its own result instead of 401ing at the finish line.
All three live in `lib/run-lifecycle.ts`, which throws at import if the order is ever broken, and
`test/run-lifecycle.test.ts` states why each gap exists.

### Cost and fairness

- **Monthly model budget is enforced at dispatch**, not only at the enqueue routes. A schedule
  creates runs with no human in the loop, so without this a cron automation would spend past the
  owner's cap forever. Over budget ⇒ the run is *deferred* (left queued), never failed: raising
  the cap or the next month releases it with nobody re-creating the work.
- **Per-workspace in-flight cap** (default 3) so one workspace's burst can't consume the
  deployment's capacity or fan out unbounded model spend. Also deferred, not failed.
- A **global per-pass limit** (default 10) is the outer burst valve.

### Retries

Two different failures, two different answers:

- **The executor died** (container evicted, box rebooted, process killed) — nobody reported
  anything. The *reclaim sweep* notices the expired lease and requeues, up to `RUN_MAX_ATTEMPTS`,
  then gives up as `lost`.
- **The executor reported a failure** — it lived long enough to say so, and it says *whether the
  failure is worth another attempt*. A provider 5xx/429, a timeout, a failed spawn, or a failed
  write is `retryable: true`; a clean run that produced no `<revision>` block is not, because a
  retry would fail identically while spending the owner's model plan again. A retryable failure
  requeues with a backoff (1 min, then 5) up to `RUN_MAX_RETRIES`; anything else is terminal.

The executor knows *why* it failed; the server owns the *policy* (how many, how long). Retry
counts live in the run's meta blob, so they survive re-dispatch and show up in the timeline.

### The run timeline

`GET /v1/workspace/runs` returns each run with a derived `timeline` (nothing extra is stored):
`phase`, `waiting_until` (a queued run that isn't due yet — a schedule or a retry backoff),
`queued_ms` / `ran_ms`, `retries`, `last_error`, `outcome`, and `writes`. Settings → Automations
renders the parts an operator asks about — retries spent, when it will next be tried, and what
went wrong last time — and stays silent for the ordinary first-try success. This is what makes
"my automation isn't doing anything" answerable without reading server logs.

### The credential

A hosted run authenticates with a `dkrun_` **capability token**: signed, scoped to exactly one
`(run, agent, workspace)`, expiring on the lifecycle clock above. It resolves to the same agent principal a
registered token would, so the write path is unchanged — but claim/tool/finish additionally pin
it to *its* run, so a leaked token can touch nothing else. Nothing standing is stored anywhere.

Third-party **source** credentials never enter the executor: a pull calls back to
`POST /v1/agent/runs/:id/tool`, and the API executes it through the broker server-side. The
model plan is the run initiator's own, fetched at run time.

## Substrates

| Substrate | Where a run executes | Enable with |
| --- | --- | --- |
| `node-child` | A child process on the API's own box | `DERIVE_HOSTED_RUNS=true` (Node) |
| `cf-container` | A scale-to-zero Cloudflare Container | Uncomment the `[[containers]]` block in `apps/api/wrangler.toml` |
| _(polling runner)_ | An owner's machine | The default when hosted runs are off |

Both substrates boot the **same image/CLI**: the entrypoint sees a `dkrun_` token and takes the
one-shot `derive runner run` lane automatically.

---

## Testing it locally

### 1. The logic — no Docker, no wrangler, no network

The whole correctness story is platform-agnostic, so it runs as a plain unit test with a fake
substrate:

```sh
pnpm --filter @derive/api test hosted-dispatch
```

Covers: boot-exactly-once, the token's scope, no double dispatch of a claimed run, reclaim of a
dead executor, giving up as `lost`, schedule materialization + idempotency, the run-now nudge, a
substrate outage leaving the run safely queued, the per-workspace in-flight cap, and the monthly
budget holding runs back. Token forgery/tamper/expiry and the lifecycle invariant are in
`test/run-lifecycle.test.ts` and the token suite.

The end-to-end pull (real runner, real API over a socket, scripted agent) is:

```sh
pnpm --filter @derive/api test agentic-pull-e2e
```

### 2. The Node substrate — a real unattended run on your laptop

```sh
npm i -g @derive-to/cli            # the executor the API will spawn
export DERIVE_HOSTED_RUNS=true
export ANTHROPIC_API_KEY=...       # or connect a model plan in Settings
pnpm --filter @derive/api dev
```

Then create an automation with `trigger: { kind: "schedule", cron: "* * * * *" }` targeting an
artifact, and watch versions accrue with **no runner running**. `DERIVE_RUNNER_BIN` points at a
non-PATH CLI. Logs: `hosted runs ENABLED (experimental)` at boot, then `hosted dispatch` per tick.

### 3. The Cloudflare substrate — locally under wrangler

Needs Docker (Containers run locally through it) and the `[[containers]]` +
`[[durable_objects.bindings]]` + `[[migrations]]` blocks in `apps/api/wrangler.toml` uncommented.

```sh
cd apps/api
wrangler dev --test-scheduled
# in another shell — fire the cron on demand instead of waiting a minute:
curl "http://localhost:8787/__scheduled"
```

Each `/__scheduled` hit runs one full dispatch pass: materialize → reclaim → boot a container per
due run. `wrangler tail` shows the boots.

**What local can't tell you:** the container **runtime ceiling**. Local Docker has no per-instance
limit, so a run that passes locally can still exceed the real one. That single assumption needs a
real deploy (or the current Containers limits) to confirm — which is why the Node substrate,
which has no such ceiling, is the recommended first hosted target.
