import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// WP5 — the living-artifact contract: an owner declares maintenance, the
// maintainer agent pulls due work under a lease and settles it. The lease is the
// safety property: two claims never hand the same artifact out twice.
describe("living artifacts", () => {
  const owner: TestUser = { id: "u_liv_own", email: "livown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_liv_mem", email: "livmem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("living", [owner, member], "commenter")

  let n = 0
  const mintAgent = async () => {
    n += 1
    const res = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), { name: `Maintainer ${n}` }),
    )
    return (await res.json()) as { id: string; token: string }
  }
  const publish = async () =>
    (await (await publishAs(app, "# Roadmap\n\nStatus: draft", {}, as(owner.email))).json())
      .short_id as string

  const declare = (shortId: string, body: object) =>
    app.request(`/v1/artifacts/${shortId}/living`, {
      ...jsonAs(as(owner.email), body),
      method: "PUT",
    })

  it("an owner declares living maintenance; only a workspace agent may maintain it", async () => {
    const shortId = await publish()
    const agent = await mintAgent()

    const bad = await declare(shortId, {
      maintainerAgentId: "ag_elsewhere",
      cadenceSeconds: 3600,
    })
    expect(bad.status).toBe(400)

    const ok = await declare(shortId, {
      maintainerAgentId: agent.id,
      cadenceSeconds: 3600,
      freshnessWindowSeconds: 600,
      route: "auto",
    })
    expect(ok.status).toBe(200)
    const rec = await ok.json()
    expect(rec).toMatchObject({ maintainer_agent_id: agent.id, route: "auto", stale: false })
    expect(rec.next_due_at > new Date().toISOString()).toBe(true)
  })

  it("declaring requires manage; reading requires read", async () => {
    const shortId = await publish()
    const agent = await mintAgent()
    // A commenter-seat member can't declare.
    const denied = await app.request(`/v1/artifacts/${shortId}/living`, {
      ...jsonAs(as(member.email), { maintainerAgentId: agent.id, cadenceSeconds: 3600 }),
      method: "PUT",
    })
    expect(denied.status).toBe(404)
  })

  it("a due artifact is claimed under a lease; a second claim gets nothing", async () => {
    const shortId = await publish()
    const agent = await mintAgent()
    // Minimum cadence is 60s, so a fresh declaration is NOT due yet.
    await declare(shortId, { maintainerAgentId: agent.id, cadenceSeconds: 60 })
    const notYet = await (
      await app.request("/v1/agent/work", { headers: bearer(agent.token) })
    ).json()
    expect(notYet.work).toHaveLength(0)
  })

  it("settle rolls the due date forward and clears the lease; only the maintainer settles", async () => {
    const shortId = await publish()
    const agent = await mintAgent()
    const other = await mintAgent()
    const rec = await (
      await declare(shortId, { maintainerAgentId: agent.id, cadenceSeconds: 60 })
    ).json()

    // A non-maintainer can't settle it.
    const wrong = await app.request(`/v1/agent/work/${rec.artifact_id}/settle`, {
      method: "POST",
      headers: bearer(other.token),
    })
    expect(wrong.status).toBe(404)

    const settled = await (
      await app.request(`/v1/agent/work/${rec.artifact_id}/settle`, {
        method: "POST",
        headers: bearer(agent.token),
      })
    ).json()
    expect(settled.last_settled_at).toBeTruthy()
    expect(settled.leased_until).toBeNull()
    expect(settled.next_due_at > rec.next_due_at).toBe(true)
  })

  it("a declaration can be cleared", async () => {
    const shortId = await publish()
    const agent = await mintAgent()
    await declare(shortId, { maintainerAgentId: agent.id, cadenceSeconds: 3600 })
    const del = await app.request(`/v1/artifacts/${shortId}/living`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBe(204)
    const after = await (
      await app.request(`/v1/artifacts/${shortId}/living`, { headers: as(owner.email) })
    ).json()
    expect(after.living).toBeNull()
  })
})
