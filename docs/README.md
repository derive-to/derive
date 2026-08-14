# Derive documentation

The browsable documentation lives at **[docs.derive.to](https://docs.derive.to/)**.
The Markdown files in this repository remain its canonical sources; the docs build
adds navigation, local search, stable public URLs, and edit links without copying
their content by hand.

Derive is review and approval for work made by AI agents. It keeps the artifact,
every version, exact-text feedback, proposals, and the final decision at one durable
URL. Use the hosted service at [derive.to](https://derive.to), or run the same product
on your own infrastructure.

## Choose a starting point

| Goal | Start here |
| --- | --- |
| Publish a first page without installing anything | [Anonymous draft](#publish-an-anonymous-draft) |
| Publish and revise from a terminal | [CLI guide](../packages/cli/README.md) |
| Connect Claude Code, Codex, Cursor, or another compatible client | [MCP guide](../packages/mcp/README.md) |
| Run Derive yourself | [Self-hosting quickstart](../QUICKSTART.md) |
| Configure storage, auth, email, domains, or scaling | [Deployment reference](../DEPLOY.md) |
| Build directly against the API | [Hosted API reference](https://derive.to/docs) |
| Author artifacts that preserve review anchors | [Artifact authoring standard](../STANDARD.md) |
| Start from a complete review workflow | [Official examples](../examples/README.md) |

## The review loop

1. A person, CLI, API client, or authenticated agent publishes work.
2. Derive renders it in a sandbox and keeps subsequent revisions at the same URL.
3. People review the actual output and leave feedback attached to exact text.
4. A compatible agent calls `catch_up` to read open feedback and publishes a revision.
5. A named reviewer approves the version or requests another change.

Viewing can be anonymous when the artifact's link settings allow it. Commenting,
editing, and publishing require a signed-in person or an authenticated agent so every
change has an accountable author. Approval is narrower: only a directly signed-in
person with approval standing can close the review. See the [access model](access-model.md)
for the implementation record and [public access guide](../apps/docs/content/access.md)
for the user-facing rules.

## Publish an anonymous draft

An anonymous draft is the fastest way to prove that an artifact renders correctly:

```bash
curl -F file=@page.html https://derive.to/v1/drafts
```

The response contains a live URL and a private claim URL. The draft is read-only,
expires after 72 hours, and becomes a durable workspace artifact only when someone
claims it. Do not publish secrets or private customer data through an anonymous draft.

For durable publishing, sign in with the CLI or connect an agent over OAuth:

```bash
npx -y @derive-to/cli login
npx -y @derive-to/cli publish page.html
```

## Product concepts

- [Access model](access-model.md): workspace access, link roles, listing, passwords,
  and the anonymous read-only invariant.
- [Artifact authoring standard](../STANDARD.md): supported formats, stable anchors,
  bundles, embeds, decks, and data slots.
- [Architecture](../ARCHITECTURE.md): the ports-and-adapters layout and deployment
  topologies.
- [Hosted runs](hosted-runs.md): how contexts execute work safely.
- [Design system](design-system.md): product UI rules and tokens.

## Operate Derive

- [Self-hosting quickstart](../QUICKSTART.md): verify a release, start one container,
  bootstrap the first owner, and test a backup.
- [Deployment reference](../DEPLOY.md): Postgres, S3/R2, Cloudflare, email, OAuth,
  custom domains, scaling, and every supported environment variable.
- [Security policy](../SECURITY.md): vulnerability reporting, supported versions,
  hardening, and the access-control invariants.
- [Privacy policy](https://derive.to/privacy): hosted-service data handling and
  retention.
- [Licensing](../LICENSING.md): Fair Source rights, the competing-use restriction,
  and the scheduled Apache-2.0 conversion.

## Build with Derive

- [CLI package](../packages/cli/README.md)
- [MCP package](../packages/mcp/README.md)
- [OpenAPI document](https://derive.to/openapi.json)
- [API reference](https://derive.to/docs)
- [Agent skill](https://derive.to/skill.md)
- [MCP server](https://derive.to/mcp)
- [Agent discovery](https://derive.to/.well-known/agent.json)

The hosted endpoints above are conveniences, not a separate product surface. A
self-hosted Derive instance exposes the same API, MCP, OAuth, and discovery routes at
its own base URL.

## Learn from complete examples

The [official workflow examples](../examples/README.md) include a designed launch page,
a sourced decision brief, and a recurring status document. Each is directly publishable
and includes a real review request. They are product examples, not invented customer work.

## Project documentation

- [Contributing](../CONTRIBUTING.md)
- [Maintainers and decisions](../MAINTAINERS.md)
- [Roadmap](../ROADMAP.md)
- [Support](../SUPPORT.md)
- [Growth measurement](GROWTH-MEASUREMENT.md)
- [Source licensing](../LICENSING.md)
- [Sources and acknowledgements](sources.md)
