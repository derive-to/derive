// Publish advisories: checks over just-published content, returned with the publish
// response (response text reaches agents far more reliably than tool descriptions
// do). The REST route carries them as a field; both MCP servers fold them into
// their notes. Advisories NEVER block or fail a publish — they exist because the
// silent-breakage shapes below each actually shipped and were only caught by
// looking at the render afterward: correct-by-construction beats
// correct-by-vigilance.

import type { BlobStore } from "./ports"
import { needsReflow } from "./reflow"

/** Advisory strings for a just-published single file — empty when nothing to say. */
export const publishAdvisories = (content: string, contentType: string): string[] => {
  const out: string[] = []

  // A temporary asset UPLOAD url (the mint-and-curl target) embedded as if it were
  // the permanent asset URL — it expires in minutes, so every image breaks shortly
  // after publish. The permanent `url` (or `ref`) comes back from the upload itself.
  if (/\/v1\/assets\/t\//.test(content))
    out.push(
      "The content embeds a temporary asset UPLOAD url (…/v1/assets/t/…), which expires in " +
        "minutes — embed the permanent `url` (or `ref`) returned by the upload instead.",
    )

  // HTML page markup stored as markdown: the markdown renderer strips/escapes
  // <style>/<head> content, so the page shows its CSS as visible text. (The type
  // sniffer catches page-shaped OPENERS; this catches page markup deeper in a
  // markdown-typed doc.)
  if (contentType === "text/markdown" && /<style[\s>]|<meta\s+name=["']viewport["']/i.test(content))
    out.push(
      "Stored as markdown, but the content contains HTML page markup (<style>/<meta viewport>) — " +
        'if this is a styled page, republish with filename:"index.html" so it renders as HTML.',
    )

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

/** How many embedded blob refs the existence check verifies per publish — a
 *  gallery page must not turn one publish into a hundred store lookups. */
const BLOB_CHECK_CAP = 12

/** Matches an embedded content-addressed asset URL (absolute or relative) and
 *  captures the 64-hex key; the extension is display sugar, the key is the ref. */
const BLOB_REF = /\/blob\/([0-9a-f]{64})(?:\.[a-z0-9]+)?/gi

/** The one advisory that needs I/O: embedded /blob/ URLs whose bytes don't exist —
 *  a hand-typed or mistranscribed hash renders as a 404 image. Only runs when the
 *  store can answer cheaply (`has` is a stat/HEAD); a store without `has` skips the
 *  check rather than falling back to body reads. Returns null when all refs
 *  resolve. Never throws — a store hiccup must not fail the publish. */
export const missingBlobAdvisory = async (
  content: string,
  blobs: BlobStore,
): Promise<string | null> => {
  if (!blobs.has) return null
  try {
    const keys = [
      ...new Set([...content.matchAll(BLOB_REF)].map((m) => (m[1] as string).toLowerCase())),
    ]
    const missing: string[] = []
    for (const key of keys.slice(0, BLOB_CHECK_CAP)) if (!(await blobs.has(key))) missing.push(key)
    if (!missing.length) return null
    return (
      `${missing.length} embedded asset URL(s) reference blobs that don't exist ` +
      `(${missing.map((k) => `${k.slice(0, 12)}…`).join(", ")}) — those images will 404. ` +
      "Upload the bytes via the assets endpoint and embed the returned permanent url."
    )
  } catch {
    return null
  }
}
