import { type ArtifactRecord, parseRef } from "@derive/core"
import { OpenAPIHono } from "@hono/zod-openapi"
import { Scalar } from "@scalar/hono-api-reference"
import type { Context, Hono } from "hono"
import { compress } from "hono/compress"
import type { BlankEnv } from "hono/types"
import { OAUTH_ANON_CLIENT_TTL_MS } from "./auth-config"
import { type AppDeps, buildContext } from "./context"
import { cacheControlFor, corsFor, fail, TOMBSTONE } from "./lib/http"
import { observability, redactPath } from "./lib/observability"
import { inMemoryRateLimiters, ipRateLimit } from "./lib/rate-limit"
import { serveContent } from "./lib/serve-content"
import { log } from "./log"
import { mountMcp } from "./mcp"
import { agentRoutes } from "./routes/agents"
import { analyticsRoutes } from "./routes/analytics"
import { artifactRoutes } from "./routes/artifacts"
import { assetRoutes } from "./routes/assets"
import { betaRoutes } from "./routes/beta"
import { blobRoutes } from "./routes/blob"
import { collectionRoutes } from "./routes/collections"
import { commentRoutes } from "./routes/comments"
import { conciergeRoutes } from "./routes/concierge"
import { contextRoutes } from "./routes/contexts"
import { domainRoutes } from "./routes/domains"
import { embedRoutes } from "./routes/embeds"
import { favoriteRoutes } from "./routes/favorites"
import { folderRoutes } from "./routes/folders"
import { followRoutes } from "./routes/follows"
import { githubAppRoutes } from "./routes/github-app"
import { livingRoutes } from "./routes/living"
import { marketingRoutes } from "./routes/marketing"
import { moderationRoutes } from "./routes/moderation"
import { notificationRoutes } from "./routes/notifications"
import { oauthRoutes } from "./routes/oauth"
import { proposalRoutes } from "./routes/proposals"
import { rawRoutes } from "./routes/raw"
import { realtimeRoutes } from "./routes/realtime"
import { reviewRoutes } from "./routes/review"
import { reworkRoutes } from "./routes/rework"
import { sessionRoutes } from "./routes/session"
import { sharingRoutes } from "./routes/sharing"
import { slackRoutes } from "./routes/slack"
import { syncRoutes } from "./routes/sync"
import { systemRoutes } from "./routes/system"
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
  // OpenAPIHono is a drop-in extension of Hono: every existing route/middleware works
  // unchanged, and routers that adopt createRoute() (contract-first) contribute their
  // schemas to the generated spec below. Untouched routers mount exactly as before.
  // Pinned to BlankEnv (what the bare `new Hono()` inferred) so the instance stays
  // assignable to Hono everywhere createApp's result is used (node.ts, worker.ts, tests).
  const app = new OpenAPIHono<BlankEnv>()

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
      path: redactPath(c.req.path),
      request_id: c.get("requestId"),
      error: err instanceof Error ? err.message : String(err),
      // Server log only (never the client) — a production 500 without a stack is
      // a message with no location.
      stack: err instanceof Error ? err.stack : undefined,
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
        cacheControlFor(a.link_role, !!a.password_hash),
      )
    }
    app.use("*", async (c, next) => {
      const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase().split(":")[0]
      if (!host || host === appHostForSub || (sandboxHost && host === sandboxHost.toLowerCase()))
        return next()
      const isSub = !!subBase && host !== subBase && host.endsWith(`.${subBase}`)
      if (!isSub && !customEnabled) return next()
      // The served HTML references /raw/derive-client.js; let raw + health through.
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
    // Mail-triggering auth endpoints get a much tighter cap on top (each request emails an
    // address, so this bounds inbox-bombing). Registered before the general auth limiter;
    // Hono runs both, and the tighter one 429s first.
    const authEmailLimiter = ipRateLimit(rateLimiters.authEmail)
    for (const p of [
      "/api/auth/request-password-reset",
      "/api/auth/send-verification-email",
      "/api/auth/change-email",
      // The beta-signup form emails an arbitrary address too (routes/beta.ts), so it
      // rides the same tight mail-triggering cap.
      "/v1/beta/signup",
    ])
      app.use(p, authEmailLimiter)
    // Anonymous OAuth client registration (open DCR) gets a tighter per-IP cap on
    // top, so no single source can flood the client table.
    app.use("/api/auth/oauth2/register", ipRateLimit(rateLimiters.oauthRegister))
    const writeLimiter = ipRateLimit(rateLimiters.write)
    app.use("/v1/*", (c, next) =>
      c.req.method === "GET" || c.req.method === "HEAD" ? next() : writeLimiter(c, next),
    )
  }

  // After an anonymous registration, opportunistically reap abandoned anonymous
  // clients (never consented, no tokens, > OAUTH_ANON_CLIENT_TTL_MS old). Best-effort
  // and async so it never delays the response; runs on both the Node and the
  // (cron-less) edge tier.
  app.use("/api/auth/oauth2/register", async (c, next) => {
    await next()
    if (c.req.method === "POST" && c.res.status < 300) {
      const cutoff = new Date(Date.now() - OAUTH_ANON_CLIENT_TTL_MS).toISOString()
      void ctx.meta.pruneStaleOAuthClients(cutoff).catch(() => 0)
    }
  })

  // Better Auth owns /api/auth/* (sign-up/in/out, OAuth, OIDC/SSO, session).
  if (deps.auth) {
    const auth = deps.auth
    // Self-heal a stale client_id on /authorize instead of dead-ending the human on
    // the oauth-provider's bare "invalid_client / client_id is required" error page
    // (that message fires both when client_id is missing AND when it's present but
    // unresolvable — see getClient in the plugin). The common cause: an agent
    // (Claude.ai, another MCP client) self-registered via DCR but its human didn't
    // finish the browser consent before pruneStaleOAuthClients reaped the row — the
    // agent has no way to know its client_id died and just keeps sending it, and
    // nothing the human does in the connector UI fixes it without knowing to
    // disconnect/reconnect. Any other cause of a missing row (a wiped local DB,
    // manual cleanup) hits the same recovery path. When the client_id on an
    // /authorize request doesn't resolve, silently register a fresh public client
    // for the same redirect_uri/scope and continue the flow under the new id — the
    // human only ever sees the consent screen, never the error.
    app.use("/api/auth/oauth2/authorize", async (c, next) => {
      const url = new URL(c.req.url)
      const clientId = url.searchParams.get("client_id")
      const redirectUri = url.searchParams.get("redirect_uri")
      const responseType = url.searchParams.get("response_type")
      const needsHealing =
        clientId &&
        redirectUri &&
        responseType === "code" &&
        !(await ctx.meta.oauthClientExists(clientId))
      if (needsHealing) {
        try {
          const registered = await auth.api.registerOAuthClient({
            body: {
              redirect_uris: [redirectUri],
              scope: url.searchParams.get("scope") ?? undefined,
              client_name: "recovered-client",
              token_endpoint_auth_method: "none",
            },
          })
          url.searchParams.set("client_id", registered.client_id)
          return c.redirect(url.toString(), 302)
        } catch (err) {
          log.error("oauth self-heal: re-registration failed", {
            error: err instanceof Error ? err.message : String(err),
          })
          // Fall through: the normal authorize handler errors as before.
        }
      }
      await next()
    })
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  }

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
    /^\/v1\/beta\/signup$/, // marketing-site beta signup — anonymous is the point; IP-capped
    /^\/v1\/sync\/github\/webhook$/, // GitHub App webhook — HMAC signature is the gate
    /^\/v1\/slack\/events$/, // Slack Events API — signing-secret signature is the gate
    /^\/v1\/slack\/interactivity$/, // Slack Block Kit actions — signing-secret signature is the gate
    /^\/v1\/slack\/commands$/, // Slack slash command (/derive) — signing-secret signature is the gate
    /^\/v1\/assets\/t\/[^/]+$/, // MCP-minted upload URL — the signed expiring token is the gate
    /^\/v1\/artifacts\/t\/[^/]+$/, // MCP-minted publish URL (create) — signed token is the gate
    /^\/v1\/artifacts\/[^/]+\/versions\/t\/[^/]+$/, // MCP-minted publish URL (revise) — signed token is the gate
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
    assetRoutes,
    blobRoutes,
    sharingRoutes,
    favoriteRoutes,
    followRoutes,
    collectionRoutes,
    folderRoutes,
    syncRoutes,
    slackRoutes,
    vitalsRoutes,
    moderationRoutes,
    proposalRoutes,
    reviewRoutes,
    livingRoutes,
    conciergeRoutes,
    reworkRoutes,
    commentRoutes,
    contextRoutes,
    realtimeRoutes,
    analyticsRoutes,
    notificationRoutes,
    webhookRoutes,
    rawRoutes,
    embedRoutes,
    domainRoutes,
    workspaceDomainRoutes,
    oauthRoutes,
    githubAppRoutes,
    systemRoutes,
    betaRoutes,
    marketingRoutes,
  ])
    app.route("/", routes(ctx))

  // The OpenAPI description of the contract-first routes, served for agents and used to
  // generate the web client's response types (apps/web/src/api-types.ts). Only routers
  // that adopt createRoute() appear here; the set grows as more migrate. Public + static
  // (no auth, no per-request state), so it sits outside the /v1 context middleware above.
  // Snapshot-locked at apps/api/openapi.json — a shape change fails the openapi test.
  app.doc("/openapi.json", {
    openapi: "3.0.3",
    info: {
      title: "Derive API",
      version: "1.0.0",
      description:
        "Derive's HTTP API. Every response shape here is the single source of truth for the " +
        "web client — generated from the same Zod schemas that back this reference, so the docs " +
        "never drift from the running API.\n\n" +
        "**Auth:** a session cookie (browser) or a bearer token (agents and the CLI). Most write " +
        "routes are scoped to the caller's active workspace. The `/v1` paths are the stable " +
        "product surface; `/openapi.json` serves this spec and `/docs` renders it.",
    },
    // Section order + descriptions for the reference sidebar (Scalar renders tags in
    // this order; a tag used by a route but absent here still appears, unsorted).
    tags: [
      {
        name: "Artifacts",
        description:
          "Documents (files and bundles): browse, publish, version, restore, and control access.",
      },
      {
        name: "Comments",
        description: "Threaded, anchored comments with reactions, edits, and resolution.",
      },
      {
        name: "Proposals",
        description:
          "Suggested revisions awaiting review — the propose → approve / request-changes flow.",
      },
      {
        name: "Review",
        description: "Review rounds on an artifact: request a review, send it back, or approve.",
      },
      {
        name: "Collections",
        description: "Shareable groups of artifacts, each with its own members.",
      },
      {
        name: "Sharing",
        description:
          "Per-artifact collaborator roles (shares) layered over the workspace baseline.",
      },
      {
        name: "Contexts",
        description:
          "Askable agent setups: wire an agent to a manifest, then open Q&A sessions against it.",
      },
      {
        name: "Agents",
        description:
          "Registered agents (bearer tokens) and the OAuth agents a user has authorized.",
      },
      { name: "Assets", description: "Standalone binary image assets referenced from bundles." },
      { name: "Favorites", description: "The caller's favorited artifacts." },
      { name: "Follows", description: "Follow people and repo paths to build the activity feed." },
      { name: "Notifications", description: "The caller's in-app notification feed." },
      {
        name: "Session",
        description: "Identity: the signed-in user, public profiles, and the people directory.",
      },
      {
        name: "Workspace",
        description: "The workspace itself: members, settings, invitations, and switching.",
      },
      { name: "Domains", description: "Custom domains and vanity subdomains bound to artifacts." },
      {
        name: "Sync",
        description: "GitHub repository mirroring: connect a repo and keep its docs in sync.",
      },
      { name: "Slack", description: "Slack connection status and integration toggles." },
      { name: "Webhooks", description: "Outgoing webhooks and their delivery log." },
      {
        name: "OAuth",
        description: "OAuth 2.1 authorization-server endpoints and sign-in capabilities.",
      },
      { name: "Realtime", description: "Live presence and cursor sharing on an artifact." },
      { name: "Analytics", description: "Aggregate view statistics for an artifact." },
      { name: "Moderation", description: "Abuse reports and takedown / reinstate actions." },
      { name: "Vitals", description: "Client-reported web-vitals ingestion." },
    ],
  })

  // Interactive API reference (Scalar) rendered from the spec above. Public +
  // static like /openapi.json — a viewer for the already-public contract, no new
  // exposure and no per-request state, so it also sits outside the /v1 auth context.
  app.get("/docs", Scalar({ url: "/openapi.json" }))

  // The remote MCP endpoint — Streamable HTTP, bearer-gated by the agent bridge.
  mountMcp(app, ctx)

  return app
}
