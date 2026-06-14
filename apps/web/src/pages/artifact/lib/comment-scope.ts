import { createContext, useContext } from "react"

/**
 * The artifact a comment composer belongs to, provided once by ArtifactComments
 * and read deep down by MentionField — so the @mention picker can scope its
 * directory to this thread's people without threading a prop through every
 * panel/card/composer in between. null when composing outside any artifact.
 */
const CommentScopeContext = createContext<{ shortId: string | null }>({ shortId: null })

export const CommentScopeProvider = CommentScopeContext.Provider
export const useCommentScope = () => useContext(CommentScopeContext)
