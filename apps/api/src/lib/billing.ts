import type { SubscriptionRecord } from "@derive/core"
import Stripe from "stripe"

/** What the webhook/route layer needs from a Stripe subscription, provider-shaped
 *  types kept out of the routes entirely. */
export interface SubscriptionSnapshot {
  id: string
  customerId: string
  status: string
  priceLookupKey: string
  quantity: number
  currentPeriodEnd: string | null
  orgId: string | null
}

/** A verified webhook, reduced: the route switches on `type` and upserts from
 *  `snapshot`; anything the rail doesn't model simply has no snapshot. */
export type BillingEvent = {
  type: string
  subscriptionId?: string
  snapshot?: SubscriptionSnapshot
}

export interface BillingDriver {
  ensureCustomer(a: {
    orgId: string
    email: string | null
    existingId: string | null
  }): Promise<string>
  createCheckoutSession(a: {
    customerId: string
    priceLookupKey: string
    quantity: number
    orgId: string
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string }>
  createPortalSession(a: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  setQuantity(subscriptionId: string, quantity: number): Promise<void>
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>
  verifyWebhook(payload: string, signature: string): Promise<BillingEvent>
}

const TIERS: Record<string, { tier: "team" | "business"; interval: "month" | "year" }> = {
  team_monthly: { tier: "team", interval: "month" },
  team_annual: { tier: "team", interval: "year" },
  business_monthly: { tier: "business", interval: "month" },
  business_annual: { tier: "business", interval: "year" },
}

/** Snapshot → local row. Unknown lookup keys (a price edited by hand in the
 *  dashboard) fall back to team/month rather than failing the webhook: status,
 *  not tier, is what gates access. */
export const recordFromSnapshot = (
  orgId: string,
  snap: SubscriptionSnapshot,
  existing: SubscriptionRecord | null,
): SubscriptionRecord => {
  const t = TIERS[snap.priceLookupKey] ?? { tier: "team" as const, interval: "month" as const }
  const now = new Date().toISOString()
  return {
    org_id: orgId,
    stripe_customer_id: snap.customerId,
    stripe_subscription_id: snap.id,
    tier: t.tier,
    billing_interval: t.interval,
    status: snap.status,
    quantity: snap.quantity,
    current_period_end: snap.currentPeriodEnd,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
}

// The installed SDK major (stripe@22) moved `current_period_end` off the top-level
// Subscription onto each SubscriptionItem (Stripe's 2025 "billing cycles per item"
// API change) — Stripe.Subscription no longer has the field at all. The rail only
// bills single-item subscriptions, so the first item's period end stands in for the
// subscription's; adapted here so SubscriptionSnapshot's shape (an external contract
// later tasks depend on verbatim) never has to know about the SDK's item-level split.
const toSnapshot = (sub: Stripe.Subscription): SubscriptionSnapshot => {
  const item = sub.items.data[0]
  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    priceLookupKey: item?.price.lookup_key ?? "",
    quantity: item?.quantity ?? 1,
    currentPeriodEnd: item?.current_period_end
      ? new Date(item.current_period_end * 1000).toISOString()
      : null,
    orgId: sub.metadata?.org_id ?? null,
  }
}

/** The real driver. Fetch HTTP client + SubtleCrypto so the same code runs on
 *  Workers and Node. Price ids are resolved from lookup keys once and cached
 *  for the process lifetime (the seed script owns the keys). */
export const stripeBillingDriver = (a: {
  secretKey: string
  webhookSecret?: string
}): BillingDriver => {
  const stripe = new Stripe(a.secretKey, { httpClient: Stripe.createFetchHttpClient() })
  const cryptoProvider = Stripe.createSubtleCryptoProvider()
  const priceIds = new Map<string, string>()
  const priceId = async (lookupKey: string): Promise<string> => {
    const hit = priceIds.get(lookupKey)
    if (hit) return hit
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
    const id = found.data[0]?.id
    if (!id)
      throw new Error(`no Stripe price with lookup key ${lookupKey}; run scripts/stripe-seed.mjs`)
    priceIds.set(lookupKey, id)
    return id
  }
  return {
    ensureCustomer: async ({ orgId, email, existingId }) => {
      if (existingId) return existingId
      const c = await stripe.customers.create({
        email: email ?? undefined,
        metadata: { org_id: orgId },
      })
      return c.id
    },
    createCheckoutSession: async ({
      customerId,
      priceLookupKey,
      quantity,
      orgId,
      successUrl,
      cancelUrl,
    }) => {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: orgId,
        line_items: [{ price: await priceId(priceLookupKey), quantity }],
        subscription_data: { metadata: { org_id: orgId } },
        success_url: successUrl,
        cancel_url: cancelUrl,
      })
      if (!session.url) throw new Error("Stripe returned a checkout session with no url")
      return { url: session.url }
    },
    createPortalSession: async ({ customerId, returnUrl }) => {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      })
      return { url: session.url }
    },
    setQuantity: async (subscriptionId, quantity) => {
      const sub = await stripe.subscriptions.retrieve(subscriptionId)
      const item = sub.items.data[0]
      if (!item) return
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: item.id, quantity }],
        proration_behavior: "create_prorations",
      })
    },
    getSubscription: async (subscriptionId) => {
      try {
        return toSnapshot(await stripe.subscriptions.retrieve(subscriptionId))
      } catch {
        return null
      }
    },
    verifyWebhook: async (payload, signature) => {
      if (!a.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured")
      const event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        a.webhookSecret,
        undefined,
        cryptoProvider,
      )
      const type = event.type
      if (type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session
        const sid =
          typeof session.subscription === "string" ? session.subscription : session.subscription?.id
        return { type, subscriptionId: sid }
      }
      if (type.startsWith("customer.subscription.")) {
        return { type, snapshot: toSnapshot(event.data.object as Stripe.Subscription) }
      }
      return { type }
    },
  }
}
