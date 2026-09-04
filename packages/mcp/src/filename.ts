// Choosing the upload filename for an inline `content` publish when the caller gave
// none. The Derive server types an artifact by its filename FIRST, so a blind
// `index.html` default silently stores Markdown as text/html — the page then renders
// the raw Markdown as markup and swallows tag-like text (the 2026-07 retype incident).
//
// These mirror the server's own sniff, inlined here because the stdio shim keeps NO
// @derive/core dependency at runtime (it is a thin HTTP client).

/** An HTML page opener: the doctype/`<html>` markers, plus the head/meta/style/
 *  title/body openers a headless designed page starts with — matched after skipping
 *  leading HTML comments (a comment alone never decides). A leading `<div>`/`<p>`/
 *  custom tag is NOT one: that is how HTML-flavored Markdown (a centered README)
 *  legitimately opens. Mirrors @derive/core's looksLikeHtmlDocument exactly. */
export const looksLikeHtmlDocument = (s: string): boolean => {
  let head = s.replace(/^﻿/, "").trimStart()
  for (let i = 0; i < 8 && head.startsWith("<!--"); i++) {
    const end = head.indexOf("-->")
    if (end === -1) return false
    head = head.slice(end + 3).trimStart()
  }
  return /^<(!doctype\s+html|html|head|body|meta|style|title)[\s/>]/i.test(head.slice(0, 64))
}

/** A LaTeX document: `\documentclass` or `\begin{document}` at a line start. Mirrors
 *  @derive/core's isLatexDocument exactly (line-anchored so prose quoting the macro
 *  does not count). */
export const isLatexDocument = (s: string): boolean =>
  /^[ \t]*\\documentclass\s*[[{]/m.test(s) || /^[ \t]*\\begin\{document\}/m.test(s)

/** The fallback filename for inline content with none given: an HTML page →
 *  `index.html`, a LaTeX document → `index.tex`, anything else → `index.md`. So
 *  Markdown is never stored as HTML and a paper is never stored as Markdown.
 *  Caveat: fragment HTML that opens with a `<div>` (indistinguishable from
 *  HTML-flavored Markdown) still lands as `.md` — pass an explicit
 *  `filename` (or use `edits`) to keep it HTML. */
export const fallbackFilename = (content: string | undefined): string =>
  looksLikeHtmlDocument(content ?? "")
    ? "index.html"
    : isLatexDocument(content ?? "")
      ? "index.tex"
      : "index.md"
