import { can, newId } from "@dock/core"
import { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson, VIEW_DEDUP_MS } from "../lib/http"

/** View recording (de-duped, owner self-views excluded) + per-artifact stats. */
export const analyticsRoutes = (ctx: AppContext) => {
  const { meta, deps, analyticsOn, currentUser, actorFor, anonLocked, authorize } = ctx
  const app = new Hono()

  // Record a view. The viewer is the logged-in user, or a stable anonymous id
  // kept in a cookie (so unique-viewer counts work for public/link artifacts).
  app.post("/v1/artifacts/:shortId/view", async (c) => {
    if (!analyticsOn) return c.body(null, 204)
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || artifact.current_version === 0 || !(await authorize(c, "read", artifact)))
      return fail(c, 404, "not found")
    // The owner's own opens aren't audience — don't count them (Notion/Docs do
    // the same). `manage` requires the owner role, so this is exactly "is owner";
    // editors/commenters/viewers and anonymous openers still count.
    const actor = await actorFor(c, artifact)
    if (actor.kind !== "anon" && can(actor, "manage", artifact.visibility)) return c.body(null, 204)
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
    const body = await readJson(c, z.object({}).catchall(z.unknown()))
    if (body instanceof Response) return body
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
    if (!analyticsOn) return fail(c, 404, "analytics disabled")
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    // View analytics are for collaborators, not anonymous link-visitors.
    if (await anonLocked(c, artifact)) return fail(c, 404, "not found")
    const stats = await meta.viewStats(artifact.id)
    // Recent user-viewers are stored by id (stable); resolve to name + avatar.
    const userIds = stats.recent.filter((r) => r.kind === "user").map((r) => r.viewer)
    if (userIds.length) {
      const byId = new Map((await meta.getUsers(userIds)).map((u) => [u.id, u]))
      stats.recent = stats.recent.map((r) => {
        if (r.kind !== "user") return r
        const u = byId.get(r.viewer)
        return { ...r, viewer: u ? (u.name ?? u.email) : "Someone", avatar: u?.image ?? null }
      })
    }
    return c.json(stats)
  })

  return app
}
