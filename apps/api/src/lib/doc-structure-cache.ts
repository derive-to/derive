import {
  type DocMap,
  docMap,
  type PreparedVersion,
  preparedMap,
  type VersionRecord,
} from "@derive/core"
import { WeightedLruCache } from "./source-text-cache"

// One isolate-wide structure cache for every artifact path. Publish derivation, changed-part
// receipts, and focused reads all parse the same immutable blob. Keeping separate caches made
// a large edit pay the parser again at each handoff.
type StructureEntry = { map: DocMap; prepared?: PreparedVersion; preparedKey?: string }

const structures = new WeightedLruCache<StructureEntry>({
  maxBytes: 8 * 1024 * 1024,
  maxEntries: 64,
  maxEntryBytes: 2 * 1024 * 1024,
})

export const documentStructure = (blobKey: string, source: string, contentType: string): DocMap => {
  const key = `${contentType}:${blobKey}`
  const cached = structures.get(key)
  if (cached) return cached.map
  const structure = docMap(source, contentType)
  const bytes = structure.nodes.reduce(
    (total, node) => total + 192 + (node.title?.length ?? 0) * 2,
    256,
  )
  structures.set(key, { map: structure }, bytes)
  return structure
}

export const cachedPreparedVersion = (version: VersionRecord): PreparedVersion | undefined => {
  const cached = structures.get(`${version.content_type}:${version.blob_key}`)
  return cached?.preparedKey === version.prepared_key ? cached.prepared : undefined
}

export const cachePreparedVersion = (
  prepared: PreparedVersion,
  preparedKey: string,
  bytes: number,
): void => {
  const map = preparedMap(prepared)
  const mapBytes = prepared.nodes.reduce(
    (total, node) => total + 224 + (node.title?.length ?? 0) * 2,
    320,
  )
  structures.set(
    `${prepared.contentType}:${prepared.sourceKey}`,
    { map, prepared, preparedKey },
    Math.max(bytes, mapBytes),
  )
}
