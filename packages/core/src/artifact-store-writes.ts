import { type ArtifactStore, HttpError, type VersionRow } from "@aniraga/open-artifact-server/kit"
import { versionRowOf } from "./artifact-store-records"
import { slugify } from "./ids"
import type { ArtifactRecord, MetaStore, NewArtifact, NewVersion, VersionRecord } from "./ports"

export interface NativePublication {
  version: NewVersion
  create?: NewArtifact
  capture?: (saved: { artifact?: ArtifactRecord; version: VersionRecord }) => void
}

type Writes = Pick<
  ArtifactStore,
  | "createArtifact"
  | "addVersion"
  | "appendVersion"
  | "replaceVersion"
  | "renameArtifact"
  | "deleteArtifact"
>

/** The host prepares access, formats, attribution, and quotas before it calls the kit. */
export const artifactStoreWrites = (meta: MetaStore, input?: NativePublication): Writes => {
  const version = (row: VersionRow): NewVersion => {
    if (!input) throw new HttpError(400, "Use this host's publication flow.")
    if (row.contentHash !== input.version.blob_key)
      throw new Error("Prepared artifact source hash changed")
    return {
      ...input.version,
      blob_key: row.contentHash,
      content_type: row.source?.contentType ?? "text/html",
    }
  }
  const capture = (saved: VersionRecord | null) => {
    if (!saved) return null
    input?.capture?.({ version: saved })
    return versionRowOf(saved)
  }
  return {
    createArtifact: async (row, first) => {
      if (!input?.create) throw new HttpError(400, "Use this host's artifact creation flow.")
      if (input.create.id !== row.id || input.create.org_id !== row.space)
        throw new Error("Prepared artifact identity changed")
      const saved = await meta.createPublishedArtifact(input.create, version(first))
      input.capture?.(saved)
    },
    addVersion: async (row, expected) =>
      capture(await meta.addVersionIfCurrent(row.artifactId, expected, version(row))),
    appendVersion: async (row) => {
      const saved = await meta.addVersion(row.artifactId, version(row))
      input?.capture?.({ version: saved })
      return versionRowOf(saved)
    },
    replaceVersion: async (row, expectedHash) =>
      capture(
        await meta.replaceCurrentVersion(
          row.artifactId,
          { n: row.n, blobKey: expectedHash },
          version(row),
        ),
      ),
    renameArtifact: async (id, title) => {
      if (!(await meta.getArtifactById(id))) return false
      await meta.setArtifactTitle(id, title, slugify(title) || null)
      return true
    },
    deleteArtifact: async (id) => {
      const row = await meta.getArtifactById(id)
      if (!row) return false
      await meta.deleteArtifact(id, row.org_id)
      return true
    },
  }
}
