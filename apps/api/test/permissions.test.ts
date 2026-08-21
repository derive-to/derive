import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { anonApp, as, dir, jsonAs, makeAuthedApp, meta, publishAs, type TestUser } from "./helpers"

describe("auth: token write-gating + per-artifact read-gating", () => {
  const authApp = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
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

  it("rejects anonymous writes even on a no-token instance (no open mode)", async () => {
    // `anonApp` is the shared instance with no auto-auth: a request with no
    // Authorization is anonymous, and anonymous can never publish.
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# x")]), "x.md")
    expect((await anonApp.request("/v1/artifacts", { method: "POST", body: form })).status).toBe(
      403,
    )
  })
})

describe("security: a no-token container is secure (anonymous can't write)", () => {
  // There is no "open" mode any more: a standalone no-token, no-auth app locks
  // anonymous callers everywhere. The bug this closes is the old `open = !token`
  // default that made a no-token container trust the anonymous caller as owner.
  const locked = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
  })

  it("refuses an anonymous publish on a no-token instance", async () => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>x</h1>")]), "x.html")
    expect((await locked.request("/v1/artifacts", { method: "POST", body: form })).status).toBe(403)
  })
})

describe("permissions: workspace roles gate writes", () => {
  const alice: TestUser = { id: "u_alice", email: "alice@derive.test", name: "Alice" }
  const bob: TestUser = { id: "u_bob", email: "bob@derive.test", name: "Bob" }
  const { app } = makeAuthedApp("perm-roles", [alice, bob], "commenter")
  let shortId: string

  it("makes the first member the owner, who can create artifacts", async () => {
    const res = await publishAs(app, "<h1>a</h1>", { visibility: "org" }, as(alice.email))
    expect(res.status).toBe(201)
    shortId = (await res.json()).short_id
  })

  it("blocks a commenter from creating or republishing", async () => {
    expect((await publishAs(app, "<h1>b</h1>", { visibility: "org" }, as(bob.email))).status).toBe(
      403,
    )
    expect(
      (await publishAs(app, "<h1>a2</h1>", { visibility: "org" }, as(bob.email), shortId)).status,
    ).toBe(403)
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
  const owner: TestUser = { id: "u_own", email: "own@derive.test", name: "Own" }
  const carol: TestUser = { id: "u_carol", email: "carol@derive.test", name: "Carol" }
  const dave: TestUser = { id: "u_dave", email: "dave@derive.test", name: "Dave" }
  const { app } = makeAuthedApp("perm-share", [owner, carol, dave], "viewer")
  let shortId: string

  it("a workspace viewer can read an org artifact but not republish it", async () => {
    shortId = (
      await (await publishAs(app, "<h1>secret</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    expect(
      (await app.request(`/v1/artifacts/${shortId}`, { headers: as(carol.email) })).status,
    ).toBe(200)
    expect(
      (await publishAs(app, "<h1>edit</h1>", { visibility: "org" }, as(carol.email), shortId))
        .status,
    ).toBe(403)
  })

  it("sharing the artifact as editor lets the viewer republish, and my_role reflects it", async () => {
    const share = await app.request(`/v1/artifacts/${shortId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ email: carol.email, role: "editor" }),
    })
    expect(share.status).toBe(201)
    expect(
      (await publishAs(app, "<h1>edit</h1>", { visibility: "org" }, as(carol.email), shortId))
        .status,
    ).toBe(201)
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
      expect.objectContaining({ user_id: carol.id, role: "editor" }),
    )
    // The member list identifies people by handle, never email.
    expect(list.members.every((m: { email?: unknown }) => m.email === undefined)).toBe(true)
  })
})

describe("permissions: a sharer can't grant or remove a role above their own", () => {
  const owner: TestUser = { id: "u_o2", email: "o2@derive.test", name: "O2" }
  const ed: TestUser = { id: "u_ed2", email: "ed2@derive.test", name: "Ed2" }
  const out: TestUser = { id: "u_out2", email: "out2@derive.test", name: "Out2" }
  const { app } = makeAuthedApp("perm-clamp", [owner, ed, out], "viewer")
  let shortId: string

  const putMember = (by: TestUser, email: string, role: string) =>
    app.request(`/v1/artifacts/${shortId}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(by.email) },
      body: JSON.stringify({ email, role }),
    })
  const delMember = (by: TestUser, userId: string) =>
    app.request(`/v1/artifacts/${shortId}/members/${userId}`, {
      method: "DELETE",
      headers: as(by.email),
    })

  it("sets up an org artifact shared to an editor", async () => {
    shortId = (
      await (await publishAs(app, "<h1>x</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    expect((await putMember(owner, ed.email, "editor")).status).toBe(201)
  })

  it("blocks an editor from granting owner (privilege escalation), but an owner can", async () => {
    expect((await putMember(ed, out.email, "owner")).status).toBe(403)
    expect((await putMember(owner, out.email, "owner")).status).toBe(201)
  })

  it("blocks an editor from removing a collaborator who outranks them, but an owner can", async () => {
    expect((await delMember(ed, out.id)).status).toBe(403)
    expect((await delMember(owner, out.id)).status).toBe(204)
  })

  it("still lets an editor grant up to their own role", async () => {
    expect((await putMember(ed, out.email, "editor")).status).toBe(201)
  })
})

// Password-protected artifacts: world-reachable by URL like `link`, but the bytes
// stay gated until a visitor enters the password (then read as a viewer). Owners /
// members always see it by role.
describe("permissions: password-protected artifacts", () => {
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "s3cret",
  })
  const owner = { authorization: "Bearer s3cret" }
  const pub = (visibility: string, password?: string) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>secret</h1>")]), "s.html")
    form.append("visibility", visibility)
    if (password) form.append("password", password)
    return app.request("/v1/artifacts", { method: "POST", body: form, headers: owner })
  }
  const unlock = (id: string, password: string) =>
    app.request(`/v1/artifacts/${id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    })
  let shortId = ""

  it("rejects `password` visibility published without a password", async () => {
    expect((await pub("password")).status).toBe(400)
  })

  it("publishes a password artifact; the owner reads it, anonymous is locked (401)", async () => {
    const res = await pub("password", "hunter2")
    expect(res.status).toBe(201)
    shortId = (await res.json()).short_id
    // The owner (token) always reads it by role.
    expect((await app.request(`/v1/artifacts/${shortId}`, { headers: owner })).status).toBe(200)
    // Anonymous: lockable, not hidden — prompt (401), and the bytes stay gated.
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(401)
    expect((await app.request(`/v1/artifacts/${shortId}/content`)).status).toBe(404)
  })

  it("rejects the wrong password, then unlocks with the right one via cookie", async () => {
    expect((await unlock(shortId, "nope")).status).toBe(401)
    const ok = await unlock(shortId, "hunter2")
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get("set-cookie")?.split(";")[0] ?? ""
    expect(cookie).toContain(`dku_${shortId}`)
    // With the unlock cookie an anonymous visitor reads the artifact and its bytes.
    expect((await app.request(`/v1/artifacts/${shortId}`, { headers: { cookie } })).status).toBe(
      200,
    )
    expect(
      (await app.request(`/v1/artifacts/${shortId}/content`, { headers: { cookie } })).status,
    ).toBe(200)
  })

  it("ignores a forged unlock cookie", async () => {
    const forged = { cookie: `dku_${shortId}=deadbeef` }
    expect((await app.request(`/v1/artifacts/${shortId}`, { headers: forged })).status).toBe(401)
  })
})

// Changing access after publish, from the Share dialog (PATCH /access). The lock
// is a gate on the world link — it only takes while link_role != none.
describe("permissions: locking the world link via PATCH /access", () => {
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "s3cret",
  })
  const owner = { authorization: "Bearer s3cret" }
  const patch = (id: string, body: object) =>
    app.request(`/v1/artifacts/${id}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify(body),
    })
  let shortId = ""

  it("locks a world-linked artifact (a password is required)", async () => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>x</h1>")]), "x.html")
    form.append("link_role", "viewer")
    shortId = (
      await (
        await app.request("/v1/artifacts", { method: "POST", body: form, headers: owner })
      ).json()
    ).short_id
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(200) // world link: anon reads
    // The legacy vocabulary still refuses to lock without a password…
    expect((await patch(shortId, { visibility: "password" })).status).toBe(400)
    // …and locking is a password on the live link.
    expect((await patch(shortId, { password: "sesame" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(401) // now locked
  })

  it("re-patching without a password keeps the lock; an empty password clears it", async () => {
    // Changing the link role (a bare PATCH) must not silently drop the lock.
    expect((await patch(shortId, { linkRole: "commenter" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(401) // still locked
    // Clearing is explicit: an empty password removes the lock.
    expect((await patch(shortId, { password: "" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(200)
  })

  it("dropping the link clears the lock — it cannot resurrect when a link returns", async () => {
    expect((await patch(shortId, { password: "sesame" })).status).toBe(200)
    expect((await patch(shortId, { linkRole: "none" })).status).toBe(200)
    expect((await patch(shortId, { linkRole: "viewer" })).status).toBe(200)
    expect((await app.request(`/v1/artifacts/${shortId}`)).status).toBe(200) // unlocked
  })
})
