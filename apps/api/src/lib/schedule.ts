import { type AutomationRecord, type MetaStore, newId } from "@derive/core"
import { Cron } from "croner"
import { parseTrigger } from "./automation"

// The schedule tick: turning DUE cron automations into queued runs. Two callers, one rule:
//   - a POLLING runner materializes ITS agent's schedules at claim time (the poll IS the tick);
//   - HOSTED dispatch materializes every enabled automation on the deployment's tick.
// Both go through materializeFor below, so "what is due" is defined exactly once.

/** The most recent cron occurrence at or before `now`, or null on a malformed expression (a bad
 *  cron must never 500 a claim — it just never fires). croner's previousRuns is relative to the
 *  passed date, so this is the fire time of the window `now` currently sits in. */
const previousOccurrence = (cron: string, tz: string | undefined, now: Date): Date | null => {
  try {
    // +1s so a fire landing exactly on `now` counts as this window, not the previous one.
    const ref = new Date(now.getTime() + 1000)
    const [prev] = new Cron(cron, tz ? { timezone: tz } : {}).previousRuns(1, ref)
    return prev ?? null
  } catch {
    return null
  }
}

/** Materialize the given automations' due schedule runs. Deduped by the automation's newest
 *  scheduled_for, so ticking several times inside one cron window creates exactly one run —
 *  the idempotency that lets a poll, a cron, and a manual tick all run safely together.
 *  Best-effort per row: one broken cron can never stall the rest. */
const materializeFor = async (
  meta: MetaStore,
  autos: AutomationRecord[],
  now: Date,
): Promise<number> => {
  let created = 0
  for (const a of autos) {
    const trigger = parseTrigger(a.trigger)
    if (trigger.kind !== "schedule" || !trigger.cron) continue
    const prev = previousOccurrence(trigger.cron, trigger.tz, now)
    if (!prev) continue
    const prevIso = prev.toISOString()
    // Already materialized this window? The newest run's scheduled_for at or after this
    // occurrence means the tick already fired for it — skip (idempotent within the window).
    const latest = await meta.latestRunForAutomation(a.id)
    if (latest?.scheduled_for && latest.scheduled_for >= prevIso) continue
    await meta.createRun({
      id: newId("run"),
      org_id: a.org_id,
      automation_id: a.id,
      agent_id: a.agent_id,
      reason: "schedule",
      scheduled_for: prevIso,
    })
    created += 1
  }
  return created
}

/** The POLLING tick: due schedule runs for one agent's automations (claim-time). */
export const materializeDueRuns = async (
  meta: MetaStore,
  agent: { id: string; org_id: string },
  now: Date,
): Promise<number> =>
  materializeFor(
    meta,
    (await meta.listAutomations(agent.org_id)).filter(
      (a) => a.agent_id === agent.id && a.enabled === 1,
    ),
    now,
  )

/** The HOSTED tick: due schedule runs across every enabled automation on this deployment. */
export const materializeAllDueRuns = async (meta: MetaStore, now: Date): Promise<number> =>
  materializeFor(meta, await meta.listEnabledAutomations(), now)
