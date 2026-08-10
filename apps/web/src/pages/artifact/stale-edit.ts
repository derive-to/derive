// Concurrent-publish awareness while a user is mid-edit.
//
// A live version.published event used to fire an 8s toast and then vanish — glance
// away and the document has moved under you with no signal left. This state is the
// durable latch: set while either edit surface is open, bump as further publishes
// land, clear only when the edit ends. The toast is gone; the chip is the truth.

/** The version that landed under an active edit, or null when the session is current.
 *  `0` is the sentinel for "a new version" whose number the SSE didn't carry. */
export type StaleEditState = number | null

/**
 * Latch a live publish against an edit session.
 * - Not editing → ignored (prev unchanged).
 * - Editing → take the newest concrete version; an unnumbered publish latches as 0
 *   only when nothing concrete is already held.
 */
export const noteStalePublish = (
  prev: StaleEditState,
  editing: boolean,
  version?: number,
): StaleEditState => {
  if (!editing) return prev
  if (version === undefined) return prev ?? 0
  if (prev === null || prev === 0) return version
  return Math.max(prev, version)
}

/** Edit ended (save / discard / cancel) — drop the latch. */
export const clearStaleEdit = (): StaleEditState => null

/** Chip copy for the active surface, or null when nothing is stale. */
export const staleEditCopy = (
  stale: StaleEditState,
  surface: "inline" | "source",
): string | null => {
  if (stale === null) return null
  const v = stale > 0 ? `v${stale}` : "A new version"
  if (surface === "source") {
    return `${v} was published while you've been editing — publishing this edit will replace it.`
  }
  return `${v} was published while you've been editing — saving re-checks your edits against it.`
}
