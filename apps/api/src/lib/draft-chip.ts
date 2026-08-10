/**
 * Serve-time chrome for anonymous drafts (see lib/drafts.ts): a small fixed
 * chip on every served draft page carrying attribution plus the expiry nudge,
 * and the branded tombstone an expired draft's URL serves. Injected at serve
 * time only — never part of the stored bytes — and gone the moment the draft
 * is claimed (claiming clears `expires_at`, the one signal that gates it).
 *
 * Discovery, not capability. The chip links the viewer to the app origin;
 * the claim capability stays the single-use token from the mint response.
 * Nothing on the public page can claim, so showing the chip to every viewer
 * widens who can *find* Derive, never who can take the draft.
 *
 * The link is same-tab on purpose: draft bytes carry the sandbox CSP
 * (`allow-popups` without `allow-popups-to-escape-sandbox`), so a
 * target=_blank popup would inherit the sandbox — no cookies, no storage —
 * and open a broken app. A same-tab navigation loads the destination fresh,
 * outside the sandbox.
 */

// Attribute-escape a server-config string (baseUrl) — order matters: & first.
const attr = (s: string): string => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;")

/** The `?src=` campaign token the signup-attribution middleware records
 *  (lib/attribution.ts) when a chip click turns into a signup. */
const SRC = "draft_chip"

/**
 * The chip appended to every HTML page of a live draft. Inline-styled and
 * self-contained: the sandbox CSP allows no external requests on our behalf,
 * and page CSS can't reach into inline styles. Dark regardless of the page's
 * own theme — the "Made with X" badge idiom (see web's PublicFrame): quiet
 * attribution + a soft nudge, never a wall.
 */
export const draftChip = (expiresAt: string, baseUrl: string): string => {
  const hours = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 3600_000))
  const href = attr(`${baseUrl}/?src=${SRC}`)
  return (
    `<a data-derive-draft-chip href="${href}" ` +
    `title="An unclaimed draft on Derive. Claim it with the link your publish returned — claimed artifacts keep a permanent, versioned URL." ` +
    `style="position:fixed;right:14px;bottom:14px;z-index:2147483647;display:inline-flex;align-items:center;gap:8px;` +
    `padding:7px 12px;border-radius:999px;background:#101216;color:#f3f4f6;border:1px solid #2c2f36;` +
    `font:500 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.02em;text-decoration:none;` +
    `box-shadow:0 2px 12px rgba(0,0,0,.3)">` +
    `Made with Derive<span style="color:#969aa2">· expires in ~${hours}h</span></a>`
  )
}

/**
 * The page an expired draft's URL serves with its 410 — a shared link that
 * outlived its draft should say what this was and where to go, not dead-end
 * in a text line. Same visual register as the chip; no external requests.
 */
export const expiredDraftPage = (baseUrl: string): string => {
  const href = attr(`${baseUrl}/?src=${SRC}`)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>This draft expired</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0b0d;color:#f3f4f6;font:16px/1.6 ui-sans-serif,system-ui,sans-serif">
<main style="max-width:34em;padding:48px 24px;text-align:center">
<p style="margin:0;font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;color:#969aa2">DERIVE · ANONYMOUS DRAFT</p>
<h1 style="margin:18px 0 0;font-size:28px;letter-spacing:-.01em">This draft expired — it was never claimed.</h1>
<p style="margin:14px 0 0;color:#969aa2">Anonymous drafts live for 72 hours unless they're claimed into a workspace, where they keep a permanent URL and every version.</p>
<p style="margin:26px 0 0"><a href="${href}" style="color:#f3f4f6">Publish another in one command →</a></p>
<pre style="margin:14px 0 0;padding:12px 16px;display:inline-block;text-align:left;background:#101216;border:1px solid #2c2f36;border-radius:8px;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#f3f4f6;overflow-x:auto;max-width:100%">curl -F file=@page.html ${attr(baseUrl)}/v1/drafts</pre>
</main></body></html>`
}
