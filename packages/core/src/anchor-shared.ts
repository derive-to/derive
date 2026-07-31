/**
 * Isomorphic anchoring primitives — the code that MUST produce byte-identical results
 * in the browser (against a live DOM, inside the sandboxed iframe client) and on the
 * server (against parsed HTML descriptors). Both `anchor-client.ts` (the injected
 * client) and `element-anchor.ts` (the server resolver) import from here, so a content
 * fingerprint made in one place equals one made in the other BY CONSTRUCTION — not by
 * hand-copying a vanilla-JS transcription and hoping it stays in lockstep (which drifted
 * once: a different join separator silently broke every browser-made element anchor).
 *
 * Keep this file dependency-free and DOM-free so it bundles cleanly into the browser
 * client and runs untouched on the server.
 */

/** Field separator inside a content fingerprint, so a value ending and the next
 *  beginning can't blur into a collision (src "…a" + alt "b" vs src "…" + alt "ab").
 *  A control char (U+0001) that never appears in real content. */
export const FP_SEP = "\u0001"

/** Cap on the text slice that feeds a fingerprint — enough to identify, bounded so a
 *  huge block doesn't dominate the hash. */
export const FP_TEXT_CAP = 120

/**
 * FNV-1a (32-bit) → base36. A tiny, fast, dependency-free hash — we only need a stable
 * content fingerprint, not cryptographic strength.
 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(36)
}

/** Collapse runs of whitespace and trim. Used everywhere a value feeds matching. */
export function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Ellipsis-truncate to `n` chars. The one copy of the convention (cut at n-1, "…"),
 *  shared by anchor labels, edit error copy, and version messages. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The canonical content fingerprint over the four identifying fields. Each side pulls
 * {tag, src, alt, text} from its own environment — a live DOM node in the browser, a
 * parsed descriptor on the server — then calls this, so the hash ASSEMBLY (the field
 * order, the separator, the text normalization + cap) lives in exactly one place.
 */
export function fingerprintFrom(tag: string, src: string, alt: string, text: string): string {
  return fnv1a([tag, src, alt, normWs(text).slice(0, FP_TEXT_CAP)].join(FP_SEP))
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Locate `quote` inside `text`, tolerating any difference in WHITESPACE between them.
 * A quote that spans block elements serializes its inter-block gaps differently in each
 * place it's read — a browser Selection renders them as "\n\n", concatenated DOM text
 * nodes carry the source indentation ("\n    "), and HTML source has yet another form —
 * so a strict indexOf is far too brittle (it silently orphaned every multi-element
 * comment). Here each run of whitespace in the quote matches ANY run of whitespace in
 * the text; everything else matches literally. Returns the [start, end) offsets of the
 * match in `text`, or null. Deterministic, no ML — the same primitive the browser client
 * and the server resolver both call, so a quote resolves identically on both.
 */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  return findQuoteWithContext(text, quote)
}

/** Whitespace-flexible regex source for a literal string: escape to a literal pattern
 *  (never introduces whitespace), then let every whitespace run flex to `\s+`. */
const flexPattern = (s: string): string => escapeRe(s).replace(/\s+/g, "\\s+")

/** The one context pattern both the lenient (highlight) and strict (edit) matchers
 *  compile: prefix + (exact) + suffix, whitespace-flexible, exact captured so the
 *  `d` (indices) flag exposes its span directly. Null when there is no context at
 *  all, or the pattern fails to compile. Kept as the single builder so the join
 *  grammar (`\s+` at each seam) cannot drift between the read and write sides. */
const contextPattern = (q: string, pre: string, suf: string, flags: string): RegExp | null => {
  if (!pre && !suf) return null
  try {
    const joinPre = pre ? `${flexPattern(pre)}\\s+` : ""
    const joinSuf = suf ? `\\s+${flexPattern(suf)}` : ""
    return new RegExp(`${joinPre}(${flexPattern(q)})${joinSuf}`, flags)
  } catch {
    return null
  }
}

type CaptureMatch = RegExpExecArray & { indices?: Array<[number, number]> }

/**
 * Locate `exact` in `text` whitespace-flexibly, using `prefix`/`suffix` as CONTEXT to
 * disambiguate a quote that repeats — then return the span of `exact` itself (not the
 * context). An `exact` that also appears inside the prefix can't hijack the result
 * (the capture group's own indices are read). Falls back to the bare exact anywhere
 * when the context doesn't resolve. The single primitive both the browser client and
 * the server call, so a quote resolves identically on both. Returns null if unfound.
 */
export function findQuoteWithContext(
  text: string,
  exact: string,
  prefix?: string,
  suffix?: string,
): { start: number; end: number } | null {
  const q = exact.trim()
  if (!q) return null
  const re = contextPattern(q, (prefix ?? "").trim(), (suffix ?? "").trim(), "d")
  if (re) {
    const m = re.exec(text) as CaptureMatch | null
    const gi = m?.indices?.[1]
    if (gi) return { start: gi[0], end: gi[1] }
  }
  // Exact anywhere (no/failed context).
  try {
    const m = new RegExp(flexPattern(q)).exec(text)
    return m ? { start: m.index, end: m.index + m[0].length } : null
  } catch {
    const i = text.indexOf(q)
    return i >= 0 ? { start: i, end: i + q.length } : null
  }
}

/**
 * The STRICT context matcher for destructive callers: the context must match
 * exactly ONCE. Two identical repeated cards produce two identical context
 * windows — a lenient matcher would silently act on the first card when the user
 * touched the second, so `matches > 1` reports the ambiguity for the caller to
 * refuse. `span` is null on a miss (no context given, pattern failed, or zero
 * matches) — pair with {@link findQuoteMatches} to accept a miss only when the
 * exact is globally unambiguous.
 */
export function findQuoteContextUnique(
  text: string,
  exact: string,
  prefix?: string,
  suffix?: string,
): { span: { start: number; end: number } | null; matches: number } {
  const q = exact.trim()
  if (!q) return { span: null, matches: 0 }
  const re = contextPattern(q, (prefix ?? "").trim(), (suffix ?? "").trim(), "dg")
  if (!re) return { span: null, matches: 0 }
  const first = re.exec(text) as CaptureMatch | null
  const gi = first?.indices?.[1]
  if (!first || !gi) return { span: null, matches: 0 }
  // One more probe decides unique-vs-ambiguous; the exact count past 2 is unneeded.
  if (first.index === re.lastIndex) re.lastIndex++ // zero-width safety
  const second = re.exec(text)
  return { span: second ? null : { start: gi[0], end: gi[1] }, matches: second ? 2 : 1 }
}

/**
 * Every whitespace-flexible match of `quote` in `text` (capped so a degenerate quote
 * on a huge document stays bounded). Lets a destructive caller distinguish "matches
 * once — safe to act on" from "matches many — ambiguous, refuse".
 */
export function findQuoteMatches(
  text: string,
  quote: string,
  cap = 20,
): { start: number; end: number }[] {
  const q = quote.trim()
  if (!q) return []
  const out: { start: number; end: number }[] = []
  try {
    const re = new RegExp(flexPattern(q), "g")
    for (let m = re.exec(text); m && out.length < cap; m = re.exec(text)) {
      out.push({ start: m.index, end: m.index + m[0].length })
      // A zero-width match can't happen (q is non-empty), but never trust lastIndex
      // to advance on its own with pathological inputs.
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1
    }
  } catch {
    let i = text.indexOf(q)
    while (i >= 0 && out.length < cap) {
      out.push({ start: i, end: i + q.length })
      i = text.indexOf(q, i + 1)
    }
  }
  return out
}
