# @derive/web

The Derive web application and public website, built with TanStack Start and Vite.

The application contains the signed-in library, artifact viewer, review and approval
surfaces, workspace settings, and onboarding. Static public assets live in `public/`;
the hosted marketing pages live in `public/site/` and are served by the API's marketing
routes. In local development, Vite serves the application on port 3090 and proxies the
API on port 8090.

From the repository root:

```bash
pnpm dev:all
pnpm verify
```

See the [documentation index](../../docs/README.md) for product and operating guides,
and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the enforced frontend guardrails.
