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
  "/agents",
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
  /^\/(?:agents|artifacts|claim|collections|contexts|settings|template-libraries|templates|users)\/[^/]+$/
const invite = /^\/invite\/(?:(?:a|c)\/)?[^/]+$/

export const isSpaPath = (path: string): boolean => {
  const normalized = path.length > 1 ? path.replace(/\/$/, "") : path
  return SPA_EXACT.has(normalized) || oneSegment.test(normalized) || invite.test(normalized)
}

// Root-level files emitted by Vite that must bypass the application when all
// navigations are worker-first. Only the agent-documentation files remain: the
// public site's pages and trust files (sitemap, security.*, the .well-known
// verifications) belong to the site Worker, and robots.txt is an app route whose
// Sitemap line depends on a site being bound.
const STATIC_ROOT_PATHS = new Set(["/llms-full.txt", "/llms.txt"])

/** True when a root-level public file belongs to the static asset binding. */
export const isStaticRootPath = (path: string): boolean => STATIC_ROOT_PATHS.has(path)

// Only `/` needs app logic among the site's URLs: it is session-dependent. The
// rest of the public site never enters the app's routes — the Worker fast path
// and Node's not-found fallback forward them to the SITE upstream wholesale.
const SERVER_EXACT = new Set(["/"])
const SERVER_PREFIXES = ["/artifacts/", "/settings/github/", "/settings/slack/", "/users/"] as const

/** Paths that need app logic before a shell or page can be selected. */
export const isServerRenderedPath = (path: string): boolean =>
  SERVER_EXACT.has(path) ||
  path === "/settings/slack" ||
  SERVER_PREFIXES.some((prefix) => path.startsWith(prefix))
