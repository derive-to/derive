import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WP1 of the hosted-agents plan: the `hosted` flag on agent records, the
// Admin-only toggle, and the workspace agent settings (master switch,
// killswitch, auto opt-in, default agent). Hosting changes where an agent
// runs — these tests pin that it changes nothing about identity or caps.
describe("hostable agents + workspace agent settings", () => {
  const owner: TestUser = { id: "u_ha_own", email: "haown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_ha_mem", email: "hamem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("agents-hosted", [owner, member], "commenter")

  const createAgent = async (name: string) => {
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name }))
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string; hosted: boolean; role: string }
  }

  it("agents are born un-hosted; the Admin toggle flips it and the list reflects it", async () => {
    const created = await createAgent("Scribe")
    expect(created.hosted).toBe(false)

    const on = await app.request(`/v1/agents/${created.id}`, {
      ...jsonAs(as(owner.email), { hosted: true }),
      method: "PATCH",
    })
    expect(on.status).toBe(200)
    const flipped = await on.json()
    // Hosting flips WHERE it runs; identity and cap are untouched.
    expect(flipped).toMatchObject({ id: created.id, hosted: true, role: "commenter" })

    const list = await (await app.request("/v1/agents", { headers: as(owner.email) })).json()
    expect(list.agents.find((a: { id: string }) => a.id === created.id)?.hosted).toBe(true)

    const off = await app.request(`/v1/agents/${created.id}`, {
      ...jsonAs(as(owner.email), { hosted: false }),
      method: "PATCH",
    })
    expect((await off.json()).hosted).toBe(false)
  })

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

  it("agent settings default sanely and round-trip through a partial PATCH", async () => {
    const before = await (
      await app.request("/v1/workspace/settings", { headers: as(owner.email) })
    ).json()
    expect(before).toMatchObject({
      hostedAgentsEnabled: true,
      agentKillswitch: false,
      agentAutoEnabled: false,
    })
    expect(before.defaultAgentId).toBeUndefined()

    const patched = await (
      await app.request("/v1/workspace/settings", {
        ...jsonAs(as(owner.email), { agentKillswitch: true, hostedAgentsEnabled: false }),
        method: "PATCH",
      })
    ).json()
    expect(patched).toMatchObject({ agentKillswitch: true, hostedAgentsEnabled: false })
    // Partial PATCH: untouched keys survive.
    expect(patched.agentAutoEnabled).toBe(false)
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
})
