import { beforeAll, describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// A workspace switch changes the authorization context, not just the library query.
// Ownership and workspace seats stay with the artifact's workspace; deliberate
// collaborator shares (viewer/commenter/editor) and world links remain portable.
describe("artifact access follows the active workspace", () => {
  const owner: TestUser = {
    id: "u_ws_art_owner",
    email: "owner@ws-art.test",
    name: "Owner",
  }
  const collaborator: TestUser = {
    id: "u_ws_art_collab",
    email: "collab@ws-art.test",
    name: "Collaborator",
  }
  const unsharedMember: TestUser = {
    id: "u_ws_art_unshared",
    email: "unshared@ws-art.test",
    name: "Unshared member",
  }
  // Isolated gives each person a distinct personal workspace. The owner creates a
  // second workspace below, which lets the same signed-in identity switch contexts.
  const { app, meta } = makeAuthedApp(
    "workspace-artifact-access",
    [owner, collaborator, unsharedMember],
    undefined,
    { isolated: true },
  )

  const workspaceCookie = (res: Response): string => {
    const match = (res.headers.get("set-cookie") ?? "").match(/derive_ws=([^;]+)/)
    return match ? `derive_ws=${match[1]}` : ""
  }
  const inWorkspace = (email: string, cookie: string) => ({ ...as(email), cookie })
  const publish = async (fields: Record<string, string>) => {
    const res = await publishAs(app, "<h1>workspace-bound</h1>", fields, as(owner.email))
    expect(res.status).toBe(201)
    return (await res.json()) as { short_id: string }
  }

  it("binds ownership and seats while preserving explicit shares and world links", async () => {
    const initial = await (await app.request("/v1/workspaces", { headers: as(owner.email) })).json()
    const origin = initial.workspaces[0] as { id: string }
    const unsharedSpaces = await (
      await app.request("/v1/workspaces", { headers: as(unsharedMember.email) })
    ).json()
    const unsharedPersonal = unsharedSpaces.workspaces[0] as { id: string }
    await meta.setMembership({
      id: "m_ws_art_unshared_origin",
      org_id: origin.id,
      user_id: unsharedMember.id,
      role: "viewer",
    })
    const unsharedSwitch = await app.request(
      "/v1/workspace/switch",
      jsonAs(as(unsharedMember.email), { id: unsharedPersonal.id }),
    )
    const unsharedElsewhere = inWorkspace(unsharedMember.email, workspaceCookie(unsharedSwitch))

    // One team draft exercises the workspace seat + creator owner row. The second
    // is invite-only, so its creator owner row is the only non-public way in.
    const team = await publish({
      title: "Team draft",
      workspace_access: "member",
      link_role: "none",
      listed: "none",
    })
    const invited = await publish({
      title: "Invited draft",
      workspace_access: "none",
      link_role: "none",
      listed: "none",
    })
    const world = await publish({
      title: "World link",
      workspace_access: "none",
      link_role: "viewer",
      listed: "none",
    })
    // The reported product path: "Use as template" creates a derived artifact
    // with the same human owner row as any other publish.
    const derivedRes = await app.request(`/v1/artifacts/${world.short_id}/use`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(derivedRes.status).toBe(201)
    const derived = (await derivedRes.json()) as { short_id: string }

    // Ownership is a workspace capability, so it cannot be handed to someone who
    // has no seat in the artifact's workspace. A collaborator role remains valid.
    const foreignOwner = await app.request(`/v1/artifacts/${invited.short_id}/members`, {
      ...jsonAs(as(owner.email), { email: collaborator.email, role: "owner" }),
      method: "PUT",
    })
    expect(foreignOwner.status).toBe(400)
    const unknownOwner = await app.request(`/v1/artifacts/${invited.short_id}/members`, {
      ...jsonAs(as(owner.email), { email: "future-owner@ws-art.test", role: "owner" }),
      method: "PUT",
    })
    expect(unknownOwner.status).toBe(400)
    const share = await app.request(`/v1/artifacts/${invited.short_id}/members`, {
      ...jsonAs(as(owner.email), { email: collaborator.email, role: "editor" }),
      method: "PUT",
    })
    expect(share.status).toBe(201)

    // A collection creator is also an owner. Putting the invite-only artifact in
    // their collection must not turn that owner role into a cross-workspace title leak.
    const collectionRes = await app.request(
      "/v1/collections",
      jsonAs(as(owner.email), { title: "Origin collection" }),
    )
    expect(collectionRes.status).toBe(201)
    const collection = (await collectionRes.json()) as { id: string }
    await meta.setCollectionAccess(collection.id, "none")
    const foreignCollectionOwner = await app.request(`/v1/collections/${collection.id}/members`, {
      ...jsonAs(as(owner.email), { email: collaborator.email, role: "owner" }),
      method: "PUT",
    })
    expect(foreignCollectionOwner.status).toBe(400)
    expect(
      (
        await app.request(`/v1/collections/${collection.id}/items/${invited.short_id}`, {
          method: "PUT",
          headers: as(owner.email),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/v1/collections/${collection.id}/items/${world.short_id}`, {
          method: "PUT",
          headers: as(owner.email),
        })
      ).status,
    ).toBe(200)
    const portableCollectionShare = await app.request(`/v1/collections/${collection.id}/members`, {
      ...jsonAs(as(owner.email), { email: collaborator.email, role: "viewer" }),
      method: "PUT",
    })
    expect(portableCollectionShare.status).toBe(201)
    const wrappedEditorShare = await app.request(`/v1/artifacts/${world.short_id}/members`, {
      ...jsonAs(as(owner.email), { email: collaborator.email, role: "editor" }),
      method: "PUT",
    })
    expect(wrappedEditorShare.status).toBe(201)

    // A workspace-open collection is a useful negative control: an origin seat
    // can reveal it only while origin is active, even when its artifact has a
    // portable world link.
    const openCollectionRes = await app.request(
      "/v1/collections",
      jsonAs(as(owner.email), { title: "Workspace collection" }),
    )
    expect(openCollectionRes.status).toBe(201)
    const openCollection = (await openCollectionRes.json()) as { id: string }
    expect(
      (
        await app.request(`/v1/collections/${openCollection.id}/items/${world.short_id}`, {
          method: "PUT",
          headers: as(owner.email),
        })
      ).status,
    ).toBe(200)

    // Creating the second workspace switches the active-workspace cookie to it.
    const create = await app.request(
      "/v1/workspaces",
      jsonAs(as(owner.email), { name: "Other workspace" }),
    )
    expect(create.status).toBe(201)
    const otherCookie = workspaceCookie(create)
    expect(otherCookie).not.toBe("")
    const elsewhere = inWorkspace(owner.email, otherCookie)

    // Neither the seat nor the creator's owner row follows the person into the
    // other workspace. The central gate covers detail and content, not just lists.
    const teamMismatch = await app.request(`/v1/artifacts/${team.short_id}`, {
      headers: elsewhere,
    })
    expect(teamMismatch.status).toBe(409)
    expect(await teamMismatch.json()).toMatchObject({
      code: "workspace_mismatch",
      workspace: { id: origin.id },
    })
    const invitedMismatch = await app.request(`/v1/artifacts/${invited.short_id}`, {
      headers: elsewhere,
    })
    expect(invitedMismatch.status).toBe(409)
    expect(await invitedMismatch.json()).toMatchObject({
      code: "workspace_mismatch",
      workspace: { id: origin.id },
    })
    const derivedMismatch = await app.request(`/v1/artifacts/${derived.short_id}`, {
      headers: elsewhere,
    })
    expect(derivedMismatch.status).toBe(409)
    const derivedHint = await derivedMismatch.json()
    expect(derivedHint).toMatchObject({
      code: "workspace_mismatch",
      workspace: { id: origin.id },
    })
    expect(derivedHint).not.toHaveProperty("short_id")
    expect(derivedHint).not.toHaveProperty("title")
    // Membership alone does not reveal an invite-only artifact. The switch hint
    // is offered only when switching would genuinely make the artifact readable.
    const noOracle = await app.request(`/v1/artifacts/${invited.short_id}`, {
      headers: unsharedElsewhere,
    })
    expect(noOracle.status).toBe(404)
    expect(await noOracle.json()).not.toHaveProperty("workspace")
    expect(
      (await app.request(`/v1/artifacts/${invited.short_id}/content`, { headers: elsewhere }))
        .status,
    ).toBe(404)

    // The collection's workspace-bound owner role cannot be used to enumerate the
    // old workspace's private artifact either.
    const foreignCollection = await (
      await app.request(`/v1/artifacts?collection=${collection.id}`, { headers: elsewhere })
    ).json()
    expect(foreignCollection.artifacts).toEqual([])
    expect(foreignCollection).not.toHaveProperty("collection")

    // A live world link is portable, but the old owner authority is not: in the
    // foreign workspace the same person opens at the link's viewer floor.
    const worldElsewhere = await app.request(`/v1/artifacts/${world.short_id}`, {
      headers: elsewhere,
    })
    expect(worldElsewhere.status).toBe(200)
    const worldElsewhereBody = await worldElsewhere.json()
    expect(worldElsewhereBody.my_role).toBe("viewer")
    expect(worldElsewhereBody.is_workspace_member).toBe(false)
    // Neither creator ownership nor a foreign workspace seat may disclose the
    // collection metadata wrapped around an otherwise portable artifact.
    expect(worldElsewhereBody.collection_access).toEqual([])

    const seatedWorldElsewhere = await app.request(`/v1/artifacts/${world.short_id}`, {
      headers: unsharedElsewhere,
    })
    expect(seatedWorldElsewhere.status).toBe(200)
    expect((await seatedWorldElsewhere.json()).collection_access).toEqual([])

    // A deliberate non-owner share is portable and remains discoverable through
    // Shared with me even though the collaborator's active workspace is elsewhere.
    const sharedDetail = await app.request(`/v1/artifacts/${invited.short_id}`, {
      headers: as(collaborator.email),
    })
    expect(sharedDetail.status).toBe(200)
    const sharedDetailBody = await sharedDetail.json()
    expect(sharedDetailBody.my_role).toBe("editor")
    expect(sharedDetailBody.is_workspace_member).toBe(false)
    expect(sharedDetailBody.collection_access).toEqual([
      expect.objectContaining({ id: collection.id, my_role: "viewer" }),
    ])
    const wrappedEditor = await app.request(`/v1/artifacts/${world.short_id}`, {
      headers: as(collaborator.email),
    })
    expect(wrappedEditor.status).toBe(200)
    expect((await wrappedEditor.json()).collection_access).toEqual([
      expect.objectContaining({ id: collection.id, my_role: "viewer" }),
    ])
    const sharedFeed = await (
      await app.request("/v1/artifacts?scope=shared", { headers: as(collaborator.email) })
    ).json()
    expect(sharedFeed.artifacts.map((a: { short_id: string }) => a.short_id)).toContain(
      invited.short_id,
    )

    // Switching back restores the workspace-bound owner grant.
    const back = await app.request("/v1/workspace/switch", jsonAs(elsewhere, { id: origin.id }))
    expect(back.status).toBe(200)
    const atOrigin = inWorkspace(owner.email, workspaceCookie(back))
    const restored = await app.request(`/v1/artifacts/${invited.short_id}`, {
      headers: atOrigin,
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ my_role: "owner", is_workspace_member: true })
  })
})

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
