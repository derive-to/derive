import { type Action, can, maxRole } from "./permissions"
import type { ArtifactRecord, MetaStore } from "./ports"

/** Explicit user standing, never a world link. Shared by human grants and runtime delegation. */
export async function artifactUserCan(
  meta: MetaStore,
  userId: string,
  action: Action,
  artifact: ArtifactRecord,
): Promise<boolean> {
  const [member, direct, collections] = await Promise.all([
    meta.getMembership(artifact.org_id, userId),
    meta.getArtifactMember(artifact.id, userId),
    meta.collectionRolesForArtifact(artifact.id, userId),
  ])
  return can(
    {
      kind: "user",
      userId,
      artifactRole: maxRole(direct?.role ?? null, ...collections),
      orgRole: member?.role ?? null,
    },
    action,
    artifact.workspace_access,
    "none",
  )
}
