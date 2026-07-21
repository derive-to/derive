// Publish advisories: pure string checks over just-published content, returned with
// the publish response (response text reaches agents far more reliably than tool
// descriptions do). The REST route carries them as a field; both MCP servers fold
// them into their notes.

import { needsReflow } from "./reflow"

/** Advisory strings for a just-published single file — empty when nothing to say. */
export const publishAdvisories = (content: string, contentType: string): string[] => {
  const out: string[] = []

  // A page with no viewport meta gets the mobile-reflow injection, whose media
  // caps can fight an intentional layout (see reflow.ts).
  if (contentType === "text/html" && needsReflow(content))
    out.push(
      'This page has no <meta name="viewport">, so Derive injects mobile-reflow CSS ' +
        "(its media caps can fight intentional layouts; data-reflow-exempt on an element " +
        "opts a component out). Declare your own viewport meta to skip the injection.",
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
