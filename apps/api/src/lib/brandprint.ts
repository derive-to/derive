import {
  type MetaStore,
  parseBrandprint,
  type ResolvedBrandprint,
  resolveBrandprint,
} from "@derive/core"

/**
 * Resolve the effective Brandprint for an actor in a workspace: the workspace's
 * conventions merged with the actor's personal layer (profile wins). One home for
 * the org-context read + merge the MCP connection, the context runner, and the
 * rework endpoint all need, each keyed on a different user id. `userId` null ⇒
 * workspace layer only (orgContext skips the personal read entirely).
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
  const { settings, personalBrandprint } = await meta.orgContext(orgId, userId)
  return resolveBrandprintContext({ settings, personalBrandprint })
}

/** Merge Brandprint inputs that another trusted read already loaded. */
export const resolveBrandprintContext = ({
  settings,
  personalBrandprint,
}: Awaited<ReturnType<MetaStore["orgContext"]>>): ResolvedBrandprint =>
  resolveBrandprint(settings.brandprint, parseBrandprint(personalBrandprint))
