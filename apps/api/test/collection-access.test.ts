import type { SearchIndex } from "@derive/core"
import { describe, expect, it } from "vitest"
import { sha256 } from "../src/lib/crypto"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

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

  it("shares a password link that unlocks the collection and every contained artifact", async () => {
    const col = await create("Launch room", as(ana.email))
    const artifact = await (
      await publishAs(
        app,
        "<p>launch plan</p>",
        { title: "Launch plan", workspace_access: "none", listed: "none", link_role: "none" },
        as(ana.email),
      )
    ).json()
    await app.request(`/v1/collections/${col.id}/items/${artifact.short_id}`, {
      method: "PUT",
      headers: as(ana.email),
    })

    const shared = await app.request(`/v1/collections/${col.id}/access`, {
      ...jsonAs(as(ana.email), { linkRole: "viewer", password: "swordfish" }),
      method: "PATCH",
    })
    expect(await shared.json()).toMatchObject({ link_role: "viewer", locked: true })
    expect((await app.request(`/v1/collections/${col.id}`)).status).toBe(401)
    expect((await app.request(`/v1/artifacts?collection=${col.id}`)).status).toBe(401)

    expect(
      (
        await app.request(`/v1/collections/${col.id}/unlock`, {
          ...jsonAs({}, { password: "wrong" }),
          method: "POST",
        })
      ).status,
    ).toBe(401)
    const unlocked = await app.request(`/v1/collections/${col.id}/unlock`, {
      ...jsonAs({}, { password: "swordfish" }),
      method: "POST",
    })
    expect(unlocked.status).toBe(200)
    const cookie = unlocked.headers.get("set-cookie")?.split(";")[0] ?? ""
    expect(cookie).toContain(`dkcu_${col.id}`)

    const collection = await app.request(`/v1/collections/${col.id}`, { headers: { cookie } })
    expect(collection.status).toBe(200)
    expect(await collection.json()).toMatchObject({ id: col.id, password_protected: true })
    const feed = await app.request(`/v1/artifacts?collection=${col.id}`, { headers: { cookie } })
    expect((await feed.json()).artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([
      artifact.short_id,
    ])
    // The collection link is inherited on direct item URLs as well.
    expect(
      (await app.request(`/v1/artifacts/${artifact.short_id}`, { headers: { cookie } })).status,
    ).toBe(200)
    // Public-link holders get contents, never the private collaborator roster.
    expect(
      (await app.request(`/v1/collections/${col.id}/members`, { headers: { cookie } })).status,
    ).toBe(404)
  })

  it("emails unknown people and redeems the same role-bearing invite flow as artifacts", async () => {
    const col = await create("Research", as(ana.email))
    const invited = await app.request(`/v1/collections/${col.id}/members`, {
      ...jsonAs(as(ana.email), { email: "new-person@example.test", role: "commenter" }),
      method: "PUT",
    })
    expect(invited.status).toBe(201)
    expect(await invited.json()).toMatchObject({
      kind: "invite",
      invite: { email: "new-person@example.test", role: "commenter" },
    })

    // Exercise redemption with a deterministic token for an account that can sign in.
    const token = "collection-invite-test-token"
    await meta.createCollectionInvite({
      id: "cinv_redeem",
      collection_id: col.id,
      email: ben.email,
      role: "editor",
      token: sha256(token),
      invited_by: ana.id,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    const preview = await app.request(`/v1/collection-invites/${token}`)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      title: "Research",
      role: "editor",
      email: ben.email,
    })
    const accepted = await app.request(`/v1/collection-invites/${token}/accept`, {
      method: "POST",
      headers: as(ben.email),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ collection_id: col.id, role: "editor" })
    expect((await meta.getCollectionMember(col.id, ben.id))?.role).toBe("editor")
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

describe("collection world-link standing", () => {
  const owner: TestUser = {
    id: "u_col_link_owner",
    email: "owner@collection-link.test",
    name: "Owner",
  }
  const holder: TestUser = {
    id: "u_col_link_holder",
    email: "holder@collection-link.test",
    name: "Link Holder",
  }
  const { app } = makeAuthedApp("collection-link-standing", [owner, holder], undefined, {
    isolated: true,
  })

  it("reports effective editor access without pretending a pure link holder can re-share", async () => {
    const col = await (
      await app.request("/v1/collections", jsonAs(as(owner.email), { title: "Editor link" }))
    ).json()
    await app.request(`/v1/collections/${col.id}/access`, {
      ...jsonAs(as(owner.email), { workspaceAccess: "none", linkRole: "editor" }),
      method: "PATCH",
    })

    const throughLink = await app.request(`/v1/collections/${col.id}`, {
      headers: as(holder.email),
    })
    expect(throughLink.status).toBe(200)
    expect(await throughLink.json()).toMatchObject({ my_role: "editor", can_share: false })
    expect(
      (
        await app.request(`/v1/collections/${col.id}/access`, {
          ...jsonAs(as(holder.email), { linkRole: "viewer" }),
          method: "PATCH",
        })
      ).status,
    ).toBe(403)

    const forOwner = await app.request(`/v1/collections/${col.id}`, { headers: as(owner.email) })
    expect(await forOwner.json()).toMatchObject({ my_role: "owner", can_share: true })
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
})

describe("collection suggestions", () => {
  // GET /v1/artifacts/{shortId}/collection-suggestions — the picker's semantic tier.
  // The dense index nominates neighbor ARTIFACTS with no access knowledge; these tests
  // pin what the route layers on top: vote aggregation into collections, the members-only
  // rule, and the per-collection role gate (an invite-only collection a neighbor lives in
  // must not surface for a non-member).

  const ana: TestUser = { id: "u_sug_ana", email: "ana@sug.test", name: "Ana", username: "anasug" }
  const ben: TestUser = { id: "u_sug_ben", email: "ben@sug.test", name: "Ben", username: "bensug" }

  /** A SearchIndex whose `similar` answers from a mutable map (internal artifact ids are
   *  only known after publishing, so tests fill it in as they go). */
  const fakeSearch = (neighbors: Record<string, { id: string; score: number }[]>): SearchIndex => ({
    indexArtifact: async () => {},
    indexArtifacts: async () => {},
    unindexArtifact: async () => {},
    search: async () => [],
    similar: async (_orgId, artifactId) =>
      (neighbors[artifactId] ?? []).map((n) => ({ ...n, chunk: "" })),
  })

  it("aggregates neighbor votes per collection and hides invite-only collections from non-members", async () => {
    const neighbors: Record<string, { id: string; score: number }[]> = {}
    const { app, meta } = makeAuthedApp("colsug", [ana, ben], "editor", {
      deps: { search: fakeSearch(neighbors) },
    })
    const A = as(ana.email)
    const B = as(ben.email)
    const json = { "content-type": "application/json" }

    const publish = async (title: string, headers: Record<string, string>) => {
      const r = await (await publishAs(app, `${title} body`, { title }, headers)).json()
      const art = await meta.getByShortId(r.short_id)
      if (!art) throw new Error(`missing ${title}`)
      return { shortId: r.short_id as string, id: art.id }
    }
    const target = await publish("Target", A)
    const n1 = await publish("Close neighbor", A)
    const n2 = await publish("Mid neighbor", A)
    const n3 = await publish("Far neighbor", A)

    const collection = async (title: string, headers: Record<string, string>) =>
      (await (
        await app.request("/v1/collections", {
          method: "POST",
          headers: { ...json, ...headers },
          body: JSON.stringify({ title }),
        })
      ).json()) as { id: string }
    const add = (colId: string, shortId: string, headers: Record<string, string>) =>
      app.request(`/v1/collections/${colId}/items/${shortId}`, {
        method: "PUT",
        headers: { ...json, ...headers },
      })

    // Ana's workspace-open collections: X holds the closest neighbor, Y holds the two
    // mid ones — Y must outrank X on summed votes (0.6 + 0.5 > 0.9).
    const colX = await collection("X", A)
    const colY = await collection("Y", A)
    await add(colX.id, n1.shortId, A)
    await add(colY.id, n2.shortId, A)
    await add(colY.id, n3.shortId, A)
    // Ben's INVITE-ONLY collection also holds the closest neighbor. It must surface
    // for Ben (creator = owner) and stay invisible to Ana (no role).
    const colZ = await collection("Z", B)
    expect(
      (
        await app.request(`/v1/collections/${colZ.id}/access`, {
          method: "PATCH",
          headers: { ...json, ...B },
          body: JSON.stringify({ workspaceAccess: "none" }),
        })
      ).status,
    ).toBe(200)
    await add(colZ.id, n1.shortId, B)

    neighbors[target.id] = [
      { id: n1.id, score: 0.9 },
      { id: n2.id, score: 0.6 },
      { id: n3.id, score: 0.5 },
    ]

    const suggestionsFor = async (headers: Record<string, string>) =>
      (
        (await (
          await app.request(`/v1/artifacts/${target.shortId}/collection-suggestions`, {
            headers,
          })
        ).json()) as { suggestions: { id: string; score: number }[] }
      ).suggestions

    const anas = await suggestionsFor(A)
    expect(anas.map((s) => s.id)).toEqual([colY.id, colX.id])
    expect(anas[0]?.score).toBeCloseTo(1.1)

    // Ben additionally sees his invite-only Z. X and Z tie at 0.9 and collection ids
    // are random here, so pin Y first and compare the rest as a set.
    const bens = await suggestionsFor(B)
    expect(bens.map((s) => s.id).sort()).toEqual([colX.id, colY.id, colZ.id].sort())
    expect(bens[0]?.id).toBe(colY.id)
  })
})
