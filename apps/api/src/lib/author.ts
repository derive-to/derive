import type { ArtifactRecord, MetaStore } from "@derive/core"

/** The current author of an artifact as a resolved profile: the denormalized
 *  name/login/avatar plus the Derive `handle` when the committer signed in with GitHub. */
export interface ResolvedAuthor {
  name: string | null
  login: string | null
  avatar: string | null
  handle: string | null
}

/** Fold gh_id → username rows into the handle map `authorProfile` consumes. Pure —
 *  the list route feeds it rows from the batched `listEnrichment` round trip. */
export const handlesFrom = (
  rows: { gh_id: string; username: string | null }[],
): Record<string, string | null> => {
  const out: Record<string, string | null> = {}
  for (const u of rows) out[u.gh_id] = u.username
  return out
}

/** Resolve a set of GitHub numeric user ids to Derive handles (usernames) in ONE batched
 *  query — gh_id → handle, only for committers who signed in with GitHub. Empty set ⇒ {}.
 *  Shared by the artifact detail and the profile work-list so both render the same chip. */
export const resolveHandles = async (
  meta: MetaStore,
  ghIds: string[],
): Promise<Record<string, string | null>> => {
  if (ghIds.length === 0) return {}
  return handlesFrom(await meta.usersByGithubIds(ghIds))
}

/** A byline derived live from a Derive user record: current display name + handle. */
export interface UserByline {
  name: string | null
  handle: string | null
}

/** Fold live user-directory rows into the byline map (name self-heals from the
 *  current record — see `resolveUserBylines`). Pure — the list route feeds it rows
 *  from the batched `listEnrichment` round trip. */
export const bylinesFrom = (
  rows: { id: string; name: string | null; username: string | null }[],
): Record<string, UserByline> => {
  const out: Record<string, UserByline> = {}
  for (const u of rows)
    out[u.id] = { name: u.name ?? u.username ?? null, handle: u.username ?? null }
  return out
}

/** Resolve a set of Derive user ids (a version's / artifact's `author_id`) to their CURRENT
 *  name + handle, in ONE batched query. The stored `author` string is only a denormalized
 *  cache: bylines are derived from the live user record, so an old row frozen with an agent-
 *  client name ("Derive CLI", "Claude") self-heals on read, and a rename is reflected too —
 *  no migration. Empty set ⇒ {}. */
export const resolveUserBylines = async (
  meta: MetaStore,
  userIds: string[],
): Promise<Record<string, UserByline>> => {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return {}
  return bylinesFrom(await meta.getUsers(ids))
}

/** The artifact's current author as a resolved profile; null when it has no author at all.
 *  A publish-by-hand carries the Derive user in `author_id`, so prefer that user's live
 *  byline over the denormalized `author_name` (which self-heals a stale agent-client name).
 *  Historical imports without an `author_id` fall through to their stored author identity. */
export const authorProfile = (
  a: ArtifactRecord,
  handleByGhId: Record<string, string | null>,
  bylineByUserId: Record<string, UserByline> = {},
): ResolvedAuthor | null => {
  const byUser = a.author_id ? bylineByUserId[a.author_id] : undefined
  if (byUser?.name)
    return {
      name: byUser.name,
      login: a.author_login,
      avatar: a.author_avatar,
      handle: byUser.handle,
    }
  if (!a.author_name && !a.author_login && !a.author_gh_id) return null
  return {
    name: a.author_name,
    login: a.author_login,
    avatar: a.author_avatar,
    handle: a.author_gh_id ? (handleByGhId[a.author_gh_id] ?? null) : null,
  }
}
