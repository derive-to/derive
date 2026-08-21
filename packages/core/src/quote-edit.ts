// Quote-scoped edits: apply a text replacement located by a TextQuoteSelector-shaped
// {exact, prefix, suffix} instead of an exact source string. This is the write half of
// the anchoring machinery — the inline editor in the viewer captures WHAT the reader
// sees (rendered text), and this module maps it back to the stored bytes and splices.
//
// Two invariants distinguish it from the read-side matcher in `anchor-shared`:
//   1. STRICT resolution. Painting a highlight may fall back to "the first place the
//      words appear"; an EDIT must not — the context match must be UNIQUE, and a
//      context miss is only accepted when the exact text is globally unambiguous.
//   2. RAW offsets. For HTML the quote matches the page-text projection, so the
//      resolved span is mapped back to raw-source offsets through the projection's
//      own segment map (`pageTextParts` — the ONE implementation both sides read),
//      Safe inline markup is repaired around the replacement; structural boundaries
//      and decoded-entity splits are refused, never guessed.
//
// Like `applyEdits`, the batch is atomic: any failure applies NOTHING.

import { type PageTextSegment, pageTextParts } from "./anchor"
import { clip, findQuoteContextUnique, findQuoteMatches } from "./anchor-shared"
import { isHtmlLike } from "./content-types"
import { type DocEdit, EditError } from "./doc-text"
import type { ElementEdit } from "./element-edit"
import { escapeHtml, sanitizeInline } from "./md"
import type { SceneEdit } from "./videos"

/** A replacement located by quote — the wire shape the inline editor sends. */
export interface QuoteEdit {
  quote: {
    exact: string
    prefix?: string
    suffix?: string
  }
  /** Replacement for the quoted span. Empty string deletes. Escaped for HTML content
   *  at apply time — callers pass the text as typed. */
  new_text?: string
  /**
   * The replacement as INLINE MARKUP instead of text — how the editor sends a run
   * the reader made bold, italic, or a link. Mutually exclusive with `new_text`.
   *
   * This is the one path where a manual edit can carry tags into the source, so it
   * is sanitized to a five-tag allowlist with no attributes but `href` (see
   * `sanitizeInline`), and it changes nothing else: the span is still located by
   * quote, still repaired across inline markup, still refused if it crosses structure
   * or splits an entity, still unique or nothing. HTML artifacts only — on a markdown
   * document, formatting is written as markdown, and passing tags would put literal
   * HTML in someone's prose.
   */
  new_html?: string
}

/** Either edit shape the edits surfaces accept. */
export type AnyDocEdit = DocEdit | QuoteEdit | ElementEdit | SceneEdit

const optionalString = (v: unknown): boolean => v === undefined || typeof v === "string"

/** True for a well-FORMED quote edit. Strict on every field (a numeric prefix must
 *  be a clean 400 at the routes, not a TypeError-shaped 500 mid-resolution), and
 *  EXACTLY ONE replacement: text or markup, never both, never neither — "both" has
 *  no sane meaning and picking one silently would apply the edit nobody asked for. */
export const isQuoteEdit = (e: unknown): e is QuoteEdit => {
  const q = e as QuoteEdit
  return (
    !!q &&
    typeof q === "object" &&
    !!q.quote &&
    typeof q.quote === "object" &&
    typeof q.quote.exact === "string" &&
    optionalString(q.quote.prefix) &&
    optionalString(q.quote.suffix) &&
    optionalString(q.new_text) &&
    optionalString(q.new_html) &&
    (typeof q.new_text === "string") !== (typeof q.new_html === "string")
  )
}

/** The segment index containing text offset `t` (binary search; segments are
 *  contiguous in `tStart` order). -1 when out of range. */
const segmentIndexAt = (segments: PageTextSegment[], t: number): number => {
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid] as PageTextSegment
    if (t < s.tStart) hi = mid - 1
    else if (t >= s.tEnd) lo = mid + 1
    else return mid
  }
  return -1
}

const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
])

