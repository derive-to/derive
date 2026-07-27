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
 *  comments directly: auth is the gate. (Callers are anon by construction — the
 *  prompt renders in PublicViewer, which only mounts for anonymous visitors.) */
export const shouldPromptSignInToComment = (
  linkRole: LinkRole | undefined,
  removed: boolean,
): boolean => (linkRole === "commenter" || linkRole === "editor") && !removed

/** The nudge's strings, from the detail response's open-thread count: the floating
 *  pill, the panel heading, and the sign-in CTA. With threads open the copy sells
 *  the conversation ("9 comments · Join the conversation"). Empty (or count
 *  withheld) drops the heading entirely — "Sign in to comment" over the drifting
 *  backdrop, deliberately ambiguous about whether anything sits behind the wall,
 *  rather than announcing there's nothing to see. Pure so the wording is pinned
 *  by tests. */
export const commentNudgeCopy = (
  count: number | undefined,
): { pill: string; heading: string | null; cta: string } => {
  if (!count) return { pill: "Comments", heading: null, cta: "Sign in to comment" }
  const n = `${count} comment${count === 1 ? "" : "s"}`
  return { pill: n, heading: n, cta: "Join the conversation" }
}
