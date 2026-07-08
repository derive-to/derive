import type { LinkRole, Role } from "@/api"

/**
 * The UI side of the access matrix (the API is the hard gate; these keep the UI from
 * offering a comment action that would 403). Kept pure + standalone so the matrix is
 * unit-tested directly.
 */

/** May a caller with this effective role create comments/replies? Mirrors the API's
 *  `comment` gate: commenter or above. Drives every write affordance in the comment UI. */
export const canCommentWithRole = (role: Role | null | undefined): boolean =>
  role === "commenter" || role === "editor" || role === "owner"

/** Should an anonymous visitor be offered "sign in to comment"? Only when the link
 *  actually grants comment or more (so signing in would lift them past viewer) and
 *  the artifact is live. If an anonymous visitor can SEE the doc at all, the link's
 *  audience already admitted them, so only the role matters here. Anonymous never
 *  comments directly: auth is the gate. */
export const shouldPromptSignInToComment = (
  isAnon: boolean,
  linkRole: LinkRole | undefined,
  removed: boolean,
): boolean => isAnon && (linkRole === "commenter" || linkRole === "editor") && !removed
