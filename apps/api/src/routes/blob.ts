import { Hono } from "hono"
import type { AppContext } from "../context"
import { withEdgeCache } from "../lib/edge-cache"
import { RAW_HEADERS, toBody } from "../lib/http"

const HASH_RE = /^([0-9a-f]{64})(?:\.[a-zA-Z0-9]+)?$/

/**
 * Public capability URLs for staged image assets (POST /v1/assets): the Slack/
 * Notion file-link model. `:file` is a sha256 hash with an optional cosmetic
 * extension (ignored — Content-Type always comes from the `asset` row, never the
 * client-supplied extension, so a mismatched one can't spoof the served type).
 *
 * Deliberately unauthenticated: unguessable (you'd need the bytes to know the
 * hash) but not access-gated, unlike an artifact's own visibility. Only hashes
 * with an `asset` row are servable — the blob store also holds bundle manifests
 * and page HTML, and that row is the allowlist keeping this route from ever
 * serving those (see routes/assets.ts, where the row is written at upload).
 */
export const blobRoutes = (ctx: AppContext) => {
  const { meta, blobs } = ctx
  const app = new Hono()

  app.get("/blob/:file", async (c) => {
    const m = HASH_RE.exec(c.req.param("file"))
    if (!m) return c.text("not found", 404, RAW_HEADERS)
    const hash = m[1] as string
    // SERVED FROM THE EDGE ON A REPEAT HIT, and this is the safest possible place to start doing
    // that: the URL is a sha256 OF THE BYTES, so it is content-addressed and can never come to
    // mean something else, and the route is deliberately unauthenticated — there is no
    // per-caller variation for a URL-keyed cache to get wrong. Every image and font in every
    // published page comes through here, and each hit was paying a Postgres round trip for the
    // `asset` row plus an R2 fetch, to return bytes already marked `immutable`.
    return withEdgeCache(c.req.raw, async () => {
      const row = await meta.getAsset(hash)
      if (!row) return c.text("not found", 404, RAW_HEADERS)
      const data = await blobs.get(hash)
      if (!data) return c.text("blob missing", 500)
      return c.body(toBody(data), 200, { ...RAW_HEADERS, "Content-Type": row.content_type })
    })
  })

  return app
}
