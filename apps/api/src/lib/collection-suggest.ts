// Neighbor voting for the collection picker's semantic "Suggested" tier: the artifacts
// most similar to the one being filed each vote — at their similarity score — for every
// collection they already live in, and the heaviest collections win. Members vote, not
// collection titles, so it works when the collections are named "Misc" and "Inbox".
// Pure; the route owns the reads and every access gate.

/** Rank collections by the summed similarity of the neighbors filed in them. Callers
 *  drop dead neighbors before voting and access-gate the RESULT per collection — this
 *  sees only ids and scores. Ties break by id so equal-scoring collections can't flap
 *  between requests. */
export const voteCollections = (
  neighbors: { id: string; score: number }[],
  collectionsByArtifact: Record<string, string[]>,
  cap: number,
): { id: string; score: number }[] => {
  const votes = new Map<string, number>()
  for (const n of neighbors)
    for (const colId of collectionsByArtifact[n.id] ?? [])
      votes.set(colId, (votes.get(colId) ?? 0) + n.score)
  return [...votes]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(cap, 0))
}
