import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// A collection's own share experience (docs/plans/access-model.md, extended to
// collections): workspace_access none|member, same Invited/Workspace toggle the
// Share dialog exposes for artifacts. Companion to the seat-folding coverage in
// collections.test.ts.

const ana: TestUser = { id: "u_ca_ana", email: "ana@ca.test", name: "Ana" }
const ben: TestUser = { id: "u_ca_ben", email: "ben@ca.test", name: "Ben" }
const cara: TestUser = { id: "u_ca_cara", email: "cara@ca.test", name: "Cara" }

describe("a collection's own workspace access", () => {
  // ana is the Admin/owner of "default"; ben and cara are editors there
  // (makeAuthedApp's default team seeding: users[0] = owner, the rest = defaultRole).
  const { app, meta } = makeAuthedApp("ca", [ana, ben, cara], "editor")

  const create = async (title: string, actor: Record<string, string>) => {
    const r = await app.request("/v1/collections", jsonAs(actor, { title }))
    return r.json()
  }
  const setAccess = (colId: string, workspaceAccess: string, actor: Record<string, string>) =>
    app.request(`/v1/collections/${colId}/access`, {
      ...jsonAs(actor, { workspaceAccess }),
      method: "PATCH",
    })

  it("defaults to workspace-open; toggling to Invited hides it from plain members", async () => {
    const col = await create("Team docs", as(ana.email))
    expect(col.workspace_access).toBe("member")
    expect(col.my_role).toBe("owner")

    // Ben, a plain workspace editor with no explicit collectionMember row, sees
    // it in the list and can open the roster — the seat-fold this PR builds on.
    const listedForBen = await (
      await app.request("/v1/collections", { headers: as(ben.email) })
    ).json()
    expect(listedForBen.collections.map((c: { id: string }) => c.id)).toContain(col.id)
    expect(
      (await app.request(`/v1/collections/${col.id}/members`, { headers: as(ben.email) })).status,
    ).toBe(200)

    // Ana (owner) flips it to Invited.
    const flipped = await setAccess(col.id, "none", as(ana.email))
    expect(flipped.status).toBe(200)
    expect((await flipped.json()).workspace_access).toBe("none")

    // Ben loses it entirely — not in the list, 404 on the roster — same as a
    // stranger to a private artifact, not merely hidden-but-reachable.
    const listedAfter = await (
      await app.request("/v1/collections", { headers: as(ben.email) })
    ).json()
    expect(listedAfter.collections.map((c: { id: string }) => c.id)).not.toContain(col.id)
    expect(
      (await app.request(`/v1/collections/${col.id}/members`, { headers: as(ben.email) })).status,
    ).toBe(404)

    // Ana (the creator) still has it, and it still lists for her.
    const listedForAna = await (
      await app.request("/v1/collections", { headers: as(ana.email) })
    ).json()
    expect(listedForAna.collections.map((c: { id: string }) => c.id)).toContain(col.id)
  })

  it("an explicit share still reaches an Invited collection", async () => {
    const col = await create("Invite only", as(ana.email))
    await setAccess(col.id, "none", as(ana.email))
    // Cara has no seat-fold now, but Ana adds her by hand.
    expect(
      (await app.request(`/v1/collections/${col.id}/members`, { headers: as(cara.email) })).status,
    ).toBe(404)
    await app.request(`/v1/collections/${col.id}/members`, {
      ...jsonAs(as(ana.email), { user: cara.email, role: "viewer" }),
      method: "PUT",
    })
    const seenByCara = await app.request(`/v1/collections/${col.id}/members`, {
      headers: as(cara.email),
    })
    expect(seenByCara.status).toBe(200)
    expect(
      (await seenByCara.json()).members.find((m: { user_id: string }) => m.user_id === cara.id)
        ?.role,
    ).toBe("viewer")
  })

  it("only a manager can change the access — a plain editor can't widen or narrow it", async () => {
    const col = await create("Ana's call", as(ana.email))
    // Cara is a workspace editor (seat-folds to "editor" on the collection, per
    // collectionRole) but that's below the "manage" bar this route gates on —
    // same bar as delete/member add/remove.
    expect((await setAccess(col.id, "none", as(cara.email))).status).toBe(403)
    expect((await meta.getCollection(col.id))?.workspace_access).toBe("member")
  })

  // Regression: the /v1/artifacts feed's own collection-scoping check used to grant
  // access from PLAIN workspace membership (`isMember(org)`), independent of the
  // collection's own workspace_access — so toggling a collection to Invited hid it
  // from the Collections list/dialog but the feed endpoint that actually lists its
  // artifacts kept serving them (and the collection's title) to every workspace
  // member regardless. Caught live: a seat-only member's browser tab, already
  // sitting on the collection, kept rendering it after the toggle.
  it("toggling to Invited also hides the collection's artifacts from the feed listing", async () => {
    const col = await create("Roadmap", as(ana.email))
    const { short_id } = await (
      await publishAs(app, "<p>plans</p>", { title: "Q3 plan", listed: "workspace" }, as(ana.email))
    ).json()
    await app.request(`/v1/collections/${col.id}/items/${short_id}`, {
      method: "PUT",
      headers: as(ana.email),
    })

    // Ben (seat-folded editor, no explicit share) sees it while the collection is
    // workspace-open — same feed a workspace member browses today.
    const openFeed = await (
      await app.request(`/v1/artifacts?collection=${col.id}`, { headers: as(ben.email) })
    ).json()
    expect(openFeed.artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([short_id])
    expect(openFeed.collection?.title).toBe("Roadmap")

    await setAccess(col.id, "none", as(ana.email))

    const invitedFeed = await (
      await app.request(`/v1/artifacts?collection=${col.id}`, { headers: as(ben.email) })
    ).json()
    expect(invitedFeed.artifacts).toEqual([])
    // The collection's title doesn't leak to a caller who no longer has a role on it.
    expect(invitedFeed.collection).toBeUndefined()
  })
})
