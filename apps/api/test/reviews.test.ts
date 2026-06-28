import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, proposeAs, publishAs, type TestUser } from "./helpers"

describe("reviews: propose → approve goes live; commenter can't approve", () => {
  const owner: TestUser = { id: "u_ro", email: "ro@dock.test", name: "Ro" }
  const cassie: TestUser = { id: "u_cassie", email: "cassie@dock.test", name: "Cassie" }
  const { app } = makeAuthedApp("reviews", [owner, cassie], "commenter")
  let shortId: string
  let proposalId: string

  it("owner publishes v1; a commenter proposes a candidate that does NOT go live", async () => {
    shortId = (await (await publishAs(app, "<h1>v1 live</h1>", {}, as(owner.email))).json())
      .short_id
    const res = await proposeAs(app, shortId, "<h1>candidate</h1>", as(cassie.email), {
      message: "tighten the headline",
    })
    expect(res.status).toBe(201)
    const p = await res.json()
    proposalId = p.id
    expect(p.state).toBe("open")
    expect(p.base_version).toBe(1)

    // The artifact is untouched: still v1, but the review queue shows 1.
    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    expect(art.current_version).toBe(1)
    expect(art.open_proposals).toBe(1)
  })

  it("renders the proposed experience at its preview URL, distinct from current", async () => {
    const proposed = await app.request(`/raw/${shortId}/p/${proposalId}/index.html`, {
      headers: as(owner.email),
    })
    expect(proposed.status).toBe(200)
    expect(await proposed.text()).toContain("<h1>candidate</h1>")
    // The live content is still v1.
    const live = await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })
    expect(await live.text()).toContain("v1 live")
  })

  it("a commenter cannot approve their own proposal", async () => {
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(cassie.email),
    })
    expect(res.status).toBe(403)
  })

  it("an editor/owner approves: the proposed content becomes the new current version", async () => {
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.state).toBe("approved")
    expect(body.published).toBe(2)

    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    expect(art.current_version).toBe(2)
    expect(art.open_proposals).toBe(0)
    const live = await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })
    expect(await live.text()).toContain("candidate")
  })

  it("approving an already-decided proposal is a conflict", async () => {
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(res.status).toBe(409)
  })
})

describe("reviews: request changes and withdraw keep content live-unchanged", () => {
  const owner: TestUser = { id: "u_rc", email: "rc@dock.test", name: "Rc" }
  const dana: TestUser = { id: "u_dana", email: "dana@dock.test", name: "Dana" }
  const { app } = makeAuthedApp("reviews-rc", [owner, dana], "commenter")
  let shortId: string

  it("request-changes carries the reviewer's note back to the proposer, content unchanged", async () => {
    shortId = (await (await publishAs(app, "<h1>base</h1>", {}, as(owner.email))).json()).short_id
    const pid = (await (await proposeAs(app, shortId, "<h1>try</h1>", as(dana.email))).json()).id
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${pid}/request-changes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ note: "Tighten the intro paragraph first" }),
    })
    expect(res.status).toBe(200)
    const decided = await res.json()
    expect(decided.state).toBe("changes_requested")
    expect(decided.decision_note).toBe("Tighten the intro paragraph first")
    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    expect(art.current_version).toBe(1)
    expect(art.open_proposals).toBe(0)
    // The decided proposal still counts toward the Proposals entry (not withdrawn),
    // so the proposer can return to read the feedback.
    expect(art.proposals_total).toBe(1)
  })

  it("a proposer can withdraw their own open proposal", async () => {
    const pid = (await (await proposeAs(app, shortId, "<h1>wip</h1>", as(dana.email))).json()).id
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${pid}/withdraw`, {
      method: "POST",
      headers: as(dana.email),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe("withdrawn")
  })

  it("an unauthenticated caller on a secured instance cannot propose", async () => {
    const res = await proposeAs(app, shortId, "<h1>nope</h1>", {})
    expect(res.status).toBe(403)
  })
})

describe("reviews: approving a proposal that conflicts with a drifted current returns 409", () => {
  const owner: TestUser = { id: "u_conf_o", email: "conf-o@dock.test", name: "ConfO" }
  const bob: TestUser = { id: "u_conf_b", email: "conf-b@dock.test", name: "ConfB" }
  const { app } = makeAuthedApp("reviews-conflict", [owner, bob], "commenter")

  it("409s with the conflict and publishes nothing when the doc moved under an overlapping proposal", async () => {
    const shortId = (await (await publishAs(app, "<h1>v1</h1>", {}, as(owner.email))).json())
      .short_id
    const proposalId = (
      await (await proposeAs(app, shortId, "<h1>candidate</h1>", as(bob.email))).json()
    ).id
    // The owner publishes v2 directly, so the proposal's base (v1) is now stale and
    // its whole-document HTML change overlaps what changed.
    const v2 = await publishAs(app, "<h1>v2 live</h1>", {}, as(owner.email), shortId)
    expect(v2.status).toBe(201)
    // Approving can no longer auto-merge -> 409, and nothing is published.
    const res = await app.request(`/v1/artifacts/${shortId}/proposals/${proposalId}/approve`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("merge conflict")
    expect(body.current_version).toBe(2)
    // The conflict didn't clobber the live content.
    const live = await app.request(`/v1/artifacts/${shortId}/content`, { headers: as(owner.email) })
    expect(await live.text()).toContain("v2 live")
  })
})
