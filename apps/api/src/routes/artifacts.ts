import {
  type ArtifactRecord,
  can,
  diffLines,
  effectiveRole,
  formatDiff,
  groupSessions,
  newId,
  PublishError,
  publish,
  renderMarkdown,
  toJson,
} from "@dock/core"
import { type Context, Hono } from "hono"
import { setCookie } from "hono/cookie"
import { z } from "zod"
import type { AppContext } from "../context"
import { hashPassword, safeEqual, unlockCookie, unlockToken, verifyPassword } from "../lib/crypto"
import {
  DEFAULT_WORKSPACE_NAME,
  fail,
  MAX_UPLOAD_BYTES,
  readJson,
  str,
  TOMBSTONE,
  visibilityOf,
} from "../lib/http"

/** The artifact lifecycle: browse + summary, publish/republish, detail, restore,
 *  source read-back, and version diffs. */
export const artifactRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    deps,
    analyticsOn,
    versionWindowMs,
    bus,
    notify,
    bearer,
    currentUser,
    actingUser,
    activeWorkspace,
    actorFor,
    authorize,
    workspaceCan,
    limited,
    overStorage,
    publishLimiter,
    unlockLimiter,
    sourceText,
  } = ctx
  const app = new Hono()

  // Newest-first, keyset-paginated (?cursor=<created_at>&limit=N), with optional
  // server-side ?q= (title search), ?tag=, and ?favorite=true. Returns
  // { artifacts, next_cursor }. tag/favorite resolve to an id set first.
  app.get("/v1/artifacts", async (c) => {
    const me = await currentUser(c)
    if (!me && deps.token && !safeEqual(bearer(c), deps.token))
      return fail(c, 401, "unauthenticated")
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
    if (!me && deps.token && !safeEqual(bearer(c), deps.token))
      return fail(c, 401, "unauthenticated")
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

  // ---- Publish ----------------------------------------------------------

  const handlePublish = async (c: Context, shortId?: string) => {
    // Republishing a version needs publish rights on that artifact; creating a
    // new one needs publish rights at the workspace level.
    let existing: ArtifactRecord | null = null
    if (shortId) {
      existing = await meta.getByShortId(shortId)
      if (!existing) return fail(c, 404, "not found")
      if (!(await authorize(c, "publish", existing))) return fail(c, 403, "forbidden")
      // A GitHub-synced artifact is read-only in Dock: GitHub is the source of
      // truth, so a republish would be silently overwritten on the next sync.
      // Edit it in the repo instead.
      if ((await meta.managedArtifactIds(existing.org_id)).includes(existing.id))
        return fail(c, 409, "managed by GitHub sync — edit this file in the repo")
    } else if (!(await workspaceCan(c, "publish"))) {
      return fail(c, 403, "forbidden")
    }
    // Quotas are per-workspace: a republish counts against the artifact's own
    // org, a new artifact against the caller's active workspace.
    const org = existing ? existing.org_id : await activeWorkspace(c)
    const rl = await limited(c, publishLimiter)
    if (rl) return rl
    // A new artifact counts against the artifact cap; republishes don't.
    if (!shortId && deps.maxArtifacts && (await meta.countArtifacts(org)) >= deps.maxArtifacts)
      return fail(c, 409, "artifact quota reached")
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")

    const body = await c.req.parseBody()
    const file = body["file"]
    if (!(file instanceof File)) return fail(c, 400, "multipart field 'file' required")

    const bytes = new Uint8Array(await file.arrayBuffer())
    // The content-length header is advisory (a client can omit/understate it),
    // so re-check the actual buffered size — the hard cap before anything stores.
    if (bytes.length > MAX_UPLOAD_BYTES) return fail(c, 413, "upload too large")
    if (await overStorage(org, bytes.length)) return fail(c, 413, "storage quota exceeded")
    const isBundle =
      /\.zip$/i.test(file.name) ||
      body["kind"] === "bundle" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5))

    // `password` visibility on a NEW artifact must carry a password to hash; a
    // republish keeps whatever the artifact already has (publish() never re-creates
    // the artifact, only adds a version, so visibility/password are set-on-create).
    const visibility = visibilityOf(body["visibility"])
    const password = str(body["password"])
    if (!shortId && visibility === "password" && !password)
      return fail(c, 400, "a password is required for password visibility")
    const passwordHash = visibility === "password" && password ? hashPassword(password) : undefined

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
          // Author is the authenticated identity (signed-in user or agent), never a
          // client-supplied field — a logged-in publish must be attributed to that
          // person. Anonymous callers can't reach this route at all, so a publish is
          // always attributed to a real principal (the token's optional `author`
          // label is the one headless exception).
          author: (await actingUser(c))?.name ?? str(body["author"]),
          name: str(body["name"]),
          orgId: org,
          visibility,
          passwordHash,
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
      if (err instanceof PublishError) return fail(c, err.statusCode as 400, err.message)
      throw err
    }
  }

  app.post("/v1/artifacts", (c) => handlePublish(c))
  app.post("/v1/artifacts/:shortId/versions", (c) => handlePublish(c, c.req.param("shortId")))

  app.get("/v1/artifacts/:shortId", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    // For a missing artifact, fall back to the most restrictive visibility so
    // an anonymous probe can't learn anything (a non-member gets no access).
    const actor = await actorFor(c, artifact ?? ({ id: "", visibility: "org" } as ArtifactRecord))
    if (!artifact) return fail(c, 404, "not found")
    if (!can(actor, "read", artifact.visibility))
      // A password artifact isn't hidden, it's lockable: tell the client to prompt
      // for the password (401) rather than claim it doesn't exist (404).
      return artifact.visibility === "password"
        ? fail(c, 401, "password required")
        : fail(c, 404, "not found")
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
      // Mirrored from a GitHub sync source → read-only in Dock (the client hides
      // Edit/Propose; the publish/propose routes also refuse it server-side).
      managed: (await meta.managedArtifactIds(artifact.org_id)).includes(artifact.id),
    })
  })

  // Change general access (visibility) after publish — the Share dialog's
  // "general access" control. Editors+ (share), per the GDocs model. Enabling
  // `password` needs a password (or keeps the existing one); any other visibility
  // clears the stored hash.
  app.patch("/v1/artifacts/:shortId/visibility", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({ visibility: z.string(), password: z.string().optional() }),
    )
    if (b instanceof Response) return b
    const visibility = visibilityOf(b.visibility)
    if (!visibility) return fail(c, 400, "invalid visibility")
    let passwordHash: string | null = null
    if (visibility === "password") {
      if (b.password) passwordHash = hashPassword(b.password)
      else if (artifact.visibility === "password" && artifact.password_hash)
        passwordHash = artifact.password_hash
      else return fail(c, 400, "a password is required for password visibility")
    }
    await meta.setVisibility(artifact.id, visibility, passwordHash)
    return c.json({ visibility })
  })

  // Unlock a `password` artifact: verify the password and drop a cookie whose
  // value is derived from the server-only hash (so it can't be forged and dies if
  // the password changes). Brute force is bounded by a dedicated tight limiter
  // (10 attempts/min per caller), well below the lenient global /v1 write cap.
  // authz-exempt: the password itself is the gate; any visitor may attempt unlock.
  app.post("/v1/artifacts/:shortId/unlock", async (c) => {
    const over = await limited(c, unlockLimiter)
    if (over) return over
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.visibility !== "password" || !artifact.password_hash)
      return fail(c, 404, "not found")
    const b = await readJson(c, z.object({ password: z.string().min(1) }))
    if (b instanceof Response) return b
    if (!verifyPassword(b.password, artifact.password_hash)) return fail(c, 401, "wrong password")
    setCookie(
      c,
      unlockCookie(artifact.short_id),
      unlockToken(artifact.id, artifact.password_hash),
      {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        httpOnly: true,
        sameSite: deps.crossSite ? "None" : "Lax",
        secure: deps.crossSite || new URL(deps.baseUrl).protocol === "https:",
      },
    )
    return c.json({ ok: true })
  })

  // Restore a past version: re-point a new revision at its stored blob (no
  // re-upload, works for files and bundles). History is never rewritten.
  app.post("/v1/artifacts/:shortId/restore", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "publish", artifact))) return fail(c, 403, "forbidden")
    const body = await readJson(c, z.object({ version: z.number().int("version required") }))
    if (body instanceof Response) return body
    const src = await meta.getVersion(artifact.id, body.version)
    if (!src) return fail(c, 404, `no version ${body.version}`)
    const me = await currentUser(c)
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key: src.blob_key,
      content_type: src.content_type,
      // Same blob as the restored version — carry its size so the storage meter
      // stays consistent (and dedup'd, since it reuses the same blob_key).
      size_bytes: src.size_bytes,
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

  // Source read-back for machines: returns an artifact's text content for any
  // version, as plain text (?v=N selects a version; defaults to current).
  app.get("/v1/artifacts/:shortId/content", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return fail(c, 404, "not found")
    if (artifact.removed_at) return fail(c, 410, TOMBSTONE)
    const v = c.req.query("v") ? Number(c.req.query("v")) : artifact.current_version
    if (!Number.isInteger(v)) return fail(c, 400, "bad version")
    const version = await meta.getVersion(artifact.id, v)
    if (!version) return fail(c, 404, `no version ${v}`)
    const src = await sourceText(version)
    if (src === null) return fail(c, 500, "blob missing")
    c.header("Content-Type", "text/plain; charset=utf-8")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Dock-Version", String(v))
    c.header("X-Dock-Kind", artifact.kind)
    return c.body(src)
  })

  // Live editor preview: render a markdown draft to the exact published HTML.
  // Stateless (renders the caller's text, stores nothing) and signed-in only, so
  // it can't be used as an anonymous render farm. HTML drafts preview in the
  // browser, so this is markdown-only.
  app.post("/v1/preview", async (c) => {
    if (!(await actingUser(c))) return fail(c, 401, "unauthenticated")
    const body = await readJson(
      c,
      z.object({ source: z.string().max(500_000), title: z.string().max(300).nullish() }),
    )
    if (body instanceof Response) return body
    return c.json({ html: await renderMarkdown(body.source, body.title ?? null) })
  })

  // Line diff between two versions. Defaults to (current-1 → current).
  // ?format=json returns the structured ops; otherwise unified-style text.
  app.get("/v1/artifacts/:shortId/diff", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return fail(c, 404, "not found")
    const cur = artifact.current_version
    const from = c.req.query("from") ? Number(c.req.query("from")) : Math.max(1, cur - 1)
    const to = c.req.query("to") ? Number(c.req.query("to")) : cur
    if (!Number.isInteger(from) || !Number.isInteger(to)) return fail(c, 400, "bad version")
    const [vf, vt] = [
      await meta.getVersion(artifact.id, from),
      await meta.getVersion(artifact.id, to),
    ]
    if (!vf || !vt) return fail(c, 404, "version not found")
    const [a, b] = [await sourceText(vf), await sourceText(vt)]
    if (a === null || b === null) return fail(c, 500, "blob missing")
    const ops = diffLines(a, b)

    c.header("Access-Control-Allow-Origin", "*")
    c.header("X-Dock-From", String(from))
    c.header("X-Dock-To", String(to))
    if (c.req.query("format") === "json") return c.json({ from, to, ops })
    c.header("Content-Type", "text/plain; charset=utf-8")
    return c.body(formatDiff(ops))
  })

  return app
}
