import type { Artifact } from "@/api"

// The parent directory of a synced artifact's source path ("" when top-level) — the
// folder chip on cards/rows and the grouping key for folder-grouped repo views.
export const dirOf = (path: string): string => {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

// The short type badge for an artifact (Skill / Site / Deck / MD / HTML / Doc),
// derived from its kind + denormalized content type without opening the bundle.
export function artifactTypeLabel(a: Artifact): string {
  // A skill rides the denormalized content type (derive/skill), so the grid badges it
  // without opening the bundle — string mirrored from @derive/core SKILL_CONTENT_TYPE.
  if (a.current_content_type === "derive/skill") return "Skill"
  if (a.kind === "bundle") return "Site"
  const ct = a.current_content_type
  if (ct === "text/x-derive-deck") return "Deck"
  if (ct === "text/markdown") return "MD"
  if (ct?.startsWith("text/html")) return "HTML"
  return "Doc"
}
