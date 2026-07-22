import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WP6 — the run ledger: an agent records its own runs via its bearer; an Admin
// reads the workspace's activity. org_id + agent_id are never trusted from the
// body — an agent can only write its own runs in its own workspace.
describe("agent run ledger", () => {
  const owner: TestUser = { id: "u_run_own", email: "runown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_run_mem", email: "runmem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("agent-runs", [owner, member], "commenter")

  let n = 0
  const mintAgent = async () => {
    // Unique name per mint — the seeded workspace is shared across tests, and
    // agent names are unique per workspace.
    n += 1
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name: `Ledgerer ${n}` }))
    return (await res.json()) as { id: string; token: string }
  }

  it("an agent records a run; an Admin reads it back newest-first", async () => {
    const agent = await mintAgent()
    const rec = await app.request("/v1/agent/runs", {
      method: "POST",
      headers: { ...bearer(agent.token), "content-type": "application/json" },
      body: JSON.stringify({
        lane: "shared",
        trigger: "draft",
        outcome: "proposed",
        model: "claude-x",
        input_tokens: 1200,
        output_tokens: 340,
        cost_micro_usd: 5100,
        artifact_short_id: "a1b2c3d4",
      }),
    })
    expect(rec.status).toBe(201)

    const list = await (
      await app.request("/v1/workspace/agent-runs", { headers: as(owner.email) })
    ).json()
    expect(list.runs).toHaveLength(1)
    expect(list.runs[0]).toMatchObject({
      agent_id: agent.id,
      lane: "shared",
      trigger: "draft",
      outcome: "proposed",
      cost_micro_usd: 5100,
      artifact_short_id: "a1b2c3d4",
    })
  })

  it("recording requires an agent bearer, and validates the body", async () => {
    const noAuth = await app.request("/v1/agent/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "shared", trigger: "x", outcome: "answered" }),
    })
    // The app's anon lockdown (403) fires before the route's own 401 — either
    // way a tokenless caller is refused.
    expect([401, 403]).toContain(noAuth.status)

    const agent = await mintAgent()
    const badOutcome = await app.request("/v1/agent/runs", {
      method: "POST",
      headers: { ...bearer(agent.token), "content-type": "application/json" },
      body: JSON.stringify({ lane: "shared", trigger: "x", outcome: "exploded" }),
    })
    expect(badOutcome.status).toBe(400)
  })

  it("the activity view is Admin-only", async () => {
    const denied = await app.request("/v1/workspace/agent-runs", { headers: as(member.email) })
    expect(denied.status).toBe(403)
  })
})
