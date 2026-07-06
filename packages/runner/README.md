# @derive/runner

The context runner: an owner-operated daemon that answers a Derive context's
sessions. It polls the context's queue, runs `claude -p` with the manifest as
system prompt (plus the transcript), and posts structured answers back. The
manifest is fetched at spawn time, so editing it on Derive reconfigures the
runner with no restart. It polls rather than holding a connection (the API has
none to hold), which also makes catch-up free: a closed laptop just delays
answers. Failures surface as `failed` sessions and are never retried silently —
a retry would mask the manifest/tooling bugs the owner needs to see.

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

Register the agent as **editor** if the context should publish charts: answers
can carry a visual the runner publishes as an artifact, and publishing needs
workspace editor standing. A commenter-role agent still answers fine — its
charts just demote to a caveat naming the 403.

Credentials never touch Derive: the MCP servers configured in `RUNNER_CWD`'s
`.mcp.json` carry them (use read-only credentials — that boundary is the entire
safety model; the subprocess runs with permissions prompts disabled). Extra env
the MCP config expands (e.g. a `${MONGO_URI}`) can be sourced before launch:

```bash
set -a; source /path/to/.env.readonly; set +a; DERIVE_SERVER=… pnpm --filter @derive/runner start
```
