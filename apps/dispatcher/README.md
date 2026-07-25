# @derive/dispatcher

The managed executor from the built-in agent plan: **a clock pointed at the
public runner contract**. One small process, no database, no orchestrator built
in-house.

Every managed context gets a cron schedule. Each tick runs `derive runner once
<ctx>`: claim, drain the context's open sessions, exit. A tick that lands while
the previous drain is still running is dropped (not queued behind it), because a
drain reads the whole queue every time — so a missed tick costs latency, never
work, and the next tick is the retry. The dispatcher owns process lifecycle only
— the Derive API, the model, and the answer contract all live in the runner. If
this process ever needs a private API the public contract lacks, that is a bug.

> This used to run pg-boss. It was removed: the clock is a cron evaluation, "one
> drain at a time" is an in-flight flag, and the retry is the next tick — so the
> job system only added a Postgres dependency and a second queue-of-record beside
> Derive's own run table.

## Configuration (environment only)

| Var | Meaning |
| --- | --- |
| `DISPATCHER_CONTEXTS` | Inline JSON registry (or `DISPATCHER_CONTEXTS_FILE`, a path). Required. |
| `DERIVE_SERVER` | Defaults to `https://derive.to`. |
| `DISPATCHER_RUNNER_BIN` | Defaults to `derive` (the CLI on PATH). |
| `DISPATCHER_DATA_DIR` | Per-context working dirs (repo clones, skills persist between drains). Defaults `/data`. |
| `DISPATCHER_DRAIN_TIMEOUT_MS` | Kill deadline per drain. Defaults 660000 (runner timeout + margin). |
| `DISPATCHER_HOST_SECRET` | The shared secret the Derive API presents to the internal invoke surface. Unset ⇒ the hosted lane (HTTP server) is off; the owner-run drain lane still works. |
| `DISPATCHER_HTTP_PORT` | Port for the internal invoke/health surface. Defaults `3040`. |

Plus the runner's own env, passed through untouched: the model credential for
the chosen provider, optional `RUNNER_*` knobs, `GH_TOKEN` for private repo
pointers.

**Providers.** The runner is agent-CLI-agnostic (`RUNNER_PROVIDER` / `--provider`,
default `claude-code`; add one in `packages/cli/src/providers/`). Each provider's
own CLI owns its auth from the inherited env — no token is ever reimplemented:

| Provider | Binary | Credential (either) |
| --- | --- | --- |
| `claude-code` | `claude` | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (a Pro/Max plan) |
| `codex` (experimental) | `codex` | `OPENAI_API_KEY`, or a `codex login` (ChatGPT plan) |

A subscription/plan token works because the runner drives the provider's real
CLI, which consumes the token exactly as licensed — the sanctioned path, not a
reimplemented client.

## Two lanes

The dispatcher runs both halves of the executor split:

- **Owner-run drain lane** (cron → `derive runner once`): serves contexts
  whose agent runs on the run's initiator's credential (the asker's for a session, the clicker's for Run now), falling back to the owner's. Always on.
- **Shared hosted lane** (`POST /internal/invoke`, behind `DISPATCHER_HOST_SECRET`):
  runs a Derive-hosted agent (the `@derive/hosted-agent` Mastra harness) live for a
  single task. The API calls it for "Draft with your agent" and @mention replies.
  A model provider is wired in the host (`resolveModel`); until one is configured,
  the surface accepts requests and fails the run with a clear message.

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
