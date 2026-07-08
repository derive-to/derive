import { describe, expect, it } from "vitest"
import { as, json, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The general-access comment grant, enforced end to end at the route layer (the
// companion to packages/core's effectiveRole matrix). The invariant under test: an
// anonymous caller can never comment, no matter the grant — auth is the gate — while a
// signed-in caller reaching purely via the link rises to commenter when the link allows
// it. Mirrors the access matrix in SECURITY.md.
describe("comment access via the general-access link", () => {
  const alice: TestUser = { id: "u_ca_alice", email: "alice@ca.test", name: "Alice" }
  // Bob is signed in but reaches Alice's artifact purely via the link (his own isolated
  // workspace → no membership, no share): the "signed in via link" column.
  const bob: TestUser = { id: "u_ca_bob", email: "bob@ca.test", name: "Bob" }
  const { app } = makeAuthedApp("comment-access", [alice, bob], undefined, { isolated: true })

  const setAccess = (shortId: string, generalRole: "viewer" | "commenter") =>
    app.request(`/v1/artifacts/${shortId}/visibility`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(alice.email) },
      body: JSON.stringify({ visibility: "public", generalRole }),
    })
  const comment = (shortId: string, headers: Record<string, string>) =>
    app.request(`/v1/artifacts/${shortId}/comments`, jsonAs(headers, { body_md: "hi" }))
  const view = (shortId: string, headers?: Record<string, string>) =>
    app.request(`/v1/artifacts/${shortId}`, headers ? { headers } : undefined)

  it("view link: anyone reaching may read, nobody reaching may comment", async () => {
    await app.request("/v1/me", { headers: as(alice.email) }) // provision Alice's workspace
    const shortId = (await (await publishAs(app, "<h1>doc</h1>", {}, as(alice.email))).json())
      .short_id
    expect((await setAccess(shortId, "viewer")).ok).toBe(true)

    // Reads succeed for a signed-in reacher and for an anonymous visitor.
    expect((await view(shortId, as(bob.email))).status).toBe(200)
    expect((await view(shortId)).status).toBe(200)
    // Comments are refused for both — a view link grants only viewer.
    expect((await comment(shortId, as(bob.email))).status).toBe(403)
    expect(
      (await app.request(`/v1/artifacts/${shortId}/comments`, json({ body_md: "hi" }))).status,
    ).toBe(403)
  })

  it("comment link: a signed-in reacher comments; an anonymous one is forced to auth", async () => {
    await app.request("/v1/me", { headers: as(alice.email) })
    const shortId = (await (await publishAs(app, "<h1>doc2</h1>", {}, as(alice.email))).json())
      .short_id
    expect((await setAccess(shortId, "commenter")).ok).toBe(true)

    // Signed in via the link → commenter → may comment.
    expect((await comment(shortId, as(bob.email))).ok).toBe(true)
    // Anonymous → still viewer → 403 even on a comment link (the invariant).
    expect(
      (await app.request(`/v1/artifacts/${shortId}/comments`, json({ body_md: "no" }))).status,
    ).toBe(403)

    // my_role reflects the grant per caller; the GET returns the persisted link
    // pair (the legacy generalRole PATCH above landed on link_role, audience
    // forced public by the coherence rule).
    const bobView = await (await view(shortId, as(bob.email))).json()
    expect(bobView.my_role).toBe("commenter")
    expect(bobView.link_role).toBe("commenter")
    expect(bobView.link_audience).toBe("public")
    const anonView = await (await view(shortId)).json()
    expect(anonView.my_role).toBe("viewer")
  })

  it("revoking the comment grant locks commenting again", async () => {
    await app.request("/v1/me", { headers: as(alice.email) })
    const shortId = (await (await publishAs(app, "<h1>doc3</h1>", {}, as(alice.email))).json())
      .short_id
    expect((await setAccess(shortId, "commenter")).ok).toBe(true)
    expect((await comment(shortId, as(bob.email))).ok).toBe(true)
    // Flip back to view-only: the same reacher can no longer comment.
    expect((await setAccess(shortId, "viewer")).ok).toBe(true)
    expect((await comment(shortId, as(bob.email))).status).toBe(403)
  })
})

// The workspace-audience link (round 4, scenario 1): a private artifact's URL
// admits workspace members at the link's grant — the review loop works on a
// pasted link — while outsiders and anonymous stay out entirely.
describe("comment access via the workspace link", () => {
  const dana: TestUser = {
    id: "u_ca_dana",
    email: "dana@ca.test",
    name: "Dana",
    username: "danac",
  }
  const memo: TestUser = {
    id: "u_ca_memo",
    email: "memo@ca.test",
    name: "Memo",
    username: "memoc",
  }
  // Otto signs in to the SAME app but never joins Dana's workspace (isolated:
  // everyone provisions their own; Dana then invites only Memo) — the
  // signed-in-outsider column of the state table.
  const otto: TestUser = { id: "u_ca_otto", email: "otto@ca.test", name: "Otto" }
  const { app } = makeAuthedApp("comment-access-org", [dana, memo, otto], undefined, {
    isolated: true,
  })

  it("a member comments on a private doc via the default link; an outsider gets 404", async () => {
    await app.request("/v1/me", { headers: as(dana.email) }) // provision Dana's workspace
    await app.request("/v1/me", { headers: as(otto.email) }) // Otto provisions his own
    // Dana seats Memo in her workspace; Otto stays outside.
    expect(
      (
        await app.request("/v1/workspace/members", {
          ...jsonAs(as(dana.email), { user: "memoc", role: "commenter" }),
          method: "PUT",
        })
      ).ok,
    ).toBe(true)

    // The factory default pair (org · commenter) — no fields sent.
    const a = await (await publishAs(app, "<h1>draft</h1>", {}, as(dana.email))).json()
    expect(a.visibility).toBe("private")
    expect(a.link_role).toBe("commenter")
    expect(a.link_audience).toBe("org")

    // Memo (workspace member, no share) comments through the link.
    expect(
      (
        await app.request(
          `/v1/artifacts/${a.short_id}/comments`,
          jsonAs(as(memo.email), { body_md: "left a note via the pasted link" }),
        )
      ).ok,
    ).toBe(true)

    // Otto is signed in but outside the workspace: the same URL is inert (404,
    // indistinguishable from not existing). Anonymous likewise.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(otto.email) })).status,
    ).toBe(404)
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(404)
  })
})
