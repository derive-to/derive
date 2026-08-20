import { describe, expect, it } from "vitest"
import { FakeBilling, subscriptionRow, subscriptionSnapshot } from "./fake-billing"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const USERS = [u(1), u(2), u(3), u(4)]
const PAST = "2000-01-01T00:00:00Z"

const boot = (name: string, billingEnforceAt?: string) => {
  const fake = new FakeBilling()
  const made = makeAuthedApp(name, USERS, "editor", {
    deps: { billing: fake, billingEnforceAt },
  })
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

const SNAP = subscriptionSnapshot({
  customerId: "cus_fake_default",
  currentPeriodEnd: "2026-08-30T00:00:00.000Z",
})

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
    const { app, fake } = boot("br_checkout", PAST)
    const r = await app.request(
      "/v1/billing/checkout",
      jsonAs(as("u1@x.test"), { tier: "team", interval: "month" }),
    )
    expect(r.status).toBe(200)
    expect((await r.json()).url).toContain("checkout.stripe.test")
    expect(fake.checkouts[0]).toMatchObject({ priceLookupKey: "team_monthly", quantity: 4 })
  })

  it("checkout: annual business maps to business_annual", async () => {
    const { app, fake } = boot("br_annual", PAST)
    await app.request(
      "/v1/billing/checkout",
      jsonAs(as("u1@x.test"), { tier: "business", interval: "year" }),
    )
    expect(fake.checkouts[0]?.priceLookupKey).toBe("business_annual")
  })

  it("checkout: 409 while billing is off, before creating billing state", async () => {
    const { app, fake, meta } = boot("br_checkout_beta")
    const r = await app.request(
      "/v1/billing/checkout",
      jsonAs(as("u1@x.test"), { tier: "team", interval: "month" }),
    )
    expect(r.status).toBe(409)
    expect((await r.json()).error).toBe("Billing is not enabled on this instance.")
    expect(fake.checkouts).toHaveLength(0)
    expect(await meta.getSubscription("default")).toBeNull()
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
    const { app, meta, fake } = boot("br_hook")
    expect((await hook(app, {}, "wrong")).status).toBe(400)
    // The handler now refetches by id (order-proofing) rather than trusting the
    // event payload — the FakeBilling driver's `subscriptions` map is the authority,
    // so it must be seeded to match what the event snapshot claims.
    fake.subscriptions.set("sub_1", SNAP)
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
    const { app, meta, fake } = boot("br_deleted")
    fake.subscriptions.set("sub_1", SNAP)
    await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    fake.subscriptions.set("sub_1", { ...SNAP, status: "canceled" })
    await hook(app, {
      type: "customer.subscription.deleted",
      snapshot: { ...SNAP, status: "canceled" },
    })
    expect((await meta.getSubscription("default"))?.status).toBe("canceled")
    const body = await (await app.request("/v1/billing", { headers: as("u1@x.test") })).json()
    expect(body.subscribed).toBe(false)
    expect(body.status).toBe("canceled")
  })

  it("webhook: a stale retried 'active' event can't resurrect a canceled subscription", async () => {
    const { app, meta, fake } = boot("br_stale_retry")
    // Authoritative Stripe state is already canceled (the `deleted` event processed
    // first, in real time). A late retry of the earlier `updated` event arrives with
    // a snapshot that still claims "active" — the refetch must win over the payload.
    fake.subscriptions.set("sub_1", { ...SNAP, status: "canceled" })
    const r = await hook(app, {
      type: "customer.subscription.updated",
      snapshot: { ...SNAP, status: "active" },
    })
    expect(r.status).toBe(200)
    expect((await meta.getSubscription("default"))?.status).toBe("canceled")
  })

  it("checkout with an active sub: 409, the portal owns changes", async () => {
    const { app, fake } = boot("br_409")
    fake.subscriptions.set("sub_1", SNAP)
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
    const { app, fake } = boot("br_active_not_beta")
    fake.subscriptions.set("sub_1", SNAP)
    await hook(app, { type: "customer.subscription.updated", snapshot: SNAP })
    const body = await (await app.request("/v1/billing", { headers: as("u1@x.test") })).json()
    expect(body.subscribed).toBe(true)
    expect(body.beta).toBe(false)
  })
})

describe("GET /v1/billing blocked", () => {
  it("is null during beta grace even over the seat limit", async () => {
    // boot()'s default deps have no billingEnforceAt, and USERS is 4 editors
    // (over FREE_SEAT_LIMIT) — the published beta promise still wins.
    const { app } = boot("br_blocked_beta")
    const r = await app.request("/v1/billing", { headers: as("u1@x.test") })
    const body = await r.json()
    expect(body.blocked).toBeNull()
  })

  it("is null while subscribed", async () => {
    const FIVE = [u(1), u(2), u(3), u(4), u(5)]
    const { app, meta } = makeAuthedApp("br_blocked_subscribed", FIVE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.upsertSubscription(subscriptionRow({ status: "active", quantity: 5 }))
    const r = await app.request("/v1/billing", { headers: as("u1@x.test") })
    const body = await r.json()
    expect(body.blocked).toBeNull()
  })

  it("reports billing_required past enforcement with 4 seats", async () => {
    const { app } = makeAuthedApp("br_blocked_needs_team", USERS, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const r = await app.request("/v1/billing", { headers: as("u1@x.test") })
    const body = await r.json()
    expect(body.blocked?.code).toBe("billing_required")
    expect(body.blocked?.message).toContain("/settings/billing")
  })

  it("reports billing_lapsed for a canceled subscription past enforcement", async () => {
    const { app, meta } = makeAuthedApp("br_blocked_lapsed", USERS, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.upsertSubscription(subscriptionRow({ status: "canceled" }))
    const r = await app.request("/v1/billing", { headers: as("u1@x.test") })
    const body = await r.json()
    expect(body.blocked?.code).toBe("billing_lapsed")
  })
})
