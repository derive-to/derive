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
import {
  activeSince,
  Collection,
  collectionsJson,
  enrich,
  PREVIEW_PER_COLLECTION,
  sourceMaps,
} from "../lib/boot-shapes"
import { BULK_MAX, BulkSummarySchema, bulkArtifactOp } from "../lib/bulk"
import { bail, fail, readJson } from "../lib/http"
import { resolveUserRef } from "../lib/resolve-user"
import { ArtifactMember } from "../schemas"

/** Collections: shareable groups of artifacts. A member's role on a collection
 *  propagates to every artifact inside it (see collectionRolesForArtifact). The
 *  Collection response schema is the single source for the web client's type
 *  (generated from the OpenAPI spec). Member endpoints return the shared ArtifactMember
 *  shape (see ../schemas). */
export const collectionRoutes = (ctx: AppContext) => {
  const {
    meta,
    isMember,
    isToken,
    currentUser,
    requireUser,
    activeWorkspace,
    workspaceCan,
    authorize,
    collectionRole,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const canManageCollection = async (c: Context, col: CollectionRecord, action: Action) =>
    roleAllows((await collectionRole(c, col)) ?? "viewer", action)

  // Resolve the :id collection and gate it — 404 missing, 403 present-but-
  // unauthorized (unlike an artifact's read gate, a collection you can't manage is
  // still worth knowing exists, so this doesn't hide it behind a 404). The
  // getCollection + canManageCollection pair every mutating route below opens with.
  const requireCollection = async (
    c: Context,
    action: Action,
  ): Promise<CollectionRecord | Response> => {
    const id = c.req.param("id")
    const col = id ? await meta.getCollection(id) : null
    if (!col) return fail(c, 404, "not found")
    if (!(await canManageCollection(c, col, action))) return fail(c, 403, "forbidden")
    return col
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
      // ONE store call answers the whole view: the org's collections + repo sources, and
      // (for a signed-in reader) their stars, worked-in set, and per-shelf preview strip.
      // Those last three were separate reads for one release — ~240ms of round trips on
      // the edge tier, which round-trip-budget.test.ts now fails on.
      const {
        collections: cols,
        sources,
        starred,
        active,
        previews: rawPreviews,
      } = await meta.collectionsOverview(
        org,
        me
          ? { userId: me.id, activeSince: activeSince(), previewPer: PREVIEW_PER_COLLECTION }
          : undefined,
      )
      // Same share experience as an artifact: an invite-only collection
      // (workspace_access=none) only lists for its creator or an explicit
      // collectionMember — collectionRole (the single source of truth, shared with the
      // members endpoint's own visibility gate) applies that per-collection, but calling
      // it once per row cost up to two round trips PER collection. Same rule, computed
      // from ONE batched `collectionRolesForUser` call: the operator token is owner on
      // everything; otherwise the creator is owner, else the batched map (explicit
      // membership or a seat on a workspace-open collection, higher wins) decides.
      const roleMap =
        me && !isToken(c)
          ? await meta.collectionRolesForUser(
              cols.map((col) => col.id),
              me.id,
            )
          : {}
      const collections = collectionsJson(
        cols,
        sources,
        roleMap,
        me?.id ?? null,
        isToken(c),
        new Set(starred),
        new Set(active),
        rawPreviews,
      )
      return c.json({ collections })
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
        // Same factory default as an artifact: workspace-open. (Unlike an
        // artifact, there's no per-org default to consult yet — collections are
        // simpler, always workspace_access=member on create.)
        workspace_access: "member",
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
      return c.json({ ...col, count: 0, my_role: "owner" as const, kind: "manual" as const }, 201)
    },
  )

  // Star a collection: it pins to the caller's sidebar. Deliberately gated on `read`,
  // not `share` — starring changes nothing about the collection or who reaches it, it is
  // a note-to-self about where you work. Anyone who can open it can star it.
  for (const [method, on] of [
    ["put", true],
    ["delete", false],
  ] as const) {
    app.openapi(
      createRoute({
        method,
        path: "/v1/collections/{id}/favorite",
        tags: ["Collections"],
        summary: on ? "Star a collection." : "Unstar a collection.",
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: {
            description: "The new starred state.",
            content: { "application/json": { schema: z.object({ starred: z.boolean() }) } },
          },
        },
      }),
      async (c) => {
        // The same guard the artifact star uses — a star belongs to a real account, and
        // the shared helper is what makes an anonymous caller a 403 rather than a crash.
        const me = await requireUser(c)
        if (me instanceof Response) return bail(me)
        const col = await requireCollection(c, "read")
        if (col instanceof Response) return bail(col)
        if (on) await meta.setCollectionFavorite(col.id, me.id)
        else await meta.removeCollectionFavorite(col.id, me.id)
        return c.json({ starred: on })
      },
    )
  }

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
      const col = await requireCollection(c, "publish")
      if (col instanceof Response) return bail(col)
      const body = await readJson(c, z.object({ title: z.string().optional() }))
      if (body instanceof Response) return bail(body)
      const updated = await meta.updateCollection(col.id, {
        title: body.title?.trim().slice(0, 120),
      })
      if (!updated) return bail(fail(c, 404, "not found"))
      // Return the SAME enriched shape as the list, so every collection response is one
      // type. Count + origin are unchanged by a rename; re-derive them (rare op).
      const [ids, sources, role] = await Promise.all([
        meta.collectionArtifactIds(updated.id),
        meta.listRepoSources(updated.org_id),
        collectionRole(c, updated),
      ])
      const { srcByCollection, branchByRepo } = sourceMaps(sources)
      return c.json(
        enrich({ ...updated, count: ids.length, my_role: role }, srcByCollection, branchByRepo),
      )
    },
  )

  // Change a collection's share experience — the Share dialog's Invited/Workspace
  // toggle. Same one-question shape as an artifact's /access, minus link_role/
  // listed (a collection isn't individually link-servable content, so its share
  // dialog skips the Anyone segment — see access-model.md and the collection
  // table's workspace_access comment). Applies immediately, no Save button.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/collections/{id}/access",
      tags: ["Collections"],
      summary: "Change a collection's workspace access.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The new access.",
          content: {
            "application/json": {
              schema: z.object({
                workspace_access: z
                  .enum(["none", "member"])
                  .describe("The collection's new workspace share scope."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const col = await requireCollection(c, "manage")
      if (col instanceof Response) return bail(col)
      const b = await readJson(c, z.object({ workspaceAccess: z.enum(["none", "member"]) }))
      if (b instanceof Response) return bail(b)
      await meta.setCollectionAccess(col.id, b.workspaceAccess)
      return c.json({ workspace_access: b.workspaceAccess })
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
      const col = await requireCollection(c, "manage")
      if (col instanceof Response) return bail(col)
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
      const col = await requireCollection(c, "publish")
      if (col instanceof Response) return bail(col)
      const art = await meta.getByShortId(c.req.param("shortId"))
      // Adding to a collection re-shares the artifact (the collection's members inherit
      // a role on it), so the caller must be able to SHARE the artifact — not merely
      // read it (a viewer can't reshape access) but not necessarily own it either.
      // Collections are org-wide organizing tools, so a workspace editor can fold in any
      // workspace-accessible artifact (share via their seat); an invite-only doc still
      // needs explicit share standing. The same-workspace guard keeps it from folding a
      // foreign-workspace artifact in by short_id.
      if (!art || art.org_id !== col.org_id) return bail(fail(c, 404, "artifact not found"))
      if (!(await authorize(c, "share", art))) return bail(fail(c, 403, "forbidden"))
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
      const col = await requireCollection(c, "publish")
      if (col instanceof Response) return bail(col)
      const art = await meta.getByShortId(c.req.param("shortId"))
      // Curation of your own collection; same-workspace guard mirrors the add path.
      if (!art || art.org_id !== col.org_id) return bail(fail(c, 404, "artifact not found"))
      await meta.removeCollectionItem(col.id, art.id)
      return c.body(null, 204)
    },
  )

  // Bulk add — the library multi-select bar drops many artifacts into one or more
  // collections in a single call. The collections are authorized once each (you must be
  // able to publish to a collection to fold artifacts into it); every artifact is then
  // authorized on its own for "share" exactly like the single add-item route, since adding
  // to a shared collection re-shares the artifact. Per-artifact refusals come back as
  // `skipped`, so a mixed selection lands what it can without failing the batch.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bulk/collections",
      tags: ["Collections"],
      summary: "Add many artifacts to one or more collections (per-artifact share-gated).",
      responses: {
        200: {
          description: "How many artifacts were added / skipped / failed.",
          content: { "application/json": { schema: BulkSummarySchema } },
        },
      },
    }),
    async (c) => {
      const body = await readJson(
        c,
        z.object({
          shortIds: z.array(z.string()).min(1).max(BULK_MAX),
          collectionIds: z.array(z.string()).min(1),
        }),
      )
      if (body instanceof Response) return bail(body)
      // Resolve the target collections and keep only those the caller can publish to. If
      // they can manage NONE, that's a flat 403 — nothing to add into.
      const resolved = await Promise.all(body.collectionIds.map((id) => meta.getCollection(id)))
      const allowedCols: CollectionRecord[] = []
      for (const col of resolved) {
        if (col && (await canManageCollection(c, col, "publish"))) allowedCols.push(col)
      }
      if (allowedCols.length === 0) return bail(fail(c, 403, "forbidden"))
      const summary = await bulkArtifactOp(
        body.shortIds,
        (ids) => meta.getByShortIds(ids),
        (a) => authorize(c, "share", a),
        async (a) => {
          // Same-workspace guard mirrors the single add-item route: a foreign-workspace
          // artifact (by short_id) is not folded into this workspace's collection.
          for (const col of allowedCols) {
            if (col.org_id === a.org_id) await meta.addCollectionItem(col.id, a.id)
          }
        },
      )
      return c.json(summary)
    },
  )

  // Member endpoints — the collaborators whose role propagates to the collection's
  // artifacts. They return the shared ArtifactMember shape (see ../schemas).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections/{id}/members",
      tags: ["Collections"],
      summary: "List a collection's members.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The collection's creator and its members.",
          content: {
            "application/json": {
              schema: z.object({
                created_by: z.string().describe("User id of the collection's creator."),
                members: z.array(ArtifactMember),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      if (!col || (await collectionRole(c, col)) === null) return bail(fail(c, 404, "not found"))
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
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/collections/{id}/members",
      tags: ["Collections"],
      summary: "Add or update a collection member.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "The added member.",
          content: { "application/json": { schema: ArtifactMember } },
        },
      },
    }),
    async (c) => {
      const col = await requireCollection(c, "manage")
      if (col instanceof Response) return bail(col)
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
      if (b instanceof Response) return bail(b)
      const id = await resolveUserRef(meta, (b.user ?? b.email) as string)
      const [user] = id ? await meta.getUsers([id]) : []
      if (!user) return bail(fail(c, 404, "no Derive user with that username or email"))
      // The creator is permanently owner (collectionRole checks created_by first), so
      // their role isn't a member row anyone can rewrite — reject demoting them.
      if (user.id === col.created_by)
        return bail(fail(c, 409, "the collection owner's role can't be changed"))
      await meta.setCollectionMember({
        id: newId("cm"),
        collection_id: col.id,
        user_id: user.id,
        role: b.role,
      })
      return c.json({ user_id: user.id, handle: user.username, name: user.name, role: b.role }, 201)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}/members/{userId}",
      tags: ["Collections"],
      summary: "Remove a collection member.",
      request: { params: z.object({ id: z.string(), userId: z.string() }) },
      responses: { 204: { description: "The member was removed." } },
    }),
    async (c) => {
      const col = await requireCollection(c, "manage")
      if (col instanceof Response) return bail(col)
      // The creator stays owner via created_by regardless of member rows; removing the
      // row wouldn't revoke their access, it would just orphan the roster — refuse it.
      if (c.req.param("userId") === col.created_by)
        return bail(fail(c, 409, "can't remove the collection owner"))
      await meta.removeCollectionMember(col.id, c.req.param("userId"))
      return c.body(null, 204)
    },
  )

  return app
}
