import { describe, expect, it } from "vitest"
import { visibleArtifacts } from "../src/lib/visibility"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The sharing & visibility model end-to-end: the workspace-only default, the
// `private` (invite-only) tier, and profile privacy (discoverable as a real
// switch). Companion to the effectiveRole table tests in @derive/core.

const ana: TestUser = { id: "u_vis_ana", email: "ana@vis.test", name: "Ana", username: "anav" }
const ben: TestUser = { id: "u_vis_ben", email: "ben@vis.test", name: "Ben", username: "benv" }

describe("publish defaults to the team draft (workspace access, no world link, unlisted)", () => {
  it("no fields ⇒ unlisted, the workspace reaches at its seat role, the world is out", async () => {
    const { app } = makeAuthedApp("vis-default", [ana, ben], "editor")
    const a = await (await publishAs(app, "<h1>draft</h1>", {}, as(ana.email))).json()
    // The factory default: workspace_access=member (the team folds in at their
    // seats), link_role=none (no world link), listed=none (out of every feed).
    expect(a.workspace_access).toBe("member")
    expect(a.link_role).toBe("none")
    expect(a.listed).toBe("none")
    // No world link ⇒ anonymous 404s on both the detail and the bytes.
    expect((await app.request(`/v1/artifacts/${a.short_id}`)).status).toBe(404)
    expect((await app.request(`/raw/${a.short_id}/v/1/index.html`)).status).toBe(404)
    // A workspace member holding the URL opens it at THEIR seat role — Ben is an
    // editor, so he reaches it as an editor. A pasted link never dead-ends a
    // teammate, but the team's seats are what confer the access, not the link.
    const bens = await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })
    expect(bens.status).toBe(200)
    expect((await bens.json()).my_role).toBe("editor")
    // Unlisted stays unlisted: Ben's library never shows it (the URL is the only way in).
    const bensList = await (await app.request("/v1/artifacts", { headers: as(ben.email) })).json()
    expect(bensList.artifacts.map((x: { short_id: string }) => x.short_id)).not.toContain(
      a.short_id,
    )
    // The publisher owns it (the owner-member row written at publish).
    const mine = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ana.email) })
    ).json()
    expect(mine.my_role).toBe("owner")
  })

  it("workspace_access none ⇒ invite-only: even a workspace member 404s", async () => {
    const { app } = makeAuthedApp("vis-none", [ana, ben], "editor")
    const a = await (
      await publishAs(app, "<h1>draft</h1>", { workspace_access: "none" }, as(ana.email))
    ).json()
    expect(a.workspace_access).toBe("none")
    // No workspace access and no link: an editor teammate reaches nothing.
    expect(
      (await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })).status,
    ).toBe(404)
  })

  it("a world link reaches anyone — even an anonymous holder, even while unlisted", async () => {
    const { app } = makeAuthedApp("vis-world-link", [ana], "editor")
    const a = await (
      await publishAs(app, "<h1>unlisted</h1>", { link_role: "viewer" }, as(ana.email))
    ).json()
    expect(a.link_role).toBe("viewer")
    expect(a.listed).toBe("none")
    // Anonymous holder reads (clamped to view); it is still listed nowhere.
    const anonView = await app.request(`/v1/artifacts/${a.short_id}`)
    expect(anonView.status).toBe(200)
    expect((await anonView.json()).my_role).toBe("viewer")
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

    // The agent publishes (no fields ⇒ the workspace default: the team-draft,
    // unlisted until Ana promotes it).
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# memo")]), "memo.md")
    const pub = await app.request("/v1/artifacts", {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${reg.token}` },
    })
    expect(pub.status).toBe(201)
    const a = await pub.json()
    expect(a.listed).toBe("none")

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
    // The team-draft contract for a teammate: never LISTED, but the workspace
    // reaches it at its seat role — Ben is an editor, so a pasted link opens at editor.
    const bensView = await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ben.email) })
    expect(bensView.status).toBe(200)
    expect((await bensView.json()).my_role).toBe("editor")
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

    // Ana publishes an invite-only draft herself; her agent republishes it (the
    // agent borrows Ana's owner standing, capped to its registered editor role).
    const hers = await (
      await publishAs(app, "<h1>draft</h1>", { workspace_access: "none" }, as(ana.email))
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

    // Ben's invite-only draft (workspace_access=none): the workspace reaches
    // nothing, and Ana — whose standing the agent borrows — is not a member. So
    // the agent can't even READ it, let alone revise it.
    const bens = await (
      await publishAs(app, "<h1>secret</h1>", { workspace_access: "none" }, as(ben.email))
    ).json()
    const read = await app.request(`/v1/artifacts/${bens.short_id}`, {
      headers: { authorization: `Bearer ${reg.token}` },
    })
    expect(read.status).toBe(404)
    // The revise path doesn't hide existence the way read does — it just refuses.
    const form3 = new FormData()
    form3.append("file", new Blob([new TextEncoder().encode("<h1>hijack</h1>")]), "draft.html")
    expect(
      (
        await app.request(`/v1/artifacts/${bens.short_id}/versions`, {
          method: "POST",
          body: form3,
          headers: { authorization: `Bearer ${reg.token}` },
        })
      ).status,
    ).toBe(403)
  })
})

describe("invite-only when workspace access is off", () => {
  it("hides an invite-only artifact from workspace members until shared", async () => {
    const { app } = makeAuthedApp("vis-private", [ana, ben], "editor")
    // workspace_access=none, no link: true invite-only — nobody but explicit
    // members reaches it. (The DEFAULT grants the workspace seat access — above.)
    const a = await (
      await publishAs(app, "<h1>secret</h1>", { workspace_access: "none" }, as(ana.email))
    ).json()

    // The creator owns it (the owner-member row written at publish).
    const mine = await (
      await app.request(`/v1/artifacts/${a.short_id}`, { headers: as(ana.email) })
    ).json()
    expect(mine.my_role).toBe("owner")

    // Ben is a workspace EDITOR and still can't see it — workspace_access=none
    // withholds the seat grant, and there's no link. Detail, bytes, and the
    // library listing all stay dark.
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
    await publishAs(app, "<h1>secret</h1>", { workspace_access: "none" }, as(ana.email))
    const works = await (
      await app.request("/v1/users/anav/artifacts", { headers: as(ana.email) })
    ).json()
    expect(works.artifacts).toEqual([])
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
})

describe("/v1/people — workmates only", () => {
  it("lists workspace-mates regardless of discoverability, never yourself", async () => {
    const opted: TestUser = {
      id: "u_vis_out",
      email: "out@vis.test",
      name: "Out",
      username: "outv",
      discoverable: false,
    }
    const { app } = makeAuthedApp("vis-people", [ana, opted], "editor")
    // Membership already implies you can see each other — the discoverable
    // opt-out governs strangers (search/profiles), not teammates.
    const ws = await (await app.request("/v1/people", { headers: as(ana.email) })).json()
    expect(ws.users.map((u: { username: string }) => u.username)).toContain("outv")
    expect(ws.users.map((u: { username: string }) => u.username)).not.toContain("anav")
  })
})

describe("the last owner is immovable", () => {
  it("refuses to remove or downgrade the sole owner-member", async () => {
    const { app } = makeAuthedApp("vis-last-owner", [ana], "editor")
    const a = await (
      await publishAs(app, "<h1>mine</h1>", { workspace_access: "none" }, as(ana.email))
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

// The gate chunks its candidate list to stay inside a dialect's parameter cap. It used to
// hard-code the SMALLEST cap any driver has (D1's), which made Postgres split a
// 200-candidate search into three sequential round trips to respect a limit it does not
// have. A store now declares its own bound — and the gate must return the SAME rows
// whichever bound it uses, because a chunking change that silently dropped a candidate
// would look exactly like a relevance change.
describe("the visibility gate honours the store's own id bound", () => {
  const scope = { orgId: "org_chunk", viewerId: "u_chunk", publicOnly: false }

  it("asks for one query when the store can take the whole list, several when it cannot", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `a_${i}`)
    const calls: number[] = []
    const fake = (bound?: number) => ({
      idsPerQuery: bound === undefined ? undefined : () => bound,
      listArtifacts: async (opts?: { ids?: string[] }) => {
        calls.push(opts?.ids?.length ?? 0)
        return (opts?.ids ?? []).map((id) => ({ id, password_hash: null })) as never
      },
    })

    calls.length = 0
    const wide = await visibleArtifacts(fake(1000) as never, ids, scope)
    expect(calls).toEqual([200])

    calls.length = 0
    const narrow = await visibleArtifacts(fake(undefined) as never, ids, scope)
    expect(calls).toEqual([90, 90, 20])

    // THE REGRESSION THIS EXISTS FOR. Wrappers around the store assume every member is a
    // method, so a store can hand back something that is not a number at all. Unvalidated,
    // that made the chunk size NaN — which slices an EMPTY id list, so the gate reported
    // "no matches" rather than failing. It must fall back to the safe default instead.
    calls.length = 0
    const bogus = {
      idsPerQuery: () => "nonsense" as unknown as number,
      listArtifacts: async (opts?: { ids?: string[] }) => {
        calls.push(opts?.ids?.length ?? 0)
        return (opts?.ids ?? []).map((id) => ({ id, password_hash: null })) as never
      },
    }
    const safe = await visibleArtifacts(bogus as never, ids, scope)
    expect(calls).toEqual([90, 90, 20])
    expect(safe).toHaveLength(200)

    // Same rows either way — the bound is a transport detail, never a filter.
    expect(wide.map((a) => a.id)).toEqual(narrow.map((a) => a.id))
    expect(wide).toHaveLength(200)
  })
})
