// Quote-scoped edits: apply a text replacement located by a TextQuoteSelector-shaped
// {exact, prefix, suffix} instead of an exact source string. This is the write half of
// the anchoring machinery — the inline editor in the viewer captures WHAT the reader
// sees (rendered text), and this module maps it back to the stored bytes and splices.
//
// Two invariants distinguish it from the read-side matcher in `anchor-shared`:
//   1. STRICT resolution. Painting a highlight may fall back to "the first place the
//      words appear"; an EDIT must not — a context miss is only accepted when the
//      exact text is globally unambiguous, otherwise the whole batch is rejected.
//   2. RAW offsets. For HTML the quote matches the tag-stripped projection
//      (`pageText`), so the resolved span must be mapped back to raw-source offsets
//      through an offset-tracking twin of that projection — and an edit whose span
//      would cross markup (or split a decoded entity) is refused, never guessed.
//
// Like `applyEdits`, the batch is atomic: any failure applies NOTHING.

import { decodeEntities, pageText } from "./anchor"
import { findQuoteContextOnly, findQuoteMatches } from "./anchor-shared"
import type { DocEdit } from "./doc-text"
import { EditError } from "./doc-text"

/** A replacement located by quote — the wire shape the inline editor sends. */
export interface QuoteEdit {
  quote: {
    exact: string
    prefix?: string
    suffix?: string
  }
  /** Replacement for the quoted span. Empty string deletes. Escaped for HTML content
   *  at apply time — callers pass the text as typed. */
  new_text: string
}

/** Either edit shape the edits surfaces accept. */
export type AnyDocEdit = DocEdit | QuoteEdit

export const isQuoteEdit = (e: unknown): e is QuoteEdit => {
  const q = e as QuoteEdit
  return (
    !!q &&
    typeof q === "object" &&
    !!q.quote &&
    typeof q.quote === "object" &&
    typeof q.quote.exact === "string" &&
    typeof q.new_text === "string"
  )
}

// ---------------------------------------------------------------------------------
// Offset-tracking pageText

/** One run of the projection: how a slice of visible text maps onto the raw source.
 *  `text` runs map 1:1; an `entity` run is one decoded character (or a surrogate
 *  pair) covering the entity's whole raw span; a `gap` is the single space a tag,
 *  comment, or invisible block collapsed to. */
interface Segment {
  kind: "text" | "entity" | "gap"
  tStart: number
  tEnd: number
  rStart: number
  rEnd: number
}

// The same patterns pageText strips, scanned in ONE left-to-right alternation pass
// (invisible blocks, then comments, then any tag — the order pageText's sequential
// replaces resolve to). Kept local rather than shared: a global RegExp object carries
// lastIndex state, and the projection equality is asserted at apply time anyway.
const STRIP = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->|<[^>]+>/gi
const ENTITY = /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g

interface PageTextMap {
  text: string
  segments: Segment[]
}

