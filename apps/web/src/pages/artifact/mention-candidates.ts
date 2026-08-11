import { api, type DirUser } from "@/api"
import { isValidUsername } from "@/lib/username"

export const MENTION_CANDIDATE_LIMIT = 6

export type MentionableUser = DirUser & { handle: string }

/** One filter for every document-editor mention surface. Agents keep their canonical
 * comment/thread path until a live body mention has somewhere safe to reply. */
export const isMentionableUser = (user: DirUser): user is MentionableUser =>
  user.kind !== "agent" && isValidUsername(user.handle)

/** Authenticated directory read without a presentation limit (used to resolve reader chips). */
export const mentionDirectory = async (
  query: string,
  shortId?: string,
): Promise<MentionableUser[]> => {
  const { users } = await api.users(query, shortId)
  return users.filter(isMentionableUser)
}

/** Picker-sized result set shared by source and rendered-document editing. */
export const mentionCandidates = async (
  query: string,
  shortId?: string,
): Promise<MentionableUser[]> =>
  (await mentionDirectory(query, shortId)).slice(0, MENTION_CANDIDATE_LIMIT)
