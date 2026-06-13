import { Hono } from "hono"
import type { AppContext } from "../context"

/** Favorites (personal stars) + tags (workspace browse metadata). */
export const favoriteRoutes = (ctx: AppContext) => {
  const { meta, currentUser, authorize } = ctx
  const app = new Hono()

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

  return app
}
