import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("guarded republish: baseVersion (If-Match) merges or conflicts instead of clobbering", () => {
  const owner: TestUser = { id: "u_gp", email: "gp@dock.test", name: "Gp" }
  const { app } = makeAuthedApp("guarded-publish", [owner], "viewer")

  it("409s on an overlapping concurrent edit when baseVersion is sent (nothing clobbered)", async () => {
    const shortId = (await (await publishAs(app, "<h1>v1</h1>", {}, as(owner.email))).json())
      .short_id
    // Someone advances the doc to v2.
    await publishAs(app, "<h1>v2 live</h1>", {}, as(owner.email), shortId)
    // We republish FROM the stale base v1 with a different whole-document change.
    // HTML isn't line-merged in v1, so a divergence is a conflict, not a clobber.
    const res = await publishAs(
      app,
      "<h1>my edit</h1>",
      { baseVersion: "1" },
      as(owner.email),
      shortId,
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("merge conflict")
    expect(body.current_version).toBe(2)
    // The live content is untouched — still v2.
    const live = await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })
    expect(await live.text()).toContain("v2 live")
  })

  it("a republish WITHOUT baseVersion stays last-write-wins (unguarded, backward-compatible)", async () => {
    const shortId = (await (await publishAs(app, "<h1>a</h1>", {}, as(owner.email))).json())
      .short_id
    await publishAs(app, "<h1>b</h1>", {}, as(owner.email), shortId)
    const res = await publishAs(app, "<h1>c</h1>", {}, as(owner.email), shortId) // no baseVersion
    expect(res.status).toBe(201)
    const live = await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })
    expect(await live.text()).toContain("c") // overwrote, as before
  })
})
