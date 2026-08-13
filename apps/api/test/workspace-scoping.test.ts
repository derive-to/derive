import { beforeAll, describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Listing/counting must stay consistent with workspace scoping: a collection's
// artifacts live in the COLLECTION's workspace, and the favorites count must match
// the (workspace-scoped) favorites list. Regression tests for the two scoping bugs.
describe("workspace scoping: collections + favorites", () => {
  const owner: TestUser = { id: "u_ws_owner", email: "owner@ws.test", name: "Owner" }
  const collaborator: TestUser = {
    id: "u_ws_collab",
    email: "collab@ws.test",
    name: "Collaborator",
  }
  const outsider: TestUser = { id: "u_ws_out", email: "out@ws.test", name: "Outsider" }
  // Both seed into the shared "default" workspace (owner = admin); their ACTIVE
  // workspace (no cookie) is "default".
  const { app, meta } = makeAuthedApp("ws-scoping", [owner, collaborator, outsider])

  // A second workspace B with one artifact + a collection holding it. owner is a
  // member of B; outsider is not. Seeded once for the whole describe.
  const colId = "col_inB"
  beforeAll(async () => {
    await meta.setWorkspace("wsB", "Workspace B")
    await meta.setMembership({ id: "m_wsB_owner", org_id: "wsB", user_id: owner.id, role: "owner" })
    await meta.setMembership({
      id: "m_wsB_collab",
      org_id: "wsB",
      user_id: collaborator.id,
      role: "owner",
    })
    const art = await meta.createArtifact({
      id: "a_inB",
      short_id: "binb01",
      org_id: "wsB",
      slug: null,
      title: "Doc in B",
      workspace_access: "member",
      link_role: "none",
      listed: "workspace",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(art.id, {
      id: "v_inB",
      blob_key: "k_inB",
      content_type: "text/html",
      size_bytes: 1,
      author: "Owner",
      message: null,
    })
    // Historical owner rows can exist from before ownership became workspace-
    // bound. This one must not leak authority into the default workspace.
    await meta.setArtifactMember({
      id: "am_inB_collab",
      artifact_id: art.id,
      user_id: collaborator.id,
      role: "owner",
    })
    const col = await meta.createCollection({
      id: "col_inB",
      org_id: "wsB",
      title: "B Collection",
      created_by: owner.id,
    })
    await meta.addCollectionItem(col.id, art.id)
    await meta.setCollectionMember({
      id: "cm_inB_collab",
      collection_id: col.id,
      user_id: collaborator.id,
      role: "editor",
    })
  })

  it("binds collection ownership to its workspace while preserving collaborator shares", async () => {
    // The owner's active workspace is "default", while their collection lives in
    // wsB. Creator ownership must not cross that workspace boundary.
    const res = await app.request(`/v1/artifacts?collection=${colId}`, { headers: as(owner.email) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.artifacts).toEqual([])
    expect(body).not.toHaveProperty("collection")

    // A deliberate non-owner collection share is portable. Its listing scopes to
    // the collection's workspace and carries the title for the cold-linked view.
    const shared = await app.request(`/v1/artifacts?collection=${colId}`, {
      headers: as(collaborator.email),
    })
    const sharedBody = await shared.json()
    expect(sharedBody.artifacts.map((a: { short_id: string }) => a.short_id)).toContain("binb01")
    expect(sharedBody.collection).toMatchObject({ id: colId, title: "B Collection" })
    // The card carries the portable collection grant, not the foreign workspace's
    // stronger owner seat, and therefore matches the detail page.
    expect(sharedBody.artifacts[0]?.my_role).toBe("editor")
    const sharedDetail = await app.request("/v1/artifacts/binb01", {
      headers: as(collaborator.email),
    })
    expect(sharedDetail.status).toBe(200)
    expect((await sharedDetail.json()).my_role).toBe("editor")

    // In-collection search follows the same portable share.
    const res2 = await app.request(`/v1/artifacts?collection=${colId}&query=Doc%20in%20B`, {
      headers: as(collaborator.email),
    })
    expect((await res2.json()).artifacts.map((a: { short_id: string }) => a.short_id)).toContain(
      "binb01",
    )

    // outsider isn't a member of wsB and holds no collection share → no non-public
    // artifacts (the workspace-visibility doc is hidden).
    const res3 = await app.request(`/v1/artifacts?collection=${colId}`, {
      headers: as(outsider.email),
    })
    expect((await res3.json()).artifacts).toEqual([])

    // unknown collection id → empty, not a crash.
    const res4 = await app.request(`/v1/artifacts?collection=col_nope`, {
      headers: as(owner.email),
    })
    expect((await res4.json()).artifacts).toEqual([])
  })

  it("favorites count matches the workspace-scoped list (no cross-workspace inflation)", async () => {
    // Favorite the wsB artifact while active in "default".
    await meta.setFavorite("a_inB", owner.id)
    // Publish + favorite an artifact in the active ("default") workspace.
    const here = await (await publishAs(app, "<h1>here</h1>", {}, as(owner.email))).json()
    await meta.setFavorite((await meta.getByShortId(here.short_id))?.id ?? "", owner.id)

    // /v1/tags is the active workspace's summary → counts only the default-ws favorite.
    const tags = await (await app.request("/v1/tags", { headers: as(owner.email) })).json()
    expect(tags.favorites).toBe(1)

    // …and that count equals the favorites list length (the bug was count=2, list=1).
    const list = await (
      await app.request("/v1/artifacts?favorite=true", { headers: as(owner.email) })
    ).json()
    expect(list.artifacts).toHaveLength(1)
    expect(list.artifacts[0].short_id).toBe(here.short_id)
  })
})
