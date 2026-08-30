import {
  type BlobStore,
  type DocMap,
  encodePreparedVersion,
  type MetaStore,
  type PreparedVersion,
  prepareVersion,
  type VersionRecord,
} from "@derive/core"

export type PreparedReadMode = "off" | "shadow" | "read"

/** Runtime entrypoints default to read. Direct embedders and tests stay off unless configured. */
export const parsePreparedReadMode = (value: string | undefined): PreparedReadMode => {
  const mode = value?.trim() || "read"
  if (mode === "off" || mode === "shadow" || mode === "read") return mode
  throw new Error(`invalid DERIVE_PREPARED_READS: ${value} (expected off, shadow, or read)`)
}

export interface PersistedPreparedVersion {
  prepared: PreparedVersion
  key: string
  bytes: number
  attached: boolean
}

/** Persist derived structure, then fence its pointer against the exact source version. */
export const persistPreparedVersion = async (
  meta: Pick<MetaStore, "setVersionPrepared">,
  blobs: BlobStore,
  version: VersionRecord,
  source: string,
  structure: DocMap,
): Promise<PersistedPreparedVersion | null> => {
  const prepared = prepareVersion(version.blob_key, source, version.content_type, structure)
  if (!prepared) return null
  const bytes = encodePreparedVersion(prepared)
  if (!bytes) return null
  const key = await blobs.put(bytes)
  const attached = await meta.setVersionPrepared(
    version.artifact_id,
    version.n,
    version.blob_key,
    key,
  )
  return { prepared, key, bytes: bytes.byteLength, attached }
}
