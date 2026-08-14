# Derive documentation site

This workspace builds [docs.derive.to](https://docs.derive.to), the public documentation
site for Derive. It is a static Astro Starlight site deployed as its own Cloudflare Worker,
separate from the hosted product at `derive.to`.

## Local development

From the repository root:

```bash
pnpm --filter @derive/docs dev
```

The pre-step generates the content collection from [`docs-manifest.mjs`](docs-manifest.mjs).
Files under `src/content/docs/` and generated public assets are intentionally ignored: edit a
manifest source, not its generated copy.

## Content model

- `content/` holds docs-specific onboarding and reference pages.
- Repository documents such as `DEPLOY.md`, `SECURITY.md`, and package READMEs remain canonical.
- `scripts/sync-content.mjs` adds site metadata and rewrites repository-relative links.
- `scripts/check-built.mjs` verifies every declared route, canonical URL, internal link, search
  index, sitemap, and real 404 behavior after each build.

Add or move a public page through `docs-manifest.mjs` and the Starlight sidebar in
`astro.config.mjs` together. The public-claims guard fails CI when the deployment or discovery
contract drifts.

## Build and deployment

```bash
pnpm --filter @derive/docs build
pnpm --filter @derive/docs typecheck
pnpm --filter @derive/docs deploy:check
```

Use `pnpm --filter @derive/docs dev:edge` when you need Cloudflare's real trailing-slash,
404, header, and asset-cache behavior locally. The faster `dev` command is the normal content
authoring loop.

The `deploy-docs` CI job deploys `dist/` from the protected `docs-production` GitHub environment
on `main`, records Cloudflare's version metadata, and then checks the production build marker,
security headers, immutable hashed-asset caching, and 404 response. `wrangler.toml` owns the
`docs.derive.to` custom domain; the Worker has no API, database, storage, or application-secret
bindings. Its `workers.dev` and preview URLs are disabled so search engines have one canonical
documentation origin.
