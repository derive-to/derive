import type { BillingDriver, BillingEvent, SubscriptionSnapshot } from "../src/lib/billing"

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
