import type { Artifact } from "@/api"

export const byRecency = (a: Artifact, b: Artifact): number => {
  const ta = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at ?? ""
  const tb = b.updated_at ?? b.created_at ?? b.versions[0]?.created_at ?? ""
  if (ta !== tb) return tb.localeCompare(ta)
  return (a.title ?? a.short_id).localeCompare(b.title ?? b.short_id)
}
