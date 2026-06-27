import { type ArtifactRecord, parseRef } from "@dock/core"
import { type Context, Hono } from "hono"
import { compress } from "hono/compress"
import { OAUTH_SCOPES } from "./auth-config"
import { type AppDeps, buildContext } from "./context"
import { manifestFormHTML, setupResultHTML } from "./github-app-setup"
import { encryptSecret, signState, verifyState } from "./lib/crypto"
import { convertManifestCode } from "./lib/github-app"
import { cacheControlFor, corsFor, fail, TOMBSTONE } from "./lib/http"
import { observability } from "./lib/observability"
import { inMemoryRateLimiters, ipRateLimit } from "./lib/rate-limit"
import { serveContent } from "./lib/serve-content"
import { log } from "./log"
import { mountMcp } from "./mcp"
import { cliCallbackHTML } from "./oauth-cli-callback"
import { consentHTML } from "./oauth-consent"
import { agentRoutes } from "./routes/agents"
import { analyticsRoutes } from "./routes/analytics"
import { artifactRoutes } from "./routes/artifacts"
import { collectionRoutes } from "./routes/collections"
import { commentRoutes } from "./routes/comments"
import { domainRoutes } from "./routes/domains"
import { embedRoutes } from "./routes/embeds"
import { favoriteRoutes } from "./routes/favorites"
import { followRoutes } from "./routes/follows"
import { moderationRoutes } from "./routes/moderation"
import { notificationRoutes } from "./routes/notifications"
import { proposalRoutes } from "./routes/proposals"
import { rawRoutes } from "./routes/raw"
import { realtimeRoutes } from "./routes/realtime"
import { sessionRoutes } from "./routes/session"
import { sharingRoutes } from "./routes/sharing"
import { slackRoutes } from "./routes/slack"
import { syncRoutes } from "./routes/sync"
import { vitalsRoutes } from "./routes/vitals"
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
  // One limiter set, shared by the IP middleware below and the keyed limiters in
  // buildContext (resolved here and passed in, so both see the same instance). The edge
  // entry supplies native per-colo limiters; Node / self-host / tests fall back to the
  // in-process set (authoritative on one container).
  const rateLimiters = deps.rateLimiters ?? inMemoryRateLimiters(deps)
  const ctx = buildContext({ ...deps, rateLimiters })
  const app = new Hono()

  // Outermost: a per-request id + one structured access-log line (method, path,
  // status, duration, actor, org), so a 500 is correlatable to who/what.
  app.use("*", observability())

  // App-origin security headers. Set after the handler so responses that declare
  // their own policy keep it: artifact bytes carry the sandbox CSP (serveContent),
  // and the embed iframe opts into `frame-ancestors *`. HSTS + nosniff are safe on
  // every response; the clickjacking lock (frame-ancestors 'none' + X-Frame-Options)
  // covers the app UI + API, but never artifact bytes (/raw), the embed surface
  // (/v1/embed), a subdomain-served artifact (already carries a CSP), or SSE streams.
  app.use("*", async (c, next) => {
    await next()
    // A proxied/streamed response (e.g. a Durable Object's SSE stream on the edge,
    // returned via stub.fetch) carries IMMUTABLE headers — mutating them throws and
    // would 500 the request. These headers are belt-and-suspenders on the app
    // surface, never load-bearing on a streamed DO/raw response, so skip silently
    // when the headers can't be written.
    try {
      const h = c.res.headers
      if (!h.has("x-content-type-options")) h.set("X-Content-Type-Options", "nosniff")
      const proto = (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol).replace(
        ":",
        "",
      )
      if (proto === "https" && !h.has("strict-transport-security"))
        h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
      const path = c.req.path
      const framable = path.startsWith("/raw/") || path.startsWith("/v1/embed/")
      if (!framable && !path.endsWith("/events") && !h.has("content-security-policy")) {
        h.set("Content-Security-Policy", "frame-ancestors 'none'")
        h.set("X-Frame-Options", "DENY")
      }
    } catch {
      // immutable (proxied/streamed) response headers — leave as-is
    }
  })

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
      return serveContent(
        c,
        ctx.blobs,
        version,
        a.title,
        prefix,
        rawPath,
        cacheControlFor(a.visibility),
      )
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
      if (record?.status !== "active") return isSub ? c.text("not found", 404) : next()
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
    app.use("/api/auth/*", ipRateLimit(rateLimiters.auth))
    // Anonymous OAuth client registration (open DCR) gets a tighter per-IP cap on
    // top, so no single source can flood the client table.
    app.use("/api/auth/oauth2/register", ipRateLimit(rateLimiters.oauthRegister))
    const writeLimiter = ipRateLimit(rateLimiters.write)
    app.use("/v1/*", (c, next) =>
      c.req.method === "GET" || c.req.method === "HEAD" ? next() : writeLimiter(c, next),
    )
  }

  // After an anonymous registration, opportunistically reap abandoned anonymous
  // clients (never consented, no tokens, > 1 day old). Best-effort and async so it
  // never delays the response; runs on both the Node and the (cron-less) edge tier.
  app.use("/api/auth/oauth2/register", async (c, next) => {
    await next()
    if (c.req.method === "POST" && c.res.status < 300) {
      const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString()
      void ctx.meta.pruneStaleOAuthClients(cutoff).catch(() => 0)
    }
  })

  // OAuth 2.0 discovery at the well-known root (RFC 8414 + RFC 9728), mirroring
  // what the oidc-provider plugin serves under /api/auth — MCP clients and standard
  // OAuth tooling probe the root. Issuer is the live request origin so it's correct
  // behind any proxy / on workers.dev without configuration.
  const asMeta = (c: Context) => {
    const base = new URL(c.req.url).origin
    return {
      issuer: base,
      authorization_endpoint: `${base}/api/auth/oauth2/authorize`,
      token_endpoint: `${base}/api/auth/oauth2/token`,
      registration_endpoint: `${base}/api/auth/oauth2/register`,
      userinfo_endpoint: `${base}/api/auth/oauth2/userinfo`,
      jwks_uri: `${base}/api/auth/jwks`,
      scopes_supported: [...OAUTH_SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    }
  }
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(asMeta(c)))
  // OIDC discovery for standards-compliant OIDC clients. We issue id tokens (jwt
  // plugin) + advertise the openid scope + a userinfo endpoint, so RPs that probe
  // /.well-known/openid-configuration must get JSON here — previously this path fell
  // through to the SPA shell (HTML 200), breaking discovery. Superset of the OAuth AS
  // metadata with the two OIDC-required fields.
  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      ...asMeta(c),
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["EdDSA"],
    }),
  )
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const base = new URL(c.req.url).origin
    return c.json({
      resource: base,
      authorization_servers: [base],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
    })
  })

  // The consent screen the oauth-provider plugin redirects a signed-in user to
  // (client_id + scope + code in the query). We render the branded grant page; on
  // Approve it posts back to /api/auth/oauth2/consent, which completes the flow.
  app.get("/oauth/consent", async (c) => {
    const clientId = c.req.query("client_id") ?? ""
    const scopes = (c.req.query("scope") ?? "").split(/\s+/).filter(Boolean)
    const clientName = (await ctx.meta.getOAuthClientName(clientId)) || clientId || "An application"
    return c.html(consentHTML({ clientName, scopes, query: new URL(c.req.url).search }))
  })

  // Hosted callback for the CLI/native OAuth flow (`dock login`). A command-line
  // client registers this as its redirect_uri instead of localhost; after consent
  // the browser lands here with the one-time code, which we display for the user to
  // paste back into the terminal (the PKCE verifier stays on their machine).
  app.get("/oauth/cli-callback", (c) => {
    const code = c.req.query("code")
    const error = c.req.query("error_description") ?? c.req.query("error")
    return c.html(cliCallbackHTML({ code, error }))
  })

  // ---- One-click GitHub App registration (manifest flow) ----------------
  // /new renders the auto-submitting manifest form (admins only); GitHub creates
  // the App and redirects to /created with a temporary code we trade for the
  // App's credentials. Both are top-level navigations (not the /v1 API), bound by
  // a signed `state` carrying the initiating user. Needs an encryptionKey — App
  // secrets are never stored in the clear.
  app.get("/settings/github/app/new", async (c) => {
    if (!deps.encryptionKey)
      return c.html(
        setupResultHTML({ ok: false, error: "Server is missing an encryption key." }),
        500,
      )
    if (!(await ctx.workspaceCan(c, "publish")))
      return c.redirect("/login?return_to=/settings/github/app/new")
    const uid = (await ctx.currentUser(c))?.id ?? "anon"
    const state = signState({ kind: "app-manifest", uid }, deps.encryptionKey)
    return c.html(manifestFormHTML({ baseUrl: deps.baseUrl, state }))
  })

  app.get("/settings/github/app/created", async (c) => {
    const code = c.req.query("code")
    const stateRaw = c.req.query("state") ?? ""
    if (!deps.encryptionKey || !code)
      return c.html(setupResultHTML({ ok: false, error: "Missing setup code." }), 400)
    const state = verifyState<{ kind?: string }>(stateRaw, deps.encryptionKey)
    if (state?.kind !== "app-manifest")
      return c.html(setupResultHTML({ ok: false, error: "This setup link has expired." }), 400)
    try {
      const conv = await convertManifestCode(code)
      const key = deps.encryptionKey
      await ctx.meta.setGithubApp({
        id: "default",
        app_id: conv.app_id,
        slug: conv.slug,
        client_id: conv.client_id,
        client_secret: encryptSecret(conv.client_secret, key),
        private_key: encryptSecret(conv.pem, key),
        webhook_secret: encryptSecret(conv.webhook_secret, key),
        created_at: new Date().toISOString(),
      })
      return c.html(setupResultHTML({ ok: true, slug: conv.slug }))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log.error("github app manifest conversion failed", { error: detail })
      return c.html(
        setupResultHTML({ ok: false, error: `Could not create the GitHub App. ${detail}` }),
        502,
      )
    }
  })

  // Better Auth owns /api/auth/* (sign-up/in/out, OAuth, OIDC/SSO, session).
  if (deps.auth) {
    const auth = deps.auth
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  }

  app.get("/healthz", (c) => c.json({ ok: true }))

  // Which social sign-in providers are configured (env-gated in auth-config), so
  // the login page only renders buttons that actually work. Public + read-only.
  app.get("/v1/auth/providers", (c) =>
    c.json({
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      github: !!(process.env.GITHUB_LOGIN_CLIENT_ID && process.env.GITHUB_LOGIN_CLIENT_SECRET),
    }),
  )

  // Readiness (vs /healthz liveness): proves the datastore + blob store are
  // actually reachable, so an orchestrator stops routing to an instance whose DB
  // or blob backend is down instead of letting it 500 every request. 503 on any
  // failure. Point the platform healthcheck here for rollout/traffic gating.
  app.get("/readyz", async (c) => {
    try {
      await deps.meta.getWorkspace(deps.defaultOrgId ?? "default")
      // A valid 64-hex key so the store does real I/O (fs read / S3 GET): the
      // sentinel doesn't exist, so a healthy backend returns null, but an
      // unreachable one throws — which is the signal we want. A non-hex key
      // would short-circuit to null without touching the backend (no-op probe).
      await deps.blobs.get("0".repeat(64))
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
    /^\/v1\/vitals$/, // anonymous Core Web Vitals beacon (telemetry, no state)
    /^\/v1\/sync\/github\/webhook$/, // GitHub App webhook — HMAC signature is the gate
    /^\/v1\/slack\/events$/, // Slack Events API — signing-secret signature is the gate
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
    followRoutes,
    collectionRoutes,
    syncRoutes,
    slackRoutes,
    vitalsRoutes,
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

  // The remote MCP endpoint — Streamable HTTP, bearer-gated by the agent bridge.
  mountMcp(app, ctx)

  return app
}
