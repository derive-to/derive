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
| `DISPATCHER_HOST_SECRET` | The shared secret the Derive API presents to the internal invoke surface. Unset ⇒ the hosted lane (HTTP server) is off; the owner-run drain lane still works. |
| `DISPATCHER_HTTP_PORT` | Port for the internal invoke/health surface. Defaults `3040`. |

Plus the runner's own env, passed through untouched: the model credential for
the chosen provider, optional `RUNNER_*` knobs, `GH_TOKEN` for private repo
pointers.

**Providers.** The runner is agent-CLI-agnostic (`RUNNER_PROVIDER` / `--provider`,
default `claude-code`; add one in `packages/cli/src/providers/`). Each provider's
own CLI owns its auth, but the runner supplies the token per run: it fetches the
run's per-user plan from Derive and injects it into that one spawn as the env var
the CLI reads. Any inherited model token is stripped first, and there is no
shared/ambient fallback, so a stray global token on the host is never billed.

| Provider | Binary | Env the CLI reads |
| --- | --- | --- |
| `claude-code` | `claude` | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (a Pro/Max plan) |
| `codex` (experimental) | `codex` | `OPENAI_API_KEY`, or a `codex login` (ChatGPT plan) |

A subscription/plan token works because the runner drives the provider's real
CLI, which consumes the token exactly as licensed. Each member connects their own
plan in Derive (Settings, Model plans); the runner resolves whose plan pays for
each run (the initiator's, then a lent owner's, then a workspace pool, else the
run fails closed) and no token is ever reimplemented. The resolved credential is
injected into a private per-run home (Codex: a fresh `CODEX_HOME` holding the
login `auth.json`, 0600, removed after the run), and the runner strips every
inherited model-auth var before the spawn, so nothing bills a stray host token.

**Isolation invariant (deploy):** the runner image must carry NO host login
(`~/.codex/auth.json`, `~/.claude/.credentials.json`) and NO baked model token or
`*_BASE_URL`. The env strip is defense in depth; the clean image is the primary
control, since a host login FILE can still be read via `$HOME` if present.

**Codex plan-login concurrency limit:** a Codex `login` refresh token is
single-use, and the CLI rotates it in place. The runner persists the rotated
`auth.json` back after each run (bound to the exact tier + a compare-and-swap, so
a stale write can't clobber a fresher token). SEQUENTIAL runs on one login are
safe; two runs on the SAME shared login (a pool or owner-lent Codex plan) at once
can race the rotation and one will need a reconnect. An API key has no such limit.
Serializing concurrent use of one login is a planned hardening.

## Two lanes

The dispatcher runs both halves of the executor split:

- **Owner-run drain lane** (pg-boss cron → `derive runner once`): serves contexts
  whose agent runs on the run's initiator's credential (the asker's for a session, the clicker's for Run now), then a lent owner's, then a workspace pool, else the run fails closed. Always on.
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
# Local (needs a Postgres and the CLI on PATH). Model auth is NOT set here: each
# member connects their own plan in Derive, and the runner injects it per run.
DATABASE_URL=postgres://localhost/dispatcher \
DISPATCHER_CONTEXTS='[{"id":"ctx_x","token_env":"CTX_X_TOKEN"}]' \
CTX_X_TOKEN=dk_agt_... \
pnpm --filter @derive/dispatcher start

# Containers: see deploy/dispatcher.compose.example.yml
```

The dispatcher is one of several interchangeable executors — a GitHub Actions
cron or a compose-interval timer can run the identical `derive runner once`
against the same contexts. This one exists so Derive's hosted tier has a
default with retries, singleton semantics, and a durable job log.
