import type { MetaStore } from "@derive/core"

/** Start-of-month ISO (UTC) — the budget window. */
const monthStartIso = (): string => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

/**
 * The enqueue budget guard (invariant 2). True when the owner's resolved MODEL plan carries a
 * monthly limit AND this org's run spend this month has reached it. A missing plan or a plan
 * with no limit is NOT over budget here — a missing meter is the loud failure at execution
 * time (when a model key is actually needed), not at enqueue. `ownerUserId` is the person the
 * run bills to: the verb/automation owner (null → the workspace pool).
 */
export const overBudget = async (
  meta: MetaStore,
  orgId: string,
  ownerUserId: string | null,
): Promise<boolean> => {
  const modelPlan = await meta.resolvePlan(orgId, ownerUserId, "model")
  if (!modelPlan?.limits) return false
  let limit: number | undefined
  try {
    limit = (JSON.parse(modelPlan.limits) as { monthlyMicroUsd?: number }).monthlyMicroUsd
  } catch {
    return false
  }
  if (!limit || limit <= 0) return false
  const spent = await meta.sumRunCostSince(orgId, monthStartIso())
  return spent >= limit
}
