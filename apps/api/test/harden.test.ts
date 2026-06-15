import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Coverage for the read-path hardening: a non-member / anonymous caller gets only
// content they're entitled to (public artifacts) — never an org/link title, a member
// roster, an email, or a workspace's name + size. See bug-hunt B-001/003/004/012/013/015.
describe("read-path exposure hardening", () => {
  const owner: TestUser = { id: "u_h_owner", email: "owner-h@dock.test", name: "Owner H" }
  const outsider: TestUser = { id: "u_h_out", email: "out-h@dock.test", name: "Out H" }

  it("B-001: listArtifacts(publicOnly) hides org/link titles; a member still sees all", async () => {
    const { app, meta: m } = makeAuthedApp("harden-list", [owner])
    await publishAs(app, "<h1>p</h1>", { title: "PubDoc", visibility: "public" }, as(owner.email))
    await publishAs(app, "<h1>o</h1>", { title: "OrgSecret", visibility: "org" }, as(owner.email))

    const all = await m.listArtifacts({ orgId: "default" })
    expect(all.map((a) => a.title).sort()).toEqual(["OrgSecret", "PubDoc"])
    // The publicOnly filter (used for anon / non-member callers) drops the org title.
    const pub = await m.listArtifacts({ orgId: "default", publicOnly: true })
    expect(pub.map((a) => a.title)).toEqual(["PubDoc"])
    // A member still sees everything through the route.
    const mem = await (await app.request("/v1/artifacts", { headers: as(owner.email) })).json()
    expect(mem.artifacts.map((a: { title: string }) => a.title)).toContain("OrgSecret")
  })

  it("B-015: an oversized ?q= is capped, not a 500", async () => {
    const { app } = makeAuthedApp("harden-q", [owner])
    const res = await app.request(`/v1/artifacts?q=${"a".repeat(5000)}`, {
      headers: as(owner.email),
    })
    expect(res.status).toBe(200)
  })

  it("B-013: only a member/sharee sees the member list; it carries handles, never email", async () => {
    const { app } = makeAuthedApp("harden-members", [owner, outsider], undefined, {
      isolated: true,
    })
    const { short_id } = await (
      await publishAs(app, "<h1>p</h1>", { visibility: "public" }, as(owner.email))
    ).json()
    // The owner (a member) sees the roster...
    const ownerView = await app.request(`/v1/artifacts/${short_id}/members`, {
      headers: as(owner.email),
    })
    expect(ownerView.status).toBe(200)
    const body = await ownerView.json()
    for (const m of body.members) expect(m).not.toHaveProperty("email")
    // ...but an authenticated stranger who can merely READ the public artifact does not.
    const stranger = await app.request(`/v1/artifacts/${short_id}/members`, {
      headers: as(outsider.email),
    })
    expect(stranger.status).toBe(404)
  })

  it("B-012: the @mention directory never returns another workspace's roster to a non-member", async () => {
    const { app } = makeAuthedApp("harden-dir", [owner, outsider], undefined, { isolated: true })
    const { short_id } = await (
      await publishAs(app, "<h1>p</h1>", { visibility: "public" }, as(owner.email))
    ).json()
    // Outsider (member of their own workspace only) asks the directory scoped to the
    // owner's public artifact: they must not receive the owner as a directory entry,
    // and certainly no email field.
    const res = await app.request(`/v1/users?artifact=${short_id}`, { headers: as(outsider.email) })
    const { users } = await res.json()
    expect(users.some((u: { id: string }) => u.id === owner.id)).toBe(false)
    for (const u of users) expect(u).not.toHaveProperty("email")
  })

  it("share echoes the handle, never the email (no handle->email oracle)", async () => {
    const { app } = makeAuthedApp("harden-share", [owner, outsider])
    const { short_id } = await (
      await publishAs(app, "<h1>p</h1>", { visibility: "link" }, as(owner.email))
    ).json()
    // Share by email (still accepted as an input ref) — the response must NOT echo it back.
    const res = await app.request(`/v1/artifacts/${short_id}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ email: outsider.email, role: "viewer" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).not.toHaveProperty("email")
    expect(body.role).toBe("viewer")
  })
})
