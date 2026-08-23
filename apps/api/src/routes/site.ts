import { type Context, Hono } from "hono"
import { getCookie } from "hono/cookie"
import type { AppContext } from "../context"
import { SESSION_COOKIE_NAMES } from "../lib/http"

/**
 * The front door. derive.to's public site (the marketing pages, the blog, the
 * trust files) lives in its own Worker — github.com/derive-to/site — reached
 * through `deps.site`: the SITE service binding on the edge, DERIVE_SITE_ORIGIN
 * on Node. The app itself owns exactly two paths here:
 *
 *   GET /            the shared URL. Signed-OUT visitors get the site's landing
 *                    page; a session cookie (or the app.* alias host) gets the
 *                    SPA shell, so the app keeps owning `/` for its users.
 *   GET /robots.txt  crawler policy is the app's on every deployment (the
 *                    Disallow lines guard its own private paths); the Sitemap
 *                    line exists only where a site does.
 *
 * The site's other pages (/pricing, /blog, …) never reach these routes: the
 * Worker's fast path and Node's not-found fallback hand any navigation the app
 * does not own to the site (worker.ts, lib/serve-web.ts), and the site's own
 * script sets their caching and security headers. Without `deps.site` — every
 * self-host — the SPA owns `/`, and the shell fallback below keeps the front
 * door from 404ing on the edge, where run_worker_first is static config. The
 * session check is presence-only — no DB hit on a landing view; a stale cookie
 * serves the shell and the SPA's own guard bounces to /login.
 */
export const siteRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const site = ctx.deps.site

  const getShell = async (): Promise<string | null> =>
    ctx.deps.shell ?? (ctx.deps.shellFetch ? await ctx.deps.shellFetch() : null)
  const shellOr404 = async (c: Context) => {
    const shell = await getShell()
    return shell ? c.html(shell) : c.notFound()
  }

  app.get("/robots.txt", (c) =>
    c.text(
      [
        "User-agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Disallow: /oauth/",
        "Disallow: /settings/",
        "Disallow: /v1/",
        ...(site ? ["", `Sitemap: ${ctx.deps.baseUrl}/sitemap.xml`] : []),
        "",
      ].join("\n"),
      200,
      { "Cache-Control": "public, max-age=3600" },
    ),
  )

  if (!site) {
    // No site upstream. The Node tier's static middleware and SPA fallback own
    // `/`; on the edge nothing else serves it (there is no catch-all asset
    // fallback), so hand back the shell rather than a 404.
    if (!ctx.deps.serveWeb && (ctx.deps.shell || ctx.deps.shellFetch)) app.get("/", shellOr404)
    return app
  }

  // Presence only — never validated here; a stale cookie serves the shell and the
  // SPA's own guard bounces to /login.
  const hasSession = (c: Context): boolean => SESSION_COOKIE_NAMES.some((n) => !!getCookie(c, n))

  app.get("/", async (c) => {
    // app.* is the app alias: its visitors chose the app, never the brochure.
    const host = (c.req.header("host") ?? "").toLowerCase()
    if (host.startsWith("app.") || hasSession(c)) return shellOr404(c)
    const page = await site(c.req.raw)
    // A broken or empty site deploy must never 404 the front door.
    if (!page.ok) return shellOr404(c)
    const res = new Response(page.body, page)
    // Never shared-cacheable: the same URL serves the SPA to signed-in visitors,
    // and a cached brochure would shadow the app after login.
    res.headers.set("Cache-Control", "private, max-age=0, must-revalidate")
    return res
  })

  return app
}
