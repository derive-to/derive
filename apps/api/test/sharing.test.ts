import { beforeAll, describe, expect, it } from "vitest"
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

// A signed-in stranger who lands on an artifact they cannot read gets an
// indistinguishable 404 (deliberately — see routes/artifacts.ts). Asking for access is
// the way out of that dead end, and the ask must not become the existence oracle the
// 404 exists to prevent: every request is accepted the same way, whether the artifact
// is missing, forbidden, or already readable. Only the side effects differ.
describe("access request", () => {
  const owner: TestUser = { id: "u_ar_owner", email: "owner@ar.test", name: "Owner" }
  const editor: TestUser = { id: "u_ar_editor", email: "editor@ar.test", name: "Editor" }
  const viewer: TestUser = { id: "u_ar_viewer", email: "viewer@ar.test", name: "Viewer" }
  const stranger: TestUser = { id: "u_ar_stranger", email: "stranger@ar.test", name: "Stranger" }
  // A second asker keeps the indistinguishability probe off the first asker's spent
  // dedupe window; the curator owns a workspace of their own for the collection case.
  const second: TestUser = { id: "u_ar_second", email: "second@ar.test", name: "Second" }
  const curator: TestUser = { id: "u_ar_curator", email: "curator@ar.test", name: "Curator" }
  const { app, meta } = makeAuthedApp(
    "access-request",
    [owner, editor, viewer, stranger, second, curator],
    undefined,
    {
      isolated: true,
    },
  )

  const ask = (shortId: string, by: string, note?: string) =>
    app.request(`/v1/artifacts/${shortId}/access-request`, {
      ...jsonAs(as(by), note === undefined ? {} : { note }),
      method: "POST",
    })
  const bell = async (email: string) =>
    (await (await app.request("/v1/notifications", { headers: as(email) })).json()) as {
      unread: number
      notifications: { kind: string; actor: string; artifact_short_id: string; preview: string }[]
    }

  let shortId = ""
  beforeAll(async () => {
    const spaces = await (await app.request("/v1/workspaces", { headers: as(owner.email) })).json()
    const org = (spaces.workspaces[0] as { id: string }).id
    // An editor seat can share; a viewer seat cannot. Both are in the workspace, so
    // both can READ the team draft — only the editor should be asked to approve.
    await meta.setMembership({ id: "m_ar_ed", org_id: org, user_id: editor.id, role: "editor" })
    await meta.setMembership({ id: "m_ar_vw", org_id: org, user_id: viewer.id, role: "viewer" })
    shortId = (
      await (
        await publishAs(
          app,
          "<h1>team draft</h1>",
          { title: "Team draft", workspace_access: "member", link_role: "none", listed: "none" },
          as(owner.email),
        )
      ).json()
    ).short_id
  })

  it("reaches everyone who can grant, and nobody who cannot", async () => {
    expect((await ask(shortId, stranger.email, "Sent this by a teammate")).status).toBe(202)

    for (const who of [owner, editor]) {
      const n = (await bell(who.email)).notifications[0]
      if (!n) throw new Error(`no notification for ${who.email}`)
      expect(n).toMatchObject({
        kind: "access_request",
        actor: "Stranger",
        artifact_short_id: shortId,
      })
      // The approver needs something to grant TO, and the note to judge it by. The
      // address is also flagged unproven: signup is open and sign-in never requires
      // verification, so an unverified address is a string the asker typed — an
      // approver told to "add dana@partner-co.example" on the strength of it would be
      // granting a stranger a colleague's access.
      expect(n.preview).toContain("Sent this by a teammate")
      expect(n.preview).toContain("unverified email")
    }
    // A viewer seat can read the artifact but cannot share it — asking them to
    // approve is noise they can do nothing about.
    expect((await bell(viewer.email)).unread).toBe(0)
    // And the asker never notifies themselves.
    expect((await bell(stranger.email)).unread).toBe(0)
  })

  // Deliberately uses a DIFFERENT asker from the test above, so the forbidden call
  // reaches the full fan-out (approvers, notifications, mail) instead of returning at
  // the dedupe. Comparing two cheap early exits would pass while the expensive branch
  // leaked. Headers are compared too: an earlier draft called `limited()` here, which
  // writes Retry-After into the Hono context, and the header rode out on the 202.
  it("answers a missing artifact exactly as it answers a forbidden one", async () => {
    const forbidden = await ask(shortId, second.email)
    const missing = await ask("zzzz9999", second.email)
    expect(missing.status).toBe(forbidden.status)
    expect(await missing.text()).toBe(await forbidden.text())
    const headers = (r: Response) =>
      [...r.headers].filter(([k]) => k !== "date" && k !== "x-request-id").sort()
    expect(headers(missing)).toEqual(headers(forbidden))
  })

  it("does not re-notify while an ask is still fresh", async () => {
    const before = (await bell(owner.email)).unread
    expect((await ask(shortId, stranger.email)).status).toBe(202)
    expect((await bell(owner.email)).unread).toBe(before)
  })

  it("stays silent for someone who can already read it", async () => {
    const before = (await bell(owner.email)).unread
    expect((await ask(shortId, viewer.email)).status).toBe(202)
    expect((await bell(owner.email)).unread).toBe(before)
  })

  it("closes the loop: the existing share grant is what answers the ask", async () => {
    expect(
      (await app.request(`/v1/artifacts/${shortId}`, { headers: as(stranger.email) })).status,
    ).toBe(404)
    const granted = await app.request(`/v1/artifacts/${shortId}/members`, {
      ...jsonAs(as(owner.email), { email: stranger.email, role: "commenter" }),
      method: "PUT",
    })
    expect(granted.status).toBe(201)
    expect(
      (await app.request(`/v1/artifacts/${shortId}`, { headers: as(stranger.email) })).status,
    ).toBe(200)
  })
  // A collection is the third grant that can confer `share`, and the one an approver
  // roster built from artifact members + workspace seats alone silently misses. The
  // curator here holds NO artifact_member row and NO seat in the owner's workspace —
  // an editor role on a collection holding the artifact is their only standing, and it
  // is enough to grant. Stub the collection lookup in accessApprovers and this fails.
  it("reaches an approver who can only grant through a collection", async () => {
    const invited = (
      await (
        await publishAs(
          app,
          "<h1>curated</h1>",
          { title: "Curated", workspace_access: "none", link_role: "none", listed: "none" },
          as(owner.email),
        )
      ).json()
    ).short_id
    const spaces = await (await app.request("/v1/workspaces", { headers: as(owner.email) })).json()
    const collection = await (
      await app.request(
        "/v1/collections",
        jsonAs(as(owner.email), {
          title: "Reading list",
          org_id: (spaces.workspaces[0] as { id: string }).id,
        }),
      )
    ).json()
    expect(
      (
        await app.request(`/v1/collections/${collection.id}/items/${invited}`, {
          ...jsonAs(as(owner.email), {}),
          method: "PUT",
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/v1/collections/${collection.id}/members`, {
          ...jsonAs(as(owner.email), { email: curator.email, role: "editor" }),
          method: "PUT",
        })
      ).status,
    ).toBe(201)

    // Precondition: the curator really can grant it, so being asked is actionable.
    expect(
      (await app.request(`/v1/artifacts/${invited}`, { headers: as(curator.email) })).status,
    ).toBe(200)

    const before = (await bell(curator.email)).unread
    expect((await ask(invited, stranger.email)).status).toBe(202)
    expect((await bell(curator.email)).unread).toBe(before + 1)
  })
})
