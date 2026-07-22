import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WP5/WP6 — automations + runs, the generic agent-work primitive. An owner defines an
// automation (agent + trigger + instruction); "run now" enqueues a run; the agent claims
// the queued run, finishes it, and the workspace ledger lists it. A "living doc refresh" is
// just an automation with a doc ref, run on demand — the same path a schedule/webhook takes.
describe("automations + runs", () => {
  const owner: TestUser = { id: "u_auto_own", email: "autoown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_auto_mem", email: "automem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("automations", [owner, member], "commenter")

  let n = 0
  const mintAgent = async () => {
    n += 1
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name: `Runner ${n}` }))
    return (await res.json()) as { id: string; token: string }
  }
  const createAutomation = (agentId: string, over: object = {}) =>
    app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        agentId,
        trigger: { kind: "manual" },
        instruction: "keep the roadmap current",
        ...over,
      }),
    )

  it("an owner defines an automation; the agent must be in the workspace", async () => {
    const agent = await mintAgent()
    const bad = await createAutomation("ag_elsewhere")
    expect(bad.status).toBe(400)

    const ok = await createAutomation(agent.id, {
      trigger: { kind: "schedule", cron: "0 9 * * 1", tz: "America/Los_Angeles" },
      route: "auto",
      refs: ["art_123"],
    })
    expect(ok.status).toBe(201)
    const rec = await ok.json()
    expect(rec).toMatchObject({ agent_id: agent.id, route: "auto", enabled: true })
    expect(rec.trigger).toMatchObject({ kind: "schedule", cron: "0 9 * * 1" })
    expect(rec.refs).toEqual(["art_123"])
  })

  it("defining requires manage; a commenter-seat member can't", async () => {
    const agent = await mintAgent()
    const denied = await app.request(
      "/v1/automations",
      jsonAs(as(member.email), {
        agentId: agent.id,
        trigger: { kind: "manual" },
        instruction: "x",
      }),
    )
    expect([403, 404]).toContain(denied.status)
  })

  it("run now → the agent claims the queued run → finishes it → it's in the ledger", async () => {
    const agent = await mintAgent()
    const created = await (await createAutomation(agent.id)).json()

    // Run now: enqueue a run (the "refresh please" verb).
    const runRes = await app.request(`/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(runRes.status).toBe(201)
    const { id: runId, status } = await runRes.json()
    expect(status).toBe("queued")

    // The agent claims it — flipped to running, carrying its automation definition.
    const claimed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    const mine = claimed.runs.find((r: { id: string }) => r.id === runId)
    expect(mine).toBeTruthy()
    expect(mine.automation.instruction).toBe("keep the roadmap current")
    // Claimed once: a second poll gets nothing.
    const again = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    expect(again.runs.find((r: { id: string }) => r.id === runId)).toBeFalsy()

    // Finish it with a cost + result meta.
    const fin = await app.request(`/v1/agent/runs/${runId}/finish`, {
      ...jsonAs(bearer(agent.token), {
        status: "succeeded",
        cost_micro_usd: 900,
        meta: { outcome: "published" },
      }),
      method: "POST",
    })
    expect(fin.status).toBe(200)

    // The workspace ledger shows it (admin view).
    const ledger = await (
      await app.request("/v1/workspace/runs", { headers: as(owner.email) })
    ).json()
    const row = ledger.runs.find((r: { id: string }) => r.id === runId)
    expect(row?.status).toBe("succeeded")
    expect(row?.cost_micro_usd).toBe(900)
  })

  it("an agent records an ad-hoc finished run; org + agent come from the bearer", async () => {
    const agent = await mintAgent()
    const res = await app.request(
      "/v1/agent/runs",
      jsonAs(bearer(agent.token), { reason: "mention", meta: { outcome: "answered" } }),
    )
    expect(res.status).toBe(201)
    const anon = await app.request("/v1/agent/runs", {
      ...jsonAs({}, { reason: "mention" }),
      method: "POST",
    })
    expect([401, 403]).toContain(anon.status)
  })
})
