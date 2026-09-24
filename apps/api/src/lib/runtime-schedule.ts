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
import { runtimeFailureReason } from "./runtime-diagnostics"
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
  const runtime = a.runtime_id ? await meta.getContextRuntime(a.runtime_id, a.org_id) : null
  const managed = runtime?.connection_id === null
  return !!(
    member &&
    (managed || (await meta.isInstanceOperator(a.created_by))) &&
    context?.org_id === a.org_id &&
    (context.created_by === a.created_by || roleAllows(member.role, "manage"))
  )
}

/** Edits and pause invalidate queued work. A claimed task can finish and save normally. */
export async function runtimeScheduleAllows(meta: MetaStore, run: RunRecord): Promise<boolean> {
  if (!run.automation_id) return true
  const a = await meta.getAutomation(run.automation_id)
  const runtime = run.runtime_id ? await meta.getContextRuntime(run.runtime_id, run.org_id) : null
  const input = JSON.parse(run.input_snapshot ?? "null") as RuntimeRunInput | null
  return !!(
    a &&
    (await scheduleOwnerAllowed(meta, a)) &&
    a.org_id === run.org_id &&
    a.runtime_id === run.runtime_id &&
    (run.reason === "manual:runtime" ||
      (a.enabled === 1 && (await meta.getOrgSettings(run.org_id)).automateBeta)) &&
    (runtime?.connection_id === null || a.created_by === run.initiated_by) &&
    a.revision === input?.schedule_revision
  )
}

export async function materializeRuntimeSchedules(
  meta: MetaStore,
  now: Date,
  orgIds: ReadonlySet<string>,
) {
  const schedules = await meta.listRuntimeSchedules([...orgIds])
  let admitted = 0
  const skipped: Record<string, number> = {}
  for (const a of schedules) {
    const fields = { automation: a.id, workspace: a.org_id, runtime: a.runtime_id }
    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1
      log.info("runtime schedule skipped", { ...fields, reason })
    }
    let stage = "definition"
    try {
      if (!a.runtime_id || !a.created_by) {
        skip("incomplete_definition")
        continue
      }
      stage = "settings"
      const settings = await meta.getOrgSettings(a.org_id)
      if (!settings.hostedAgentsEnabled || !settings.agentWrites || !settings.automateBeta) {
        skip(
          !settings.hostedAgentsEnabled
            ? "hosted_agents_disabled"
            : !settings.agentWrites
              ? "agent_writes_disabled"
              : "automations_disabled",
        )
        continue
      }
      stage = "owner"
      if (!(await scheduleOwnerAllowed(meta, a))) {
        skip("owner_ineligible")
        continue
      }
      stage = "occurrence"
      const trigger = parseTrigger(a.trigger)
      if (trigger.kind !== "schedule" || !trigger.cron) {
        skip("invalid_trigger")
        continue
      }
      const due = previousOccurrence(trigger.cron, trigger.tz, now)?.toISOString()
      if (!due || due < (a.updated_at ?? a.created_at)) {
        skip(due ? "not_due_since_edit" : "no_occurrence")
        continue
      }
      stage = "latest_run"
      const latest = await meta.latestRunForAutomation(a.id, "schedule")
      if (latest?.scheduled_for && latest.scheduled_for >= due) {
        skip("already_admitted")
        continue
      }
      stage = "context"
      const runtime = await meta.getContextRuntime(a.runtime_id, a.org_id)
      const context = runtime ? await meta.getContext(runtime.context_id) : null
      if (!context || context.org_id !== a.org_id || context.agent_id !== a.agent_id) {
        skip("context_unavailable")
        continue
      }
      stage = "input"
      const input = await runtimeInput(meta, context, {
        instruction: a.instruction,
        provider: a.provider,
        model: null,
        schedule_revision: a.revision,
      })
      if (!input) {
        skip("manifest_unavailable")
        continue
      }
      // The store rechecks the definition/revision and busy state at insertion. The existing
      // unique schedule-occurrence index arbitrates concurrent ticks, including lost responses.
      stage = "insert"
      const run = await meta.createRun({
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
      admitted++
      log.info("runtime schedule admitted", { ...fields, run: run.id, scheduled_for: due })
    } catch (error) {
      const reason = runtimeFailureReason(error)
      skipped[reason] = (skipped[reason] ?? 0) + 1
      // A busy runtime or duplicate occurrence is normal. Other errors need attention;
      // neither permits retrying an agent that may already be doing the work.
      const emit = reason === "duplicate" || reason === "admission_conflict" ? log.info : log.warn
      emit("runtime schedule admission deferred", { ...fields, stage, reason })
    }
  }
  return { schedules: schedules.length, admitted, skipped }
}
