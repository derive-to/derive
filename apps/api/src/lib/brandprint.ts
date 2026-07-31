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
 * rework endpoint all need, each keyed on a different user id. The reads are
 * independent, so they run concurrently. `userId` null ⇒ workspace layer only.
 *
 * A context's runs key on the context's CREATOR, not whoever triggers a given run:
 * the creator's personal toggle governs every session that context spawns,
 * regardless of who reads or fires it.
 */
export const resolveActorBrandprint = async (
  meta: MetaStore,
  orgId: string,
  userId: string | null,
): Promise<ResolvedBrandprint> => {
  const { settings, personalBrandprint } = await meta.orgSettingsAndBrandprint(orgId, userId)
  return resolveBrandprint(settings.brandprint, parseBrandprint(personalBrandprint))
}
