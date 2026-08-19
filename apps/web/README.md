# @derive/web

The Derive web application and public website, built with TanStack Start and Vite.

The application contains the signed-in library, artifact viewer, collaboration and review
surfaces, workspace settings, and onboarding. Static public assets live in `public/`;
the hosted marketing pages live in `public/site/` and are served by the API's marketing
routes. In local development, Vite serves the application on port 3090 and proxies the
API on port 8090.

The blog is generated. Posts are markdown files in `content/blog/`, named
`YYYY-MM-DD-slug.md` with a `title`, `description` and `date` in their front matter;
`scripts/build-blog.mjs` runs at the end of the build and writes `/blog`, each post at
`/blog/<slug>`, and the feed at `/blog/rss.xml` into `dist/client`. Nothing generated is
committed, and Vite's dev server does not serve it, so preview a post from a real build:

```bash
pnpm --filter @derive/web build
node apps/web/e2e/public-quality/static-server.mjs apps/web/dist/client 9700
```

From the repository root:

```bash
pnpm dev:all
pnpm verify
```

See the [documentation index](../../docs/README.md) for product and operating guides,
and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the enforced frontend guardrails.
