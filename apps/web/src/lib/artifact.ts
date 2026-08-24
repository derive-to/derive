import type { Artifact } from "@/api"

/** Can this viewer publish a change straight to the artifact? Editors and owners
 *  publish; a LOCK is a freeze that stops even them until someone unlocks. One
 *  spelling, because the page (which labels the buttons) and the inline-edit hook
 *  both decide this. */
export const canPublishArtifact = (a: Artifact): boolean =>
  (a.my_role === "editor" || a.my_role === "owner") && !a.locked

/** The ONE eligibility base every manual-edit affordance shares — the inline mode,
 *  the in-document gesture that opens it, and the raw source editor: a single file
 *  at its current version that this viewer can PUBLISH to (editing is publishing;
 *  a commenter suggests changes in comments instead), unlocked, with no source
 *  editor already open. Kept here rather
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
  (a.my_role === "editor" || a.my_role === "owner") &&
  !a.locked &&
  !sourceEditorOpen

/** May this viewer rename the artifact? Publish rights, like editing the words —
 *  but a LOCK doesn't stop it: a lock routes CONTENT through review, and a title
 *  carries none. */
export const canRenameArtifact = (a: Artifact): boolean =>
  a.my_role === "editor" || a.my_role === "owner"

/** The format (md vs html) of the artifact's CURRENT version — publishing must keep
 *  it (editing an .md artifact stays markdown), and the source editor keys its
 *  highlighting + preview off it. One spelling, because the page and the actions
 *  hook both decide this. Note this reads the version list, not
 *  `current_content_type` — the denormalized field also carries deck/skill types
 *  that the md-or-html question deliberately flattens. */
export const formatOf = (a: Artifact): "md" | "html" =>
  a.versions.find((v) => v.n === a.current_version)?.content_type === "text/markdown"
    ? "md"
    : "html"

// The short type badge for an artifact (Skill / Site / Deck / MD / HTML / Doc),
// derived from its kind + denormalized content type without opening the bundle.
export function artifactTypeLabel(a: Artifact): string {
  // A skill rides the denormalized content type (derive/skill), so the grid badges it
  // without opening the bundle — string mirrored from @derive/core SKILL_CONTENT_TYPE.
  if (a.current_content_type === "derive/skill") return "Skill"
  if (a.kind === "bundle") return "Site"
  const ct = a.current_content_type
  if (ct === "text/x-derive-deck") return "Deck"
  if (ct === "text/x-derive-linked-bundle") return "Bundle"
  if (ct === "text/x-derive-video") return "Video"
  if (ct === "text/markdown") return "MD"
  if (ct?.startsWith("text/html")) return "HTML"
  return "Doc"
}
