/** A W3C Web Annotation TextQuoteSelector — survives republishing. */
export interface QuoteSelector {
  type: "TextQuoteSelector"
  exact: string
  prefix?: string
  suffix?: string
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
 * 1) exact match with prefix+suffix context, 2) exact match anywhere,
 * 3) not found → orphaned. Deterministic, no ML.
 */
export function reanchor(sel: QuoteSelector, text: string): Reanchor {
  if (!sel.exact) return { found: false, index: -1 }
  const withContext = `${sel.prefix ?? ""}${sel.exact}${sel.suffix ?? ""}`
  if (withContext !== sel.exact) {
    const i = text.indexOf(withContext)
    if (i >= 0) return { found: true, index: i + (sel.prefix?.length ?? 0) }
  }
  const j = text.indexOf(sel.exact)
  return j >= 0 ? { found: true, index: j } : { found: false, index: -1 }
}

/**
 * Injected into served artifacts. On text selection it posts a quote selector
 * to the parent window — the only way to anchor across a sandboxed iframe.
 */
export const SELECTION_SCRIPT = `<script>(function(){document.addEventListener("mouseup",function(){
var s=window.getSelection(),t=s?s.toString().trim():"";
if(!t||t.length<2){parent.postMessage({source:"dock",type:"select",selector:null},"*");return}
var ctx=(s.anchorNode&&s.anchorNode.textContent)||t,i=ctx.indexOf(t);
parent.postMessage({source:"dock",type:"select",selector:{type:"TextQuoteSelector",exact:t,
prefix:i>=0?ctx.slice(Math.max(0,i-24),i):"",suffix:i>=0?ctx.slice(i+t.length,i+t.length+24):""}},"*")})})();</script>`

/** True if the comment's stored anchor still resolves in `text`. */
export function isAnchored(anchorJson: string | null, text: string): boolean {
  if (!anchorJson) return true
  try {
    const sel = JSON.parse(anchorJson) as QuoteSelector
    if (sel.type !== "TextQuoteSelector" || !sel.exact) return true
    return reanchor(sel, text).found
  } catch {
    return true
  }
}
