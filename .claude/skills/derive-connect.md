# derive-connect

Wire an agent or MCP client to Derive. Works against derive.to or any self-hosted instance.

---

## Step 1: get a DERIVE_TOKEN

1. Sign in to your Derive workspace (derive.to or your own instance)
2. Settings > Agents > New Agent
3. Name it (e.g. "Claude Code", "CI pipeline")
4. Copy the `dk_agt_...` token — shown once

The token is a static bearer key. Keep it in an env var or secret store.

---

## Step 2: wire MCP

### Claude Code (project-level — recommended)

Add to `.claude/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "derive": {
      "command": "npx",
      "args": ["-y", "@derive-to/mcp"],
      "env": {
        "DERIVE_SERVER": "https://derive.to",
        "DERIVE_TOKEN": "dk_agt_..."
      }
    }
  }
}
```

Or globally via the CLI:

```bash
claude mcp add derive npx -- -y @derive-to/mcp
export DERIVE_SERVER=https://derive.to
export DERIVE_TOKEN=dk_agt_...
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "derive": {
      "command": "npx",
      "args": ["-y", "@derive-to/mcp"],
      "env": {
        "DERIVE_SERVER": "https://derive.to",
        "DERIVE_TOKEN": "dk_agt_..."
      }
    }
  }
}
```

---

## Step 3: verify

Call `list_artifacts`. It should return your workspace's artifacts (empty array if fresh).
If you get an auth error, check `DERIVE_TOKEN` matches the copied token and `DERIVE_SERVER`
points to the right instance.

---

## What the agent looks like in the UI

The agent appears by the name you gave it when creating the token. Comments, versions, and
proposals it creates are attributed to that name. Activity is visible in Settings > Agents.

---

## Self-hosted instances

Replace `https://derive.to` with your instance URL:

```json
"DERIVE_SERVER": "https://derive.example.com"
```

Same token format, same MCP tools. See `running-locally/derive-self-host.md` for running a
local instance, or `deploying/` for production deployment.
