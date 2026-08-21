import { describe, expect, it } from "vitest"
import { MAX_MENTIONS, parseMentions } from "../src/lib/comments"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Coverage for the read-path hardening: a non-member / anonymous caller gets only
// content they're entitled to (public artifacts) — never an org/link title, a member
// roster, an email, or a workspace's name + size. See bug-hunt B-001/003/004/012/013/015.
describe("read-path exposure hardening", () => {
  const owner: TestUser = { id: "u_h_owner", email: "owner-h@derive.test", name: "Owner H" }
  const outsider: TestUser = { id: "u_h_out", email: "out-h@derive.test", name: "Out H" }

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

  it("B-015: an oversized ?query= is capped, not a 500", async () => {
    const { app } = makeAuthedApp("harden-q", [owner])
    const res = await app.request(`/v1/artifacts?query=${"a".repeat(5000)}`, {
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
      await publishAs(app, "<h1>p</h1>", { visibility: "public" }, as(owner.email))
    ).json()
    // Share by email (still accepted as an input ref) — the response must NOT echo it back.
    const res = await app.request(`/v1/artifacts/${short_id}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ email: outsider.email, role: "viewer" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    // The direct-share branch (existing account) — the member payload must not
    // echo the email back (the handle→email oracle this test pins).
    expect(body.kind).toBe("member")
    expect(body.member).not.toHaveProperty("email")
    expect(body.member.role).toBe("viewer")
  })
})

// B-019: @mentions are client-supplied; a mention must only notify someone who can
// actually SEE the artifact (a workspace member or an explicit sharee). Otherwise any
// user could push an attacker-controlled title/preview into ANY user's bell + SSE —
// cross-workspace spam/phishing. See bug-hunt B-019.
describe("B-019: @mention notifies only collaborators", () => {
  const owner: TestUser = { id: "u_b19_owner", email: "o19@derive.test", name: "Owner19" }
  const member: TestUser = { id: "u_b19_member", email: "m19@derive.test", name: "Member19" }
  const sharee: TestUser = { id: "u_b19_sharee", email: "s19@derive.test", name: "Sharee19" }
  const outsider: TestUser = { id: "u_b19_out", email: "x19@derive.test", name: "Out19" }

  it("notifies a workspace member + an artifact sharee, but NEVER a non-member", async () => {
    const { app, meta: m } = makeAuthedApp(
      "harden-b19",
      [owner, member, sharee, outsider],
      undefined,
      { isolated: true },
    )
    // Owner provisions their workspace by publishing an org-private artifact.
    const { short_id } = await (
      await publishAs(app, "<h1>p</h1>", { title: "B19", visibility: "org" }, as(owner.email))
    ).json()
    const art = await m.getByShortId(short_id)
    if (!art) throw new Error("artifact not found")
    // member joins the workspace; sharee gets an explicit share; outsider stays a stranger.
    await m.setMembership({ id: "m_b19", org_id: art.org_id, user_id: member.id, role: "editor" })
    await m.setArtifactMember({
      id: "am_b19",
      artifact_id: art.id,
      user_id: sharee.id,
      role: "viewer",
    })

    // Owner @mentions all three (attacker-controlled body, as in the live repro).
    const res = await app.request(
      `/v1/artifacts/${short_id}/comments`,
      jsonAs(as(owner.email), {
        body_md: "CLICK http://evil.example",
        mentions: [
          { id: member.id, name: "Member19" },
          { id: sharee.id, name: "Sharee19" },
          { id: outsider.id, name: "Out19" },
        ],
      }),
    )
    expect(res.status).toBe(201)

    // Collaborators are notified; the non-member is not (the spam/phishing is blocked).
    expect((await m.listNotifications(member.id, 50)).length).toBe(1)
    expect((await m.listNotifications(sharee.id, 50)).length).toBe(1)
    expect((await m.listNotifications(outsider.id, 50)).length).toBe(0)
  })

  it("caps the number of distinct mentions parsed per comment", () => {
    const many = Array.from({ length: MAX_MENTIONS + 25 }, (_, i) => ({
      id: `u${i}`,
      name: `n${i}`,
    }))
    expect(parseMentions(many)).toHaveLength(MAX_MENTIONS)
  })
})

// B-018: an explicitly-provided legacy visibility that isn't a known value is
// rejected, not silently coerced. Absent access fields default to the team draft.
describe("B-018: publish rejects an unknown visibility", () => {
  const owner: TestUser = { id: "u_b18_owner", email: "o18@derive.test", name: "Owner18" }

  it("400s on an unknown visibility; valid values map; absent defaults to unlisted", async () => {
    const { app } = makeAuthedApp("harden-b18", [owner])
    const bad = await publishAs(
      app,
      "<h1>x</h1>",
      { title: "v", visibility: "secret" },
      as(owner.email),
    )
    expect(bad.status).toBe(400)
    const pub = await (
      await publishAs(app, "<h1>x</h1>", { title: "v2", visibility: "public" }, as(owner.email))
    ).json()
    expect(pub.listed).toBe("public")
    // Legacy client vocabulary maps instead of 400ing (link → public).
    const legacy = await (
      await publishAs(app, "<h1>x</h1>", { title: "v4", visibility: "link" }, as(owner.email))
    ).json()
    expect(legacy.listed).toBe("public")
    const def = await (await publishAs(app, "<h1>x</h1>", { title: "v3" }, as(owner.email))).json()
    expect(def.listed).toBe("none")
  })
})

// B-020: view-analytics (who-viewed + counts) is for collaborators, not every
// signed-in reader. A public artifact's `read` access is satisfied by any
// signed-in user, so the endpoint must additionally require a member/sharee — and
// resolve viewers to a handle, never email. See bug-hunt B-020 (and B-013).
describe("B-020: view-analytics is collaborator-gated + never leaks email", () => {
  const owner: TestUser = { id: "u_b20_owner", email: "o20@derive.test", name: "Owner20" }
  // name:null forces the viewer-display fallback — it must land on the handle, not email.
  const viewer: TestUser = {
    id: "u_b20_viewer",
    email: "v20@derive.test",
    name: null,
    username: "viewer20",
  }
  const outsider: TestUser = { id: "u_b20_out", email: "x20@derive.test", name: "Out20" }

  it("refuses a non-member; serves a member; viewers resolve to handle, never email", async () => {
    const { app, meta: m } = makeAuthedApp("harden-b20", [owner, viewer, outsider], undefined, {
      isolated: true,
    })
    const { short_id } = await (
      await publishAs(app, "<h1>p</h1>", { visibility: "public" }, as(owner.email))
    ).json()
    const art = await m.getByShortId(short_id)
    if (!art) throw new Error("artifact not found")
    // viewer joins the workspace and records a view (non-owner → counts).
    await m.setMembership({
      id: "m_b20",
      org_id: art.org_id,
      user_id: viewer.id,
      role: "commenter",
    })
    await app.request(`/v1/artifacts/${short_id}/view`, jsonAs(as(viewer.email), {}))

    // A signed-in NON-member stranger is refused, even though the artifact is public.
    const stranger = await app.request(`/v1/artifacts/${short_id}/analytics`, {
      headers: as(outsider.email),
    })
    expect(stranger.status).toBe(404)

    // The owner (a collaborator) sees the stats; the recent viewer shows by HANDLE
    // (name is null) and the email never appears anywhere in the payload.
    const ownerRes = await app.request(`/v1/artifacts/${short_id}/analytics`, {
      headers: as(owner.email),
    })
    expect(ownerRes.status).toBe(200)
    const stats = await ownerRes.json()
    expect(stats.recent.map((r: { viewer: string }) => r.viewer)).toContain("viewer20")
    expect(JSON.stringify(stats)).not.toContain("v20@derive.test")
  })
})

// B-021: author/actor attribution shown to others (publish + version author byline,
// comment author, review-round resolver) must fall back to the public handle
// when a user has no display name — never the email. The email→handle migration
// fixed the rosters but missed these byline paths. See bug-hunt B-021.
describe("B-021: author/actor attribution falls back to handle, never email", () => {
  // name:null forces the fallback — it must land on the username, not the email.
  const ghost: TestUser = {
    id: "u_b21",
    email: "ghost21@derive.test",
    name: null,
    username: "ghost21",
  }

  it("a name-less user's publish + comment author show the handle, not the email", async () => {
    const { app } = makeAuthedApp("harden-b21", [ghost])
    const pub = await (
      await publishAs(app, "<h1>p</h1>", { title: "B21", visibility: "public" }, as(ghost.email))
    ).json()
    // The version author byline (shown publicly) is the handle, and the email is absent.
    expect(pub.versions[0].author).toBe("ghost21")
    expect(JSON.stringify(pub)).not.toContain("ghost21@derive.test")

    const cm = await (
      await app.request(
        `/v1/artifacts/${pub.short_id}/comments`,
        jsonAs(as(ghost.email), { body_md: "hi" }),
      )
    ).json()
    expect(cm.author).toBe("ghost21")
    expect(JSON.stringify(cm)).not.toContain("ghost21@derive.test")
  })
})
