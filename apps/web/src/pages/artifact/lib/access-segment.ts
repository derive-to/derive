import type { LinkRole, Listed, WorkspaceAccess } from "@/api"

/** The "WHO CAN OPEN THIS" primary choice in the share dialog. */
export type AccessSegment = "invite" | "workspace" | "anyone"

/** Project the access triple onto the widest-reach segment. */
export const accessSegmentOf = (
  linkRole: LinkRole,
  workspaceAccess: WorkspaceAccess,
): AccessSegment =>
  linkRole !== "none" ? "anyone" : workspaceAccess === "member" ? "workspace" : "invite"

/**
 * Widening to "Anyone" is the one irreversible-feeling step — a private doc becomes
 * link-reachable. Confirm that jump only; narrowing (and invite ↔ workspace) stay one-click.
 */
export const accessSegmentNeedsConfirm = (from: AccessSegment, to: AccessSegment): boolean =>
  to === "anyone" && from !== "anyone"

/** Toast copy after a segment change lands — names the new reach, not the old. */
export const accessSegmentToast = (segment: AccessSegment): string => {
  if (segment === "anyone") return "Anyone with the link can now open this"
  if (segment === "workspace") return "Everyone in the workspace can now open this"
  return "Only people you've added can open this"
}

/** Segment pick → access triple at the safe defaults the share dialog already used. */
export const draftForAccessSegment = (
  seg: AccessSegment,
  currentLinkRole: LinkRole,
  currentListed: Listed,
): { workspaceAccess: WorkspaceAccess; linkRole: LinkRole; listed: Listed } => {
  if (seg === "invite") return { workspaceAccess: "none", linkRole: "none", listed: "none" }
  if (seg === "workspace")
    return {
      workspaceAccess: "member",
      linkRole: "none",
      listed: currentListed === "workspace" ? "workspace" : "none",
    }
  // anyone: keep the current link role (or default to view), keep a public listing.
  return {
    workspaceAccess: "member",
    linkRole: currentLinkRole === "none" ? "viewer" : currentLinkRole,
    listed: currentListed === "public" ? "public" : "none",
  }
}

/** One decision for a segment click: confirm gate + toast once the write lands. */
export const decideAccessSegmentChange = (
  from: AccessSegment,
  to: AccessSegment,
): { needsConfirm: boolean; toast: string } => ({
  needsConfirm: accessSegmentNeedsConfirm(from, to),
  toast: accessSegmentToast(to),
})
