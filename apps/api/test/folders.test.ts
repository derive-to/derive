import { describe, expect, it } from "vitest"
import { app, as, makeAuthedApp, meta, postJson, type TestUser } from "./helpers"

describe("folders", () => {
  const putJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  it("owner creates + lists + renames folders; the list is case-insensitive alphabetical", async () => {
    const beta = await (await postJson("/v1/folders", { name: "Beta" })).json()
    const alpha = await (await postJson("/v1/folders", { name: "alpha" })).json()
    expect(beta.name).toBe("Beta")
    expect(alpha.name).toBe("alpha")

    const list = await (await app.request("/v1/folders")).json()
    const names = list.folders.map((f: { name: string }) => f.name)
    expect(names).toEqual(["alpha", "Beta"]) // A–Z, case-insensitive

    const renamed = await app.request(`/v1/folders/${beta.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bravo" }),
    })
    expect(renamed.status).toBe(200)
    expect((await meta.getFolder(beta.id))?.name).toBe("Bravo")
  })

  it("files a collection under a folder (exposes folderId); deleting the folder un-files it, collection survives", async () => {
    const folder = await (await postJson("/v1/folders", { name: "Rebrand" })).json()
    const col = await (await postJson("/v1/collections", { title: "Homepage" })).json()
    expect(
      (await putJson(`/v1/collections/${col.id}/folder`, { folderId: folder.id })).status,
    ).toBe(204)

    const list = await (await app.request("/v1/collections")).json()
    expect(list.collections.find((c: { id: string }) => c.id === col.id)?.folderId).toBe(folder.id)

    expect((await app.request(`/v1/folders/${folder.id}`, { method: "DELETE" })).status).toBe(204)
    expect(await meta.getFolder(folder.id)).toBeNull()
    // The collection survives, un-filed.
    expect((await meta.getCollection(col.id))?.folder_id ?? null).toBeNull()
    const after = await (await app.request("/v1/collections")).json()
    expect(after.collections.find((c: { id: string }) => c.id === col.id)?.folderId).toBeUndefined()
  })

  it("ungroups a collection when folderId is null", async () => {
    const folder = await (await postJson("/v1/folders", { name: "Temp" })).json()
    const col = await (await postJson("/v1/collections", { title: "C" })).json()
    await putJson(`/v1/collections/${col.id}/folder`, { folderId: folder.id })
    expect((await putJson(`/v1/collections/${col.id}/folder`, { folderId: null })).status).toBe(204)
    expect((await meta.getCollection(col.id))?.folder_id ?? null).toBeNull()
  })

  it("rejects filing under an unknown folder (404)", async () => {
    const col = await (await postJson("/v1/collections", { title: "C2" })).json()
    expect(
      (await putJson(`/v1/collections/${col.id}/folder`, { folderId: "fld_missing" })).status,
    ).toBe(404)
  })

  it("rejects a blank rename (matches create)", async () => {
    const folder = await (await postJson("/v1/folders", { name: "Keep" })).json()
    const res = await app.request(`/v1/folders/${folder.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    })
    expect(res.status).toBe(400)
    expect((await meta.getFolder(folder.id))?.name).toBe("Keep")
  })

  it("won't file a collection under a folder from another workspace (404)", async () => {
    // Folder lives in the default app's workspace…
    const folder = await (await postJson("/v1/folders", { name: "Theirs" })).json()
    // …a different, isolated workspace's owner has their own collection…
    const solo: TestUser = {
      id: "u_fld_solo",
      email: "solo@fld.test",
      name: "Solo",
      username: "solof",
    }
    const { app: other } = makeAuthedApp("folders-xws", [solo], undefined, { isolated: true })
    const col = await (
      await other.request("/v1/collections", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(solo.email) },
        body: JSON.stringify({ title: "Mine" }),
      })
    ).json()
    // …and cannot file it under the other workspace's folder (folder not in their org).
    const res = await other.request(`/v1/collections/${col.id}/folder`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(solo.email) },
      body: JSON.stringify({ folderId: folder.id }),
    })
    expect(res.status).toBe(404)
  })

  it("folder mutations are workspace-owner-only; a member editor can read but not write", async () => {
    const owner: TestUser = {
      id: "u_fld_own",
      email: "own@fld.test",
      name: "Own",
      username: "ownf",
    }
    const ed: TestUser = { id: "u_fld_ed", email: "ed@fld.test", name: "Ed", username: "edf" }
    const { app: team } = makeAuthedApp("folders-roles", [owner, ed], "editor")

    const created = await team.request("/v1/folders", {
      method: "POST",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ name: "Team" }),
    })
    expect(created.status).toBe(201)
    const folder = await created.json()

    // The editor sees the shared folder tree…
    const list = await (await team.request("/v1/folders", { headers: as(ed.email) })).json()
    expect(list.folders.map((f: { id: string }) => f.id)).toContain(folder.id)

    // …but can't create / rename / delete (owner-only).
    const create = await team.request("/v1/folders", {
      method: "POST",
      headers: { "content-type": "application/json", ...as(ed.email) },
      body: JSON.stringify({ name: "Nope" }),
    })
    expect(create.status).toBe(403)
    const rename = await team.request(`/v1/folders/${folder.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ed.email) },
      body: JSON.stringify({ name: "X" }),
    })
    expect(rename.status).toBe(403)
    const del = await team.request(`/v1/folders/${folder.id}`, {
      method: "DELETE",
      headers: as(ed.email),
    })
    expect(del.status).toBe(403)
  })
})
