import {
  type Action,
  type CollectionRecord,
  isRole,
  newId,
  type Role,
  roleAllows,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { resolveUserRef } from "../lib/resolve-user"

/** Collections: shareable groups of artifacts. A member's role on a collection
 *  propagates to every artifact inside it (see collectionRolesForArtifact). The
 *  Collection response schema is the single source for the web client's type
 *  (generated from the OpenAPI spec). The member endpoints stay plain routes for now:
 *  they return the shared ArtifactMember shape, migrated with artifacts/sharing. */
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
  const app = new OpenAPIHono<BlankEnv>()

  const canManageCollection = async (c: Context, col: CollectionRecord, action: Action) =>
    roleAllows((await collectionRole(c, col)) ?? "viewer", action)

  // A collection as it goes out: the stored row + its item `count` + where it came from
  // (`kind` = manual/repo/pr, with the repo/PR details). Origin is DERIVED here, not
  // stored. Every collection-returning endpoint emits this one shape.
  const Collection = z
    .object({
      id: z.string(),
      title: z.string(),
      created_by: z.string(),
      created_at: z.string(),
      count: z.number(),
      /** Where it came from: "repo" = a GitHub repo mirror, "pr" = a read-only PR preview
       *  nested under its repo, "manual" = user-created. */
      kind: z.enum(["manual", "repo", "pr"]).optional(),
      /** For a PR preview: the repo collection it nests under (when still connected). */
      parentId: z.string().optional(),
      /** For a PR preview: the pull-request number. */
      prNumber: z.number().optional(),
      /** For repo/PR collections: "owner/name". */
      repo: z.string().optional(),
    })
    .openapi("Collection")

  // A repo_source links a collection to a "owner/name" repo; pr_number null = the branch
  // mirror (the parent), set = a PR preview (a child). Built once, shared by every path
  // that enriches a collection so the origin logic lives in one place.
  type Src = { repo: string; pr: number | null }
  const sourceMaps = (
    sources: { collection_id: string; repo: string; pr_number: number | null }[],
  ) => {
    const srcByCollection = new Map<string, Src>()
    const branchByRepo = new Map<string, string>()
    for (const s of sources) {
      srcByCollection.set(s.collection_id, { repo: s.repo, pr: s.pr_number })
      if (s.pr_number === null) branchByRepo.set(s.repo, s.collection_id)
    }
    return { srcByCollection, branchByRepo }
  }
  const enrich = (
    col: CollectionRecord & { count: number },
    srcByCollection: Map<string, Src>,
    branchByRepo: Map<string, string>,
  ) => {
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
      parentId: branchByRepo.get(src.repo),
    }
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections",
      tags: ["Collections"],
      summary: "List the active workspace's collections (members only).",
      responses: {
        200: {
          description: "The workspace's collections, each with its item count and origin.",
          content: {
            "application/json": { schema: z.object({ collections: z.array(Collection) }) },
          },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      if (!me && !isToken(c)) return bail(fail(c, 401, "unauthenticated"))
      const org = await activeWorkspace(c)
      // Collections are a workspace-internal organizer — only members (or the operator
      // token) see them. A non-member (incl. anon in open mode) gets an empty list, so
      // a workspace's collections can't be enumerated via a public artifact's workspace.
      if (!(await isMember(c, org))) return c.json({ collections: [] })
      const [cols, sources] = await Promise.all([
        meta.listCollections(org),
        meta.listRepoSources(org),
      ])
      const { srcByCollection, branchByRepo } = sourceMaps(sources)
      return c.json({ collections: cols.map((col) => enrich(col, srcByCollection, branchByRepo)) })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/collections",
      tags: ["Collections"],
      summary: "Create a collection.",
      responses: {
        201: {
          description: "The created collection (empty, manual).",
          content: { "application/json": { schema: Collection } },
        },
      },
    }),
    async (c) => {
      if (!(await workspaceCan(c, "comment"))) return bail(fail(c, 403, "forbidden"))
      const me = await currentUser(c)
      const body = await readJson(
        c,
        z.object({ title: z.string().refine((s) => s.trim() !== "", "title required") }),
      )
      if (body instanceof Response) return bail(body)
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
      // A brand-new collection is empty (count 0) and user-created (manual) — return the
      // full shape so the client can drop it straight into its list without a refetch.
      return c.json({ ...col, count: 0, kind: "manual" as const }, 201)
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/collections/{id}",
      tags: ["Collections"],
      summary: "Rename a collection.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated collection.",
          content: { "application/json": { schema: Collection } },
        },
      },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      if (!col) return bail(fail(c, 404, "not found"))
      if (!(await canManageCollection(c, col, "publish"))) return bail(fail(c, 403, "forbidden"))
      const body = await readJson(c, z.object({ title: z.string().optional() }))
      if (body instanceof Response) return bail(body)
      const updated = await meta.updateCollection(col.id, {
        title: body.title?.trim().slice(0, 120),
      })
      if (!updated) return bail(fail(c, 404, "not found"))
      // Return the SAME enriched shape as the list, so every collection response is one
      // type. Count + origin are unchanged by a rename; re-derive them (rare op).
      const [ids, sources] = await Promise.all([
        meta.collectionArtifactIds(updated.id),
        meta.listRepoSources(updated.org_id),
      ])
      const { srcByCollection, branchByRepo } = sourceMaps(sources)
      return c.json(enrich({ ...updated, count: ids.length }, srcByCollection, branchByRepo))
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}",
      tags: ["Collections"],
      summary: "Delete a collection.",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The collection was deleted." } },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      if (!col) return bail(fail(c, 404, "not found"))
      if (!(await canManageCollection(c, col, "manage"))) return bail(fail(c, 403, "forbidden"))
      await meta.deleteCollection(col.id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/collections/{id}/items/{shortId}",
      tags: ["Collections"],
      summary: "Add an artifact to a collection.",
      request: { params: z.object({ id: z.string(), shortId: z.string() }) },
      responses: {
        200: {
          description: "The artifact was added.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      if (!col) return bail(fail(c, 404, "not found"))
      if (!(await canManageCollection(c, col, "publish"))) return bail(fail(c, 403, "forbidden"))
      const art = await meta.getByShortId(c.req.param("shortId"))
      // Same-workspace + owns-the-artifact: adding to a collection re-shares the
      // artifact (the collection's members inherit a role on it), so it must be a
      // manage action on the artifact itself, not just on the collection. Without
      // this, anyone could fold any artifact by short_id into their own collection
      // and inherit a role on it (cross-workspace privilege escalation).
      if (!art || art.org_id !== col.org_id) return bail(fail(c, 404, "artifact not found"))
      if (!(await authorize(c, "manage", art))) return bail(fail(c, 403, "forbidden"))
      await meta.addCollectionItem(col.id, art.id)
      return c.json({ ok: true })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}/items/{shortId}",
      tags: ["Collections"],
      summary: "Remove an artifact from a collection.",
      request: { params: z.object({ id: z.string(), shortId: z.string() }) },
      responses: { 204: { description: "The artifact was removed." } },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      if (!col) return bail(fail(c, 404, "not found"))
      if (!(await canManageCollection(c, col, "publish"))) return bail(fail(c, 403, "forbidden"))
      const art = await meta.getByShortId(c.req.param("shortId"))
      // Curation of your own collection; same-workspace guard mirrors the add path.
      if (!art || art.org_id !== col.org_id) return bail(fail(c, 404, "artifact not found"))
      await meta.removeCollectionItem(col.id, art.id)
      return c.body(null, 204)
    },
  )

  // --- Member endpoints: plain routes (not in the spec yet). They return the shared
  // ArtifactMember shape, which is migrated holistically with artifacts/sharing.
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
        handle: byId.get(r.user_id)?.username ?? null,
        name: byId.get(r.user_id)?.name ?? null,
        role: r.role,
      })),
    })
  })
  app.put("/v1/collections/:id/members", async (c) => {
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "manage"))) return fail(c, 403, "forbidden")
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
    const col = await meta.getCollection(c.req.param("id"))
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, "manage"))) return fail(c, 403, "forbidden")
    await meta.removeCollectionMember(col.id, c.req.param("userId"))
    return c.body(null, 204)
  })

  return app
}
