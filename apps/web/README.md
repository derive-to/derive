# @derive/web

The Derive web application and public website, built with TanStack Start and Vite.

The application contains the signed-in library, artifact viewer, collaboration and review
surfaces, workspace settings, and onboarding. Static assets every deployment ships live in
`public/`. The public site (derive.to's marketing pages, blog and trust files) is its own
repository and Worker (derive-to/site, private), which the API reaches over a service
binding; nothing of it ships in this build. In local development,
Vite serves the application on port 3090 and proxies the API on port 8090.

From the repository root:

```bash
pnpm dev:all
pnpm verify
```

See the [documentation index](../../docs/README.md) for product and operating guides,
and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the enforced frontend guardrails.
