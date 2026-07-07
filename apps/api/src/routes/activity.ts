import { Hono } from "hono"
import type { AppContext } from "../context"
import { fail } from "../lib/http"

/** The workspace Activity feed: everything recorded (publishes, comments, resolved
 *  threads, shares, proposal decisions, first reads) across every artifact, newest
 *  first. Read-only; the rows are written at each action's own route. */
export const activityRoutes = (ctx: AppContext) => {
  const { meta, activeWorkspace, workspaceRole } = ctx
  const app = new Hono()

  app.get("/v1/activity", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30))
    // Opaque compound cursor "<created_at>|<id>" — same shape as listArtifacts.
    const rawCursor = c.req.query("cursor")
    const sep = rawCursor?.indexOf("|") ?? -1
    const cursor =
      rawCursor && sep > 0
        ? { created_at: rawCursor.slice(0, sep), id: rawCursor.slice(sep + 1) }
        : undefined
    const items = await meta.listActivity(org, { limit: limit + 1, cursor })
    const hasMore = items.length > limit
    const page = hasMore ? items.slice(0, limit) : items
    const last = page[page.length - 1]
    const next_cursor = hasMore && last ? `${last.created_at}|${last.id}` : null
    return c.json({ items: page, next_cursor })
  })

  return app
}
