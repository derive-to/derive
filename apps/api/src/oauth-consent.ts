// The OAuth consent screen Derive serves when an agent (an MCP client like Claude)
// asks to act on your behalf. The oauth-provider plugin redirects the signed-in
// user here (/oauth/consent?client_id&scope&code); on Approve we POST to
// /api/auth/oauth2/consent with the original query, and the plugin returns the
// browser to the client's redirect_uri with the authorization code. This is the
// human-in-the-loop grant: an agent can't self-authorize.
//
// On the Derive palette (Inter, the anchor mark) so the grant moment feels like Derive.
import { BRAND_PAGE_MARK, BRAND_PAGE_TOKENS } from "./lib/brand-page-css"

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
  "derive:manage": "Manage agents and contexts (only as far as your workspace role allows)",
}

// Scopes that let the agent change something get a distinct accent tick; read-only
// scopes get a quieter one — so the grant's blast radius reads at a glance.
const WRITE_SCOPES = new Set([
  "derive:comment",
  "derive:propose",
  "derive:publish",
  "derive:review",
  "derive:manage",
])

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

/** The consent page HTML. `query` is the original authorize query string, echoed
 *  back to /oauth2/consent so the plugin can complete the authorization. Every
 *  grant covers all of the signed-in user's workspaces for now — the
 *  `workspaces`/`selected` picker UI is deferred (see the comment on `picker`
 *  below), though its params and the POST /oauth/consent/workspace plumbing
 *  stay wired for when it comes back. */
