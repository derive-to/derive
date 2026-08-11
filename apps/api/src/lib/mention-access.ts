// The standing required to RECEIVE a collaboration mention. Comments, live source,
// the picker, and channel delivery all need the same answer: a public link alone is
// never enough to page somebody, but a workspace seat, direct share, or collection
// grant is. Keeping this in one place prevents one surface from leaking a private
// document title while another correctly withholds it.

import type { ArtifactRecord, MetaStore } from "@derive/core"

type MentionAccessStore = Pick<
  MetaStore,
  | "listMemberships"
  | "listArtifactMembers"
  | "collectionIdsForArtifact"
  | "getCollections"
  | "listCollectionMembers"
>

/**
 * Every real user who could receive a standing-only mention for this artifact.
 * Collection creators are owners even when no explicit collection-member row exists;
 * workspace seats apply only where the artifact or one of its collections is open to
 * the workspace. The optional candidate set keeps a caller's final loop bounded while
 * retaining one canonical access calculation.
 */
export const eligibleMentionRecipientIds = async (
  meta: MentionAccessStore,
  artifact: ArtifactRecord,
  candidates?: Iterable<string>,
): Promise<Set<string>> => {
  const [memberships, directShares, collectionIds] = await Promise.all([
    meta.listMemberships(artifact.org_id),
    meta.listArtifactMembers(artifact.id),
    meta.collectionIdsForArtifact(artifact.id),
  ])
  const workspaceIds = new Set(memberships.map((membership) => membership.user_id))
  const eligible = new Set<string>(directShares.map((share) => share.user_id))
  if (artifact.workspace_access === "member") for (const id of workspaceIds) eligible.add(id)

  const collections = await meta.getCollections(collectionIds)
  for (const collection of collections) {
    eligible.add(collection.created_by)
    if (collection.workspace_access === "member") {
      for (const id of workspaceIds) eligible.add(id)
    }
    for (const member of await meta.listCollectionMembers(collection.id))
      eligible.add(member.user_id)
  }

  if (!candidates) return eligible
  const requested = new Set(candidates)
  return new Set([...eligible].filter((id) => requested.has(id)))
}
