import { describe, expect, it } from "vitest"
import { as, json, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// An anonymous visitor (no session, no token) can view a public artifact and send
// the ephemeral "I'm here" signals — a presence heartbeat and a live cursor. Nothing
// else: no comments, members, proposals, analytics, sharing, or any write. There is
// no "open" mode that would elevate them.
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

    // allowed: read content + the "someone is viewing" signals — a presence
    // heartbeat and a live cursor (Figma-style viral viewing). Both are ephemeral
    // and server-named; they are the ONLY things an anonymous caller may do.
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

// The structural guarantee: NO anonymous caller can ever mutate anything. This
// sweeps every mutating surface at once, so a regression (or a newly added route
// that forgets its gate) trips here. The only things anon may do are read a
// public artifact, count a view, and send a presence heartbeat.
describe("anonymous can never write — global lockdown sweep", () => {
  const owner: TestUser = { id: "u_sweep_own", email: "sweepown@dock.test", name: "Owner" }
  const { app } = makeAuthedApp("anon-sweep", [owner])
  let shortId: string
  const at = (p: string, init?: RequestInit) => app.request(`/v1/artifacts/${shortId}${p}`, init)
  const put = (body: unknown) => ({
    method: "PUT" as const,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  it("seeds a public artifact (as the owner) to probe against", async () => {
    shortId = (
      await (await publishAs(app, "<h1>pub</h1>", { visibility: "public" }, as(owner.email))).json()
    ).short_id
    expect(shortId).toBeTruthy()
  })

  it("allows ONLY read + the ephemeral viewing signals for an anonymous caller", async () => {
    expect((await at("")).status).toBe(200) // read metadata
    expect((await at("/content")).status).toBe(200) // read content
    expect((await at("/view", json({}))).status).toBe(204) // passive view counter
    expect((await at("/presence", json({}))).status).toBe(200) // "someone is viewing"
    expect((await at("/cursor", json({ id: "g", x: 0, y: 0 }))).status).toBe(204) // live cursor
    // leave/tap ride the same /cursor route (a flag, not a new path), so they need
    // no new anonymous gate — an anon viewer can retire their own cursor.
    expect((await at("/cursor", json({ id: "g", gone: true, x: 0, y: 0 }))).status).toBe(204)
  })

  it("refuses every anonymous mutation across the API", async () => {
    // artifact-scoped writes
    expect((await publishAs(app, "<h1>v2</h1>", {}, {}, shortId)).status).toBe(403)
    expect((await at("/comments", json({ body_md: "x" }))).status).toBe(403)
    expect((await at("/proposals", json({}))).status).toBe(403)
    expect((await at("/report", json({ reason: "spam" }))).status).toBe(403)
    expect((await at("/takedown", json({}))).status).toBe(403)
    expect((await at("/restore", json({ version: 1 }))).status).toBe(403)
    expect((await at("/members", put({ email: "x@y.com", role: "editor" }))).status).toBe(403)
    expect((await at("/favorite", { method: "PUT" })).status).toBe(403)
    expect((await at("/tags", put({ tags: ["x"] }))).status).toBe(403)
    // workspace / collection / agent / webhook creation
    expect((await app.request("/v1/collections", json({ title: "c" }))).status).toBe(403)
    expect((await app.request("/v1/workspaces", json({ name: "w" }))).status).toBe(403)
    expect((await app.request("/v1/agents", json({ name: "a" }))).status).toBe(403)
    expect(
      (
        await app.request(
          "/v1/webhooks",
          json({ url: "https://example.com/h", events: ["version.published"] }),
        )
      ).status,
    ).toBe(403)
    expect(
      (await app.request("/v1/workspace", { ...json({ name: "x" }), method: "PATCH" })).status,
    ).toBe(403)
  })

  it("hides the member directory and private artifacts from anonymous callers", async () => {
    expect((await app.request("/v1/users")).status).toBe(401)
    const priv = (
      await (await publishAs(app, "<h1>secret</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    expect((await app.request(`/v1/artifacts/${priv}`)).status).toBe(404)
    expect((await app.request(`/v1/artifacts/${priv}/content`)).status).toBe(404)
  })
})
