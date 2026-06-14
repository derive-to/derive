import { type ArtifactRecord, parseRef } from "@dock/core"
import { type Context, Hono } from "hono"
import { compress } from "hono/compress"
import { type AppDeps, buildContext } from "./context"
import { corsFor, fail, TOMBSTONE } from "./lib/http"
import { observability } from "./lib/observability"
import { makeRateLimiter } from "./lib/rate-limit"
import { serveContent } from "./lib/serve-content"
import { log } from "./log"
import { agentRoutes } from "./routes/agents"
import { analyticsRoutes } from "./routes/analytics"
import { artifactRoutes } from "./routes/artifacts"
import { collectionRoutes } from "./routes/collections"
import { commentRoutes } from "./routes/comments"
import { domainRoutes } from "./routes/domains"
import { embedRoutes } from "./routes/embeds"
import { favoriteRoutes } from "./routes/favorites"
import { moderationRoutes } from "./routes/moderation"
import { notificationRoutes } from "./routes/notifications"
import { proposalRoutes } from "./routes/proposals"
import { rawRoutes } from "./routes/raw"
import { realtimeRoutes } from "./routes/realtime"
import { sessionRoutes } from "./routes/session"
import { sharingRoutes } from "./routes/sharing"
import { webhookRoutes } from "./routes/webhooks"
import { workspaceRoutes } from "./routes/workspace"
import { workspaceDomainRoutes } from "./routes/workspace-domains"

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

  // Outermost: a per-request id + one structured access-log line (method, path,
  // status, duration, actor, org), so a 500 is correlatable to who/what.
  app.use("*", observability())

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
      request_id: c.get("requestId"),
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

  // ---- Domain mode (C1): vanity subdomains + workspace custom domains -----
  // A request whose Host is in the `domain` table serves artifact bytes off the app
  // origin (only bytes + the anchor client, never the app/auth/API; the app's own
  // host is never matched). The host is cross-origin so the actor is anonymous: only
  // public/link artifacts resolve, gated ones 404, removed ones 410. Two shapes,
  // chosen by whether the row is bound to one artifact — this keeps per-artifact
  // custom domains + wildcard subdomains addable later with no dispatch change:
  //   · artifact-bound (subdomain today)  → serve that artifact at the host root.
  //   · workspace domain (artifact_id null) → serve `<host>/<ref>`, scoped to the
  //     domain's workspace so one tenant's domain can't serve another's artifact.
  // No host cache needed: on the edge, Cloudflare only routes registered hostnames
  // to the Worker, so the lookup surface is bounded.
  const subBase = deps.subdomainBase?.toLowerCase()
  const customEnabled = !!deps.customDomains
  const appHostForSub = (() => {
    try {
      return new URL(deps.baseUrl).host.toLowerCase()
    } catch {
      return null
    }
  })()
  if (subBase || customEnabled) {
    const serveArtifact = async (
      c: Context,
      a: ArtifactRecord,
      n: number,
      prefix: string,
      rawPath: string,
    ) => {
      if (!(await ctx.authorize(c, "read", a))) return c.text("not found", 404)
      if (a.removed_at) return c.text(TOMBSTONE, 410)
      const version = await ctx.meta.getVersion(a.id, n)
      if (!version) return c.text("not found", 404)
      return serveContent(c, ctx.blobs, version, a.title, prefix, rawPath)
    }
    app.use("*", async (c, next) => {
      const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase().split(":")[0]
      if (!host || host === appHostForSub || (sandboxHost && host === sandboxHost.toLowerCase()))
        return next()
      const isSub = !!subBase && host !== subBase && host.endsWith(`.${subBase}`)
      if (!isSub && !customEnabled) return next()
      // The served HTML references /raw/dock-client.js; let raw + health through.
      if (c.req.path === "/healthz" || c.req.path.startsWith("/raw/")) return next()
      const record = await ctx.meta.getDomain(host)
      // Unknown subdomain → 404 (clearly ours); unknown/pending custom host → fall
      // through so an unregistered host pointed at us never serves stale content.
      if (!record || record.status !== "active") return isSub ? c.text("not found", 404) : next()
      if (record.artifact_id) {
        // Artifact-bound host (subdomain today): serve that one artifact at the root.
        const a = await ctx.meta.getArtifactById(record.artifact_id)
        if (!a) return c.text("not found", 404)
        return serveArtifact(
          c,
          a,
          a.current_version,
          "/",
          decodeURIComponent(c.req.path.replace(/^\/+/, "")),
        )
      }
      // Workspace domain: `<host>/<ref>/<sub>` → the workspace's artifact at <ref>,
      // scoped to the domain's org so a tenant can't serve another tenant's artifact.
      const segs = c.req.path.replace(/^\/+/, "").split("/")
      const ref = segs[0] ?? ""
      if (!ref) return c.text("not found", 404)
      const a = await ctx.meta.getByShortId(parseRef(ref).shortId)
      if (!a || a.org_id !== record.org_id) return c.text("not found", 404)
      const n = parseRef(ref).version ?? a.current_version
      return serveArtifact(c, a, n, `/${ref}/`, decodeURIComponent(segs.slice(1).join("/")))
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

  // Readiness (vs /healthz liveness): proves the datastore + blob store are
  // actually reachable, so an orchestrator stops routing to an instance whose DB
  // or blob backend is down instead of letting it 500 every request. 503 on any
  // failure. Point the platform healthcheck here for rollout/traffic gating.
  app.get("/readyz", async (c) => {
    try {
      await deps.meta.getWorkspace(deps.defaultOrgId ?? "default")
      await deps.blobs.get("__readyz_probe__")
      return c.json({ ok: true })
    } catch (err) {
      log.error("readiness check failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      return c.json({ ok: false }, 503)
    }
  })

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
    moderationRoutes,
    proposalRoutes,
    commentRoutes,
    realtimeRoutes,
    analyticsRoutes,
    notificationRoutes,
    webhookRoutes,
    rawRoutes,
    embedRoutes,
    domainRoutes,
    workspaceDomainRoutes,
  ])
    app.route("/", routes(ctx))

  return app
}
