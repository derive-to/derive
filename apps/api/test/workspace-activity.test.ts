import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("GET /v1/workspace/activity — the home's needs-you + recent activity", () => {
  const owner: TestUser = { id: "u_wa_own", email: "waown@derive.test", name: "Owner" }
  const mate: TestUser = { id: "u_wa_mate", email: "wamate@derive.test", name: "Mate" }
  const { app } = makeAuthedApp("workspace-activity", [owner, mate], "editor")

  it("serves versions, comments and rounds over the artifacts the viewer can see, healed and typed", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(mate.email) })
    // A team document listed to the workspace (an UNlisted draft never appears in a feed by
    // access alone — the library's rule, which the home's activity follows), and one the
    // owner keeps to themself.
    const shared = (
      await (
        await publishAs(
          app,
          "<h1>team</h1>",
          { workspace_access: "member", listed: "workspace" },
          as(owner.email),
        )
      ).json()
    ).short_id
    const secret = (
      await (
        await publishAs(app, "<h1>mine</h1>", { workspace_access: "none" }, as(owner.email))
      ).json()
    ).short_id
    // An agent publishes a version of the team doc and asks the owner to review it.
    const reg = await (
      await app.request(
        "/v1/agents",
        jsonAs(as(owner.email), { name: "Claude Code", role: "editor" }),
      )
    ).json()
    const pub = await publishAs(
      app,
      "<h1>team v2</h1>",
      { request_review: "true", review_note: "Please check." },
      bearer(reg.token),
      shared,
    )
    expect(pub.status).toBe(201)
    // The owner comments on both documents.
    const onShared = await (
      await app.request(
        `/v1/artifacts/${shared}/comments`,
        jsonAs(as(owner.email), { body_md: "Team note" }),
      )
    ).json()
    await app.request(
      `/v1/artifacts/${secret}/comments`,
      jsonAs(as(owner.email), { body_md: "Private note" }),
    )

    // The owner sees everything, credited: the agent's version, the round for them, both comments.
    const mine = await (
      await app.request("/v1/workspace/activity", { headers: as(owner.email) })
    ).json()
    expect(mine.artifacts.map((a: { short_id: string }) => a.short_id).sort()).toEqual(
      [shared, secret].sort(),
    )
    const v2 = mine.versions.find((v: { n: number; artifact_id: string }) => v.n === 2)
    expect(v2).toMatchObject({ author: "Owner", agent: { id: reg.id, name: "Claude Code" } })
    expect(mine.rounds).toHaveLength(1)
    expect(mine.rounds[0]).toMatchObject({
      state: "pending",
      requested_for: owner.id,
      requested_by_kind: "agent",
      requested_by_name: "Claude Code",
    })
    expect(mine.comments.map((c: { body_md: string }) => c.body_md).sort()).toEqual([
      "Private note",
      "Team note",
    ])
    expect(mine.comments.find((c: { id: string }) => c.id === onShared.id)).toMatchObject({
      author: "Owner",
      author_kind: "user",
    })

    // A workmate sees the team document's rows only — never the private one's.
    const theirs = await (
      await app.request("/v1/workspace/activity", { headers: as(mate.email) })
    ).json()
    expect(theirs.artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([shared])
    expect(theirs.comments.map((c: { body_md: string }) => c.body_md)).toEqual(["Team note"])
    expect(
      theirs.versions.every(
        (v: { artifact_id: string }) => v.artifact_id === theirs.artifacts[0].id,
      ),
    ).toBe(true)
    // The round is on the team doc, so it is visible; it is pending FOR the owner, which the
    // client reads off requested_for.
    expect(theirs.rounds).toHaveLength(1)
  })

  it("rejects the signed-out and clamps the window", async () => {
    expect((await app.request("/v1/workspace/activity")).status).toBe(401)
    expect(
      (await app.request("/v1/workspace/activity?days=90", { headers: as(owner.email) })).status,
    ).toBe(400)
  })
})
