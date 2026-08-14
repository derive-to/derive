# `@derive-to/mcp`

The local stdio compatibility server for [Derive](https://derive.to). It gives an
MCP-compatible agent the same publish, review, revision, and context tools exposed by
a Derive instance's remote `/mcp` endpoint.

## Prefer the remote server

The hosted service already exposes a remote MCP server with browser OAuth:

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

Replace `https://derive.to` with your instance URL when self-hosting. The first tool
call opens browser consent; the granted OAuth scope maps to the agent's Derive role.

## Use the local stdio bridge

Use this package when a client cannot connect to a remote Streamable HTTP MCP server,
or when headless automation must authenticate with a static bearer:

```json
{
  "mcpServers": {
    "derive": {
      "command": "npx",
      "args": ["-y", "@derive-to/mcp"],
      "env": {
        "DERIVE_SERVER": "https://derive.example.com",
        "DERIVE_TOKEN": "set-this-outside-source-control"
      }
    }
  }
}
```

`DERIVE_SERVER` defaults to `http://localhost:8080`. Without `DERIVE_TOKEN`, the
bridge can reuse a compatible account created by `derive login`. Prefer OAuth for
interactive clients. Treat static tokens as credentials and never commit them.

## Tools

- `find`: search and browse artifacts and contexts.
- `read`: read artifact content or a specific version.
- `catch_up`: retrieve changed work, open feedback, history, or the current work queue.
- `comment`: leave feedback, reply, resolve, or reopen a thread.
- `publish`: create an artifact or save a revision; lower roles create proposals.
- `stage`: upload images, fonts, and other bundle assets out of band.
- `use`: ask a workspace context to perform work.
- `checkpoint`: save resumable working state as a one-page artifact.

The server also exposes workflow resources under `derive://skills/*`. Agents should
read the relevant workflow before performing a multi-step operation. The canonical
[Derive skill](SKILL.md) contains the complete operating instructions.

## Permission model

The MCP server does not bypass Derive permissions. The authenticated agent can only
read, comment, propose, publish, or manage what its role allows. Anonymous callers are
always read-only, and mutations retain the authenticated actor for accountability.
See the
[access model](https://docs.derive.to/concepts/access/).

Derive is licensed under FSL-1.1-ALv2 and converts to Apache-2.0 on the schedule in
the [license](https://github.com/derive-to/derive/blob/main/LICENSE).
