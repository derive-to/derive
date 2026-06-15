import {
  type Action,
  type Actor,
  type AgentRecord,
  type ArtifactRecord,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  can,
  DEFAULT_VERSION_WINDOW_MS,
  type MetaStore,
  maxRole,
  newId,
  type Role,
  roleAllows,
} from "@dock/core"
import type { Context } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { createLocalJWKSet, type JWTPayload, jwtVerify } from "jose"
import type { Auth } from "./auth-config"
import { type Backplane, createInProcessBackplane } from "./bus"
import type { CustomDomainProvider } from "./lib/cloudflare-saas"
import { safeEqual, sha256, unlockCookie, unlockToken } from "./lib/crypto"
import { VIEWER_COOKIE, WS_COOKIE } from "./lib/http"
import { inMemoryRateLimiters, type Limiter, type RateLimiters } from "./lib/rate-limit"
import { log } from "./log"
import { edgeCtx } from "./realtime-do"
import { enqueueForEvent, type WebhookEvent } from "./webhooks"

export interface SessionUser {
  id: string
  email: string
  name: string | null
  /** Public handle (Profiles & Accounts v1); null until claimed at onboarding. */
  username: string | null
  /** Opt-in: findable in people search when true. Off by default. */
  discoverable: boolean
}

export interface AppDeps {
  meta: MetaStore
  blobs: BlobStore
  /** Realtime relay + presence. In-process when unset (self-host); the Cloudflare
   *  edge entry injects a Durable Object backplane. */
  backplane?: Backplane
  baseUrl: string
  /** A static token (CI/agents) authorizes writes + gated reads, alongside a login session. */
  token?: string
  /** Passphrase for encrypting stored third-party secrets at rest (GitHub PATs).
   *  The Node + Worker entries pass the auth secret. Unset (e.g. tests) ⇒ tokens
   *  are stored as-is; set ⇒ AES-256-GCM encrypted (see lib/crypto encryptSecret). */
  encryptionKey?: string
  /** Operator (instance super-admin) emails: global moderation powers, on top of `token`. */
  superAdmins?: string[]
  /** Better Auth instance — mounts /api/auth/* and provides the session. */
  auth?: Auth
  /**
   * Web origins allowed to make credentialed (cookie) calls to /api + /v1.
   * Needed only for the hosted split where the SPA (CDN) and API (container)
   * are on different origins; empty for same-origin self-host or dev proxy.
   */
  webOrigins?: string[]
  /** Record + serve view analytics. Default on; set false to disable entirely. */
  analytics?: boolean
  /** Revisions within this window (ms) collapse into one displayed version. */
  versionWindowMs?: number
  /** Workspace role granted to a member who isn't the first user. Default "editor". */
  defaultRole?: Role
  /**
   * The org_id of the bootstrap workspace: the fallback for anonymous requests.
   * Every signed-in user gets their own personal workspace on first login. A
   * real, persisted id, never a magic literal.
   * Defaults to "default" when unset (tests); the Node entry generates + persists
   * one and rekeys any legacy rows onto it.
   */
  defaultOrgId?: string
  /** Per-IP / per-actor rate limiting on auth + mutating routes. Off by default. */
  rateLimit?: boolean
  /**
   * The rate limiters to enforce. Omit for the in-process default (authoritative on a
   * single container — Node / self-host — and used by tests). The edge entry supplies a
   * set backed by Cloudflare's native per-colo limiter (see worker.ts).
   */
  rateLimiters?: RateLimiters
  /**
   * Per-workspace storage backstops (abuse gate). Both default to unlimited so
   * self-host stays open; the hosted tier sets them. maxArtifacts caps how many
   * artifacts a workspace can create; maxBytes caps the summed byte size of all
   * stored versions. Exceeding maxArtifacts → 409, maxBytes → 413.
   */
  maxArtifacts?: number
  maxBytes?: number
  /**
   * Per-actor (signed-in user or agent, falling back to IP) write rate limits,
   * in actions per minute. Applied only when rateLimit is on; identity-keyed so
   * one noisy account can't drown the workspace. Default: 30 publishes/min,
   * 60 comments/min.
   */
  publishRate?: number
  commentRate?: number
  /**
   * The web SPA is served from this same process (single-container self-host).
   * When true, the bare `/` placeholder is dropped so the bundled SPA's index
   * owns the app shell; the Node entry wires the static + fallback middleware.
   */
  serveWeb?: boolean
  /**
   * The SPA shell HTML (index.html), when this process serves the bundled web app.
   * Lets the server-rendered `/a/:ref` route return the shell with per-artifact
   * unfurl meta injected, so crawlers (which don't run JS) get OG/Twitter cards.
   * Unset = no injection (API-only, or the edge Worker where assets serve `/a/*`).
   */
  shell?: string
  /**
   * Async shell provider for runtimes that can't read the SPA shell synchronously:
   * the edge Worker fetches `index.html` from its static-assets binding. Used to
   * inject unfurl meta into `/a/:ref` when `shell` (the sync string) isn't set.
   * Returns null if the shell can't be read (the route then serves it untouched).
   */
  shellFetch?: () => Promise<string | null>
  /**
   * gzip the responses. On for the Node/Fly entry (Fly's proxy gives HTTP/2 but
   * doesn't compress); left off for the Cloudflare Worker entry, where the edge
   * already compresses (gzip/brotli) and doubling it up wastes CPU.
   */
  compress?: boolean
  /**
   * A separate origin that serves artifact bytes (`/raw/*`), keeping user HTML
   * off the app's cookie origin — the real isolation wall (CSP sandbox is
   * defense-in-depth). When set, the app origin redirects `/raw/*` here, and
   * this origin serves ONLY raw bytes (never auth, the API, or the app). Use a
   * different registrable domain so session cookies can never reach it. Unset =
   * single-origin self-host, where the iframe `sandbox` attribute is the wall.
   */
  sandboxOrigin?: string
  /**
   * Base domain for vanity subdomains (e.g. "dockd.app"). When set, a request to
   * `<label>.<base>` whose host is in the `domain` table serves that artifact at
   * the host root (domain mode). Unset = subdomain serving off.
   */
  subdomainBase?: string
  /**
   * Bring-your-own custom domains (hosted tier). When set, an owner can attach their
   * own hostname to an artifact and Cloudflare for SaaS issues + renews the TLS cert.
   * Unset = custom domains disabled (those endpoints 501). Subdomains work without it.
   */
  customDomains?: CustomDomainProvider
  /**
   * The SPA and API are on different sites (hosted split). Makes first-party
   * cookies we set here — currently the anonymous-viewer id — `SameSite=None;
   * Secure` so they survive the cross-site request, matching the session cookie.
   */
  crossSite?: boolean
  /**
   * Wake the webhook outbox drainer right after an event is enqueued, so delivery is
   * near-instant instead of waiting for the next poll/alarm. Node wires it to the
   * in-process worker's `poke`; the edge entry wires it to the `WebhookOutbox` DO.
   * Unset (e.g. tests) = no poke; the interval/cron backstop still drains the outbox.
   */
  pokeWebhooks?: () => void
}

