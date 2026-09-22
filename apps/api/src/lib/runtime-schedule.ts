import {
  type AutomationRecord,
  type MetaStore,
  newId,
  type RunRecord,
  type RuntimeRunInput,
  roleAllows,
} from "@derive/core"
import { Cron } from "croner"
import { log } from "../log"
import { parseTrigger } from "./automation"
import { runtimeInput } from "./runtime-input"
import { previousOccurrence } from "./schedule"

export function nextRuntimeOccurrence(cron: string, timezone: string, after = new Date()) {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error("Use a five-field cron expression")
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after)
  const next = new Cron(cron, { timezone }).nextRun(after)
  if (!next) throw new Error("The schedule has no next occurrence")
  return next.toISOString()
}

async function scheduleOwnerAllowed(meta: MetaStore, a: AutomationRecord) {
  if (!a.created_by || !a.context_id) return false
  const member = await meta.getMembership(a.org_id, a.created_by)
  const context = await meta.getContext(a.context_id)
  return !!(
    member &&
    context?.org_id === a.org_id &&
    (context.created_by === a.created_by || roleAllows(member.role, "manage"))
  )
}

/** Edits and pause invalidate queued work. A claimed task can finish and save normally. */
export async function runtimeScheduleAllows(meta: MetaStore, run: RunRecord): Promise<boolean> {
  if (!run.automation_id) return true
  const a = await meta.getAutomation(run.automation_id)
  const input = JSON.parse(run.input_snapshot ?? "null") as RuntimeRunInput | null
  return !!(
    a &&
    (await scheduleOwnerAllowed(meta, a)) &&
    a.org_id === run.org_id &&
    a.runtime_id === run.runtime_id &&
    a.enabled === 1 &&
    a.created_by === run.initiated_by &&
    a.revision === input?.schedule_revision
  )
}

export async function materializeRuntimeSchedules(
  meta: MetaStore,
  now: Date,
  orgIds?: ReadonlySet<string>,
) {
  for (const a of await meta.listRuntimeSchedules(orgIds ? [...orgIds] : undefined)) {
    if (!a.runtime_id || !a.created_by) continue
    try {
      const settings = await meta.getOrgSettings(a.org_id)
      if (!settings.hostedAgentsEnabled || !settings.agentWrites || !settings.automateBeta) continue
      if (!(await scheduleOwnerAllowed(meta, a))) continue
      const trigger = parseTrigger(a.trigger)
      if (trigger.kind !== "schedule" || !trigger.cron) continue
      const due = previousOccurrence(trigger.cron, trigger.tz, now)?.toISOString()
      if (!due || due < (a.updated_at ?? a.created_at)) continue
      const latest = await meta.latestRunForAutomation(a.id, "schedule")
      if (latest?.scheduled_for && latest.scheduled_for >= due) continue
      const runtime = await meta.getContextRuntime(a.runtime_id, a.org_id)
      const context = runtime ? await meta.getContext(runtime.context_id) : null
      if (!context || context.org_id !== a.org_id || context.agent_id !== a.agent_id) continue
      const input = await runtimeInput(meta, context, {
        instruction: a.instruction,
        provider: a.provider,
        model: null,
        schedule_revision: a.revision,
      })
      if (!input) continue
      // The store rechecks the definition/revision and busy state at insertion. The existing
      // unique schedule-occurrence index arbitrates concurrent ticks, including lost responses.
      await meta.createRun({
        id: newId("run"),
        org_id: a.org_id,
        agent_id: a.agent_id,
        automation_id: a.id,
        runtime_id: a.runtime_id,
        initiated_by: a.created_by,
        reason: "schedule",
        scheduled_for: due,
        input_snapshot: JSON.stringify(input),
      })
    } catch {
      // A busy runtime or duplicate occurrence is normal; neither grants a retry of agent work.
      log.info("runtime schedule admission deferred", { automation: a.id })
    }
  }
}
