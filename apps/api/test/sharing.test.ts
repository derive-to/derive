import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Sharing an artifact with someone should land in their notification bell, the
// same way an @mention does. A share has no comment thread, so the thread/comment
// ids are empty and the bell deep-links to the artifact itself.
describe("artifact share → notification", () => {
  const alice: TestUser = { id: "u_sh_alice", email: "sha@derive.test", name: "Alice" }
  const bob: TestUser = { id: "u_sh_bob", email: "shb@derive.test", name: "Bob" }
  const { app } = makeAuthedApp("share-notif", [alice, bob], "editor")
  let shortId: string

  const share = (email: string, role: string, by: string) =>
    app.request(`/v1/artifacts/${shortId}/members`, {
      ...jsonAs(as(by), { email, role }),
      method: "PUT",
    })

  it("notifies the person an artifact is shared with", async () => {
    shortId = (await (await publishAs(app, "<h1>doc</h1>", {}, as(alice.email))).json()).short_id
    expect((await share(bob.email, "viewer", alice.email)).status).toBe(201)

    const bobN = await (await app.request("/v1/notifications", { headers: as(bob.email) })).json()
    expect(bobN.unread).toBe(1)
    expect(bobN.notifications[0]).toMatchObject({
      kind: "share",
      actor: "Alice",
      artifact_short_id: shortId,
      thread_id: "",
      comment_id: "",
      read: 0,
    })
    expect(bobN.notifications[0].preview).toContain("viewer")
  })
})

describe("share by username or email", () => {
  const ann: TestUser = { id: "u_shu_ann", email: "ann@shu.test", name: "Ann" }
  // Bob has a handle; we'll add him by @handle, not his email.
  const bob: TestUser = { id: "u_shu_bob", email: "bob@shu.test", name: "Bob", username: "bobby" }
  const { app } = makeAuthedApp("share-by-username", [ann, bob], "editor")

  const put = (body: Record<string, unknown>, by: string) =>
    app.request(`/v1/artifacts/${SID}/members`, { ...jsonAs(as(by), body), method: "PUT" })
  let SID = ""

  it("resolves a @handle, a bare handle, and an email to the same account", async () => {
    SID = (await (await publishAs(app, "<h1>d</h1>", {}, as(ann.email))).json()).short_id

    // By @handle.
    const r1 = await put({ user: "@bobby", role: "viewer" }, ann.email)
    expect(r1.status).toBe(201)
    expect((await r1.json()).member.user_id).toBe(bob.id)

    // By bare handle (case-insensitive).
    expect((await put({ user: "BOBBY", role: "commenter" }, ann.email)).status).toBe(201)
    // Still by email (back-compat).
    expect((await put({ email: "bob@shu.test", role: "editor" }, ann.email)).status).toBe(201)

    // An unknown handle is a 404, not a silent no-op.
    expect((await put({ user: "@nobody", role: "viewer" }, ann.email)).status).toBe(404)
    // Neither field → 400.
    expect((await put({ role: "viewer" }, ann.email)).status).toBe(400)
  })
})

// GET /v1/artifacts?scope=shared returns only artifacts explicitly shared with the
// caller (a per-artifact membership) — the home's "Shared with you" set.
describe("scope=shared listing", () => {
  const owner: TestUser = { id: "u_sc_owner", email: "owner@sc.test", name: "Owner" }
  const viewer: TestUser = { id: "u_sc_viewer", email: "viewer@sc.test", name: "Viewer" }
  const stranger: TestUser = { id: "u_sc_stranger", email: "stranger@sc.test", name: "Stranger" }
  const { app } = makeAuthedApp("scope-shared", [owner, viewer, stranger], "editor")

  const sharedFor = async (email: string): Promise<{ short_id: string }[]> => {
    const res = await app.request("/v1/artifacts?scope=shared", { headers: as(email) })
    return (await res.json()).artifacts
  }

  it("lists only what's shared with the caller, and never leaks to others", async () => {
    const sid = (await (await publishAs(app, "<h1>shared</h1>", {}, as(owner.email))).json())
      .short_id
    await app.request(`/v1/artifacts/${sid}/members`, {
      ...jsonAs(as(owner.email), { email: viewer.email, role: "commenter" }),
      method: "PUT",
    })

    // The viewer sees it under scope=shared…
    expect((await sharedFor(viewer.email)).map((a) => a.short_id)).toContain(sid)
    // …the owner doesn't (they own it, it isn't *shared with* them)…
    expect((await sharedFor(owner.email)).map((a) => a.short_id)).not.toContain(sid)
    // …and a stranger it was never shared with sees nothing.
    expect(await sharedFor(stranger.email)).toEqual([])
  })
})
