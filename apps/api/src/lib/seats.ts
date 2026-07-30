import { ACTIVE_SUBSCRIPTION_STATUSES, type MetaStore } from "@derive/core"
import { log } from "../log"
import type { BillingDriver } from "./billing"

/** The seats Stripe should bill for: every member who can write (editor or owner).
 *  Viewers/commenters ride free — only write access is metered. */
export const billableSeatCount = async (meta: MetaStore, orgId: string): Promise<number> =>
  (await meta.listMemberships(orgId)).filter((m) => m.role === "editor" || m.role === "owner")
    .length

/**
 * Push the live seat count to Stripe when it drifts from the subscription's
 * quantity. Fire-and-forget semantics: a Stripe hiccup must never fail the
 * membership change that triggered it (GET /v1/billing heals on next look).
 */
export const syncSeats = async (
  a: { meta: MetaStore; billing?: BillingDriver },
  orgId: string,
): Promise<void> => {
  try {
    const sub = await a.meta.getSubscription(orgId)
    if (!sub?.stripe_subscription_id || !a.billing) return
    if (!(ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) return
    const seats = Math.max(1, await billableSeatCount(a.meta, orgId))
    if (seats === sub.quantity) return
    await a.billing.setQuantity(sub.stripe_subscription_id, seats)
    await a.meta.upsertSubscription({
      ...sub,
      quantity: seats,
      updated_at: new Date().toISOString(),
    })
  } catch (err) {
    // Never fails the membership change that triggered it — GET /v1/billing heals
    // drift on next look, so a swallowed Stripe hiccup here just means the fix
    // lands a request later instead of immediately.
    log.error("seat sync failed", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
