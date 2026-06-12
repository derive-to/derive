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
  header{display:flex;align-items:center;gap:10px;padding:9px 16px;background:var(--panel);
    border-bottom:1px solid var(--line);flex:0 0 auto}
  .t{font-weight:600;font-size:14px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42vw}
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
</style>
</head>
<body>
<header>
  ${LOGO}
  <span class="t">${title}</span>
  <span class="meta">v${shownVersion} · ${escapeHtml(version?.author ?? "")}${artifact.kind === "bundle" ? " · bundle" : ""}</span>
  <span class="grow"></span>
  <div class="chips">${chips}</div>
  ${editable ? `<button class="btn" id="editBtn">Edit</button>` : ""}
  ${isMd ? `<a class="btn" href="${rawSrc.replace(/index\.html$/, "raw.md")}">.md</a>` : ""}
  <button class="btn" id="copyBtn">Copy link</button>
  <button class="btn" id="toggleBtn">Comments</button>
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

$("#copyBtn").onclick = () => navigator.clipboard.writeText(location.href).then(()=>toast("Link copied"));
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
} catch {}
const myName = () => who || "anonymous";
function beat(){ fetch(base + "/presence", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name: myName()})}).catch(()=>{}); }
beat(); setInterval(beat, 25000);
</script>
</body>
</html>`
}
