import { randomUUID } from "node:crypto"
import {
  type Action,
  type Actor,
  type AgentRecord,
  ANCHOR_CLIENT_JS,
  type ArtifactRecord,
  approveProposal,
  artifactUrl,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  type CollectionRecord,
  type CommentRecord,
  can,
  DEFAULT_VERSION_WINDOW_MS,
  diffLines,
  effectiveRole,
  formatDiff,
  groupSessions,
  isAnchored,
  isRole,
  type MetaStore,
  maxRole,
  mimeFor,
  newId,
  type ProposalRecord,
  PublishError,
  propose,
  publish,
  type Role,
  renderMarkdown,
  renderShell,
  roleAllows,
  SELECTION_SCRIPT,
  toJson,
  type Visibility,
} from "@dock/core"
import { type Context, Hono, type Next } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { streamSSE } from "hono/streaming"
import type { Auth } from "./auth-config"
import { createBus, Presence } from "./bus"
import { enqueueForEvent, WEBHOOK_EVENTS, type WebhookEvent } from "./webhooks"

/** The fixed reaction set; arbitrary emoji are rejected to keep data clean. */
const REACTIONS = ["👍", "❤️", "🎉", "😄", "👀", "🙏", "🚀", "👎"]

/** A resolved @mention captured by the composer: the picked user's id + display name. */
type Mention = { id: string; name: string }
type CommentMeta = {
  reactions?: Record<string, string[]>
  edited_at?: string
  deleted?: boolean
  mentions?: Mention[]
}
const parseMeta = (m: string | null): CommentMeta => {
  if (!m) return {}
  try {
    return JSON.parse(m) as CommentMeta
  } catch {
    return {}
  }
}

