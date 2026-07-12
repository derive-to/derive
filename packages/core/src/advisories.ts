// Detection-driven publish advisories. A rule delivered in the publish RESPONSE, at
// the moment of the mistake, lands where a rule buried in a 200-word tool description
// doesn't — the agent reads results, then acts. Pure string checks over the content
// that was just published; both MCP servers append these to their response notes.
// (Plan: docs/plans/agent-artifact-learnings.md §4.)

import { needsReflow } from "./reflow"

/** Advisory strings for a just-published single file — empty when nothing to say. */
export const publishAdvisories = (content: string, contentType: string): string[] => {
  const out: string[] = []

  // A styled page with no viewport meta gets the mobile-reflow injection, whose
  // media caps can silently fight an intentional layout (see reflow.ts). Authors who
  // declared a viewport hear nothing.
  if (contentType === "text/html" && needsReflow(content))
    out.push(
      'This page has no <meta name="viewport">, so Derive injects mobile-reflow CSS ' +
        "(its media caps can fight intentional layouts; data-reflow-exempt on an element " +
        "opts a component out). Declare your own viewport meta to skip the injection.",
    )

  // Inlined base64 at scale means binaries rode through a tool call — the token-cost
  // and silent-mistranscription path the asset store exists to replace. Threshold set
  // well above icon-sized payloads so small data URIs stay quiet.
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
