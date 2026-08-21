import { describe, expect, it } from "vitest"
import { app, as, makeAuthedApp, meta, postJson, publishAs, type TestUser, upload } from "./helpers"

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

  it("a workspace editor can add a teammate's workspace artifact to a teammate's collection; an outsider can't", async () => {
    // Collections are org-wide organizing tools: any workspace editor manages them at
    // their seat (not just the creator), and can fold in any workspace-accessible
    // artifact — not just ones they own. (Regression: collectionRole ignored workspace
    // membership, and the add-item guard required owning the artifact.)
    const ana: TestUser = { id: "u_col_ana", email: "ana@col.test", name: "Ana", username: "anac" }
    const ben: TestUser = { id: "u_col_ben", email: "ben@col.test", name: "Ben", username: "benc" }
    const { app: teamApp } = makeAuthedApp("col-member", [ana, ben], "editor")
    // Ana creates the collection AND owns the artifact (a default team-draft — the
    // workspace reaches it at each member's seat). Ben created neither.
    const col = await (
      await teamApp.request("/v1/collections", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(ana.email) },
        body: JSON.stringify({ title: "Team" }),
      })
    ).json()
    const anas = await (await publishAs(teamApp, "<h1>a</h1>", {}, as(ana.email))).json()
    // Ben (workspace editor, owns neither) can still fold Ana's artifact into her
    // collection — his seat gives him share on it and manage on the collection.
    expect(
      (
        await teamApp.request(`/v1/collections/${col.id}/items/${anas.short_id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...as(ben.email) },
        })
      ).status,
    ).toBe(200)

    // An outsider (own workspace, no membership here) still can't manage the collection.
    const outsider: TestUser = {
      id: "u_col_out",
      email: "out@col.test",
      name: "Out",
      username: "outc",
    }
    const { app: outApp } = makeAuthedApp("col-outsider", [ana, outsider], undefined, {
      isolated: true,
    })
    const otherCol = await (
      await outApp.request("/v1/collections", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(ana.email) },
        body: JSON.stringify({ title: "Private-ish" }),
      })
    ).json()
    const mine = await (await publishAs(outApp, "<h1>o</h1>", {}, as(outsider.email))).json()
    expect(
      (
        await outApp.request(`/v1/collections/${otherCol.id}/items/${mine.short_id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...as(outsider.email) },
        })
      ).status,
    ).toBe(403) // no seat in that workspace → no standing to manage the collection
  })
})

describe("collections: list rows", () => {
  const amy: TestUser = { id: "u_amy", email: "amy@derive.test", name: "Amy" }
  const { app: authed } = makeAuthedApp("collection-stars", [amy])

  const mk = async (title: string) => {
    const r = await authed.request("/v1/collections", {
      method: "POST",
      headers: { ...as(amy.email), "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
    return (await r.json()) as { id: string }
  }

  it("list rows carry their collection ids, from the batched read", async () => {
    // The library's grouped-by-collection view groups on this field, from the LIST
    // response — not the detail. It shipped broken once: the field was populated by
    // `listEnrichment` but the Postgres fast path (`listPage`) builds its decoration
    // inside one statement, and the arm was missing there — so every artifact grouped
    // as unfiled in production while every SQLite test passed. This test runs under
    // test:pg too, which is the whole point of it.
    const col = await mk("Filed")
    const up = await authed.request("/v1/artifacts", {
      method: "POST",
      headers: as(amy.email),
      body: (() => {
        const f = new FormData()
        f.set("file", new File(["# filed"], "filed.md", { type: "text/markdown" }))
        f.set("title", "Filed doc")
        return f
      })(),
    })
    const { short_id } = (await up.json()) as { short_id: string }
    await authed.request(`/v1/collections/${col.id}/items/${short_id}`, {
      method: "PUT",
      headers: as(amy.email),
    })

    // A second artifact, deliberately unfiled.
    const up2 = await authed.request("/v1/artifacts", {
      method: "POST",
      headers: as(amy.email),
      body: (() => {
        const f = new FormData()
        f.set("file", new File(["# loose"], "loose.md", { type: "text/markdown" }))
        f.set("title", "Unfiled doc")
        return f
      })(),
    })
    const { short_id: looseId } = (await up2.json()) as { short_id: string }

    const list = await (
      await authed.request("/v1/artifacts?limit=30", { headers: as(amy.email) })
    ).json()
    const byId = (id: string) => list.artifacts.find((a: { short_id: string }) => a.short_id === id)
    expect(byId(short_id), "the filed artifact is on the list").toBeTruthy()
    expect(byId(short_id).collections).toEqual([col.id])
    // An unfiled row says so with an empty array, not an absent field.
    expect(byId(looseId).collections).toEqual([])
  })
})

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
