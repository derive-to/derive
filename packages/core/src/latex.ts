import type { BundleManifest } from "./ports"

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
