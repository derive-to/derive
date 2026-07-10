import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Share-by-email to someone with NO account: the PUT creates a pending invite
// (emailed out-of-band), the token previews and accepts into a per-artifact
// membership, and the share dialog's roster lists/revokes pending invites.
// Replay, supersede, mismatch, and the need-to-know gate on invitee emails are
// pinned here. (The exact-email happy path needs an account that signs up AFTER
// the invite — the fake auth here can't mint one mid-test, so the share e2e
// covers it end to end.)
describe("artifact invites (share-by-email → accept)", () => {
  const owner: TestUser = { id: "u_ai_owner", email: "owner@ai.test", name: "Olive" }
  // An existing account that redeems tokens addressed to OTHER emails (the
  // possession-authorizes + mismatch-confirm path).
  const redeemer: TestUser = { id: "u_ai_red", email: "redeemer@ai.test", name: "Red" }
  const { app } = makeAuthedApp("artifact-invites", [owner, redeemer], "editor")

  const invite = (shortId: string, email: string, role: string, by = owner.email) =>
    app.request(`/v1/artifacts/${shortId}/members`, {
      ...jsonAs(as(by), { email, role }),
      method: "PUT",
    })
  const accept = (token: string, by: string, body: Record<string, unknown> = {}) =>
    app.request(`/v1/artifact-invites/${token}/accept`, {
      ...jsonAs(as(by), body),
      method: "POST",
    })
  const publish = async () =>
    (await (await publishAs(app, "<h1>doc</h1>", {}, as(owner.email))).json()).short_id as string

  it("an unknown email creates a pending invite with an accept link", async () => {
    const sid = await publish()
    const res = await invite(sid, "fool@external.test", "commenter")
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.kind).toBe("invite")
    expect(body.invite).toMatchObject({ email: "fool@external.test", role: "commenter" })
    // The raw token rides only the accept link; the invite payload never carries it.
    expect(body.invite).not.toHaveProperty("token")
    expect(body.accept_url).toContain("/invite/a/")

    // The pending invite shows on the roster for share-capable callers.
    const roster = await (
      await app.request(`/v1/artifacts/${sid}/members`, { headers: as(owner.email) })
    ).json()
    expect(roster.invites).toHaveLength(1)
    expect(roster.invites[0].email).toBe("fool@external.test")
  })

  it("the token previews, 409s a mismatched account, then accepts on confirm", async () => {
    const sid = await publish()
    const { accept_url } = await (await invite(sid, "stranger@external.test", "commenter")).json()
    const token = accept_url.split("/invite/a/")[1]

    // Preview is unauthenticated — possession authorizes.
    const preview = await (await app.request(`/v1/artifact-invites/${token}`)).json()
    expect(preview).toMatchObject({
      role: "commenter",
      email: "stranger@external.test",
      inviter: "Olive",
    })

    // A signed-in account under a DIFFERENT email is surfaced, not silently joined.
    expect((await accept(token, redeemer.email)).status).toBe(409)
    const acc = await accept(token, redeemer.email, { confirm_mismatch: true })
    expect(acc.status).toBe(200)
    expect(await acc.json()).toMatchObject({ short_id: sid, role: "commenter" })

    // The membership is real: on the roster, invite gone, token spent.
    const roster = await (
      await app.request(`/v1/artifacts/${sid}/members`, { headers: as(owner.email) })
    ).json()
    expect(roster.members.some((m: { user_id: string }) => m.user_id === redeemer.id)).toBe(true)
    expect(roster.invites).toHaveLength(0)
    expect((await accept(token, redeemer.email, { confirm_mismatch: true })).status).toBe(404)
  })

  it("accepting never downgrades an existing higher share", async () => {
    const sid = await publish()
    // Redeemer is already an editor-member; a stray commenter invite must not demote.
    expect((await invite(sid, redeemer.email, "editor")).status).toBe(201)
    const { accept_url } = await (await invite(sid, "alias@external.test", "commenter")).json()
    const token = accept_url.split("/invite/a/")[1]
    const acc = await (await accept(token, redeemer.email, { confirm_mismatch: true })).json()
    expect(acc.role).toBe("editor")
  })

  it("re-inviting supersedes the old token; revoking kills the pending one", async () => {
    const sid = await publish()
    const first = await (await invite(sid, "x@external.test", "viewer")).json()
    const second = await (await invite(sid, "x@external.test", "commenter")).json()
    // The first token died when the second was minted.
    const t1 = first.accept_url.split("/invite/a/")[1]
    expect((await app.request(`/v1/artifact-invites/${t1}`)).status).toBe(404)

    // Revoke the pending invite; its token stops resolving.
    const del = await app.request(`/v1/artifacts/${sid}/invites/${second.invite.id}`, {
      headers: as(owner.email),
      method: "DELETE",
    })
    expect(del.status).toBe(204)
    const t2 = second.accept_url.split("/invite/a/")[1]
    expect((await app.request(`/v1/artifact-invites/${t2}`)).status).toBe(404)
  })

  it("an unknown @handle is still a plain miss, and anon can't invite", async () => {
    const sid = await publish()
    expect((await invite(sid, "@nobody", "viewer")).status).toBe(404)
    const anon = await app.request(`/v1/artifacts/${sid}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.test", role: "viewer" }),
    })
    expect([401, 403, 404]).toContain(anon.status)
  })
})

// The need-to-know gate on invitee emails: a collaborator who cannot themselves
// share (viewer seat + viewer share) sees the member roster but never the
// pending-invite emails.
describe("artifact invites — invitee emails are need-to-know", () => {
  const owner: TestUser = { id: "u_aig_owner", email: "owner@aig.test", name: "Olive" }
  const viewer: TestUser = { id: "u_aig_viewer", email: "viewer@aig.test", name: "Vera" }
  const { app } = makeAuthedApp("artifact-invites-gate", [owner, viewer], "viewer")

  it("a viewer collaborator sees members but no invites", async () => {
    const sid = (await (await publishAs(app, "<h1>d</h1>", {}, as(owner.email))).json()).short_id
    const put = await app.request(`/v1/artifacts/${sid}/members`, {
      ...jsonAs(as(owner.email), { email: "secret@external.test", role: "viewer" }),
      method: "PUT",
    })
    expect(put.status).toBe(201)

    const asViewer = await (
      await app.request(`/v1/artifacts/${sid}/members`, { headers: as(viewer.email) })
    ).json()
    expect(asViewer.invites).toHaveLength(0)

    const asOwner = await (
      await app.request(`/v1/artifacts/${sid}/members`, { headers: as(owner.email) })
    ).json()
    expect(asOwner.invites).toHaveLength(1)
  })
})
