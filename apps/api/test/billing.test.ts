import { describe, expect, it } from "vitest"
import { FakeBilling } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const USERS = [u(1), u(2), u(3), u(4)]

const boot = (name: string) => {
  const fake = new FakeBilling()
  const made = makeAuthedApp(name, USERS, "editor", { deps: { billing: fake } })
  return { ...made, fake }
}

const hook = (
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  event: unknown,
  sig = "test-sig",
) =>
  app.request("/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    body: JSON.stringify(event),
  })

const SNAP = {
  id: "sub_1",
  customerId: "cus_fake_default",
  status: "active",
  priceLookupKey: "team_monthly",
  quantity: 4,
  currentPeriodEnd: "2026-08-30T00:00:00.000Z",
  orgId: "default",
}

describe("billing routes", () => {
  it("GET /v1/billing: owner sees free-tier truth", async () => {
    const { app } = boot("br_get")
    const r = await app.request("/v1/billing", { headers: as("u1@x.test") })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.tier).toBe("free")
    expect(body.seats).toBe(4)
    expect(body.subscribed).toBe(false)
    expect(body.beta).toBe(true)
  })

  it("GET /v1/billing: editor sees the same shape (any member can read)", async () => {
    const { app } = boot("br_get_editor")
    const r = await app.request("/v1/billing", { headers: as("u2@x.test") })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.tier).toBe("free")
    expect(body.seats).toBe(4)
    expect(body.subscribed).toBe(false)
    expect(body.beta).toBe(true)
  })

  it("checkout: owner gets a URL, quantity = live seats", async () => {
    const { app, fake } = boot("br_checkout")
    const r = await app.request(
      "/v1/billing/checkout",
      jsonAs(as("u1@x.test"), { tier: "team", interval: "month" }),
    )
    expect(r.status).toBe(200)
    expect((await r.json()).url).toContain("checkout.stripe.test")
    expect(fake.checkouts[0]).toMatchObject({ priceLookupKey: "team_monthly", quantity: 4 })
  })

  it("checkout: annual business maps to business_annual", async () => {
    const { app, fake } = boot("br_annual")
    await app.request(
      "/v1/billing/checkout",
      jsonAs(as("u1@x.test"), { tier: "business", interval: "year" }),
    )
    expect(fake.checkouts[0]?.priceLookupKey).toBe("business_annual")
  })

  it("checkout: non-owner 403; no driver 503", async () => {
    const { app } = boot("br_c403")
    expect(
      (
        await app.request(
          "/v1/billing/checkout",
          jsonAs(as("u2@x.test"), { tier: "team", interval: "month" }),
        )
      ).status,
    ).toBe(403)
    const bare = makeAuthedApp("br_nodriver", USERS, "editor")
    expect(
      (
        await bare.app.request(
          "/v1/billing/checkout",
          jsonAs(as("u1@x.test"), { tier: "team", interval: "month" }),
        )
      ).status,
    ).toBe(503)
  })

  it("webhook: bad signature 400, good subscription event upserts", async () => {
    const { app, meta } = boot("br_hook")
    expect((await hook(app, {}, "wrong")).status).toBe(400)
    const r = await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    expect(r.status).toBe(200)
    const row = await meta.getSubscription("default")
    expect(row?.status).toBe("active")
    expect(row?.tier).toBe("team")
    expect(row?.quantity).toBe(4)
  })

  it("webhook: checkout.session.completed pulls the subscription by id", async () => {
    const { app, meta, fake } = boot("br_completed")
    fake.subscriptions.set("sub_1", SNAP)
    const r = await hook(app, { type: "checkout.session.completed", subscriptionId: "sub_1" })
    expect(r.status).toBe(200)
    expect((await meta.getSubscription("default"))?.stripe_subscription_id).toBe("sub_1")
  })

  it("webhook: deletion marks canceled; GET now reports it", async () => {
    const { app, meta } = boot("br_deleted")
    await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    await hook(app, {
      type: "customer.subscription.deleted",
      snapshot: { ...SNAP, status: "canceled" },
    })
    expect((await meta.getSubscription("default"))?.status).toBe("canceled")
    const body = await (await app.request("/v1/billing", { headers: as("u1@x.test") })).json()
    expect(body.subscribed).toBe(false)
    expect(body.status).toBe("canceled")
  })

  it("checkout with an active sub: 409, the portal owns changes", async () => {
    const { app } = boot("br_409")
    await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    expect(
      (
        await app.request(
          "/v1/billing/checkout",
          jsonAs(as("u1@x.test"), { tier: "team", interval: "month" }),
        )
      ).status,
    ).toBe(409)
  })

  it("anonymous webhook passes the front-door lockdown (signature is the gate)", async () => {
    const { app } = boot("br_anon")
    const r = await hook(app, { type: "ignored.event" })
    expect(r.status).toBe(200)
  })

  it("an active subscription is never beta, even before enforcement", async () => {
    const { app } = boot("br_active_not_beta")
    await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    const body = await (await app.request("/v1/billing", { headers: as("u1@x.test") })).json()
    expect(body.subscribed).toBe(true)
    expect(body.beta).toBe(false)
  })
})
