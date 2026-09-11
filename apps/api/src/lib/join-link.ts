import type { JoinLinkRecord, Role } from "@derive/core"

/** How long a workspace join link lives. Fixed; rotating the link is the only extension. */
export const JOIN_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** A link is redeemable until its expiry. It is never "consumed": many people join through it. */
export const isLiveJoinLink = (l: { expires_at: string }): boolean =>
  new Date(l.expires_at).getTime() >= Date.now()

/** The roles a join link may grant. Never owner: an Admin link could take the workspace over. */
export type JoinLinkRole = Extract<Role, "commenter" | "editor">
export const isJoinLinkRole = (v: unknown): v is JoinLinkRole => v === "commenter" || v === "editor"

/** The link as the Admin sees it. The token rides only inside `url`. */
export const joinLinkJson = (l: JoinLinkRecord, url: string) => ({
  id: l.id,
  role: l.role,
  url,
  created_at: l.created_at,
  expires_at: l.expires_at,
  join_count: l.join_count,
})