/**
 * The shared request-handling context: every helper and singleton a route module
 * needs, built once per app. Route factories destructure what they use from this;
 * route-specific helpers stay in their own module. `AppContext` is inferred from
 * what `buildContext` returns, so the two never drift.
 */
export type AppContext = ReturnType<typeof buildContext>

export function buildContext(deps: AppDeps) {
  const { meta, blobs } = deps
  // Realtime relay + presence. In-process by default (self-host stays zero-config);
  // the edge entry injects a Durable Object backplane. `bus`/`presence` are facades
  // over it, so the publish + heartbeat call sites are unchanged.
  const backplane = deps.backplane ?? createInProcessBackplane()
  const bus = backplane
  const presence = backplane.presence

  const analyticsOn = deps.analytics !== false
  const versionWindowMs = deps.versionWindowMs ?? DEFAULT_VERSION_WINDOW_MS
  const allowOrigins = new Set(deps.webOrigins ?? [])
  const defaultRole: Role = deps.defaultRole ?? "editor"
  // The bootstrap workspace id — always a real value, never a magic
  // literal. The Node entry generates + persists one; tests fall back to this.
  const defaultOrg = deps.defaultOrgId ?? "default"

  // Per-actor limiters on the flood-prone actions, identity-keyed so one account can't
  // drown the workspace even from many IPs. Active only when rate limiting is on; the IP
  // middleware (app.ts) is the per-origin backstop. The same limiter set backs both call
  // sites — app.ts resolves it once and passes it in, so it's a single source of truth.
  // Password unlock is a credential-guessing surface and gets a much tighter cap (5 / 5
  // min in-process; the edge's native binding caps it to a 60s window — see worker.ts).
  const limiters = deps.rateLimiters ?? inMemoryRateLimiters(deps)
  const publishLimiter = deps.rateLimit ? limiters.publish : null
  const commentLimiter = deps.rateLimit ? limiters.comment : null
  const unlockLimiter = deps.rateLimit ? limiters.unlock : null

  // Fan an event to subscribed webhooks (enqueues to the outbox; the drainer
  // delivers). Awaited so the row is durable before we respond, but never fatal.
  // When something was enqueued, poke the drainer so it goes out now instead of on
  // the next interval/alarm tick.
  const notify = (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) =>
    enqueueForEvent(meta, deps.baseUrl, a, event, data)
      .then((queued) => {
        if (queued > 0) deps.pokeWebhooks?.()
      })
      .catch((err) =>
        // Non-fatal (the request still succeeds), but a dropped enqueue means the
        // webhook silently never fires — log it rather than swallow.
        log.error("webhook enqueue failed", {
          event,
          artifact: a.short_id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )

  // Run after-the-response work without blocking the reply. On Workers the request
  // executionCtx keeps the isolate alive past the sent response via waitUntil; on
  // Node (and tests) there is no such context, so we await inline — local DBs are
  // fast and tests need the work finished before they assert. Used to keep slow,
  // best-effort fan-out (webhook enqueue, mention notifications) off the hot path.
  const background = async (work: Promise<unknown>): Promise<void> => {
    const guarded = Promise.resolve(work).catch((err) =>
      log.error("background task failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    const ec = edgeCtx.getStore()
    if (ec) ec.waitUntil(guarded)
    else await guarded
  }

  const bearer = (c: Context): string => {
    const h = c.req.header("authorization") ?? ""
    return h.startsWith("Bearer ") ? h.slice(7) : ""
  }

  // The signed-in user for this request, memoized like agentFor below: several
  // handlers (actingUser, activeWorkspace, the route itself) resolve the caller
  // more than once, and the session lookup shouldn't run again each time.
  const userCache = new WeakMap<Context, SessionUser | null>()
  const currentUser = async (c: Context): Promise<SessionUser | null> => {
    if (userCache.has(c)) return userCache.get(c) ?? null
    const s = deps.auth ? await deps.auth.api.getSession({ headers: c.req.raw.headers }) : null
    // `username`/`discoverable` ride the session via Better Auth additionalFields
    // (see auth-config.ts); read them through a narrow cast (optional extras).
    const su = s?.user as
      | {
          id: string
          email: string
          name?: string | null
          username?: string | null
          discoverable?: boolean | number | null
        }
      | undefined
    const u: SessionUser | null = su
      ? {
          id: su.id,
          email: su.email,
          name: su.name ?? null,
          username: su.username ?? null,
          // Discoverable unless explicitly opted out (on by default; unset = on).
          discoverable: su.discoverable !== false,
        }
      : null
    userCache.set(c, u)
    if (u) c.set("actorId", u.id) // tag the access log with the resolved actor
    return u
  }

  // Instance super-admins: the people who run + host the deployment. The static
  // DOCK_TOKEN (automation) or any signed-in user whose email is in the operator
  // allow-list. Super-admins get global moderation (cross-workspace takedown +
  // the global reports/audit queue); a workspace Admin stays scoped to their own.
  const superAdminEmails = new Set((deps.superAdmins ?? []).map((e) => e.toLowerCase()))
  const isSuperAdmin = async (c: Context): Promise<boolean> => {
    if (deps.token && safeEqual(bearer(c), deps.token)) return true
    if (superAdminEmails.size === 0) return false
    const me = await currentUser(c)
    return !!me && superAdminEmails.has(me.email.toLowerCase())
  }

  // A registered agent acting via its bearer token (memoized per request). An
  // agent is a workspace principal: same authorization path as a member, with
  // its own identity and (default commenter) role.
  // The least-privilege role an OAuth-granted scope set maps to: publish/review
  // earn editor; propose/comment earn commenter; read alone is viewer.
  const roleFromScopes = (scopes: string[]): Role =>
    scopes.includes("dock:publish") || scopes.includes("dock:review")
      ? "editor"
      : scopes.includes("dock:propose") || scopes.includes("dock:comment")
        ? "commenter"
        : "viewer"

  const agentCache = new WeakMap<Context, AgentRecord | null>()
  const agentFor = async (c: Context): Promise<AgentRecord | null> => {
    if (agentCache.has(c)) return agentCache.get(c) ?? null
    const b = bearer(c)
    let a: AgentRecord | null = null
    if (b && !(deps.token && safeEqual(b, deps.token))) {
      // Either a registered agent token (stored hashed), or an OAuth access token
      // minted by the browser consent flow, resolved to a scoped agent.
      a = (await meta.getAgentByToken(sha256(b))) ?? (await oauthAgent(b))
    }
    agentCache.set(c, a)
    if (a) c.set("actorId", a.id)
    return a
  }

  // The agent runs in the granting user's workspace, provisioned on first touch
  // exactly as the user's own first request would (multi mode, lazy).
  const oauthWorkspace = async (
    userId: string,
    email: string | null,
    name: string | null,
  ): Promise<string> => {
    const mine = await meta.listWorkspaces(userId)
    return mine[0]?.id ?? (await provisionPersonal({ id: userId, email: email ?? "", name }))
  }

  // Our own JWKS (served by the jwt plugin at /api/auth/jwks), read straight from
  // Better Auth's store on this instance — NOT an HTTP self-fetch, which a
  // Cloudflare Worker can't do against its own hostname. The local key set is
  // cached per isolate, rebuilt on a verify miss (a rotated signing key).
  const oauthIssuer = new URL("/api/auth", deps.baseUrl).toString()
  let jwksCache: ReturnType<typeof createLocalJWKSet> | null = null
  const loadJwks = async () => {
    const res = (await deps.auth?.api.getJwks()) as
      | Parameters<typeof createLocalJWKSet>[0]
      | undefined
    return res?.keys?.length ? createLocalJWKSet(res) : null
  }

  // An OAuth access token (granted via the consent screen) acts as a scoped agent:
  // it runs in the granting user's workspace, authors as the client's name, and
  // takes a role derived from the granted dock:* scopes. Expired/invalid tokens
  // resolve to nothing — the caller is then anonymous (read-only), never the owner.
  const oauthAgent = async (token: string): Promise<AgentRecord | null> => {
    // 1. Opaque access token (the `dock login` flow): stored hashed (sha256, like
    //    agent tokens), so resolve by the hash of the presented bearer.
    const grant = await meta.getOAuthGrant(sha256(token))
    if (grant) {
      if (grant.expiresAt.getTime() <= Date.now()) return null
      const org = await oauthWorkspace(grant.userId, grant.userEmail, grant.userName)
      return {
        id: `oauth:${grant.clientId}`,
        org_id: org,
        name: grant.clientName,
        token: "",
        role: roleFromScopes(grant.scopes),
        created_at: new Date().toISOString(),
      }
    }
    // 2. JWT access token: the oauth-provider issues a signed JWT (not stored in our
    //    table) when a client sends an RFC 8707 `resource` indicator — which every
    //    remote MCP client (Claude Code, claude.ai) does. Verify it against our own
    //    JWKS and resolve the agent from its claims.
    if (token.split(".").length === 3) return oauthAgentFromJwt(token)
    return null
  }

  const oauthAgentFromJwt = async (token: string): Promise<AgentRecord | null> => {
    const verify = async (): Promise<JWTPayload | null> => {
      jwksCache ??= await loadJwks()
      if (!jwksCache) return null
      return (await jwtVerify(token, jwksCache, { issuer: oauthIssuer })).payload
    }
    let claims: JWTPayload | null
    try {
      claims = await verify()
    } catch {
      // Bad signature/issuer/expiry — or a rotated key the cache misses. Rebuild
      // the key set once and retry before giving up.
      jwksCache = null
      try {
        claims = await verify()
      } catch {
        return null
      }
    }
    if (!claims) return null
    const userId = typeof claims.sub === "string" ? claims.sub : ""
    if (!userId) return null
    const scopes = String(claims.scope ?? "")
      .split(/\s+/)
      .filter(Boolean)
    const clientId = String(claims.azp ?? claims.client_id ?? "")
    const u = (await meta.getUsers([userId]))[0]
    const org = await oauthWorkspace(userId, u?.email ?? null, u?.name ?? null)
    return {
      id: `oauth:${clientId}`,
      org_id: org,
      name: (await meta.getOAuthClientName(clientId)) || clientId || "An agent",
      token: "",
      role: roleFromScopes(scopes),
      created_at: new Date().toISOString(),
    }
  }

  // The acting identity (agent or signed-in user) for authorship; null when
  // anonymous. Agents author as their name, never spoofing a person.
  const actingUser = async (c: Context): Promise<{ id: string; name: string } | null> => {
    const ag = await agentFor(c)
    if (ag) return { id: ag.id, name: ag.name }
    const me = await currentUser(c)
    // Display identity feeds the comment/version author byline shown to others, so
    // fall back to the public handle, never the email (the email→handle migration).
    // Every account has a username post-migration; email is only a last-ditch guard.
    return me ? { id: me.id, name: me.name ?? me.username ?? me.email } : null
  }

  const ipOf = (c: Context): string =>
    (c.req.header("x-forwarded-for")?.split(",")[0] ?? c.req.header("x-real-ip") ?? "global").trim()
  // A stable rate-limit key for the caller: the signed-in user / agent if known,
  // otherwise their IP so anonymous floods are still bounded.
  const actorKey = async (c: Context): Promise<string> => {
    const a = await actingUser(c)
    return a ? `id:${a.id}` : `ip:${ipOf(c)}`
  }

  // Apply a keyed limiter to the caller; returns a 429 Response when over, else
  // null to continue. Helper because publish + propose + comment share it.
  const limited = async (c: Context, limiter: Limiter | null): Promise<Response | null> => {
    if (!limiter) return null
    const r = await limiter(await actorKey(c))
    if (r.ok) return null
    c.header("Retry-After", String(r.retryAfter))
    return c.json({ error: "rate limit exceeded" }, 429)
  }
  // Would storing `incoming` more bytes push THIS workspace over its storage cap?
  const overStorage = async (orgId: string, incoming: number): Promise<boolean> =>
    !!deps.maxBytes && (await meta.storageBytes(orgId)) + incoming > deps.maxBytes

  // Lazy provisioning: the first member of a workspace is its owner; everyone
  // else joins at the default role. Returns the caller's role in that workspace.
  const ensureMembership = async (orgId: string, userId: string): Promise<Role> => {
    const existing = await meta.getMembership(orgId, userId)
    if (existing) return existing.role
    const role: Role = (await meta.countMemberships(orgId)) === 0 ? "owner" : defaultRole
    await meta.setMembership({ id: newId("m"), org_id: orgId, user_id: userId, role })
    return role
  }

  // A signed-in user's own workspace, created on demand (multi mode, first login).
  const provisionPersonal = async (me: {
    id: string
    email: string
    name: string | null
  }): Promise<string> => {
    const id = newId("ws")
    const base = (me.name ?? me.email).split("@")[0] || "My"
    await meta.setWorkspace(id, `${base}'s Workspace`)
    await meta.setMembership({ id: newId("m"), org_id: id, user_id: me.id, role: "owner" })
    return id
  }

  // The caller's active workspace for this request (memoized). Single mode: always
  // the bootstrap org. Multi mode: the dock_ws cookie (validated against
  // membership), else the user's first workspace, provisioning one if they have none.
  const wsCache = new WeakMap<Context, string>()
  const activeWorkspace = async (c: Context): Promise<string> => {
    const cached = wsCache.get(c)
    if (cached) return cached
    // An agent acts within its own workspace, never a cookie's.
    const ag = await agentFor(c)
    const me = ag ? null : await currentUser(c)
    let ws: string
    if (ag) {
      ws = ag.org_id
    } else if (!me) {
      ws = getCookie(c, WS_COOKIE) || defaultOrg
    } else {
      const ck = getCookie(c, WS_COOKIE)
      if (ck && (await meta.getMembership(ck, me.id))) ws = ck
      else {
        const mine = await meta.listWorkspaces(me.id)
        ws = mine[0]?.id ?? (await provisionPersonal(me))
      }
    }
    wsCache.set(c, ws)
    c.set("orgId", ws)
    return ws
  }
  // Persist the active-workspace choice. Same cross-site handling as the viewer
  // cookie so it survives the hosted SPA↔API split.
  const setWsCookie = (c: Context, id: string): void =>
    setCookie(c, WS_COOKIE, id, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      httpOnly: true,
      sameSite: deps.crossSite ? "None" : "Lax",
      secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
    })

  // A stable id for an anonymous viewer, kept in a long-lived first-party cookie
  // so the same browser counts as one viewer across opens (unique-view counts +
  // a stable presence handle). Minted on first sight. Same SameSite/secure rules
  // as the workspace cookie so it survives the hosted cross-site split.
  const anonViewerId = (c: Context): string => {
    let vid = getCookie(c, VIEWER_COOKIE)
    if (!vid) {
      vid = newId("anon")
      setCookie(c, VIEWER_COOKIE, vid, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        httpOnly: true,
        sameSite: deps.crossSite ? "None" : "Lax",
        secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
      })
    }
    return vid
  }

  const actorFor = async (c: Context, a: ArtifactRecord): Promise<Actor> => {
    // For a `password` artifact, has this visitor entered the password? The unlock
    // cookie's value is derived from the server-only hash, so it can't be forged.
    const unlocked =
      a.visibility === "password" &&
      !!a.password_hash &&
      safeEqual(getCookie(c, unlockCookie(a.short_id)) ?? "", unlockToken(a.id, a.password_hash))
    if (deps.token && safeEqual(bearer(c), deps.token)) return { kind: "token" }
    const ag = await agentFor(c)
    if (ag) {
      const am = await meta.getArtifactMember(a.id, ag.id)
      // An agent (registered token or OAuth-consent grant) carries its role ONLY
      // within its OWN workspace, never onto an artifact owned by another one — it
      // can resolve any artifact by its global short_id, so binding here is the
      // gate. Mirrors the human branch below: orgRole is scoped to the ARTIFACT's
      // workspace; on a foreign artifact it drops to the visibility floor while its
      // own per-artifact shares (artifactRole) still apply. Without this an agent's
      // home-workspace editor role would let it publish/share/mutate anything.
      const orgRole = ag.org_id === a.org_id ? ag.role : null
      return { kind: "user", userId: ag.id, artifactRole: am?.role ?? null, orgRole }
    }
    const me = await currentUser(c)
    if (!me) return { kind: "anon", unlocked }
    // Baseline role = membership in the ARTIFACT's workspace. Opening a shared
    // link never auto-joins you into someone else's workspace; you only carry an
    // org role where you're explicitly a member.
    const orgRole = (await meta.getMembership(a.org_id, me.id))?.role ?? null
    const am = await meta.getArtifactMember(a.id, me.id)
    // A collection share grants its role on every artifact in the collection,
    // folded in alongside any per-artifact share (the higher wins).
    const cRoles = await meta.collectionRolesForArtifact(a.id, me.id)
    const artifactRole = maxRole(am?.role ?? null, ...cRoles)
    return { kind: "user", userId: me.id, artifactRole, orgRole, unlocked }
  }

  /** Authorize an action against a specific artifact. */
  const authorize = (c: Context, action: Action, a: ArtifactRecord): Promise<boolean> =>
    actorFor(c, a).then((actor) => can(actor, action, a.visibility))

  /**
   * True when the caller is an anonymous visitor — they may view public content
   * but nothing collaborative (comments, member list, proposals, analytics).
   * Anonymous is never a trusted principal, so this is a simple kind check. Use
   * as a post-`read` gate to hide collaboration from public link-visitors without
   * touching the role model.
   */
  const anonLocked = async (c: Context, a: ArtifactRecord): Promise<boolean> => {
    const actor = await actorFor(c, a)
    return actor.kind === "anon"
  }

  /**
   * Is the caller an authenticated principal — a static token, a registered
   * agent, or a signed-in user — as opposed to an anonymous visitor? The single
   * source of truth for "not anonymous", used by the global anonymous-write
   * lockdown so a new mutating route can never accidentally be exposed to anon.
   */
  const isPrincipal = async (c: Context): Promise<boolean> => {
    if (deps.token && safeEqual(bearer(c), deps.token)) return true
    return !!(await actingUser(c))
  }

  /** The caller's role in their active workspace (creating artifacts, settings). */
  const workspaceRole = async (c: Context): Promise<Role | null> => {
    if (deps.token && safeEqual(bearer(c), deps.token)) return "owner"
    const ag = await agentFor(c)
    if (ag) return ag.role
    const me = await currentUser(c)
    if (!me) return null
    return ensureMembership(await activeWorkspace(c), me.id)
  }
  const workspaceCan = async (c: Context, action: Action): Promise<boolean> => {
    const r = await workspaceRole(c)
    return r !== null && roleAllows(r, action)
  }

  /**
   * Source text of stored content (entry document for bundles); null if missing.
   * Works for a version or a proposal — both carry blob_key + content_type.
   */
  const sourceText = async (content: {
    blob_key: string
    content_type: string
  }): Promise<string | null> => {
    let data: Uint8Array | null
    if (content.content_type === BUNDLE_CONTENT_TYPE) {
      const manifestBytes = await blobs.get(content.blob_key)
      if (!manifestBytes) return null
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest
      const entryFile = manifest.files[manifest.entry]
      if (!entryFile) return null
      data = await blobs.get(entryFile.key)
    } else {
      data = await blobs.get(content.blob_key)
    }
    return data ? new TextDecoder().decode(data) : null
  }

  return {
    deps,
    meta,
    blobs,
    bus,
    presence,
    backplane,
    analyticsOn,
    versionWindowMs,
    allowOrigins,
    defaultOrg,
    defaultRole,
    publishLimiter,
    commentLimiter,
    unlockLimiter,
    notify,
    background,
    bearer,
    currentUser,
    agentFor,
    actingUser,
    limited,
    overStorage,
    ensureMembership,
    provisionPersonal,
    activeWorkspace,
    setWsCookie,
    anonViewerId,
    actorFor,
    authorize,
    anonLocked,
    isPrincipal,
    isSuperAdmin,
    workspaceRole,
    workspaceCan,
    sourceText,
  }
}
