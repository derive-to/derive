import type { SubscriptionRecord } from "@derive/core"
import { describe, expect, it } from "vitest"
import { recordFromSnapshot } from "../src/lib/billing"
import { FakeBilling } from "./fake-billing"

const snap = {
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  priceLookupKey: "business_annual",
  quantity: 3,
  currentPeriodEnd: "2027-07-30T00:00:00.000Z",
  orgId: "default",
}

describe("recordFromSnapshot", () => {
  it("maps lookup key to tier + interval and carries quantities", () => {
    const r = recordFromSnapshot("default", snap, null)
    expect(r.tier).toBe("business")
    expect(r.billing_interval).toBe("year")
    expect(r.status).toBe("active")
    expect(r.quantity).toBe(3)
    expect(r.stripe_subscription_id).toBe("sub_1")
  })
  it("keeps created_at from an existing row and refreshes updated_at", () => {
    const existing: SubscriptionRecord = recordFromSnapshot("default", snap, null)
    const bumped = recordFromSnapshot("default", { ...snap, status: "canceled" }, existing)
    expect(bumped.created_at).toBe(existing.created_at)
    expect(bumped.status).toBe("canceled")
  })
  it("falls back to team/month on an unknown lookup key", () => {
    const r = recordFromSnapshot("default", { ...snap, priceLookupKey: "custom" }, null)
    expect(r.tier).toBe("team")
    expect(r.billing_interval).toBe("month")
  })
})

// FakeBilling implements the same BillingDriver port the real Stripe driver does — the
// in-memory stand-in later tasks' route tests inject instead of talking to Stripe. Covered
// here so its recorded-call bookkeeping and signature check are proven once, not re-derived
// by every route test that uses it.
describe("FakeBilling", () => {
  it("mints a customer id once and reuses an existing one without minting again", async () => {
    const billing = new FakeBilling()
    const first = await billing.ensureCustomer({
      orgId: "org_1",
      email: "a@b.com",
      existingId: null,
    })
    expect(first).toBe("cus_fake_org_1")
    expect(billing.customersCreated).toBe(1)
    const second = await billing.ensureCustomer({
      orgId: "org_1",
      email: "a@b.com",
      existingId: "cus_real",
    })
    expect(second).toBe("cus_real")
    expect(billing.customersCreated).toBe(1)
  })

  it("records checkout sessions and quantity changes", async () => {
    const billing = new FakeBilling()
    const { url } = await billing.createCheckoutSession({
      customerId: "cus_1",
      priceLookupKey: "team_monthly",
      quantity: 5,
      orgId: "org_1",
      successUrl: "https://x/success",
      cancelUrl: "https://x/cancel",
    })
    expect(url).toBe("https://checkout.stripe.test/org_1")
    expect(billing.checkouts).toEqual([
      { priceLookupKey: "team_monthly", quantity: 5, orgId: "org_1" },
    ])

    await billing.setQuantity("sub_1", 7)
    expect(billing.quantityCalls).toEqual([{ subscriptionId: "sub_1", quantity: 7 }])
  })

  it("looks up a seeded subscription by id, else returns null", async () => {
    const billing = new FakeBilling()
    expect(await billing.getSubscription("sub_missing")).toBeNull()
    billing.subscriptions.set("sub_1", snap)
    expect(await billing.getSubscription("sub_1")).toEqual(snap)
  })

  it("verifyWebhook accepts only the test signature and echoes the payload", async () => {
    const billing = new FakeBilling()
    const event = { type: "customer.subscription.updated", snapshot: snap }
    await expect(billing.verifyWebhook(JSON.stringify(event), "wrong-sig")).rejects.toThrow(
      "bad signature",
    )
    await expect(billing.verifyWebhook(JSON.stringify(event), "test-sig")).resolves.toEqual(event)
  })
})
