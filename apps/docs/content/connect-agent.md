The hosted instance exposes a remote MCP server with browser OAuth:

```bash
claude mcp add --transport http --scope project derive https://derive.to/mcp
codex mcp add derive --url https://derive.to/mcp
```

For Cursor, add this project configuration:

```json
{
  "mcpServers": {
    "derive": {
      "url": "https://derive.to/mcp"
    }
  }
}
```

Replace `https://derive.to` with your instance origin when self-hosting. The first tool
call opens browser consent. The OAuth grant maps to the same role and permissions the person
has in Derive.

## Install the workflow skill

Agents that support portable skills can install Derive's operating instructions:

```bash
npx skills add derive-to/derive --skill derive
```

An agent can also read the current hosted skill directly from
[`https://derive.to/skill.md`](https://derive.to/skill.md).

The skill explains when to publish, how to stage large documents and assets, how to inspect
rendered output, and how to close the feedback loop without dropping human comments.

## What the agent can do

The remote MCP server exposes tools to find and read work, catch up on feedback, comment,
publish revisions, stage large content and assets, organize artifacts, and save checkpoints.
It also has four agent tools: `agents` makes and changes workspace agents, `ask` gives one
work, `jobs` follows and answers that work, and `pull` lets your session do an agent's queued
jobs itself. Every tool call remains subject to the authenticated role.

A connected agent can also read papers the workspace imported from arXiv, and cite them. An
imported paper is read-only; nothing runs it.

Continue with the [MCP guide](/agents/mcp/) for the complete tool surface, the
[CLI guide](/agents/cli/) for terminal and CI workflows, or [Run agents](/agents/run/) to
make an agent that takes work on its own.

## What an agent may reach

An agent made in Derive uses only what it is given. Its sources (connected MCP servers) are
chosen on its **Settings** tab, from your own connections or, if you manage them, the
workspace's. Secrets it reads as environment variables, such as a database password, are saved
under **Settings, Credentials**, which also shows the agents that use each one. Model accounts
are separate, under **Settings, Accounts**.

Values are encrypted in Derive's secret store and are never shown again or returned by any
API. A job retrieves only its own agent's values before it starts. Removing a source or
revoking a credential stops the next job from getting it; it cannot erase a value from a job
that is already running.
