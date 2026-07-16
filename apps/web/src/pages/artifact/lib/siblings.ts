// Which collection provides the "sibling" context for the artifact view's breadcrumb
// switcher, and where prev/next point within it. Pure so the resolution rules are
// pinned by a test rather than tangled into the component.

/** Resolve the collection whose artifacts the switcher pages through. Deterministic:
 *  the `?collection=` param wins — but only if the artifact is actually a member (a
 *  stale link that points at a collection it left must not lie); otherwise the sole
 *  collection it belongs to; otherwise null (a 0- or ambiguously-multi-collection
 *  artifact shows just its title, no switcher). */
export function resolveContextCollection(
  paramCollection: string | undefined,
  artifactCollections: string[] | undefined,
): string | null {
  const cols = artifactCollections ?? []
  if (paramCollection && cols.includes(paramCollection)) return paramCollection
  if (cols.length === 1) return cols[0] ?? null
  return null
}

/** The current artifact's position among its ordered siblings, plus the clamped
 *  prev/next targets — null at the ends, so the switcher disables rather than wraps.
 *  `index` is -1 when the current id isn't in the list (siblings still loading, or the
 *  artifact dropped out of the collection), in which case there's no prev/next. */
export function siblingNav(
  siblingIds: string[],
  currentId: string,
): { index: number; total: number; prev: string | null; next: string | null } {
  const index = siblingIds.indexOf(currentId)
  return {
    index,
    total: siblingIds.length,
    prev: index > 0 ? (siblingIds[index - 1] ?? null) : null,
    next: index >= 0 && index < siblingIds.length - 1 ? (siblingIds[index + 1] ?? null) : null,
  }
}
