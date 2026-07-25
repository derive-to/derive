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

### The credential

A hosted run authenticates with a `dkrun_` **capability token**: signed, scoped to exactly one
`(run, agent, workspace)`, expiring in 45 minutes. It resolves to the same agent principal a
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
dead executor, giving up as `lost`, schedule materialization + idempotency, the run-now nudge,
and a substrate outage leaving the run safely queued.

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
