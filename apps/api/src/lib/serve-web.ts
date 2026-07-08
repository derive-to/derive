import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"

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
const API_PREFIXES = ["/v1", "/api", "/raw", "/oauth"] as const
// Exact server-owned paths. The OAuth 2.0 discovery docs (RFC 8414 / RFC 9728) the
// Worker must answer with JSON, else SPA not_found_handling shadows them. `/mcp` is
// EXACT, not a prefix: the MCP Streamable-HTTP endpoint is hit at exactly /mcp with
// no subpath, so a `/mcp/*` worker-first glob misses it and the asset handler 405s
// the POST. (Trailing-slash/subpath variants aren't used by the transport.)
const API_EXACT = [
  "/healthz",
  "/mcp",
  // The generated OpenAPI spec + its Scalar reference UI. Worker-first, else the SPA
  // not_found_handling shadows them: /docs would render the app shell and the
  // reference's fetch of /openapi.json would get HTML instead of the spec.
  "/openapi.json",
  "/docs",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/openid-configuration",
] as const

// Page prefixes the SERVER renders before handing off to the SPA, but that are NOT
// API paths: `/artifacts/:ref` (per-artifact unfurl meta) and `/users/:handle` (per-profile unfurl
// meta) are served as the SPA shell with OpenGraph/Twitter meta injected for crawlers
// (which don't run JS). `/settings/github` and `/settings/slack` are plain server-rendered
// HTML pages (the App-manifest setup flow), not the SPA at all. The edge Worker must run
// first on these to render; the dev proxy and `isApiPath` deliberately ignore them (in dev
// the SPA owns the page, and an unmatched one still falls back to the shell, never JSON).
const SERVER_PAGE_PREFIXES = [
  "/artifacts",
  "/users",
  "/settings/github",
  "/settings/slack",
] as const

/** Server-owned path tokens in declaration order (as the dev proxy lists them). */
export const API_PATHS: readonly string[] = [...API_PREFIXES, ...API_EXACT]

/** True when the API/server owns this path (everything else is the SPA's). */
export const isApiPath = (path: string): boolean =>
  API_PREFIXES.some((p) => path.startsWith(p)) || (API_EXACT as readonly string[]).includes(path)

/** The `run_worker_first` globs this contract implies: API prefixes + the
 *  server-rendered page prefixes (both → `/*`), plus the exact paths as-is. */
export const workerFirstGlobs = (): string[] => [
  ...API_PREFIXES.map((p) => `${p}/*`),
  ...SERVER_PAGE_PREFIXES.map((p) => `${p}/*`),
  ...API_EXACT,
]

// Content-hashed assets never change behind a URL — cache them for a year. A new
// build emits new hashes, so this is safe and maximizes cache hits.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

export interface ServeWebOpts {
  /** serveStatic root, relative to `process.cwd()`. */
  webRoot: string
  /** The SPA shell HTML (index.html / _shell.html), already read from disk. */
  shellHtml: string
}

/**
 * Serve the bundled SPA from the API process (single-container self-host). This is
 * the Node-mode mirror of the Worker's Cloudflare Static Assets: hashed `/assets/*`
 * cached immutably, other root files served as-is, and any non-API GET falling back
 * to the shell so the client router takes over. API routes mounted before this
 * always win; `isApiPath` keeps unmatched API URLs as JSON 404s instead of leaking
 * the shell.
 */
export const mountWeb = (app: Hono, { webRoot, shellHtml }: ServeWebOpts): void => {
  app.use(
    "/assets/*",
    serveStatic({ root: webRoot, onFound: (_p, c) => c.header("Cache-Control", IMMUTABLE_CACHE) }),
  )
  // Root-level static files Vite emits (favicon, manifest, …).
  app.get("/:file{[^/]+\\.[^/]+}", serveStatic({ root: webRoot }))
  app.notFound((c) =>
    isApiPath(c.req.path) ? c.json({ error: "not found" }, 404) : c.html(shellHtml),
  )
}