interface OpenInlineTag {
  name: string
  raw: string
  at: number
}

interface ParsedHtmlTag {
  closing: boolean
  name: string
  selfClosing: boolean
}

const isHtmlSpace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f"

const isTagNameStart = (char: string): boolean =>
  (char >= "a" && char <= "z") || (char >= "A" && char <= "Z")

const isTagNameChar = (char: string): boolean =>
  isTagNameStart(char) ||
  (char >= "0" && char <= "9") ||
  char === "_" ||
  char === ":" ||
  char === "-"

/** Parse only the tag facts boundary repair needs, in one bounded pass. */
const parseHtmlTag = (raw: string): ParsedHtmlTag | null => {
  if (raw.length < 3 || raw[0] !== "<" || raw[raw.length - 1] !== ">") return null
  let i = 1
  while (i < raw.length - 1 && isHtmlSpace(raw[i] ?? "")) i++
  const closing = raw[i] === "/"
  if (closing) {
    i++
    while (i < raw.length - 1 && isHtmlSpace(raw[i] ?? "")) i++
  }
  if (!isTagNameStart(raw[i] ?? "")) return null
  const nameStart = i
  while (i < raw.length - 1 && isTagNameChar(raw[i] ?? "")) i++
  const name = raw.slice(nameStart, i).toLowerCase()
  const selfClosing = !closing && raw.slice(0, -1).trimEnd().endsWith("/")
  return { closing, name, selfClosing }
}

/** Return the next complete tag/comment without backtracking over attacker input. */
const nextHtmlBoundary = (
  src: string,
  from: number,
): { at: number; raw: string; next: number } | null => {
  const at = src.indexOf("<", from)
  if (at < 0) return null
  const comment = src.startsWith("<!--", at)
  const end = comment ? src.indexOf("-->", at + 4) : src.indexOf(">", at + 1)
  if (end < 0) return null
  const next = end + (comment ? 3 : 1)
  return { at, raw: src.slice(at, next), next }
}

const closingTagLengthAt = (src: string, at: number, expectedName: string): number => {
  if (src[at] !== "<") return 0
  const end = src.indexOf(">", at + 1)
  if (end < 0) return 0
  const raw = src.slice(at, end + 1)
  const parsed = parseHtmlTag(raw)
  if (!parsed?.closing || parsed.name !== expectedName) return 0
  let i = 1
  while (i < raw.length - 1 && isHtmlSpace(raw[i] ?? "")) i++
  i++
  while (i < raw.length - 1 && isHtmlSpace(raw[i] ?? "")) i++
  i += parsed.name.length
  while (i < raw.length - 1 && isHtmlSpace(raw[i] ?? "")) i++
  return i === raw.length - 1 ? raw.length : 0
}

/**
 * Preserve the HTML topology around a replacement that crosses inline markup.
 *
 * The raw splice removes every tag inside the selected range. Tags that were open
 * at only one edge are therefore closed before, or reopened after, the replacement.
 * The replacement inherits only formatting common to both edges — the same useful
 * rule a rich-text editor applies when a selection crosses formatting runs.
 * Structural tags remain a hard boundary.
 */
