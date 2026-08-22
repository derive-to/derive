/**
 * Routes owned by the client application. Keeping this explicit lets the Node
 * server and the edge return a real 404 for arbitrary paths without breaking
 * refreshes on legitimate TanStack Router deep links.
 *
 * Query strings and fragments are not part of `pathname`, so callers pass only
 * the URL path. A single trailing slash is accepted because browsers and copied
 * links commonly add one; the client router canonicalises after hydration.
 */
const SPA_EXACT = new Set([
  "/",
  "/archived",
  "/brandprint",
  "/chat",
  "/contexts",
  "/favorites",
  "/feedback",
  "/following",
  "/login",
  "/new",
  "/people",
  "/reset-password",
  "/roadmap",
  "/search",
  "/settings",
  "/showcase",
  "/shared",
  "/template-libraries",
  "/templates",
  "/unlisted",
  "/welcome",
])

const oneSegment =
  /^\/(?:artifacts|claim|collections|contexts|settings|template-libraries|templates|users)\/[^/]+$/
const invite = /^\/invite\/(?:(?:a|c)\/)?[^/]+$/

export const isSpaPath = (path: string): boolean => {
  const normalized = path.length > 1 ? path.replace(/\/$/, "") : path
  return SPA_EXACT.has(normalized) || oneSegment.test(normalized) || invite.test(normalized)
}

// Root-level files emitted by Vite that must bypass the application when all
// navigations are worker-first. Keep the canonical extensionless security page
// beside its physical filename: Cloudflare's HTML handling serves
// `/security.html` at `/security`, while the explicit allowlist prevents an
// arbitrary missing file from falling through to the SPA shell with a soft 200.
const STATIC_ROOT_PATHS = new Set([
  "/.well-known/glama.json",
  "/.well-known/mcp-registry-auth",
  "/.well-known/security.txt",
  "/llms-full.txt",
  "/llms.txt",
  "/robots.txt",
  "/security",
  "/security.html",
  "/sitemap.xml",
])

/** True when a root-level public file belongs to the static asset binding. */
export const isStaticRootPath = (path: string): boolean => STATIC_ROOT_PATHS.has(path)

const SERVER_EXACT = new Set(["/", "/pricing", "/privacy", "/guides", "/examples"])
const SERVER_PREFIXES = ["/artifacts/", "/settings/github/", "/settings/slack/", "/users/"] as const

/** Paths that need app logic before a shell or page can be selected. */
export const isServerRenderedPath = (path: string): boolean =>
  SERVER_EXACT.has(path) ||
  path === "/settings/github" ||
  path === "/settings/slack" ||
  SERVER_PREFIXES.some((prefix) => path.startsWith(prefix))
