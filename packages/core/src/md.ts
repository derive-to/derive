import { marked } from "marked"
// xss is CJS; named ESM imports fail at runtime under Node's interop.
import xssPkg from "xss"
import { decodeEntities, SELECTION_SCRIPT } from "./anchor"

const { FilterXSS, whiteList } = xssPkg as unknown as typeof import("xss")

const sanitizer = new FilterXSS({
  whiteList: {
    ...whiteList,
    img: ["src", "alt", "title", "width", "height"],
    a: ["href", "name", "target", "rel", "title"],
    code: ["class"],
    pre: ["class"],
    input: ["type", "checked", "disabled"],
    th: ["align"],
    td: ["align"],
    details: [],
    summary: [],
    ins: [],
    del: [],
    sup: [],
    sub: [],
  },
})

// The rendered-artifact stylesheet (markdown + Reader view). Standalone — it ships
// inside the sandboxed iframe, so it can't read the app's [data-theme] tokens (or
// Tailwind's prose plugin), and carries its own copy of the Derive palette. The
// look is a hand-rolled version of the editorial prose style: medium-weight,
// tracked-tight headings with generous rhythm; soft body ink at a relaxed
// line-height; quiet underlined links; calm code. Follows the viewer's OS colour
// scheme (light default, dark via prefers-color-scheme).
const PAGE_CSS = `
  :root{--paper:#f7f8fa;--ink:#14161a;--body:#3f434a;--muted:#6b7079;--line:#e5e7eb;
    --code:#eceef2;--code-line:#e2e5ea}
  @media(prefers-color-scheme:dark){:root{--paper:#0a0b0d;--ink:#f3f4f6;--body:#c2c6cd;
    --muted:#8b8f98;--line:#23252b;--code:#16181d;--code-line:#23252b}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--body);
    font:16px/1.75 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  main{max-width:700px;margin:0 auto;padding:56px 24px 96px}
  h1,h2,h3,h4{color:var(--ink);font-weight:500;letter-spacing:-.02em;line-height:1.25}
  h1{font-size:2em;font-weight:600;margin:0 0 .6em}
  h2{font-size:1.5em;margin:2em 0 .7em}
  h3{font-size:1.22em;margin:1.6em 0 .5em}
  h4{font-size:1.05em;margin:1.4em 0 .4em}
  :is(h1,h2,h3,h4):first-child{margin-top:0}
  p{margin:1.15em 0}
  a{color:var(--ink);text-decoration:underline;text-decoration-thickness:1px;
    text-underline-offset:3px;text-decoration-color:var(--line);transition:text-decoration-color .15s}
  a:hover{text-decoration-color:var(--ink)}
  strong{color:var(--ink);font-weight:600}
  ul,ol{margin:1.5em 0;padding-left:1.4em}
  li{margin:.35em 0}
  li::marker{color:var(--muted)}
  code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em;
    background:var(--code);border:1px solid var(--code-line);padding:.1em .4em;border-radius:6px}
  pre{background:var(--code);border:1px solid var(--code-line);padding:16px 18px;border-radius:12px;
    overflow:auto;line-height:1.6;margin:1.6em 0}
  pre code{background:none;border:0;padding:0;font-size:.9em}
  blockquote{margin:1.6em 0;padding:.1em 0 .1em 1.1em;border-left:2px solid var(--line);color:var(--muted)}
  blockquote p{margin:.5em 0}
  table{border-collapse:collapse;width:100%;font-size:.92em;margin:1.6em 0}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line)}
  th{color:var(--ink);font-weight:600;font-size:.86em}
  img{max-width:100%;height:auto;border-radius:12px;margin:1.6em 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
  hr{border:0;border-top:1px solid var(--line);margin:3em 0}
`

/** XSS-sanitize an HTML fragment with Derive's content whitelist (drops scripts, styles,
 *  inline style/class attributes — so re-rendered content can't carry layout or JS). */
export const sanitizeHtml = (html: string): string => sanitizer.process(html)

/**
 * The ONE place a manual edit is allowed to carry markup, and the smallest set that
 * makes it worth having: emphasis and a link.
 *
 * Everywhere else, an inline edit's replacement is HTML-escaped before it goes near
 * the source — that escaping is the only thing between typed text and a served
 * document, because an HTML artifact is served verbatim (the sandbox CSP is the
 * containment, not a sanitizer). So the opening is deliberately narrow: five inline
 * tags, no attributes at all except a link's href, and every URL scheme refused
 * except the three a reader can follow. `javascript:` is unreachable twice over —
 * once by the scheme check here, once by xss's own filter underneath.
 *
 * Block tags, images, styles and classes are NOT in this list. Formatting a run of
 * words is the feature; introducing structure is not.
 */
const inlineSanitizer = new FilterXSS({
  // `br` is the one structural thing in the list, and it earns its place: pressing
  // Enter mid-sentence is the most reflexive edit there is, and blocking it outright
  // made the mode feel broken. A line break inside a block changes no structure the
  // document depends on — unlike a paragraph split, which is not here.
  whiteList: { b: [], strong: [], i: [], em: [], code: [], br: [], a: ["href"] },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
  onTagAttr: (tag, name, value) => {
    if (tag !== "a" || name !== "href") return ""
    const v = value.trim()
    const decoded = decodeEntities(v)
    // Browsers remove ASCII tabs/newlines while parsing URLs, so inspect a more
    // conservative normalized spelling. Otherwise `java&#9;script:` passes this
    // check and becomes `javascript:` when the document is opened.
    const schemeInput = [...decoded]
      .filter((char) => {
        const code = char.charCodeAt(0)
        return code > 0x20 && code !== 0x7f
      })
      .join("")
    // Network-path references are external URLs, not relative paths: `//host`
    // (and browser-normalized backslash variants) inherit the page's scheme while
    // switching origin, so they must not bypass the explicit scheme allowlist.
    if (/^[\\/]{2}/.test(schemeInput)) return ""
    // An absolute link must use a scheme a reader can follow, spelled out rather
    // than pattern-matched.
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(schemeInput)?.[0]?.toLowerCase()
    if (scheme && scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:") return ""
    return `href="${escapeHtml(decoded)}"`
  },
})
export const sanitizeInline = (html: string): string => inlineSanitizer.process(html)

/** Wrap clean body HTML in Derive's responsive document shell (the same mobile-safe
 *  typography the markdown renderer uses). Shared by renderMarkdown + Reader view. */
export const renderDocShell = (bodyHtml: string, title: string | null): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ?? "Document")}</title>
<style>${PAGE_CSS}</style>
</head>
<body><main>${bodyHtml}</main>${SELECTION_SCRIPT}</body>
</html>`

export async function renderMarkdown(source: string, title: string | null): Promise<string> {
  return renderDocShell(sanitizeHtml(await marked.parse(source, { gfm: true })), title)
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
