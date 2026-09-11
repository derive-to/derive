import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// Workspace invitations: bring someone in by email — an existing account joins straight
// away, an unknown email becomes a pending, token-redeemable invite.
describe("workspace invitations", () => {
  const admin: TestUser = { id: "u_inv_admin", email: "invadmin@derive.test", name: "Ada" }
  const teammate: TestUser = { id: "u_inv_mate", email: "invmate@derive.test", name: "Mo" }
  // A user who exists but isn't in the workspace yet — stands in for "the invitee already
  // has a Derive account" and can drive the accept flow.
  const outsider: TestUser = { id: "u_inv_out", email: "invout@derive.test", name: "Sam" }
  const { app } = makeAuthedApp("invitations", [admin, teammate, outsider], "editor", {
    isolated: true,
  })

  const invite = (headers: Record<string, string>, body: unknown) =>
    app.request("/v1/workspace/invites", { ...jsonAs(headers, body), method: "POST" })

  it("adds an EXISTING Derive user directly (by email), not as a pending invite", async () => {
    const res = await invite(as(admin.email), { email: teammate.email, role: "editor" })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.kind).toBe("member")
    expect(body.member.user_id).toBe(teammate.id)
    // They're now on the roster.
    const w = await (await app.request("/v1/workspace", { headers: as(admin.email) })).json()
    expect(w.members.some((m: { user_id: string }) => m.user_id === teammate.id)).toBe(true)
  })

  it("creates a PENDING invite for an unknown email, and returns a copyable accept link", async () => {
    const res = await invite(as(admin.email), { email: "newcomer@derive.test", role: "commenter" })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.kind).toBe("invite")
    expect(body.invite.email).toBe("newcomer@derive.test")
    expect(body.accept_url).toContain("/invite/")
    // It shows up in the pending list (token never exposed there).
    const list = await (
      await app.request("/v1/workspace/invites", { headers: as(admin.email) })
    ).json()
    expect(list.invites.some((i: { email: string }) => i.email === "newcomer@derive.test")).toBe(
      true,
    )
    expect(JSON.stringify(list)).not.toContain("dki_")
  })

  it("rotates a pending invite when an admin needs its link again", async () => {
    const created = await (
      await invite(as(admin.email), { email: "resend-me@derive.test", role: "commenter" })
    ).json()
    const oldToken = created.accept_url.split("/invite/")[1]
    const res = await app.request(`/v1/workspace/invites/${created.invite.id}/resend`, {
      method: "POST",
      headers: as(admin.email),
    })
    expect(res.status).toBe(201)
    const replacement = await res.json()
    expect(replacement.kind).toBe("invite")
    expect(replacement.accept_url).toContain("/invite/")
    expect(replacement.accept_url).not.toContain(oldToken)
    expect((await app.request(`/v1/invites/${oldToken}`)).status).toBe(404)
    expect(
      (await app.request(`/v1/invites/${replacement.accept_url.split("/invite/")[1]}`)).status,
    ).toBe(200)
  })

  it("rejects a non-admin trying to invite", async () => {
    const res = await invite(as(teammate.email), { email: "x@derive.test", role: "editor" })
    // teammate is an editor here (default role), not an owner → forbidden.
    expect(res.status).toBe(403)
  })

  it("previews then accepts an invite, joining the workspace at the invited role", async () => {
    // Invite a NEW email (→ pending invite with a token); the outsider, who happens to
    // hold the link, redeems it (token possession authorizes, like a share link).
    const created = await (
      await invite(as(admin.email), { email: "joiner@derive.test", role: "commenter" })
    ).json()
    expect(created.kind).toBe("invite")
    const token = created.accept_url.split("/invite/")[1]
    expect(token).toBeTruthy()

    // Preview (no auth needed — the token is the secret).
    const preview = await (await app.request(`/v1/invites/${token}`)).json()
    expect(preview.workspace).toBeTruthy()
    expect(preview.role).toBe("commenter")

    // The outsider holds the link but is signed in under a DIFFERENT email than
    // the invite named — the mismatch is surfaced, not silently joined.
    const refused = await app.request(`/v1/invites/${token}/accept`, {
      ...jsonAs(as(outsider.email), {}),
      method: "POST",
    })
    expect(refused.status).toBe(409)
    const mismatch = await refused.json()
    expect(mismatch.error).toBe("email_mismatch")
    expect(mismatch.invited_email).toBe("joiner@derive.test")

    // An explicit confirm accepts anyway (token possession still authorizes —
    // self-hosts without verified email keep working).
    const acc = await app.request(`/v1/invites/${token}/accept`, {
      ...jsonAs(as(outsider.email), { confirm_mismatch: true }),
      method: "POST",
    })
    expect(acc.status).toBe(200)
    const w = await (await app.request("/v1/workspace", { headers: as(admin.email) })).json()
    expect(w.members.some((m: { user_id: string }) => m.user_id === outsider.id)).toBe(true)

    // The invite is spent — a second accept 404s, and it's gone from the pending list.
    const again = await app.request(`/v1/invites/${token}/accept`, {
      ...jsonAs(as(outsider.email), { confirm_mismatch: true }),
      method: "POST",
    })
    expect(again.status).toBe(404)
  })

  it("revokes a pending invite (Admin), after which its token can't be previewed", async () => {
    const created = await (
      await invite(as(admin.email), { email: "revoke-me@derive.test", role: "editor" })
    ).json()
    const token = created.accept_url.split("/invite/")[1]
    const del = await app.request(`/v1/workspace/invites/${created.invite.id}`, {
      method: "DELETE",
      headers: as(admin.email),
    })
    expect(del.status).toBe(204)
    const preview = await app.request(`/v1/invites/${token}`)
    expect(preview.status).toBe(404)
  })

  it("requires sign-in to accept (anon is refused by the write lockdown)", async () => {
    const created = await (
      await invite(as(admin.email), { email: "anon-accept@derive.test", role: "editor" })
    ).json()
    const token = created.accept_url.split("/invite/")[1]
    const res = await app.request(`/v1/invites/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })
})

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
  // `isolated: true` gives each user a personal workspace with a generated id; read it back.
  const activeOrg = async (headers: Record<string, string>): Promise<string> =>
    (await (await app.request("/v1/workspaces", { headers })).json()).active

  it("creates a Creator link by default; GET is 404 until one exists", async () => {
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
    const rotated = await (await create(as(admin.email))).json()
    expect(rotated.url).not.toBe(first.url)
    expect((await app.request(`/v1/join/${tokenOf(first)}`)).status).toBe(404)
    expect((await app.request(`/v1/join/${tokenOf(rotated)}`)).status).toBe(200)
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
    const orgId = await activeOrg(as(admin.email))
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

  it("clears a stale pending email invite for the address that joins", async () => {
    const orgId = await activeOrg(as(admin.email))
    // Invited by email months ago, never redeemed; they arrive through the link instead. The
    // Admin's pending list must not keep showing them once they are on the roster.
    await meta.createInvitation({
      id: "inv_jl_stale",
      org_id: orgId,
      email: second.email,
      role: "commenter",
      token: "hash_jl_stale_invite",
      invited_by: admin.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const pending = async (): Promise<string[]> => {
      const list = await (
        await app.request("/v1/workspace/invites", { headers: as(admin.email) })
      ).json()
      return list.invites.map((i: { email: string }) => i.email)
    }
    expect(await pending()).toContain(second.email)

    // A Viewer link, so the seat gate never stands between the join and the assertion.
    const link = await (await create(as(admin.email), { role: "commenter" })).json()
    expect((await join(tokenOf(link), as(second.email))).status).toBe(200)
    expect(await pending()).not.toContain(second.email)
  })
})
