import { describe, expect, it } from "vitest"
import { FakeBilling } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const FOUR = [u(1), u(2), u(3), u(4)]
const THREE = [u(1), u(2), u(3)]
const PAST = "2000-01-01T00:00:00Z"

const seedSub = async (meta: ReturnType<typeof makeAuthedApp>["meta"], status: string) => {
  const now = new Date().toISOString()
  await meta.upsertSubscription({
    org_id: "default",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    tier: "team",
    billing_interval: "month",
    status,
    quantity: 4,
    current_period_end: null,
    created_at: now,
    updated_at: now,
  })
}

describe("billing gate", () => {
  it("beta: 4 editor seats publish freely", async () => {
    const { app } = makeAuthedApp("bg_beta", FOUR, "editor", {
      deps: { billing: new FakeBilling() },
    })
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(201)
  })

  it("enforced + 4 seats + no sub: publish 402 billing_required", async () => {
    const { app } = makeAuthedApp("bg_needs", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_required")
  })

  it("enforced + 3 seats: publish stays open", async () => {
    const { app } = makeAuthedApp("bg_three", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    expect((await publishAs(app, "hello", {}, as("u2@x.test"))).status).toBe(201)
  })

  it("enforced + active sub: 4 seats publish", async () => {
    const { app, meta } = makeAuthedApp("bg_active", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "active")
    expect((await publishAs(app, "hello", {}, as("u2@x.test"))).status).toBe(201)
  })

  it("enforced + canceled sub: read-only lapse, even at 3 seats", async () => {
    const { app, meta } = makeAuthedApp("bg_lapsed", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "canceled")
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_lapsed")
  })

  it("lapse blocks review approve too, but reading stays open", async () => {
    const { app, meta } = makeAuthedApp("bg_lapse_read", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const pub = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(pub.status).toBe(201)
    const { short_id } = await pub.json()
    await seedSub(meta, "canceled")
    const approve = await app.request(
      `/v1/artifacts/${short_id}/review/approve`,
      jsonAs(as("u1@x.test"), {}),
    )
    expect(approve.status).toBe(402)
    const read = await app.request(`/v1/artifacts/${short_id}`, { headers: as("u2@x.test") })
    expect(read.status).toBe(200)
  })

  it("an active Team sub lifts a tiny fallback storage cap to the tier cap", async () => {
    const { app, meta } = makeAuthedApp("bg_cap", THREE, "editor", {
      deps: { billing: new FakeBilling(), maxBytes: 10 },
    })
    const blocked = await publishAs(app, "x".repeat(100), {}, as("u2@x.test"))
    expect(blocked.status).toBe(413)
    await seedSub(meta, "active")
    expect((await publishAs(app, "x".repeat(100), {}, as("u2@x.test"))).status).toBe(201)
  })
})
