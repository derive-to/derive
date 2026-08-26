import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// POST /v1/artifacts/:shortId/move — owner-only, destination is any workspace
// you belong to (any role). Companion to the "default" workspace tests in
// workspace.test.ts; this suite seeds its own extra workspaces per case.

const ana: TestUser = { id: "u_move_ana", email: "ana@move.test", name: "Ana" }
const ben: TestUser = { id: "u_move_ben", email: "ben@move.test", name: "Ben" }

const workspaceCookie = (res: Response): string => {
  const match = (res.headers.get("set-cookie") ?? "").match(/derive_ws=([^;]+)/)
  return match ? `derive_ws=${match[1]}` : ""
}

const linkedBundle = (refs: string[]): string =>
  `<!doctype html><html><body>${refs
    .map((ref) => `<a href="/artifacts/${ref}">${ref}</a>`)
    .join("")}<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify({
    schema: "derive.linked-bundle/v1",
    purpose: "Exercise recursive workspace moves",
    members: refs.map((ref, i) => ({ id: `member-${i}`, ref, label: `Member ${i}` })),
  })}</script></body></html>`

describe("move an artifact to a different workspace", () => {
  // ana is the Admin/owner of "default"; ben is an editor there (makeAuthedApp's
  // default team seeding: users[0] = owner, the rest = defaultRole).
  const { app, meta } = makeAuthedApp("move-artifact", [ana, ben], "editor")

  it("owner-only, and only into a workspace you're a member of", async () => {
    const a = await (await publishAs(app, "<h1>doc</h1>", {}, as(ana.email))).json()

    // Ben is an editor, not an owner — refused before even checking the target.
    const forbidden = await app.request(
      `/v1/artifacts/${a.short_id}/move`,
      jsonAs(as(ben.email), { targetOrgId: "nope" }),
    )
    expect(forbidden.status).toBe(403)

    // A real workspace, but Ana isn't a member of it — still refused.
    await meta.setWorkspace("not-anas", "Not Ana's")
    const notMember = await app.request(
      `/v1/artifacts/${a.short_id}/move`,
      jsonAs(as(ana.email), { targetOrgId: "not-anas" }),
    )
    expect(notMember.status).toBe(403)

    // Ana joins "acme" as an editor (not owner) — the destination needs no role
    // floor, so the move still succeeds.
    await meta.setWorkspace("acme", "Acme")
    await meta.setMembership({ id: "m_ana_acme", org_id: "acme", user_id: ana.id, role: "editor" })
    const moved = await app.request(
      `/v1/artifacts/${a.short_id}/move`,
      jsonAs(as(ana.email), { targetOrgId: "acme" }),
    )
    expect(moved.status).toBe(200)
    expect((await moved.json()).org_id).toBe("acme")

    // Moving does not silently switch the whole application. The artifact leaves
    // the active workspace immediately, so even its creator cannot keep opening
    // it through an owner row that belongs to another workspace.
    const leftBehind = await app.request(`/v1/artifacts/${a.short_id}`, {
      headers: as(ana.email),
    })
    expect(leftBehind.status).toBe(409)
    expect(await leftBehind.json()).toMatchObject({
      code: "workspace_mismatch",
      workspace: { id: "acme", name: "Acme" },
    })

    // In the destination workspace, the workspace-bound owner row applies again.
    // Ana only has an editor seat there, so this also proves ownership comes from
    // the artifact grant without making that grant portable across workspaces.
    const switched = await app.request(
      "/v1/workspace/switch",
      jsonAs(as(ana.email), { id: "acme" }),
    )
    expect(switched.status).toBe(200)
    const inAcme = { ...as(ana.email), cookie: workspaceCookie(switched) }
    const detail = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: inAcme })
    ).json()
    expect(detail.org_id).toBe("acme")
    expect(detail.my_role).toBe("owner")

    // Moving into the workspace it's already in is a no-op error, not a 200.
    const noop = await app.request(
      `/v1/artifacts/${a.short_id}/move`,
      jsonAs(inAcme, { targetOrgId: "acme" }),
    )
    expect(noop.status).toBe(400)
  })

  it("leaves any collection it was in, and refuses when a custom domain is bound", async () => {
    const a = await (await publishAs(app, "<h1>doc2</h1>", {}, as(ana.email))).json()
    const art = await meta.getByShortId(a.short_id)
    if (!art) throw new Error("missing artifact")
    const col = await meta.createCollection({
      id: "c_move_test",
      org_id: "default",
      title: "Move test",
      created_by: ana.id,
    })
    await meta.addCollectionItem(col.id, art.id)
    expect(await meta.collectionIdsForArtifact(art.id)).toContain(col.id)

    await meta.setWorkspace("acme2", "Acme 2")
    await meta.setMembership({ id: "m_ana_acme2", org_id: "acme2", user_id: ana.id, role: "owner" })
    const moved = await app.request(
      `/v1/artifacts/${a.short_id}/move`,
      jsonAs(as(ana.email), { targetOrgId: "acme2" }),
    )
    expect(moved.status).toBe(200)
    expect(await meta.collectionIdsForArtifact(art.id)).toEqual([])

    // A second artifact, bound to a custom domain: the move is refused rather
    // than silently orphaning the domain's routing.
    const b = await (await publishAs(app, "<h1>doc3</h1>", {}, as(ana.email))).json()
    const bArt = await meta.getByShortId(b.short_id)
    if (!bArt) throw new Error("missing artifact")
    await meta.setDomain({
      host: "doc3.move-test.derive.to",
      artifact_id: bArt.id,
      org_id: "default",
      kind: "subdomain",
    })
    const blocked = await app.request(
      `/v1/artifacts/${b.short_id}/move`,
      jsonAs(as(ana.email), { targetOrgId: "acme2" }),
    )
    expect(blocked.status).toBe(409)
  })

  it("recursively moves a linked bundle graph once, survives cycles, and leaves external refs alone", async () => {
    const leaf = await (await publishAs(app, "# Leaf", {}, as(ana.email))).json()
    const shared = await (await publishAs(app, "# Shared", {}, as(ana.email))).json()
    const external = await (await publishAs(app, "# External", {}, as(ana.email))).json()

    await meta.setWorkspace("move-external", "Move external")
    await meta.setMembership({
      id: "m_ana_move_external",
      org_id: "move-external",
      user_id: ana.id,
      role: "owner",
    })
    expect(
      (
        await app.request(
          `/v1/artifacts/${external.short_id}/move`,
          jsonAs(as(ana.email), { targetOrgId: "move-external" }),
        )
      ).status,
    ).toBe(200)

    const nested = await (
      await publishAs(app, linkedBundle([leaf.short_id, shared.short_id]), {}, as(ana.email))
    ).json()
    const root = await (
      await publishAs(
        app,
        linkedBundle([nested.short_id, shared.short_id, external.short_id]),
        {},
        as(ana.email),
      )
    ).json()
    // Re-publish the nested shell with a back-edge to the root. The traversal must
    // terminate, and the shared leaf reached from both shells must move only once.
    expect(
      (
        await publishAs(
          app,
          linkedBundle([leaf.short_id, shared.short_id, root.short_id]),
          {},
          as(ana.email),
          nested.short_id,
        )
      ).status,
    ).toBe(201)

    await meta.setWorkspace("move-target", "Move target")
    await meta.setMembership({
      id: "m_ana_move_target",
      org_id: "move-target",
      user_id: ana.id,
      role: "editor",
    })
    const moved = await app.request(
      `/v1/artifacts/${root.short_id}/move`,
      jsonAs(as(ana.email), { targetOrgId: "move-target" }),
    )
    expect(moved.status).toBe(200)

    for (const shortId of [root.short_id, nested.short_id, leaf.short_id, shared.short_id])
      expect((await meta.getByShortId(shortId))?.org_id).toBe("move-target")
    expect((await meta.getByShortId(external.short_id))?.org_id).toBe("move-external")
  })

  it("preflights every linked member so a blocked descendant leaves the whole graph untouched", async () => {
    const leaf = await (await publishAs(app, "# Domain leaf", {}, as(ana.email))).json()
    const nested = await (
      await publishAs(app, linkedBundle([leaf.short_id]), {}, as(ana.email))
    ).json()
    const root = await (
      await publishAs(app, linkedBundle([nested.short_id]), {}, as(ana.email))
    ).json()
    const leafArtifact = await meta.getByShortId(leaf.short_id)
    if (!leafArtifact) throw new Error("missing linked leaf")
    await meta.setDomain({
      host: "linked-leaf.move-test.derive.to",
      artifact_id: leafArtifact.id,
      org_id: "default",
      kind: "subdomain",
    })

    await meta.setWorkspace("move-preflight-target", "Move preflight target")
    await meta.setMembership({
      id: "m_ana_move_preflight_target",
      org_id: "move-preflight-target",
      user_id: ana.id,
      role: "owner",
    })
    const blocked = await app.request(
      `/v1/artifacts/${root.short_id}/move`,
      jsonAs(as(ana.email), { targetOrgId: "move-preflight-target" }),
    )
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({
      error: expect.stringContaining(leaf.short_id),
    })
    for (const shortId of [root.short_id, nested.short_id, leaf.short_id])
      expect((await meta.getByShortId(shortId))?.org_id).toBe("default")
  })
})
