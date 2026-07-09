import { findQuoteWithContext } from "./anchor-shared"
import { elementResolvesIn, parseElementSelector } from "./element-anchor"
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

// Tags whose content is invisible (script/style) or a fallback that shouldn't count as
// page text (noscript) — dropped whole before stripping the remaining tags.
const INVISIBLE_TAGS = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const ANY_TAG = /<[^>]+>/g
const ENTITY = /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g
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

/**
 * The visible text of an HTML page, for matching a text quote server-side — the
 * counterpart to the browser client's text-node concatenation. Drops script/style/
 * comment content, turns every remaining tag into a space (so words separated only by
 * markup — a multi-element quote — become whitespace-separated, which reanchor's
 * flexible match then spans), and decodes the common entities the browser would.
 * NOT a full HTML parser; findQuote's whitespace tolerance absorbs the small differences.
 */
export function pageText(html: string): string {
  return decodeEntities(
    html.replace(INVISIBLE_TAGS, " ").replace(HTML_COMMENT, " ").replace(ANY_TAG, " "),
  )
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
  const ct = contentType.split(";")[0]?.trim()
  return ct === "text/html" || ct === "text/x-derive-deck" ? { raw, text: pageText(raw) } : raw
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
