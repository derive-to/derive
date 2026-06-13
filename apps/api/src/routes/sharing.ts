import { isRole, newId, type Role } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

/** Per-artifact role overrides (a share). Managing shares requires `share`
 *  (editor+, GDocs model); the share's role beats the caller's workspace baseline. */
export const sharingRoutes = (ctx: AppContext) => {
  const { meta, defaultRole, anonLocked, authorize } = ctx
  const app = new Hono()

  app.get("/v1/artifacts/:shortId/members", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    // The member list (collaborator emails/names) is not public: hide it from
    // anonymous visitors even on a public link. Authenticated readers still see it.
    if (await anonLocked(c, artifact)) return fail(c, 404, "not found")
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
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({
        email: z.string().min(1, "an email is required"),
        role: z.custom<Role>(isRole, "a valid role is required"),
      }),
    )
    if (b instanceof Response) return b
    const user = await meta.findUserByEmail(b.email.trim())
    if (!user) return fail(c, 404, "no Dock user with that email")
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
    if (!artifact) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    await meta.removeArtifactMember(artifact.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  return app
}
