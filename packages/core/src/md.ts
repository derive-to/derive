import { marked } from "marked"
// xss is CJS; named ESM imports fail at runtime under Node's interop.
import xssPkg from "xss"
import { SELECTION_SCRIPT } from "./anchor"

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
// inside the sandboxed iframe, so it can't read the app's [data-theme] tokens and
// carries its own copy of the Derive palette. Monochrome + neutral, following the
// viewer's OS colour scheme (light default, dark via prefers-color-scheme) so it's
// never the old fixed "paper" page.
const PAGE_CSS = `
  :root{--paper:#f7f8fa;--panel:#eef1f4;--ink:#14161a;--soft:#565a63;--muted:#6b7079;
    --line:#e5e7eb;--line2:#eef0f3;--pre-bg:#101216;--pre-ink:#e7e8ea}
  @media(prefers-color-scheme:dark){:root{--paper:#0a0b0d;--panel:#16181d;--ink:#f3f4f6;
    --soft:#a0a4ac;--muted:#8b8f98;--line:#23252b;--line2:#1b1e22;--pre-bg:#05060a;--pre-ink:#e7e8ea}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  main{max-width:760px;margin:0 auto;padding:48px 28px 80px}
  h1,h2,h3,h4{line-height:1.15;letter-spacing:-.015em}
  h1{font-size:2.1em;margin:.2em 0 .6em} h2{font-size:1.5em;margin:1.6em 0 .5em}
  h3{font-size:1.18em;margin:1.4em 0 .4em}
  a{color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
  code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.88em;
    background:var(--line2);padding:1px 6px;border-radius:5px}
  pre{background:var(--pre-bg);color:var(--pre-ink);padding:16px 18px;border-radius:12px;overflow:auto;line-height:1.6}
  pre code{background:transparent;color:inherit;padding:0}
  blockquote{margin:1em 0;padding:.2em 1.1em;border-left:3px solid var(--line);color:var(--soft);
    background:var(--panel);border-radius:0 10px 10px 0}
  table{border-collapse:collapse;width:100%;font-size:.92em;background:var(--panel);
    border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line2)}
  th{font-size:.8em;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  tr:last-child td{border-bottom:0}
  img{max-width:100%;border-radius:10px}
  hr{border:0;border-top:1px solid var(--line);margin:2.2em 0}
`

/** XSS-sanitize an HTML fragment with Derive's content whitelist (drops scripts, styles,
 *  inline style/class attributes — so re-rendered content can't carry layout or JS). */
export const sanitizeHtml = (html: string): string => sanitizer.process(html)

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
