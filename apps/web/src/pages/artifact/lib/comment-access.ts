import type { Role } from "@/api"

/**
 * The UI side of the access matrix (the API is the hard gate; these keep the UI from
 * offering a comment action that would 403). Kept pure + standalone so the matrix is
 * unit-tested directly.
 */

/** May a caller with this effective role create comments/replies? Mirrors the API's
 *  `comment` gate: commenter or above. Drives every write affordance in the comment UI —
 *  including an anonymous visitor, whose `my_role` now arrives as "commenter" on a
 *  commenter+ link (the guest-name field in the composer covers the rest of the gate). */
export const canCommentWithRole = (role: Role | null | undefined): boolean =>
  role === "commenter" || role === "editor" || role === "owner"
