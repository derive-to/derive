// The OAuth consent screen Dock serves when an agent (an MCP client like Claude)
// asks to act on your behalf. The oauth-provider plugin redirects the signed-in
// user here (/oauth/consent?client_id&scope&code); on Approve we POST to
// /api/auth/oauth2/consent with the original query, and the plugin returns the
// browser to the client's redirect_uri with the authorization code. This is the
// human-in-the-loop grant: an agent can't self-authorize.

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "Your name and avatar",
  email: "Your email address",
  offline_access: "Stay connected without asking again (refresh access)",
  "dock:read": "Read your artifacts and comments",
  "dock:comment": "Comment on your artifacts",
  "dock:propose": "Propose new versions (you approve before they go live)",
  "dock:publish": "Publish new versions directly",
  "dock:review": "Approve or request changes on proposals",
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

/** The consent page HTML. `query` is the original authorize query string, echoed
 *  back to /oauth2/consent so the plugin can complete the authorization. */
export function consentHTML(props: {
  clientName: string
  scopes: string[]
  query: string
}): string {
  const name = esc(props.clientName || "An application")
  const items = props.scopes
    .map((s) => `<li><span class="tick">✓</span><span>${esc(SCOPE_LABELS[s] ?? s)}</span></li>`)
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Authorize ${name} · Dock</title>
<style>
  :root{--bg:#f6f0e3;--card:#fffdf8;--ink:#1a1714;--mut:#6b6258;--line:#e7ddc9;--ac:#7c6cbd;--ac-ink:#fff;--good:#3c8f4e}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
    font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:24px}
  .card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:18px;
    padding:30px 30px 24px;box-shadow:0 10px 40px rgba(60,45,20,.10)}
  .logo{font-weight:700;letter-spacing:-.01em;font-size:15px;color:var(--mut);margin-bottom:20px;display:flex;align-items:center;gap:7px}
  h1{font-size:20px;line-height:1.3;letter-spacing:-.02em;margin:0 0 6px;font-weight:650}
  h1 b{color:var(--ac);font-weight:700}
  .sub{color:var(--mut);font-size:13.5px;margin:0 0 18px}
  ul.scopes{list-style:none;margin:0 0 22px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#fbf7ee}
  ul.scopes li{display:flex;gap:10px;align-items:flex-start;padding:6px 0;font-size:13.5px}
  ul.scopes li+li{border-top:1px solid var(--line)}
  .tick{color:var(--good);font-weight:700;flex:none}
  .row{display:flex;gap:10px}
  .btn{flex:1;padding:11px 16px;border-radius:10px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer;border:1px solid var(--line);transition:transform .04s,background .15s}
  .btn:active{transform:translateY(1px)}
  .btn.ghost{background:transparent;color:var(--mut)}
  .btn.ghost:hover{background:#f2ead9}
  .btn.primary{background:var(--ac);color:var(--ac-ink);border-color:var(--ac)}
  .btn.primary:hover{filter:brightness(1.06)}
  .btn[disabled]{opacity:.55;cursor:default}
  .foot{color:var(--mut);font-size:12px;text-align:center;margin:16px 0 0}
  .err{color:#c0492b;font-size:12.5px;text-align:center;margin:12px 0 0;min-height:0}
</style>
</head>
<body>
  <main class="card">
    <div class="logo">⚓ Dock</div>
    <h1><b>${name}</b> wants to act in your workspace</h1>
    <p class="sub">Approving lets this agent do the following as you, with a token that expires. You stay in control.</p>
    <ul class="scopes">${items}</ul>
    <div class="row">
      <button id="deny" class="btn ghost" type="button">Deny</button>
      <button id="allow" class="btn primary" type="button">Approve</button>
    </div>
    <p class="err" id="err"></p>
    <p class="foot">Revoke anytime in Settings → Agents.</p>
  </main>
  <script>
    var query = ${JSON.stringify(props.query)};
    var allow = document.getElementById("allow"), deny = document.getElementById("deny"), err = document.getElementById("err");
    async function decide(accept){
      allow.disabled = deny.disabled = true; err.textContent = "";
      try{
        var r = await fetch("/api/auth/oauth2/consent", {
          method:"POST", headers:{"content-type":"application/json"},
          credentials:"include", redirect:"manual",
          body: JSON.stringify({ accept: accept, oauth_query: query })
        });
        // The plugin replies JSON { redirect: true, url: "<redirect_uri>?code=..." }
        // (note: "redirect" is a boolean flag, the destination is "url").
        var loc = r.headers.get("location");
        if (loc){ window.location.href = loc; return; }
        var data = await r.json().catch(function(){ return {}; });
        var to = data && (data.url || data.redirectURI || data.location);
        if (to){ window.location.href = to; return; }
        err.textContent = (data && (data.error_description || data.error)) || "Something went wrong.";
      }catch(e){ err.textContent = "Network error. Try again."; }
      allow.disabled = deny.disabled = false;
    }
    allow.onclick = function(){ decide(true); };
    deny.onclick = function(){ decide(false); };
  </script>
</body>
</html>`
}
