import { newId, type Role } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { DEFAULT_WORKSPACE_NAME, fail, isWorkspaceRole, readJson } from "../lib/http"
import { resolveUserRef } from "../lib/resolve-user"

/** The workspace itself: name + members (Admin-managed), plus multi-workspace
 *  list / create / switch. A workspace always keeps at least one Admin. */
export const workspaceRoutes = (ctx: AppContext) => {
  const { meta, currentUser, activeWorkspace, setWsCookie, workspaceRole, workspaceCan } = ctx
  const app = new Hono()

  // A workspace must always keep at least one Admin, so it stays manageable:
  // demoting or removing the last owner is refused.
  const isLastOwner = async (orgId: string, userId: string): Promise<boolean> => {
    const owners = (await meta.listMemberships(orgId)).filter((m) => m.role === "owner")
    return owners.length <= 1 && owners.some((m) => m.user_id === userId)
  }

  const memberJson = (
    m: { user_id: string; role: Role },
    dir: Map<string, { username: string | null; name: string | null; profession?: string | null }>,
  ) => ({
    user_id: m.user_id,
    handle: dir.get(m.user_id)?.username ?? null,
    name: dir.get(m.user_id)?.name ?? null,
    profession: dir.get(m.user_id)?.profession ?? null,
    role: m.role,
  })

  // The workspace name, the caller's role, and the full member directory.
  app.get("/v1/workspace", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    const [ws, members] = await Promise.all([meta.getWorkspace(org), meta.listMemberships(org)])
    const users = await meta.getUsers(members.map((m) => m.user_id))
    const dir = new Map(users.map((u) => [u.id, u]))
    return c.json({
      id: org,
      name: ws?.name ?? DEFAULT_WORKSPACE_NAME,
      role,
      multi: true,
      members: members.map((m) => memberJson(m, dir)),
    })
  })

  // Rename the workspace (Admin only).
  app.patch("/v1/workspace", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
    )
    if (b instanceof Response) return b
    const name = b.name.trim().slice(0, 80)
    const ws = await meta.setWorkspace(await activeWorkspace(c), name)
    return c.json({ name: ws.name })
  })

  // Add a member by email, or update their role (Admin only).
  app.put("/v1/workspace/members", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z
        .object({
          user: z.string().min(1).optional(),
          email: z.string().min(1).optional(),
          role: z.custom<Role>(isWorkspaceRole, "a valid role is required"),
        })
        .refine((v) => v.user || v.email, "a username or email is required"),
    )
    if (b instanceof Response) return b
    const id = await resolveUserRef(meta, (b.user ?? b.email) as string)
    const [user] = id ? await meta.getUsers([id]) : []
    if (!user) return fail(c, 404, "no Dock user with that username or email")
    const org = await activeWorkspace(c)
    // This route both adds and re-roles, so it must honor the same last-Admin
    // guard as PATCH — otherwise an Admin could demote the sole Admin via PUT.
    const existing = await meta.getMembership(org, user.id)
    if (existing?.role === "owner" && b.role !== "owner" && (await isLastOwner(org, user.id)))
      return fail(c, 409, "the workspace needs at least one admin")
    await meta.setMembership({
      id: existing?.id ?? newId("m"),
      org_id: org,
      user_id: user.id,
      role: b.role,
    })
    return c.json(
      {
        user_id: user.id,
        handle: user.username,
        name: user.name,
        profession: user.profession ?? null,
        role: b.role,
      },
      201,
    )
  })

  // Change a member's role (Admin only; can't strip the last Admin).
  app.patch("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const userId = c.req.param("userId")
    const b = await readJson(
      c,
      z.object({ role: z.custom<Role>(isWorkspaceRole, "a valid role is required") }),
    )
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return fail(c, 404, "not a member")
    if (existing.role === "owner" && b.role !== "owner" && (await isLastOwner(org, userId)))
      return fail(c, 409, "the workspace needs at least one admin")
    await meta.setMembership({ id: existing.id, org_id: org, user_id: userId, role: b.role })
    return c.json({ user_id: userId, role: b.role })
  })

  // Remove a member (Admin only; can't remove the last Admin).
  app.delete("/v1/workspace/members/:userId", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const userId = c.req.param("userId")
    const org = await activeWorkspace(c)
    const existing = await meta.getMembership(org, userId)
    if (!existing) return c.body(null, 204)
    if (existing.role === "owner" && (await isLastOwner(org, userId)))
      return fail(c, 409, "the workspace needs at least one admin")
    await meta.removeMembership(org, userId)
    return c.body(null, 204)
  })

  // ---- Integration settings (enable/disable each channel) -----------------
  // The workspace's integration toggles (email / GitHub post + mirror / Slack).
  // Any member can read them; only an Admin can change them.
  app.get("/v1/workspace/settings", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    return c.json(await meta.getOrgSettings(await activeWorkspace(c)))
  })

  app.patch("/v1/workspace/settings", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z
        .object({
          emailNotifications: z.boolean(),
          githubPostComments: z.boolean(),
          githubMirrorComments: z.boolean(),
          githubPreviewLink: z.boolean(),
          slackPost: z.boolean(),
        })
        .partial(),
    )
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    // Merge over current (so a partial PATCH only flips the keys it sends).
    const next = { ...(await meta.getOrgSettings(org)), ...b }
    await meta.setOrgSettings(org, next)
    return c.json(next)
  })

  // ---- Workspaces: list / create / switch (multi-workspace) --------------
  // The caller's workspaces (just the one in single mode). `active` is the id of
  // the workspace this request resolved to.
  app.get("/v1/workspaces", async (c) => {
    const role = await workspaceRole(c)
    if (role === null) return fail(c, 401, "unauthenticated")
    const active = await activeWorkspace(c)
    const me = await currentUser(c)
    if (!me) {
      const ws = await meta.getWorkspace(active)
      return c.json({
        multi: true,
        active,
        workspaces: [{ id: active, name: ws?.name ?? DEFAULT_WORKSPACE_NAME, role }],
      })
    }
    const mine = await meta.listWorkspaces(me.id)
    return c.json({
      multi: true,
      active,
      workspaces: mine.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    })
  })

  // Create a workspace. The creator becomes its Admin and is switched in.
  app.post("/v1/workspaces", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const b = await readJson(
      c,
      z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
    )
    if (b instanceof Response) return b
    const name = b.name.trim().slice(0, 80)
    const id = newId("ws")
    await meta.setWorkspace(id, name)
    await meta.setMembership({ id: newId("m"), org_id: id, user_id: me.id, role: "owner" })
    setWsCookie(c, id)
    return c.json({ id, name, role: "owner" }, 201)
  })

  // Switch the active workspace. Must be a member.
  app.post("/v1/workspace/switch", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const b = await readJson(c, z.object({}).catchall(z.unknown()))
    if (b instanceof Response) return b
    const id = typeof b.id === "string" ? b.id : ""
    if (!id || !(await meta.getMembership(id, me.id)))
      return fail(c, 403, "not a member of that workspace")
    setWsCookie(c, id)
    return c.json({ active: id })
  })

  // Delete a workspace you own. Guarded: Admin only, never your last workspace, and
  // it must be empty (no artifacts) — we don't cascade-delete content. If it was the
  // active workspace, switch to another one you own.
  app.delete("/v1/workspaces/:id", async (c) => {
    const me = await currentUser(c)
    if (!me) return fail(c, 401, "unauthenticated")
    const id = c.req.param("id")
    const mem = await meta.getMembership(id, me.id)
    if (mem?.role !== "owner") return fail(c, 403, "only an admin can delete this workspace")
    const mine = await meta.listWorkspaces(me.id)
    if (mine.length <= 1) return fail(c, 409, "you need at least one workspace")
    if ((await meta.countArtifacts(id)) > 0)
      return fail(c, 409, "this workspace still has artifacts — delete or move them first")
    const wasActive = (await activeWorkspace(c)) === id
    await meta.deleteWorkspace(id)
    const next = mine.find((w) => w.id !== id)?.id ?? null
    if (wasActive && next) setWsCookie(c, next)
    return c.json({ deleted: id, active: wasActive ? next : null })
  })

  return app
}
