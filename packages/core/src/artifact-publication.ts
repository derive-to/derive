import { createEvents, createSourcePublication } from "@aniraga/open-artifact-server/source"
import { createArtifactStore } from "./artifact-store"
import { artifactRowOf, publicationActor } from "./artifact-store-records"
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

/** Existing schema and native atomic writes adapt to the shared publication kernel. */
export const publishArtifactSource = async (
  meta: MetaStore,
  blobs: BlobStore,
  input: { bytes: Uint8Array; version: NewVersion; target: Target },
): Promise<{ artifact: ArtifactRecord; version: VersionRecord }> => {
  let writtenArtifact: ArtifactRecord | undefined
  let writtenVersion: VersionRecord | undefined
  const store = createArtifactStore(meta, {
    publication: {
      version: input.version,
      ...("create" in input.target ? { create: input.target.create } : {}),
      capture: (saved) => {
        if (saved.artifact) writtenArtifact = saved.artifact
        writtenVersion = saved.version
      },
    },
  })
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
    await publication.createSource(publicationActor(input.version), {
      ...source,
      id: input.target.create.id,
      title: input.target.create.title ?? "",
      space: input.target.create.org_id,
      facts,
    })
  } else {
    const target = input.target
    await publication.publishSource(
      publicationActor(input.version),
      artifactRowOf(target.artifact),
      {
        ...source,
        facts,
        expected: target.expected,
        replaceCurrent: target.replacement
          ? { n: target.replacement.n, contentHash: target.replacement.blobKey }
          : undefined,
      },
    )
    writtenArtifact = target.artifact
  }
  if (!writtenArtifact || !writtenVersion) throw new Error("Artifact publication did not commit")
  return { artifact: writtenArtifact, version: writtenVersion }
}
