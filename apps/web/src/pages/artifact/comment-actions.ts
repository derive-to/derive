import { createContext, useContext } from "react"

// Rich comment actions (reactions, edit, delete, copy-link) threaded through one
// context so the deep card tree doesn't re-pass them at every level.
export type CommentActions = {
  /** The viewer's user id — ownership is decided by it, as the server does (`ownsComment`);
   *  the name is the fallback for rows written before comments kept an author id. */
  meId: string
  meName: string
  react: (commentId: string, emoji: string) => void
  edit: (commentId: string, body: string) => Promise<void> | void
  remove: (commentId: string) => void
  copyLink: (threadId: string) => void
}

const NOOP_ACTIONS: CommentActions = {
  meId: "",
  meName: "",
  react: () => {},
  edit: () => {},
  remove: () => {},
  copyLink: () => {},
}

export const ActionsCtx = createContext<CommentActions | null>(null)
export const useActions = (): CommentActions => useContext(ActionsCtx) ?? NOOP_ACTIONS
