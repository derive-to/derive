// THE visibility gate for any surface that reaches artifacts by something OTHER than
// their own id: workspace search reaches them through a relevance index, cross-artifact
// slot reads reach them through a metric name. Both start from an oracle that knows
// nothing about access, so both must re-resolve what they found against the caller's
// actual reach before returning a single row.
//
// It lives here, alone, because the second copy is how these drift: a fix applied to
// search that never reaches the slot reader is indistinguishable from no fix at all.

import type { ArtifactRecord, MetaStore } from "@derive/core"

/** Ids per listArtifacts call. D1 binds each id as a parameter and caps a statement at
 *  100, so stay under it with room for the other bound values. */
export const LIST_ID_CHUNK = 90

export interface VisibilityOpts {
  orgId: string
  /** The human the caller acts for (an agent's registrant), or the agent itself. Absent
   *  means an anonymous caller, who sees only what is public. */
  viewerId?: string
  publicOnly?: boolean
}

/**
 * Narrow a set of candidate artifact ids to the ones this caller may actually read.
 *
 * Re-resolves every candidate through `listArtifacts` with the caller's own
 * orgId/viewerId/publicOnly, PLUS `excludeRemoved` (the search index and the slot tables
 * both outlive a takedown, and listArtifacts keeps tombstones for the feed, so a caller
 * that skipped this would make a moderated artifact readable again). An id survives only
 * if that call returns it, so an oracle with no access knowledge can never widen what a
 * caller sees.
 *
 * A password lock suspends the WORLD LINK until unlocked (`effectiveRole` in
 * permissions.ts), so a locked artifact is readable only through a non-link grant: a
 * workspace SEAT, or an explicit share. listArtifacts is the LISTING gate, not the read
 * gate, so a {listed:"public", workspace_access:"none", link_role:"viewer", password:…}
 * doc lists to a member who can still only open it through the locked link. Keep a locked
 * artifact only when the caller's SEAT grants read. Anonymous and link-only callers, and
 * the rare member reachable solely by an explicit share on a locked workspace_access:"none"
 * doc, are dropped: a safe recall loss, never a leak. (A per-candidate
 * `authorize(c,"read",a)` would also honor explicit shares and unlock cookies, but the MCP
 * entry point has no request Context to build that actor from, so this seat-only predicate
 * is the uniform floor every caller here shares.)
 *
 * Returns the surviving records in listArtifacts' own order; callers that had a ranking
 * restore it themselves.
 */
export const visibleArtifacts = async (
  meta: Pick<MetaStore, "listArtifacts">,
  ids: string[],
  opts: VisibilityOpts,
): Promise<ArtifactRecord[]> => {
  const visible: ArtifactRecord[] = []
  for (let i = 0; i < ids.length; i += LIST_ID_CHUNK) {
    const rows = await meta.listArtifacts({
      orgId: opts.orgId,
      viewerId: opts.viewerId,
      publicOnly: opts.publicOnly,
      excludeRemoved: true,
      ids: ids.slice(i, i + LIST_ID_CHUNK),
    })
    visible.push(...rows)
  }
  return visible.filter(
    (a) => !a.password_hash || (!opts.publicOnly && a.workspace_access === "member"),
  )
}

/** The same gate as a set of surviving ids, for callers holding rows rather than records. */
export const visibleArtifactIds = async (
  meta: Pick<MetaStore, "listArtifacts">,
  ids: string[],
  opts: VisibilityOpts,
): Promise<Set<string>> => new Set((await visibleArtifacts(meta, ids, opts)).map((a) => a.id))
