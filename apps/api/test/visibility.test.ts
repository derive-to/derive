import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The sharing & visibility model end-to-end: the workspace-only default, the
// `private` (invite-only) tier, and profile privacy (discoverable as a real
// switch). Companion to the effectiveRole table tests in @derive/core.

const ana: TestUser = { id: "u_vis_ana", email: "ana@vis.test", name: "Ana", username: "anav" }
const ben: TestUser = { id: "u_vis_ben", email: "ben@vis.test", name: "Ben", username: "benv" }

describe("publish defaults to workspace-only", () => {
  it("no visibility field ⇒ org; the artifact is unreadable anonymously", async () => {
    const { app } = makeAuthedApp("vis-default", [ana, ben], "editor")
    const a = await (await publishAs(app, "<h1>draft</h1>", {}, as(ana.email))).json()
    expect(a.visibility).toBe("org")
    // Anonymous (no session header): the detail 404s and the bytes don't serve.
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(404)
    expect((await app.request(`/raw/${a.short_id}/v/1/index.html`)).status).toBe(404)
    // A workspace member reads it fine.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(200)
  })
})

describe("private: only invited people", () => {
  it("hides a private artifact from workspace members until shared", async () => {
    const { app } = makeAuthedApp("vis-private", [ana, ben], "editor")
    const a = await (
      await publishAs(app, "<h1>secret</h1>", { visibility: "private" }, as(ana.email))
    ).json()

    // The creator owns it (the owner-member row written at publish).
    const mine = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ana.email) })
    ).json()
    expect(mine.my_role).toBe("owner")

    // Ben is a workspace EDITOR and still can't see it — org role grants nothing
    // on private. Detail, bytes, and the library listing all stay dark.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(404)
    expect(
      (await app.request(`/raw/${a.short_id}/v/1/index.html`, { headers: as(ben.email) })).status,
    ).toBe(404)
    const list = await (await app.request("/v1/artifacts", { headers: as(ben.email) })).json()
    expect(list.artifacts.map((x: { short_id: string }) => x.short_id)).not.toContain(a.short_id)
    // The creator's own listing shows it.
    const own = await (await app.request("/v1/artifacts", { headers: as(ana.email) })).json()
    expect(own.artifacts.map((x: { short_id: string }) => x.short_id)).toContain(a.short_id)

    // An explicit share opens it — and it lands in Ben's shared feed.
    const share = await app.request(`/v1/artifacts/${a.short_id}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify({ user: "benv", role: "commenter" }),
    })
    expect(share.status).toBe(201)
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(200)
    const shared = await (
      await app.request("/v1/artifacts?scope=shared", { headers: as(ben.email) })
    ).json()
    expect(shared.artifacts.map((x: { short_id: string }) => x.short_id)).toContain(a.short_id)
  })

  it("never lists a private artifact on the author's profile, even to themselves", async () => {
    const { app } = makeAuthedApp("vis-private-profile", [ana], "editor")
    await publishAs(app, "<h1>secret</h1>", { visibility: "private" }, as(ana.email))
    const works = await (
      await app.request("/v1/users/anav/artifacts", { headers: as(ana.email) })
    ).json()
    expect(works.artifacts).toEqual([])
  })

  it("your own work never shows in your shared-with-you feed", async () => {
    const { app } = makeAuthedApp("vis-own-shared", [ana], "editor")
    await publishAs(app, "<h1>mine</h1>", {}, as(ana.email))
    const shared = await (
      await app.request("/v1/artifacts?scope=shared", { headers: as(ana.email) })
    ).json()
    expect(shared.artifacts).toEqual([])
  })
})

describe("profile privacy: discoverable off hides the profile", () => {
  // Cara opted out; Dre shares a workspace with her, Eve does not.
  const cara: TestUser = {
    id: "u_vis_cara",
    email: "cara@vis.test",
    name: "Cara",
    username: "carav",
    discoverable: false,
  }
  const dre: TestUser = { id: "u_vis_dre", email: "dre@vis.test", name: "Dre", username: "drev" }

  it("404s for anonymous and unrelated viewers; workspace-mates and self still see it", async () => {
    const { app } = makeAuthedApp("vis-profile", [cara, dre], "editor")
    const eveApp = makeAuthedApp("vis-profile-eve", [
      { id: "u_vis_eve", email: "eve@vis.test", name: "Eve", username: "evev" },
    ]).app

    // Anonymous: same 404 as an unknown handle — existence isn't confirmable.
    expect((await app.request("/v1/users/carav")).status).toBe(404)
    expect((await app.request("/v1/users/carav/artifacts")).status).toBe(404)
    // A workspace-mate still resolves her (they already see each other's work).
    expect((await app.request("/v1/users/carav", { headers: as(dre.email) })).status).toBe(200)
    // Herself, of course.
    expect((await app.request("/v1/users/carav", { headers: as(cara.email) })).status).toBe(200)
    // A signed-in stranger in another workspace: 404 (isolated app = no shared org).
    expect((await eveApp.request("/v1/users/carav", { headers: as("eve@vis.test") })).status).toBe(
      404,
    )
  })

  it("a discoverable profile stays anonymous-readable (the author-chip contract)", async () => {
    const { app } = makeAuthedApp("vis-profile-on", [ana])
    expect((await app.request("/v1/users/anav")).status).toBe(200)
  })
})

describe("/v1/people?scope=workspace", () => {
  it("lists workspace-mates regardless of discoverability; global browse still honors it", async () => {
    const opted: TestUser = {
      id: "u_vis_out",
      email: "out@vis.test",
      name: "Out",
      username: "outv",
      discoverable: false,
    }
    const { app } = makeAuthedApp("vis-people", [ana, opted], "editor")
    const ws = await (
      await app.request("/v1/people?scope=workspace", { headers: as(ana.email) })
    ).json()
    expect(ws.users.map((u: { username: string }) => u.username)).toContain("outv")
    // Not yourself.
    expect(ws.users.map((u: { username: string }) => u.username)).not.toContain("anav")
    // The global directory still hides the opt-out.
    const all = await (await app.request("/v1/people", { headers: as(ana.email) })).json()
    expect(all.users.map((u: { username: string }) => u.username)).not.toContain("outv")
  })
})
