import type { Brandprint } from "@/api"

/**
 * Merge a patch into the caller's current personal Brandprint. `api.setProfile`
 * persists `brandprint` as a whole-object replace (see api.ts / the server route),
 * with no server-side merge, so every save must start from what's already there, or
 * a field the caller isn't touching (the collection pointer, the workspace toggle)
 * silently disappears. Collapses to `null` only when the merged result has nothing
 * left worth saving: no collection, and the workspace toggle isn't explicitly off.
 * Pure so the merge is unit-tested; callers supply the live `me.brandprint` and the
 * one field they're changing.
 */
export function nextPersonalBrandprint(
  current: Brandprint | null | undefined,
  patch: Partial<Brandprint>,
): Brandprint | null {
  const next = { ...current, ...patch }
  return next.collectionId || next.useWorkspaceBrandprint === false ? next : null
}
