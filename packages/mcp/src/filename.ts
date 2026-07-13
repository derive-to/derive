// Choosing the upload filename for an inline `content` publish when the caller gave
// none. The Derive server types an artifact by its filename FIRST, so a blind
// `index.html` default silently stores Markdown as text/html — the page then renders
// the raw Markdown as markup and swallows tag-like text (the 2026-07 retype incident).
//
// These mirror the server's own sniff, inlined here because the stdio shim keeps NO
// @derive/core dependency at runtime (it is a thin HTTP client).

/** A full HTML document starts with `<!doctype html>` or `<html>`. Everything else
 *  (Markdown, plain text, an HTML fragment) is NOT one. */
export const looksLikeHtmlDocument = (s: string): boolean =>
  /^\s*<(!doctype\s+html|html)[\s>]/i.test(s.slice(0, 256))

/** The fallback filename for inline content with none given: a full HTML document →
 *  `index.html`, anything else → `index.md`. So Markdown is never stored as HTML.
 *  Caveat: a fragment-HTML artifact (not starting with a doctype) republished with no
 *  filename lands as `.md` — pass an explicit `filename` (or use `edits`) to keep it. */
export const fallbackFilename = (content: string | undefined): string =>
  looksLikeHtmlDocument(content ?? "") ? "index.html" : "index.md"
