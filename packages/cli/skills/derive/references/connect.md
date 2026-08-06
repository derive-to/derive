# Connect an agent to Derive

Use the hosted remote MCP unless the user explicitly names a self-hosted instance. It
uses OAuth, refreshes access without pasted secrets, and exposes the complete tool and
skill surface. (For a one-off "publish this" with no setup at all, the anonymous draft
flow in SKILL.md needs no connection.)

## Claude Code

Project-scoped setup:

```bash
claude mcp add --transport http --scope project derive https://derive.to/mcp
```

Then run `/mcp` once to complete OAuth. A checked-in `.mcp.json` with this server removes
the add step; Claude still asks before trusting a new project MCP configuration.

Omit `--scope project` for a user-level install instead:

```bash
claude mcp add --transport http derive https://derive.to/mcp
```

## Codex

User-scoped setup:

```bash
codex mcp add derive --url https://derive.to/mcp
```

Or add the same URL under `[mcp_servers.derive]` in a trusted project's
`.codex/config.toml`. Complete OAuth when Codex prompts, then start a fresh task if the
server was added after the current task began.

## Cursor

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](https://cursor.com/install-mcp?name=derive&config=eyJ1cmwiOiJodHRwczovL2Rlcml2ZS50by9tY3AifQ%3D%3D)

Or add it by hand: name `derive`, URL `https://derive.to/mcp`, no headers. Cursor completes
OAuth on first use.

## Verify

The complete remote server advertises these ten tools:

`find`, `read`, `catch_up`, `comment`, `stage`, `publish`, `organize`, `checkpoint`,
`use`, and `list_workspaces`.

Its initialization instructions identify the active role and workspace and list the
`derive://skills/*` resources. Call `list_workspaces` when the intended destination is
not already clear.

## Self-hosted Derive

Replace `https://derive.to` with the instance origin and keep `/mcp`. The server handles
OAuth discovery. Do not place access tokens in a checked-in MCP config.

If remote OAuth is not available, the compatibility stdio server is:

```bash
npx -y @derive-to/mcp
```

It shares `derive login` credentials on the machine. It is a smaller compatibility
surface; see [compatibility.md](compatibility.md).
