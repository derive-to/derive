import { DecodingMode, decodeHTML, EntityDecoder, htmlDecodeTree } from "entities/decode"
import { findQuoteWithContext } from "./anchor-shared"
import { isHtmlLike, isLatexLike } from "./content-types"
import { elementResolvesIn, parseElementSelector } from "./element-anchor"
import {
  elementEnd,
  type HtmlTag,
  hasAttr,
  RAW_TEXT_ELEMENTS,
  RCDATA_ELEMENTS,
  tags,
} from "./html-tags"
import { latexTextProjection } from "./latex-render"
import { MENTION_NON_PROSE_TAGS } from "./mention-shared"
import type { CommentState } from "./ports"

/** A W3C Web Annotation TextQuoteSelector — survives republishing. */
export interface QuoteSelector {
  type: "TextQuoteSelector"
  exact: string
  prefix?: string
  suffix?: string
  /** Deck artifacts only: the 0-based slide the comment was made on. Undefined on
   *  ordinary documents. Resolution scopes to this slide first, then falls back to
   *  the whole document (so a comment survives text moving between slides). */
  slide?: number
  /** Stable `data-derive-slide` identity. New deck comments prefer this after a
   *  rearrange; `slide` remains the backward-compatible positional fallback. */
  slide_identity?: string
}

const CONTEXT = 24

/** Build a quote selector for `text[start, start+length)` with surrounding context. */
export function quoteSelector(text: string, start: number, length: number): QuoteSelector {
  return {
    type: "TextQuoteSelector",
    exact: text.slice(start, start + length),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(start + length, start + length + CONTEXT),
  }
}

export interface Reanchor {
  found: boolean
  index: number
}

/**
 * Locate a quote selector in (possibly republished) text.
 * 1) context match (prefix+exact+suffix, to disambiguate a repeated quote), then the
 *    exact within that window; 2) exact match anywhere; 3) not found → orphaned.
 * Both phases are WHITESPACE-FLEXIBLE (findQuote): a quote spanning block elements
 * serializes its inter-block gaps differently in the browser Selection, the DOM text,
 * and the HTML source, so a strict indexOf silently orphaned every multi-element
 * comment. `text` should be the page's visible text (tags stripped for HTML — see
 * pageText) so the quote's words are contiguous. Deterministic, no ML.
 */
export function reanchor(sel: QuoteSelector, text: string): Reanchor {
  if (!sel.exact) return { found: false, index: -1 }
  // Context-disambiguated, whitespace-flexible match (shared with the browser client);
  // returns the span of the exact itself.
  const m = findQuoteWithContext(text, sel.exact, sel.prefix, sel.suffix)
  return m ? { found: true, index: m.start } : { found: false, index: -1 }
}

// Matches one HTML character reference. Shared (via pageTextParts' segmenter) with
// the edit path's offset map, so an entity the decoder learns is one the mapper
// learns in the same breath — two copies of this regex once drifted a hair from
// being a feature-wide refusal.
/** Legacy export retained for callers that only need a coarse candidate scan.
 *  Offset-sensitive code uses {@link decodedEntitiesIn}, which follows the full
 *  browser entity grammar including semicolonless legacy names. */
