import type { GeneralRole, Role } from "@/api"

/**
 * The UI side of the access matrix (the API is the hard gate; these keep the UI from
 * offering a comment action that would 403). Kept pure + standalone so the matrix is
 * unit-tested directly.
 */

/** May a caller with this effective role create comments/replies? Mirrors the API's
 *  `comment` gate: commenter or above. Drives every write affordance in the comment UI. */
export const canCommentWithRole = (role: Role | null | undefined): boolean =>
  role === "commenter" || role === "editor" || role === "owner"

/** Should an anonymous visitor be offered "sign in to comment"? Only when the link's
 *  general access actually grants comment (so signing in would lift them to commenter)
 *  and the artifact is live. Anonymous never comments directly: auth is the gate. */
export const shouldPromptSignInToComment = (
  isAnon: boolean,
  generalRole: GeneralRole | undefined,
  removed: boolean,
): boolean => isAnon && generalRole === "commenter" && !removed
