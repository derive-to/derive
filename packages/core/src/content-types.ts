export const HTML_CONTENT_TYPE = "text/html"
export const MARKDOWN_CONTENT_TYPE = "text/markdown"
export const DECK_CONTENT_TYPE = "text/x-derive-deck"
const VIDEO_HTML_CONTENT_TYPE = "text/x-derive-video"
// A private duplicate of latex.ts LATEX_CONTENT_TYPE, for the same reason as the video
// literal above: this module is a leaf (no imports, so no cycle), and the public spelling
// lives with the parser in latex.ts.
const LATEX_SOURCE_CONTENT_TYPE = "text/x-latex"
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

/** Stored types that contain Markdown. Parameters such as `charset=utf-8` are
 * metadata, not a different editing language. */
export const isMarkdownLike = (contentType: string): boolean =>
  baseType(contentType) === MARKDOWN_CONTENT_TYPE

/** Stored LaTeX source (a single .tex file). Neither HTML-like nor Markdown-like: every
 * consumer that branches on those two must decide what it does with a third source
 * language explicitly, which is why this predicate exists rather than joining either. */
export const isLatexLike = (contentType: string): boolean =>
  baseType(contentType) === LATEX_SOURCE_CONTENT_TYPE

/** Types that may carry the full author-declared fact grammar. Decks receive derived structure
 * plus narrowly allowlisted operational contracts at the API boundary. */
export const isAuthoredFactType = (contentType: string): boolean =>
  [HTML_CONTENT_TYPE, MARKDOWN_CONTENT_TYPE, LINKED_BUNDLE_HTML_CONTENT_TYPE].includes(
    baseType(contentType),
  )
