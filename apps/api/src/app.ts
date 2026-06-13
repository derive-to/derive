import { randomUUID } from "node:crypto"
import {
  type Action,
  type Actor,
  ANCHOR_CLIENT_JS,
  type ArtifactRecord,
  approveProposal,
  artifactUrl,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
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

type CommentMeta = { reactions?: Record<string, string[]>; edited_at?: string; deleted?: boolean }
const parseMeta = (m: string | null): CommentMeta => {
  if (!m) return {}
  try {
    return JSON.parse(m) as CommentMeta
  } catch {
    return {}
  }
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
  /** In-memory per-IP rate limiting on auth + mutating routes. Off by default. */
  rateLimit?: boolean
}

/** The single workspace (multi-workspace is a later layer). */
const WORKSPACE = "local"

const VISIBILITIES = ["public", "link", "org", "password"] as const

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Headers for everything inside the artifact sandbox. */
const RAW_HEADERS: Record<string, string> = {
  // Opaque origin: scripts run, but can touch no cookies, storage, or APIs.
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  // Versioned paths are immutable by construction.
  "Cache-Control": "public, max-age=31536000, immutable",
}

const REF_RE = /^([0-9a-z]{6,12})(?:-[a-z0-9-]*)?(?:@v(\d+))?$/

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

  // ---- Authorization ----------------------------------------------------
  // One choke point: every gate resolves an Actor and asks can(). An unsecured
  // instance (no static token) trusts anonymous callers — zero-config self-host.
  const open = !deps.token
  const defaultRole: Role = deps.defaultRole ?? "editor"

  // Lazy provisioning: the first member of the workspace is its owner; everyone
  // else joins at the default role. Returns the caller's workspace role.
  const ensureMembership = async (userId: string): Promise<Role> => {
    const existing = await meta.getMembership(WORKSPACE, userId)
    if (existing) return existing.role
    const role: Role = (await meta.countMemberships(WORKSPACE)) === 0 ? "owner" : defaultRole
    await meta.setMembership({ id: newId("m"), org_id: WORKSPACE, user_id: userId, role })
    return role
  }

  const actorFor = async (c: Context, a: ArtifactRecord): Promise<Actor> => {
    if (deps.token && bearer(c) === deps.token) return { kind: "token" }
    const me = await currentUser(c)
    if (!me) return { kind: "anon", open }
    const orgRole = await ensureMembership(me.id)
    const am = await meta.getArtifactMember(a.id, me.id)
    return { kind: "user", userId: me.id, artifactRole: am?.role ?? null, orgRole, open }
  }

  /** Authorize an action against a specific artifact. */
  const authorize = (c: Context, action: Action, a: ArtifactRecord): Promise<boolean> =>
    actorFor(c, a).then((actor) => can(actor, action, a.visibility))

  /** The caller's role at the workspace level (creating artifacts, settings). */
  const workspaceRole = async (c: Context): Promise<Role | null> => {
    if (deps.token && bearer(c) === deps.token) return "owner"
    const me = await currentUser(c)
    if (!me) return open ? "owner" : null
    return ensureMembership(me.id)
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
    const role = await ensureMembership(u.id) // provisions on first load
    return c.json({ user: { ...u, role } })
  })

  // Newest-first, keyset-paginated (?cursor=<created_at>&limit=N), with optional
  // server-side ?q= (title search), ?tag=, and ?favorite=true. Returns
  // { artifacts, next_cursor }. tag/favorite resolve to an id set first.
  app.get("/v1/artifacts", async (c) => {
    const me = await currentUser(c)
    if (!me && deps.token && bearer(c) !== deps.token)
      return c.json({ error: "unauthenticated" }, 401)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30))
    const cursor = c.req.query("cursor") || undefined
    const q = c.req.query("q")?.trim() || undefined
    const tag = c.req.query("tag")?.trim() || undefined
    const favOnly = c.req.query("favorite") === "true"

    const favIds = me ? await meta.listUserFavoriteIds(me.id) : []
    const favorites = new Set(favIds)
    let ids: string[] | undefined
    if (tag) ids = await meta.artifactIdsByTag(tag)
    if (favOnly) ids = ids ? ids.filter((id) => favorites.has(id)) : favIds
    if (ids && ids.length === 0) return c.json({ artifacts: [], next_cursor: null })

    const rows = await meta.listArtifacts({ limit: limit + 1, cursor, q, ids })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const next_cursor = hasMore ? page[page.length - 1].created_at : null

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
    const [total, tags, favIds] = await Promise.all([
      meta.countArtifacts(),
      meta.tagCounts(),
      me ? meta.listUserFavoriteIds(me.id) : Promise.resolve([]),
    ])
    tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    return c.json({ total, favorites: favIds.length, tags })
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
      open_proposals: proposals.filter((p) => p.state === "open").length,
      proposals_total: proposals.filter((p) => p.state !== "withdrawn").length,
    })
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

    const me = await currentUser(c)
    const author = me ? (me.name ?? me.email) : str(body.author) || "anonymous"
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

    const me = await currentUser(c)
    const author = me
      ? (me.name ?? me.email)
      : typeof body.author === "string" && body.author
        ? body.author
        : "anonymous"
    const created = await meta.createComment({
      id,
      artifact_id: artifact.id,
      thread_id: threadId,
      base_version: baseVersion,
      path: typeof body.path === "string" ? body.path : null,
      anchor,
      body_md: body.body_md,
      author,
    })
    bus.publish(artifact.id, { type: "comment.created", comment: created })
    await notify(artifact, "comment.created", {
      author: created.author,
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
  // The signed-in actor's display name, or null on an open (no-auth) instance.
  const actorName = async (c: Context): Promise<string | null> => {
    const me = await currentUser(c)
    return me ? (me.name ?? me.email) : null
  }

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
      viewer = me.name ?? me.email
      kind = "user"
    } else {
      let vid = getCookie(c, "dock_vid")
      if (!vid) {
        vid = newId("v")
        setCookie(c, "dock_vid", vid, {
          path: "/",
          maxAge: 60 * 60 * 24 * 365,
          httpOnly: true,
          sameSite: "Lax",
        })
      }
      viewer = vid
      kind = "anon"
    }
    const body = (await c.req.json().catch(() => ({}))) as { version?: number }
    const version = Number.isInteger(body.version)
      ? (body.version as number)
      : artifact.current_version
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
    return c.json(await meta.viewStats(artifact.id))
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
    const n = m[2] ? Number(m[2]) : artifact.current_version
    const version = await meta.getVersion(artifact.id, n)
    if (!version) return c.text(`no version ${n}`, 404)
    const versions = await meta.listVersions(artifact.id)
    const rawSrc = `/raw/${artifact.short_id}/v/${n}/index.html`
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

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)

const visibilityOf = (v: unknown): Visibility | undefined =>
  typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v)
    ? (v as Visibility)
    : undefined

export { artifactUrl }
