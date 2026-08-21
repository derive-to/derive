import type { AutomationRef, AutomationTrigger, Run } from "@/api"

// Pure formatting for the Automations UI — kept out of the component so it's unit-tested.

/** A compact human summary of an automation's targets for the row subtitle, e.g.
 *  "1 artifact, 1 tag" or "2 collections". Empty string when there are no targets. */
export function targetSummary(refs: AutomationRef[]): string {
  const counts = { artifact: 0, collection: 0, tag: 0 }
  for (const r of refs) counts[r.kind] += 1
  const parts: string[] = []
  const add = (n: number, one: string) => n > 0 && parts.push(`${n} ${one}${n === 1 ? "" : "s"}`)
  add(counts.artifact, "artifact")
  add(counts.collection, "collection")
  add(counts.tag, "tag")
  return parts.join(", ")
}

/** One write a run performed, ready for the ledger row: the artifact it touched and the
 *  verb — a run either created it or revised it. */
export interface RunWrite {
  shortId: string
  verb: "created" | "revised"
}

/** Parse meta.writes[] into linked, labelled writes — what the activity row renders. Only
 *  writes that produced an artifact (a short id) are shown; a malformed or writes-less meta
 *  (asks, failed runs) yields []. */
export function runWrites(meta: string | null): RunWrite[] {
  if (!meta) return []
  let raw: unknown
  try {
    raw = JSON.parse(meta)
  } catch {
    return []
  }
  const writes = (raw as { writes?: unknown })?.writes
  if (!Array.isArray(writes)) return []
  const out: RunWrite[] = []
  for (const w of writes as { short_id?: unknown; created?: unknown }[]) {
    if (typeof w?.short_id !== "string" || w.short_id === "") continue
    out.push({ shortId: w.short_id, verb: w.created ? "created" : "revised" })
  }
  return out
}

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

export interface RunExecutionReceipt {
  provider: "claude-code" | "codex"
  location: "hosted" | "local"
  model: string | null
  actions: number
  threadId: string | null
}

/** The execution proof attached at enqueue (provider/location/model) and enriched at finish with
 *  the coding agent's structured action count + thread id. Malformed or historical rows are
 *  simply quiet in the activity list. */
export function runExecutionReceipt(meta: string | null): RunExecutionReceipt | null {
  if (!meta) return null
  try {
    const value = JSON.parse(meta) as Record<string, unknown>
    const execution = value.execution as Record<string, unknown> | undefined
    if (!execution || (execution.provider !== "claude-code" && execution.provider !== "codex"))
      return null
    return {
      provider: execution.provider,
      location: execution.location === "local" ? "local" : "hosted",
      model: typeof execution.model === "string" ? execution.model : null,
      actions: Array.isArray(value.actions) ? value.actions.length : 0,
      threadId: typeof value.thread_id === "string" ? value.thread_id : null,
    }
  } catch {
    return null
  }
}
