import {
  type Action,
  type CollectionRecord,
  isRole,
  newId,
  type Role,
  roleAllows,
} from "@dock/core"
import { type Context, Hono } from "hono"
import type { AppContext } from "../context"
import { safeEqual } from "../lib/crypto"
import { fail } from "../lib/http"

/** Collections: shareable groups of artifacts. A member's role on a collection
 *  propagates to every artifact inside it (see collectionRolesForArtifact). */
export const collectionRoutes = (ctx: AppContext) => {
  const { meta, deps, open, bearer, currentUser, activeWorkspace, workspaceCan } = ctx
  const app = new Hono()

  // A user's role on a collection: creator/member role, token/open → owner.
  const collectionRole = async (c: Context, col: CollectionRecord): Promise<Role | null> => {
    if (deps.token && safeEqual(bearer(c), deps.token)) return "owner"
    const me = await currentUser(c)
    if (!me) return open ? "owner" : null
    if (col.created_by === me.id) return "owner"
    const m = await meta.getCollectionMember(col.id, me.id)
    return m?.role ?? (open ? "owner" : null)
  }
  const canManageCollection = async (c: Context, col: CollectionRecord, action: Action) =>
    roleAllows((await collectionRole(c, col)) ?? "viewer", action)

  app.get("/v1/collections", async (c) => {
    if (!(await currentUser(c)) && deps.token && !safeEqual(bearer(c), deps.token))
      return fail(c, 401, "unauthenticated")
    return c.json({ collections: await meta.listCollections(await activeWorkspace(c)) })
  })
  app.post("/v1/collections", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return fail(c, 403, "forbidden")
    const me = await currentUser(c)
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    const title = (body.title ?? "").trim().slice(0, 120)
    if (!title) return fail(c, 400, "title required")
    const createdBy = me?.id ?? "anon"
    const col = await meta.createCollection({
      id: newId("col"),
      org_id: await activeWorkspace(c),
      title,
      created_by: createdBy,
    })
    // The creator joins as owner: they manage it, and (like any member) their
    // role propagates to the collection's artifacts.
    await meta.setCollectionMember({
      id: newId("cm"),
      collection_id: col.id,
      user_id: createdBy,
      role: "owner",
    })
    return c.json(col, 201)
  })
  app.patch("/v1/collections/:id", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "publish"))) return fail(c, 403, "forbidden")
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    return c.json(await meta.updateCollection(col.id, { title: body.title?.trim().slice(0, 120) }))
  })
  app.delete("/v1/collections/:id", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "manage"))) return fail(c, 403, "forbidden")
    await meta.deleteCollection(col.id)
    return c.body(null, 204)
  })
  app.put("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "publish"))) return fail(c, 403, "forbidden")
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art) return fail(c, 404, "artifact not found")
    await meta.addCollectionItem(col.id, art.id)
    return c.json({ ok: true })
  })
  app.delete("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "publish"))) return fail(c, 403, "forbidden")
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art) return fail(c, 404, "artifact not found")
    await meta.removeCollectionItem(col.id, art.id)
    return c.body(null, 204)
  })
  app.get("/v1/collections/:id/members", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col || (await collectionRole(c, col)) === null) return fail(c, 404, "not found")
    const rows = await meta.listCollectionMembers(col.id)
    const users = await meta.getUsers(rows.map((r) => r.user_id))
    const byId = new Map(users.map((u) => [u.id, u]))
    return c.json({
      created_by: col.created_by,
      members: rows.map((r) => ({
        user_id: r.user_id,
        email: byId.get(r.user_id)?.email ?? null,
        name: byId.get(r.user_id)?.name ?? null,
        role: r.role,
      })),
    })
  })
  app.put("/v1/collections/:id/members", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "manage"))) return fail(c, 403, "forbidden")
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string }
    if (!b.email || !isRole(b.role)) return fail(c, 400, "email and a valid role are required")
    const user = await meta.findUserByEmail(b.email.trim())
    if (!user) return fail(c, 404, "no Dock user with that email")
    await meta.setCollectionMember({
      id: newId("cm"),
      collection_id: col.id,
      user_id: user.id,
      role: b.role,
    })
    return c.json({ user_id: user.id, email: user.email, name: user.name, role: b.role }, 201)
  })
  app.delete("/v1/collections/:id/members/:userId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "manage"))) return fail(c, 403, "forbidden")
    await meta.removeCollectionMember(col.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  return app
}
