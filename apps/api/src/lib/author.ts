import type { ArtifactRecord, MetaStore } from "@derive/core"

/** The current author of an artifact as a resolved profile: the denormalized
 *  name/login/avatar plus the Derive `handle` when the committer signed in with GitHub. */
export interface ResolvedAuthor {
  name: string | null
  login: string | null
  avatar: string | null
  handle: string | null
}

/** Resolve a set of GitHub numeric user ids to Derive handles (usernames) in ONE batched
 *  query — gh_id → handle, only for committers who signed in with GitHub. Empty set ⇒ {}.
 *  Shared by the artifact list and the profile work-list so both render the same chip. */
export const resolveHandles = async (
  meta: MetaStore,
  ghIds: string[],
): Promise<Record<string, string | null>> => {
  const out: Record<string, string | null> = {}
  if (ghIds.length === 0) return out
  for (const u of await meta.usersByGithubIds(ghIds)) out[u.gh_id] = u.username
  return out
}

/** The artifact's current author as a resolved profile; null when it has no author at all. */
export const authorProfile = (
  a: ArtifactRecord,
  handleByGhId: Record<string, string | null>,
): ResolvedAuthor | null => {
  if (!a.author_name && !a.author_login && !a.author_gh_id) return null
  return {
    name: a.author_name,
    login: a.author_login,
    avatar: a.author_avatar,
    handle: a.author_gh_id ? (handleByGhId[a.author_gh_id] ?? null) : null,
  }
}
