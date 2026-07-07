import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("workspace Activity feed", () => {
  const alice: TestUser = { id: "u_act_alice", email: "aa@derive.test", name: "Alice" }
  const bob: TestUser = { id: "u_act_bob", email: "ab@derive.test", name: "Bob" }
  const { app } = makeAuthedApp("activity", [alice, bob], "editor")

  it("requires a signed-in caller", async () => {
    const res = await app.request("/v1/activity")
    expect(res.status).toBe(401)
  })

  it("records a publish and a comment for an org-visible artifact, newest first", async () => {
    const { short_id } = await (
      await publishAs(app, "<h1>doc</h1>", { visibility: "org" }, as(alice.email))
    ).json()
    await app.request(
      `/v1/artifacts/${short_id}/comments`,
      jsonAs(as(bob.email), { body_md: "looks good" }),
    )

    const feed = await (await app.request("/v1/activity", { headers: as(alice.email) })).json()
    expect(feed.items[0]).toMatchObject({
      kind: "comment",
      actor: "Bob",
      artifact_short_id: short_id,
      preview: "looks good",
    })
    expect(feed.items[1]).toMatchObject({
      kind: "publish",
      actor: "Alice",
      artifact_short_id: short_id,
      version_n: 1,
    })
  })

  it("never records activity for a private or unlisted artifact", async () => {
    const before = (await (await app.request("/v1/activity", { headers: as(alice.email) })).json())
      .items.length
    await publishAs(app, "<h1>secret</h1>", { visibility: "private" }, as(alice.email))
    await publishAs(app, "<h1>draft</h1>", { visibility: "unlisted" }, as(alice.email))
    const after = (await (await app.request("/v1/activity", { headers: as(alice.email) })).json())
      .items.length
    expect(after).toBe(before)
  })

  it("stops serving an artifact's activity once it's downgraded below the feed-visible tiers", async () => {
    const { short_id } = await (
      await publishAs(app, "<h1>fade</h1>", { visibility: "org" }, as(alice.email))
    ).json()
    const seen = async () => {
      const res = await app.request("/v1/activity?limit=100", { headers: as(alice.email) })
      const j = (await res.json()) as { items: { artifact_short_id: string }[] }
      return j.items.some((i) => i.artifact_short_id === short_id)
    }
    expect(await seen()).toBe(true)

    const patched = await app.request(`/v1/artifacts/${short_id}/visibility`, {
      ...jsonAs(as(alice.email), { visibility: "private" }),
      method: "PATCH",
    })
    expect(patched.status).toBe(200)
    expect(await seen()).toBe(false)
  })

  it("deleting an artifact with recorded activity succeeds and drops its rows from the feed", async () => {
    const { short_id } = await (
      await publishAs(app, "<h1>ephemeral</h1>", { visibility: "org" }, as(alice.email))
    ).json()
    const before = (
      await (await app.request("/v1/activity?limit=100", { headers: as(alice.email) })).json()
    ).items as { artifact_short_id: string }[]
    expect(before.some((i) => i.artifact_short_id === short_id)).toBe(true)

    const del = await app.request(`/v1/artifacts/${short_id}`, {
      method: "DELETE",
      headers: as(alice.email),
    })
    expect(del.status).toBe(204)

    const after = (
      await (await app.request("/v1/activity?limit=100", { headers: as(alice.email) })).json()
    ).items as { artifact_short_id: string }[]
    expect(after.some((i) => i.artifact_short_id === short_id)).toBe(false)
  })

  it("records a resolve when a republish bundles thread resolutions via `resolves`", async () => {
    const { short_id } = await (
      await publishAs(app, "<h1>thread</h1>", { visibility: "org" }, as(alice.email))
    ).json()
    const cm = await (
      await app.request(
        `/v1/artifacts/${short_id}/comments`,
        jsonAs(as(bob.email), { body_md: "please fix the typo" }),
      )
    ).json()

    await publishAs(app, "<h1>thread fixed</h1>", { resolves: cm.id }, as(alice.email), short_id)

    const feed = await (
      await app.request("/v1/activity?limit=100", { headers: as(alice.email) })
    ).json()
    const resolved = feed.items.find(
      (i: { kind: string; thread_id: string | null }) =>
        i.kind === "resolve" && i.thread_id === cm.thread_id,
    )
    expect(resolved).toMatchObject({ actor: "Alice", artifact_short_id: short_id })
  })

  it("paginates with a keyset cursor", async () => {
    for (let i = 0; i < 3; i++)
      await publishAs(app, `<h1>page ${i}</h1>`, { visibility: "org" }, as(alice.email))
    const first = await (
      await app.request("/v1/activity?limit=2", { headers: as(alice.email) })
    ).json()
    expect(first.items).toHaveLength(2)
    expect(first.next_cursor).toBeTruthy()

    const second = await (
      await app.request(`/v1/activity?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`, {
        headers: as(alice.email),
      })
    ).json()
    const firstIds = new Set(first.items.map((i: { id: string }) => i.id))
    for (const item of second.items) expect(firstIds.has(item.id)).toBe(false)
  })
})
