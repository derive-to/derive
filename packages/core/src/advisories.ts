// Publish advisories: pure string checks over just-published content, returned with
// the publish response (response text reaches agents far more reliably than tool
// descriptions do). The REST route carries them as a field; both MCP servers fold
// them into their notes. Plan: docs/plans/agent-artifact-learnings.md §4.

import { looksLikeHtmlDocument } from "./publish"
import { needsReflow } from "./reflow"

/** Advisory strings for a just-published single file — empty when nothing to say. */
export const publishAdvisories = (content: string, contentType: string): string[] => {
  const out: string[] = []

  // Reflow is opt-in as of [Q2] (2026-07-13): a viewport-less page now serves
  // byte-faithful, which means phones render it zoomed-out. Nudge, don't mutate.
  if (contentType === "text/html" && needsReflow(content))
    out.push(
      'This page has no <meta name="viewport">, so phones will render it zoomed-out. ' +
        "Add your own viewport meta (best), or republish with reflow:true to let Derive " +
        "inject conservative mobile-reflow CSS at serve time (data-reflow-exempt opts an " +
        "element out).",
    )

  // Extension/content mismatch: a full HTML document stored under a markdown type
  // (an explicit .md filename overrode the sniffer) renders as ESCAPED SOURCE, not
  // a page — the second half of the retype-incident class the filename sniffer
  // (#416) fixed for the filename-less path.
  if (contentType === "text/markdown" && looksLikeHtmlDocument(content))
    out.push(
      "The content is a full HTML document but the filename typed it as markdown, so " +
        "it will render as escaped source instead of a page. If it should render, " +
        "republish with an .html filename.",
    )

  // Large inlined base64 usually means binaries were pasted through a tool call
  // instead of staged via /v1/assets. The threshold keeps icon-sized data URIs quiet.
  let base64Chars = 0
  for (const m of content.matchAll(/data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)/g))
    base64Chars += (m[1] ?? "").length
  if (base64Chars > 16 * 1024)
    out.push(
      `~${Math.round(base64Chars / 1024)}KB of inline base64 data URIs — upload binaries ` +
        "(images, woff2 fonts) to POST /v1/assets and reference the returned URLs instead: " +
        "base64 carried through a tool call costs tokens and can be silently mistranscribed.",
    )

  return out
}
