import type { AutomationTrigger, Run } from "@/api"

// Pure formatting for the Automations UI — kept out of the component so it's unit-tested.

/** The schedule presets the New-automation form offers, and their cron. Shared so the
 *  create form and the label reader agree on one source of truth. */
export const SCHEDULE_PRESETS = [
  { id: "daily", label: "Every day at 9:00 AM", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays at 9:00 AM", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Mondays at 9:00 AM", cron: "0 9 * * 1" },
] as const

export const EVENT_KINDS = [
  { id: "comment.opened", label: "When someone comments" },
  { id: "upstream.published", label: "When a doc it depends on updates" },
  { id: "webhook", label: "When a webhook fires" },
] as const

const CRON_LABELS: Record<string, string> = Object.fromEntries(
  SCHEDULE_PRESETS.map((p) => [p.cron, p.label]),
)
const EVENT_LABELS: Record<string, string> = Object.fromEntries(
  EVENT_KINDS.map((e) => [e.id, e.label]),
)

/** A human label for an automation's trigger — the row subtitle + the pill. */
export function triggerLabel(t: AutomationTrigger): string {
  if (t.kind === "schedule")
    return t.cron ? (CRON_LABELS[t.cron] ?? `Schedule · ${t.cron}`) : "Schedule"
  if (t.kind === "event") return t.on ? (EVENT_LABELS[t.on] ?? `On ${t.on}`) : "On an event"
  return "Run on demand"
}

/** The one-word status for a run's activity row. Queued/running are live; the rest terminal. */
export function runStatusLabel(status: Run["status"]): string {
  return { queued: "Queued", running: "Running", succeeded: "Done", failed: "Failed" }[status]
}

/** The semantic outcome (published/proposed/answered/…) recorded in a run's meta blob, or null. */
export function runOutcome(meta: string | null): string | null {
  if (!meta) return null
  try {
    const m = JSON.parse(meta) as { outcome?: unknown }
    return typeof m.outcome === "string" ? m.outcome : null
  } catch {
    return null
  }
}
