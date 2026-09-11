import { describe, expect, it } from "vitest"
import { isLiveJoinLink, JOIN_LINK_TTL_MS } from "../src/lib/join-link"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// The workspace join link: one shareable URL per workspace. Anyone who opens it joins at the
// link's role. Owner-only to create, revocable, 30-day expiry, never grants owner.
describe("workspace join link", () => {
  const admin: TestUser = { id: "u_jl_admin", email: "jladmin@derive.test", name: "Ada" }
  const teammate: TestUser = { id: "u_jl_mate", email: "jlmate@derive.test", name: "Mo" }
  const outsider: TestUser = { id: "u_jl_out", email: "jlout@derive.test", name: "Sam" }
  const second: TestUser = { id: "u_jl_two", email: "jltwo@derive.test", name: "Tia" }
  const { app, meta } = makeAuthedApp("join_link", [admin, teammate, outsider, second], "editor", {
    isolated: true,
  })

  const create = (headers: Record<string, string>, body: unknown = {}) =>
    app.request("/v1/workspace/join-link", { ...jsonAs(headers, body), method: "POST" })
  const tokenOf = (link: { url: string }) => link.url.split("/join/")[1] ?? ""
  const join = (token: string, headers?: Record<string, string>) =>
    app.request(`/v1/join/${token}`, { method: "POST", headers })

  it("creates a Creator link by default, and GET returns it without a 500 for 'none'", async () => {
    expect(
      (await app.request("/v1/workspace/join-link", { headers: as(admin.email) })).status,
    ).toBe(404)
    const res = await create(as(admin.email))
    expect(res.status).toBe(201)
    const link = await res.json()
    expect(link.role).toBe("editor")
    expect(link.url).toContain("/join/dkj_")
    expect(link.join_count).toBe(0)
    const got = await (
      await app.request("/v1/workspace/join-link", { headers: as(admin.email) })
    ).json()
    expect(got.id).toBe(link.id)
    expect(got.url).toBe(link.url)
  })

  it("never grants owner, and accepts commenter explicitly", async () => {
    expect((await create(as(admin.email), { role: "owner" })).status).toBe(400)
    const res = await create(as(admin.email), { role: "commenter" })
    expect(res.status).toBe(201)
    expect((await res.json()).role).toBe("commenter")
  })

  it("rejects a non-owner creating, reading, or revoking the link", async () => {
    // Make teammate a Creator (member, not Admin) first.
    const add = await app.request("/v1/workspace/members", {
      ...jsonAs(as(admin.email), { email: teammate.email, role: "editor" }),
      method: "PUT",
    })
    expect(add.status).toBe(201)
    expect((await create(as(teammate.email))).status).toBe(403)
    expect(
      (await app.request("/v1/workspace/join-link", { headers: as(teammate.email) })).status,
    ).toBe(403)
    expect(
      (
        await app.request("/v1/workspace/join-link", {
          method: "DELETE",
          headers: as(teammate.email),
        })
      ).status,
    ).toBe(403)
  })

  it("previews without auth, joins the signed-in holder at the link's role, and counts the join", async () => {
    const link = await (await create(as(admin.email), { role: "editor" })).json()
    const token = tokenOf(link)
    const preview = await app.request(`/v1/join/${token}`)
    expect(preview.status).toBe(200)
    const p = await preview.json()
    expect(p.role).toBe("editor")
    expect(p.workspace).toBeTruthy()
    expect(p.inviter).toBe("Ada")

    const res = await join(token, as(outsider.email))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe("editor")
    expect(body.already_member).toBe(false)
    const w = await (await app.request("/v1/workspace", { headers: as(admin.email) })).json()
    expect(w.members.some((m: { user_id: string }) => m.user_id === outsider.id)).toBe(true)
    const got = await (
      await app.request("/v1/workspace/join-link", { headers: as(admin.email) })
    ).json()
    expect(got.join_count).toBe(1)

    // Joining again is idempotent: 200, already_member, no role change, no second count.
    const again = await (await join(token, as(outsider.email))).json()
    expect(again.already_member).toBe(true)
    expect(again.role).toBe("editor")
    const gotAgain = await (
      await app.request("/v1/workspace/join-link", { headers: as(admin.email) })
    ).json()
    expect(gotAgain.join_count).toBe(1)
  })

  it("never downgrades an existing member", async () => {
    // admin is the owner; a Viewer link must not touch their role.
    const link = await (await create(as(admin.email), { role: "commenter" })).json()
    const res = await (await join(tokenOf(link), as(admin.email))).json()
    expect(res.already_member).toBe(true)
    expect(res.role).toBe("owner")
  })

  it("rotates on re-create: the old token stops working", async () => {
    const first = await (await create(as(admin.email))).json()
    const second_ = await (await create(as(admin.email))).json()
    expect(second_.url).not.toBe(first.url)
    expect((await app.request(`/v1/join/${tokenOf(first)}`)).status).toBe(404)
    expect((await app.request(`/v1/join/${tokenOf(second_)}`)).status).toBe(200)
  })

  it("revokes: preview and join both 404 afterwards", async () => {
    const link = await (await create(as(admin.email))).json()
    const del = await app.request("/v1/workspace/join-link", {
      method: "DELETE",
      headers: as(admin.email),
    })
    expect(del.status).toBe(204)
    expect((await app.request(`/v1/join/${tokenOf(link)}`)).status).toBe(404)
    expect((await join(tokenOf(link), as(second.email))).status).toBe(404)
  })

  it("answers 410 join_link_expired on preview and join once the link has expired", async () => {
    await create(as(admin.email))
    // The isolated per-user workspace requireWorkspace resolves for admin: this describe
    // block seeds no shared "default" team (isolated: true), so read it back rather than
    // assuming an id.
    const orgId = (await (await app.request("/v1/workspaces", { headers: as(admin.email) })).json())
      .active
    // Same workspace, same role, but already expired: replaceJoinLink rotates the row.
    const expired = await meta.replaceJoinLink({
      id: "wjl_expired_test",
      org_id: orgId,
      role: "editor",
      token: "dkj_expired_test_token",
      created_by: admin.id,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
    const preview = await app.request(`/v1/join/${expired.token}`)
    expect(preview.status).toBe(410)
    expect((await preview.json()).code).toBe("join_link_expired")
    const joined = await join(expired.token, as(second.email))
    expect(joined.status).toBe(410)
    expect((await joined.json()).code).toBe("join_link_expired")
  })

  it("requires sign-in to join (anon is refused by the write lockdown)", async () => {
    const link = await (await create(as(admin.email))).json()
    const res = await app.request(`/v1/join/${tokenOf(link)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })

  it("never leaks a link through the workspace roster or the pending-invite list", async () => {
    await create(as(admin.email))
    const invitesRes = await app.request("/v1/workspace/invites", { headers: as(admin.email) })
    expect(invitesRes.status).toBe(200)
    const list = await invitesRes.json()
    expect(JSON.stringify(list)).not.toContain("dkj_")
    const rosterRes = await app.request("/v1/workspace", { headers: as(admin.email) })
    expect(rosterRes.status).toBe(200)
    const roster = await rosterRes.json()
    expect(JSON.stringify(roster)).not.toContain("dkj_")
  })
})

describe("join link liveness", () => {
  it("is live until expires_at, and the TTL is 30 days", () => {
    expect(JOIN_LINK_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(isLiveJoinLink({ expires_at: new Date(Date.now() + 1000).toISOString() })).toBe(true)
    expect(isLiveJoinLink({ expires_at: new Date(Date.now() - 1000).toISOString() })).toBe(false)
  })
})
