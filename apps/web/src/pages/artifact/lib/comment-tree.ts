import { createContext, useContext } from "react"
import type { Comment, Mention } from "@/api"

/**
 * The comment-tree interaction context — the active/hover/anchored STATE and the
 * per-thread HANDLERS every comment card needs, provided once by ArtifactComments and
 * read directly by CommentCard (and by PinnedZone for its layout math). Before this,
 * these eight values were prop-drilled unchanged through OpenPanel → PinnedZone /
 * CollapsibleThreadSection / MobileComments to reach each card; the intermediate layers
 * now forward nothing. Cards self-compute `active`/`hovered`/`present` from the state
 * here, so a card render site is just `<CommentCard thread={t} />`.
 */
export interface CommentTree {
  /** The thread currently expanded (its card shows the full thread + reply box). */
  activeThread: string | null
  /** The thread whose card is hovered (two-way emphasis with the doc highlight). */
  hoverThread: string | null
  /** Which anchor ids the frame reports resolving live — a card reads its own
   *  `present` from this (absent ⇒ falls back to the server's `anchored` flag). */
  inDoc: Record<string, boolean>
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
}

// Non-null default so a card outside a provider fails loudly in dev rather than
// silently no-op'ing (there is no valid comment card without the tree context).
const CommentTreeContext = createContext<CommentTree | null>(null)

export const CommentTreeProvider = CommentTreeContext.Provider

export function useCommentTree(): CommentTree {
  const ctx = useContext(CommentTreeContext)
  if (!ctx) throw new Error("useCommentTree must be used within a CommentTreeProvider")
  return ctx
}