const inlineBoundaryRepair = (
  src: string,
  rStart: number,
  rEnd: number,
  label: string,
): { rStart: number; rEnd: number; before: string; after: string } => {
  const stack: OpenInlineTag[] = []
  let atStart: OpenInlineTag[] = []
  let atEnd: OpenInlineTag[] = []
  let capturedStart = false
  let capturedEnd = false
  for (
    let boundary = nextHtmlBoundary(src, 0);
    boundary;
    boundary = nextHtmlBoundary(src, boundary.next)
  ) {
    const { at, raw } = boundary
    if (at >= rStart && !capturedStart) {
      atStart = stack.slice()
      capturedStart = true
    }
    if (at >= rEnd) {
      atEnd = stack.slice()
      capturedEnd = true
      break
    }
    const parsed = parseHtmlTag(raw)
    if (!parsed) {
      if (at >= rStart)
        throw new EditError(`${label} failed: the selection crosses a non-text HTML boundary.`)
      continue
    }
    const name = parsed.name
    if (!INLINE_TAGS.has(name)) {
      if (at >= rStart)
        throw new EditError(
          `${label} failed: the selection crosses an element boundary in the source.`,
        )
      continue
    }
    if (parsed.closing) {
      let open = -1
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.name === name) {
          open = i
          break
        }
      }
      if (open >= 0) stack.splice(open, 1)
    } else if (!parsed.selfClosing) {
      stack.push({ name, raw, at })
    }
  }
  if (!capturedStart) atStart = stack.slice()
  if (!capturedEnd) atEnd = stack.slice()

  let common = 0
  while (
    common < atStart.length &&
    common < atEnd.length &&
    atStart[common]?.at === atEnd[common]?.at
  )
    common++
  const startOnly = atStart.slice(common)
  const endOnly = atEnd.slice(common)

  // If the selection begins at the first character inside a formatting wrapper,
  // consume the opening tag too instead of leaving `<span></span>` behind. Walk
  // inside-out so nested wrappers (`<b><i>text`) collapse cleanly as well.
  let adjustedStart = rStart
  let consumedStart = 0
  for (let i = startOnly.length - 1; i >= 0; i--) {
    const entry = startOnly[i] as OpenInlineTag
    if (entry.at + entry.raw.length !== adjustedStart) break
    adjustedStart = entry.at
    consumedStart++
  }

  // Symmetrically consume closing tags immediately after the selection. The
  // corresponding opening tags are already inside the removed span, so retaining
  // these closers would require an empty reopened wrapper.
  let adjustedEnd = rEnd
  let consumedEnd = 0
  for (let i = endOnly.length - 1; i >= 0; i--) {
    const entry = endOnly[i] as OpenInlineTag
    const closeLength = closingTagLengthAt(src, adjustedEnd, entry.name)
    if (!closeLength) break
    adjustedEnd += closeLength
    consumedEnd++
  }

  const before = startOnly
    .slice(0, startOnly.length - consumedStart)
    .reverse()
    .map((entry) => `</${entry.name}>`)
    .join("")
  const after = endOnly
    .slice(0, endOnly.length - consumedEnd)
    .map((entry) => entry.raw)
    .join("")
  return { rStart: adjustedStart, rEnd: adjustedEnd, before, after }
}

/**
 * Map a [start, end) span of the projection back to raw-source offsets. Inline gaps
 * are repaired; structural gaps are refused. Starting or ending INSIDE an entity's
 * decoded characters is also refused (you can't splice half a decoded character).
 */
const spanToRaw = (
  src: string,
  segments: PageTextSegment[],
  start: number,
  end: number,
  label: string,
): { rStart: number; rEnd: number; before: string; after: string } => {
  const firstIdx = segmentIndexAt(segments, start)
  const lastIdx = segmentIndexAt(segments, end - 1)
  if (firstIdx < 0 || lastIdx < 0)
    throw new EditError(`${label} failed: the matched text fell outside the document.`)
  // Gaps may be inline formatting tags. Structural tags are still rejected by the
  // boundary repair below.
  let crossesMarkup = false
  for (let i = firstIdx; i <= lastIdx; i++) {
    if ((segments[i] as PageTextSegment).kind === "gap") crossesMarkup = true
  }
  const first = segments[firstIdx] as PageTextSegment
  const lastSeg = segments[lastIdx] as PageTextSegment
  if (first.kind === "entity" && start > first.tStart)
    throw new EditError(
      `${label} failed: the edit would split a character. Select the whole character.`,
    )
  if (lastSeg.kind === "entity" && end < lastSeg.tEnd)
    throw new EditError(
      `${label} failed: the edit would split a character. Select the whole character.`,
    )
  const rStart = first.kind === "entity" ? first.rStart : first.rStart + (start - first.tStart)
  const rEnd = lastSeg.kind === "entity" ? lastSeg.rEnd : lastSeg.rStart + (end - lastSeg.tStart)
  const repair = crossesMarkup ? inlineBoundaryRepair(src, rStart, rEnd, label) : null
  return repair ?? { rStart, rEnd, before: "", after: "" }
}