export const ENTITY_RE = /&(?:#(?:x[0-9a-fA-F]+|[0-9]+)|[a-zA-Z][a-zA-Z0-9]+);?/g

export interface DecodedEntity {
  start: number
  end: number
  text: string
}

/** Browser-compatible character references and their exact raw spans. The entity
 *  decoder reports how many source characters it consumed, which is essential for
 *  mapping legacy semicolonless names and multi-code-point named entities back to
 *  authored bytes without guessing. */
export function decodedEntitiesIn(input: string, from = 0, to = input.length): DecodedEntity[] {
  const out: DecodedEntity[] = []
  let decoded = ""
  const decoder = new EntityDecoder(htmlDecodeTree, (cp) => {
    decoded += cp === 0xa0 ? " " : String.fromCodePoint(cp)
  })
  let cursor = from
  for (;;) {
    // `indexOf("&", cursor)` has no end bound. When this helper runs once per visible
    // text run, an entity-free run near the start of a large document would scan every
    // later run again before the result was rejected as `>= to`. Walk only this run so
    // all calls made by one page projection examine each source character at most once.
    let amp = cursor
    while (amp < to && input.charCodeAt(amp) !== 38) amp++
    if (amp >= to) break
    decoded = ""
    decoder.startEntity(DecodingMode.Legacy)
    let consumed = decoder.write(input, amp + 1)
    if (consumed < 0) consumed = decoder.end()
    const end = amp + consumed
    if (consumed > 1 && decoded && end <= to) {
      out.push({ start: amp, end, text: decoded })
      cursor = end
    } else cursor = amp + 1
  }
  return out
}

/** Decode numeric character references and the common named entities the browser
 *  would. Unknown named entities pass through untouched. Shared by `pageText` and
 *  the doc-text markdown conversion so both read an `&amp;` the same way. */
export function decodeEntities(s: string): string {
  return decodeHTML(s, DecodingMode.Legacy).replaceAll("\u00a0", " ")
}

/** One run of the page-text projection: how a slice of visible text maps onto the
 *  raw source. `text` runs map 1:1; an `entity` run is one decoded character (or a
 *  surrogate pair) covering the entity's whole raw span; a `gap` is the single space
 *  a tag, comment, or invisible block collapsed to. */
export interface PageTextSegment {
  kind: "text" | "entity" | "gap"
  tStart: number
  tEnd: number
  rStart: number
  rEnd: number
}

export interface PageTextParts {
  text: string
  segments: PageTextSegment[]
}

const INVISIBLE_NAMES = [
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "title",
  "iframe",
  "noembed",
  "noframes",
  "textarea",
]
const SVG_INVISIBLE_NAMES = new Set(["desc", "metadata"])
const MATH_INVISIBLE_NAMES = new Set(["annotation", "annotation-xml"])
/** Exported so latex-emit.ts can pin its mirrored copy in a test. */
export const BLOCK_TEXT_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "listing",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "xmp",
])

/** Memoized left-to-right indexOf. During a forward scan, thousands of failed
 *  searches for the same needle (unclosed "<!--" after unclosed "<!--") would each
 *  rescan to the end of the string — quadratic in aggregate. The cursor only moves
 *  forward, so the last answer per needle stays valid until the cursor passes it;
 *  re-searches only ever advance it, which keeps the total scan work linear. */
const makeFinder = (haystack: string) => {
  const cache = new Map<string, number>()
  return (needle: string, from: number): number => {
    const c = cache.get(needle)
    if (c !== undefined && (c === -1 || c >= from)) return c
    const n = haystack.indexOf(needle, from)
    cache.set(needle, n)
    return n
  }
}

/** Append `raw[rFrom, rTo)` — a run with no tags in it — as text/entity segments. */
const pushTextRun = (
  out: PageTextSegment[] | null,
  parts: string[],
  tLen: number,
  raw: string,
  rFrom: number,
  rTo: number,
): number => {
  const run = raw.slice(rFrom, rTo)
  let last = 0
  for (const entity of decodedEntitiesIn(raw, rFrom, rTo)) {
    const localStart = entity.start - rFrom
    const localEnd = entity.end - rFrom
    if (localStart > last) {
      const plain = run.slice(last, localStart)
      out?.push({
        kind: "text",
        tStart: tLen,
        tEnd: tLen + plain.length,
        rStart: rFrom + last,
        rEnd: entity.start,
      })
      parts.push(plain)
      tLen += plain.length
    }
    out?.push({
      kind: "entity",
      tStart: tLen,
      tEnd: tLen + entity.text.length,
      rStart: entity.start,
      rEnd: entity.end,
    })
    parts.push(entity.text)
    tLen += entity.text.length
    last = localEnd
  }
  if (last < run.length) {
    const plain = run.slice(last)
    out?.push({
      kind: "text",
      tStart: tLen,
      tEnd: tLen + plain.length,
      rStart: rFrom + last,
      rEnd: rTo,
    })
    parts.push(plain)
    tLen += plain.length
  }
  return tLen
}

