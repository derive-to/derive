import { describe, expect, it } from "vitest"
import { as, json, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// On a SECURE instance (token set => open=false), an anonymous visitor can view a
// public artifact and nothing else: no comments, members, proposals, analytics,
// sharing, or writes. Presence + cursor stay open (Google-Docs anonymous presence).
// Authenticated users keep normal role-based access — a viewer still sees comments.
describe("anonymous lockdown (secure instance)", () => {
  const owner: TestUser = { id: "u_own", email: "own@dock.test", name: "Owner One" }
  const viewer: TestUser = { id: "u_vee", email: "vee@dock.test", name: "Vee" }
  const { app } = makeAuthedApp("anon-lock", [owner, viewer], "viewer")

  it("attributes a publish to the signed-in user, never a client field or 'anonymous'", async () => {
    const res = await publishAs(
      app,
      "<h1>pub</h1>",
      { visibility: "public", author: "SPOOFED" },
      as(owner.email),
    )
    expect(res.status).toBe(201)
    const j = await res.json()
    // Author comes from the session, not the client-supplied "author" field.
    expect(j.versions[0].author).toBe("Owner One")
    expect(j.versions[0].author).not.toBe("SPOOFED")
    expect(j.versions[0].author).not.toBe("anonymous")
  })

  it("anonymous can view a public artifact but sees no collaboration", async () => {
    const { short_id } = await (
      await publishAs(app, "<h1>pub</h1>", { visibility: "public" }, as(owner.email))
    ).json()
    const a = (p: string, init?: RequestInit) => app.request(`/v1/artifacts/${short_id}${p}`, init)

    // allowed: view content + presence/cursor (Google-Docs anonymous presence)
    expect((await a("")).status).toBe(200)
    expect((await a("/content")).status).toBe(200)
    expect((await a("/presence", json({ name: "Guest" }))).status).toBe(200)
    expect((await a("/cursor", json({ id: "g", x: 0.5, y: 0.5 }))).status).toBe(204)

    // hidden: comments, members, proposals, analytics
    expect((await a("/comments")).status).toBe(404)
    expect((await a("/members")).status).toBe(404)
    expect((await a("/proposals")).status).toBe(404)
    expect((await a("/analytics")).status).toBe(404)

    // forbidden writes: comment, share, publish a new version
    expect((await a("/comments", json({ body_md: "hi" }))).status).toBe(403)
    expect(
      (
        await a("/members", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "x@y.com", role: "editor" }),
        })
      ).status,
    ).toBe(403)
    expect((await publishAs(app, "<h1>v2</h1>", {}, {}, short_id)).status).toBe(403)
  })

  it("an authenticated viewer still sees comments (Google-Docs style)", async () => {
    const { short_id } = await (
      await publishAs(app, "<h1>pub</h1>", { visibility: "public" }, as(owner.email))
    ).json()
    // owner leaves a comment, then the viewer lists comments
    await app.request(`/v1/artifacts/${short_id}/comments`, {
      ...json({ body_md: "internal note" }),
      headers: { "content-type": "application/json", ...as(owner.email) },
    })
    const list = await app.request(`/v1/artifacts/${short_id}/comments`, {
      headers: as(viewer.email),
    })
    expect(list.status).toBe(200)
    expect((await list.json()).comments.length).toBe(1)
  })
})
