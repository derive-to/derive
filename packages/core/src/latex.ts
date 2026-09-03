import { headingSlugger } from "./doc-text"
import { LATEX_CSS } from "./latex-classes"
import type { DynamicValueLike, LatexTextSegment } from "./latex-emit"
import { type LatexRenderResult, latexTextProjection, renderLatexBody } from "./latex-render"
import { renderDocShell } from "./md"
import type { BundleManifest } from "./ports"
import { tapsPackageAdvisories } from "./taps-packages"

/**
 * LaTeX is the third SOURCE language Derive stores, beside Markdown and HTML. It keeps an
 * ordinary type (`text/x-derive-*` is reserved for HTML bytes that speak a Derive
 * protocol; a source language is not that), carries the same `; charset=utf-8`
 * parameter the other text types do through mime.ts, and is compared through
 * `isLatexLike` (content-types.ts), never by string equality on the raw value.
 */
export const LATEX_CONTENT_TYPE = "text/x-latex"

/** A multi-file paper: a bundle whose entry is a .tex file (main.tex + figures + .bib +
 *  class and style files). A distinct bundle type, like a skill, so the library can badge
 *  it without opening the manifest. */
export const LATEX_BUNDLE_ENTRY = "/main.tex"

/**
 * Does this text read as a LaTeX document? Line-anchored on purpose: a Markdown skill that
 * quotes `\documentclass` mid-sentence, or an HTML fragment mentioning `\begin{document}`
 * in prose, must not type as LaTeX. A chapter file with neither is still LaTeX when it is
 * NAMED .tex; the publish sniff checks the name first and this second, so an unnamed
 * payload (an MCP publish of inline content) is still caught.
 */
export const isLatexDocument = (text: string): boolean =>
  /^[ \t]*\\documentclass\s*[[{]/m.test(text) || /^[ \t]*\\begin\{document\}/m.test(text)

export const isLatexBundle = (manifest: Pick<BundleManifest, "entry">): boolean =>
  /\.tex$/i.test(manifest.entry)

/**
 * The math typesetter the rendered page loads, served from the API's own copy under
 * `/raw/vendor/katex/<version>/` (never a CDN: the artifact iframe is a null origin and
 * the deployment decides what it reaches). Pinned to the version apps/api installs; a
 * test keeps the two equal so a bump cannot leave pages requesting files that are not
 * there.
 */
export const KATEX_VERSION = "0.18.5"
export const KATEX_ASSET_BASE = `/raw/vendor/katex/${KATEX_VERSION}`

/** Files the vendor route may serve for KaTeX: the two bundles and its own fonts. */
export const KATEX_FILE_PATTERN =
  /^(katex\.min\.(js|css)|fonts\/KaTeX_[A-Za-z0-9-]+\.(woff2|woff|ttf))$/

// Typesets every placeholder once the page (and the deferred typesetter) has loaded.
// The TeX travels in an attribute, so the visible text of the page is prose only: what
// comment anchoring projects server-side (latexTextParts) is exactly what a reader can
// select before the typesetter runs. If KaTeX never arrives the source is shown instead.
const LATEX_MATH_BOOT = `(function(){function run(){var els=document.querySelectorAll('.derive-math[data-derive-math]');var macros={};try{var m=document.getElementById('derive-latex-macros');if(m)macros=JSON.parse(m.textContent||'{}')}catch(e){}var k=window.katex;for(var i=0;i<els.length;i++){var el=els[i];var tex=el.getAttribute('data-tex')||'';if(!k){el.textContent=tex;continue}try{k.render(tex,el,{displayMode:el.getAttribute('data-derive-math')==='display',throwOnError:false,macros:macros,trust:false,strict:'ignore',output:'html'})}catch(e){el.textContent=tex}}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run()})();`

/** The `<head>` additions of a rendered paper: its stylesheet and, when the document has
 *  math, the typesetter with the document's `\newcommand` macros. */
export const latexHead = (macros: Record<string, string>, hasMath: boolean): string => {
  const style = `<style>${LATEX_CSS}</style>`
  if (!hasMath) return style
  // `</script>` inside the JSON would end the island early; the escape is harmless to JSON.
  const island = JSON.stringify(macros).replace(/<\//g, "<\\/")
  return (
    `${style}<link rel="stylesheet" href="${KATEX_ASSET_BASE}/katex.min.css">` +
    `<script defer src="${KATEX_ASSET_BASE}/katex.min.js"></script>` +
    `<script type="application/json" id="derive-latex-macros">${island}</script>` +
    `<script>${LATEX_MATH_BOOT}</script>`
  )
}

export interface RenderLatexOptions {
  /** Dynamic slot values of the version being served, by name. */
  dynamic?: ReadonlyMap<string, DynamicValueLike>
  /** Bundle text files by path (`sec/intro.tex`, `refs.bib`, `main.bbl`). */
  resolve?: (path: string) => string | null
  /** A served URL for a bundle-relative image path. */
  imageUrl?: (path: string) => string | null
}

export interface RenderedLatex
  extends Pick<LatexRenderResult, "headings" | "bindings" | "diagnostics" | "profile" | "hasMath"> {
  /** The full document, ready to serve (shell + selection runtime). */
  html: string
  /** The `<article>` alone, for callers that wrap it themselves. */
  body: string
  title: string | null
}

/** Render a LaTeX source (single file or a bundle's entry) to the served page. */
export const renderLatex = (
  source: string,
  title: string | null = null,
  opts: RenderLatexOptions = {},
): RenderedLatex => {
  const r = renderLatexBody(source, { slug: headingSlugger(), ...opts })
  return {
    html: renderDocShell(r.html, title ?? r.title ?? "Paper", latexHead(r.macros, r.hasMath)),
    body: r.html,
    title: r.title,
    headings: r.headings,
    bindings: r.bindings,
    diagnostics: r.diagnostics,
    profile: r.profile,
    hasMath: r.hasMath,
  }
}

/** The visible text of the rendered page and how it maps onto the source: what comment
 *  re-anchoring and quote edits read for LaTeX, the way `pageTextParts` serves HTML and
 *  `markdownTextParts` serves Markdown. Math is a gap (its text is typeset client-side
 *  and never exists server-side), so a quote that crosses a formula cannot be edited
 *  and goes outdated on republish; prose and captions map 1:1. */
export const latexTextParts = (
  source: string,
  opts: RenderLatexOptions = {},
): { text: string; segments: LatexTextSegment[] } => latexTextProjection(source, opts)

const ADVISORY_LIMIT = 8

/** Publish-time advisories for a LaTeX version: what the renderer could not honour
 *  (unknown macros, missing figures, unresolved references) and, for acmart, packages
 *  ACM TAPS will refuse. Never throws. */
export const latexAdvisories = (source: string, opts: RenderLatexOptions = {}): string[] => {
  const out: string[] = []
  try {
    const r = renderLatexBody(source, { slug: headingSlugger(), ...opts })
    for (const d of r.diagnostics.slice(0, ADVISORY_LIMIT))
      out.push(`latex: line ${d.line}: ${d.message}`)
    if (r.diagnostics.length > ADVISORY_LIMIT)
      out.push(`latex: ${r.diagnostics.length - ADVISORY_LIMIT} more notices not shown`)
  } catch {
    out.push("latex: the document could not be read; the page shows its source")
  }
  out.push(...tapsPackageAdvisories(source))
  return out
}
