# @derive/dispatcher

The managed executor from the built-in agent plan: **pg-boss pointed at the
public runner contract**. One small process, one Postgres, no orchestrator
built in-house.

Every managed context gets a pg-boss queue (`drain:<ctx_id>`, singleton policy)
and a cron schedule. Each tick runs `derive runner once <ctx>`: claim, drain
the context's open sessions, exit. The dispatcher owns process lifecycle only —
the Derive API, the model, and the answer contract all live in the runner. If
this process ever needs a private API the public contract lacks, that is a bug.

## Configuration (environment only)

| Var | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres for pg-boss's job state. Required. |
| `DISPATCHER_CONTEXTS` | Inline JSON registry (or `DISPATCHER_CONTEXTS_FILE`, a path). Required. |
| `DERIVE_SERVER` | Defaults to `https://derive.to`. |
| `DISPATCHER_RUNNER_BIN` | Defaults to `derive` (the CLI on PATH). |
| `DISPATCHER_DATA_DIR` | Per-context working dirs (repo clones, skills persist between drains). Defaults `/data`. |
| `DISPATCHER_DRAIN_TIMEOUT_MS` | Kill deadline per drain. Defaults 660000 (runner timeout + margin). |

Plus the runner's own env, passed through untouched: exactly one of
`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, optional `RUNNER_*` knobs,
`GH_TOKEN` for private repo pointers.

Registry shape — tokens are **never** inline (name an env var or a file, the
same discipline as `runner install`):

```json
{
  "contexts": [
    { "id": "ctx_abc123", "token_env": "CTX_ANALYTICS_TOKEN" },
    { "id": "ctx_def456", "token_file": "/secrets/reports.token", "model": "opus", "cron": "*/5 * * * *" }
  ]
}
```

`cron` defaults to `* * * * *` (per-minute pull — the v1 cadence; webhook kick
is the planned latency upgrade). `singleton` queues mean a tick that lands
mid-drain is dropped, not queued: the next tick covers whatever arrived,
because every drain empties the whole session queue.

## Run it

```bash
# Local (needs a Postgres and the CLI on PATH):
DATABASE_URL=postgres://localhost/dispatcher \
DISPATCHER_CONTEXTS='[{"id":"ctx_x","token_env":"CTX_X_TOKEN"}]' \
CTX_X_TOKEN=dk_agt_... ANTHROPIC_API_KEY=sk-... \
pnpm --filter @derive/dispatcher start

# Containers: see deploy/dispatcher.compose.example.yml
```

The dispatcher is one of several interchangeable executors — a GitHub Actions
cron or a compose-interval timer can run the identical `derive runner once`
against the same contexts. This one exists so Derive's hosted tier has a
default with retries, singleton semantics, and a durable job log.
