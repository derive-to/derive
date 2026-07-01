// The OAuth consent screen Derive serves when an agent (an MCP client like Claude)
// asks to act on your behalf. The oauth-provider plugin redirects the signed-in
// user here (/oauth/consent?client_id&scope&code); on Approve we POST to
// /api/auth/oauth2/consent with the original query, and the plugin returns the
// browser to the client's redirect_uri with the authorization code. This is the
// human-in-the-loop grant: an agent can't self-authorize.
//
// On the Derive plan-site palette (Space Grotesk + Inter, the anchor mark) so the
// grant moment feels like Derive.

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "Your name and avatar",
  email: "Your email address",
  offline_access: "Stay connected without asking again (refresh access)",
  "derive:read": "Read your artifacts and comments",
  "derive:comment": "Comment on your artifacts",
  "derive:propose": "Propose new versions (you approve before they go live)",
  "derive:publish": "Publish new versions directly",
  "derive:review": "Approve or request changes on proposals",
}

// Scopes that let the agent change something get a distinct accent tick; read-only
// scopes get a quieter one — so the grant's blast radius reads at a glance.
const WRITE_SCOPES = new Set([
  "derive:comment",
  "derive:propose",
  "derive:publish",
  "derive:review",
])

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

const MARK = `<svg class="mk" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540"/>
  <path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="#8a7dc0" stroke-width="1.7" stroke-linejoin="round"/>
  <rect x="13.6" y="6.4" width="4.8" height="4.8" rx="1.2" fill="#655999"/>
</svg>`

/** The consent page HTML. `query` is the original authorize query string, echoed
 *  back to /oauth2/consent so the plugin can complete the authorization. */
export function consentHTML(props: {
  clientName: string
  scopes: string[]
  query: string
}): string {
  const name = esc(props.clientName || "An application")
  const items = props.scopes
    .map((s) => {
      const write = WRITE_SCOPES.has(s)
      return `<li><span class="tick${write ? " w" : ""}" aria-hidden="true">${
        write ? "✦" : "✓"
      }</span><span>${esc(SCOPE_LABELS[s] ?? s)}</span></li>`
    })
    .join("")
  // The card swapped in after Approve — a branded confirmation on the page we own,
  // shown for a beat before the browser carries the auth code back to the client.
  const connectedInner = `<div class="brand">${MARK}<span class="name">Derive</span><span class="badge ok">Connected</span></div>
    <div class="done">
      <div class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>
      <h1>You're connected</h1>
      <p class="sub"><b>${name}</b> can now act in your workspace. Taking you back…</p>
      <a class="back" id="back" href="#">Return to ${name} now</a>
    </div>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Authorize ${name} · Derive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#f6f0e3;--panel:#fdf8ec;--panel-2:#f6efe0;--ink:#2a2540;--ink-soft:#46415c;
    --muted:#6b6680;--line:#e4dcc9;--line-2:#eee7d6;--accent:#655999;--accent-ink:#4f447e;
    --accent-2:#8a7dc0;--accent-soft:#e8e4f1;--good:#6f7a35;--good-soft:#ebedda;--bad:#a04425;
    --display:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;
    --sans:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:var(--ink);
    background:var(--paper);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");}
  .card{width:100%;max-width:448px;background:var(--panel);border:1px solid var(--line);border-radius:20px;
    padding:32px 32px 26px;box-shadow:0 1px 2px rgba(42,37,64,.04),0 24px 60px -22px rgba(42,37,64,.32)}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
  .mk{width:30px;height:30px;display:block;flex:none}
  .brand .name{font-family:var(--display);font-weight:600;font-size:17px;letter-spacing:-.02em}
  .badge{margin-left:auto;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.05em;
    text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--accent-soft);color:var(--accent-ink)}
  h1{font-family:var(--display);font-weight:600;font-size:22px;line-height:1.25;letter-spacing:-.02em;margin:0 0 7px}
  h1 b{color:var(--accent-ink);font-weight:700}
  .sub{color:var(--ink-soft);font-size:13.5px;margin:0 0 18px}
  ul.scopes{list-style:none;margin:0 0 22px;padding:8px 16px;border:1px solid var(--line);border-radius:14px;background:var(--panel-2)}
  ul.scopes li{display:flex;gap:11px;align-items:flex-start;padding:9px 0;font-size:13.5px;color:var(--ink-soft)}
  ul.scopes li+li{border-top:1px solid var(--line-2)}
  .tick{color:var(--good);font-weight:700;flex:none;font-size:13px;line-height:1.5}
  .tick.w{color:var(--accent)}
  .row{display:flex;gap:10px}
  .btn{flex:1;padding:12px 16px;border-radius:11px;font:600 14px var(--sans);cursor:pointer;border:1px solid var(--line);
    transition:transform .05s,background .15s,filter .15s}
  .btn:active{transform:translateY(1px)}
  .btn.ghost{background:transparent;color:var(--muted)}
  .btn.ghost:hover{background:var(--panel-2);color:var(--ink-soft)}
  .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn.primary:hover{filter:brightness(1.07)}
  .btn[disabled]{opacity:.55;cursor:default}
  .foot{color:var(--muted);font-size:12px;text-align:center;margin:16px 0 0}
  .err{color:var(--bad);font-size:12.5px;text-align:center;margin:12px 0 0;min-height:0}
  .badge.ok{background:var(--good-soft);color:var(--good)}
  /* The post-approve confirmation: a branded "you're connected" beat on the page
     we control, before the browser hands the code back to the client. */
  .done{text-align:center;padding:10px 4px 2px}
  .check{width:58px;height:58px;margin:6px auto 20px;border-radius:50%;background:var(--good);
    display:grid;place-items:center;box-shadow:0 10px 26px -10px rgba(111,122,53,.7);
    animation:pop .36s cubic-bezier(.2,.9,.3,1.4) both}
  .check svg{width:30px;height:30px;fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;
    stroke-linejoin:round;stroke-dasharray:26;stroke-dashoffset:26;animation:draw .4s .14s ease forwards}
  @keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
  @keyframes draw{to{stroke-dashoffset:0}}
  .done h1{margin:0 0 7px}
  .done .sub{margin:0}
  .back{display:inline-block;margin-top:20px;color:var(--accent-ink);font-size:13px;
    text-decoration:none;border-bottom:1px solid var(--line);padding-bottom:1px}
  .back:hover{color:var(--accent);border-color:var(--accent-2)}
  ::selection{background:var(--accent-soft);color:var(--accent-ink)}
</style>
</head>
<body>
  <main class="card">
    <div class="brand">${MARK}<span class="name">Derive</span><span class="badge">Authorize</span></div>
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
    var CONNECTED = ${JSON.stringify(connectedInner)};
    var allow = document.getElementById("allow"), deny = document.getElementById("deny"), err = document.getElementById("err");
    // Show our branded "Connected" card, then hand the code back to the client.
    // The auth code is short-lived but a ~1.1s beat is well within its window.
    function goConnected(to){
      var card = document.querySelector("main.card");
      if (card) card.innerHTML = CONNECTED;
      var back = document.getElementById("back");
      if (back) back.setAttribute("href", to);
      setTimeout(function(){ window.location.href = to; }, 1100);
    }
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
        var to = loc;
        if (!to){
          var data = await r.json().catch(function(){ return {}; });
          to = data && (data.url || data.redirectURI || data.location);
        }
        // On approve, linger on our confirmation; on deny, bounce straight back.
        if (to){ if (accept) goConnected(to); else window.location.href = to; return; }
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
