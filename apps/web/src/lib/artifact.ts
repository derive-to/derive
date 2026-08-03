import type { Artifact } from "@/api"

// The parent directory of a synced artifact's source path ("" when top-level) — the
// folder chip on cards/rows and the grouping key for folder-grouped repo views.
export const dirOf = (path: string): string => {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

/** Can this viewer publish a change straight to the artifact, or must it go through
 *  review? Editors and owners publish; a LOCKED artifact sends even them to the
 *  propose path. One spelling, because the page (which labels the buttons) and the
 *  inline-edit hook (which picks the endpoint) both decide this, and the two
 *  disagreeing means a button that says Save and files a proposal. */
export const canPublishArtifact = (a: Artifact): boolean =>
  (a.my_role === "editor" || a.my_role === "owner") && !a.locked

/** The ONE eligibility base every manual-edit affordance shares — the inline mode,
 *  the in-document gesture that opens it, and the raw source editor: a single file
 *  at its current version that this viewer can at least propose against, with no
 *  source editor already open and no GitHub sync owning the bytes. Kept here rather
 *  than inline on the page because the page and the frame's arming decide it at
 *  different points in the render, and a new rule must land in both. */
export const canEditArtifactDoc = (
  a: Artifact | undefined,
  shownVersion: number | undefined,
  sourceEditorOpen: boolean,
): boolean =>
  !!a &&
  a.kind === "file" &&
  shownVersion === a.current_version &&
  (a.my_role === "editor" || a.my_role === "owner" || a.my_role === "commenter") &&
  !sourceEditorOpen &&
  !a.managed

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
