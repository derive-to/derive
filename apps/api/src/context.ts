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
import type { Auth } from "./auth-config"
import { createBus, Presence } from "./bus"
import { safeEqual, sha256 } from "./lib/crypto"
import { WS_COOKIE } from "./lib/http"
import { makeKeyedLimiter } from "./lib/rate-limit"
import { log } from "./log"
import { enqueueForEvent, type WebhookEvent } from "./webhooks"

export interface SessionUser {
  id: string
  email: string
  name: string | null
}

export interface AppDeps {
  meta: MetaStore
  blobs: BlobStore
  baseUrl: string
  /** A static token (CI/agents) authorizes writes + gated reads, alongside a login session. */
  token?: string
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
   * Enable multiple workspaces: users can create/switch workspaces and each is
   * scoped by org_id. Off by default (self-host is single-workspace); the hosted
   * product turns it on. Single mode behaves exactly as before, just keyed by a
   * real `defaultOrgId` instead of a magic constant.
   */
  multiWorkspace?: boolean
  /**
   * The org_id of the single/bootstrap workspace. A real, persisted id (never a
   * magic literal) so flipping on multiWorkspace later is a no-op for the data.
   * Defaults to "default" when unset (tests); the Node entry generates + persists
   * one and rekeys any legacy rows onto it.
   */
  defaultOrgId?: string
  /** In-memory per-IP rate limiting on auth + mutating routes. Off by default. */
  rateLimit?: boolean
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
   * A separate origin that serves artifact bytes (`/raw/*`), keeping user HTML
   * off the app's cookie origin — the real isolation wall (CSP sandbox is
   * defense-in-depth). When set, the app origin redirects `/raw/*` here, and
   * this origin serves ONLY raw bytes (never auth, the API, or the app). Use a
   * different registrable domain so session cookies can never reach it. Unset =
   * single-origin self-host, where the iframe `sandbox` attribute is the wall.
   */
  sandboxOrigin?: string
  /**
   * The SPA and API are on different sites (hosted split). Makes first-party
   * cookies we set here — currently the anonymous-viewer id — `SameSite=None;
   * Secure` so they survive the cross-site request, matching the session cookie.
   */
  crossSite?: boolean
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
  const bus = createBus()
  const presence = new Presence()

  const analyticsOn = deps.analytics !== false
  const versionWindowMs = deps.versionWindowMs ?? DEFAULT_VERSION_WINDOW_MS
  const allowOrigins = new Set(deps.webOrigins ?? [])
  const open = !deps.token
  const defaultRole: Role = deps.defaultRole ?? "editor"
  const multi = !!deps.multiWorkspace
  // The single/bootstrap workspace id — always a real value, never a magic
  // literal. The Node entry generates + persists one; tests fall back to this.
  const defaultOrg = deps.defaultOrgId ?? "default"

  // Per-actor limiters on the two flood-prone actions, identity-keyed so one
  // account can't drown the workspace even from many IPs. Active only when
  // rate limiting is on; the IP middleware is the per-origin backstop.
  const publishLimiter = deps.rateLimit ? makeKeyedLimiter(60_000, deps.publishRate ?? 30) : null
  const commentLimiter = deps.rateLimit ? makeKeyedLimiter(60_000, deps.commentRate ?? 60) : null

  // Fan an event to subscribed webhooks (enqueues to the outbox; the worker
  // delivers). Awaited so the row is durable before we respond, but never fatal.
  const notify = (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) =>
    enqueueForEvent(meta, deps.baseUrl, a, event, data).catch((err) =>
      // Non-fatal (the request still succeeds), but a dropped enqueue means the
      // webhook silently never fires — log it rather than swallow.
      log.error("webhook enqueue failed", {
        event,
        artifact: a.short_id,
        error: err instanceof Error ? err.message : String(err),
      }),
    )

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
    const u = s?.user ? { id: s.user.id, email: s.user.email, name: s.user.name ?? null } : null
    userCache.set(c, u)
    return u
  }

  // A registered agent acting via its bearer token (memoized per request). An
  // agent is a workspace principal: same authorization path as a member, with
  // its own identity and (default commenter) role.
  const agentCache = new WeakMap<Context, AgentRecord | null>()
  const agentFor = async (c: Context): Promise<AgentRecord | null> => {
    if (agentCache.has(c)) return agentCache.get(c) ?? null
    const b = bearer(c)
    // Tokens are stored hashed; look up by the hash of the presented bearer.
    const a =
      !b || (deps.token && safeEqual(b, deps.token)) ? null : await meta.getAgentByToken(sha256(b))
    agentCache.set(c, a)
    return a
  }

  // The acting identity (agent or signed-in user) for authorship; null when
  // anonymous. Agents author as their name, never spoofing a person.
  const actingUser = async (c: Context): Promise<{ id: string; name: string } | null> => {
    const ag = await agentFor(c)
    if (ag) return { id: ag.id, name: ag.name }
    const me = await currentUser(c)
    return me ? { id: me.id, name: me.name ?? me.email } : null
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
  const limited = async (
    c: Context,
    limiter: ReturnType<typeof makeKeyedLimiter> | null,
  ): Promise<Response | null> => {
    if (!limiter) return null
    const r = limiter(await actorKey(c))
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
  const provisionPersonal = async (me: SessionUser): Promise<string> => {
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
    if (!multi) return defaultOrg
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
        ws = mine.length ? mine[0].id : await provisionPersonal(me)
      }
    }
    wsCache.set(c, ws)
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

  const actorFor = async (c: Context, a: ArtifactRecord): Promise<Actor> => {
    if (deps.token && safeEqual(bearer(c), deps.token)) return { kind: "token" }
    const ag = await agentFor(c)
    if (ag) {
      const am = await meta.getArtifactMember(a.id, ag.id)
      return { kind: "user", userId: ag.id, artifactRole: am?.role ?? null, orgRole: ag.role, open }
    }
    const me = await currentUser(c)
    if (!me) return { kind: "anon", open }
    // Baseline role = membership in the ARTIFACT's workspace. Single mode keeps
    // its first-user-owner auto-join; multi mode never auto-joins you into
    // someone else's workspace just because you opened a shared link.
    const orgRole = multi
      ? ((await meta.getMembership(a.org_id, me.id))?.role ?? null)
      : await ensureMembership(a.org_id, me.id)
    const am = await meta.getArtifactMember(a.id, me.id)
    // A collection share grants its role on every artifact in the collection,
    // folded in alongside any per-artifact share (the higher wins).
    const cRoles = await meta.collectionRolesForArtifact(a.id, me.id)
    const artifactRole = maxRole(am?.role ?? null, ...cRoles)
    return { kind: "user", userId: me.id, artifactRole, orgRole, open }
  }

  /** Authorize an action against a specific artifact. */
  const authorize = (c: Context, action: Action, a: ArtifactRecord): Promise<boolean> =>
    actorFor(c, a).then((actor) => can(actor, action, a.visibility))

  /** The caller's role in their active workspace (creating artifacts, settings). */
  const workspaceRole = async (c: Context): Promise<Role | null> => {
    if (deps.token && safeEqual(bearer(c), deps.token)) return "owner"
    const ag = await agentFor(c)
    if (ag) return ag.role
    const me = await currentUser(c)
    if (!me) return open ? "owner" : null
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
      data = await blobs.get(manifest.files[manifest.entry].key)
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
    analyticsOn,
    versionWindowMs,
    allowOrigins,
    open,
    multi,
    defaultOrg,
    defaultRole,
    publishLimiter,
    commentLimiter,
    notify,
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
    actorFor,
    authorize,
    workspaceRole,
    workspaceCan,
    sourceText,
  }
}
