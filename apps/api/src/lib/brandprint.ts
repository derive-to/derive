import {
  type MetaStore,
  parseBrandprint,
  type ResolvedBrandprint,
  resolveBrandprint,
} from "@derive/core"

/**
 * Resolve the effective Brandprint for an actor in a workspace: the workspace's
 * conventions merged with the actor's personal layer (profile wins). One home for
 * the org-context read + merge the MCP connection and the rework endpoint both need,
 * each keyed on a different user id. `userId` null ⇒ workspace layer only
 * (orgContext skips the personal read entirely).
 */
export const resolveActorBrandprint = async (
  meta: MetaStore,
  orgId: string,
  userId: string | null,
): Promise<ResolvedBrandprint> => {
  const { settings, personalBrandprint } = await meta.orgContext(orgId, userId)
  return resolveBrandprintContext({ settings, personalBrandprint })
}

/** Merge Brandprint inputs that another trusted read already loaded. */
export const resolveBrandprintContext = ({
  settings,
  personalBrandprint,
}: Awaited<ReturnType<MetaStore["orgContext"]>>): ResolvedBrandprint =>
  resolveBrandprint(settings.brandprint, parseBrandprint(personalBrandprint))
