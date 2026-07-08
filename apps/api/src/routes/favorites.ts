import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

/** Favorites (personal stars) + tags (workspace browse metadata). */
export const favoriteRoutes = (ctx: AppContext) => {
  const { meta, requireUser, requireArtifact, authorize } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  // Favorites are personal: any user who can read the artifact can star it.
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/artifacts/{shortId}/favorite",
      tags: ["Favorites"],
      summary: "Star an artifact.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "Starred.",
          content: { "application/json": { schema: z.object({ favorite: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      await meta.setFavorite(artifact.id, me.id)
      return c.json({ favorite: true })
    },
  )
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{shortId}/favorite",
      tags: ["Favorites"],
      summary: "Unstar an artifact.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "Unstarred.",
          content: { "application/json": { schema: z.object({ favorite: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const artifact = await meta.getByShortId(c.req.param("shortId"))
      if (!artifact) return bail(fail(c, 404, "not found"))
      await meta.removeFavorite(artifact.id, me.id)
      return c.json({ favorite: false })
    },
  )

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
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/artifacts/{shortId}/tags",
      tags: ["Favorites"],
      summary: "Set an artifact's browse tags (editors).",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The normalized tags.",
          content: { "application/json": { schema: z.object({ tags: z.array(z.string()) }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      if (!(await authorize(c, "publish", artifact))) return bail(fail(c, 403, "forbidden"))
      const body = await readJson(c, z.object({ tags: z.unknown().optional() }))
      if (body instanceof Response) return bail(body)
      const tags = normalizeTags(body.tags)
      await meta.setArtifactTags(artifact.id, tags)
      return c.json({ tags })
    },
  )

  return app
}