/** Append a RAWTEXT run without decoding character references. */
const pushLiteralRun = (
  out: PageTextSegment[] | null,
  parts: string[],
  tLen: number,
  raw: string,
  rFrom: number,
  rTo: number,
): number => {
  if (rTo <= rFrom) return tLen
  const text = raw.slice(rFrom, rTo)
  out?.push({
    kind: "text",
    tStart: tLen,
    tEnd: tLen + text.length,
    rStart: rFrom,
    rEnd: rTo,
  })
  parts.push(text)
  return tLen + text.length
}

/**
 * The page-text projection WITH its offset map: visible text plus, per run, where
 * it came from in the raw source. One linear indexOf-driven scan (no lazy-quantifier
 * regexes — those backtracked polynomially on crafted documents, CodeQL
 * js/polynomial-redos) is THE implementation: `pageText` is this function's `text`,
 * and the edit path's raw-offset mapping reads the same `segments`, so the read
 * side and the write side cannot disagree about what the projection is.
 *
 * Strip rules, tried in order at each "<" (the order the old regexes resolved to):
 * an invisible block (script/style/noscript, attrs to the FIRST ">", closed by the
 * first literal "</name>", case-insensitive, or running to EOF when unclosed), else
 * a comment ("<!--" to the first "-->", or EOF), else a bare tag (1+ non-">" chars
 * before ">"); a "<" matching none stays literal text. Each stripped construct
 * collapses to one space; entities in text runs decode via {@link decodeEntities}.
 */
