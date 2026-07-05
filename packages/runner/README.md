# @derive/runner

The context runner: an owner-operated daemon that answers a Derive context's
sessions. It polls the context's queue, runs `claude -p` with the manifest as
system prompt (plus the transcript), and posts structured answers back. The
manifest is fetched at spawn time, so editing it on Derive reconfigures the
runner with no restart. Failures surface as `failed` sessions — never retried
silently. See the daniel prototype's decision log for why polling, why
drain-on-startup, why no retry.

## Run

```bash
DERIVE_SERVER=https://derive.to \
DERIVE_TOKEN=dk_agt_…        # the context's agent bearer (Settings → Agents)
DERIVE_CONTEXT=ctx_…         # the context id (its console URL)
RUNNER_CWD=/path/to/repo     # where claude runs — its .mcp.json supplies the tools
pnpm --filter @derive/runner start
```

Optional: `RUNNER_POLL_MS` (default 5000), `RUNNER_TIMEOUT_MS` (default 600000),
`CLAUDE_BIN`, and `RUNNER_MOCK=1` (skip Claude, post a canned answer — wiring
smoke test).

Credentials never touch Derive: the MCP servers configured in `RUNNER_CWD`'s
`.mcp.json` carry them (use read-only credentials — that boundary is the entire
safety model; the subprocess runs with permissions prompts disabled). Extra env
the MCP config expands (e.g. a `${MONGO_URI}`) can be sourced before launch:

```bash
set -a; source /path/to/.env.readonly; set +a; DERIVE_SERVER=… pnpm --filter @derive/runner start
```
