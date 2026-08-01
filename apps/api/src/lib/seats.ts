import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  isBillableRole,
  type MetaStore,
  type SubscriptionRecord,
} from "@derive/core"
import { log } from "../log"
import type { BillingDriver } from "./billing"

export { isBillableRole } from "@derive/core"

/** The seats Stripe should bill for: every member who can write (editor or owner). */
export const billableSeatCount = async (meta: MetaStore, orgId: string): Promise<number> =>
  (await meta.listMemberships(orgId)).filter((m) => isBillableRole(m.role)).length

/**
 * Push the live seat count to Stripe when it drifts from the subscription's
 * quantity. Fire-and-forget semantics: a Stripe hiccup must never fail the
 * membership change that triggered it (GET /v1/billing heals on next look).
 *
 * `pre`, when the caller already fetched the subscription row and computed the
 * seat count for its own purposes, skips this function's own two fetches.
 * Returns the corrected row it upserted, or null when it no-oped or failed.
 */
export const syncSeats = async (
  a: { meta: MetaStore; billing?: BillingDriver },
  orgId: string,
  pre?: { sub: SubscriptionRecord | null; seats: number },
): Promise<SubscriptionRecord | null> => {
  try {
    const sub = pre ? pre.sub : await a.meta.getSubscription(orgId)
    if (!sub?.stripe_subscription_id || !a.billing) return null
    if (!(ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) return null
    const seats = Math.max(1, pre ? pre.seats : await billableSeatCount(a.meta, orgId))
    if (seats === sub.quantity) return null
    await a.billing.setQuantity(sub.stripe_subscription_id, seats)
    const corrected: SubscriptionRecord = {
      ...sub,
      quantity: seats,
      updated_at: new Date().toISOString(),
    }
    await a.meta.upsertSubscription(corrected)
    return corrected
  } catch (err) {
    // A swallowed Stripe hiccup here just means the fix lands on a later request
    // instead of immediately.
    log.error("seat sync failed", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
