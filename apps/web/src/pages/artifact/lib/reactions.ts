import type { Comment } from "@/api"

export const REACTION_EMOJI = ["👍", "❤️", "🎉", "😄", "👀", "🙏", "🚀", "👎"]

// Optimistic local toggle that mirrors the server's react logic.
export function toggleReaction(c: Comment, emoji: string, who: string): Comment {
  const reactions: Record<string, string[]> = { ...(c.reactions ?? {}) }
  const arr = [...(reactions[emoji] ?? [])]
  const i = arr.indexOf(who)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(who)
  if (arr.length) reactions[emoji] = arr
  else delete reactions[emoji]
  return { ...c, reactions }
}
