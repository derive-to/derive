import { escapeHtml } from "./md"
import type { ArtifactRecord, VersionRecord } from "./ports"

const LOGO = `<svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">
<rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540"/>
<path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="#8a7dc0" stroke-width="1.7" stroke-linejoin="round"/>
<rect x="13.6" y="6.4" width="4.8" height="4.8" rx="1.2" fill="#655999"/></svg>`

/** Viewer chrome around the sandboxed artifact iframe, with a live comment panel and inline editing. */
export function renderShell(
  artifact: ArtifactRecord,
  versions: VersionRecord[],
  shownVersion: number,
  rawSrc: string,
): string {
  const title = escapeHtml(artifact.title ?? artifact.short_id)
  const current = artifact.current_version
  const version = versions.find((v) => v.n === shownVersion)
  const isMd = version?.content_type === "text/markdown"
  const editable = artifact.kind === "file" && shownVersion === current
  const chips = versions
    .map(
      (v) =>
        `<a class="chip${v.n === shownVersion ? " on" : ""}" href="/a/${artifact.short_id}@v${v.n}" title="${escapeHtml(v.message ?? "")}">v${v.n}</a>`,
    )
    .join("")

  const cfg = JSON.stringify({
    shortId: artifact.short_id,
    version: shownVersion,
    current,
    kind: artifact.kind,
    ext: isMd ? "md" : "html",
    filename: `${(artifact.slug || artifact.short_id).replace(/[^a-z0-9-]/gi, "-")}.${isMd ? "md" : "html"}`,
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Dock</title>
<style>
  :root{--paper:#f6f0e3;--paper-2:#f1ead9;--panel:#fdf8ec;--ink:#2a2540;--ink-soft:#46415c;--muted:#6b6680;
    --line:#e4dcc9;--line-2:#eee7d6;--accent:#655999;--accent-ink:#4f447e;--accent-soft:#e8e4f1;
    --cmt-bg:#ebe7f5;--cmt-tx:#564f82;--cmt-bd:#cbc5e5;--good:#3c6e2f;--good-bg:#e3eedb;
    --sans:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--paper);
    font:13px/1.5 var(--sans);color:var(--ink)}
  header{position:relative;display:flex;align-items:center;gap:10px;padding:9px 16px;background:var(--panel);
    border-bottom:1px solid var(--line);flex:0 0 auto}
  /* Title sits centered at the top, GDocs-style, independent of the side controls. */
  .t{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-weight:600;font-size:14px;
    letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38%;text-align:center;pointer-events:none}
  .meta{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap}
  .grow{flex:1}
  .chips{display:flex;gap:5px}
  .chip{font-family:var(--mono);font-size:10.5px;color:var(--muted);text-decoration:none;border:1px solid var(--line);
    border-radius:6px;padding:3px 8px;background:var(--paper)}
  .chip.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
  .btn{font-size:11.5px;font-weight:600;border:1px solid var(--line);background:var(--paper);color:var(--ink);
    border-radius:7px;padding:5px 11px;cursor:pointer;text-decoration:none;white-space:nowrap}
  .btn:hover{border-color:var(--accent);color:var(--accent-ink)}
  .btn.pri{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn.pri:hover{color:#fff;filter:brightness(1.05)}
  .old{background:#f4ead4;color:#7a531a;font-size:11.5px;padding:4px 16px;border-bottom:1px solid var(--line);flex:0 0 auto}
  .old a{color:#7a531a;font-weight:700}
  main{flex:1;display:flex;min-height:0}
  .stage{flex:1;display:flex;min-width:0}
  iframe{flex:1;border:0;width:100%;background:#fff}
  /* inline editor */
  .editor{flex:1;display:none;flex-direction:column;background:#fff}
  .editor.on{display:flex}
  .editor .bar{display:flex;align-items:center;gap:9px;padding:8px 12px;background:var(--paper-2);border-bottom:1px solid var(--line-2)}
  .editor .bar .lbl{font-family:var(--mono);font-size:11px;color:var(--muted)}
  .editor textarea{flex:1;border:0;resize:none;padding:16px 20px;font-family:var(--mono);font-size:13px;line-height:1.6;color:var(--ink);outline:none}
  /* comment panel */
  aside{width:320px;flex:0 0 320px;border-left:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0}
  aside.hidden{display:none}
  .ph{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--line-2)}
  .ph b{font-family:Inter;font-size:13px}
  .ph .cnt{font-family:var(--mono);font-size:10px;color:var(--accent-ink);background:var(--accent-soft);border-radius:999px;padding:1px 8px;font-weight:700}
  .ph .pres{margin-left:auto;font-size:10.5px;color:var(--muted);display:flex;align-items:center;gap:5px}
  .ph .pres i{width:6px;height:6px;border-radius:50%;background:var(--good)}
  .threads{flex:1;overflow:auto;padding:12px}
  .empty{color:var(--muted);font-size:12px;text-align:center;padding:30px 12px}
  .thread{border:1px solid var(--line);border-radius:11px;background:var(--paper);margin-bottom:11px;overflow:hidden}
  .thread.resolved{opacity:.62}
  .cmt{padding:10px 12px;border-bottom:1px solid var(--line-2)}
  .cmt:last-child{border-bottom:0}
  .cmt .who{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;color:var(--cmt-tx);margin-bottom:4px}
  .cmt .who .av{width:17px;height:17px;border-radius:50%;background:var(--cmt-bg);color:var(--cmt-tx);display:grid;place-items:center;font-size:9px}
  .cmt .who .vb{margin-left:auto;font-family:var(--mono);font-size:9px;color:var(--muted);font-weight:400}
  .cmt p{margin:0;font-size:12.5px;color:var(--ink);line-height:1.45;white-space:pre-wrap;word-break:break-word}
  .cmt .anc{font-family:var(--mono);font-size:9.5px;color:var(--muted);background:var(--paper-2);border-radius:5px;padding:2px 6px;display:inline-block;margin-bottom:5px}
  .tfoot{display:flex;gap:7px;align-items:center;padding:7px 12px;background:var(--paper-2)}
  .tfoot .st{font-family:var(--mono);font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:999px}
  .tfoot .st.open{background:var(--accent-soft);color:var(--accent-ink)} .tfoot .st.resolved{background:var(--good-bg);color:var(--good)}
  .tfoot button{margin-left:auto;font-size:10.5px;font-weight:600;border:1px solid var(--line);background:var(--paper);color:var(--ink-soft);border-radius:6px;padding:3px 9px;cursor:pointer}
  .reply{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--line-2)}
  .reply input{flex:1;border:1px solid var(--line);border-radius:7px;padding:6px 9px;font-family:var(--sans);font-size:12px;color:var(--ink);background:var(--paper)}
  .composer{flex:0 0 auto;border-top:1px solid var(--line-2);padding:11px 12px;background:var(--panel)}
  .composer textarea{width:100%;border:1px solid var(--cmt-bd);border-radius:9px;padding:8px 10px;font-family:var(--sans);font-size:12.5px;color:var(--ink);resize:vertical;min-height:52px;background:var(--paper)}
  .composer .row{display:flex;gap:8px;align-items:center;margin-top:7px}
  .composer .name{flex:1;border:1px solid var(--line);border-radius:7px;padding:5px 9px;font-size:11px;color:var(--muted);background:var(--paper)}
  .toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--paper);font-size:12px;padding:8px 14px;border-radius:9px;opacity:0;transition:.25s;pointer-events:none;z-index:50}
  .toast.show{opacity:1}
  /* live multiplayer cursors (overlaid on the artifact stage) */
  #cursors{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:30}
  .pcur{position:absolute;top:0;left:0;transition:transform .09s linear,opacity .3s;will-change:transform}
  .pcur svg{display:block;fill:var(--c);filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))}
  .pcur b{position:absolute;left:12px;top:14px;background:var(--c);color:#fff;font:600 10.5px var(--sans);
    padding:1px 7px;border-radius:5px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.25)}
  /* share dialog (GDocs-style) */
  .sh-ov{position:fixed;inset:0;background:rgba(20,16,34,.42);display:none;place-items:center;z-index:60}
  .sh-ov.on{display:grid}
  .sh{width:min(92vw,460px);background:var(--panel);border:1px solid var(--line);border-radius:16px;
    box-shadow:0 16px 50px rgba(30,20,55,.28);overflow:hidden}
  .sh h3{margin:0;padding:15px 18px;font-size:15px;font-weight:600;border-bottom:1px solid var(--line-2);display:flex;align-items:center;gap:8px}
  .sh h3 .x{margin-left:auto;border:0;background:none;font-size:20px;color:var(--muted);cursor:pointer;line-height:1}
  .sh .bd{padding:14px 18px;display:flex;flex-direction:column;gap:14px;max-height:66vh;overflow:auto}
  .sh .invite{display:flex;gap:7px}
  .sh .invite input{flex:1;border:1px solid var(--cmt-bd);border-radius:8px;padding:7px 10px;font:inherit;color:var(--ink);background:var(--paper)}
  .sh select{border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;color:var(--ink);background:var(--paper)}
  .sh .sec{font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px}
  .sh .person{display:flex;align-items:center;gap:9px;padding:6px 2px}
  .sh .person .av{width:26px;height:26px;border-radius:50%;background:var(--cmt-bg);color:var(--cmt-tx);display:grid;place-items:center;font-size:11px;font-weight:700;flex:0 0 auto}
  .sh .person .who{display:flex;flex-direction:column;min-width:0}
  .sh .person .who .nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sh .person .who .em{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sh .person .rt{margin-left:auto;display:flex;align-items:center;gap:6px}
  .sh .person .role{font-size:12px;color:var(--ink-soft);text-transform:capitalize}
  .sh .person .rm{border:0;background:none;color:var(--muted);cursor:pointer;font-size:13px}
  .sh .ga{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:11px;padding:11px 12px;background:var(--paper)}
  .sh .ga .ic{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);font-size:15px;flex:0 0 auto}
  .sh .ga .gt b{display:block;font-weight:600}
  .sh .ga .gt span{font-size:11px;color:var(--muted)}
  .sh .note{background:var(--paper-2);border-radius:9px;padding:10px 12px;color:var(--ink-soft);font-size:12px}
  .sh .err{color:#a23;font-size:11.5px}
  .sh .ft{display:flex;align-items:center;gap:8px;padding:13px 18px;border-top:1px solid var(--line-2)}
</style>
</head>
<body>
<header>
  ${LOGO}
  <span class="meta">v${shownVersion} · ${escapeHtml(version?.author ?? "")}${artifact.kind === "bundle" ? " · bundle" : ""}</span>
  <span class="t">${title}</span>
  <span class="grow"></span>
  <div class="chips">${chips}</div>
  ${editable ? `<button class="btn" id="editBtn">Edit</button>` : ""}
  ${isMd ? `<a class="btn" href="${rawSrc.replace(/index\.html$/, "raw.md")}">.md</a>` : ""}
  <button class="btn" id="toggleBtn">Comments</button>
  <button class="btn pri" id="shareBtn">Share</button>
</header>
${shownVersion !== current ? `<div class="old">Viewing v${shownVersion} — <a href="/a/${artifact.short_id}">jump to current (v${current})</a></div>` : ""}
<main>
  <div class="stage">
    <iframe id="frame" src="${rawSrc}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" title="${title}"></iframe>
    <div class="editor" id="editor">
      <div class="bar"><span class="lbl" id="editLbl">editing source</span><span class="grow"></span>
        <button class="btn" id="cancelEdit">Cancel</button>
        <button class="btn pri" id="publishEdit">Publish new version</button>
      </div>
      <textarea id="src" spellcheck="false" placeholder="loading…"></textarea>
    </div>
  </div>
  <aside id="panel">
    <div class="ph"><b>Comments</b><span class="cnt" id="openCount">0</span>
      <span class="pres" id="pres" hidden><i></i><span id="presN">1</span> viewing</span></div>
    <div class="threads" id="threads"><div class="empty">Loading…</div></div>
    <div class="composer">
      <textarea id="newBody" placeholder="Add a comment…"></textarea>
      <div class="row"><input class="name" id="who" placeholder="Your name"><button class="btn pri" id="addBtn">Comment</button></div>
    </div>
  </aside>
</main>
<div class="sh-ov" id="shareOv">
  <div class="sh" role="dialog" aria-modal="true" aria-label="Share">
    <h3><span>Share</span><button class="x" id="shClose" aria-label="Close">&times;</button></h3>
    <div class="bd" id="shBody"><div class="empty">Loading…</div></div>
    <div class="ft"><button class="btn" id="shCopy">🔗 Copy link</button><span class="grow"></span><button class="btn pri" id="shDone">Done</button></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const CFG = ${cfg};
const base = "/v1/artifacts/" + CFG.shortId;
const $ = (s) => document.querySelector(s);
const esc = (s) => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
let who = localStorage.getItem("dock_name") || "";
$("#who").value = who;
$("#who").addEventListener("change", e => { who = e.target.value; localStorage.setItem("dock_name", who); });

function toast(m){ const t=$("#toast"); t.textContent=m; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),1800); }

