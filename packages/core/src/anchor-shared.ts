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

/**
 * The canonical content fingerprint over the four identifying fields. Each side pulls
 * {tag, src, alt, text} from its own environment — a live DOM node in the browser, a
 * parsed descriptor on the server — then calls this, so the hash ASSEMBLY (the field
 * order, the separator, the text normalization + cap) lives in exactly one place.
 */
export function fingerprintFrom(tag: string, src: string, alt: string, text: string): string {
  return fnv1a([tag, src, alt, normWs(text).slice(0, FP_TEXT_CAP)].join(FP_SEP))
}
