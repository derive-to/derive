import { type AutomationRecord, type MetaStore, newId } from "@derive/core"
import { Cron } from "croner"
import { log } from "../log"
import { parseTrigger } from "./automation"
import { findPayer } from "./payer"

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
  let unpayable = 0
  let gated = 0
  // THE BETA GATE, on the one trigger that fires with nobody watching. `automateBeta` was
  // enforced only on the REST lanes a person drives, so with the flag OFF
  // `POST /v1/automations/:id/run` correctly 404'd while the cron tick went right on
  // materializing, dispatching and LIVE-PUBLISHING a document replacement. A switch that stops
  // the button but not the clock is not a kill switch.
  //
  // Read at most once per org per pass, and FAIL CLOSED — the same stance dispatch takes for
  // hostedAgentsEnabled. A settings read that errors must not be able to start work a workspace
  // deliberately switched off.
  const optedIn = new Map<string, boolean>()
  const automateOn = async (orgId: string): Promise<boolean> => {
    const known = optedIn.get(orgId)
    if (known !== undefined) return known
    const on = await meta
      .getOrgSettings(orgId)
      .then((s) => s?.automateBeta === true)
      .catch(() => false)
    optedIn.set(orgId, on)
    return on
  }
  for (const a of autos) {
    const trigger = parseTrigger(a.trigger)
    if (trigger.kind !== "schedule" || !trigger.cron) continue
    // Before the cron maths and the payer walk: a gated workspace costs this pass one settings
    // read, not a query per automation per minute.
    if (!(await automateOn(a.org_id))) {
      gated += 1
      continue
    }
    const prev = previousOccurrence(trigger.cron, trigger.tz, now)
    if (!prev) continue
    const prevIso = prev.toISOString()
    // Already materialized this window? The newest SCHEDULE run's scheduled_for at or after
    // this occurrence means the tick already fired for it — skip (idempotent within the
    // window).
    //
    // Scoped to reason="schedule" deliberately. Every other kind of firing also stamps a
    // scheduled_for — Run now and a webhook fire stamp `now`, and a retry stamps now+backoff,
    // which is in the FUTURE — so an unscoped read let any of them masquerade as "this window
    // is done" and silently swallow the occurrence. One click of Run now at 10:05 meant the
    // 10:00 hourly run never existed, with nothing logged and nothing to notice.
    const latest = await meta.latestRunForAutomation(a.id, "schedule")
    if (latest?.scheduled_for && latest.scheduled_for >= prevIso) continue
    // The read above is a dedupe, not a lock: two ticks can both reach here for the same
    // occurrence (the cron, every polling agent's claim, a second replica). A partial unique
    // index on (automation_id, scheduled_for) WHERE reason='schedule' makes the second INSERT
    // fail instead of creating a duplicate run — so a rejection here means "somebody else
    // already materialized this occurrence", which is success, not an error.
    //
    // Caught per automation so one collision cannot abandon the rest of the pass: this loop
    // walks every enabled automation in the deployment, and throwing out of it would silently
    // stop every automation after the one that collided.
    // PAYER guard. A schedule is the one trigger with nobody watching: without this, an
    // automation in a workspace that has connected no plan materializes a run on EVERY
    // occurrence, forever, and each one boots an executor that discovers the same thing and
    // fails. Refusing to materialize is the difference between a cron that is idle and a cron
    // that bills container time every minute to produce a failure nobody reads.
    //
    // Checked HERE — after the dedupe, immediately before the insert — so a tick that
    // materializes nothing costs no extra queries, whatever the size of the automation list.
    const ag = await meta.getAgent(a.agent_id)
    const payer = await findPayer(meta, {
      orgId: a.org_id,
      agentId: a.agent_id,
      agentCreatedBy: ag?.created_by ?? null,
      // A clock has no person behind it, so a scheduled run can only reach the owner-lend and
      // pool tiers. That is also why it is the trigger most likely to have no payer at all.
      initiator: null,
    })
    if (!payer) {
      unpayable += 1
      continue
    }
    try {
      await meta.createRun({
        id: newId("run"),
        org_id: a.org_id,
        automation_id: a.id,
        agent_id: a.agent_id,
        reason: "schedule",
        scheduled_for: prevIso,
      })
      created += 1
    } catch {
      // Lost the race. The occurrence exists; nothing to do and nothing to report.
    }
  }
  // Once per pass with a count, not once per automation per minute: a workspace that never
  // connects a plan would otherwise fill the log with the same line forever. Silence would be
  // worse — a schedule that quietly stops materializing is indistinguishable from one that is
  // working, which is exactly the class of bug this codebase keeps finding.
  if (unpayable > 0)
    log.warn("schedule: skipped occurrences with no connected model plan", { unpayable })
  // Same shape, same reason: a schedule that quietly stops materializing must be
  // distinguishable from one that is working. `info`, not `warn` — a workspace that has simply
  // not opted into the beta is the expected state, not a fault.
  if (gated > 0)
    log.info("schedule: skipped automations in workspaces without automateBeta", { gated })
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
