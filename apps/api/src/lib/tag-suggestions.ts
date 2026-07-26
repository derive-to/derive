import type { ArtifactRecord, MetaStore, SearchIndex, VersionRecord } from "@derive/core"

// Tag suggestions for an artifact — the discover half of "auto-tag", shared by the HTTP
// route (GET /v1/artifacts/{shortId}/tag-suggestions) and the MCP `organize` tool so
// the two never drift. It answers "what should this be tagged?" the way a librarian would:
// look at what similar things are already tagged, and reuse that vocabulary.

export interface TagSuggestions {
  /** Tags already on the artifact. */
  current: string[]
  /** Tags carried by the most semantically-similar artifacts, most-shared first, with the
   *  artifact's current tags removed. Empty when no dense arm is configured. */
  suggested: { tag: string; count: number }[]
  /** Every tag in the workspace with its usage count, most-used first (capped). Lets a
   *  caller reuse an existing tag instead of minting a near-duplicate. */
  vocabulary: { tag: string; count: number }[]
}

// How many neighbors to pull, how many suggestions/vocabulary entries to return, and how
// much of the doc to embed as the neighbor query.
const NEIGHBORS = 20
const MAX_SUGGESTED = 12
const MAX_VOCAB = 100
const QUERY_CHARS = 4000

type SuggestDeps = {
  meta: Pick<MetaStore, "tagCounts" | "tagsForArtifacts" | "getVersion" | "listArtifacts">
  /** The optional dense/semantic arm; absent ⇒ vocabulary-only suggestions. */
  search?: SearchIndex
  sourceText: (content: { blob_key: string; content_type: string }) => Promise<string | null>
}

export async function computeTagSuggestions(
  deps: SuggestDeps,
  artifact: ArtifactRecord,
  viewerId: string | undefined,
): Promise<TagSuggestions> {
  const { meta, search, sourceText } = deps
  const org = artifact.org_id
  const [vocab, currentMap] = await Promise.all([
    meta.tagCounts(org),
    meta.tagsForArtifacts([artifact.id]),
  ])
  const current = currentMap[artifact.id] ?? []
  const currentSet = new Set(current)

  let suggested: { tag: string; count: number }[] = []
  // The dense store already holds this artifact, so querying it with the doc's own title +
  // text returns its nearest neighbors. Best-effort: a slow/absent embedder must never
  // fail the call — it just yields no neighbor suggestions.
  if (search) {
    try {
      const ver: VersionRecord | null = await meta.getVersion(artifact.id, artifact.current_version)
      const body = ver ? ((await sourceText(ver)) ?? "") : ""
      const query = `${artifact.title ?? ""}\n${body}`.slice(0, QUERY_CHARS).trim()
      if (query) {
        const hits = await search.search(org, query, NEIGHBORS)
        const neighborIds = hits.map((h) => h.id).filter((id) => id !== artifact.id)
        if (neighborIds.length) {
          // search.search applies NO visibility filter (per SearchIndex), so re-apply it
          // through listArtifacts({ ids, viewerId }) before reading anyone's tags.
          const visible = await meta.listArtifacts({
            orgId: org,
            viewerId,
            ids: neighborIds,
            excludeRemoved: true,
          })
          const tagMap = await meta.tagsForArtifacts(visible.map((a) => a.id))
          const counts = new Map<string, number>()
          for (const a of visible) {
            for (const t of tagMap[a.id] ?? []) {
              if (currentSet.has(t) || t.startsWith("sift-")) continue
              counts.set(t, (counts.get(t) ?? 0) + 1)
            }
          }
          suggested = [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
            .slice(0, MAX_SUGGESTED)
        }
      }
    } catch {
      // Dense-arm hiccup — vocabulary-only is still a useful answer.
    }
  }

  return {
    current,
    suggested,
    vocabulary: vocab
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, MAX_VOCAB),
  }
}
