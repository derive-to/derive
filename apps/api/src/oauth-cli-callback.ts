// The hosted landing page for the CLI/native OAuth flow. A command-line client
// (`derive login`) can't host a public callback, but it shouldn't bounce you to
// localhost either — so it registers THIS page as its redirect_uri. After you
// approve consent, the authorization server sends the browser here with the
// one-time `code`; we display it for you to paste back into the terminal. The
// PKCE code_verifier never leaves the CLI, so the displayed code is useless to
// anyone else — it only completes the exchange paired with that local verifier.
//
// On the Derive palette (Inter, the anchor mark) so the auth experience feels like Derive.
import { BRAND_PAGE_MARK, BRAND_PAGE_TOKENS } from "./lib/brand-page-css"

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

// The Derive anchor mark, inline so the page is a single self-contained document.
const SHELL = (title: string, inner: { badge: string; body: string }): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · Derive</title>
<style>
  ${BRAND_PAGE_TOKENS}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:var(--ink);
    background:var(--paper);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");}
  .card{width:100%;max-width:460px;background:var(--panel);border:1px solid var(--line);border-radius:20px;
    padding:32px 32px 26px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 24px 60px -22px rgba(0,0,0,.28)}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
  .mk{height:26px;width:auto;display:block;flex:none}
  .brand .name{font-family:var(--display);font-weight:600;font-size:17px;letter-spacing:-.02em}
  .badge{margin-left:auto;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.05em;
    text-transform:uppercase;padding:4px 9px;border-radius:999px}
  .badge.ok{background:var(--good-soft);color:var(--good)}
  .badge.err{background:#f1e1d6;color:var(--bad)}
  h1{font-family:var(--display);font-weight:600;font-size:23px;line-height:1.2;letter-spacing:-.02em;margin:0 0 7px}
  .sub{color:var(--ink-soft);font-size:14px;margin:0 0 20px}
  .code{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:13px;
    background:var(--panel-2);padding:13px 15px}
  .code code{flex:1;font:13px/1.45 var(--mono);word-break:break-all;color:var(--ink);letter-spacing:.01em}
  .btn{padding:9px 15px;border-radius:10px;font:600 13px var(--sans);border:1px solid var(--accent);
    background:var(--accent);color:var(--accent-fg);flex:none;transition:transform .05s,filter .15s}
  .btn:active{transform:translateY(1px)} .btn:hover{filter:brightness(1.07)}
  .foot{color:var(--muted);font-size:12.5px;line-height:1.5;margin:20px 0 0}
  .err{color:var(--bad);font-size:14px;margin:0 0 4px;font-weight:500}
  kbd{font-family:var(--mono);background:var(--panel-2);border:1px solid var(--line-2);border-radius:6px;padding:1px 6px;font-size:.85em}
  ::selection{background:var(--accent-soft);color:var(--accent-ink)}
</style>
</head>
<body><main class="card">
  <div class="brand">${BRAND_PAGE_MARK}<span class="name">Derive</span>${inner.badge}</div>
  ${inner.body}
</main></body>
</html>`

/**
 * Render the CLI callback page. With a `code`, shows it for copy-paste back to the
 * terminal; with an `error`, shows the failure so the user isn't left on a blank
 * page. Either way it's a hosted Derive page — never a localhost redirect.
 */
export function cliCallbackHTML(props: { code?: string; error?: string }): string {
  if (props.error || !props.code) {
    const msg = esc(
      props.error || "No authorization code was returned. Please run `derive login` again.",
    )
    return SHELL("Authorization failed", {
      badge: `<span class="badge err">Failed</span>`,
      body: `<h1>Authorization didn't complete</h1>
      <p class="err">${msg}</p>
      <p class="foot">Close this tab and re-run <kbd>derive login</kbd> in your terminal to try again.</p>`,
    })
  }
  const code = esc(props.code)
  return SHELL("Authorized", {
    badge: `<span class="badge ok">Authorized</span>`,
    body: `<h1>You're authorized</h1>
    <p class="sub">Copy this code and paste it back into your terminal to finish signing in.</p>
    <div class="code">
      <code id="code">${code}</code>
      <button class="btn" id="copy" type="button">Copy</button>
    </div>
    <p class="foot">This code only works paired with the verifier on your machine and expires shortly. You can close this tab once you've copied it.</p>
    <script>
      var b=document.getElementById("copy"),c=${JSON.stringify(props.code)};
      b.onclick=function(){navigator.clipboard&&navigator.clipboard.writeText(c);b.textContent="Copied ✓";setTimeout(function(){b.textContent="Copy"},1600)};
    </script>`,
  })
}
