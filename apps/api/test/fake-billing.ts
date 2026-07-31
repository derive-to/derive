import type { SubscriptionRecord } from "@derive/core"
import type { BillingDriver, BillingEvent, SubscriptionSnapshot } from "../src/lib/billing"

/** A local subscription row, defaulted to an active Team-monthly plan (org_id
 *  "default", cus_1/sub_1, quantity 4) — override just what a test cares about. */
export const subscriptionRow = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => {
  const now = new Date().toISOString()
  return {
    org_id: "default",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    tier: "team",
    billing_interval: "month",
    status: "active",
    quantity: 4,
    current_period_end: null,
    created_at: now,
    updated_at: now,
    ...over,
  }
}

/** The Stripe-shaped counterpart of `subscriptionRow` — same defaults (cus_1/sub_1,
 *  active team_monthly, quantity 4, org "default") — for tests that drive the
 *  webhook/driver surface instead of upserting a row directly. */
export const subscriptionSnapshot = (
  over: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot => ({
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  priceLookupKey: "team_monthly",
  quantity: 4,
  currentPeriodEnd: null,
  orgId: "default",
  ...over,
})

/** In-memory Stripe stand-in. Signature "test-sig" is the only valid one; the
 *  payload IS the BillingEvent as JSON, so tests author events directly. */
export class FakeBilling implements BillingDriver {
  checkouts: Array<{ priceLookupKey: string; quantity: number; orgId: string }> = []
  quantityCalls: Array<{ subscriptionId: string; quantity: number }> = []
  subscriptions = new Map<string, SubscriptionSnapshot>()
  customersCreated = 0

  async ensureCustomer(a: { orgId: string; email: string | null; existingId: string | null }) {
    if (a.existingId) return a.existingId
    this.customersCreated += 1
    return `cus_fake_${a.orgId}`
  }
  async createCheckoutSession(a: {
    customerId: string
    priceLookupKey: string
    quantity: number
    orgId: string
    successUrl: string
    cancelUrl: string
  }) {
    this.checkouts.push({ priceLookupKey: a.priceLookupKey, quantity: a.quantity, orgId: a.orgId })
    return { url: `https://checkout.stripe.test/${a.orgId}` }
  }
  async createPortalSession() {
    return { url: "https://portal.stripe.test/session" }
  }
  async setQuantity(subscriptionId: string, quantity: number) {
    this.quantityCalls.push({ subscriptionId, quantity })
  }
  async getSubscription(subscriptionId: string) {
    return this.subscriptions.get(subscriptionId) ?? null
  }
  async verifyWebhook(payload: string, signature: string): Promise<BillingEvent> {
    if (signature !== "test-sig") throw new Error("bad signature")
    return JSON.parse(payload) as BillingEvent
  }
}
