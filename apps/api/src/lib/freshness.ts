import type { ArtifactRecord, MetaStore } from "@derive/core"
import { newId } from "@derive/core"
import { parseRefs, parseTrigger } from "./automation"

/** Does an automation's refs blob target this artifact (by internal id or short id)? Reuses the
 *  shared canonical-selector parse rather than re-walking the raw JSON. */
const targetsArtifact = (refsRaw: string | null, artifact: ArtifactRecord): boolean =>
  parseRefs(refsRaw).some(
    (r) => r.kind === "artifact" && (r.id === artifact.id || r.id === artifact.short_id),
  )

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
    if (!targetsArtifact(a.refs, artifact)) continue
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
