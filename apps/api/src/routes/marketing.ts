import { type Context, Hono } from "hono"
import { getCookie } from "hono/cookie"
import type { AppContext } from "../context"

/**
 * The marketing site (the hosted front door). Two self-contained HTML pages that
 * ship inside the web build at `site/` (authored in apps/web/public/site) and are
 * served worker-first (see lib/serve-web MARKETING_EXACT):
 *
 *   GET /          the landing page — signed-OUT visitors only. A visitor with a
 *                  session cookie (or on the app.* alias host) gets the SPA shell,
 *                  so the app keeps owning `/` for its users.
 *   GET /pricing   the pricing page, for everyone.
 *
 * Always on when the web build ships the pages (deps.marketing); a build without
 * them keeps today's behavior, where the SPA fallback owns both paths. The session
 * check is presence-only — no DB hit on a landing view; a stale cookie serves the
 * shell and the SPA's own guard bounces to /login, exactly as it does today.
 */
export const marketingRoutes = (ctx: AppContext) => {
  const app = new Hono()
  const m = ctx.deps.marketing

  const getShell = async (): Promise<string | null> =>
    ctx.deps.shell ?? (ctx.deps.shellFetch ? await ctx.deps.shellFetch() : null)
  const shellOr404 = async (c: Context) => {
    const shell = await getShell()
    return shell ? c.html(shell) : c.notFound()
  }

  if (!m) {
    // Marketing off, but wrangler.toml's run_worker_first is static config: on the
    // edge these paths still reach the Worker, and nothing else serves them (there is
    // no catch-all asset fallback). Hand back the SPA shell so `/` never 404s. On the
    // Node tier (serveWeb) the in-process static middleware owns them — mount nothing.
    if (!ctx.deps.serveWeb && (ctx.deps.shell || ctx.deps.shellFetch)) {
      app.get("/", shellOr404)
      app.get("/pricing", shellOr404)
    }
    return app
  }
  // Better Auth's session cookie, both spellings (useSecureCookies adds the
  // __Secure- prefix on https origins). Presence only — never validated here.
  const SESSION_COOKIES = ["__Secure-better-auth.session_token", "better-auth.session_token"]
  const hasSession = (c: Context): boolean => SESSION_COOKIES.some((n) => !!getCookie(c, n))

  app.get("/", async (c) => {
    // app.* is the app alias: its visitors chose the app, never the brochure.
    const host = (c.req.header("host") ?? "").toLowerCase()
    if (host.startsWith("app.") || hasSession(c)) return shellOr404(c)
    const html = await m.home()
    if (!html) return shellOr404(c)
    // Never shared-cacheable: the same URL serves the SPA to signed-in visitors,
    // and a cached brochure would shadow the app after login.
    return c.html(html, 200, { "Cache-Control": "private, max-age=0, must-revalidate" })
  })

  app.get("/pricing", async (c) => {
    const html = await m.pricing()
    if (!html) return shellOr404(c)
    return c.html(html, 200, { "Cache-Control": "public, max-age=300" })
  })

  return app
}
