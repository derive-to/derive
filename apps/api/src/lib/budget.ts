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
 *
 * ⚠️ NOT LOAD-BEARING YET — do not describe this as a spend ceiling. It sums
 * `run.cost_micro_usd`, and nothing writes that column: the executor settles a run with
 * `{status, meta}` and never reports what the model cost (grep `cost_micro_usd` under
 * packages/cli — no hits). The sum is therefore always 0 and this always returns false, at
 * every call site. The wiring is right and starts working the day the executor reports cost;
 * until then the only real limits on hosted spend are the per-org in-flight cap and the
 * retry/attempt caps, which bound CONCURRENCY and REPETITION rather than money. Reporting
 * cost from the runner is the fix, and it is the last thing standing between this and an
 * actual budget.
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
