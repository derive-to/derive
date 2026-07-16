import { type Action, type FolderRecord, newId, roleAllows } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

/** Folders organize the artifacts WITHIN a collection (Collection → Folder → artifacts).
 *  A folder inherits its collection's access and grants nothing of its own — it never
 *  appears in any auth path. Reading a collection's folders needs any role on it; managing
 *  (create / rename / delete / file an item) needs the collection's editor role. Items are
 *  filed per-membership (collection_item.folder_id), so the same artifact can sit in
 *  different folders in different collections. The Folder schema is the web client's type. */
export const folderRoutes = (ctx: AppContext) => {
  const { meta, currentUser, collectionRole } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const Folder = z
    .object({
      id: z.string(),
      collectionId: z.string().describe("The collection this folder organizes."),
      name: z.string(),
      created_by: z.string().describe('Creator\'s user id ("anon" if created anonymously).'),
      created_at: z.string(),
    })
    .openapi("Folder")
  const toFolder = (f: FolderRecord) => ({
    id: f.id,
    collectionId: f.collection_id ?? "",
    name: f.name,
    created_by: f.created_by,
    created_at: f.created_at,
  })

  const NAME_MAX = 80
  const cleanName = (s: string) => s.trim().slice(0, NAME_MAX)
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

  // Resolve the collection by id and require `action` on it (managing folders = "publish",
  // the collection's editor role). 404 missing, 403 present-but-unauthorized.
  const requireCollectionRole = async (c: Context, colId: string, action: Action) => {
    const col = await meta.getCollection(colId)
    if (!col) return fail(c, 404, "not found")
    if (!roleAllows((await collectionRole(c, col)) ?? "viewer", action))
      return fail(c, 403, "forbidden")
    return col
  }
  // Resolve the :id folder and gate on ITS collection (editor). Used by rename/delete,
  // whose path carries the folder id, not the collection id.
  const requireFolderManage = async (c: Context) => {
    const id = c.req.param("id")
    const f = id ? await meta.getFolder(id) : null
    if (!f || !f.collection_id) return fail(c, 404, "not found")
    const col = await requireCollectionRole(c, f.collection_id, "publish")
    if (col instanceof Response) return col
    return f
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections/{id}/folders",
      tags: ["Folders"],
      summary: "A collection's folders + its item→folder assignments (any collection role).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Folders (name order) and the artifact→folder map for grouping.",
          content: {
            "application/json": {
              schema: z.object({
                folders: z.array(Folder),
                assignments: z
                  .record(z.string(), z.string())
                  .describe("artifact short_id → folder id (filed items only)."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const col = await meta.getCollection(c.req.param("id"))
      if (!col) return bail(fail(c, 404, "not found"))
      // Any role on the collection can see its folder structure (it's part of the view).
      if ((await collectionRole(c, col)) === null) return bail(fail(c, 403, "forbidden"))
      const [folders, assignments] = await Promise.all([
        meta.listFolders(col.id),
        meta.collectionItemFolders(col.id),
      ])
      return c.json({ folders: folders.map(toFolder).sort(byName), assignments })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/collections/{id}/folders",
      tags: ["Folders"],
      summary: "Create a folder in a collection (collection editors).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        201: {
          description: "The created folder.",
          content: { "application/json": { schema: Folder } },
        },
      },
    }),
    async (c) => {
      const col = await requireCollectionRole(c, c.req.param("id"), "publish")
      if (col instanceof Response) return bail(col)
      const body = await readJson(
        c,
        z.object({ name: z.string().refine((s) => s.trim() !== "", "name required") }),
      )
      if (body instanceof Response) return bail(body)
      const me = await currentUser(c)
      const created = await meta.createFolder({
        id: newId("fld"),
        org_id: col.org_id,
        collection_id: col.id,
        name: cleanName(body.name),
        created_by: me?.id ?? "anon",
      })
      return c.json(toFolder(created), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/folders/{id}",
      tags: ["Folders"],
      summary: "Rename a folder (collection editors).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated folder.",
          content: { "application/json": { schema: Folder } },
        },
      },
    }),
    async (c) => {
      const f = await requireFolderManage(c)
      if (f instanceof Response) return bail(f)
      const body = await readJson(c, z.object({ name: z.string().optional() }))
      if (body instanceof Response) return bail(body)
      const name = body.name !== undefined ? cleanName(body.name) : undefined
      if (name === "") return bail(fail(c, 400, "name required"))
      const updated = await meta.updateFolder(f.id, { name })
      if (!updated) return bail(fail(c, 404, "not found"))
      return c.json(toFolder(updated))
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/folders/{id}",
      tags: ["Folders"],
      summary: "Delete a folder (collection editors); its items become unfiled, not removed.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        204: { description: "Deleted; the collection's artifacts are un-filed, not removed." },
      },
    }),
    async (c) => {
      const f = await requireFolderManage(c)
      if (f instanceof Response) return bail(f)
      await meta.deleteFolder(f.id)
      return c.body(null, 204)
    },
  )

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/collections/{id}/items/{shortId}/folder",
      tags: ["Folders"],
      summary: "File a collection's artifact under a folder, or unfile it (collection editors).",
      request: { params: z.object({ id: z.string(), shortId: z.string() }) },
      responses: { 204: { description: "Filed (or unfiled when folderId is null)." } },
    }),
    async (c) => {
      const col = await requireCollectionRole(c, c.req.param("id"), "publish")
      if (col instanceof Response) return bail(col)
      const art = await meta.getByShortId(c.req.param("shortId"))
      if (!art || art.org_id !== col.org_id) return bail(fail(c, 404, "artifact not found"))
      // The artifact must actually be IN this collection — filing a non-member would be a
      // silent no-op (no collection_item row to update), so reject it as not-found.
      if (!(await meta.collectionIdsForArtifact(art.id)).includes(col.id))
        return bail(fail(c, 404, "artifact not in collection"))
      const body = await readJson(c, z.object({ folderId: z.string().nullable() }))
      if (body instanceof Response) return bail(body)
      // A non-null target must be a folder OF THIS collection — you can't file an item into
      // another collection's folder (the cross-collection integrity the DB can't enforce).
      if (body.folderId !== null) {
        const f = await meta.getFolder(body.folderId)
        if (!f || f.collection_id !== col.id) return bail(fail(c, 404, "folder not found"))
      }
      await meta.setItemFolder(col.id, art.id, body.folderId)
      return c.body(null, 204)
    },
  )

  return app
}
