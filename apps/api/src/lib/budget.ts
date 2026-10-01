import type { MetaStore } from "@derive/core"

/** Start-of-month ISO (UTC) — the budget window. */
const monthStartIso = (): string => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

/**
 * The enqueue budget guard (invariant 2). True when the owner's resolved MODEL plan carries a
 * monthly limit AND this org's job spend this month has reached it. A missing plan or a plan
 * with no limit is NOT over budget here — a missing meter is the loud failure at execution
 * time (when a model key is actually needed), not at enqueue. `ownerUserId` is the person the
 * work bills to: the job's payer_id (null → the workspace pool).
 *
 * Jobs record `cost_micro_usd` when the selected provider exposes dollar cost. Some
 * subscription-backed CLIs (including Codex) expose token usage but no dollar amount, so their
 * rows remain unknown rather than being recorded as free. Concurrency and retry caps therefore
 * remain the hard backstops for providers whose CLI cannot report price.
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
  // A personal plan's limit is that person's: only the jobs that bill them count against it.
  // The pool's limit is the workspace's, so all of its jobs do.
  const spent = await meta.sumJobCostSince(orgId, monthStartIso(), modelPlan.user_id ?? undefined)
  return spent >= limit
}

/** The budget check for agent jobs: asks, follow-ups, schedules, pulls, graph steps and
 *  Derive-machine dispatch. `payer` is who the work bills to (lib/job-accounts.ts jobPayer),
 *  which picks their personal plan's limit or the workspace pool's, as the chat gate does. A
 *  budget that cannot be read does not stop work: the agent-write switch is the brake that
 *  fails closed, and a missing meter is the loud failure at execution time. */
export const jobsOverBudget = (
  meta: MetaStore,
  orgId: string,
  payer: string | null,
): Promise<boolean> => overBudget(meta, orgId, payer).catch(() => false)

/** What an asker is told when the workspace has spent its month. */
export const OVER_BUDGET =
  "This workspace has reached its monthly model budget, so agents take no new work until next month or until the limit is raised."
