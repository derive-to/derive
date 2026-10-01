# Derive project documentation

Public user documentation lives at **[docs.derive.to](https://docs.derive.to/)**. This
directory holds maintainer and design records that should not be published as product docs.

## Maintainer records

- [Access model](access-model.md): authorization and anonymous-read invariants.
- [Hosted runs](hosted-runs.md): the retired hosted automation lane, kept as a record.
- [Ortam smoke check](ortam-smoke.md): the Ortam sandbox check; its later sections record the
  retired Context runtime controller.
- [Design system](design-system.md): product UI rules and tokens.
- [Growth measurement](GROWTH-MEASUREMENT.md): privacy-safe acquisition measurement.
- [Governance](../.github/GOVERNANCE.md): ownership, decisions, and review expectations.
- [Sources](sources.md): connecting an MCP server as a source, pinning its tools, and signing in.
- [Architecture decisions](decisions/): durable technical decisions.

Historical implementation plans and specifications remain under `superpowers/`; they are records,
not current product documentation.

## Public documentation sources

The docs site (a small Astro build, see [`apps/docs/README.md`](../apps/docs/README.md)) uses
authored product documentation under `apps/docs/content/` and reuses
community health files such as `SECURITY.md` and package READMEs where appropriate.
[`apps/docs/docs-manifest.mjs`](../apps/docs/docs-manifest.mjs) is the single source for public
page membership and navigation order. The build generates copies, search indexes, `llms.txt`, and
stable routes; do not edit generated files under `apps/docs/src/content/docs/`.

## Work locally

```bash
pnpm --filter @derive/docs dev
pnpm --filter @derive/docs build
```

Before pushing any repository change, run the full deterministic gate:

```bash
pnpm verify
```
