import {
  type ArtifactRow,
  createEvents,
  createSourcePublication,
  type PublicationStore,
  type VersionRow,
} from "@aniraga/open-artifact-server/source"
import type {
  ArtifactRecord,
  BlobStore,
  MetaStore,
  NewArtifact,
  NewVersion,
  VersionRecord,
} from "./ports"

type Target =
  | { create: NewArtifact }
  | { artifact: ArtifactRecord; expected?: number; replacement?: { n: number; blobKey: string } }

const actorOf = (version: NewVersion) => ({
  id: version.author_id ?? version.agent_id ?? "anonymous",
  name: version.author,
})

const versionOf = (version: VersionRecord): VersionRow => ({
  artifactId: version.artifact_id,
  n: version.n,
  contentHash: version.blob_key,
  size: version.size_bytes,
  csp: {},
  createdAt: version.created_at,
  createdBy: actorOf(version),
  source: { contentType: version.content_type },
})

/** Publication uses this identity. Native rows retain Derive's complete bylines and access. */
const artifactOf = (artifact: ArtifactRecord): ArtifactRow => {
  const actor = { id: artifact.author_id ?? "anonymous", name: artifact.author_name ?? "anonymous" }
  return {
    id: artifact.id,
    space: artifact.org_id,
    title: artifact.title ?? "",
    currentVersion: artifact.current_version,
    createdAt: artifact.created_at,
    updatedAt: artifact.updated_at ?? artifact.created_at,
    createdBy: actor,
    updatedBy: actor,
    summary: "",
    kind: artifact.current_content_type === "text/x-derive-deck" ? "slides" : "page",
  }
}

/** Existing schema and native atomic writes adapt to the shared publication kernel. */
export const publishArtifactSource = async (
  meta: MetaStore,
  blobs: BlobStore,
  input: { bytes: Uint8Array; version: NewVersion; target: Target },
): Promise<{ artifact: ArtifactRecord; version: VersionRecord }> => {
  let writtenArtifact: ArtifactRecord | undefined
  let writtenVersion: VersionRecord | undefined
  const newVersion = (row: VersionRow): NewVersion => ({
    ...input.version,
    blob_key: row.contentHash,
    content_type: row.source?.contentType ?? "text/html",
  })
  const capture = (version: VersionRecord): VersionRow => {
    writtenVersion = version
    return versionOf(version)
  }
  const store: PublicationStore = {
    createArtifact: async (_artifact, first) => {
      if (!("create" in input.target)) throw new Error("Publication is missing its creation input")
      const saved = await meta.createPublishedArtifact(input.target.create, newVersion(first))
      writtenArtifact = saved.artifact
      writtenVersion = saved.version
    },
    addVersion: async (row, expected) => {
      const saved = await meta.addVersionIfCurrent(row.artifactId, expected, newVersion(row))
      return saved ? capture(saved) : null
    },
    appendVersion: async (row) => capture(await meta.addVersion(row.artifactId, newVersion(row))),
    replaceVersion: async (row, expectedHash) => {
      const saved = await meta.replaceCurrentVersion(
        row.artifactId,
        { n: row.n, blobKey: expectedHash },
        newVersion(row),
      )
      return saved ? capture(saved) : null
    },
  }
  const publication = createSourcePublication(
    {
      store,
      blobs: {
        put: async (key) => {
          // Classification already stores the original file or manifest. Refuse a mismatch.
          if (key !== input.version.blob_key)
            throw new Error("Prepared artifact source hash changed")
        },
        get: async (key) => {
          const bytes = await blobs.get(key)
          return bytes ? { bytes: Uint8Array.from(bytes), type: input.version.content_type } : null
        },
      },
    },
    createEvents(),
  )
  const source = {
    bytes: Uint8Array.from(input.bytes),
    contentType: input.version.content_type,
    csp: {},
  }
  const facts = {
    summary: "",
    kind:
      input.version.content_type === "text/x-derive-deck" ? ("slides" as const) : ("page" as const),
  }
  if ("create" in input.target) {
    await publication.createSource(actorOf(input.version), {
      ...source,
      id: input.target.create.id,
      title: input.target.create.title ?? "",
      space: input.target.create.org_id,
      facts,
    })
  } else {
    const target = input.target
    await publication.publishSource(actorOf(input.version), artifactOf(target.artifact), {
      ...source,
      facts,
      expected: target.expected,
      replaceCurrent: target.replacement
        ? { n: target.replacement.n, contentHash: target.replacement.blobKey }
        : undefined,
    })
    writtenArtifact = target.artifact
  }
  if (!writtenArtifact || !writtenVersion) throw new Error("Artifact publication did not commit")
  return { artifact: writtenArtifact, version: writtenVersion }
}
