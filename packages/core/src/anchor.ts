import { findQuoteWithContext } from "./anchor-shared"
import { isHtmlLike } from "./content-types"
import { elementResolvesIn, parseElementSelector } from "./element-anchor"
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
export const ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g
const ENTITY = ENTITY_RE
// The five XML entities plus the common named entities real prose/documentation
// actually uses (typographic punctuation, arrows, symbols) — found missing when
// deep-testing the converter against real Sift/Derive docs, which use middot,
// ndash, rarr, and curly quotes throughout. Unknown named entities still pass
// through untouched; this just widens what "known" covers.
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  bull: "•",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  shy: "­",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
}

/** Decode numeric character references and the common named entities the browser
 *  would. Unknown named entities pass through untouched. Shared by `pageText` and
 *  the doc-text markdown conversion so both read an `&amp;` the same way. */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (whole, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole
    }
    return NAMED[body] ?? whole
  })
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

const INVISIBLE_NAMES = ["script", "style", "noscript"]
const isWordChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c)

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
  out: PageTextSegment[],
  parts: string[],
  tLen: number,
  raw: string,
  rFrom: number,
  rTo: number,
): number => {
  const run = raw.slice(rFrom, rTo)
  let last = 0
  // A FRESH instance from the shared source: decodeEntities (called in this loop)
  // uses the module-level ENTITY, and a /g regex's lastIndex is shared state — one
  // object in both places restarts this exec loop from 0 forever.
  const entityRe = new RegExp(ENTITY_RE.source, "g")
  for (let m = entityRe.exec(run); m; m = entityRe.exec(run)) {
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
 * The page-text projection WITH its offset map: visible text plus, per run, where
 * it came from in the raw source. One linear indexOf-driven scan (no lazy-quantifier
 * regexes — those backtracked polynomially on crafted documents, CodeQL
 * js/polynomial-redos) is THE implementation: `pageText` is this function's `text`,
 * and the edit path's raw-offset mapping reads the same `segments`, so the read
 * side and the write side cannot disagree about what the projection is.
 *
 * Strip rules, tried in order at each "<" (the order the old regexes resolved to):
 * an invisible block (script/style/noscript, attrs to the FIRST ">", closed by the
 * first literal "</name>", case-insensitive), else a comment ("<!--" to the first
 * "-->"), else a bare tag (1+ non-">" chars before ">"); a "<" matching none stays
 * literal text. Each stripped construct collapses to one space; entities in text
 * runs decode via {@link decodeEntities}.
 */
export function pageTextParts(
  html: string,
  omitContentsOf: readonly string[] = INVISIBLE_NAMES,
): PageTextParts {
  const lower = html.toLowerCase()
  const findRaw = makeFinder(html)
  const findLower = makeFinder(lower)

  /** The strip token starting exactly at html[i] (which is "<"), or null when this
   *  "<" is literal text. */
  const stripTokenAt = (i: number): number | null => {
    // <!-- ... -->
    if (lower.startsWith("<!--", i)) {
      const close = findRaw("-->", i + 4)
      if (close >= 0) return close + 3
    }
    // <script|style|noscript ...> ... </same>
    for (const name of omitContentsOf) {
      if (!lower.startsWith(name, i + 1)) continue
      const after = i + 1 + name.length
      if (after < html.length && isWordChar(html[after] as string)) continue // \b
      const open = findRaw(">", after)
      if (open < 0) continue
      const close = findLower(`</${name}>`, open + 1)
      if (close >= 0) return close + name.length + 3
      // No closer: this alternative fails; fall through to the bare-tag rule.
    }
    // <[^>]+>
    const gt = findRaw(">", i + 1)
    if (gt > i + 1) return gt + 1
    return null
  }

  const segments: PageTextSegment[] = []
  const parts: string[] = []
  let tLen = 0
  let last = 0 // start of the pending text run
  let from = 0 // "<" search cursor
  for (;;) {
    const i = findRaw("<", from)
    if (i < 0) break
    const end = stripTokenAt(i)
    if (end === null) {
      from = i + 1 // a literal "<": it stays inside the text run
      continue
    }
    if (i > last) tLen = pushTextRun(segments, parts, tLen, html, last, i)
    segments.push({ kind: "gap", tStart: tLen, tEnd: tLen + 1, rStart: i, rEnd: end })
    parts.push(" ")
    tLen += 1
    last = end
    from = end
  }
  if (last < html.length) tLen = pushTextRun(segments, parts, tLen, html, last, html.length)
  return { text: parts.join(""), segments }
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
  return pageTextParts(html).text
}

/**
 * Reader prose for document-body mention detection. It intentionally omits code,
 * templates, form labels, and head metadata in addition to ordinary invisible
 * markup, matching the in-frame mention decorator's DOM filter.
 */
export function mentionText(html: string): string {
  return pageTextParts(html, MENTION_NON_PROSE_TAGS).text
}

// The comment-anchor client that runs inside the sandboxed artifact iframe. It is real,
// type-checked source in `anchor-client.ts` (which shares the fingerprint primitives with
// the server resolver via `anchor-shared`), bundled to a served IIFE string by
// scripts/build-anchor-client.mjs; CI keeps the generated file in sync (check-anchor-client).
export { ANCHOR_CLIENT_JS } from "./anchor-client.gen"

/** The tag appended to served artifact HTML; resolves on any host. */
export const SELECTION_SCRIPT = `<script src="/raw/derive-client.js"></script>`

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
  return isHtmlLike(contentType) ? { raw, text: pageText(raw) } : raw
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