$("#toggleBtn").onclick = () => $("#panel").classList.toggle("hidden");

/* ---- comments ---- */
function anchorLabel(a){ try{ const o=JSON.parse(a); return o.path||o.exact||o.value||a; }catch{ return a; } }
function group(comments){
  const map = new Map();
  for(const c of comments){ if(!map.has(c.thread_id)) map.set(c.thread_id, []); map.get(c.thread_id).push(c); }
  return [...map.values()];
}
async function loadComments(){
  const r = await fetch(base + "/comments");
  if(!r.ok){ $("#threads").innerHTML = '<div class="empty">Comments unavailable.</div>'; return; }
  const { comments } = await r.json();
  const threads = group(comments);
  const open = threads.filter(t => t[0].state === "open").length;
  $("#openCount").textContent = open;
  if(threads.length === 0){ $("#threads").innerHTML = '<div class="empty">No comments yet.<br>Leave the first one below.</div>'; return; }
  $("#threads").innerHTML = threads.map(t => {
    const root = t[0]; const resolved = root.state === "resolved";
    const cmts = t.map(c => \`<div class="cmt">
      <div class="who"><span class="av">\${esc((c.author||"?").slice(0,2)).toUpperCase()}</span>\${esc(c.author||"anon")}<span class="vb">base v\${c.base_version}</span></div>
      \${c.anchor?\`<span class="anc">@ \${esc(anchorLabel(c.anchor))}</span>\`:""}
      <p>\${esc(c.body_md)}</p></div>\`).join("");
    return \`<div class="thread \${resolved?"resolved":""}" data-tid="\${root.thread_id}" data-cid="\${root.id}">
      \${cmts}
      <div class="tfoot"><span class="st \${resolved?"resolved":"open"}">\${resolved?"resolved":"open"}</span>
        <button class="resolveBtn">\${resolved?"Reopen":"Resolve"}</button></div>
      <div class="reply"><input placeholder="Reply…"><button class="btn replyBtn">Reply</button></div>
    </div>\`;
  }).join("");
  $("#threads").querySelectorAll(".thread").forEach(el => {
    const tid = el.dataset.tid, cid = el.dataset.cid;
    const resolved = el.classList.contains("resolved");
    el.querySelector(".resolveBtn").onclick = async () => {
      await fetch(base + "/comments/" + cid + "/resolve", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state: resolved?"open":"resolved"})});
      loadComments();
    };
    const ri = el.querySelector(".reply input"), rb = el.querySelector(".replyBtn");
    const send = async () => { const v=ri.value.trim(); if(!v) return; await post({body_md:v, thread_id:tid}); ri.value=""; };
    rb.onclick = send; ri.addEventListener("keydown", e => { if(e.key==="Enter") send(); });
  });
}
async function post(payload){
  payload.author = who || "anonymous";
  payload.base_version = CFG.current;
  const r = await fetch(base + "/comments", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  if(r.status === 401){ toast("Sign-in required to comment"); return; }
  if(!r.ok){ toast("Could not post"); return; }
  loadComments();
}
$("#addBtn").onclick = async () => { const v=$("#newBody").value.trim(); if(!v) return; await post({body_md:v}); $("#newBody").value=""; };

/* ---- inline edit ---- */
const editor = $("#editor"), frame = $("#frame");
if($("#editBtn")){
  $("#editBtn").onclick = async () => {
    editor.classList.add("on"); frame.style.display="none";
    $("#editLbl").textContent = "editing " + CFG.filename;
    const r = await fetch(base + "/content");
    $("#src").value = r.ok ? await r.text() : "";
    $("#src").focus();
  };
  $("#cancelEdit").onclick = () => { editor.classList.remove("on"); frame.style.display=""; };
  $("#publishEdit").onclick = async () => {
    const body = $("#src").value;
    const fd = new FormData();
    fd.append("file", new Blob([body]), CFG.filename);
    fd.append("message", "edited in browser");
    const r = await fetch(base + "/versions", {method:"POST",body:fd});
    if(r.status === 401){ toast("Sign-in required to publish"); return; }
    if(!r.ok){ toast("Publish failed"); return; }
    const j = await r.json();
    toast("Published v" + j.current_version);
    location.href = "/a/" + CFG.shortId;
  };
}

/* ---- live updates ---- */
loadComments();
try {
  const ev = new EventSource(base + "/events");
  ev.addEventListener("comment.created", loadComments);
  ev.addEventListener("comment.resolved", loadComments);
  ev.addEventListener("version.published", () => toast("A new version was published"));
  ev.addEventListener("presence", e => { try{ const d=JSON.parse(e.data); const n=(d.viewers||[]).length; $("#presN").textContent=n; $("#pres").hidden = n<2; }catch{} });
  ev.addEventListener("cursor", e => { try{ const d=JSON.parse(e.data); if(d.id!==myId) showPeer(d); }catch{} });
} catch {}
const myName = () => who || "anonymous";
function beat(){ fetch(base + "/presence", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name: myName()})}).catch(()=>{}); }
beat(); setInterval(beat, 25000);

/* ---- live cursors (multiplayer) ---- */
const stage = $(".stage"); stage.style.position = "relative";
const clayer = document.createElement("div"); clayer.id = "cursors"; stage.appendChild(clayer);
const myId = Math.random().toString(36).slice(2, 9);
let h = 0; for (let i = 0; i < myId.length; i++) h = (h * 31 + myId.charCodeAt(i)) % 360;
const myColor = "hsl(" + h + " 72% 52%)";
const peers = {};
let lastXY = null, lastSent = 0;
function sendCursor(){ if(!lastXY) return; lastSent = Date.now();
  fetch(base + "/cursor", {method:"POST",headers:{"content-type":"application/json"},
    body: JSON.stringify({id: myId, name: myName(), color: myColor, x: lastXY[0], y: lastXY[1]})}).catch(()=>{}); }
window.addEventListener("message", e => {
  const m = e.data; if(!m || m.source !== "dock" || m.type !== "cursor") return;
  lastXY = [m.x, m.y]; if(Date.now() - lastSent >= 45) sendCursor(); });
setInterval(() => { if(lastXY) sendCursor(); }, 3000);
const CUR_SVG = '<svg width="20" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.5 11.5 L13 11.5 Z" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
function showPeer(d){
  let el = peers[d.id];
  if(!el){ el = document.createElement("div"); el.className = "pcur"; el.innerHTML = CUR_SVG + "<b></b>"; clayer.appendChild(el); peers[d.id] = el; }
  el.style.setProperty("--c", d.color || "#655999");
  el.querySelector("b").textContent = d.name || "anon";
  const r = stage.getBoundingClientRect();
  el.style.transform = "translate(" + (d.x * r.width).toFixed(1) + "px," + (d.y * r.height).toFixed(1) + "px)";
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; setTimeout(() => { el.remove(); delete peers[d.id]; }, 400); }, 8000);
}

/* ---- share (GDocs-style: always reachable; role decides what you can do) ---- */
const SH_ROLES = ["viewer", "commenter", "editor"];
const SH_GA = { org: ["🔒", "Restricted", "Only invited people can open this"],
                link: ["🌐", "Anyone with the link", "Anyone with the link can view"],
                public: ["🌐", "Anyone with the link", "Public — listed and shareable"] };
const shAv = (s) => esc((s || "?").slice(0, 2)).toUpperCase();
const canShare = (r) => r === "owner" || r === "editor";
let shState = null;
function roleOpts(sel){ return SH_ROLES.map(r => '<option value="'+r+'"'+(r===sel?" selected":"")+'>'+r[0].toUpperCase()+r.slice(1)+'</option>').join(""); }
async function openShare(){
  $("#shareOv").classList.add("on");
  $("#shBody").innerHTML = '<div class="empty">Loading…</div>';
  try {
    const [a, m] = await Promise.all([fetch(base), fetch(base + "/members")]);
    const aj = a.ok ? await a.json() : {}; const mj = m.ok ? await m.json() : { members: [] };
    shState = { role: aj.my_role || "viewer", visibility: aj.visibility || "org", members: mj.members || [] };
    renderShare();
  } catch { $("#shBody").innerHTML = '<div class="empty">Could not load sharing.</div>'; }
}
function personRow(p, manage){
  const role = p.role || "viewer";
  return '<div class="person" data-uid="'+esc(p.user_id)+'" data-email="'+esc(p.email||"")+'">'+
    '<div class="av">'+shAv(p.name||p.email)+'</div>'+
    '<div class="who"><span class="nm">'+esc(p.name||p.email||"Someone")+'</span>'+
    (p.email?'<span class="em">'+esc(p.email)+'</span>':"")+'</div><div class="rt">'+
    (manage ? '<select class="prole">'+roleOpts(role)+'</select><button class="rm" title="Remove">✕</button>'
            : '<span class="role">'+esc(role)+'</span>')+'</div></div>';
}
function renderShare(){
  const manage = canShare(shState.role);
  const ga = SH_GA[shState.visibility] || SH_GA.org;
  let html = manage
    ? '<div class="invite"><input id="shEmail" type="email" placeholder="Invite people by email…">'+
      '<select id="shRole">'+roleOpts("editor")+'</select><button class="btn pri" id="shInvite">Invite</button></div>'+
      '<div class="err" id="shErr" hidden></div>'
    : '<div class="note">🔒 View only — you can view this artifact but can’t change who has access. Ask the owner or an editor to share it.</div>';
  html += '<div><div class="sec">People with access</div>'+
    (shState.members.length ? shState.members.map(p => personRow(p, manage)).join("")
      : '<div class="empty" style="padding:8px 2px">Just you and the workspace for now.</div>')+'</div>';
  html += '<div><div class="sec">General access</div><div class="ga"><div class="ic">'+ga[0]+'</div>'+
    '<div class="gt"><b>'+ga[1]+'</b><span>'+ga[2]+'</span></div></div></div>';
  $("#shBody").innerHTML = html;
  if(manage){
    $("#shInvite").onclick = doInvite;
    $("#shEmail").addEventListener("keydown", e => { if(e.key === "Enter") doInvite(); });
    $("#shBody").querySelectorAll(".person").forEach(row => {
      const email = row.dataset.email, uid = row.dataset.uid;
      const sel = row.querySelector(".prole"); if(sel) sel.onchange = async () => { if(!(await putMember(email, sel.value))) refreshMembers(); };
      const rm = row.querySelector(".rm"); if(rm) rm.onclick = () => delMember(uid);
    });
  }
}
function shErr(m){ const e = $("#shErr"); if(e){ e.textContent = m; e.hidden = false; } else toast(m); }
async function putMember(email, role){
  if(!email) return false;
  const r = await fetch(base + "/members", {method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({email, role})});
  if(r.status === 404){ shErr("No Dock user with that email."); return false; }
  if(!r.ok){ shErr(r.status === 403 ? "You don’t have permission to share." : "Could not update."); return false; }
  return true;
}
async function doInvite(){
  const email = $("#shEmail").value.trim(); if(!email) return;
  if(await putMember(email, $("#shRole").value)){ $("#shEmail").value = ""; toast("Shared with " + email); refreshMembers(); }
}
async function delMember(uid){
  const r = await fetch(base + "/members/" + uid, {method:"DELETE"});
  if(!r.ok){ shErr("Could not remove."); return; }
  refreshMembers();
}
async function refreshMembers(){
  const m = await fetch(base + "/members"); shState.members = m.ok ? (await m.json()).members || [] : []; renderShare();
}
$("#shareBtn").onclick = openShare;
$("#shClose").onclick = () => $("#shareOv").classList.remove("on");
$("#shDone").onclick = () => $("#shareOv").classList.remove("on");
$("#shCopy").onclick = () => navigator.clipboard.writeText(location.href).then(() => toast("Link copied"));
$("#shareOv").addEventListener("click", e => { if(e.target.id === "shareOv") $("#shareOv").classList.remove("on"); });
document.addEventListener("keydown", e => { if(e.key === "Escape") $("#shareOv").classList.remove("on"); });
</script>
</body>
</html>`
}
