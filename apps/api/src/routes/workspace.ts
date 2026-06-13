import { newId, type Role } from "@dock/core"
import { Hono } from "hono"
import type { AppContext } from "../context"
import { DEFAULT_WORKSPACE_NAME, isWorkspaceRole } from "../lib/http"

/** The workspace itself: name + members (Admin-managed), plus multi-workspace
 *  list / create / switch. A workspace always keeps at least one Admin. */
export const workspaceRoutes = (ctx: AppContext) => {
  const { meta, multi, currentUser, activeWorkspace, setWsCookie, workspaceRole, workspaceCan } =
    ctx
  const app = new Hono()

  // A workspace must always keep at least one Admin, so it stays manageable:
  // demoting or removing the last owner is refused.
  const isLastOwner = async (orgId: string, userId: string): Promise<boolean> => {
    const owners = (await meta.listMemberships(orgId)).filter((m) => m.role === "owner")
    return owners.length <= 1 && owners.some((m) => m.user_id === userId)
  }

  const memberJson = (
    m: { user_id: string; role: Role },
    dir: Map<string, { email: string; name: string | null }>,
  ) => ({
    user_id: m.user_id,
    email: dir.get(m.user_id)?.email ?? null,
    name: dir.get(m.user_id)?.name ?? null,
    role: m.role,
  })

  // The workspace name, the caller's role, and the full member directory.
  app.get("/v1/workspace", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return c.json({ error: "unauthenticated" }, 401)
    const org = await activeWorkspace(c)
    const [ws, members] = await Promise.all([meta.getWorkspace(org), meta.listMemberships(org)])
    const users = await meta.getUsers(members.map((m) => m.user_id))
    const dir = new Map(users.map((u) => [u.id, u]))
    return c.json({
      id: org,
      name: ws?.name ?? DEFAULT_WORKSPACE_NAME,
      role,
      multi,
      members: members.map((m) => memberJson(m, dir)),
    })
  })

  // Rename the workspace (Admin only).
  app.patch("/v1/workspace", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown }
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : ""
    if (!name) return c.json({ error: "name required" }, 400)
    const ws = await meta.setWorkspace(await activeWorkspace(c), name)
    return c.json({ name: ws.name })
  })

  // Add a member by email, or update their role (Admin only).
  app.put("/v1/workspace/members", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: unknown }
    if (!b.email || !isWorkspaceRole(b.role))
      return c.json({ error: "email and a valid role are required" }, 400)
    const user = await meta.findUserByEmail(b.email.trim())
    if (!user) return c.json({ error: "no Dock user with that email" }, 404)
    const org = await activeWorkspace(c)
    // This route both adds and re-roles, so it must honor the same last-Admin
    // guard as PATCH — otherwise an Admin could demote the sole Admin via PUT.
    const existing = await meta.getMembership(org, user.id)
    if (existing?.role === "owner" && b.role !== "owner" && (await isLastOwner(org, user.id)))
      return c.json({ error: "the workspace needs at least one admin" }, 409)
    await meta.setMembership({
      id: existing?.id ?? newId("m"),
      org_id: org,
      user_id: user.id,
      role: b.role,
    })
    return c.json({ user_id: user.id, email: user.email, name: user.name, role: b.role }, 201)
  })

  // Change a member's role (Admin only; can't strip the last Admin).
  app.patch("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const userId = c.req.param("userId")
    const b = (await c.req.json().catch(() => ({}))) as { role?: unknown }
    if (!isWorkspaceRole(b.role)) return c.json({ error: "a valid role is required" }, 400)
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return c.json({ error: "not a member" }, 404)
    if (existing.role === "owner" && b.role !== "owner" && (await isLastOwner(org, userId)))
      return c.json({ error: "the workspace needs at least one admin" }, 409)
    await meta.setMembership({ id: existing.id, org_id: org, user_id: userId, role: b.role })
    return c.json({ user_id: userId, role: b.role })
  })

  // Remove a member (Admin only; can't remove the last Admin).
  app.delete("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return c.json({ error: "forbidden" }, 403)
    const userId = c.req.param("userId")
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return c.body(null, 204)
    if (existing.role === "owner" && (await isLastOwner(org, userId)))
      return c.json({ error: "the workspace needs at least one admin" }, 409)
    await meta.removeMembership(org, userId)
    return c.body(null, 204)
  })

  // ---- Workspaces: list / create / switch (multi-workspace) --------------
  // The caller's workspaces (just the one in single mode). `active` is the id of
  // the workspace this request resolved to.
  app.get("/v1/workspaces", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return c.json({ error: "unauthenticated" }, 401)
    const active = await activeWorkspace(c)
    const me = await currentUser(c)
    if (!multi || !me) {
      const ws = await meta.getWorkspace(active)
      return c.json({
        multi,
        active,
        workspaces: [{ id: active, name: ws?.name ?? DEFAULT_WORKSPACE_NAME, role }],
      })
    }
    const mine = await meta.listWorkspaces(me.id)
    return c.json({
      multi,
      active,
      workspaces: mine.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    })
  })

  // Create a workspace (multi only). The creator becomes its Admin and is switched in.
  app.post("/v1/workspaces", async (c) => {
    if (!multi) return c.json({ error: "multi-workspace is disabled" }, 403)
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown }
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : ""
    if (!name) return c.json({ error: "name required" }, 400)
    const id = newId("ws")
    await meta.setWorkspace(id, name)
    await meta.setMembership({ id: newId("m"), org_id: id, user_id: me.id, role: "owner" })
    setWsCookie(c, id)
    return c.json({ id, name, role: "owner" }, 201)
  })

  // Switch the active workspace (multi only). Must be a member.
  app.post("/v1/workspace/switch", async (c) => {
    if (!multi) return c.json({ error: "multi-workspace is disabled" }, 403)
    const me = await currentUser(c)
    if (!me) return c.json({ error: "unauthenticated" }, 401)
    const b = (await c.req.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof b.id === "string" ? b.id : ""
    if (!id || !(await meta.getMembership(id, me.id)))
      return c.json({ error: "not a member of that workspace" }, 403)
    setWsCookie(c, id)
    return c.json({ active: id })
  })

  return app
}