const projectPageText = (
  html: string,
  omitContentsOf: readonly string[],
  mapOffsets: boolean,
): PageTextParts => {
  const findRaw = makeFinder(html)
  const omitted = new Set(omitContentsOf)
  const parsedTags = tags(html)
  let closingTagByEnd: Map<number, HtmlTag> | null = null
  const tagEnds = new Map(parsedTags.map((tag) => [tag.start, tag.end]))
  const blockTagStarts = new Set(
    parsedTags.filter((tag) => BLOCK_TEXT_ELEMENTS.has(tag.name)).map((tag) => tag.start),
  )
  const invisibleEnds = new Map<number, number>()
  const literalRanges: { start: number; end: number; entities: boolean }[] = []
  for (let i = 0; i < parsedTags.length; i++) {
    const tag = parsedTags[i]
    if (
      tag &&
      !tag.closing &&
      !tag.selfClosing &&
      (RAW_TEXT_ELEMENTS.has(tag.name) || RCDATA_ELEMENTS.has(tag.name))
    ) {
      const end = elementEnd(parsedTags, i)
      closingTagByEnd ??= new Map(
        parsedTags
          .filter((candidate) => candidate.closing)
          .map((candidate) => [candidate.end, candidate]),
      )
      const candidate = closingTagByEnd.get(end)
      const close = candidate?.name === tag.name ? candidate : undefined
      literalRanges.push({
        start: tag.end,
        end: close?.start ?? html.length,
        entities: RCDATA_ELEMENTS.has(tag.name),
      })
    }
    const foreignMetadata =
      (tag?.namespace === "svg" && SVG_INVISIBLE_NAMES.has(tag.name)) ||
      (tag?.namespace === "math" && MATH_INVISIBLE_NAMES.has(tag.name))
    if (
      !tag ||
      tag.closing ||
      (!omitted.has(tag.name) && !hasAttr(tag.attrs, "hidden") && !foreignMetadata)
    )
      continue
    const end = elementEnd(parsedTags, i)
    invisibleEnds.set(tag.start, end < 0 ? html.length : end)
  }

  const commentCloseEnd = (from: number): number => {
    let cursor = from
    for (;;) {
      const dashes = findRaw("--", cursor)
      if (dashes < 0) return html.length
      if (html.startsWith("-->", dashes)) return dashes + 3
      if (html.startsWith("--!>", dashes)) return dashes + 4
      cursor = dashes + 2
    }
  }

  /** The strip token starting exactly at html[i] (which is "<"), or null when this
   *  "<" is literal text. */
  const stripTokenAt = (i: number): { end: number; space: boolean } | null => {
    const invisibleEnd = invisibleEnds.get(i)
    if (invisibleEnd !== undefined) return { end: invisibleEnd, space: false }
    // <!-- ... -->
    if (html.startsWith("<!--", i)) return { end: commentCloseEnd(i + 4), space: false }
    const parsedEnd = tagEnds.get(i)
    if (parsedEnd !== undefined) return { end: parsedEnd, space: blockTagStarts.has(i) }
    // A browser keeps consuming an opening tag while an attribute quote remains
    // unterminated, including apparent `>` characters and later markup through
    // EOF. The shared scanner emits no tag for that malformed remainder; do not
    // let the coarse fallback expose its attribute bytes as editable prose.
    if (/^<\/?[a-zA-Z][a-zA-Z0-9-]*/.test(html.slice(i, i + 64)))
      return { end: html.length, space: false }
    // <[^>]+>
    const gt = findRaw(">", i + 1)
    if (gt > i + 1) return { end: gt + 1, space: false }
    return null
  }

  const segments: PageTextSegment[] = []
  const mappedSegments = mapOffsets ? segments : null
  const parts: string[] = []
  let tLen = 0
  let last = 0 // start of the pending text run
  let from = 0 // "<" search cursor
  let literalIndex = 0
  for (;;) {
    while (literalRanges[literalIndex] && (literalRanges[literalIndex]?.end ?? 0) <= from)
      literalIndex++
    const literal = literalRanges[literalIndex]
    if (literal && from === literal.start) {
      tLen = literal.entities
        ? pushTextRun(mappedSegments, parts, tLen, html, literal.start, literal.end)
        : pushLiteralRun(mappedSegments, parts, tLen, html, literal.start, literal.end)
      last = literal.end
      from = literal.end
      literalIndex++
      continue
    }
    const i = findRaw("<", from)
    if (i < 0) break
    const token = stripTokenAt(i)
    if (token === null) {
      from = i + 1 // a literal "<": it stays inside the text run
      continue
    }
    if (i > last) tLen = pushTextRun(mappedSegments, parts, tLen, html, last, i)
    mappedSegments?.push({
      kind: "gap",
      tStart: tLen,
      tEnd: tLen + (token.space ? 1 : 0),
      rStart: i,
      rEnd: token.end,
    })
    if (token.space) {
      parts.push(" ")
      tLen++
    }
    last = token.end
    from = token.end
  }
  if (last < html.length) tLen = pushTextRun(mappedSegments, parts, tLen, html, last, html.length)
  return { text: parts.join(""), segments }
}

export function pageTextParts(
  html: string,
  omitContentsOf: readonly string[] = INVISIBLE_NAMES,
): PageTextParts {
  return projectPageText(html, omitContentsOf, true)
}

/**
 * The visible text of an HTML page, for matching a text quote server-side — the
 * counterpart to the browser client's text-node concatenation. Drops script/style/
 * comment content, turns every stripped construct into a space (so words separated
 * only by markup — a multi-element quote — become whitespace-separated, which
 * reanchor's flexible match then spans), and decodes the common entities the
 * browser would. NOT a full HTML parser; findQuote's whitespace tolerance absorbs
 * the small differences.
 */
export function pageText(html: string): string {
  return projectPageText(html, INVISIBLE_NAMES, false).text
}

/**
 * Reader prose for document-body mention detection. It intentionally omits code,
 * templates, form labels, and head metadata in addition to ordinary invisible
 * markup, matching the in-frame mention decorator's DOM filter.
 */
export function mentionText(html: string): string {
  return projectPageText(html, MENTION_NON_PROSE_TAGS, false).text
}

