import type { ArtifactRecord, AutomationTrigger, MetaStore } from "@derive/core"
import { newId } from "@derive/core"

const parseTrigger = (raw: string): AutomationTrigger => {
  try {
    const t = JSON.parse(raw)
    if (t && typeof t === "object") return t as AutomationTrigger
  } catch {}
  return { kind: "manual" }
}

/** Does an automation's refs blob target this artifact (by internal id or short id)? */
const refsInclude = (refsRaw: string | null, artifact: ArtifactRecord): boolean => {
  if (!refsRaw) return false
  try {
    const refs = JSON.parse(refsRaw)
    if (!Array.isArray(refs)) return false
    return refs.some((r) => {
      const id = typeof r === "string" ? r : (r as { id?: string })?.id
      return id === artifact.id || id === artifact.short_id
    })
  } catch {
    return false
  }
}

/**
 * WO7 — on a view of `artifact`, enqueue a refresh run for each ENABLED "view" automation that
 * targets it AND whose content is older than its staleness budget (maxAgeMinutes; 0 = always).
 * Debounced: if a run is already queued for that automation, none is added, so concurrent opens
 * don't pile up runs. Best-effort and fire-and-forget from the view beacon; never blocks it.
 */
export const maybeRefreshOnView = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
): Promise<void> => {
  const autos = await meta.listAutomations(artifact.org_id)
  const contentTime = new Date(artifact.updated_at ?? artifact.created_at).getTime()
  const ageMinutes = (Date.now() - contentTime) / 60_000
  const cutoff = new Date(Date.now() + 60_000).toISOString()
  for (const a of autos) {
    if (a.enabled !== 1) continue
    const t = parseTrigger(a.trigger)
    if (t.kind !== "view") continue
    if (!refsInclude(a.refs, artifact)) continue
    const maxAge = typeof t.maxAgeMinutes === "number" ? t.maxAgeMinutes : 0
    if (ageMinutes < maxAge) continue // still fresh
    // Debounce: a run already queued for this automation covers this view.
    if (await meta.findCoalescibleRun(a.id, cutoff)) continue
    await meta.createRun({
      id: newId("run"),
      org_id: a.org_id,
      automation_id: a.id,
      agent_id: a.agent_id,
      reason: "view",
      scheduled_for: new Date().toISOString(),
      meta: JSON.stringify({ trigger: "view", artifact: artifact.short_id }),
    })
  }
}
