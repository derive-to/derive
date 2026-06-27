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
const CommentScopeContext = createContext<{
  shortId: string | null
  canComment: boolean
  /** Deck artifacts: the slide being viewed (null/undefined = not a deck). Lets a
   *  comment card show which slide it belongs to without prop-threading. */
  currentSlide?: number | null
  /** Per-thread: the slide its anchor resolved on (null = outside any slide). */
  landedSlides?: Record<string, number | null>
  /** Per-thread element-anchor resolution quality, so a card can show a quiet
   *  "moved" marker when its element relocated with less than full confidence. */
  anchorConf?: Record<string, { band: "high" | "medium" | "low"; confidence: number }>
}>({
  shortId: null,
  canComment: true,
})

export const CommentScopeProvider = CommentScopeContext.Provider
export const useCommentScope = () => useContext(CommentScopeContext)
