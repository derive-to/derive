// Auto-reflow for HTML artifacts that weren't built with mobile in mind. Applied at
// serve time (see apps/api serve-content), non-destructively: the stored bytes are never
// changed, we only inject into the served <head>.
//
// It is intentionally CONSERVATIVE and detection-gated. If the author already declared a
// viewport (they thought about mobile), we leave the page completely alone. Otherwise we
// add three things:
//   1. the viewport meta — many "desktop-only" pages are actually fluid and just missing
//      this tag, so a phone renders them at a 980px fallback and shrinks everything; the
//      tag alone makes that content reflow.
//   2. a small CSS reset that caps oversized media / wraps code / lets wide tables scroll
//      in their own box — i.e. it REFLOWS overflow rather than clipping it. We never set
//      `overflow:hidden` on the page (that would hide content the user can't get back to).
//   3. a tiny fit-to-width safeguard (FIT_SCRIPT): after layout, if the page STILL overflows
//      (a hard fixed-pixel layout the CSS couldn't reflow), it sets the viewport to the real
//      content width so the browser shrinks the whole page to fit — instead of leaving the
//      forced `device-width` that would make a fixed page need horizontal scrolling. So a
//      fluid page reflows to device-width and a fixed page shrinks cleanly to fit; either
//      way there's no sideways scroll, and a genuinely responsive page is never touched.

const VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1" data-derive-vp>'

// Runs in the sandboxed artifact frame (inline script is allowed under the `sandbox
// allow-scripts` CSP). It only ever touches OUR viewport meta (data-derive-vp), so an
// author's own viewport is never affected — and we only inject this on pages that had
// none. Resets to device-width, measures, and on real overflow switches the viewport to
// the content width (classic shrink-to-fit). Re-runs on load (late images/fonts) + resize.
const FIT_SCRIPT = `<script data-derive-reflow>
(function(){var m=document.querySelector('meta[data-derive-vp]');if(!m)return;
var DW='width=device-width, initial-scale=1';
function fit(){var d=document.documentElement,b=document.body,
w=Math.max(d.scrollWidth,b?b.scrollWidth:0),s=screen.width||d.clientWidth||9999;
m.setAttribute('content',w>s+8?'width='+Math.ceil(w):DW);}
var t;function sc(){clearTimeout(t);t=setTimeout(fit,120);}
if(document.readyState==='loading')addEventListener('DOMContentLoaded',fit);else fit();
addEventListener('load',sc);addEventListener('resize',sc);})();
</script>`

// Reflow CSS. `!important` on the media caps so an author's fixed pixel width on an <img>
// can't reintroduce horizontal overflow; tables become their own horizontal scroll region
// instead of blowing out the page; <pre> wraps instead of running off-screen.
//
// `data-reflow-exempt` on an element (or any ancestor) opts its subtree out of the
// media caps, for components that intentionally oversize media — e.g. a sprite crop
// scaling an <img> to 140% inside an overflow-hidden frame, which the `!important`
// cap would squash. The rest of the page keeps the overflow guarantee; the page-level
// opt-out remains declaring a viewport.
const REFLOW_CSS = `<style data-derive-reflow>
img:not([data-reflow-exempt],[data-reflow-exempt] *),video:not([data-reflow-exempt],[data-reflow-exempt] *),canvas:not([data-reflow-exempt],[data-reflow-exempt] *){max-width:100%!important;height:auto}
svg:not([data-reflow-exempt],[data-reflow-exempt] *),iframe:not([data-reflow-exempt],[data-reflow-exempt] *),embed:not([data-reflow-exempt],[data-reflow-exempt] *),object:not([data-reflow-exempt],[data-reflow-exempt] *){max-width:100%!important}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
table{display:block;max-width:100%;overflow-x:auto}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
</style>`

const INJECTION = `${VIEWPORT}${REFLOW_CSS}${FIT_SCRIPT}`

interface OpeningTag {
  index: number
  source: string
}

const findTagEnd = (html: string, from: number): number => {
  let quote: '"' | "'" | null = null
  for (let at = from; at < html.length; at++) {
    const char = html[at]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === ">") return at
  }
  return -1
}

const findOpeningTag = (html: string, name: string, from = 0): OpeningTag | null => {
  const lower = html.toLowerCase()
  const needle = `<${name}`
  let index = lower.indexOf(needle, from)
  while (index >= 0) {
    const boundary = lower[index + needle.length]
    if (
      boundary === ">" ||
      boundary === "/" ||
      boundary === " " ||
      boundary === "\t" ||
      boundary === "\n" ||
      boundary === "\r"
    ) {
      const end = findTagEnd(html, index + needle.length)
      return end < 0 ? null : { index, source: html.slice(index, end + 1) }
    }
    index = lower.indexOf(needle, index + needle.length)
  }
  return null
}

const attributeValue = (tag: string, wanted: string): string | null => {
  let at = 1
  while (at < tag.length && !/\s/.test(tag[at] ?? "")) at++
  while (at < tag.length) {
    while (/\s/.test(tag[at] ?? "")) at++
    if (tag[at] === ">" || (tag[at] === "/" && tag[at + 1] === ">")) return null
    const nameStart = at
    while (at < tag.length && !/[\s=/>]/.test(tag[at] ?? "")) at++
    const name = tag.slice(nameStart, at).toLowerCase()
    while (/\s/.test(tag[at] ?? "")) at++
    let value = ""
    if (tag[at] === "=") {
      at++
      while (/\s/.test(tag[at] ?? "")) at++
      const quote = tag[at] === '"' || tag[at] === "'" ? tag[at++] : null
      const valueStart = at
      if (quote) while (at < tag.length && tag[at] !== quote) at++
      else while (at < tag.length && !/[\s>]/.test(tag[at] ?? "")) at++
      value = tag.slice(valueStart, at)
      if (quote && tag[at] === quote) at++
    }
    if (name === wanted) return value
  }
  return null
}

/** Does this document already declare a viewport? If so the author considered mobile and
 *  we leave it untouched. Matches any `<meta name="viewport" ...>` (single/double/unquoted). */
const hasViewportMeta = (html: string): boolean => {
  let from = 0
  while (from < html.length) {
    const tag = findOpeningTag(html, "meta", from)
    if (!tag) return false
    if (attributeValue(tag.source, "name")?.toLowerCase() === "viewport") return true
    from = tag.index + tag.source.length
  }
  return false
}

/** True when the document looks like it was NOT built for mobile (no viewport declared) and
 *  is therefore a reflow candidate. Exported for serve-time gating + telemetry. */
export const needsReflow = (html: string): boolean => !hasViewportMeta(html)

/**
 * Inject the viewport tag + reflow CSS into a served HTML document, unless it already
 * declares a viewport. Inserts right after `<head>` (so the viewport is early and the reset
 * precedes author styles — author rules still win except where we use `!important`); falls
 * back to after `<html …>`, then to prepending, so a head-less fragment is still handled.
 * Returns the input unchanged when no reflow is needed.
 */
export const reflowHtml = (html: string): string => {
  if (!needsReflow(html)) return html
  const head = findOpeningTag(html, "head")
  if (head) {
    const at = head.index + head.source.length
    return html.slice(0, at) + INJECTION + html.slice(at)
  }
  const htmlTag = findOpeningTag(html, "html")
  if (htmlTag) {
    const at = htmlTag.index + htmlTag.source.length
    return `${html.slice(0, at)}<head>${INJECTION}</head>${html.slice(at)}`
  }
  return INJECTION + html
}
