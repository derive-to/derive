Derive exposes the same API and discovery surface on the hosted service and self-hosted
instances. Replace `https://derive.to` with your instance origin when self-hosting.

## HTTP API

- [Interactive API reference](https://derive.to/docs)
- [OpenAPI document](https://derive.to/openapi.json)
- API base: `https://derive.to/v1`

Use OAuth for interactive clients and scoped bearer tokens for headless automation. Do not
embed a static token in browser code or commit one to source control.

## Agents and MCP

- Remote MCP endpoint: [`https://derive.to/mcp`](https://derive.to/mcp)
- Agent manifest: [`https://derive.to/.well-known/agent.json`](https://derive.to/.well-known/agent.json)
- Portable skill: [`https://derive.to/skill.md`](https://derive.to/skill.md)
- OAuth authorization-server metadata: [`https://derive.to/.well-known/oauth-authorization-server`](https://derive.to/.well-known/oauth-authorization-server)
- OAuth protected-resource metadata: [`https://derive.to/.well-known/oauth-protected-resource`](https://derive.to/.well-known/oauth-protected-resource)

## Raw artifact content

Artifact content is available below `/raw/:ref` when the caller's access permits it. Pin a
version with `/raw/:ref/v/:number`. Bundles preserve their internal paths beneath the version,
and extracted fact slots are available as JSON or JSONL.

Access checks are identical to the rendered artifact. A raw URL is not a bypass around a
private artifact, password, workspace boundary, or link role.
