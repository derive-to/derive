import { describe, expect, it } from "vitest"
import { app, meta, postJson, upload } from "./helpers"

describe("collections", () => {
  const put = (path: string) =>
    app.request(path, { method: "PUT", headers: { "content-type": "application/json" } })

  it("CRUD + items + ?collection filter + detail membership", async () => {
    const col = await (await postJson("/v1/collections", { title: "Launch" })).json()
    expect(col.title).toBe("Launch")
    const { short_id } = await (await upload("c1.md", "x", { title: "In collection" })).json()
    expect((await put(`/v1/collections/${col.id}/items/${short_id}`)).status).toBe(200)

    const list = await (await app.request("/v1/collections")).json()
    expect(list.collections.find((c: { id: string }) => c.id === col.id)?.count).toBe(1)

    const filtered = await (await app.request(`/v1/artifacts?collection=${col.id}`)).json()
    expect(filtered.artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([short_id])

    const detail = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(detail.collections).toEqual([col.id])

    await app.request(`/v1/collections/${col.id}/items/${short_id}`, { method: "DELETE" })
    expect(
      (await (await app.request(`/v1/artifacts?collection=${col.id}`)).json()).artifacts,
    ).toHaveLength(0)
  })

  it("sharing a collection grants its role on every artifact in it", async () => {
    const col = await (await postJson("/v1/collections", { title: "Shared" })).json()
    const { short_id } = await (await upload("cs.md", "x", { title: "Shared art" })).json()
    await put(`/v1/collections/${col.id}/items/${short_id}`)
    const art = await meta.getByShortId(short_id)
    if (!art) throw new Error("missing artifact")
    // A stranger has no role over the artifact…
    expect(await meta.collectionRolesForArtifact(art.id, "stranger")).toEqual([])
    // …until the collection is shared with them — then it propagates to items.
    await meta.setCollectionMember({
      id: "cm_test",
      collection_id: col.id,
      user_id: "stranger",
      role: "editor",
    })
    expect(await meta.collectionRolesForArtifact(art.id, "stranger")).toEqual(["editor"])
    // Removing the item drops the propagation.
    await meta.removeCollectionItem(col.id, art.id)
    expect(await meta.collectionRolesForArtifact(art.id, "stranger")).toEqual([])
  })

  it("renames and deletes a collection (artifacts survive)", async () => {
    const col = await (await postJson("/v1/collections", { title: "Temp" })).json()
    const { short_id } = await (await upload("cd.md", "x", { title: "Survivor" })).json()
    await put(`/v1/collections/${col.id}/items/${short_id}`)
    await app.request(`/v1/collections/${col.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    })
    expect((await meta.getCollection(col.id))?.title).toBe("Renamed")
    expect((await app.request(`/v1/collections/${col.id}`, { method: "DELETE" })).status).toBe(204)
    expect(await meta.getCollection(col.id)).toBeNull()
    // the artifact itself is untouched
    expect(await meta.getByShortId(short_id)).not.toBeNull()
  })
})
