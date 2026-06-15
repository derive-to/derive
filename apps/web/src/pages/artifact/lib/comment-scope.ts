import { createContext, useContext } from "react"

/**
 * Comment-tree scope, provided once by ArtifactComments and read deep down without
 * threading props through every panel/card/composer:
 *  - `shortId`: the artifact, so MentionField scopes its @mention directory to this
 *    thread's people (null when composing outside any artifact).
 *  - `canComment`: may the caller create comments/replies here? Gates every write
 *    affordance (new-comment buttons, reply boxes). Reading is unaffected. The API is
 *    the hard gate; this keeps the UI from offering a comment action that would 403.
 *    Defaults true so non-artifact consumers are unaffected.
 */
const CommentScopeContext = createContext<{ shortId: string | null; canComment: boolean }>({
  shortId: null,
  canComment: true,
})

export const CommentScopeProvider = CommentScopeContext.Provider
export const useCommentScope = () => useContext(CommentScopeContext)
