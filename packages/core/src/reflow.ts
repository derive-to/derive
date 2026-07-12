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

/** Does this document already declare a viewport? If so the author considered mobile and
 *  we leave it untouched. Matches any `<meta name="viewport" ...>` (single/double/unquoted). */
const hasViewportMeta = (html: string): boolean => /<meta[^>]+name=["']?viewport["']?/i.test(html)

/** True when the document looks like it was NOT built for mobile (no viewport declared) and
 *  is therefore a reflow candidate. Exported for serve-time gating + telemetry. */
export const needsReflow = (html: string): boolean => !hasViewportMeta(html)

// ---- Reader view ----------------------------------------------------------
// "Reader" strips the authored layout entirely and re-renders the content in Derive's
// responsive document shell — the universal answer for pages auto-reflow can't fix (hard
// fixed-pixel layouts) and the one that also works inside the in-app iframe viewer, where
// the viewport tag is ignored. Deliberately dependency-free (no Readability/DOM lib, so it
// stays edge-safe): pull out the <body>, drop <head>/<script>/<style>, and sanitize — which
// also removes inline style/class, so the author's fixed widths are gone and the content
// flows into the clean column. Best for the doc/report artifacts Derive holds (no nav/ads to
// strip); not a full article-extraction.

const stripBlocks = (html: string): string =>
  html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")

/** The document's title: <title> if present, else the first <h1>, else null. */
export const extractTitle = (html: string): string | null => {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  if (t?.trim()) return t.replace(/\s+/g, " ").trim()
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
  return h1
    ? h1
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim() || null
    : null
}

/**
 * Render an HTML document as a clean, responsive Reader view: extract its body content,
 * strip layout/head/scripts, sanitize (which removes inline styles + classes), and wrap it
 * in Derive's responsive shell. `render` is injected (renderDocShell) and `sanitize`
 * (sanitizeHtml) from the markdown module, so this stays a pure string transform that the
 * serve layer wires up.
 */
export const readerView = (
  html: string,
  render: (bodyHtml: string, title: string | null) => string,
  sanitize: (html: string) => string,
): string => {
  const title = extractTitle(html)
  const stripped = stripBlocks(html)
  const body = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? stripped
  return render(sanitize(body), title)
}

/**
 * Inject the viewport tag + reflow CSS into a served HTML document, unless it already
 * declares a viewport. Inserts right after `<head>` (so the viewport is early and the reset
 * precedes author styles — author rules still win except where we use `!important`); falls
 * back to after `<html …>`, then to prepending, so a head-less fragment is still handled.
 * Returns the input unchanged when no reflow is needed.
 */
export const reflowHtml = (html: string): string => {
  if (!needsReflow(html)) return html
  const head = html.match(/<head[^>]*>/i)
  if (head?.index !== undefined) {
    const at = head.index + head[0].length
    return html.slice(0, at) + INJECTION + html.slice(at)
  }
  const htmlTag = html.match(/<html[^>]*>/i)
  if (htmlTag?.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, at)}<head>${INJECTION}</head>${html.slice(at)}`
  }
  return INJECTION + html
}
