import {
  type Action,
  type CollectionRecord,
  isRole,
  newId,
  type Role,
  roleAllows,
} from "@derive/core"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { DEFAULT_WORKSPACE_NAME, fail, readJson } from "../lib/http"
import { resolveUserRef } from "../lib/resolve-user"

/** Collections: shareable groups of artifacts. A member's role on a collection
 *  propagates to every artifact inside it (see collectionRolesForArtifact). */
export const collectionRoutes = (ctx: AppContext) => {
  const {
    meta,
    isMember,
    isToken,
    currentUser,
    activeWorkspace,
    workspaceCan,
    authorize,
    collectionRole,
  } = ctx
  const app = new Hono()

  const canManageCollection = async (c: Context, col: CollectionRecord, action: Action) =>
    roleAllows((await collectionRole(c, col)) ?? "viewer", action)

  // Look up a collection and require `manage` on it (owner/creator/explicit
  // manager) — the shared gate for delete, member add/remove, and the
  // workspace share. Callers do `if (col instanceof Response) return col`.
  const requireManageable = async (
    c: Context,
    id: string,
  ): Promise<CollectionRecord | Response> => {
    const col = await meta.getCollection(id)
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "manage"))) return fail(c, 403, "forbidden")
    return col
  }

  app.get("/v1/collections", async (c) => {
    const me = await currentUser(c)
    if (!me && !isToken(c)) return fail(c, 401, "unauthenticated")
    const org = await activeWorkspace(c)
    // Collections are a workspace-internal organizer — only members (or the operator
    // token) see them. A non-member (incl. anon in open mode) gets an empty list, so
    // a workspace's collections can't be enumerated via a public artifact's workspace.
    if (!(await isMember(c, org))) return c.json({ collections: [] })
    // Tag each collection with its origin so the client can nest PR previews under
    // their repo. A repo_source links a collection to a "owner/name" repo; pr_number
    // null = the branch mirror (the parent), set = a PR preview (a child). Derived
    // here, not stored, so it needs no schema change and self-corrects on disconnect.
    const [cols, sources] = await Promise.all([
      meta.listCollections(org),
      meta.listRepoSources(org),
    ])
    const srcByCollection = new Map<string, { repo: string; pr: number | null }>()
    const branchCollectionByRepo = new Map<string, string>()
    for (const s of sources) {
      srcByCollection.set(s.collection_id, { repo: s.repo, pr: s.pr_number })
      if (s.pr_number === null) branchCollectionByRepo.set(s.repo, s.collection_id)
    }
    const collections = cols.map((col) => {
      const src = srcByCollection.get(col.id)
      if (!src) return { ...col, kind: "manual" as const }
      if (src.pr === null) return { ...col, kind: "repo" as const, repo: src.repo }
      return {
        ...col,
        kind: "pr" as const,
        repo: src.repo,
        prNumber: src.pr,
        // Omitted when the repo was disconnected but the PR source lingers → the
        // client falls back to rendering it top-level.
        parentId: branchCollectionByRepo.get(src.repo),
      }
    })
    return c.json({ collections })
  })
  app.post("/v1/collections", async (c) => {
    if (!(await workspaceCan(c, "comment"))) return fail(c, 403, "forbidden")
    const me = await currentUser(c)
    const body = await readJson(
      c,
      z.object({ title: z.string().refine((s) => s.trim() !== "", "title required") }),
    )
    if (body instanceof Response) return body
    const title = body.title.trim().slice(0, 120)
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
    const body = await readJson(c, z.object({ title: z.string().optional() }))
    if (body instanceof Response) return body
    return c.json(await meta.updateCollection(col.id, { title: body.title?.trim().slice(0, 120) }))
  })
  app.delete("/v1/collections/:id", async (c) => {
    const col = await requireManageable(c, c.req.param("id"))
    if (col instanceof Response) return col
    await meta.deleteCollection(col.id)
    return c.body(null, 204)
  })
  app.put("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "publish"))) return fail(c, 403, "forbidden")
    const art = await meta.getByShortId(c.req.param("shortId"))
    // Same-workspace + owns-the-artifact: adding to a collection re-shares the
    // artifact (the collection's members inherit a role on it), so it must be a
    // manage action on the artifact itself, not just on the collection. Without
    // this, anyone could fold any artifact by short_id into their own collection
    // and inherit a role on it (cross-workspace privilege escalation).
    if (!art || art.org_id !== col.org_id) return fail(c, 404, "artifact not found")
    if (!(await authorize(c, "manage", art))) return fail(c, 403, "forbidden")
    await meta.addCollectionItem(col.id, art.id)
    return c.json({ ok: true })
  })
  app.delete("/v1/collections/:id/items/:shortId", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "publish"))) return fail(c, 403, "forbidden")
    const art = await meta.getByShortId(c.req.param("shortId"))
    // Curation of your own collection; same-workspace guard mirrors the add path.
    if (!art || art.org_id !== col.org_id) return fail(c, 404, "artifact not found")
    await meta.removeCollectionItem(col.id, art.id)
    return c.body(null, 204)
  })
  app.get("/v1/collections/:id/members", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col || (await collectionRole(c, col)) === null) return fail(c, 404, "not found")
    const [rows, workspaceShare, ws] = await Promise.all([
      meta.listCollectionMembers(col.id),
      meta.getCollectionWorkspaceShare(col.id),
      meta.getWorkspace(col.org_id),
    ])
    const users = await meta.getUsers(rows.map((r) => r.user_id))
    const byId = new Map(users.map((u) => [u.id, u]))
    return c.json({
      created_by: col.created_by,
      members: rows.map((r) => ({
        user_id: r.user_id,
        handle: byId.get(r.user_id)?.username ?? null,
        name: byId.get(r.user_id)?.name ?? null,
        role: r.role,
      })),
      // The collection's own workspace — the only target `workspace_share` can
      // currently point at — plus the share itself, if one exists.
      workspace: { id: col.org_id, name: ws?.name ?? DEFAULT_WORKSPACE_NAME },
      workspace_share: workspaceShare ? { role: workspaceShare.role } : null,
    })
  })
  // Share (or re-role) a collection with every member of its own workspace — a
  // live binding, not a member-list snapshot (see collectionRolesForArtifact).
  app.put("/v1/collections/:id/workspace-share", async (c) => {
    const col = await requireManageable(c, c.req.param("id"))
    if (col instanceof Response) return col
    const b = await readJson(
      c,
      z.object({ role: z.custom<Role>(isRole, "a valid role is required") }),
    )
    if (b instanceof Response) return b
    const share = await meta.setCollectionWorkspaceShare({
      id: newId("cws"),
      collection_id: col.id,
      org_id: col.org_id,
      role: b.role,
    })
    return c.json({ role: share.role }, 201)
  })
  app.delete("/v1/collections/:id/workspace-share", async (c) => {
    const col = await requireManageable(c, c.req.param("id"))
    if (col instanceof Response) return col
    await meta.removeCollectionWorkspaceShare(col.id, col.org_id)
    return c.body(null, 204)
  })
  app.put("/v1/collections/:id/members", async (c) => {
    const col = await requireManageable(c, c.req.param("id"))
    if (col instanceof Response) return col
    const b = await readJson(
      c,
      z
        .object({
          user: z.string().min(1).optional(),
          email: z.string().min(1).optional(),
          role: z.custom<Role>(isRole, "a valid role is required"),
        })
        .refine((v) => v.user || v.email, "a username or email is required"),
    )
    if (b instanceof Response) return b
    const id = await resolveUserRef(meta, (b.user ?? b.email) as string)
    const [user] = id ? await meta.getUsers([id]) : []
    if (!user) return fail(c, 404, "no Derive user with that username or email")
    await meta.setCollectionMember({
      id: newId("cm"),
      collection_id: col.id,
      user_id: user.id,
      role: b.role,
    })
    return c.json({ user_id: user.id, handle: user.username, name: user.name, role: b.role }, 201)
  })
  app.delete("/v1/collections/:id/members/:userId", async (c) => {
    const col = await requireManageable(c, c.req.param("id"))
    if (col instanceof Response) return col
    await meta.removeCollectionMember(col.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  return app
}
