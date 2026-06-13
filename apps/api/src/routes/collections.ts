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
      return c.json({ error: "unauthenticated" }, 401)
    return c.json({ collections: await meta.listCollections(await activeWorkspace(c)) })
  })
  app.post("/v1/collections", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return c.json({ error: "forbidden" }, 403)
    const me = await currentUser(c)
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    const title = (body.title ?? "").trim().slice(0, 120)
    if (!title) return c.json({ error: "title required" }, 400)
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
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "publish"))) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    return c.json(await meta.updateCollection(col.id, { title: body.title?.trim().slice(0, 120) }))
  })
  app.delete("/v1/collections/:id", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.deleteCollection(col.id)
    return c.body(null, 204)
  })
  app.put("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "publish"))) return c.json({ error: "forbidden" }, 403)
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art) return c.json({ error: "artifact not found" }, 404)
    await meta.addCollectionItem(col.id, art.id)
    return c.json({ ok: true })
  })
  app.delete("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "publish"))) return c.json({ error: "forbidden" }, 403)
    const art = await meta.getByShortId(c.req.param("shortId"))
    if (!art) return c.json({ error: "artifact not found" }, 404)
    await meta.removeCollectionItem(col.id, art.id)
    return c.body(null, 204)
  })
  app.get("/v1/collections/:id/members", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col || (await collectionRole(c, col)) === null) return c.json({ error: "not found" }, 404)
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
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string }
    if (!b.email || !isRole(b.role))
      return c.json({ error: "email and a valid role are required" }, 400)
    const user = await meta.findUserByEmail(b.email.trim())
    if (!user) return c.json({ error: "no Dock user with that email" }, 404)
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
    if (!col) return c.json({ error: "not found" }, 404)
    if (!(await canManageCollection(c, col, "manage"))) return c.json({ error: "forbidden" }, 403)
    await meta.removeCollectionMember(col.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  return app
}
