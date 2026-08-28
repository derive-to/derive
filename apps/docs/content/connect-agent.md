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
publish revisions, stage large content and assets, organize artifacts, save checkpoints,
and use workspace Contexts. A Context packages reusable instructions, skills, sources, and
permissions; the connected agent is the actor using it. Every tool call remains subject to the
authenticated role.

Continue with the [MCP guide](/agents/mcp/) for the complete tool surface or the
[CLI guide](/agents/cli/) for terminal and CI workflows.
