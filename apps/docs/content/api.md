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
extracted fact slots are available as JSON or JSONL, and a version's dynamic table or figure
slots are available as JSON at `/raw/:ref/dynamic/:name.json` (or pinned beneath the
version). Dynamic slots change without a new version, so they are never cached as immutable.

A LaTeX artifact (`text/x-latex`, or a `derive/latex` bundle whose entry is `main.tex`) is
served as a rendered page under `/raw/:ref/v/:n/index.html` and as its source at
`/raw/:ref/v/:n/raw.tex`; the math typesetter it loads is served by the instance itself
under `/raw/vendor/katex/<version>/`. `POST /v1/preview` renders a LaTeX draft when the
body carries `content_type: "text/x-latex"`; with `short_id` and `path` it renders that
paper bundle with the draft substituted for the named file, so sections, citations,
figures and dynamic data appear as they will on the page. A paper bundle takes `edits` on its entry
file through `POST /v1/artifacts/:id/versions` like a single file; one text file of any
bundle is read and written by path at `GET`/`PUT /v1/artifacts/:id/files/*`, and a
paper's bibliography as entries at `GET`/`PUT /v1/artifacts/:id/bib` (`ops` of
`{ op: "set", key?, raw }` and `{ op: "delete", key }`). Each write publishes a new
version of the bundle.

Access checks are identical to the rendered artifact. A raw URL is not a bypass around a
private artifact, password, workspace boundary, or link role.
