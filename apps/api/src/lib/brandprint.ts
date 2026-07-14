import {
  type MetaStore,
  parseBrandprint,
  type ResolvedBrandprint,
  resolveBrandprint,
} from "@derive/core"

/**
 * Resolve the effective Brandprint for an actor in a workspace: the workspace's
 * conventions merged with the actor's personal layer (profile wins). One home for
 * the two-read + merge sequence the MCP connection, the context runner, and the
 * rework endpoint all need — keyed on a different user id at each site, which is
 * exactly the axis the hand-rolled copies had started to drift on. The reads are
 * independent, so they run concurrently. `userId` null ⇒ workspace layer only.
 */
export const resolveActorBrandprint = async (
  meta: MetaStore,
  orgId: string,
  userId: string | null,
): Promise<ResolvedBrandprint> => {
  const [settings, personal] = await Promise.all([
    meta.getOrgSettings(orgId),
    userId ? meta.getUserBrandprint(userId) : null,
  ])
  return resolveBrandprint(settings.brandprint, parseBrandprint(personal))
}
