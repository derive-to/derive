import { describe, expect, it } from "vitest"
import { app, as, makeAuthedApp, meta, postJson, type TestUser, upload } from "./helpers"

// Folders organize the artifacts WITHIN a collection. A folder belongs to one collection;
// an item's folder is per-membership (collection_item.folder_id). Management needs the
// collection's editor role; reading needs any role on it.
describe("folders (inside a collection)", () => {
  const jsonReq = (
    path: string,
    method: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  const addItem = (colId: string, shortId: string) =>
    app.request(`/v1/collections/${colId}/items/${shortId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
    })
  const seedItem = async (colId: string, title: string) => {
    const { short_id } = await (await upload(`${title}.md`, "x", { title })).json()
    await addItem(colId, short_id)
    const art = await meta.getByShortId(short_id)
    if (!art) throw new Error("artifact missing")
    return { short_id, id: art.id }
  }

  it("creates folders in a collection and lists them (name order) with an empty assignment map", async () => {
    const col = await (await postJson("/v1/collections", { title: "Homepage" })).json()
    const a = await (
      await jsonReq(`/v1/collections/${col.id}/folders`, "POST", { name: "alpha" })
    ).json()
    await jsonReq(`/v1/collections/${col.id}/folders`, "POST", { name: "Beta" })
    expect(a.collectionId).toBe(col.id)
    const list = await (await app.request(`/v1/collections/${col.id}/folders`)).json()
    expect(list.folders.map((f: { name: string }) => f.name)).toEqual(["alpha", "Beta"])
    expect(list.assignments).toEqual({})
  })

  it("files an artifact into a folder (assignment map reflects it); null unfiles it", async () => {
    const col = await (await postJson("/v1/collections", { title: "C" })).json()
    const folder = await (
      await jsonReq(`/v1/collections/${col.id}/folders`, "POST", { name: "Heroes" })
    ).json()
    const item = await seedItem(col.id, "Art")
    expect(
      (
        await jsonReq(`/v1/collections/${col.id}/items/${item.short_id}/folder`, "PUT", {
          folderId: folder.id,
        })
      ).status,
    ).toBe(204)
    let list = await (await app.request(`/v1/collections/${col.id}/folders`)).json()
    expect(list.assignments[item.short_id]).toBe(folder.id)
    expect(
      (
        await jsonReq(`/v1/collections/${col.id}/items/${item.short_id}/folder`, "PUT", {
          folderId: null,
        })
      ).status,
    ).toBe(204)
    list = await (await app.request(`/v1/collections/${col.id}/folders`)).json()
    expect(list.assignments[item.short_id]).toBeUndefined()
  })

  it("the same artifact sits in different folders in different collections (per-membership)", async () => {
    const x = await (await postJson("/v1/collections", { title: "X" })).json()
    const y = await (await postJson("/v1/collections", { title: "Y" })).json()
    const fx = await (
      await jsonReq(`/v1/collections/${x.id}/folders`, "POST", { name: "FX" })
    ).json()
    const fy = await (
      await jsonReq(`/v1/collections/${y.id}/folders`, "POST", { name: "FY" })
    ).json()
    const { short_id } = await (await upload("multi.md", "x", { title: "Multi" })).json()
    await addItem(x.id, short_id)
    await addItem(y.id, short_id)
    await jsonReq(`/v1/collections/${x.id}/items/${short_id}/folder`, "PUT", { folderId: fx.id })
    await jsonReq(`/v1/collections/${y.id}/items/${short_id}/folder`, "PUT", { folderId: fy.id })
    const lx = await (await app.request(`/v1/collections/${x.id}/folders`)).json()
    const ly = await (await app.request(`/v1/collections/${y.id}/folders`)).json()
    expect(lx.assignments[short_id]).toBe(fx.id)
    expect(ly.assignments[short_id]).toBe(fy.id)
  })

  it("won't file an item under a folder from another collection (404)", async () => {
    const x = await (await postJson("/v1/collections", { title: "X2" })).json()
    const y = await (await postJson("/v1/collections", { title: "Y2" })).json()
    const fy = await (
      await jsonReq(`/v1/collections/${y.id}/folders`, "POST", { name: "other" })
    ).json()
    const item = await seedItem(x.id, "Cross")
    expect(
      (
        await jsonReq(`/v1/collections/${x.id}/items/${item.short_id}/folder`, "PUT", {
          folderId: fy.id,
        })
      ).status,
    ).toBe(404)
  })

  it("won't file an artifact that isn't in the collection (404, not a silent no-op)", async () => {
    const col = await (await postJson("/v1/collections", { title: "Members" })).json()
    const folder = await (
      await jsonReq(`/v1/collections/${col.id}/folders`, "POST", { name: "F" })
    ).json()
    // An artifact that exists but was never added to this collection.
    const { short_id } = await (await upload("stray.md", "x", { title: "Stray" })).json()
    expect(
      (
        await jsonReq(`/v1/collections/${col.id}/items/${short_id}/folder`, "PUT", {
          folderId: folder.id,
        })
      ).status,
    ).toBe(404)
  })

  it("deleting a folder unfiles its items — the artifacts stay in the collection", async () => {
    const col = await (await postJson("/v1/collections", { title: "D" })).json()
    const folder = await (
      await jsonReq(`/v1/collections/${col.id}/folders`, "POST", { name: "Temp" })
    ).json()
    const item = await seedItem(col.id, "Survivor")
    await jsonReq(`/v1/collections/${col.id}/items/${item.short_id}/folder`, "PUT", {
      folderId: folder.id,
    })
    expect((await app.request(`/v1/folders/${folder.id}`, { method: "DELETE" })).status).toBe(204)
    expect(await meta.getFolder(folder.id)).toBeNull()
    const list = await (await app.request(`/v1/collections/${col.id}/folders`)).json()
    expect(list.folders).toHaveLength(0)
    expect(list.assignments).toEqual({})
    const arts = await (await app.request(`/v1/artifacts?collection=${col.id}`)).json()
    expect(arts.artifacts.map((a: { short_id: string }) => a.short_id)).toContain(item.short_id)
  })

  it("rejects a blank folder name (create + rename)", async () => {
    const col = await (await postJson("/v1/collections", { title: "N" })).json()
    expect(
      (await jsonReq(`/v1/collections/${col.id}/folders`, "POST", { name: "   " })).status,
    ).toBe(400)
    const f = await (
      await jsonReq(`/v1/collections/${col.id}/folders`, "POST", { name: "Keep" })
    ).json()
    expect((await jsonReq(`/v1/folders/${f.id}`, "PATCH", { name: "   " })).status).toBe(400)
    expect((await meta.getFolder(f.id))?.name).toBe("Keep")
  })

  it("management needs the collection's editor role; a viewer member can read but not write", async () => {
    const owner: TestUser = { id: "u_f2_own", email: "own@f2.test", name: "Own", username: "ownf2" }
    const viewer: TestUser = {
      id: "u_f2_view",
      email: "view@f2.test",
      name: "View",
      username: "viewf2",
    }
    const { app: team } = makeAuthedApp("folders2-roles", [owner, viewer], "viewer")
    const col = await (
      await team.request("/v1/collections", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(owner.email) },
        body: JSON.stringify({ title: "Team" }),
      })
    ).json()
    const folder = await (
      await team.request(`/v1/collections/${col.id}/folders`, {
        method: "POST",
        headers: { "content-type": "application/json", ...as(owner.email) },
        body: JSON.stringify({ name: "Owned" }),
      })
    ).json()
    // The viewer can READ the folder structure…
    const list = await (
      await team.request(`/v1/collections/${col.id}/folders`, { headers: as(viewer.email) })
    ).json()
    expect(list.folders.map((f: { id: string }) => f.id)).toContain(folder.id)
    // …but can't create / rename / delete.
    const create = await team.request(`/v1/collections/${col.id}/folders`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(viewer.email) },
      body: JSON.stringify({ name: "Nope" }),
    })
    expect(create.status).toBe(403)
    const rename = await team.request(`/v1/folders/${folder.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(viewer.email) },
      body: JSON.stringify({ name: "X" }),
    })
    expect(rename.status).toBe(403)
    const del = await team.request(`/v1/folders/${folder.id}`, {
      method: "DELETE",
      headers: as(viewer.email),
    })
    expect(del.status).toBe(403)
  })
})