/**
 * Apply quote-scoped edits to `src` atomically. Every quote is resolved against the
 * ORIGINAL source (markdown: the source itself; HTML/deck: the page-text projection,
 * mapped back to raw offsets through its segment map), spans are checked for
 * overlap, and the splices land back-to-front — so one batch's edits can never
 * shift each other's targets. Any failure throws `EditError` (with which edit and
 * why) and applies nothing, matching `applyEdits`' contract.
 */
export function applyQuoteEdits(src: string, contentType: string, edits: QuoteEdit[]): string {
  if (!edits.length) return src
  const isHtml = isHtmlLike(contentType || "")
  let text = src
  let segments: PageTextSegment[] | null = null
  if (isHtml) {
    const parts = pageTextParts(src)
    text = parts.text
    segments = parts.segments
  }

  const spans: {
    rStart: number
    rEnd: number
    replacement: string
    label: string
    before: string
    after: string
  }[] = []
  for (const [i, e] of edits.entries()) {
    const label = `Edit ${i + 1} of ${edits.length}`
    const exact = e.quote.exact
    if (!exact.trim()) throw new EditError(`${label} failed: the quoted text is empty.`)
    // Context first — and the context itself must pin exactly ONE spot. A context
    // that matches twice (identical repeated cards) must refuse, not silently edit
    // the first card when the user touched the second. A context miss is acceptable
    // only when the exact text appears exactly once in the document.
    const ctx = findQuoteContextUnique(text, exact, e.quote.prefix, e.quote.suffix)
    if (ctx.matches > 1)
      throw new EditError(
        `${label} failed: "${clip(exact, 60)}" appears in ${ctx.matches} identical contexts — the edit can't be pinned to one. Open the source editor.`,
      )
    let span = ctx.span
    if (!span) {
      const all = findQuoteMatches(text, exact)
      if (all.length === 1) span = all[0] as { start: number; end: number }
      else if (all.length === 0)
        throw new EditError(
          `${label} failed: "${clip(exact, 60)}" wasn't found — the document may have changed. Re-read and retry.`,
        )
      else
        throw new EditError(
          `${label} failed: "${clip(exact, 60)}" appears ${all.length} times and the surrounding context didn't pin one down.`,
        )
    }
    const raw = segments
      ? spanToRaw(src, segments, span.start, span.end, label)
      : { rStart: span.start, rEnd: span.end, before: "", after: "" }
    // Markup, only where markup is the language. On markdown the source IS what the
    // author writes, so formatting is `**bold**` typed as text; splicing tags there
    // would put literal HTML in someone's prose.
    if (e.new_html !== undefined && !isHtml)
      throw new EditError(
        `${label} failed: this document is Markdown — write formatting as Markdown text, not HTML.`,
      )
    const replacement =
      e.new_html !== undefined
        ? sanitizeInline(e.new_html)
        : isHtml
          ? escapeHtml(e.new_text ?? "")
          : (e.new_text ?? "")
    spans.push({ ...raw, replacement: raw.before + replacement + raw.after, label })
  }

  // Overlapping spans would make the result order-dependent — refuse the batch.
  spans.sort((a, b) => a.rStart - b.rStart || a.rEnd - b.rEnd)
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1] as (typeof spans)[number]
    const cur = spans[i] as (typeof spans)[number]
    if (cur.rStart < prev.rEnd)
      throw new EditError(`${cur.label} failed: it overlaps ${prev.label.toLowerCase()}.`)
  }

  // Back-to-front, so earlier spans' offsets stay valid.
  let out = src
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i] as (typeof spans)[number]
    out = out.slice(0, s.rStart) + s.replacement + out.slice(s.rEnd)
  }
  return out
}
