export const HTML_CONTENT_TYPE = "text/html"
export const MARKDOWN_CONTENT_TYPE = "text/markdown"
export const DECK_CONTENT_TYPE = "text/x-derive-deck"
const VIDEO_HTML_CONTENT_TYPE = "text/x-derive-video"
export const LINKED_BUNDLE_HTML_CONTENT_TYPE = "text/x-derive-linked-bundle"

const baseType = (contentType: string): string => contentType.split(";")[0]?.trim() ?? ""

/** Stored types that contain an HTML document and share reading/editing behavior. */
export const isHtmlLike = (contentType: string): boolean =>
  [
    HTML_CONTENT_TYPE,
    DECK_CONTENT_TYPE,
    VIDEO_HTML_CONTENT_TYPE,
    LINKED_BUNDLE_HTML_CONTENT_TYPE,
  ].includes(baseType(contentType))

/** Types that may carry author-declared facts. Decks receive derived structure only. */
export const isAuthoredFactType = (contentType: string): boolean =>
  [HTML_CONTENT_TYPE, MARKDOWN_CONTENT_TYPE, LINKED_BUNDLE_HTML_CONTENT_TYPE].includes(
    baseType(contentType),
  )
