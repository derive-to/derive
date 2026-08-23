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
  // Crawler policy (routes/site.ts): app-owned on every deployment — the
  // Disallow lines guard the app's own private paths — with the Sitemap line
  // only where a public site is bound. In the dev proxy so Vite serves it too.
  "/robots.txt",
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

export interface ServeWebOpts {
  /** serveStatic root, relative to `process.cwd()`. */
  webRoot: string
  /** The SPA shell HTML (index.html / _shell.html), already read from disk. */
  shellHtml: string
  /** A human 404 page emitted by the web build. Falls back to plain text when absent. */
  notFoundHtml?: string
  /** The public site upstream (deps.site), consulted for navigations the app does not own. */
  site?: (req: Request) => Promise<Response>
}

/**
 * Serve the bundled SPA from the API process (single-container self-host). This is
 * the Node-mode mirror of the Worker's Cloudflare Static Assets: hashed `/assets/*`
 * cached immutably, other root files served as-is, and any non-API GET falling back
 * to the shell so the client router takes over. API routes mounted before this
 * always win; `isApiPath` keeps unmatched API URLs as JSON 404s instead of leaking
 * the shell.
 */
export const mountWeb = (
  app: Hono,
  { webRoot, shellHtml, notFoundHtml, site }: ServeWebOpts,
): void => {
  app.use(
    "/assets/*",
    serveStatic({ root: webRoot, onFound: (_p, c) => c.header("Cache-Control", IMMUTABLE_CACHE) }),
  )
  // Root-level static files Vite emits (favicon, manifest, …).
  app.get("/:file{[^/]+\\.[^/]+}", serveStatic({ root: webRoot }))
  // The brand files (wordmark, favicon, fonts) ship in every build and the app
  // itself references them. Without this the shell fallback swallows them — the
  // Worker's Static Assets serve them natively, so only Node needs the route.
  app.get("/brand/*", serveStatic({ root: webRoot }))
  app.notFound((c) => {
    if (isApiPath(c.req.path)) return c.json({ error: "not found" }, 404)
    const navigation = c.req.method === "GET" || c.req.method === "HEAD"
    if (navigation && isSpaPath(c.req.path)) return c.html(shellHtml)
    // A navigation the app does not own belongs to the public site when this
    // deployment has one (derive.to's pages, blog and trust files) — the Node
    // mirror of the Worker fast path's SITE fallback. The site answers with its
    // own status, including its 404 page.
    if (navigation && site) return site(c.req.raw)
    return notFoundHtml ? c.html(notFoundHtml, 404) : c.text("not found", 404)
  })
}
