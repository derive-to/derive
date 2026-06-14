import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { app, as, dir, jsonAs, makeAuthedApp, meta, publishAs, type TestUser } from "./helpers"

describe("auth: token write-gating + per-artifact read-gating", () => {
  const authApp = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
    token: "s3cret",
  })
  const authed = (extra: RequestInit = {}) => ({
    ...extra,
    headers: { authorization: "Bearer s3cret", ...(extra.headers ?? {}) },
  })
  const pub = (visibility?: string, headers?: HeadersInit) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>secret</h1>")]), "s.html")
    if (visibility) form.append("visibility", visibility)
    return authApp.request("/v1/artifacts", { method: "POST", body: form, headers })
  }

  it("rejects writes without the token, accepts with it", async () => {
    expect((await pub("link")).status).toBe(403) // permission-gated: forbidden
    const ok = await pub("link", { authorization: "Bearer s3cret" })
    expect(ok.status).toBe(201)
  })

  it("serves public/link artifacts to anyone", async () => {
    const { short_id } = await (await pub("link", { authorization: "Bearer s3cret" })).json()
    expect((await authApp.request(`/v1/artifacts/${short_id}`)).status).toBe(200)
    expect((await authApp.request(`/v1/artifacts/${short_id}/content`)).status).toBe(200)
  })

  it("hides gated artifacts without the token (404), reveals with it", async () => {
    const { short_id } = await (await pub("org", { authorization: "Bearer s3cret" })).json()
    expect((await authApp.request(`/v1/artifacts/${short_id}`)).status).toBe(404)
    expect((await authApp.request(`/v1/artifacts/${short_id}/content`)).status).toBe(404)
    expect((await authApp.request(`/v1/artifacts/${short_id}`, authed())).status).toBe(200)
  })

  it("leaves a no-token instance fully open (the default app)", async () => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# x")]), "x.md")
    expect((await app.request("/v1/artifacts", { method: "POST", body: form })).status).toBe(201)
  })
})

describe("permissions: workspace roles gate writes", () => {
  const alice: TestUser = { id: "u_alice", email: "alice@dock.test", name: "Alice" }
  const bob: TestUser = { id: "u_bob", email: "bob@dock.test", name: "Bob" }
  const { app } = makeAuthedApp("perm-roles", [alice, bob], "commenter")
  let shortId: string

  it("makes the first member the owner, who can create artifacts", async () => {
    const res = await publishAs(app, "<h1>a</h1>", {}, as(alice.email))
    expect(res.status).toBe(201)
    shortId = (await res.json()).short_id
  })

  it("provisions later members at the default role (commenter)", async () => {
    const me = await (await app.request("/v1/me", { headers: as(bob.email) })).json()
    expect(me.user.role).toBe("commenter")
  })

  it("blocks a commenter from creating or republishing", async () => {
    expect((await publishAs(app, "<h1>b</h1>", {}, as(bob.email))).status).toBe(403)
    expect((await publishAs(app, "<h1>a2</h1>", {}, as(bob.email), shortId)).status).toBe(403)
  })

  it("lets a commenter comment, but not an unauthenticated caller", async () => {
    const ok = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(bob.email), { body_md: "nice" }),
    )
    expect(ok.status).toBe(201)
    const anon = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs({}, { body_md: "x" }),
    )
    expect(anon.status).toBe(403)
  })
})

describe("permissions: a per-artifact share overrides the workspace role", () => {
  const owner: TestUser = { id: "u_own", email: "own@dock.test", name: "Own" }
  const carol: TestUser = { id: "u_carol", email: "carol@dock.test", name: "Carol" }
  const dave: TestUser = { id: "u_dave", email: "dave@dock.test", name: "Dave" }
  const { app } = makeAuthedApp("perm-share", [owner, carol, dave], "viewer")
  let shortId: string

  it("a workspace viewer can read an org artifact but not republish it", async () => {
    shortId = (
      await (await publishAs(app, "<h1>secret</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    expect(
      (await app.request(`/v1/artifacts/${shortId}`, { headers: as(carol.email) })).status,
    ).toBe(200)
    expect((await publishAs(app, "<h1>edit</h1>", {}, as(carol.email), shortId)).status).toBe(403)
  })

  it("sharing the artifact as editor lets the viewer republish, and my_role reflects it", async () => {
    const share = await app.request(`/v1/artifacts/${shortId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ email: carol.email, role: "editor" }),
    })
    expect(share.status).toBe(201)
    expect((await publishAs(app, "<h1>edit</h1>", {}, as(carol.email), shortId)).status).toBe(201)
    const meta = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(carol.email) })
    ).json()
    expect(meta.my_role).toBe("editor")
  })

  it("an editor can manage shares (GDocs model: editors can invite)", async () => {
    const byEditor = await app.request(`/v1/artifacts/${shortId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(carol.email) },
      body: JSON.stringify({ email: dave.email, role: "commenter" }),
    })
    expect(byEditor.status).toBe(201)
  })

  it("a commenter/viewer still cannot manage shares", async () => {
    const byDave = await app.request(`/v1/artifacts/${shortId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(dave.email) },
      body: JSON.stringify({ email: owner.email, role: "viewer" }),
    })
    expect(byDave.status).toBe(403)
  })

  it("the owner sees the share in the member list", async () => {
    const list = await (
      await app.request(`/v1/artifacts/${shortId}/members`, { headers: as(owner.email) })
    ).json()
    expect(list.default_role).toBe("viewer")
    expect(list.members).toContainEqual(
      expect.objectContaining({ email: carol.email, role: "editor" }),
    )
  })
})
