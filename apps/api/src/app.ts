import { type Context, Hono } from "hono"
import { compress } from "hono/compress"
import { type AppDeps, buildContext } from "./context"
import { corsFor, fail } from "./lib/http"
import { makeRateLimiter } from "./lib/rate-limit"
import { log } from "./log"
import { agentRoutes } from "./routes/agents"
import { analyticsRoutes } from "./routes/analytics"
import { artifactRoutes } from "./routes/artifacts"
import { collectionRoutes } from "./routes/collections"
import { commentRoutes } from "./routes/comments"
import { embedRoutes } from "./routes/embeds"
import { favoriteRoutes } from "./routes/favorites"
import { moderationRoutes } from "./routes/moderation"
import { notificationRoutes } from "./routes/notifications"
import { proposalRoutes } from "./routes/proposals"
import { rawRoutes } from "./routes/raw"
import { realtimeRoutes } from "./routes/realtime"
import { sessionRoutes } from "./routes/session"
import { sharingRoutes } from "./routes/sharing"
import { syncRoutes } from "./routes/sync"
import { webhookRoutes } from "./routes/webhooks"
import { workspaceRoutes } from "./routes/workspace"

// Re-exported from its lib home so existing importers (and tests) keep working.
export { isPublicHttpUrl } from "./lib/net"
export type { AppDeps }

/**
 * The Hono app: a shared request context (auth, authz, workspace resolution,
 * realtime, quotas) wired once, then one router per feature mounted on top.
 * `node.ts` adds static SPA serving around what this returns.
 */
export function createApp(deps: AppDeps): Hono {
  const ctx = buildContext(deps)
  const app = new Hono()

  // gzip everything (Node/Fly entry only — the Worker edge compresses already).
  // Registered first so it wraps every downstream response; honors Accept-Encoding
  // and skips already-small bodies. Exception: the SSE streams (paths ending in
  // /events) — gzip buffers the stream and would stall real-time delivery, so they
  // pass through uncompressed.
  if (deps.compress) {
    const gzip = compress()
    app.use("*", (c, next) => (c.req.path.endsWith("/events") ? next() : gzip(c, next)))
  }

  // Uncaught errors become a consistent JSON 500 (never a stack trace to the
  // client) and a structured server log line.
  app.onError((err, c) => {
    log.error("unhandled error", {
      method: c.req.method,
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
    })
    return c.json({ error: "internal error" }, 500)
  })

  // ---- Origin isolation (A4) --------------------------------------------
  // When a sandbox origin is configured, artifact bytes live on a different
  // registrable domain than the app + auth cookies. This guard, registered
  // before everything, splits the two:
  //   · on the sandbox host  → ONLY /raw/* (and /healthz); never auth/API/app,
  //     so the sandbox can't double as a session front-door.
  //   · on the app host      → /raw/* 302-redirects to the sandbox, so user
  //     HTML can never execute on the cookie origin. The redirect IS the wall,
  //     independent of any client pointing its iframe at the right place.
  const sandboxHost = deps.sandboxOrigin ? new URL(deps.sandboxOrigin).host : null
  if (sandboxHost) {
    const reqHost = (c: Context) => (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase()
    app.use("*", async (c, next) => {
      const path = c.req.path
      if (reqHost(c) === sandboxHost.toLowerCase()) {
        if (path === "/healthz" || path.startsWith("/raw/")) return next()
        return c.text("not found", 404)
      }
      // App host: bounce raw bytes to the sandbox origin (preserve the path+query).
      if (path.startsWith("/raw/")) {
        return c.redirect(`${deps.sandboxOrigin}${path}${new URL(c.req.url).search}`, 302)
      }
      return next()
    })
  }

  // Credentialed CORS for the cross-origin SPA. A wildcard ACAO can't carry
  // cookies, so the request's Origin is echoed back only when it's allow-listed;
  // OPTIONS preflights are answered here. Same-origin/self-host = no-op.
  if (ctx.allowOrigins.size) {
    app.use("/api/*", corsFor(ctx.allowOrigins))
    app.use("/v1/*", corsFor(ctx.allowOrigins))
  }
  if (deps.rateLimit) {
    // Strict on auth (credential brute-force); lenient on mutating API calls.
    app.use("/api/auth/*", makeRateLimiter(60_000, 20))
    const writeLimiter = makeRateLimiter(60_000, 120)
    app.use("/v1/*", (c, next) =>
      c.req.method === "GET" || c.req.method === "HEAD" ? next() : writeLimiter(c, next),
    )
  }

  // Better Auth owns /api/auth/* (sign-up/in/out, OAuth, OIDC/SSO, session).
  if (deps.auth) {
    const auth = deps.auth
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  }

  app.get("/healthz", (c) => c.json({ ok: true }))

  // A minimal API-origin landing. Skipped when the SPA is bundled in-process
  // (serveWeb) so the app's own home page owns `/`.
  if (!deps.serveWeb)
    app.get("/", (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Dock</title>
<body style="font:16px/1.6 system-ui;background:#f6f0e3;color:#2a2540;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="letter-spacing:-.02em">Dock</h1>
<p>An open home for AI-generated artifacts.<br>
<code style="background:#eee7d6;padding:2px 8px;border-radius:6px">dock publish ./your-thing</code></p></div>`,
      ),
    )

  // ---- Hard anonymous lockdown ------------------------------------------
  // An anonymous caller (no signed-in session, no agent, no static token) may
  // only READ and signal that they're viewing — the Google-Docs/Figma "someone
  // is here" experience (presence, view count, and a live cursor). Every other
  // mutation is refused here, at the door, before any route runs: one structural
  // gate, so a newly added mutating route can never accidentally be exposed to
  // anonymous callers. The per-route role checks still apply on top (defense in
  // depth). Auth lives under /api/auth and reads (GET/HEAD) are untouched;
  // OPTIONS preflights pass through to CORS. All three allowed actions are
  // ephemeral and identity-safe (the server, not the client, names the viewer).
  const ANON_WRITE_ALLOW = [
    /^\/v1\/artifacts\/[^/]+\/presence$/, // ephemeral "I'm viewing" heartbeat
    /^\/v1\/artifacts\/[^/]+\/cursor$/, // ephemeral live cursor (viral viewing)
    /^\/v1\/artifacts\/[^/]+\/view$/, // de-duped, anonymous-safe view counter
    /^\/v1\/artifacts\/[^/]+\/unlock$/, // password unlock — the password is the gate
  ]
  app.use("/v1/*", async (c, next) => {
    const m = c.req.method
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next()
    if (await ctx.isPrincipal(c)) return next()
    if (ANON_WRITE_ALLOW.some((re) => re.test(c.req.path))) return next()
    return fail(c, 403, "forbidden")
  })

  // One router per feature, all sharing the context. Paths are distinct, so the
  // mount order doesn't affect matching.
  for (const routes of [
    sessionRoutes,
    workspaceRoutes,
    agentRoutes,
    artifactRoutes,
    sharingRoutes,
    favoriteRoutes,
    collectionRoutes,
    syncRoutes,
    moderationRoutes,
    proposalRoutes,
    commentRoutes,
    realtimeRoutes,
    analyticsRoutes,
    notificationRoutes,
    webhookRoutes,
    rawRoutes,
    embedRoutes,
  ])
    app.route("/", routes(ctx))

  return app
}
