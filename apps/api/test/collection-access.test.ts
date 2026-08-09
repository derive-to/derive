import { describe, expect, it } from "vitest"
import { sha256 } from "../src/lib/crypto"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// A collection's own share experience (docs/access-model.md, extended to
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

  // Regression: the phantom-empty collection. The list count is a raw item count, but a
  // seat-only member (no explicit share) used to get NO role on a PRIVATE artifact inside
  // a workspace-open collection — so "· 1" rendered an empty body and opening the item
  // 404'd. Propagation (collectionRolesForArtifact folds the seat) + the feed's
  // collection-access bypass now let the seat reach every item, so count === contents and
  // the item actually opens.
  it("a seat-only member sees and can open a private artifact in a workspace-open collection; count matches", async () => {
    const col = await create("Eng docs", as(ana.email))
    // A truly private artifact: no workspace seat on the artifact itself, unlisted, no
    // link — the ONLY way to reach it is the collection.
    const priv = await (
      await publishAs(
        app,
        "<p>secret</p>",
        { title: "Secret", workspace_access: "none", listed: "none", link_role: "none" },
        as(ana.email),
      )
    ).json()
    await app.request(`/v1/collections/${col.id}/items/${priv.short_id}`, {
      method: "PUT",
      headers: as(ana.email),
    })

    // Ben has an editor SEAT but no explicit collection share and no artifact share. The
    // count he sees…
    const listForBen = await (
      await app.request("/v1/collections", { headers: as(ben.email) })
    ).json()
    expect(listForBen.collections.find((c: { id: string }) => c.id === col.id)?.count).toBe(1)
    // …matches the contents the feed serves him (no phantom-empty)…
    const feed = await (
      await app.request(`/v1/artifacts?collection=${col.id}`, { headers: as(ben.email) })
    ).json()
    expect(feed.artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([priv.short_id])
    // …and he can actually OPEN the item, not just see it listed (propagation reaches the
    // read path too, so no 404).
    expect(
      (await app.request(`/v1/artifacts/${priv.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(200)
  })

  // An agent holds no collection rows of its own: it borrows exactly its human's standing,
  // capped at its registered role. On an invite-only collection, the creator's agent can
  // still curate (owner standing, capped to the editor bar the routes gate on) while an
  // agent whose human has no role on it derives none — the same removal that works for
  // one is a 403 for the other, so the agent path never widens access.
  it("an agent borrows exactly its human's standing on an invite-only collection", async () => {
    const col = await create("Curated", as(ana.email))
    const { short_id } = await (
      await publishAs(app, "<p>x</p>", { title: "Curated doc" }, as(ana.email))
    ).json()
    await app.request(`/v1/collections/${col.id}/items/${short_id}`, {
      method: "PUT",
      headers: as(ana.email),
    })
    await setAccess(col.id, "none", as(ana.email))

    // Ben has a workspace seat but no role on the invite-only collection, so an agent
    // registered to him derives none — seeded directly, since registration is Admin-gated.
    const benToken = `dk_agt_${"b".repeat(64)}`
    await meta.createAgent({
      id: "ag_ca_ben",
      org_id: "default",
      name: "BenBot",
      token: sha256(benToken),
      role: "editor",
      created_by: ben.id,
    })
    const refused = await app.request(`/v1/collections/${col.id}/items/${short_id}`, {
      method: "DELETE",
      headers: bearer(benToken),
    })
    expect(refused.status).toBe(403)

    // Ana created the collection, so her agent curates it — and the item is really gone.
    const anasBot = await (
      await app.request("/v1/agents", jsonAs(as(ana.email), { name: "AnaBot", role: "editor" }))
    ).json()
    const removed = await app.request(`/v1/collections/${col.id}/items/${short_id}`, {
      method: "DELETE",
      headers: bearer(anasBot.token),
    })
    expect(removed.status).toBe(204)
    const art = await meta.getByShortId(short_id)
    if (!art) throw new Error("artifact missing")
    expect(await meta.collectionIdsForArtifact(art.id)).toEqual([])
  })

  // The creator is permanently owner via created_by — their roster row is immovable, and
  // the backend refuses to demote or remove them regardless of who asks (a self-demote,
  // or another manager trying to unseat them).
  it("the collection creator's owner role can't be demoted or removed, by anyone", async () => {
    const col = await create("Ana's collection", as(ana.email))
    const putMember = (actor: Record<string, string>, user: string, role: string) =>
      app.request(`/v1/collections/${col.id}/members`, {
        ...jsonAs(actor, { user, role }),
        method: "PUT",
      })
    const delMember = (actor: Record<string, string>, userId: string) =>
      app.request(`/v1/collections/${col.id}/members/${userId}`, {
        method: "DELETE",
        headers: actor,
      })

    // The creator can't demote or remove herself.
    expect((await putMember(as(ana.email), ana.email, "editor")).status).toBe(409)
    expect((await delMember(as(ana.email), ana.id)).status).toBe(409)

    // Another manager (cara, promoted to owner) can manage the roster but still can't
    // touch the creator.
    expect((await putMember(as(ana.email), cara.email, "owner")).status).toBe(201)
    expect((await putMember(as(cara.email), ana.email, "viewer")).status).toBe(409)
    expect((await delMember(as(cara.email), ana.id)).status).toBe(409)

    // Ana is still owner throughout.
    expect((await meta.getCollectionMember(col.id, ana.id))?.role).toBe("owner")
  })
})

// The detail response's `collection_access` — the share dialog's disclosure rows. The
// artifact's own fields can't express a collection grant (it folds into the explicit
// slot), so the detail payload must carry which collections' sharing reaches the doc,
// or the dialog renders "Invited · 1 person" on a doc the whole workspace can open.
describe("collection_access disclosure on the artifact detail", () => {
  const dana: TestUser = { id: "u_cad_ana", email: "ana@cad.test", name: "Ana" }
  const dben: TestUser = { id: "u_cad_ben", email: "ben@cad.test", name: "Ben" }
  const dcara: TestUser = { id: "u_cad_cara", email: "cara@cad.test", name: "Cara" }
  const dave: TestUser = { id: "u_cad_dave", email: "dave@cad.test", name: "Dave" }
  const { app, meta } = makeAuthedApp("cad", [dana, dben, dcara, dave], "editor")

  const detail = async (shortId: string, headers?: Record<string, string>) =>
    (await app.request(`/v1/artifacts/${shortId}`, headers ? { headers } : undefined)).json()
  const create = async (title: string, actor: Record<string, string>) =>
    (await app.request("/v1/collections", jsonAs(actor, { title }))).json()
  const addItem = (colId: string, shortId: string, actor: Record<string, string>) =>
    app.request(`/v1/collections/${colId}/items/${shortId}`, { method: "PUT", headers: actor })

  it("discloses a workspace-open collection, with each viewer's own collection role", async () => {
    const { short_id } = await (
      await publishAs(
        app,
        "<p>enablement</p>",
        { title: "Custom Offers", workspace_access: "none", listed: "none", link_role: "none" },
        as(dana.email),
      )
    ).json()
    // Outside any collection: nothing to disclose.
    expect((await detail(short_id, as(dana.email))).collection_access).toEqual([])

    const col = await create("Product Training", as(dana.email)) // workspace-open by default
    await addItem(col.id, short_id, as(dana.email))

    // The owner sees the grant with her role on the COLLECTION (owner ⇒ Manage).
    const forAna = (await detail(short_id, as(dana.email))).collection_access
    expect(forAna).toEqual([
      {
        id: col.id,
        title: "Product Training",
        workspace_access: "member",
        my_role: "owner",
        member_count: 1,
        created_by: dana.id,
        owner_name: "Ana",
      },
    ])

    // A seat-only member reaches the doc THROUGH the collection and sees the same
    // row at his seat role (editor — no Manage, just attribution).
    const forBen = (await detail(short_id, as(dben.email))).collection_access
    expect(forBen).toHaveLength(1)
    expect(forBen[0]).toMatchObject({ id: col.id, my_role: "editor", owner_name: "Ana" })
  })

  it("someone else's invite-only collection is disclosed to the artifact's manager, but never to a roleless caller", async () => {
    const { short_id } = await (
      await publishAs(
        app,
        "<p>open</p>",
        { title: "Open doc", workspace_access: "member", listed: "none", link_role: "viewer" },
        as(dana.email),
      )
    ).json()
    // Cara (workspace editor ⇒ share on the artifact) files it into her own
    // invite-only collection — a grant Ana neither made nor can see as a collection.
    const col = await create("Cara's picks", as(dcara.email))
    await app.request(`/v1/collections/${col.id}/access`, {
      ...jsonAs(as(dcara.email), { workspaceAccess: "none" }),
      method: "PATCH",
    })
    await addItem(col.id, short_id, as(dcara.email))

    // Ana manages the artifact, so she sees WHAT grants access to her doc even though
    // she has no role on the collection itself (my_role null ⇒ "Managed by Cara").
    const forAna = (await detail(short_id, as(dana.email))).collection_access
    expect(forAna).toHaveLength(1)
    expect(forAna[0]).toMatchObject({
      id: col.id,
      title: "Cara's picks",
      workspace_access: "none",
      my_role: null,
      owner_name: "Cara",
    })

    // An anonymous link viewer can open the doc but has no role on the collection and
    // doesn't manage the artifact — the private collection's existence (and title)
    // doesn't leak to them.
    expect((await detail(short_id)).collection_access).toEqual([])
  })

  // Manager standing is computed WITHOUT the world link: a signed-in stranger holding
  // an editor URL gets editor on the DOC, but must not unlock other people's private
  // collections' titles/rosters — the same class of caller the members-roster route
  // refuses (sharing's cross-workspace gate).
  it("an editor world link never unlocks other people's private collection metadata", async () => {
    const { short_id } = await (
      await publishAs(
        app,
        "<p>linked</p>",
        { title: "Linked doc", workspace_access: "member", listed: "none", link_role: "editor" },
        as(dana.email),
      )
    ).json()
    const col = await create("Cara's private list", as(dcara.email))
    await app.request(`/v1/collections/${col.id}/access`, {
      ...jsonAs(as(dcara.email), { workspaceAccess: "none" }),
      method: "PATCH",
    })
    await addItem(col.id, short_id, as(dcara.email))

    // Dave is signed in but holds NO seat anywhere — pure link-holder.
    await meta.removeMembership("default", dave.id)
    const forDave = await detail(short_id, as(dave.email))
    expect(forDave.my_role).toBe("editor") // the link grants him the doc…
    expect(forDave.collection_access).toEqual([]) // …never Cara's private collection

    // Ana (explicit owner — real standing) still sees what grants access to her doc.
    const forAna = (await detail(short_id, as(dana.email))).collection_access
    expect(forAna.map((g: { id: string }) => g.id)).toContain(col.id)
  })

  // The response contract: collection_access lists only collections that ADD reach.
  // Your own invite-only collection with just you in it reaches nobody new — the
  // server excludes it, so every consumer (MCP, CLI, web) can render the field verbatim.
  it("your own solo invite-only collection adds no reach — excluded server-side", async () => {
    const { short_id } = await (
      await publishAs(
        app,
        "<p>solo</p>",
        { title: "Solo doc", workspace_access: "none", listed: "none", link_role: "none" },
        as(dana.email),
      )
    ).json()
    const col = await create("Ana's own shelf", as(dana.email))
    await app.request(`/v1/collections/${col.id}/access`, {
      ...jsonAs(as(dana.email), { workspaceAccess: "none" }),
      method: "PATCH",
    })
    await addItem(col.id, short_id, as(dana.email))
    expect((await detail(short_id, as(dana.email))).collection_access).toEqual([])

    // Inviting one person makes it a real grant — the row appears.
    await app.request(`/v1/collections/${col.id}/members`, {
      ...jsonAs(as(dana.email), { user: dben.email, role: "viewer" }),
      method: "PUT",
    })
    const after = (await detail(short_id, as(dana.email))).collection_access
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: col.id, member_count: 2 })
  })
})
