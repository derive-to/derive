import { DRAFT_TTL_MS } from "./drafts"

/**
 * Serve-time chrome for anonymous drafts (lib/drafts.ts): the attribution chip
 * appended to every served draft page, and the tombstone an expired draft's
 * URL serves. Gated on `expires_at` — only unclaimed drafts carry one — so it
 * all disappears the moment a draft is claimed. Injected at serve time like
 * the anchor client, never part of the stored bytes.
 *
 * Two constraints shape the markup:
 * - Discovery only. The chip links the viewer to the app origin; claiming
 *   stays the single-use token from the mint response.
 * - Same-tab link. Draft bytes carry the sandbox CSP with `allow-popups` but
 *   not `allow-popups-to-escape-sandbox`, so a target=_blank popup would
 *   inherit the sandbox (no cookies, no storage) and open a broken app.
 */

// baseUrl is operator config, not user input; escaped on principle.
const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")

/** The `?src=` token lib/attribution.ts records when a chip visit becomes a signup. */
const SRC = "draft_chip"

const TTL_HOURS = DRAFT_TTL_MS / 3600_000

/**
 * Inline-styled and self-contained — the sandbox CSP blocks external requests,
 * and page CSS can't reach into inline styles. Dark whatever the page's own
 * theme: the "Made with X" badge idiom (web's PublicFrame), attribution + a
 * soft nudge, never a wall.
 */
export const draftChip = (expiresAt: string, baseUrl: string): string => {
  const hours = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 3600_000))
  return (
    `<a data-derive-draft-chip href="${esc(`${baseUrl}/?src=${SRC}`)}" ` +
    `title="An unclaimed draft on Derive. Claim it with the link your publish returned — claimed artifacts keep a permanent, versioned URL." ` +
    `style="position:fixed;right:14px;bottom:14px;z-index:2147483647;display:inline-flex;align-items:center;gap:8px;` +
    `padding:7px 12px;border-radius:999px;background:#101216;color:#f3f4f6;border:1px solid #2c2f36;` +
    `font:500 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.02em;text-decoration:none;` +
    `box-shadow:0 2px 12px rgba(0,0,0,.3)">` +
    `Made with Derive<span style="color:#969aa2">· expires in ~${hours}h</span></a>`
  )
}

/** The 410 an expired draft's URL serves: what this was, and the one-line republish. */
export const expiredDraftPage = (baseUrl: string): string => {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>This draft expired</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0b0d;color:#f3f4f6;font:16px/1.6 ui-sans-serif,system-ui,sans-serif">
<main style="max-width:34em;padding:48px 24px;text-align:center">
<p style="margin:0;font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;color:#969aa2">DERIVE · ANONYMOUS DRAFT</p>
<h1 style="margin:18px 0 0;font-size:28px;letter-spacing:-.01em">This draft expired — it was never claimed.</h1>
<p style="margin:14px 0 0;color:#969aa2">Anonymous drafts live for ${TTL_HOURS} hours unless they're claimed into a workspace, where they keep a permanent URL and every version.</p>
<p style="margin:26px 0 0"><a href="${esc(`${baseUrl}/?src=${SRC}`)}" style="color:#f3f4f6">Publish another in one command →</a></p>
<pre style="margin:14px 0 0;padding:12px 16px;display:inline-block;text-align:left;background:#101216;border:1px solid #2c2f36;border-radius:8px;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#f3f4f6;overflow-x:auto;max-width:100%">curl -F file=@page.html ${esc(baseUrl)}/v1/drafts</pre>
</main></body></html>`
}
