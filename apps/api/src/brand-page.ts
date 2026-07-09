// Shared chrome for the server-rendered, brand-styled setup/callback pages (GitHub
// App + Slack app setup). One source for the cream/navy card so the two flows can't
// drift — augmented with a code block + step list the Slack manifest page needs.
import { BRAND_PAGE_MARK, BRAND_PAGE_TOKENS } from "./lib/brand-page-css"

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

const STYLE = `<style>
  ${BRAND_PAGE_TOKENS}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:var(--ink);
    background:var(--paper);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:520px;background:var(--panel);border:1px solid var(--line);border-radius:20px;
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
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .btn{display:inline-block;padding:10px 17px;border-radius:10px;font:600 14px var(--sans);cursor:pointer;
    border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);text-decoration:none}
  .btn:hover{filter:brightness(1.07)}
  .btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
  .foot{color:var(--muted);font-size:12.5px;line-height:1.5;margin:20px 0 0}
  .err{color:var(--bad);font-size:14px;margin:0 0 4px;font-weight:500}
  code{font-family:var(--mono);font-size:.9em;background:rgba(0,0,0,.05);padding:1px 5px;border-radius:5px}
  ol.steps{margin:0 0 20px;padding-left:20px;color:var(--ink-soft);font-size:13.5px;line-height:1.7}
  ol.steps strong{color:var(--ink);font-weight:600}
  .code{position:relative;margin:0 0 18px}
  .code pre{margin:0;max-height:240px;overflow:auto;background:var(--paper);border:1px solid var(--line);
    border-radius:12px;padding:14px 15px;font-family:var(--mono);font-size:11.5px;line-height:1.5;color:var(--ink)}
  .code .copy{position:absolute;top:9px;right:9px;padding:5px 11px;border-radius:8px;font:600 12px var(--sans);
    cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
  .code .copy:hover{border-color:var(--accent)}
</style>`

export const brandShell = (title: string, badge: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · Derive</title>
${STYLE}</head>
<body><main class="card"><div class="brand">${BRAND_PAGE_MARK}<span class="name">Derive</span>${badge}</div>
${body}</main></body></html>`
