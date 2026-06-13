import { isRole, newId } from "@dock/core"
import { Hono } from "hono"
import type { AppContext } from "../context"

/** Per-artifact role overrides (a share). Managing shares requires `manage` on
 *  the artifact; the share's role beats the caller's workspace baseline. */
export const sharingRoutes = (ctx: AppContext) => {
  const { meta, defaultRole, authorize } = ctx
  const app = new Hono()

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

  return app
}
