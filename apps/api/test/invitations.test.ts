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
