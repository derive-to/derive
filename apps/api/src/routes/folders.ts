import { newId } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

/** Folders: an owner-editable, workspace-shared layer that groups collections in the
 *  sidebar (Phase 3 of the sidebar rework). A folder grants NO access — it never appears
 *  in any auth path; it only files collections (collection.folder_id). Reads are
 *  member-scoped; every mutation is workspace-owner-only (requireWorkspace "manage"). The
 *  Folder response schema is the single source for the web client's type. */
export const folderRoutes = (ctx: AppContext) => {
  const { meta, isMember, isToken, currentUser, activeWorkspace, requireWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Folder = z
    .object({
      id: z.string(),
      name: z.string(),
      created_by: z.string().describe('Creator\'s user id ("anon" if created anonymously).'),
      created_at: z.string(),
    })
    .openapi("Folder")

  const NAME_MAX = 80
  const cleanName = (s: string) => s.trim().slice(0, NAME_MAX)

  // Resolve the :id folder IN the caller's workspace (404 otherwise). Every mutation
  // opens with this after the owner gate, so a folder from another workspace can't be
  // touched even by its own owner.
  const requireFolder = async (c: Context, org: string) => {
    const id = c.req.param("id")
    const f = id ? await meta.getFolder(id) : null
    if (!f || f.org_id !== org) return fail(c, 404, "not found")
    return f
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/folders",
      tags: ["Folders"],
      summary: "List the active workspace's folders (members only).",
      responses: {
        200: {
          description: "The workspace's folders, in name order.",
          content: { "application/json": { schema: z.object({ folders: z.array(Folder) }) } },
        },
      },
    }),
    async (c) => {
      const me = await currentUser(c)
      if (!me && !isToken(c)) return bail(fail(c, 401, "unauthenticated"))
      const org = await activeWorkspace(c)
      // Folders are shared workspace structure — members (or the operator token) see the
      // tree; a non-member gets an empty list (they can't enumerate it).
      if (!(await isMember(c, org))) return c.json({ folders: [] })
      const folders = (await meta.listFolders(org)).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      )
      return c.json({ folders })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/folders",
      tags: ["Folders"],
      summary: "Create a folder (workspace owners only).",
      responses: {
        201: {
          description: "The created folder.",
          content: { "application/json": { schema: Folder } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const body = await readJson(
        c,
        z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
      )
      if (body instanceof Response) return bail(body)
      const me = await currentUser(c)
      const created = await meta.createFolder({
        id: newId("fld"),
        org_id: org,
        name: cleanName(body.name),
        created_by: me?.id ?? "anon",
      })
      return c.json(created, 201)
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/folders/{id}",
      tags: ["Folders"],
      summary: "Rename a folder (workspace owners only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated folder.",
          content: { "application/json": { schema: Folder } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const f = await requireFolder(c, org)
      if (f instanceof Response) return bail(f)
      const body = await readJson(c, z.object({ name: z.string().optional() }))
      if (body instanceof Response) return bail(body)
      const name = body.name !== undefined ? cleanName(body.name) : undefined
      // A provided-but-blank name is rejected, matching create — don't persist an
      // empty folder name (an invisible row in the rail).
      if (name === "") return bail(fail(c, 400, "name required"))
      const updated = await meta.updateFolder(f.id, { name })
      if (!updated) return bail(fail(c, 404, "not found"))
      return c.json(updated)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/folders/{id}",
      tags: ["Folders"],
      summary: "Delete a folder (workspace owners only); its collections become ungrouped.",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "Deleted; member collections are un-filed, not removed." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const f = await requireFolder(c, org)
      if (f instanceof Response) return bail(f)
      await meta.deleteFolder(f.id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/collections/{id}/folder",
      tags: ["Folders"],
      summary: "File a collection under a folder, or ungroup it (workspace owners only).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "Filed (or ungrouped when folderId is null)." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const col = await meta.getCollection(c.req.param("id"))
      if (!col || col.org_id !== org) return bail(fail(c, 404, "not found"))
      const body = await readJson(c, z.object({ folderId: z.string().nullable() }))
      if (body instanceof Response) return bail(body)
      // A non-null target must be a real folder in THIS workspace (folders never cross
      // workspaces, and an unknown id must not silently orphan the pointer).
      if (body.folderId !== null) {
        const f = await meta.getFolder(body.folderId)
        if (!f || f.org_id !== org) return bail(fail(c, 404, "folder not found"))
      }
      await meta.setCollectionFolder(col.id, body.folderId)
      return c.body(null, 204)
    },
  )

  return app
}
