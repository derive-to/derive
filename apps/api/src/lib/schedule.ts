import { type AutomationRecord, type MetaStore, newId } from "@derive/core"
import { Cron } from "croner"
import { parseTrigger } from "./automation"

// The schedule tick, materialized lazily at claim time. There is no separate scheduler service:
// when a runner polls /v1/agent/runs/claim, we first turn any DUE cron automations of that agent
// into queued runs, then claim. The runner's poll cadence IS the tick — no runner, no runs, the
// same BYO contract the ask queue already has.

/** The most recent cron occurrence at or before `now`, or null on a malformed expression (a bad
 *  cron must never 500 a claim — it just never fires). croner's previousRun is relative to the
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

/** Enqueue one run for every DUE schedule automation of this agent, deduped so a runner polling
 *  several times inside one cron window creates exactly one run. Returns how many were created.
 *  Best-effort: a single bad automation is skipped, never thrown, so one broken cron can't stall
 *  the claim. */
export const materializeDueRuns = async (
  meta: MetaStore,
  agent: { id: string; org_id: string },
  now: Date,
): Promise<number> => {
  const autos = (await meta.listAutomations(agent.org_id)).filter(
    (a: AutomationRecord) => a.agent_id === agent.id && a.enabled === 1,
  )
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
      org_id: agent.org_id,
      automation_id: a.id,
      agent_id: a.agent_id,
      reason: "schedule",
      scheduled_for: prevIso,
    })
    created += 1
  }
  return created
}
