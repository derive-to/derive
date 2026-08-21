import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Hosted agents, first slice: the `hosted` flag on agent records, the
// Admin-only toggle, and the workspace agent settings (the master switch,
// the agent-write switch, default agent). Hosting changes where an agent
// runs — these tests pin that it changes nothing about identity or caps.
describe("hostable agents + workspace agent settings", () => {
  const owner: TestUser = { id: "u_ha_own", email: "haown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_ha_mem", email: "hamem@derive.test", name: "Member" }
  const { app, meta } = makeAuthedApp("agents-hosted", [owner, member], "commenter")

  const createAgent = async (name: string, role?: string) => {
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name, role }))
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string; hosted: boolean; role: string; token: string }
  }

  it("the toggle is Admin-only and workspace-scoped", async () => {
    const created = await createAgent("Scoped")
    // A commenter-seat member can't manage agents.
    const denied = await app.request(`/v1/agents/${created.id}`, {
      ...jsonAs(as(member.email), { hosted: true }),
      method: "PATCH",
    })
    expect(denied.status).toBe(403)
    // An unknown id in this workspace is a 404, not a cross-tenant write.
    const missing = await app.request("/v1/agents/ag_not_here", {
      ...jsonAs(as(owner.email), { hosted: true }),
      method: "PATCH",
    })
    expect(missing.status).toBe(404)
  })

  it("defaultAgentId must name an agent in THIS workspace; null clears it", async () => {
    const bad = await app.request("/v1/workspace/settings", {
      ...jsonAs(as(owner.email), { defaultAgentId: "ag_elsewhere" }),
      method: "PATCH",
    })
    expect(bad.status).toBe(400)

    const agent = await createAgent("Fallback")
    const set = await (
      await app.request("/v1/workspace/settings", {
        ...jsonAs(as(owner.email), { defaultAgentId: agent.id }),
        method: "PATCH",
      })
    ).json()
    expect(set.defaultAgentId).toBe(agent.id)

    const cleared = await (
      await app.request("/v1/workspace/settings", {
        ...jsonAs(as(owner.email), { defaultAgentId: null }),
        method: "PATCH",
      })
    ).json()
    expect(cleared.defaultAgentId).toBeUndefined()
  })

  it("the agentWrites switch refuses an agent-bearer HTTP publish; a person's own is untouched", async () => {
    // The switch binds the write itself, not only the hosted claims — a standing agent
    // bearer hitting /v1/artifacts directly is still an agent writing.
    const agent = await createAgent("Writer", "editor")
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      agentWrites: false,
    })
    const refused = await publishAs(app, "<h1>n</h1>", { title: "Nope" }, bearer(agent.token))
    expect(refused.status).toBe(403)
    expect(await refused.text()).toMatch(/agent writes switched off/i)
    // The switch is about agents: the owner's own publish still lands.
    const human = await publishAs(app, "<h1>mine</h1>", { title: "Mine" }, as(owner.email))
    expect(human.status).toBeLessThan(300)
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      agentWrites: true,
    })
    const ok = await publishAs(app, "<h1>y</h1>", { title: "Yep" }, bearer(agent.token))
    expect(ok.status).toBeLessThan(300)
  })

  it("an agent write to the brand profile ALWAYS opens a round, on the HTTP route too", async () => {
    // The profile steers every agent in the workspace, so its reveal is never silent —
    // whichever surface the write arrives on. A round for the human behind the grant opens
    // even though nobody passed request_review.
    const seeded = await publishAs(
      app,
      "<h1>profile</h1>",
      { title: "Brand profile" },
      as(owner.email),
    )
    const { short_id } = (await seeded.json()) as { short_id: string }
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      brandprint: { collectionId: "col_bp", profileId: short_id },
    })
    const agent = await createAgent("Stylist", "editor")
    const wrote = await publishAs(app, "<h1>new voice</h1>", {}, bearer(agent.token), short_id)
    expect(wrote.status).toBeLessThan(300)
    const art = await meta.getByShortId(short_id)
    const rounds = await meta.listReviewRounds(art?.id ?? "")
    const pending = rounds.find((r) => r.state === "pending")
    expect(pending).toBeTruthy()
    expect(pending?.requested_for).toBe(owner.id)
    // A DETACHED request interrupts the human it acts for — the positive twin of the
    // attended lane's no-self-email rule: the review email is enqueued here.
    const far = new Date(Date.now() + 10_000_000).toISOString()
    const due = await meta.claimDueDeliveries(far, 50, far)
    expect(due.some((d) => d.kind === "email" && d.event_type === "review.requested")).toBe(true)
  })
})
