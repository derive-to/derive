import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WO2 — bring-your-own plans. An owner attaches their own model/broker credential; runs meter
// against it (personal → workspace pool → loud failure). Secrets are encrypted at rest and
// never surfaced. A monthly limit blocks new runs at enqueue once spend reaches it.
const KEY = "test-encryption-key"

describe("plans (bring-your-own model + broker)", () => {
  const owner: TestUser = { id: "u_plan_own", email: "planown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_plan_mem", email: "planmem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("plans", [owner, member], "commenter", {
    deps: { encryptionKey: KEY },
  })
  const attach = (who: string, body: object) => app.request("/v1/plans", jsonAs(as(who), body))

  it("attaches a personal model plan; the secret is never surfaced", async () => {
    const res = await attach(owner.email, {
      kind: "model",
      provider: "anthropic",
      secret: "sk-ant-SECRET",
    })
    expect(res.status).toBe(201)
    const p = (await res.json()) as Record<string, unknown>
    expect(p).toMatchObject({
      kind: "model",
      provider: "anthropic",
      scope: "personal",
      user_id: owner.id,
    })
    expect(p.secret).toBeUndefined()
    expect(p.secret_enc).toBeUndefined()
    // Listed, still no secret anywhere in the payload.
    const listed = await (await app.request("/v1/plans", { headers: as(owner.email) })).json()
    expect(JSON.stringify(listed)).not.toContain("sk-ant-SECRET")
    expect(listed.plans.some((x: { id: string }) => x.id === p.id)).toBe(true)
  })

  it("a workspace pool plan needs manage; a commenter-seat member can't", async () => {
    const denied = await attach(member.email, {
      kind: "model",
      provider: "anthropic",
      secret: "sk",
      scope: "workspace",
    })
    expect([403, 404]).toContain(denied.status)
    const ok = await attach(owner.email, {
      kind: "model",
      provider: "anthropic",
      secret: "sk",
      scope: "workspace",
    })
    expect(ok.status).toBe(201)
    expect((await ok.json()).scope).toBe("workspace")
  })

  it("owner removes their own personal plan", async () => {
    const p = await (
      await attach(owner.email, { kind: "broker", provider: "composio", secret: "ck" })
    ).json()
    const del = await app.request(`/v1/plans/${p.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBe(204)
  })
})

describe("plans: monthly budget guard at enqueue", () => {
  const owner: TestUser = { id: "u_bud_own", email: "budown@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("plans-budget", [owner], "commenter", {
    deps: { encryptionKey: KEY },
  })

  it("blocks fire and run-now once spend reaches the monthly limit", async () => {
    // A pool model plan with a tiny monthly cap.
    await app.request(
      "/v1/plans",
      jsonAs(as(owner.email), {
        kind: "model",
        provider: "anthropic",
        secret: "sk",
        scope: "workspace",
        limits: { monthlyMicroUsd: 1000 },
      }),
    )
    // Record spend that reaches the cap (an agent ad-hoc finished run with cost).
    const agent = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "R" }))
    ).json()
    await app.request(
      "/v1/agent/runs",
      jsonAs(bearer(agent.token), { reason: "mention", cost_micro_usd: 1000 }),
    )
    // A webhook automation: firing it now exceeds budget.
    const auto = await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          trigger: { kind: "event", on: "webhook" },
          instruction: "x",
        }),
      )
    ).json()
    const fired = await app.request(`/v1/automations/${auto.id}/fire`, {
      method: "POST",
      headers: { authorization: `Bearer ${auto.fire_secret}`, "content-type": "application/json" },
      body: "{}",
    })
    expect(fired.status).toBe(429)
    // Run-now is blocked too.
    const ran = await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(ran.status).toBe(429)
  })
})