/** Append `raw[rFrom, rTo)` — a run with no tags in it — as text/entity segments. */
const pushTextRun = (
  out: Segment[],
  parts: string[],
  tLen: number,
  raw: string,
  rFrom: number,
  rTo: number,
): number => {
  const run = raw.slice(rFrom, rTo)
  let last = 0
  ENTITY.lastIndex = 0
  for (let m = ENTITY.exec(run); m; m = ENTITY.exec(run)) {
    const decoded = decodeEntities(m[0])
    if (decoded === m[0]) continue // unknown entity: passes through as plain text
    if (m.index > last) {
      const plain = run.slice(last, m.index)
      out.push({
        kind: "text",
        tStart: tLen,
        tEnd: tLen + plain.length,
        rStart: rFrom + last,
        rEnd: rFrom + m.index,
      })
      parts.push(plain)
      tLen += plain.length
    }
    out.push({
      kind: "entity",
      tStart: tLen,
      tEnd: tLen + decoded.length,
      rStart: rFrom + m.index,
      rEnd: rFrom + m.index + m[0].length,
    })
    parts.push(decoded)
    tLen += decoded.length
    last = m.index + m[0].length
  }
  if (last < run.length) {
    const plain = run.slice(last)
    out.push({
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

/**
 * `pageText`, but remembering where every visible character came from — so a span
 * resolved in the projection can be spliced into the raw source. `.text` is verified
 * equal to `pageText(html)` by the caller before any edit lands (belt and suspenders:
 * a divergence degrades to a clean refusal, never a mis-placed splice).
 */
export function pageTextWithMap(html: string): PageTextMap {
  const segments: Segment[] = []
  const parts: string[] = []
  let tLen = 0
  let last = 0
  STRIP.lastIndex = 0
  for (let m = STRIP.exec(html); m; m = STRIP.exec(html)) {
    if (m.index > last) tLen = pushTextRun(segments, parts, tLen, html, last, m.index)
    segments.push({
      kind: "gap",
      tStart: tLen,
      tEnd: tLen + 1,
      rStart: m.index,
      rEnd: m.index + m[0].length,
    })
    parts.push(" ")
    tLen += 1
    last = m.index + m[0].length
  }
  if (last < html.length) tLen = pushTextRun(segments, parts, tLen, html, last, html.length)
  return { text: parts.join(""), segments }
}

/** The segment containing text offset `t` (binary search; segments are contiguous). */
const segmentAt = (segments: Segment[], t: number): Segment | null => {
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = segments[mid] as Segment
    if (t < s.tStart) hi = mid - 1
    else if (t >= s.tEnd) lo = mid + 1
    else return s
  }
  return null
}

/**
 * Map a [start, end) span of the projection back to raw-source offsets. Refuses a
 * span that includes a `gap` (it would cross a tag — a structural change, not a text
 * edit) or that starts/ends INSIDE an entity's decoded characters (you can't splice
 * half of `&amp;#128064;`).
 */
const spanToRaw = (
  segments: Segment[],
  start: number,
  end: number,
  label: string,
): { rStart: number; rEnd: number } => {
  const first = segmentAt(segments, start)
  const lastSeg = segmentAt(segments, end - 1)
  if (!first || !lastSeg)
    throw new EditError(`${label} failed: the matched text fell outside the document.`)
  // Every segment the span touches must be visible text — a gap inside means the
  // selection crosses an element boundary in the source.
  for (let i = segments.indexOf(first); ; i++) {
    const s = segments[i] as Segment
    if (s.kind === "gap")
      throw new EditError(
        `${label} failed: the selection crosses formatting or element boundaries in the source — edit a smaller run of plain text, or open the source editor.`,
      )
    if (s === lastSeg) break
  }
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

const escapeHtmlText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Apply quote-scoped edits to `src` atomically. Every quote is resolved against the
 * ORIGINAL source (markdown: the source itself; HTML/deck: the tag-stripped
 * projection, mapped back to raw offsets), spans are checked for overlap, and the
 * splices land back-to-front — so one batch's edits can never shift each other's
 * targets. Any failure throws `EditError` (with which edit and why) and applies
 * nothing, matching `applyEdits`' contract.
 */
export function applyQuoteEdits(src: string, contentType: string, edits: QuoteEdit[]): string {
  if (!edits.length) return src
  const ct = (contentType || "").split(";")[0]?.trim()
  const isHtml = ct === "text/html" || ct === "text/x-derive-deck"
  let text = src
  let segments: Segment[] | null = null
  if (isHtml) {
    const mapped = pageTextWithMap(src)
    // The projection must be byte-identical to the one comment anchors resolve
    // against — if the two scanners ever disagree, refuse rather than splice at
    // offsets that mean something else.
    if (mapped.text !== pageText(src))
      throw new EditError(
        "This document's text projection couldn't be mapped safely — open the source editor to make this change.",
      )
    text = mapped.text
    segments = mapped.segments
  }

  const spans: { rStart: number; rEnd: number; replacement: string; label: string }[] = []
  for (const [i, e] of edits.entries()) {
    const label = `Edit ${i + 1} of ${edits.length}`
    const exact = e.quote.exact
    if (!exact.trim()) throw new EditError(`${label} failed: the quoted text is empty.`)
    // Context first (prefix + exact + suffix pins WHICH occurrence); a context miss
    // is acceptable only when the exact text appears exactly once in the document.
    let span = findQuoteContextOnly(text, exact, e.quote.prefix, e.quote.suffix)
    if (!span) {
      const all = findQuoteMatches(text, exact)
      if (all.length === 1) span = all[0] as { start: number; end: number }
      else if (all.length === 0)
        throw new EditError(
          `${label} failed: "${clip(exact)}" wasn't found — the document may have changed. Re-read and retry.`,
        )
      else
        throw new EditError(
          `${label} failed: "${clip(exact)}" appears ${all.length} times and the surrounding context didn't pin one down.`,
        )
    }
    const raw = segments
      ? spanToRaw(segments, span.start, span.end, label)
      : { rStart: span.start, rEnd: span.end }
    spans.push({
      ...raw,
      replacement: isHtml ? escapeHtmlText(e.new_text) : e.new_text,
      label,
    })
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
