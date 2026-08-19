import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"
import { isSpaPath } from "./spa-paths"

/**
 * The single source of truth for which request paths the API/server owns. Every
 * other GET falls back to the SPA shell so the client router handles it (deep
 * links, refresh, /artifacts/:ref, /settings, …).
 *
 * The same contract is declared in two other places that can't import a value —
 * the Cloudflare Worker (`wrangler.toml` `run_worker_first`) and the Vite dev
 * proxy (`apps/web/vite.config.ts`). `serve-web.test.ts` parses both and asserts
 * they stay in lockstep with this list, so the Node server, the edge Worker, and
 * local dev can never disagree about who owns a path.
 *
 *  · prefixes match the path and any subpath (`/v1`, `/v1/artifacts`, …)
 *  · exact paths match only themselves (`/healthz`)
 */
const API_PREFIXES = ["/v1", "/api", "/raw", "/blob", "/oauth", "/.well-known/skills"] as const
// Exact server-owned paths. The OAuth 2.0 discovery docs (RFC 8414 / RFC 9728) the
// Worker must answer with JSON, else SPA not_found_handling shadows them. `/mcp` is
// EXACT, not a prefix: the MCP Streamable-HTTP endpoint is hit at exactly /mcp with
// no subpath, so a `/mcp/*` worker-first glob misses it and the asset handler 405s
// the POST. (Trailing-slash/subpath variants aren't used by the transport.)
const API_EXACT = [
  "/healthz",
  // Readiness, and it MUST be here for the same reason the OAuth docs are: SPA
  // not_found_handling answers an unlisted path with 200 + the shell, before the Worker is
  // consulted. /readyz was missing, so the endpoint whose whole job is reporting that the
  // database or blob store is unreachable answered 200 text/html regardless — a probe that
  // could never say "not ready", which is worse than no probe because a platform health check
  // trusts it. Verified against production before the fix.
  "/readyz",
  "/mcp",
  // The generated OpenAPI spec + its Scalar reference UI. Worker-first, else the SPA
  // not_found_handling shadows them: /docs would render the app shell and the
  // reference's fetch of /openapi.json would get HTML instead of the spec.
  "/openapi.json",
  "/docs",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/openid-configuration",
  // Agent discovery (routes/agent-discovery.ts): the served skill + capability
  // manifest. Worker-first for the same reason as the OAuth docs — the SPA's
  // not_found_handling would otherwise answer with the shell.
  "/skill.md",
  "/.well-known/agent.json",
] as const

/** Server-owned path tokens in declaration order (as the dev proxy lists them). */
export const API_PATHS: readonly string[] = [...API_PREFIXES, ...API_EXACT]

/** True when the API/server owns this path (everything else is the SPA's). */
export const isApiPath = (path: string): boolean =>
  API_PREFIXES.some((p) => path.startsWith(p)) || (API_EXACT as readonly string[]).includes(path)

// The static namespaces (see lib/static-namespaces.ts for why they're worker-first
// on the edge). Deliberately NOT in `isApiPath` (an unmatched one must fall back to
// the shell, never JSON) and not in the dev proxy (Vite serves them itself in dev);
// on Node, mountWeb's own routes below serve them and domain mode runs first.

// Content-hashed assets never change behind a URL — cache them for a year. A new
// build emits new hashes, so this is safe and maximizes cache hits.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

/** The file behind a blog URL: the directory index for /blog, `<slug>.html` for a
 *  post, and the file itself for anything that already names one (rss.xml). */
const blogFile = (path: string): string => {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
  if (trimmed === "/blog") return "/blog"
  return /\.[^/]+$/.test(trimmed) ? trimmed : `${trimmed}.html`
}

export interface ServeWebOpts {
  /** serveStatic root, relative to `process.cwd()`. */
  webRoot: string
  /** The SPA shell HTML (index.html / _shell.html), already read from disk. */
  shellHtml: string
  /** A human 404 page emitted by the web build. Falls back to plain text when absent. */
  notFoundHtml?: string
}

/**
 * Serve the bundled SPA from the API process (single-container self-host). This is
 * the Node-mode mirror of the Worker's Cloudflare Static Assets: hashed `/assets/*`
 * cached immutably, other root files served as-is, and any non-API GET falling back
 * to the shell so the client router takes over. API routes mounted before this
 * always win; `isApiPath` keeps unmatched API URLs as JSON 404s instead of leaking
 * the shell.
 */
export const mountWeb = (app: Hono, { webRoot, shellHtml, notFoundHtml }: ServeWebOpts): void => {
  app.use(
    "/assets/*",
    serveStatic({ root: webRoot, onFound: (_p, c) => c.header("Cache-Control", IMMUTABLE_CACHE) }),
  )
  // Root-level static files Vite emits (favicon, manifest, …).
  app.get("/:file{[^/]+\\.[^/]+}", serveStatic({ root: webRoot }))
  // Nested build directories the marketing pages reference (/site fonts + og image,
  // /brand wordmark). Without these the shell fallback swallows them — the Worker's
  // Static Assets serve them natively, so only Node needs the routes. /site is absent
  // from a self-host build (only the hosted build assembles it) and these 404 there,
  // which is correct: nothing links to them.
  app.get("/site/*", serveStatic({ root: webRoot }))
  app.get("/brand/*", serveStatic({ root: webRoot }))
  // The blog, generated into the build by apps/web/scripts/build-blog.mjs. On the
  // edge Cloudflare's HTML handling maps blog/<slug>.html to /blog/<slug> and the
  // directory to /blog; do the same here so a self-host publishes the same URLs.
  app.get("/blog", serveStatic({ root: webRoot, rewriteRequestPath: blogFile }))
  app.get("/blog/*", serveStatic({ root: webRoot, rewriteRequestPath: blogFile }))
  // Cloudflare's Static Assets HTML handling maps the physical security.html file to
  // its canonical extensionless URL. Mirror that contract so both tiers of a HOSTED
  // deployment serve the same page; the file is part of derive.to's own surface, so
  // an ordinary self-host build has none and this route simply misses.
  app.get("/security", serveStatic({ root: webRoot, path: "security.html" }))
  // Same reason, for the one static file that lives under a dot-directory:
  // /.well-known/security.txt (RFC 9116). The root-file route above only matches a
  // single segment, so without this the shell fallback swallows it and scanners see
  // HTML where the security contact should be. The server-owned well-knowns (OAuth
  // discovery, /.well-known/skills, agent.json) are mounted before mountWeb and
  // still win; an unmatched one falls through to `isApiPath` and stays a JSON 404.
  app.get("/.well-known/*", serveStatic({ root: webRoot }))
  app.notFound((c) => {
    if (isApiPath(c.req.path)) return c.json({ error: "not found" }, 404)
    if ((c.req.method === "GET" || c.req.method === "HEAD") && isSpaPath(c.req.path))
      return c.html(shellHtml)
    return notFoundHtml ? c.html(notFoundHtml, 404) : c.text("not found", 404)
  })
}
