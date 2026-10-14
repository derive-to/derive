import { DECK_CONTENT_TYPE, HTML_CONTENT_TYPE, isMarkdownLike } from "./content-types"
import { VIDEO_CONTENT_TYPE } from "./videos"

export {
  type AppliedSourceOps,
  applySourceOps,
  hashSource,
  hostMarker,
  parseSourceOps,
  SourceConflictError,
  type SourceHash,
  type SourceInlineTag,
  type SourceOp,
  type SourceToken,
  type StampedSync,
  type SyncReply,
  sourceMap,
  sourceSha,
  staleSourceIds,
  stampSourceIds,
  syncStamped,
  withHostMarker,
} from "@aniraga/open-artifact-protocol/source"

/** Stored formats whose rendered editor sends exact source operations. */
export const isSourceEditable = (contentType: string): boolean => {
  const base = contentType.split(";")[0]?.trim()
  return (
    base === HTML_CONTENT_TYPE ||
    base === DECK_CONTENT_TYPE ||
    base === VIDEO_CONTENT_TYPE ||
    isMarkdownLike(contentType)
  )
}