/** Coerce arbitrary input into a clean Mention[] (defensive against bad clients). */
function parseMentions(input: unknown): Mention[] {
  if (!Array.isArray(input)) return []
  const out: Mention[] = []
  const seen = new Set<string>()
  for (const m of input) {
    if (!m || typeof m !== "object") continue
    const id = (m as { id?: unknown }).id
    const name = (m as { name?: unknown }).name
    if (typeof id !== "string" || typeof name !== "string" || !id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

/** Wire shape for a comment: meta unpacked into clean fields; deleted bodies blanked. */
function commentJson(cm: CommentRecord, anchored?: boolean) {
  const { meta, ...rest } = cm
  const md = parseMeta(meta)
  const deleted = !!md.deleted
  return {
    ...rest,
    body_md: deleted ? "" : cm.body_md,
    reactions: md.reactions ?? {},
    edited: !!md.edited_at,
    edited_at: md.edited_at ?? null,
    deleted,
    mentions: deleted ? [] : (md.mentions ?? []),
    ...(anchored !== undefined ? { anchored } : {}),
  }
}

interface SessionUser {
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

const DEFAULT_WORKSPACE_NAME = "My Workspace"
/** Cookie holding the active workspace id (multi-workspace mode). */
const WS_COOKIE = "dock_ws"

// Workspace membership is three simple roles, presented to people as
// Admin / Creator / Viewer:
//   - owner     → Admin:   manage members + settings (and everything below)
//   - editor    → Creator: create + publish artifacts
//   - commenter → Viewer:  read + comment
// The canonical Role vocabulary is unchanged; a bare read-only "viewer" isn't
// offered as a workspace role (a Viewer can always comment).
const isWorkspaceRole = (v: unknown): v is Role =>
  v === "owner" || v === "editor" || v === "commenter"

/** Repeat opens by the same viewer of the same version inside this window collapse
 *  to one recorded view — a refresh or quick re-open doesn't inflate the count. */
const VIEW_DEDUP_MS = 30 * 60_000

const VISIBILITIES = ["public", "link", "org", "password"] as const

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Headers for everything inside the artifact sandbox. */
const RAW_HEADERS: Record<string, string> = {
  // Opaque origin: scripts run, but can touch no cookies, storage, or APIs.
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  // Raw artifact bytes are never the indexable surface (the viewer is); keeping
  // them out of search engines also blunts using the host for SEO-spam/phishing.
  "X-Robots-Tag": "noindex",
  // Versioned paths are immutable by construction.
  "Cache-Control": "public, max-age=31536000, immutable",
}

const REF_RE = /^([0-9a-z]{6,12})(?:-[a-z0-9-]*)?(?:@v(\d+))?$/

/** A taken-down artifact: content is gone (410), the record is preserved. */
const TOMBSTONE = "This artifact was removed."

/** Copy into a plain ArrayBuffer — what Hono's body() accepts. */
const toBody = (u: Uint8Array): ArrayBuffer => new Uint8Array(u).buffer as ArrayBuffer

/**
 * Embedded mode serves bundles under /raw/:id/v/:n/, so root-absolute URLs
 * (href="/x", src="/x", url(/x)) must be prefixed or they escape the artifact.
 * Domain mode (per-artifact origin) makes this a no-op later.
 */
const rewriteAbsoluteUrls = (text: string, prefix: string): string =>
  text
    .replace(/(\b(?:href|src|action|srcset|poster)=["'])\/(?!\/)/g, `$1${prefix}/`)
    .replace(/(url\(\s*['"]?)\/(?!\/)/g, `$1${prefix}/`)

/** Fixed-window per-IP limiter. In-memory (per instance); good enough as a
 *  brute-force / abuse backstop on a single container. */
function makeRateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; reset: number }>()
  return async (c: Context, next: Next) => {
    const now = Date.now()
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    const ip = (
      c.req.header("x-forwarded-for")?.split(",")[0] ??
      c.req.header("x-real-ip") ??
      "global"
    ).trim()
    let b = hits.get(ip)
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs }
      hits.set(ip, b)
    }
    b.count++
    if (b.count > max) {
      c.header("Retry-After", String(Math.ceil((b.reset - now) / 1000)))
      return c.json({ error: "rate limit exceeded" }, 429)
    }
    return next()
  }
}

/**
 * Reject webhook URLs aimed at private, loopback, or link-local addresses
 * (incl. the cloud metadata endpoint) to blunt SSRF. Literal IPs + localhost are
 * blocked here; hostnames that resolve into private space (DNS rebinding) are
 * out of scope for this static check.
 */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "" || host === "0.0.0.0" || host === "localhost" || host.endsWith(".localhost"))
    return false
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const o = v4.slice(1).map(Number)
    if (o.some((n) => n > 255)) return false
    const [a, b] = o
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
    return true
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false
    if (/^f[cd]/.test(host)) return false // unique-local fc00::/7
    if (/^fe80/.test(host)) return false // link-local
    return true
  }
  return true
}

export function createApp(deps: AppDeps): Hono {
  const { meta, blobs } = deps
  const app = new Hono()
  const bus = createBus()
  const presence = new Presence()

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
  const analyticsOn = deps.analytics !== false
  const versionWindowMs = deps.versionWindowMs ?? DEFAULT_VERSION_WINDOW_MS
  const allowOrigins = new Set(deps.webOrigins ?? [])

  // Fan an event to subscribed webhooks (enqueues to the outbox; the worker
  // delivers). Awaited so the row is durable before we respond, but never fatal.
  const notify = (a: ArtifactRecord, event: WebhookEvent, data: Record<string, unknown>) =>
    enqueueForEvent(meta, deps.baseUrl, a, event, data).catch(() => {})

  // Create in-app notification rows for the people a comment @mentions (real
  // users only, never the author) and push each a live event over their stream.
  // Returns the display names actually notified (for the Slack webhook).
  const notifyMentions = async (
    a: ArtifactRecord,
    cm: CommentRecord,
    mentions: Mention[],
    actorId: string | null,
  ): Promise<string[]> => {
    const targetIds = mentions.map((m) => m.id).filter((mid) => mid !== actorId)
    if (targetIds.length === 0) return []
    const real = new Set((await meta.getUsers(targetIds)).map((u) => u.id))
    // Registered agents are mentionable too; a mention of an agent lands in its
    // pull inbox instead of a notification bell.
    const agentIds = new Set((await meta.listAgents(a.org_id)).map((ag) => ag.id))
    const preview = previewOf(cm.body_md)
    const notified: string[] = []
    for (const m of mentions) {
      if (m.id === actorId) continue
      if (real.has(m.id)) {
        const row = {
          id: newId("n"),
          user_id: m.id,
          actor: cm.author,
          kind: "mention" as const,
          artifact_id: a.id,
          artifact_short_id: a.short_id,
          artifact_title: a.title,
          thread_id: cm.thread_id,
          comment_id: cm.id,
          preview,
        }
        await meta.createNotification(row)
        notified.push(m.name)
        bus.publish(`u:${m.id}`, {
          type: "notification",
          notification: { ...row, read: 0, created_at: new Date().toISOString() },
        })
      } else if (agentIds.has(m.id)) {
        await meta.createAgentMention({
          id: newId("amn"),
          agent_id: m.id,
          artifact_id: a.id,
          artifact_short_id: a.short_id,
          comment_id: cm.id,
          thread_id: cm.thread_id,
          body: cm.body_md,
          author: cm.author,
        })
        notified.push(m.name)
      }
    }
    return notified
  }
  if (allowOrigins.size) {
    app.use("/api/*", corsFor(allowOrigins))
    app.use("/v1/*", corsFor(allowOrigins))
  }
  if (deps.rateLimit) {
    // Strict on auth (credential brute-force); lenient on mutating API calls.
    app.use("/api/auth/*", makeRateLimiter(60_000, 20))
    const writeLimiter = makeRateLimiter(60_000, 120)
    app.use("/v1/*", (c, next) =>
      c.req.method === "GET" || c.req.method === "HEAD" ? next() : writeLimiter(c, next),
    )
  }

  const bearer = (c: Context): string => {
    const h = c.req.header("authorization") ?? ""
    return h.startsWith("Bearer ") ? h.slice(7) : ""
  }

  const currentUser = async (c: Context): Promise<SessionUser | null> => {
    if (!deps.auth) return null
    const s = await deps.auth.api.getSession({ headers: c.req.raw.headers })
    return s?.user ? { id: s.user.id, email: s.user.email, name: s.user.name ?? null } : null
  }

  // A registered agent acting via its bearer token (memoized per request). An
  // agent is a workspace principal: same authorization path as a member, with
  // its own identity and (default commenter) role.
  const agentCache = new WeakMap<Context, AgentRecord | null>()
  const agentFor = async (c: Context): Promise<AgentRecord | null> => {
    if (agentCache.has(c)) return agentCache.get(c) ?? null
    const b = bearer(c)
    const a = !b || (deps.token && b === deps.token) ? null : await meta.getAgentByToken(b)
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

  // ---- Authorization ----------------------------------------------------
  // One choke point: every gate resolves an Actor and asks can(). An unsecured
  // instance (no static token) trusts anonymous callers — zero-config self-host.
  const open = !deps.token
  const defaultRole: Role = deps.defaultRole ?? "editor"
  const multi = !!deps.multiWorkspace
  // The single/bootstrap workspace id — always a real value, never a magic
  // literal. The Node entry generates + persists one; tests fall back to this.
  const DEFAULT_ORG = deps.defaultOrgId ?? "default"

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
    if (!multi) return DEFAULT_ORG
    const cached = wsCache.get(c)
    if (cached) return cached
    // An agent acts within its own workspace, never a cookie's.
    const ag = await agentFor(c)
    const me = ag ? null : await currentUser(c)
    let ws: string
    if (ag) {
      ws = ag.org_id
    } else if (!me) {
      ws = getCookie(c, WS_COOKIE) || DEFAULT_ORG
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
    if (deps.token && bearer(c) === deps.token) return { kind: "token" }
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
    if (deps.token && bearer(c) === deps.token) return "owner"
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

  app.get("/v1/me", async (c) => {
    const u = await currentUser(c)
    if (!u) return c.json({ error: "unauthenticated" }, 401)
    const role = await ensureMembership(await activeWorkspace(c), u.id) // provisions on first load
    return c.json({ user: { ...u, role }, multi })
  })

  // Workspace member directory for the @mention picker — people AND agents, so
  // an agent can be @mentioned like anyone. Signed-in (or open) only; optional
  // ?q= filters by name/email prefix. Never exposes non-members.
  app.get("/v1/users", async (c) => {
    if (!open && !(await currentUser(c)) && bearer(c) !== deps.token)
      return c.json({ error: "unauthenticated" }, 401)
    const org = await activeWorkspace(c)
    const members = await meta.listMemberships(org)
    const users = await meta.getUsers(members.map((m) => m.user_id))
    const q = (c.req.query("q") ?? "").trim().toLowerCase()
    const people = (
      q
        ? users.filter(
            (u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
          )
        : users
    ).map((u) => ({ id: u.id, name: u.name ?? u.email, email: u.email, kind: "user" as const }))
    const agents = (await meta.listAgents(org))
      .filter((ag) => !q || ag.name.toLowerCase().includes(q))
      .map((ag) => ({ id: ag.id, name: ag.name, email: "", kind: "agent" as const }))
    const all = [...people, ...agents].sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ users: all })
  })

  // ---- Workspace: name + members (Admin-managed) -------------------------
  // A workspace must always keep at least one Admin, so it stays manageable:
  // demoting or removing the last owner is refused.
  const isLastOwner = async (orgId: string, userId: string): Promise<boolean> => {
    const owners = (await meta.listMemberships(orgId)).filter((m) => m.role === "owner")
    return owners.length <= 1 && owners.some((m) => m.user_id === userId)
  }

  const memberJson = (
    m: { user_id: string; role: Role },
    dir: Map<string, { email: string; name: string | null }>,
  ) => ({
    user_id: m.user_id,
    email: dir.get(m.user_id)?.email ?? null,
    name: dir.get(m.user_id)?.name ?? null,
    role: m.role,
  })

  // The workspace name, the caller's role, and the full member directory.
  app.get("/v1/workspace", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return c.json({ error: "unauthenticated" }, 401)
    const org = await activeWorkspace(c)
    const [ws, members] = await Promise.all([meta.getWorkspace(org), meta.listMemberships(org)])
    const users = await meta.getUsers(members.map((m) => m.user_id))
    const dir = new Map(users.map((u) => [u.id, u]))
    return c.json({
      id: org,
      name: ws?.name ?? DEFAULT_WORKSPACE_NAME,
      role,
      multi,
      members: members.map((m) => memberJson(m, dir)),
    })
  })

  // Rename the workspace (Admin only).
  app.patch("/v1/workspace", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown }
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : ""
    if (!name) return c.json({ error: "name required" }, 400)
    const ws = await meta.setWorkspace(await activeWorkspace(c), name)
    return c.json({ name: ws.name })
  })

  // Add a member by email, or update their role (Admin only).
  app.put("/v1/workspace/members", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: unknown }
    if (!b.email || !isWorkspaceRole(b.role))
      return c.json({ error: "email and a valid role are required" }, 400)
    const user = await meta.findUserByEmail(b.email.trim())
    if (!user) return c.json({ error: "no Dock user with that email" }, 404)
    const org = await activeWorkspace(c)
    // This route both adds and re-roles, so it must honor the same last-Admin
    // guard as PATCH — otherwise an Admin could demote the sole Admin via PUT.
    const existing = await meta.getMembership(org, user.id)
    if (existing?.role === "owner" && b.role !== "owner" && (await isLastOwner(org, user.id)))
      return c.json({ error: "the workspace needs at least one admin" }, 409)
    await meta.setMembership({
      id: existing?.id ?? newId("m"),
      org_id: org,
      user_id: user.id,
      role: b.role,
    })
    return c.json({ user_id: user.id, email: user.email, name: user.name, role: b.role }, 201)
  })

  // Change a member's role (Admin only; can't strip the last Admin).
  app.patch("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const userId = c.req.param("userId")
    const b = (await c.req.json().catch(() => ({}))) as { role?: unknown }
    if (!isWorkspaceRole(b.role)) return c.json({ error: "a valid role is required" }, 400)
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return c.json({ error: "not a member" }, 404)
    if (existing.role === "owner" && b.role !== "owner" && (await isLastOwner(org, userId)))
      return c.json({ error: "the workspace needs at least one admin" }, 409)
    await meta.setMembership({ id: existing.id, org_id: org, user_id: userId, role: b.role })
    return c.json({ user_id: userId, role: b.role })
  })

  // Remove a member (Admin only; can't remove the last Admin).
  app.delete("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const userId = c.req.param("userId")
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return c.body(null, 204)
    if (existing.role === "owner" && (await isLastOwner(org, userId)))
      return c.json({ error: "the workspace needs at least one admin" }, 409)
    await meta.removeMembership(org, userId)
    return c.body(null, 204)
  })

  // ---- Workspaces: list / create / switch (multi-workspace) --------------
  // The caller's workspaces (just the one in single mode). `active` is the id of
  // the workspace this request resolved to.
  app.get("/v1/workspaces", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return c.json({ error: "unauthenticated" }, 401)
    const active = await activeWorkspace(c)
    const me = await currentUser(c)
    if (!multi || !me) {
      const ws = await meta.getWorkspace(active)
      return c.json({
        multi,
        active,
        workspaces: [{ id: active, name: ws?.name ?? DEFAULT_WORKSPACE_NAME, role }],
      })
    }
    const mine = await meta.listWorkspaces(me.id)
    return c.json({
      multi,
      active,
      workspaces: mine.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    })
  })

  // Create a workspace (multi only). The creator becomes its Admin and is switched in.
  app.post("/v1/workspaces", async (c) => {
    if (!multi) return c.json({ error: "multi-workspace is disabled" }, 403)
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown }
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : ""
    if (!name) return c.json({ error: "name required" }, 400)
    const id = newId("ws")
    await meta.setWorkspace(id, name)
    await meta.setMembership({ id: newId("m"), org_id: id, user_id: me.id, role: "owner" })
    setWsCookie(c, id)
    return c.json({ id, name, role: "owner" }, 201)
  })

  // Switch the active workspace (multi only). Must be a member.
  app.post("/v1/workspace/switch", async (c) => {
    if (!multi) return c.json({ error: "multi-workspace is disabled" }, 403)
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const b = (await c.req.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof b.id === "string" ? b.id : ""
    if (!id || !(await meta.getMembership(id, me.id)))
      return c.json({ error: "not a member of that workspace" }, 403)
    setWsCookie(c, id)
    return c.json({ active: id })
  })

  // ---- Agents: registry (owner-managed) + the pull inbox -----------------
  const agentJson = (a: AgentRecord) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    created_at: a.created_at,
  })

  app.get("/v1/agents", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const agents = await meta.listAgents(await activeWorkspace(c))
    return c.json({ agents: agents.map(agentJson) })
  })

  // Create an agent + mint its token. The token is returned ONCE here; only its
  // hash-free secret lives in the row, so store it now. Default role commenter
  // (propose-only); editor is opt-in. Owner is never allowed for an agent.
  app.post("/v1/agents", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown; role?: unknown }
    const name = typeof b.name === "string" ? b.name.trim() : ""
    if (!name) return c.json({ error: "name required" }, 400)
    const role: Role =
      b.role === "viewer" || b.role === "commenter" || b.role === "editor" ? b.role : "commenter"
    const token = `dk_agt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
    try {
      const agent = await meta.createAgent({
        id: newId("ag"),
        org_id: await activeWorkspace(c),
        name,
        token,
        role,
      })
      // The only place the token is ever exposed.
      return c.json({ ...agentJson(agent), token }, 201)
    } catch {
      return c.json({ error: "an agent with that name already exists" }, 409)
    }
  })

  app.delete("/v1/agents/:id", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.deleteAgent(c.req.param("id"))
    return c.body(null, 204)
  })

  // The agent's pull inbox: mentions awaiting a response. Auth = the agent's
  // own bearer token. The agent reads context via the normal read endpoints,
  // proposes/replies with this same token, then acks.
  app.get("/v1/agent/inbox", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return c.json({ error: "agent token required" }, 401)
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20))
    const mentions = await meta.listPendingAgentMentions(agent.id, limit)
    return c.json({
      agent: agentJson(agent),
      mentions: mentions.map((m) => ({
        id: m.id,
        artifact: m.artifact_short_id,
        comment_id: m.comment_id,
        thread_id: m.thread_id,
        body: m.body,
        author: m.author,
        created_at: m.created_at,
      })),
    })
  })

  app.post("/v1/agent/mentions/:id/ack", async (c) => {
    const agent = await agentFor(c)
    if (!agent) return c.json({ error: "agent token required" }, 401)
    const ok = await meta.ackAgentMention(agent.id, c.req.param("id"))
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)
  })

  // Newest-first, keyset-paginated (?cursor=<created_at>&limit=N), with optional
  // server-side ?q= (title search), ?tag=, and ?favorite=true. Returns
  // { artifacts, next_cursor }. tag/favorite resolve to an id set first.
  app.get("/v1/artifacts", async (c) => {
    const me = await currentUser(c)
    if (!me && deps.token && bearer(c) !== deps.token)
      return c.json({ error: "unauthenticated" }, 401)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30))
    // Opaque compound cursor "<created_at>|<id>" — the id tiebreak keeps paging
    // correct when many artifacts share a created_at.
    const rawCursor = c.req.query("cursor")
    const sep = rawCursor?.indexOf("|") ?? -1
    const cursor =
      rawCursor && sep > 0
        ? { created_at: rawCursor.slice(0, sep), id: rawCursor.slice(sep + 1) }
        : undefined
    const q = c.req.query("q")?.trim() || undefined
    const tag = c.req.query("tag")?.trim() || undefined
    const collectionId = c.req.query("collection")?.trim() || undefined
    const favOnly = c.req.query("favorite") === "true"

    const favIds = me ? await meta.listUserFavoriteIds(me.id) : []
    const favorites = new Set(favIds)
    // tag / collection / favorite each narrow to an id set; intersect when combined.
    let ids: string[] | undefined
    const narrow = (next: string[]) => {
      ids = ids ? ids.filter((id) => next.includes(id)) : next
    }
    if (tag) narrow(await meta.artifactIdsByTag(tag))
    if (collectionId) narrow(await meta.collectionArtifactIds(collectionId))
    if (favOnly) narrow(favIds)
    if (ids && ids.length === 0) return c.json({ artifacts: [], next_cursor: null })

    const orgId = await activeWorkspace(c)
    const rows = await meta.listArtifacts({ limit: limit + 1, cursor, q, ids, orgId })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const next_cursor = hasMore && last ? `${last.created_at}|${last.id}` : null

    const pageIds = page.map((a) => a.id)
    const counts = analyticsOn ? await meta.viewCounts(pageIds) : {}
    const tags = await meta.tagsForArtifacts(pageIds)
    return c.json({
      artifacts: page.map((a) => ({
        ...toJson(deps.baseUrl, a, []),
        views: counts[a.id] ?? 0,
        tags: tags[a.id] ?? [],
        favorite: favorites.has(a.id),
      })),
      next_cursor,
    })
  })

  // Browse summary for the sidebar: total artifacts, this user's favorite count,
  // and tag → count (so counts stay accurate independent of the current page).
  app.get("/v1/tags", async (c) => {
    const me = await currentUser(c)
    if (!me && deps.token && bearer(c) !== deps.token)
      return c.json({ error: "unauthenticated" }, 401)
    const org = await activeWorkspace(c)
    const [total, tags, favIds, ws] = await Promise.all([
      meta.countArtifacts(org),
      meta.tagCounts(org),
      me ? meta.listUserFavoriteIds(me.id) : Promise.resolve([]),
      meta.getWorkspace(org),
    ])
    tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    return c.json({
      total,
      favorites: favIds.length,
      tags,
      workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
    })
  })

  // ---- Collections (shareable groups; a member's role propagates to items) -
  // A user's role on a collection: creator/member role, token/open → owner.
  const collectionRole = async (c: Context, col: CollectionRecord): Promise<Role | null> => {
    if (deps.token && bearer(c) === deps.token) return "owner"
    const me = await currentUser(c)
    if (!me) return open ? "owner" : null
    if (col.created_by === me.id) return "owner"
    const m = await meta.getCollectionMember(col.id, me.id)
    return m?.role ?? (open ? "owner" : null)
  }
  const canManageCollection = async (c: Context, col: CollectionRecord, action: Action) =>
    roleAllows((await collectionRole(c, col)) ?? "viewer", action)

  app.get("/v1/collections", async (c) => {
    if (!(await currentUser(c)) && deps.token && bearer(c) !== deps.token)
      return c.json({ error: "unauthenticated" }, 401)
    return c.json({ collections: await meta.listCollections(await activeWorkspace(c)) })
  })
  app.post("/v1/collections", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return c.json({ error: "forbidden" }, 403)
    const me = await currentUser(c)
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    const title = (body.title ?? "").trim().slice(0, 120)
    if (!title) return c.json({ error: "title required" }, 400)
    const createdBy = me?.id ?? "anon"
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: await activeWorkspace(c),
      title,
      created_by: createdBy,
    })
    // The creator joins as owner: they manage it, and (like any member) their
    // role propagates to the collection's artifacts.
    await meta.setCollectionMember({
      id: newId("cm"),
      collection_id: col.id,
      user_id: createdBy,
      role: "owner",
    })
    return c.json(col, 201)
  })
  app.patch("/v1/collections/:id", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "publish"))) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    return c.json(await meta.updateCollection(col.id, { title: body.title?.trim().slice(0, 120) }))
  })
  app.delete("/v1/collections/:id", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.deleteCollection(col.id)
    return c.body(null, 204)
  })
  app.put("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "publish"))) return c.json({ error: "forbidden" }, 403)
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art) return c.json({ error: "artifact not found" }, 404)
    await meta.addCollectionItem(col.id, art.id)
    return c.json({ ok: true })
  })
  app.delete("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "publish"))) return c.json({ error: "forbidden" }, 403)
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art) return c.json({ error: "artifact not found" }, 404)
    await meta.removeCollectionItem(col.id, art.id)
    return c.body(null, 204)
  })
  app.get("/v1/collections/:id/members", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col || (await collectionRole(c, col)) === null) return c.json({ error: "not found" }, 404)
    const rows = await meta.listCollectionMembers(col.id)
    const users = await meta.getUsers(rows.map((r) => r.user_id))
    const byId = new Map(users.map((u) => [u.id, u]))
    return c.json({
      created_by: col.created_by,
      members: rows.map((r) => ({
        user_id: r.user_id,
        email: byId.get(r.user_id)?.email ?? null,
        name: byId.get(r.user_id)?.name ?? null,
        role: r.role,
      })),
    })
  })
  app.put("/v1/collections/:id/members", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string }
    if (!b.email || !isRole(b.role))
      return c.json({ error: "email and a valid role are required" }, 400)
    const user = await meta.findUserByEmail(b.email.trim())
    if (!user) return c.json({ error: "no Dock user with that email" }, 404)
    await meta.setCollectionMember({
      id: newId("cm"),
      collection_id: col.id,
      user_id: user.id,
      role: b.role,
    })
    return c.json({ user_id: user.id, email: user.email, name: user.name, role: b.role }, 201)
  })
  app.delete("/v1/collections/:id/members/:userId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.removeCollectionMember(col.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  // ---- Publish ----------------------------------------------------------

  const handlePublish = async (c: Context, shortId?: string) => {
    // Republishing a version needs publish rights on that artifact; creating a
    // new one needs publish rights at the workspace level.
    if (shortId) {
      const existing = await meta.getByShortId(shortId)
      if (!existing) return c.json({ error: "not found" }, 404)
      if (!(await authorize(c, "publish", existing))) return c.json({ error: "forbidden" }, 403)
    } else if (!(await workspaceCan(c, "publish"))) {
      return c.json({ error: "forbidden" }, 403)
    }
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return c.json({ error: "upload too large" }, 413)

    const body = await c.req.parseBody()
    const file = body["file"]
    if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400)

    const bytes = new Uint8Array(await file.arrayBuffer())
    const isBundle =
      /\.zip$/i.test(file.name) ||
      body["kind"] === "bundle" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))

    try {
      const { artifact, version } = await publish(
        meta,
        blobs,
        {
          bytes,
          filename: file.name,
          isBundle,
          title: str(body["title"]),
          slug: str(body["slug"]),
          spa: body["spa"] === "true" || body["spa"] === "1",
          message: str(body["message"]),
          author: str(body["author"]),
          name: str(body["name"]),
          orgId: await activeWorkspace(c),
          visibility: visibilityOf(body["visibility"]),
        },
        shortId,
      )
      bus.publish(artifact.id, {
        type: "version.published",
        n: version.n,
        message: version.message,
      })
      await notify(artifact, "version.published", {
        version: version.n,
        message: version.message,
        author: version.author,
      })
      // Republish can resolve comment threads in the same call.
      const resolves = body["resolves"]
      if (shortId && typeof resolves === "string" && resolves) {
        for (const cid of resolves
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          const cm = await meta.getComment(cid)
          if (cm && cm.artifact_id === artifact.id) {
            await meta.setThreadState(artifact.id, cm.thread_id, "resolved")
            bus.publish(artifact.id, { type: "comment.resolved", thread_id: cm.thread_id })
          }
        }
      }
      const versions = await meta.listVersions(artifact.id)
      return c.json({ ...toJson(deps.baseUrl, artifact, versions), published: version.n }, 201)
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, err.statusCode as 400)
      throw err
    }
  }

  app.post("/v1/artifacts", (c) => handlePublish(c))
  app.post("/v1/artifacts/:shortId/versions", (c) => handlePublish(c, c.req.param("shortId")))

  app.get("/v1/artifacts/:shortId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    const actor = await actorFor(
      c,
      artifact ?? ({ id: "", visibility: "password" } as ArtifactRecord),
    )
    if (!artifact || !can(actor, "read", artifact.visibility))
      return c.json({ error: "not found" }, 404)
    const versions = await meta.listVersions(artifact.id)
    const me = actor.kind === "user" ? actor.userId : null
    const tags = (await meta.tagsForArtifacts([artifact.id]))[artifact.id] ?? []
    const favorite = me ? (await meta.listUserFavoriteIds(me)).includes(artifact.id) : false
    const collections = await meta.collectionIdsForArtifact(artifact.id)
    const proposals = await meta.listProposals(artifact.id)
    // `versions` stays at revision granularity (machines/agents); `sessions` is
    // the time-grouped view the UI shows by default. `my_role` tells the client
    // which actions to surface; `open_proposals` badges the review queue while
    // `proposals_total` (everything but withdrawn) gates the Proposals entry so a
    // proposer can return to read feedback after their candidate leaves the queue.
    return c.json({
      ...toJson(deps.baseUrl, artifact, versions),
      sessions: groupSessions(versions, versionWindowMs),
      my_role: effectiveRole(actor, artifact.visibility),
      tags,
      favorite,
      collections,
      open_proposals: proposals.filter((p) => p.state === "open").length,
      proposals_total: proposals.filter((p) => p.state !== "withdrawn").length,
      // A taken-down artifact keeps its record but serves no content (410); the
      // UI shows a tombstone instead of the iframe.
      removed: !!artifact.removed_at,
    })
  })

  // ---- Moderation: report (public) + takedown / audit (owner) -----------

  // Anyone can report a public artifact for abuse. Rate-limited by the global
  // per-IP limiter on mutating /v1; the reporter's IP is recorded best-effort.
  app.post("/v1/artifacts/:shortId/report", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    const b = (await c.req.json().catch(() => ({}))) as { reason?: unknown; detail?: unknown }
    const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : ""
    if (!reason) return c.json({ error: "reason required" }, 400)
    const ip = (
      c.req.header("x-forwarded-for")?.split(",")[0] ??
      c.req.header("x-real-ip") ??
      ""
    ).trim()
    const id = newId("rep")
    await meta.createReport({
      id,
      artifact_id: artifact.id,
      artifact_short_id: artifact.short_id,
      reason,
      detail: str(b.detail) ?? null,
      reporter: ip || null,
    })
    await meta.createAuditLog({
      id: newId("aud"),
      action: "report",
      artifact_id: artifact.id,
      actor: ip || "anonymous",
      detail: reason,
    })
    return c.json({ ok: true }, 201)
  })

  // The owner's moderation queue: open reports with their artifacts.
  app.get("/v1/reports", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const reports = await meta.listReports({ state: "open", limit: 200 })
    return c.json({ reports, open: reports.length })
  })

  app.get("/v1/audit", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    return c.json({ audit: await meta.listAuditLog({ limit: 200 }) })
  })

  // Take an artifact down: its content 410s everywhere, the record stays, and
  // any open reports against it are marked actioned.
  app.post("/v1/artifacts/:shortId/takedown", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    const who = (await actingUser(c))?.name ?? "owner"
    const b = (await c.req.json().catch(() => ({}))) as { note?: unknown }
    await meta.setArtifactRemoved(artifact.id, new Date().toISOString())
    for (const r of await meta.listReports({ state: "open" }))
      if (r.artifact_id === artifact.id) await meta.setReportState(r.id, "actioned")
    await meta.createAuditLog({
      id: newId("aud"),
      action: "takedown",
      artifact_id: artifact.id,
      actor: who,
      detail: str(b.note) ?? null,
    })
    return c.json({ ok: true, removed: true })
  })

  // Reverse a takedown.
  app.post("/v1/artifacts/:shortId/reinstate", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    const who = (await actingUser(c))?.name ?? "owner"
    await meta.setArtifactRemoved(artifact.id, null)
    await meta.createAuditLog({
      id: newId("aud"),
      action: "reinstate",
      artifact_id: artifact.id,
      actor: who,
      detail: null,
    })
    return c.json({ ok: true, removed: false })
  })

  // Dismiss a report without taking the artifact down.
  app.post("/v1/reports/:id/dismiss", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.setReportState(c.req.param("id"), "dismissed")
    await meta.createAuditLog({
      id: newId("aud"),
      action: "dismiss",
      artifact_id: null,
      actor: (await actingUser(c))?.name ?? "owner",
      detail: c.req.param("id"),
    })
    return c.json({ ok: true })
  })

  // ---- Sharing: per-artifact role overrides -----------------------------
  app.get("/v1/artifacts/:shortId/members", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    const rows = await meta.listArtifactMembers(artifact.id)
    const users = await meta.getUsers(rows.map((r) => r.user_id))
    const byId = new Map(users.map((u) => [u.id, u]))
    return c.json({
      default_role: defaultRole,
      members: rows.map((r) => ({
        user_id: r.user_id,
        email: byId.get(r.user_id)?.email ?? null,
        name: byId.get(r.user_id)?.name ?? null,
        role: r.role,
      })),
    })
  })

  app.put("/v1/artifacts/:shortId/members", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "manage", artifact))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string }
    if (!b.email || !isRole(b.role))
      return c.json({ error: "email and a valid role are required" }, 400)
    const user = await meta.findUserByEmail(b.email.trim())
    if (!user) return c.json({ error: "no Dock user with that email" }, 404)
    await meta.setArtifactMember({
      id: newId("am"),
      artifact_id: artifact.id,
      user_id: user.id,
      role: b.role,
    })
    return c.json({ user_id: user.id, email: user.email, name: user.name, role: b.role }, 201)
  })

  app.delete("/v1/artifacts/:shortId/members/:userId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "manage", artifact))) return c.json({ error: "forbidden" }, 403)
    await meta.removeArtifactMember(artifact.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  // ---- Favorites (per-user stars) + tags (browse metadata) --------------
  // Favorites are personal: any user who can read the artifact can star it.
  app.put("/v1/artifacts/:shortId/favorite", async (c) => {
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    await meta.setFavorite(artifact.id, me.id)
    return c.json({ favorite: true })
  })
  app.delete("/v1/artifacts/:shortId/favorite", async (c) => {
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    await meta.removeFavorite(artifact.id, me.id)
    return c.json({ favorite: false })
  })

  // Tags are workspace metadata: editors set them. Normalized (trimmed,
  // lowercased, deduped, capped) so browse stays tidy.
  const normalizeTags = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of raw) {
      if (typeof t !== "string") continue
      const v = t.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40)
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push(v)
      if (out.length >= 20) break
    }
    // Sorted so the PUT response matches the list/detail order (tagsForArtifacts
    // also sorts), and browse chips read alphabetically everywhere.
    return out.sort()
  }
  app.put("/v1/artifacts/:shortId/tags", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "publish", artifact))) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown }
    const tags = normalizeTags(body.tags)
    await meta.setArtifactTags(artifact.id, tags)
    return c.json({ tags })
  })

  // Restore a past version: re-point a new revision at its stored blob (no
  // re-upload, works for files and bundles). History is never rewritten.
  app.post("/v1/artifacts/:shortId/restore", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "publish", artifact))) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { version?: number }
    if (!Number.isInteger(body.version)) return c.json({ error: "version required" }, 400)
    const src = await meta.getVersion(artifact.id, body.version as number)
    if (!src) return c.json({ error: `no version ${body.version}` }, 404)
    const me = await currentUser(c)
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key: src.blob_key,
      content_type: src.content_type,
      author: me ? (me.name ?? me.email) : "anonymous",
      message: `Restored v${src.n}`,
      name: null,
    })
    await notify(artifact, "version.published", {
      version: version.n,
      message: version.message,
      author: version.author,
    })
    bus.publish(artifact.id, { type: "version.published", n: version.n, message: version.message })
    const fresh = (await meta.getByShortId(artifact.short_id)) as ArtifactRecord
    const versions = await meta.listVersions(artifact.id)
    return c.json(
      {
        ...toJson(deps.baseUrl, fresh, versions),
        sessions: groupSessions(versions, versionWindowMs),
        published: version.n,
      },
      201,
    )
  })

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

  // Source read-back for machines: returns an artifact's text content for any
  // version, as plain text (?v=N selects a version; defaults to current).
  app.get("/v1/artifacts/:shortId/content", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    if (artifact.removed_at) return c.json({ error: TOMBSTONE }, 410)
    const v = c.req.query("v") ? Number(c.req.query("v")) : artifact.current_version
    if (!Number.isInteger(v)) return c.json({ error: "bad version" }, 400)
    const version = await meta.getVersion(artifact.id, v)
    if (!version) return c.json({ error: `no version ${v}` }, 404)
    const src = await sourceText(version)
    if (src === null) return c.json({ error: "blob missing" }, 500)
    c.header("Content-Type", "text/plain; charset=utf-8")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Dock-Version", String(v))
    c.header("X-Dock-Kind", artifact.kind)
    return c.body(src)
  })

  // Line diff between two versions. Defaults to (current-1 → current).
  // ?format=json returns the structured ops; otherwise unified-style text.
  app.get("/v1/artifacts/:shortId/diff", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    const cur = artifact.current_version
    const from = c.req.query("from") ? Number(c.req.query("from")) : Math.max(1, cur - 1)
    const to = c.req.query("to") ? Number(c.req.query("to")) : cur
    if (!Number.isInteger(from) || !Number.isInteger(to))
      return c.json({ error: "bad version" }, 400)
    const [vf, vt] = [
      await meta.getVersion(artifact.id, from),
      await meta.getVersion(artifact.id, to),
    ]
    if (!vf || !vt) return c.json({ error: "version not found" }, 404)
    const [a, b] = [await sourceText(vf), await sourceText(vt)]
    if (a === null || b === null) return c.json({ error: "blob missing" }, 500)
    const ops = diffLines(a, b)

    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Dock-From", String(from))
    c.header("X-Dock-To", String(to))
    if (c.req.query("format") === "json") return c.json({ from, to, ops })
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(formatDiff(ops))
  })

  // ---- Reviews: proposed versions ---------------------------------------

  const proposalJson = (a: ArtifactRecord, p: ProposalRecord) => ({
    id: p.id,
    state: p.state,
    author: p.author,
    message: p.message,
    base_version: p.base_version,
    kind: p.kind,
    decided_by: p.decided_by,
    decided_version: p.decided_version,
    decision_note: p.decision_note,
    decided_at: p.decided_at,
    created_at: p.created_at,
    // The proposed experience, rendered exactly like a live version.
    preview_url: `${deps.baseUrl}/raw/${a.short_id}/p/${p.id}/index.html`,
  })

  // Load an artifact + one of its proposals, read-gated. Returns an error
  // Response to short-circuit, or the pair to proceed.
  const loadProposal = async (c: Context) => {
    const artifact = await meta.getByShortId(c.req.param("shortId") ?? "")
    if (!artifact || !(await authorize(c, "read", artifact)))
      return { error: c.json({ error: "not found" }, 404) as Response }
    const proposal = await meta.getProposal(c.req.param("proposalId") ?? "")
    if (!proposal || proposal.artifact_id !== artifact.id)
      return { error: c.json({ error: "not found" }, 404) as Response }
    return { artifact, proposal }
  }

  // Propose a candidate version (commenter+). It does NOT go live; an editor
  // approves it. Same multipart shape as publish.
  app.post("/v1/artifacts/:shortId/proposals", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0) return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "propose", artifact))) return c.json({ error: "forbidden" }, 403)
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return c.json({ error: "upload too large" }, 413)

    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const isBundle =
      /\.zip$/i.test(file.name) ||
      body.kind === "bundle" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))

    const acting = await actingUser(c)
    const author = acting ? acting.name : str(body.author) || "anonymous"
    try {
      const { proposal } = await propose(meta, blobs, artifact.short_id, {
        bytes,
        filename: file.name,
        isBundle,
        spa: body.spa === "true" || body.spa === "1",
        message: str(body.message),
        author,
      })
      bus.publish(artifact.id, { type: "proposal.created", proposal_id: proposal.id })
      await notify(artifact, "proposal.created", {
        proposal_id: proposal.id,
        author: proposal.author,
        message: proposal.message,
        base_version: proposal.base_version,
      })
      return c.json(proposalJson(artifact, proposal), 201)
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, err.statusCode as 400)
      throw err
    }
  })

  // List proposals (read-gated). ?state=open filters to the review queue.
  app.get("/v1/artifacts/:shortId/proposals", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    const stateQ = c.req.query("state")
    const state =
      stateQ === "open" ||
      stateQ === "approved" ||
      stateQ === "changes_requested" ||
      stateQ === "withdrawn"
        ? stateQ
        : undefined
    const proposals = await meta.listProposals(artifact.id, state ? { state } : undefined)
    return c.json({ proposals: proposals.map((p) => proposalJson(artifact, p)) })
  })

  // One proposal, with a line diff of its content against its base version.
  app.get("/v1/artifacts/:shortId/proposals/:proposalId", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    const base = await meta.getVersion(artifact.id, proposal.base_version)
    const [a, b] = [base ? await sourceText(base) : "", await sourceText(proposal)]
    const ops = a !== null && b !== null ? diffLines(a, b) : []
    return c.json({
      ...proposalJson(artifact, proposal),
      diff: { base_version: proposal.base_version, ops },
    })
  })

  // Approve: the proposed content becomes the new current version (goes live).
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/approve", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    if (!(await authorize(c, "approve", artifact))) return c.json({ error: "forbidden" }, 403)
    if (proposal.state !== "open") return c.json({ error: `proposal is ${proposal.state}` }, 409)
    const me = await currentUser(c)
    const approver = me ? (me.name ?? me.email) : null
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown }
    try {
      const version = await approveProposal(meta, proposal, approver, str(body.note) ?? null)
      bus.publish(artifact.id, {
        type: "proposal.approved",
        proposal_id: proposal.id,
        n: version.n,
      })
      bus.publish(artifact.id, {
        type: "version.published",
        n: version.n,
        message: version.message,
      })
      await notify(artifact, "proposal.approved", {
        proposal_id: proposal.id,
        version: version.n,
        approver,
      })
      const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
      return c.json({ ...proposalJson(artifact, fresh), published: version.n })
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, err.statusCode as 400)
      throw err
    }
  })

  // Request changes: the candidate stays a proposal; the proposer can revise.
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/request-changes", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    if (!(await authorize(c, "approve", artifact))) return c.json({ error: "forbidden" }, 403)
    if (proposal.state !== "open") return c.json({ error: `proposal is ${proposal.state}` }, 409)
    const me = await currentUser(c)
    const reviewer = me ? (me.name ?? me.email) : null
    const body = (await c.req.json().catch(() => ({}))) as { note?: unknown }
    await meta.decideProposal(proposal.id, {
      state: "changes_requested",
      decided_by: reviewer,
      decided_version: null,
      decision_note: str(body.note) ?? null,
    })
    bus.publish(artifact.id, { type: "proposal.changes_requested", proposal_id: proposal.id })
    await notify(artifact, "proposal.changes_requested", { proposal_id: proposal.id, reviewer })
    const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
    return c.json(proposalJson(artifact, fresh))
  })

  // Withdraw: the proposer (or a manager) retracts an open proposal.
  app.post("/v1/artifacts/:shortId/proposals/:proposalId/withdraw", async (c) => {
    const r = await loadProposal(c)
    if ("error" in r) return r.error
    const { artifact, proposal } = r
    const me = await currentUser(c)
    const who = me ? (me.name ?? me.email) : null
    const isAuthor = who !== null && who === proposal.author
    if (!isAuthor && !(await authorize(c, "manage", artifact)))
      return c.json({ error: "forbidden" }, 403)
    if (proposal.state !== "open") return c.json({ error: `proposal is ${proposal.state}` }, 409)
    await meta.decideProposal(proposal.id, {
      state: "withdrawn",
      decided_by: who,
      decided_version: null,
    })
    const fresh = (await meta.getProposal(proposal.id)) as ProposalRecord
    return c.json(proposalJson(artifact, fresh))
  })

  // ---- Comments ----------------------------------------------------------

  // Create a comment (new thread) or a reply (pass thread_id).
  app.post("/v1/artifacts/:shortId/comments", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0) return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "comment", artifact))) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.body_md !== "string" || body.body_md.trim() === "")
      return c.json({ error: "body_md required" }, 400)

    const id = newId("c")
    const threadId = typeof body.thread_id === "string" && body.thread_id ? body.thread_id : id
    const baseVersion = Number.isInteger(body.base_version)
      ? (body.base_version as number)
      : artifact.current_version
    const anchor =
      body.anchor && typeof body.anchor === "object"
        ? JSON.stringify(body.anchor)
        : typeof body.anchor === "string"
          ? body.anchor
          : null

    const acting = await actingUser(c)
    const author = acting
      ? acting.name
      : typeof body.author === "string" && body.author
        ? body.author
        : "anonymous"
    const mentions = parseMentions(body.mentions)
    let created = await meta.createComment({
      id,
      artifact_id: artifact.id,
      thread_id: threadId,
      base_version: baseVersion,
      path: typeof body.path === "string" ? body.path : null,
      anchor,
      body_md: body.body_md,
      author,
    })
    // Mentions live in the comment's meta JSON (the picker supplies user ids, so
    // there's no fragile server-side @name parsing); persist them with the row.
    if (mentions.length) {
      const patched = await meta.updateComment(created.id, {
        meta: JSON.stringify({ ...parseMeta(created.meta), mentions }),
      })
      if (patched) created = patched
    }
    bus.publish(artifact.id, { type: "comment.created", comment: commentJson(created) })
    await notify(artifact, "comment.created", {
      author: created.author,
      body: created.body_md,
      quote: quoteOf(created.anchor),
      thread_id: created.thread_id,
    })
    const notified = await notifyMentions(artifact, created, mentions, acting?.id ?? null)
    if (notified.length)
      await notify(artifact, "comment.mention", {
        author: created.author,
        mentioned: notified,
        body: created.body_md,
        quote: quoteOf(created.anchor),
        thread_id: created.thread_id,
      })
    return c.json(commentJson(created), 201)
  })

  app.get("/v1/artifacts/:shortId/comments", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    const q = c.req.query("state")
    const state = q === "open" || q === "resolved" ? q : undefined
    const comments = await meta.listComments(artifact.id, state ? { state } : undefined)
    // Flag whether each anchor still resolves against the current version.
    const cur = await meta.getVersion(artifact.id, artifact.current_version)
    const src = cur ? await sourceText(cur) : null
    return c.json({
      comments: comments.map((cm) =>
        commentJson(cm, src === null ? true : isAnchored(cm.anchor, src)),
      ),
    })
  })

  // Resolve (or reopen, with {state:"open"}) the thread a comment belongs to.
  app.post("/v1/artifacts/:shortId/comments/:commentId/resolve", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return c.json({ error: "not found" }, 404)
    if (!(await authorize(c, "comment", artifact))) return c.json({ error: "forbidden" }, 403)
    const cm = await meta.getComment(c.req.param("commentId"))
    if (!cm || cm.artifact_id !== artifact.id) return c.json({ error: "not found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { state?: string }
    const state = body.state === "open" ? "open" : "resolved"
    const updated = await meta.setThreadState(artifact.id, cm.thread_id, state)
    bus.publish(artifact.id, { type: "comment.resolved", thread_id: cm.thread_id, state })
    await notify(artifact, "comment.resolved", { state, thread_id: cm.thread_id })
    return c.json({ thread_id: cm.thread_id, state, updated })
  })

  // Loads (artifact, comment) for a mutation, 404ing on mismatch.
  const loadComment = async (
    c: Context,
  ): Promise<{ artifact: ArtifactRecord; cm: CommentRecord } | { error: Response }> => {
    const artifact = await meta.getByShortId(c.req.param("shortId") ?? "")
    if (!artifact) return { error: c.json({ error: "not found" }, 404) }
    const cm = await meta.getComment(c.req.param("commentId") ?? "")
    if (!cm || cm.artifact_id !== artifact.id) return { error: c.json({ error: "not found" }, 404) }
    return { artifact, cm }
  }
  // The acting display name (agent or signed-in user); null on an open instance.
  const actorName = async (c: Context): Promise<string | null> =>
    (await actingUser(c))?.name ?? null

  // Toggle the current user's reaction (one of REACTIONS) on a comment.
  app.post("/v1/artifacts/:shortId/comments/:commentId/react", async (c) => {
    const r = await loadComment(c)
    if ("error" in r) return r.error
    const { artifact, cm } = r
    if (!(await authorize(c, "comment", artifact))) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { emoji?: string }
    if (!body.emoji || !REACTIONS.includes(body.emoji))
      return c.json({ error: "unknown reaction" }, 400)
    const actor = (await actorName(c)) ?? "anonymous"
    const md = parseMeta(cm.meta)
    const reactions = md.reactions ?? {}
    const arr = reactions[body.emoji] ?? []
    const i = arr.indexOf(actor)
    if (i >= 0) arr.splice(i, 1)
    else arr.push(actor)
    if (arr.length) reactions[body.emoji] = arr
    else delete reactions[body.emoji]
    md.reactions = reactions
    const updated = await meta.updateComment(cm.id, { meta: JSON.stringify(md) })
    bus.publish(artifact.id, { type: "comment.reacted", thread_id: cm.thread_id })
    return c.json(commentJson(updated ?? cm))
  })

  // Edit a comment's body (author only when signed in).
  app.patch("/v1/artifacts/:shortId/comments/:commentId", async (c) => {
    const r = await loadComment(c)
    if ("error" in r) return r.error
    const { artifact, cm } = r
    if (!(await authorize(c, "comment", artifact))) return c.json({ error: "forbidden" }, 403)
    const actor = await actorName(c)
    if (actor && cm.author !== actor) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { body_md?: string }
    if (typeof body.body_md !== "string" || body.body_md.trim() === "")
      return c.json({ error: "body_md required" }, 400)
    const md = parseMeta(cm.meta)
    md.edited_at = new Date().toISOString()
    const updated = await meta.updateComment(cm.id, {
      body_md: body.body_md,
      meta: JSON.stringify(md),
    })
    bus.publish(artifact.id, { type: "comment.updated", thread_id: cm.thread_id })
    return c.json(commentJson(updated ?? cm))
  })

  // Soft-delete a comment (author only when signed in); the row stays so replies
  // keep their thread, and the body is tombstoned.
  app.delete("/v1/artifacts/:shortId/comments/:commentId", async (c) => {
    const r = await loadComment(c)
    if ("error" in r) return r.error
    const { artifact, cm } = r
    if (!(await authorize(c, "comment", artifact))) return c.json({ error: "forbidden" }, 403)
    const actor = await actorName(c)
    if (actor && cm.author !== actor) return c.json({ error: "forbidden" }, 403)
    const md = parseMeta(cm.meta)
    md.deleted = true
    const updated = await meta.updateComment(cm.id, { meta: JSON.stringify(md) })
    bus.publish(artifact.id, { type: "comment.updated", thread_id: cm.thread_id })
    return c.json(commentJson(updated ?? cm))
  })

  // ---- Live stream (SSE) + presence -------------------------------------

  app.get("/v1/artifacts/:shortId/events", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return c.text("not found", 404)
    c.header("Access-Control-Allow-Origin", "*")
    return streamSSE(c, async (stream) => {
      const unsub = bus.subscribe(artifact.id, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
      })
      stream.onAbort(unsub)
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ short_id: artifact.short_id }),
      })
      while (!stream.aborted) {
        await stream.sleep(15000)
        await stream.writeSSE({ event: "ping", data: "{}" })
      }
    })
  })

  app.post("/v1/artifacts/:shortId/presence", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    const name = typeof body.name === "string" && body.name ? body.name : "anonymous"
    const viewers = presence.heartbeat(artifact.id, name, Date.now())
    bus.publish(artifact.id, { type: "presence", viewers })
    return c.json({ viewers })
  })

  // ---- View analytics ----------------------------------------------------

  // Record a view. The viewer is the logged-in user, or a stable anonymous id
  // kept in a cookie (so unique-viewer counts work for public/link artifacts).
  app.post("/v1/artifacts/:shortId/view", async (c) => {
    if (!analyticsOn) return c.body(null, 204)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    const me = await currentUser(c)
    let viewer: string
    let kind: "user" | "anon"
    if (me) {
      // Stable identity = the account. The same signed-in person is one viewer,
      // shown by name — never "anonymous".
      viewer = me.id
      kind = "user"
    } else {
      // A long-lived first-party cookie keeps the same browser as one anonymous
      // viewer across opens. SameSite=None;Secure when the SPA is cross-site, so
      // it actually sticks there (Lax would be dropped on the cross-site fetch).
      let vid = getCookie(c, "dock_vid")
      if (!vid) {
        vid = newId("anon")
        setCookie(c, "dock_vid", vid, {
          path: "/",
          maxAge: 60 * 60 * 24 * 365,
          httpOnly: true,
          sameSite: deps.crossSite ? "None" : "Lax",
          secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
        })
      }
      viewer = vid
      kind = "anon"
    }
    const body = (await c.req.json().catch(() => ({}))) as { version?: number }
    const version = Number.isInteger(body.version)
      ? (body.version as number)
      : artifact.current_version
    // De-dup: skip if this viewer already saw this version recently (a refresh).
    const since = new Date(Date.now() - VIEW_DEDUP_MS).toISOString()
    if (await meta.viewedSince(artifact.id, viewer, version, since)) return c.body(null, 204)
    await meta.recordView({
      id: newId("v"),
      artifact_id: artifact.id,
      version,
      viewer,
      viewer_kind: kind,
    })
    return c.body(null, 204)
  })

  app.get("/v1/artifacts/:shortId/analytics", async (c) => {
    if (!analyticsOn) return c.json({ error: "analytics disabled" }, 404)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact)))
      return c.json({ error: "not found" }, 404)
    const stats = await meta.viewStats(artifact.id)
    // Recent user-viewers are stored by id (stable); resolve to display names.
    const userIds = stats.recent.filter((r) => r.kind === "user").map((r) => r.viewer)
    if (userIds.length) {
      const byId = new Map((await meta.getUsers(userIds)).map((u) => [u.id, u.name ?? u.email]))
      stats.recent = stats.recent.map((r) =>
        r.kind === "user" ? { ...r, viewer: byId.get(r.viewer) ?? "Someone" } : r,
      )
    }
    return c.json(stats)
  })

  // ---- In-app notifications (per signed-in user) ------------------------

  app.get("/v1/notifications", async (c) => {
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const [notifications, unread] = await Promise.all([
      meta.listNotifications(me.id, 50),
      meta.unreadNotificationCount(me.id),
    ])
    return c.json({ notifications, unread })
  })

  app.post("/v1/notifications/read", async (c) => {
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; all?: unknown }
    const ids =
      body.all === true
        ? "all"
        : Array.isArray(body.ids)
          ? body.ids.filter((x): x is string => typeof x === "string")
          : []
    await meta.markNotificationsRead(me.id, ids)
    const unread = await meta.unreadNotificationCount(me.id)
    return c.json({ unread })
  })

  // Live notification stream for the signed-in user (the header bell subscribes).
  app.get("/v1/notifications/events", async (c) => {
    const me = await currentUser(c)
    if (!me) return c.text("unauthenticated", 401)
    c.header("Access-Control-Allow-Origin", "*")
    const userId = me.id
    return streamSSE(c, async (stream) => {
      const unsub = bus.subscribe(`u:${userId}`, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
      })
      stream.onAbort(unsub)
      await stream.writeSSE({ event: "ready", data: "{}" })
      while (!stream.aborted) {
        await stream.sleep(15000)
        await stream.writeSSE({ event: "ping", data: "{}" })
      }
    })
  })

  // ---- Webhooks (notifications: Slack + arbitrary endpoints) -------------

  const publicWebhook = (w: { secret: string }) => ({ ...w, secret: undefined })

  app.get("/v1/webhooks", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const hooks = await meta.listWebhooks()
    return c.json({ webhooks: hooks.map(publicWebhook) })
  })

  app.post("/v1/webhooks", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof b.url !== "string" || !isPublicHttpUrl(b.url))
      return c.json({ error: "a valid public http(s) url is required" }, 400)
    const kind = b.kind === "slack" ? "slack" : "generic"
    // events: array or "*"; validate against the known set
    const events =
      Array.isArray(b.events) && b.events.length
        ? b.events
            .filter((e): e is WebhookEvent =>
              (WEBHOOK_EVENTS as readonly string[]).includes(e as string),
            )
            .join(",")
        : "*"
    let artifactRef: string | null = null
    if (typeof b.artifact === "string" && b.artifact) {
      const a = await meta.getByShortId(b.artifact)
      if (!a) return c.json({ error: "artifact not found" }, 404)
      artifactRef = a.id
    }
    const created = await meta.createWebhook({
      id: `wh_${randomUUID().slice(0, 12)}`,
      artifact_id: artifactRef,
      url: b.url,
      secret: typeof b.secret === "string" && b.secret ? b.secret : randomUUID().replace(/-/g, ""),
      kind,
      events,
      label: typeof b.label === "string" ? b.label : null,
    })
    return c.json(publicWebhook(created), 201)
  })

  app.delete("/v1/webhooks/:id", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.deleteWebhook(c.req.param("id"))
    return c.body(null, 204)
  })

  app.get("/v1/webhooks/:id/deliveries", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const rows = await meta.recentDeliveries(c.req.param("id"), 20)
    return c.json({
      deliveries: rows.map((d) => ({
        id: d.id,
        event_type: d.event_type,
        status: d.status,
        attempts: d.attempts,
        last_error: d.last_error,
        created_at: d.created_at,
      })),
    })
  })

  // Send a sample event to a webhook so you can confirm it lands.
  app.post("/v1/webhooks/:id/test", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const w = await meta.getWebhook(c.req.param("id"))
    if (!w) return c.json({ error: "not found" }, 404)
    const sample = JSON.stringify({
      event: "version.published",
      at: new Date().toISOString(),
      artifact: { short_id: "sample00", title: "Test artifact", url: `${deps.baseUrl}/a/sample00` },
      data: { version: 1, message: "test delivery from Dock", author: "dock" },
    })
    await meta.enqueueDelivery({
      id: `wd_${randomUUID().slice(0, 12)}`,
      webhook_id: w.id,
      url: w.url,
      secret: w.secret,
      kind: w.kind,
      event_type: "version.published",
      payload: sample,
    })
    return c.json({ queued: true })
  })

  // ---- Viewer ------------------------------------------------------------

  app.get("/a/:ref", async (c) => {
    const m = REF_RE.exec(c.req.param("ref"))
    if (!m) return c.text("not found", 404)
    const artifact = await meta.getByShortId(m[1])
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return c.text("not found", 404)
    if (artifact.removed_at) return c.text(TOMBSTONE, 410)
    const n = m[2] ? Number(m[2]) : artifact.current_version
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text(`no version ${n}`, 404)
    const versions = await meta.listVersions(artifact.id)
    // Point the iframe straight at the sandbox origin when split (skips the
    // redirect hop); same-origin otherwise.
    const rawSrc = `${deps.sandboxOrigin ?? ""}/raw/${artifact.short_id}/v/${n}/index.html`
    return c.html(renderShell(artifact, versions, n, rawSrc))
  })

  // ---- Raw content (the sandbox) ----------------------------------------

  // The comment-anchor client, referenced by URL from artifact HTML. Artifact
  // pages are cached immutable; this is cached short so the client can evolve
  // without stranding old behavior in already-viewed artifacts.
  app.get("/raw/dock-client.js", (c) =>
    c.body(ANCHOR_CLIENT_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  )

  // Serve stored content (a version or a proposal) under `prefix`, resolving a
  // sub-`path` for bundles. Identical pipeline for both, so a proposal renders
  // exactly how it will once approved — reviewers approve the experience.
  const serveContent = async (
    c: Context,
    content: { blob_key: string; content_type: string },
    title: string | null,
    prefix: string,
    rawPath: string,
  ) => {
    let path = rawPath
    if (content.content_type === BUNDLE_CONTENT_TYPE) {
      const manifestBytes = await blobs.get(content.blob_key)
      if (!manifestBytes) return c.text("blob missing", 500)
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest

      if (path === "" || path === "index.html") path = manifest.entry.slice(1)
      let lookup = `/${path}`
      if (lookup.endsWith("/")) lookup += "index.html"
      let entry = manifest.files[lookup]
      // Pretty URLs (Astro-style dir output), then SPA fallback.
      if (!entry && !/\.[a-z0-9]+$/i.test(lookup)) entry = manifest.files[`${lookup}/index.html`]
      if (!entry && manifest.spa) entry = manifest.files[manifest.entry]
      if (!entry) return c.text("not found", 404, RAW_HEADERS)

      const data = await blobs.get(entry.key)
      if (!data) return c.text("blob missing", 500)
      if (entry.type.startsWith("text/html") || entry.type.startsWith("text/css")) {
        const rewritten = rewriteAbsoluteUrls(new TextDecoder().decode(data), prefix.slice(0, -1))
        // Bundle pages get the anchor client too — comments stick everywhere.
        const out = entry.type.startsWith("text/html") ? rewritten + SELECTION_SCRIPT : rewritten
        return c.body(out, 200, { ...RAW_HEADERS, "Content-Type": entry.type })
      }
      return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": entry.type })
    }

    const data = await blobs.get(content.blob_key)
    if (!data) return c.text("blob missing", 500)

    if (content.content_type === "text/markdown") {
      if (path === "raw.md")
        return c.body(toBody(data), 200, {
          ...RAW_HEADERS,
          "Content-Type": "text/markdown; charset=utf-8",
        })
      const html = await renderMarkdown(new TextDecoder().decode(data), title)
      return c.body(html, 200, { ...RAW_HEADERS, "Content-Type": "text/html; charset=utf-8" })
    }

    // html file artifact — any path serves the document (+ selection capture)
    const ct = mimeFor(path || "index.html")
    if (ct.startsWith("text/html")) {
      const html = new TextDecoder().decode(data) + SELECTION_SCRIPT
      return c.body(html, 200, { ...RAW_HEADERS, "Content-Type": ct })
    }
    return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": ct })
  }

  app.get("/raw/:shortId/v/:n/*", async (c) => {
    const shortId = c.req.param("shortId")
    const n = Number(c.req.param("n"))
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !Number.isInteger(n) || !(await authorize(c, "read", artifact)))
      return c.text("not found", 404)
    if (artifact.removed_at) return c.text(TOMBSTONE, 410)
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text("not found", 404)

    const prefix = `/raw/${shortId}/v/${c.req.param("n")}/`
    const path = decodeURIComponent(c.req.path.slice(prefix.length))
    return serveContent(c, version, artifact.title, prefix, path)
  })

  // Render a proposed version exactly like a live one, so review is of the
  // experience, not a source dump. Read-gated; the proposal must belong here.
  app.get("/raw/:shortId/p/:proposalId/*", async (c) => {
    const shortId = c.req.param("shortId")
    const artifact = await meta.getByShortId(shortId)
    if (!artifact || !(await authorize(c, "read", artifact))) return c.text("not found", 404)
    if (artifact.removed_at) return c.text(TOMBSTONE, 410)
    const proposal = await meta.getProposal(c.req.param("proposalId"))
    if (!proposal || proposal.artifact_id !== artifact.id) return c.text("not found", 404)

    const prefix = `/raw/${shortId}/p/${proposal.id}/`
    const path = decodeURIComponent(c.req.path.slice(prefix.length))
    return serveContent(c, proposal, artifact.title, prefix, path)
  })

  return app
}

/**
 * Echo-origin CORS middleware so the cross-origin SPA can send cookies. Headers
 * are written onto the final response after next() — the Better Auth handler
 * returns its own Response, so setting them beforehand would be discarded.
 */
const corsFor = (allowed: Set<string>) => async (c: Context, next: () => Promise<void>) => {
  const origin = c.req.header("origin")
  const ok = !!origin && allowed.has(origin)
  if (ok && c.req.method === "OPTIONS")
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    })
  await next()
  if (ok) {
    c.res.headers.set("Access-Control-Allow-Origin", origin)
    c.res.headers.set("Access-Control-Allow-Credentials", "true")
    c.res.headers.append("Vary", "Origin")
  }
}

/** The quoted text from a comment anchor, for webhook payloads. */
const quoteOf = (anchor: string | null): string | null => {
  if (!anchor) return null
  try {
    return (JSON.parse(anchor) as { exact?: string }).exact ?? null
  } catch {
    return null
  }
}

/** A short single-line preview of a comment body for notification rows. */
const previewOf = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim()
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)

const visibilityOf = (v: unknown): Visibility | undefined =>
  typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v)
    ? (v as Visibility)
    : undefined

export { artifactUrl }
