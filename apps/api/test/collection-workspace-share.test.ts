import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Sharing a collection with an entire workspace — a live binding (org membership
// is checked at read time, not a snapshot) alongside per-user collectionMember
// shares. Companion to the per-user coverage in collections.test.ts.

const ana: TestUser = { id: "u_cws_ana", email: "ana@cws.test", name: "Ana" }
const ben: TestUser = { id: "u_cws_ben", email: "ben@cws.test", name: "Ben" }
const cara: TestUser = { id: "u_cws_cara", email: "cara@cws.test", name: "Cara" }
const dee: TestUser = { id: "u_cws_dee", email: "dee@cws.test", name: "Dee" }

describe("share a collection with a workspace", () => {
  // ana is the Admin/owner of "default"; ben and cara are editors there
  // (makeAuthedApp's default team seeding: users[0] = owner, the rest = defaultRole).
  const { app, meta } = makeAuthedApp("cws", [ana, ben, cara, dee], "editor")

  const putShare = (colId: string, role: string, actor: Record<string, string>) =>
    app.request(`/v1/collections/${colId}/workspace-share`, {
      ...jsonAs(actor, { role }),
      method: "PUT",
    })
  const deleteShare = (colId: string, actor: Record<string, string>) =>
    app.request(`/v1/collections/${colId}/workspace-share`, { method: "DELETE", headers: actor })

  it("grants org members a role without an explicit share, live and re-shareable", async () => {
    const col = await (
      await app.request("/v1/collections", jsonAs(as(ana.email), { title: "Team docs" }))
    ).json()
    const a = await (
      await publishAs(app, "<h1>private doc</h1>", { title: "Roadmap" }, as(ana.email))
    ).json()
    await app.request(`/v1/collections/${col.id}/items/${a.short_id}`, {
      method: "PUT",
      headers: as(ana.email),
    })

    // Ben is a plain org editor with no explicit share — private + no collection
    // share yet means no access.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(404)

    // Ana (the creator, so she manages it) shares the collection with the workspace.
    const shared = await putShare(col.id, "viewer", as(ana.email))
    expect(shared.status).toBe(201)
    expect((await shared.json()).role).toBe("viewer")

    // The members payload reflects it too.
    const members = await (
      await app.request(`/v1/collections/${col.id}/members`, { headers: as(ana.email) })
    ).json()
    expect(members.workspace_share).toEqual({ role: "viewer" })
    expect(members.workspace.id).toBe("default")

    // Ben now reads it — via the workspace share, no per-user row for him exists.
    const benRead = await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })
    expect(benRead.status).toBe(200)
    expect((await benRead.json()).my_role).toBe("viewer")
    expect(
      await meta.collectionRolesForArtifact(
        (await meta.getByShortId(a.short_id))?.id ?? "",
        ben.id,
      ),
    ).toEqual(["viewer"])

    // Re-sharing at a higher role updates the same row rather than adding a second.
    await putShare(col.id, "editor", as(ana.email))
    const afterReshare = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })
    ).json()
    expect(afterReshare.my_role).toBe("editor")

    // Removing the share revokes access again.
    expect((await deleteShare(col.id, as(ana.email))).status).toBe(204)
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(404)
  })

  it("only someone who can manage the collection may set or remove its workspace share", async () => {
    const col = await (
      await app.request("/v1/collections", jsonAs(as(ana.email), { title: "Ana only" }))
    ).json()
    // Cara is an org editor but neither the creator nor an explicit collection
    // member — canManageCollection has nothing to grant her here.
    expect((await putShare(col.id, "viewer", as(cara.email))).status).toBe(403)
    expect((await deleteShare(col.id, as(cara.email))).status).toBe(403)
    expect(await meta.getCollectionWorkspaceShare(col.id)).toBeNull()
  })

  it("a workspace share only benefits members of that workspace", async () => {
    const col = await (
      await app.request("/v1/collections", jsonAs(as(ana.email), { title: "Members only" }))
    ).json()
    const a = await (await publishAs(app, "<h1>x</h1>", { title: "Gated" }, as(ana.email))).json()
    await app.request(`/v1/collections/${col.id}/items/${a.short_id}`, {
      method: "PUT",
      headers: as(ana.email),
    })
    await putShare(col.id, "viewer", as(ana.email))

    // Dee leaves "default" — a workspace share is scoped to actual membership,
    // not just "signed in and known to this instance".
    await meta.removeMembership("default", dee.id)
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(dee.email) })).status,
    ).toBe(404)
  })
})
