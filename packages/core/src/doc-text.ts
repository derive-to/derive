// Stored-format facade. Shared source rules own reading and document navigation.
// Derive supplies stored-format classification and LaTeX heading rendering.

import {
  docOutline,
  headingSlugger,
  htmlSectionSpans,
  htmlToMarkdown,
  type LandmarkRegion,
  labelledLandmarks,
  landmarkMap,
  markdownHeadings,
  markersFromOffsets,
  type OutlineSection,
  type SectionMarker,
  type SectionSpan,
  type SourceHeading,
  sectionSlice,
  spansFromHeadings,
} from "@aniraga/open-artifact-protocol/source"
import { isHtmlLike, isLatexLike } from "./content-types"
import { latexHeadings } from "./latex-render"

export {
  applyEdits,
  type DocEdit,
  docOutline,
  EditError,
  enclosingMarker,
  headingSlug,
  headingSlugger,
  htmlToMarkdown,
  LANDMARK_TAGS,
  type LandmarkRegion,
  landmarkMap,
  landmarkSlice,
  landmarkSpans,
  type OutlineSection,
  type SectionMarker,
  type SectionSpan,
  sectionSlice,
} from "@aniraga/open-artifact-protocol/source"
export {
  DECK_CONTENT_TYPE,
  isAuthoredFactType,
  isHtmlLike,
  isLatexLike,
  isMarkdownLike,
} from "./content-types"

const texHeadings = (source: string): SourceHeading[] =>
  latexHeadings(source, headingSlugger()).map(({ level, text, slug, start }) => ({
    level,
    text,
    slug,
    start,
  }))

const textSectionSpans = (source: string, contentType: string, flat: boolean): SectionSpan[] => {
  const latex = isLatexLike(contentType)
  const headings = latex ? texHeadings(source) : markdownHeadings(source)
  const end = latex ? source.lastIndexOf("\\end{document}") : -1
  const lastStart = headings.at(-1)?.start ?? source.length
  // Flat LaTeX spans historically include the back matter in the final section.
  const documentEnd = !flat && end > lastStart ? end : source.length
  return spansFromHeadings(headings, documentEnd, flat)
}

/** Nested sections stop at the next heading of the same or higher level. */
export const sectionSpans = (source: string, contentType: string): SectionSpan[] =>
  isHtmlLike(contentType) ? htmlSectionSpans(source) : textSectionSpans(source, contentType, false)

/** Flat sections tile source without overlap for structural edits. */
export const flatSectionSpans = (source: string, contentType: string): SectionSpan[] =>
  isHtmlLike(contentType)
    ? htmlSectionSpans(source, true)
    : textSectionSpans(source, contentType, true)

export const sectionMarkers = (source: string, contentType: string): SectionMarker[] => {
  const headings = isHtmlLike(contentType)
    ? sectionSpans(source, contentType)
    : isLatexLike(contentType)
      ? texHeadings(source)
      : markdownHeadings(source)
  const positions = headings.map((heading) => ({ text: heading.text, offset: heading.start }))
  if (isHtmlLike(contentType))
    for (const span of labelledLandmarks(source))
      positions.push({ text: span.label, offset: span.start })
  return markersFromOffsets(source, positions)
}

/** HTML converts to Markdown. Other stored text formats already contain readable source. */
export const toMarkdown = (source: string, contentType: string): string =>
  isHtmlLike(contentType) ? htmlToMarkdown(source) : source

// A base64 data: URI tokenizes at roughly 1 token/char — a single modest screenshot
// can cost 100k+ tokens to read back through an agent-facing surface. Only ever
// applied to the markdown/agent-readable form (never the exact HTML source, which
// `edits` matches byte-for-byte against); anything over ~200 base64 chars (~150
// bytes) is worth collapsing.
const DATA_URI_RE = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g
const DATA_URI_AT_RE = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/y
const elidedDataUri = (match: string, mime: string, b64: string): string =>
  b64.length > 200
    ? `data:${mime};base64,[elided — ${Math.round((b64.length * 3) / 4 / 1024)}KB inline image. Re-upload via POST /v1/assets and swap in its url to make this doc cheap to read]`
    : match
export const elideDataUris = (s: string): string => s.replace(DATA_URI_RE, elidedDataUri)

/**
 * The first `maxChars` of {@link elideDataUris}, without scanning source that cannot
 * contribute to that prefix. Search indexes at most 256 KiB of one source, while an
 * artifact can be tens of MiB. Running the global replacement before slicing made a
 * small far-tail edit rescan the complete document just to reproduce the same prefix.
 *
 * A data URI that STARTS inside the output window is still consumed in full. Its
 * replacement reports the original byte size, so stopping halfway through it would
 * change the indexed text. Everything after the output window is irrelevant.
 */
export const elideDataUrisToLimit = (s: string, maxChars: number): string => {
  const limit = Math.max(0, Math.floor(maxChars))
  if (!limit || !s) return ""
  let cursor = 0
  let out = ""
  while (cursor < s.length && out.length < limit) {
    const remaining = limit - out.length
    const candidate = s.indexOf("data:", cursor)
    if (candidate < 0 || candidate - cursor >= remaining) {
      out += s.slice(cursor, cursor + remaining)
      break
    }
    out += s.slice(cursor, candidate)
    DATA_URI_AT_RE.lastIndex = candidate
    const match = DATA_URI_AT_RE.exec(s)
    if (!match) {
      // Match the final slice exactly when a malformed literal crosses the output
      // boundary. Appending all five characters here could exceed `maxChars` and make
      // the bounded search projection differ from full elision followed by slicing.
      const literal = "data:".slice(0, limit - out.length)
      out += literal
      cursor = candidate + literal.length
      continue
    }
    const replacement = elidedDataUri(match[0], match[1] as string, match[2] as string)
    out += replacement.slice(0, limit - out.length)
    cursor = DATA_URI_AT_RE.lastIndex
  }
  return out
}

/** Outline for any text source (h1–h6 for HTML, ATX `#`–`######` for markdown,
 *  `\section` and its relatives for LaTeX). */
export const outlineOf = (source: string, contentType: string): OutlineSection[] => {
  if (isHtmlLike(contentType)) return docOutline(source)
  return sectionSpans(source, contentType).map((h) => ({
    level: h.level,
    text: h.text,
    slug: h.slug,
    chars: h.end - h.start,
  }))
}

/** The landmark map for an HTML page with no heading spine (empty for markdown, and
 *  for HTML that has headings — the outline covers those, this is the fallback). */
export const landmarksOf = (source: string, contentType: string): LandmarkRegion[] =>
  isHtmlLike(contentType) ? landmarkMap(source) : []

/** The SOURCE slice a section slug addresses (raw HTML or raw markdown). */
export const sectionOf = (source: string, contentType: string, slug: string): string | null => {
  if (isHtmlLike(contentType)) return sectionSlice(source, slug)
  const span = sectionSpans(source, contentType).find((h) => h.slug === slug)
  if (!span) return null
  return source.slice(span.start, span.end).replace(/\n+$/, "\n")
}
