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
  toJson,
} from "@dock/core"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { safeEqual } from "../lib/crypto"
import { DEFAULT_WORKSPACE_NAME, MAX_UPLOAD_BYTES, str, TOMBSTONE, visibilityOf } from "../lib/http"

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
    activeWorkspace,
    actorFor,
    authorize,
    workspaceCan,
    limited,
    overStorage,
    publishLimiter,
    sourceText,
  } = ctx
  const app = new Hono()

  // Newest-first, keyset-paginated (?cursor=<created_at>&limit=N), with optional
  // server-side ?q= (title search), ?tag=, and ?favorite=true. Returns
  // { artifacts, next_cursor }. tag/favorite resolve to an id set first.
  app.get("/v1/artifacts", async (c) => {
    const me = await currentUser(c)
    if (!me && deps.token && !safeEqual(bearer(c), deps.token))
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
    if (!me && deps.token && !safeEqual(bearer(c), deps.token))
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
    const rl = await limited(c, publishLimiter)
    if (rl) return rl
    // A new artifact counts against the artifact cap; republishes don't.
    if (!shortId && deps.maxArtifacts && (await meta.countArtifacts()) >= deps.maxArtifacts)
      return c.json({ error: "artifact quota reached" }, 409)
    const len = Number(c.req.header("content-length") ?? 0)
    if (len > MAX_UPLOAD_BYTES) return c.json({ error: "upload too large" }, 413)

    const body = await c.req.parseBody()
    const file = body["file"]
    if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400)

    const bytes = new Uint8Array(await file.arrayBuffer())
    if (await overStorage(bytes.length)) return c.json({ error: "storage quota exceeded" }, 413)
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
    // For a missing artifact, fall back to the most restrictive visibility so
    // an anonymous probe can't learn anything (a non-member gets no access).
    const actor = await actorFor(c, artifact ?? ({ id: "", visibility: "org" } as ArtifactRecord))
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

  return app
}
