import { type DocMap, docMap } from "@derive/core"
import { WeightedLruCache } from "./source-text-cache"

// One isolate-wide structure cache for every artifact path. Publish derivation, changed-part
// receipts, and focused reads all parse the same immutable blob. Keeping separate caches made
// a large edit pay the parser again at each handoff.
const structures = new WeightedLruCache<DocMap>({
  maxBytes: 8 * 1024 * 1024,
  maxEntries: 64,
  maxEntryBytes: 2 * 1024 * 1024,
})

export const documentStructure = (blobKey: string, source: string, contentType: string): DocMap => {
  const key = `${contentType}:${blobKey}`
  const cached = structures.get(key)
  if (cached) return cached
  const structure = docMap(source, contentType)
  const bytes = structure.nodes.reduce(
    (total, node) => total + 192 + (node.title?.length ?? 0) * 2,
    256,
  )
  structures.set(key, structure, bytes)
  return structure
}
