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
//      and an edit whose span would cross markup (or split a decoded entity) is
//      refused, never guessed.
//
// Like `applyEdits`, the batch is atomic: any failure applies NOTHING.

import { type PageTextSegment, pageTextParts } from "./anchor"
import { clip, findQuoteContextUnique, findQuoteMatches } from "./anchor-shared"
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
   * quote, still refused if it crosses markup or splits an entity, still unique or
   * nothing. HTML artifacts only — on a markdown document, formatting is written as
   * markdown, and passing tags would put literal HTML in someone's prose.
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

/**
 * Map a [start, end) span of the projection back to raw-source offsets. Refuses a
 * span that includes a `gap` (it would cross a tag — a structural change, not a text
 * edit) or that starts/ends INSIDE an entity's decoded characters (you can't splice
 * half of a decoded character).
 */
const spanToRaw = (
  segments: PageTextSegment[],
  start: number,
  end: number,
  label: string,
): { rStart: number; rEnd: number } => {
  const firstIdx = segmentIndexAt(segments, start)
  const lastIdx = segmentIndexAt(segments, end - 1)
  if (firstIdx < 0 || lastIdx < 0)
    throw new EditError(`${label} failed: the matched text fell outside the document.`)
  // Every segment the span touches must be visible text — a gap inside means the
  // selection crosses an element boundary in the source.
  for (let i = firstIdx; i <= lastIdx; i++) {
    if ((segments[i] as PageTextSegment).kind === "gap")
      throw new EditError(
        `${label} failed: the selection crosses formatting or element boundaries in the source — edit a smaller run of plain text, or open the source editor.`,
      )
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
  return { rStart, rEnd }
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
  const ct = (contentType || "").split(";")[0]?.trim()
  const isHtml = ct === "text/html" || ct === "text/x-derive-deck"
  let text = src
  let segments: PageTextSegment[] | null = null
  if (isHtml) {
    const parts = pageTextParts(src)
    text = parts.text
    segments = parts.segments
  }

  const spans: { rStart: number; rEnd: number; replacement: string; label: string }[] = []
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
      ? spanToRaw(segments, span.start, span.end, label)
      : { rStart: span.start, rEnd: span.end }
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
    spans.push({ ...raw, replacement, label })
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
