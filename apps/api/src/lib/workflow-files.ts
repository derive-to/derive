import {
  artifactUserCan,
  type BlobStore,
  type BundleManifest,
  fileInputInventory,
  isBundleContentType,
  type MetaStore,
  roleAllows,
  sha256Hex,
  type WorkflowFileInput,
} from "@derive/core"

/** Selecting a version delegates its use, not its source artifact's sharing settings. */
export async function workflowFilesAvailable(meta: MetaStore, org: string, pin: WorkflowFileInput) {
  const [artifact, member, version] = await Promise.all([
    meta.getArtifactById(pin.artifact_id),
    meta.getMembership(org, pin.granted_by),
    meta.getVersion(pin.artifact_id, pin.version),
  ])
  return (
    !!artifact &&
    artifact.org_id === org &&
    !artifact.removed_at &&
    !artifact.archived_at &&
    !!member &&
    roleAllows(member.role, "publish") &&
    !!version &&
    isBundleContentType(version.content_type) &&
    version.blob_key === pin.blob_key &&
    (await artifactUserCan(meta, pin.granted_by, "share", artifact))
  )
}

export async function workflowFileManifest(blobs: BlobStore, pin: WorkflowFileInput) {
  const bytes = await blobs.get(pin.blob_key)
  if (!bytes || bytes.byteLength > 1_000_000 || (await sha256Hex(bytes)) !== pin.blob_key)
    throw new Error("The uploaded file inventory is unavailable")
  return fileInputInventory(JSON.parse(new TextDecoder().decode(bytes)) as BundleManifest)
}
