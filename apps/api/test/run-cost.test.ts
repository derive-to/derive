import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

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
