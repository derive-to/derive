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

// RUN COST — the field that makes the monthly budget mean something.
//
// The budget has always summed run.cost_micro_usd. Nothing wrote it, so the sum was always zero,
// every check passed, and the only real ceiling was concurrency. The executor now reports what a
// run spent; these tests pin the two properties that decide whether the number can be trusted.
//
// The subtle one is ACCUMULATION. A retryable failure requeues the SAME run row, so a run that
// burned an expensive attempt and then settled cheaply would report only the cheap number if the
// write replaced instead of adding — undercounting exactly the runs that cost the most.
describe("run cost reporting", () => {
  const owner: TestUser = { id: "u_cost_own", email: "costown@derive.test", name: "Owner" }
  const { app, meta } = makeAuthedApp("run-cost", [owner], "editor")

  const setup = async (name: string) => {
    const ag = (await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name }))
    ).json()) as { id: string; token: string }
    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: ag.id,
          trigger: { kind: "manual" },
          instruction: "keep it current",
        }),
      )
    ).json()) as { id: string }
    return { ag, auto }
  }
  const runNow = async (autoId: string) =>
    (await (
      await app.request(`/v1/automations/${autoId}/run`, {
        method: "POST",
        headers: as(owner.email),
      })
    ).json()) as { id: string }
  const claim = (token: string) => app.request("/v1/agent/runs/claim", { headers: bearer(token) })
  const finish = (token: string, runId: string, body: object) =>
    app.request(`/v1/agent/runs/${runId}/finish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("a settled run stores what the executor reported", async () => {
    const { ag, auto } = await setup("Reporter")
    const run = await runNow(auto.id)
    await claim(ag.token)
    const res = await finish(ag.token, run.id, {
      status: "succeeded",
      cost_micro_usd: 12_345,
      meta: { outcome: "published" },
    })
    expect(res.status).toBe(200)
    const stored = await meta.getRun(run.id)
    expect(stored?.cost_micro_usd).toBe(12_345)
  })

  it("a retryable failure BANKS its cost at requeue, before the run settles", async () => {
    // The attempt that just failed still ran the model. Because a retry reuses this same row,
    // anything not written here is lost for good: the eventual settle only knows what the LAST
    // attempt spent. Banking at requeue is what makes the total add up.
    const { ag, auto } = await setup("Retrier")
    const run = await runNow(auto.id)

    await claim(ag.token)
    const first = await finish(ag.token, run.id, {
      status: "failed",
      cost_micro_usd: 900_000,
      meta: { outcome: "failed", why: "provider 529", retryable: true },
    })
    expect(first.status).toBe(200)
    expect((await first.json()).retry).toBe(1)
    expect((await meta.getRun(run.id))?.cost_micro_usd).toBe(900_000)
  })

  // The second half — that the settling attempt ADDS to the banked total rather than replacing
  // it — is a store-level test (packages/db, "run cost accumulates across attempts"). It cannot
  // run here: a retry requeues with a 60s backoff, so the run is not claimable again within the
  // test. The store test also exercises both drivers, which is where the parity risk actually is.

  it("an unreported run stays NULL rather than 0", async () => {
    // Null is summable-as-skipped and honest; 0 is a claim we cannot make. The distinction is why
    // the column is nullable, and it is what keeps "free" from being indistinguishable from
    // "never measured" when someone later reads the ledger to explain a bill.
    const { ag, auto } = await setup("Unknown")
    const run = await runNow(auto.id)
    await claim(ag.token)
    await finish(ag.token, run.id, { status: "succeeded", meta: { outcome: "published" } })
    expect((await meta.getRun(run.id))?.cost_micro_usd).toBeNull()
  })
})