export function consentHTML(props: {
  clientName: string
  scopes: string[]
  query: string
  clientId?: string
  workspaces?: { id: string; name: string }[]
  /** The workspaces a prior grant is scoped to (re-consent preselect). Empty/omitted
   *  = "All workspaces" (the default mode); non-empty = "Only selected", pre-ticked. */
  selected?: string[]
}): string {
  const name = esc(props.clientName || "An application")
  // The workspace access control: "All workspaces" (the dynamic default — every
  // workspace now and any added later, stored as an empty grant set) or "Only
  // selected" (a fixed set of ≥1 ticked workspaces). Mode defaults to "some" only
  // when re-consenting a grant that was already scoped to a subset. The selection
  // is persisted (POST /oauth/consent/workspace → setOAuthClientWorkspaces) and
  // enforced everywhere the grant resolves a workspace (oauth-agent + context +
  // the MCP surface). Zero selected in "some" mode is blocked client-side.
  const workspaces = props.workspaces ?? []
  const preselected = new Set(props.selected ?? [])
  const someMode = preselected.size > 0
  const picker =
    workspaces.length <= 1
      ? "" // nothing to choose among — a single-workspace grant is simply that one
      : `<div class="ws-access">
      <span class="ws-label">Workspace access</span>
      <label class="ws-opt"><input type="radio" name="wsmode" value="all"${someMode ? "" : " checked"}/><span class="ws-opt-t">All workspaces<small>Every workspace you have, and any you add later.</small></span></label>
      <label class="ws-opt"><input type="radio" name="wsmode" value="some"${someMode ? " checked" : ""}/><span class="ws-opt-t">Only selected workspaces<small>Limit this connection to specific workspaces.</small></span></label>
      <div class="ws-list" id="wslist"${someMode ? "" : " hidden"}>${workspaces
        .map(
          (w) =>
            `<label class="ws-check"><input type="checkbox" name="ws" value="${esc(w.id)}"${
              preselected.has(w.id) ? " checked" : ""
            }/><span>${esc(w.name)}</span></label>`,
        )
        .join("")}</div>
    </div>`
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
  const connectedInner = `<div class="brand">${BRAND_PAGE_MARK}<span class="name">Derive</span><span class="badge ok">Connected</span></div>
    <div class="done">
      <div class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>
      <h1>You're connected</h1>
      <p class="sub"><b>${name}</b> can now act in your workspaces. Taking you back…</p>
      <a class="back" id="back" href="#">Return to ${name} now</a>
    </div>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Authorize ${name} · Derive</title>
<style>
  ${BRAND_PAGE_TOKENS}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:var(--ink);
    background:var(--paper);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");}
  .card{width:100%;max-width:448px;background:var(--panel);border:1px solid var(--line);border-radius:20px;
    padding:32px 32px 26px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 24px 60px -22px rgba(0,0,0,.28)}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
  .mk{height:26px;width:auto;display:block;flex:none}
  .brand .name{font-family:var(--display);font-weight:600;font-size:17px;letter-spacing:-.02em}
  .badge{margin-left:auto;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.05em;
    text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--accent-soft);color:var(--accent-ink)}
  h1{font-family:var(--display);font-weight:600;font-size:22px;line-height:1.25;letter-spacing:-.02em;margin:0 0 7px}
  h1 b{color:var(--accent-ink);font-weight:700}
  .sub{color:var(--ink-soft);font-size:13.5px;margin:0 0 18px}
  .ws-label{display:block;font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.05em;
    text-transform:uppercase;color:var(--muted);margin:0 0 6px}
  select.ws{width:100%;margin:0 0 16px;padding:10px 12px;border:1px solid var(--line);border-radius:11px;
    background:var(--panel-2);color:var(--ink);font:500 14px var(--sans);cursor:pointer}
  select.ws:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .ws-access{margin:0 0 18px;padding:10px 14px;border:1px solid var(--line);border-radius:14px;background:var(--panel-2)}
  .ws-access .ws-label{margin:2px 0 4px}
  .ws-opt{display:flex;gap:10px;align-items:flex-start;padding:7px 0;cursor:pointer}
  .ws-opt input{margin-top:2px;accent-color:var(--accent);flex:none;width:15px;height:15px}
  .ws-opt-t{display:flex;flex-direction:column;font-size:13.5px;font-weight:600;color:var(--ink)}
  .ws-opt-t small{font-weight:400;font-size:12px;color:var(--muted);margin-top:1px}
  .ws-list{margin:2px 0 4px 25px;padding-left:12px;border-left:1px solid var(--line);display:flex;flex-direction:column}
  .ws-list[hidden]{display:none}
  .ws-check{display:flex;gap:9px;align-items:center;padding:6px 0;font-size:13.5px;color:var(--ink-soft);cursor:pointer}
  .ws-check input{accent-color:var(--accent);flex:none;width:15px;height:15px}
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
  .btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
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
    <div class="brand">${BRAND_PAGE_MARK}<span class="name">Derive</span><span class="badge">Authorize</span></div>
    <h1><b>${name}</b> wants to act in your workspaces</h1>
    <p class="sub">Approving lets this agent do the following as you, with a token that expires. You choose which workspaces it can reach, and stay in control.</p>
    ${picker}
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
    var CLIENT_ID = ${JSON.stringify(props.clientId ?? "")};
    var CONNECTED = ${JSON.stringify(connectedInner)};
    var allow = document.getElementById("allow"), deny = document.getElementById("deny"), err = document.getElementById("err");
    // Show our branded "Connected" card, then hand the code back to the client.
    // The auth code is short-lived but a ~1.1s beat is well within its window.
    // With a warning there is no auto-redirect — it would sweep the message away
    // before it could be read; the manual return link still works.
    function goConnected(to, warning){
      var card = document.querySelector("main.card");
      if (card) card.innerHTML = CONNECTED;
      var back = document.getElementById("back");
      if (back) back.setAttribute("href", to);
      if (warning){
        var w = document.createElement("p");
        w.className = "err";
        w.textContent = warning;
        var done = document.querySelector(".done");
        if (done) done.appendChild(w);
        return;
      }
      setTimeout(function(){ window.location.href = to; }, 1100);
    }
    // Saved only AFTER the consent completes: an abandoned or denied consent must
    // not re-point tokens the client already holds from an earlier grant. There is
    // no race on the other side — the client can't mint a token until the browser
    // delivers the code, which happens after this settles.
    // Workspace access mode + selection. "all" → an empty set (dynamic all);
    // "some" → the ticked ids (at least one, enforced by wsValid before Approve).
    function wsMode(){ var el = document.querySelector('input[name="wsmode"]:checked'); return el ? el.value : "all"; }
    function checkedWs(){ return Array.prototype.map.call(document.querySelectorAll('input[name="ws"]:checked'), function(c){ return c.value; }); }
    function wsValid(){ return wsMode() !== "some" || checkedWs().length > 0; }
    // Reveal the checkbox list only in "some" mode; clear any stale error on change.
    var wslist = document.getElementById("wslist");
    Array.prototype.forEach.call(document.querySelectorAll('input[name="wsmode"]'), function(r){
      r.addEventListener("change", function(){ if (wslist) wslist.hidden = wsMode() !== "some"; err.textContent = ""; });
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="ws"]'), function(cb){
      cb.addEventListener("change", function(){ err.textContent = ""; });
    });
    async function saveWorkspace(){
      // No picker on the page (single-workspace user, or none) → nothing to scope.
      if (!CLIENT_ID || !document.querySelector('input[name="wsmode"]')) return true;
      var org_ids = wsMode() === "all" ? [] : checkedWs();
      try{
        var b = await fetch("/oauth/consent/workspace", {
          method:"POST", headers:{"content-type":"application/json"}, credentials:"include",
          body: JSON.stringify({ client_id: CLIENT_ID, org_ids: org_ids })
        });
        return b.ok;
      }catch(e){ return false; }
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
        if (to){
          if (!accept){ window.location.href = to; return; }
          var saved = await saveWorkspace();
          goConnected(to, saved ? "" : "The workspace choice didn't save — this agent will act in your default workspace. Reconnect to change it.");
          return;
        }
        err.textContent = (data && (data.error_description || data.error)) || "Something went wrong.";
      }catch(e){ err.textContent = "Network error. Try again."; }
      allow.disabled = deny.disabled = false;
    }
    allow.onclick = function(){
      // Block the grant until the human picks a workspace: "Only selected" with
      // none ticked is the 0-workspace error condition.
      if (!wsValid()){ err.textContent = "Select at least one workspace, or choose “All workspaces”."; return; }
      decide(true);
    };
    deny.onclick = function(){ decide(false); };
  </script>
</body>
</html>`
}
