import type { ArtifactRow, VersionRow } from "@aniraga/open-artifact-server/source"
import type { ArtifactRecord, NewVersion, VersionRecord } from "./ports"

export const publicationActor = (version: NewVersion) => ({
  id: version.author_id ?? version.agent_id ?? "anonymous",
  name: version.author,
})

/** Native bylines and publication fields stay attached to their immutable source version. */
export const versionRowOf = (version: VersionRecord): VersionRow => ({
  artifactId: version.artifact_id,
  n: version.n,
  contentHash: version.blob_key,
  size: version.size_bytes,
  csp: {},
  createdAt: version.created_at,
  createdBy: publicationActor(version),
  source: {
    contentType: version.content_type,
    metadata: {
      id: version.id,
      author_id: version.author_id,
      author_login: version.author_login,
      author_avatar: version.author_avatar,
      author_gh_id: version.author_gh_id,
      agent_id: version.agent_id,
      agent_name: version.agent_name,
      source: version.source,
      message: version.message,
      name: version.name,
      edit_session: version.edit_session,
    },
  },
})

/** Listing reads supply the first and current versions in batches. */
export const artifactRowOf = (
  artifact: ArtifactRecord,
  versions?: { first?: VersionRecord; current?: VersionRecord },
): ArtifactRow => {
  const latest = {
    id: artifact.author_id ?? "anonymous",
    name: artifact.author_name ?? "anonymous",
  }
  return {
    id: artifact.id,
    space: artifact.org_id,
    title: artifact.title ?? "",
    currentVersion: artifact.current_version,
    createdAt: artifact.created_at,
    updatedAt: artifact.updated_at ?? artifact.created_at,
    createdBy: versions?.first ? publicationActor(versions.first) : latest,
    updatedBy: versions?.current ? publicationActor(versions.current) : latest,
    summary: versions?.current?.summary ?? "",
    kind: artifact.current_content_type === "text/x-derive-deck" ? "slides" : "page",
  }
}
