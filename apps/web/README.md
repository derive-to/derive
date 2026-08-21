# @derive/web

The Derive web application and public website, built with TanStack Start and Vite.

The application contains the signed-in library, artifact viewer, collaboration and review
surfaces, workspace settings, and onboarding. Static assets every deployment ships live in
`public/`. In local development, Vite serves the application on port 3090 and proxies the
API on port 8090.

`hosted/` is derive.to's own public surface: the marketing pages and their stylesheet, the
blog's markdown in `hosted/posts/`, the sitemap, the trust files, and a `robots.txt` that
overlays the generic one. It sits outside `public/` deliberately, so `pnpm build` produces
the application alone and a self-host never serves our front door. Only the hosted build
assembles it, through `pnpm --filter @derive/api build:web`, which runs `build:site` after
the application build. Vite serves the same directory in development, so the pages look
the same locally.

The blog is generated. Posts are markdown files in `hosted/posts/`, named
`YYYY-MM-DD-slug.md` with a `title`, `description` and `date` in their front matter;
`scripts/build-blog.mjs` writes `/blog`, each post at `/blog/<slug>`, and the feed at
`/blog/rss.xml` into `dist/client`, then lists the new URLs in the built sitemap. Nothing
generated is committed, so preview a post from a real build:

```bash
pnpm --filter @derive/api build:web
node apps/web/e2e/public-quality/static-server.mjs apps/web/dist/client 9700
```

From the repository root:

```bash
pnpm dev:all
pnpm verify
```

See the [documentation index](../../docs/README.md) for product and operating guides,
and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the enforced frontend guardrails.
