import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The sharing & visibility model end-to-end: the workspace-only default, the
// `private` (invite-only) tier, and profile privacy (discoverable as a real
// switch). Companion to the effectiveRole table tests in @derive/core.

const ana: TestUser = { id: "u_vis_ana", email: "ana@vis.test", name: "Ana", username: "anav" }
const ben: TestUser = { id: "u_vis_ben", email: "ben@vis.test", name: "Ben", username: "benv" }

describe("publish defaults to private", () => {
  it("no visibility field ⇒ private; unreadable to anonymous AND workspace members", async () => {
    const { app } = makeAuthedApp("vis-default", [ana, ben], "editor")
    const a = await (await publishAs(app, "<h1>draft</h1>", {}, as(ana.email))).json()
    expect(a.visibility).toBe("private")
    // Anonymous: the detail 404s and the bytes don't serve.
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(404)
    expect((await app.request(`/raw/${a.short_id}/v/1/index.html`)).status).toBe(404)
    // Even a workspace EDITOR can't see it — private means invited people only.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(404)
    // The publisher owns it (the owner-member row written at publish).
    const mine = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ana.email) })
    ).json()
    expect(mine.my_role).toBe("owner")
  })
})

describe("agents act as their registrant, capped at their registered role", () => {
  it("the registrant owns the publish; the agent borrows access with no roster row", async () => {
    const { app } = makeAuthedApp("vis-agent", [ana, ben], "editor")
    await app.request("/v1/me", { headers: as(ana.email) }) // provision the workspace
    const reg = await (
      await app.request("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(ana.email) },
        body: JSON.stringify({ name: "Scribe", role: "editor" }),
      })
    ).json()

    // The agent publishes (no visibility ⇒ the workspace's AGENT default,
    // private: the draft is Ana's until she promotes it).
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# memo")]), "memo.md")
    const pub = await app.request("/v1/artifacts", {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${reg.token}` },
    })
    expect(pub.status).toBe(201)
    const a = await pub.json()
    expect(a.visibility).toBe("private")

    // Ana can open and owns it; the agent can republish.
    const hers = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ana.email) })
    ).json()
    expect(hers.my_role).toBe("owner")

    // The share roster is a human contract: Ana is the only member — the agent
    // borrows her standing rather than holding a row of its own.
    const roster = await (
      await app.request(`/v1/artifacts/${a.short_id}/members`, { headers: as(ana.email) })
    ).json()
    expect(roster.members).toHaveLength(1)
    expect(roster.members[0].user_id).toBe(ana.id)

    // Borrowed standing is capped at the agent's registered role: editor can
    // republish but never manage — the agent cannot delete its own publish.
    expect(
      (
        await app.request(`/v1/artifacts/${a.short_id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${reg.token}` },
        })
      ).status,
    ).toBe(403)
    // Private's contract for a teammate: neither the link nor any listing —
    // the draft is Ana's until she shares or promotes it.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(404)
    const bensList = await (await app.request("/v1/artifacts", { headers: as(ben.email) })).json()
    expect(bensList.artifacts.map((x: { short_id: string }) => x.short_id)).not.toContain(
      a.short_id,
    )
    const form2 = new FormData()
    form2.append("file", new Blob([new TextEncoder().encode("# memo v2")]), "memo.md")
    expect(
      (
        await app.request(`/v1/artifacts/${a.short_id}/versions`, {
          method: "POST",
          body: form2,
          headers: { authorization: `Bearer ${reg.token}` },
        })
      ).status,
    ).toBe(201)
    // Ana's ORDINARY listing shows her own private draft (hers alone to see);
    // "Created by me" narrows to owned work.
    const list = await (await app.request("/v1/artifacts", { headers: as(ana.email) })).json()
    expect(list.artifacts.map((x: { short_id: string }) => x.short_id)).toContain(a.short_id)
    const mine = await (
      await app.request("/v1/artifacts?scope=mine", { headers: as(ana.email) })
    ).json()
    expect(mine.artifacts.map((x: { short_id: string }) => x.short_id)).toContain(a.short_id)
    // The summary counts it as hers — and as still private (the pending badge).
    // Note the agent republish above: ownership keys on her owner row, so a
    // revision by someone else never evicts it from "Created by me".
    const summary = await (await app.request("/v1/tags", { headers: as(ana.email) })).json()
    expect(summary.mine).toBeGreaterThanOrEqual(1)
    expect(summary.mine_private).toBeGreaterThanOrEqual(1)

    // The agent lists too (MCP list_artifacts rides this) and sees the private
    // publish through its registrant's owner row, capped to its own rank.
    const agentList = await (
      await app.request("/v1/artifacts", {
        headers: { authorization: `Bearer ${reg.token}` },
      })
    ).json()
    const row = agentList.artifacts.find((x: { short_id: string }) => x.short_id === a.short_id)
    expect(row?.my_role).toBe("editor")

    // Anonymous listing stays 401.
    expect((await app.request("/v1/artifacts")).status).toBe(401)
  })

  it("the agent can work on what its human made by hand — and not on a teammate's private draft", async () => {
    const { app } = makeAuthedApp("vis-agent-derived", [ana, ben], "editor")
    await app.request("/v1/me", { headers: as(ana.email) })
    const reg = await (
      await app.request("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(ana.email) },
        body: JSON.stringify({ name: "Scribe", role: "editor" }),
      })
    ).json()

    // Ana publishes a private draft herself; her agent republishes it.
    const hers = await (
      await publishAs(app, "<h1>draft</h1>", { visibility: "private" }, as(ana.email))
    ).json()
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>v2</h1>")]), "draft.html")
    expect(
      (
        await app.request(`/v1/artifacts/${hers.short_id}/versions`, {
          method: "POST",
          body: form,
          headers: { authorization: `Bearer ${reg.token}` },
        })
      ).status,
    ).toBe(201)

    // Ben's private draft stays invisible to Ana's agent — derived standing is
    // Ana's, and Ana has none here.
    const bens = await (
      await publishAs(app, "<h1>secret</h1>", { visibility: "private" }, as(ben.email))
    ).json()
    expect(
      (
        await app.request(`/v1/artifacts/${bens.short_id}`, {
          headers: { authorization: `Bearer ${reg.token}` },
        })
      ).status,
    ).toBe(404)
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

describe("the last owner is immovable", () => {
  it("refuses to remove or downgrade the sole owner-member", async () => {
    const { app } = makeAuthedApp("vis-last-owner", [ana], "editor")
    const a = await (
      await publishAs(app, "<h1>mine</h1>", { visibility: "private" }, as(ana.email))
    ).json()
    const del = await app.request(`/v1/artifacts/${a.short_id}/members/${ana.id}`, {
      method: "DELETE",
      headers: as(ana.email),
    })
    expect(del.status).toBe(400)
    const demote = await app.request(`/v1/artifacts/${a.short_id}/members`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(ana.email) },
      body: JSON.stringify({ user: "anav", role: "viewer" }),
    })
    expect(demote.status).toBe(400)
    // Still the owner; still readable.
    const detail = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ana.email) })
    ).json()
    expect(detail.my_role).toBe("owner")
  })
})
