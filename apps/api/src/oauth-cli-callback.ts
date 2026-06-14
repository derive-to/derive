// The hosted landing page for the CLI/native OAuth flow. A command-line client
// (`dock login`) can't host a public callback, but it shouldn't bounce you to
// localhost either — so it registers THIS page as its redirect_uri. After you
// approve consent, the authorization server sends the browser here with the
// one-time `code`; we display it for you to paste back into the terminal. The
// PKCE code_verifier never leaves the CLI, so the displayed code is useless to
// anyone else — it only completes the exchange paired with that local verifier.

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

const SHELL = (title: string, inner: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · Dock</title>
<style>
  :root{--bg:#f6f0e3;--card:#fffdf8;--ink:#1a1714;--mut:#6b6258;--line:#e7ddc9;--ac:#7c6cbd;--ac-ink:#fff;--good:#3c8f4e}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
    font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:24px}
  .card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:18px;
    padding:30px 30px 26px;box-shadow:0 10px 40px rgba(60,45,20,.10)}
  .logo{font-weight:700;letter-spacing:-.01em;font-size:15px;color:var(--mut);margin-bottom:20px;display:flex;align-items:center;gap:7px}
  h1{font-size:20px;line-height:1.3;letter-spacing:-.02em;margin:0 0 6px;font-weight:650}
  .sub{color:var(--mut);font-size:13.5px;margin:0 0 18px}
  .code{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:12px;background:#fbf7ee;padding:12px 14px}
  .code code{flex:1;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--ink)}
  .btn{padding:9px 14px;border-radius:9px;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;border:1px solid var(--ac);background:var(--ac);color:var(--ac-ink);transition:transform .04s,filter .15s;flex:none}
  .btn:active{transform:translateY(1px)} .btn:hover{filter:brightness(1.06)}
  .foot{color:var(--mut);font-size:12px;margin:18px 0 0}
  .err{color:#c0492b;font-size:13.5px;margin:0}
  kbd{background:#f1ead9;border-radius:5px;padding:1px 6px;font-size:.85em}
</style>
</head>
<body><main class="card">${inner}</main></body>
</html>`

/**
 * Render the CLI callback page. With a `code`, shows it for copy-paste back to the
 * terminal; with an `error`, shows the failure so the user isn't left on a blank
 * page. Either way it's a hosted Dock page — never a localhost redirect.
 */
export function cliCallbackHTML(props: { code?: string; error?: string }): string {
  if (props.error || !props.code) {
    const msg = esc(
      props.error || "No authorization code was returned. Please run `dock login` again.",
    )
    return SHELL(
      "Authorization failed",
      `<div class="logo">⚓ Dock</div>
      <h1>Authorization didn't complete</h1>
      <p class="err">${msg}</p>
      <p class="foot">Close this tab and re-run <kbd>dock login</kbd> in your terminal.</p>`,
    )
  }
  const code = esc(props.code)
  return SHELL(
    "Authorized",
    `<div class="logo">⚓ Dock</div>
    <h1>You're authorized</h1>
    <p class="sub">Copy this code and paste it back into your terminal to finish signing in.</p>
    <div class="code">
      <code id="code">${code}</code>
      <button class="btn" id="copy" type="button">Copy</button>
    </div>
    <p class="foot">This code only works paired with the verifier on your machine, and expires shortly. You can close this tab after copying.</p>
    <script>
      var b=document.getElementById("copy"),c=${JSON.stringify(props.code)};
      b.onclick=function(){navigator.clipboard&&navigator.clipboard.writeText(c);b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)};
    </script>`,
  )
}