// The comment-anchor client that runs inside the sandboxed artifact iframe. It is real,
// type-checked source in `anchor-client.ts` (which shares the fingerprint primitives with
// the server resolver via `anchor-shared`), bundled to a served IIFE string by
// scripts/build-anchor-client.mjs; CI keeps the generated file in sync (check-anchor-client).
export { ANCHOR_CLIENT_JS } from "./anchor-client.gen"

/** The DOM-dependent artifact client. Full HTML artifacts inject this at the start of
 * the document so an authored meta CSP cannot block Derive's own runtime; `defer` keeps
 * execution after parsing. Generated markdown can safely leave the same tag in <body>. */
export const SELECTION_SCRIPT = `<script defer src="/raw/derive-client.js"></script>`

/**
 * Page content for anchor resolution. A bare string treats it as BOTH the markup
 * (element anchors) and the match text (quotes) — right for markdown/plain, where the
 * source is already visible text. For HTML, pass `{ raw, text }`: element anchors need
 * the raw markup to relocate via the cascade, while a text quote must match against the
 * tag-stripped `text` (so a quote spanning multiple elements — whose words are separated
 * only by tags in the source — is contiguous). Build it with `anchorContentFor`.
 */
export type AnchorContent = string | { raw: string; text: string }

/** Build anchor content from a version's decoded bytes + its content type. HTML-like
 *  content (html + decks) gets tag-stripped page text for quote matching; markdown/plain
 *  is matched as-is (its source IS the visible text, and stripping would eat autolinks). */
export function anchorContentFor(raw: string, contentType: string): AnchorContent {
  if (isHtmlLike(contentType)) return { raw, text: pageText(raw) }
  // A LaTeX source renders to a page whose visible text is prose without the macros;
  // quotes are taken from that page, so they are matched against the same projection.
  if (isLatexLike(contentType)) return { raw, text: latexTextProjection(raw).text }
  return raw
}

/** True if the comment's stored anchor still resolves in `content` — a text quote
 *  (re-grepped whitespace-flexibly against the visible text) or an element anchor
 *  (relocated via the cascade against the raw markup). See {@link AnchorContent}. */
export function isAnchored(anchorJson: string | null, content: AnchorContent): boolean {
  if (!anchorJson) return true
  const raw = typeof content === "string" ? content : content.raw
  // Element anchor: relocate via the cascade against the page HTML.
  const el = parseElementSelector(anchorJson)
  if (el) return elementResolvesIn(el, raw) !== null
  try {
    const sel = JSON.parse(anchorJson) as QuoteSelector
    if (sel.type !== "TextQuoteSelector" || !sel.exact) return true
    return reanchor(sel, typeof content === "string" ? content : content.text).found
  } catch {
    return true
  }
}

/** One thread's anchoring inputs for the re-anchor sweep. `anchor` is the stored
 *  selector JSON of the thread's root comment (null = a whole-document thread). */
export interface AnchorThread {
  thread_id: string
  anchor: string | null
  state: CommentState
}

/** A state flip the sweep wants applied (always thread-level). */
export interface AnchorTransition {
  thread_id: string
  state: "open" | "outdated"
}

/**
 * Decide which threads change state when an artifact is republished. Pure — the
 * caller applies the returned flips.
 *
 * - `open` + anchored + no longer resolves → `outdated` (the quoted text changed)
 * - `outdated` + resolves again            → `open`     (the text came back)
 * - `resolved` threads and whole-document (un-anchored) threads are never touched.
 */
export function planAnchorSweep(
  threads: AnchorThread[],
  content: AnchorContent,
): AnchorTransition[] {
  const out: AnchorTransition[] = []
  for (const t of threads) {
    if (!t.anchor) continue // whole-document feedback never goes stale
    const resolves = isAnchored(t.anchor, content)
    if (t.state === "open" && !resolves) out.push({ thread_id: t.thread_id, state: "outdated" })
    else if (t.state === "outdated" && resolves) out.push({ thread_id: t.thread_id, state: "open" })
  }
  return out
}
