import { DECK_CONTENT_TYPE, HTML_CONTENT_TYPE, isMarkdownLike } from "./content-types"
import { VIDEO_CONTENT_TYPE } from "./videos"

export {
  type AppliedMarkdownSourceOps,
  type AppliedSourceOps,
  applyMarkdownSourceOps,
  applySourceOps,
  hashSource,
  hostMarker,
  type MarkdownSourceKind,
  type MarkdownSourceModel,
  type MarkdownSourceNode,
  type MarkdownSourceUnit,
  markdownUnit,
  parseSourceOps,
  removedSourceIn,
  SOURCE_ASSET_MAX_BYTES,
  SOURCE_ASSET_TYPES,
  type SourceAssetType,
  SourceConflictError,
  type SourceHash,
  type SourceImageType,
  type SourceInlineTag,
  type SourceOp,
  type SourceToken,
  type StampedSync,
  type SyncReply,
  sourceAssetType,
  sourceImageType,
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
