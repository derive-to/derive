import type { SubscriptionRecord } from "./ports"

export type BillingTier = "free" | "team" | "business"

/** Statuses that grant full access. past_due stays writable while Stripe
 *  retries the card (dunning); the workspace only locks once Stripe gives up. */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const

/** A formerly-live subscription that ended. Distinct from "incomplete" (a
 *  checkout that never paid), which counts as no subscription at all. */
export const LAPSED_SUBSCRIPTION_STATUSES = ["canceled", "unpaid", "incomplete_expired"] as const

export const FREE_SEAT_LIMIT = 3

const GIB = 1024 ** 3
export const STORAGE_CAPS = {
  free: 1 * GIB,
  team: 50 * GIB,
  business: 250 * GIB,
} as const

export interface BillingState {
  tier: BillingTier
  subscriptionActive: boolean
  canPublishApprove: boolean
  blockedReason?: "needs_team" | "lapsed"
  /** undefined = unlimited (self-host with no DERIVE_MAX_BYTES). */
  storageCapBytes?: number
  whiteLabelEntitled: boolean
}

/**
 * The one billing decision, pure and DB-free. Rules, in order:
 *  1. An active subscription wins outright (beta or not) and carries its tier cap.
 *  2. Before enforcement (enforceAt unset or future): the published beta promise,
 *     nothing blocked, storage stays on the operator's fallback cap.
 *  3. After enforcement: a lapsed subscription is read-only; a free workspace
 *     over FREE_SEAT_LIMIT is read-only until an owner upgrades; within the
 *     limit it keeps publishing at the free cap. Read/comment are never touched
 *     here; callers gate only publish/approve.
 */
export const resolveBillingState = (args: {
  subscription: SubscriptionRecord | null
  seatCount: number
  now: Date
  enforceAt?: Date | null
  fallbackMaxBytes?: number
}): BillingState => {
  const { subscription: sub, seatCount, now, enforceAt, fallbackMaxBytes } = args
  if (sub && (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) {
    return {
      tier: sub.tier,
      subscriptionActive: true,
      canPublishApprove: true,
      storageCapBytes: STORAGE_CAPS[sub.tier],
      whiteLabelEntitled: true,
    }
  }
  const enforced = !!enforceAt && enforceAt.getTime() <= now.getTime()
  if (!enforced) {
    return {
      tier: "free",
      subscriptionActive: false,
      canPublishApprove: true,
      storageCapBytes: fallbackMaxBytes,
      whiteLabelEntitled: true,
    }
  }
  const base = {
    tier: "free" as const,
    subscriptionActive: false,
    storageCapBytes: STORAGE_CAPS.free,
    whiteLabelEntitled: false,
  }
  if (sub && (LAPSED_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status))
    return { ...base, canPublishApprove: false, blockedReason: "lapsed" }
  if (seatCount > FREE_SEAT_LIMIT)
    return { ...base, canPublishApprove: false, blockedReason: "needs_team" }
  return { ...base, canPublishApprove: true }
}
