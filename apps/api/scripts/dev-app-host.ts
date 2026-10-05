// A local MCP Apps host for the `show` view: `pnpm dev:app-host`, then open the URL it prints.
//
// It boots Derive in-process against a local SQLite store under data/app-host (kept across
// restarts), seeds an OAuth grant and three artifacts (a template deck, a memo, a deck written
// without the deck protocol), and serves a page that plays the HOST's half of the protocol
// around the real view: initialize, tool results, tools/call, model context, display modes,
// ui/message. Run under `tsx watch`, so an edit to the view or the server restarts it; the
// page's "Reload card" then fetches the view again, the way a reopened chat does.
//
// The switches on the page reproduce what real hosts did that a fake host would hide: ChatGPT
// delivers a refused tool call as a rejected request, keeps fullscreen in a separate card, and
// the model publishes in between. A real host still has the last word: `pnpm dev:tunnel`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DECK_TEMPLATE } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { serve } from "@hono/node-server"
import Database from "better-sqlite3"
import { createApp } from "../src/app"
import type { AppDeps } from "../src/context"
import { sha256 } from "../src/lib/crypto"
import { ARTIFACT_VIEW_URI } from "../src/mcp-app-view"

const PORT = Number(process.env.APP_HOST_PORT ?? 8791)
const BASE = `http://127.0.0.1:${PORT}`
const DIR = resolve(import.meta.dirname, "../../../data/app-host")
const TOKEN = "tok_app_host"
mkdirSync(DIR, { recursive: true })

// The grant a consent dance would leave behind, written straight into the provider tables.
const dbPath = join(DIR, "derive.db")
const meta = new SqliteMetaStore(dbPath)
const db = new Database(dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, brandprint TEXT);
  CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
`)
db.prepare(
  `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_dev','dev@app-host.test','Dev')`,
).run()
db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('host','Local host')`).run()
db.prepare(
  `INSERT OR REPLACE INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
).run(
  sha256(TOKEN),
  "host",
  "u_dev",
  JSON.stringify(["openid", "derive:read", "derive:comment", "derive:publish"]),
  new Date(Date.now() + 30 * 86_400_000).toISOString(),
)
db.close()

const app = createApp({
  meta,
  blobs: new FsBlobStore(join(DIR, "blobs")),
  baseUrl: BASE,
  token: "unused",
  encryptionKey: "dev-app-host-key-0123456789abcdef",
  auth: {
    handler: async () => new Response(null, { status: 404 }),
    api: { getSession: async () => null },
  } as unknown as AppDeps["auth"],
})

const mcp = async (method: string, params: unknown) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const text = await res.text()
  const line = text.split("\n").find((l) => l.startsWith("data:"))
  return JSON.parse(line ? line.slice(5) : text).result
}
const publish = async (args: Record<string, unknown>) =>
  JSON.parse((await mcp("tools/call", { name: "publish", arguments: args })).content[0].text)

// Seed once; later runs reuse what is there, versions and comments included.
const seedPath = join(DIR, "seed.json")
let seed: Record<string, string>
try {
  seed = JSON.parse(readFileSync(seedPath, "utf8"))
} catch {
  const handRolled = ["Intro", "Problem", "Plan", "Budget", "Ask"]
    .map((h, i) => `<section data-slide="${i + 1}"><h1>${h}</h1></section>`)
    .join("")
  seed = {
    deck: (
      await publish({
        title: "Launch plan",
        filename: "deck.html",
        content: DECK_TEMPLATE.replace(/<title>[^<]*<\/title>/, "<title>Launch plan</title>"),
      })
    ).short_id,
    memo: (
      await publish({
        title: "Pricing memo",
        filename: "memo.html",
        content:
          "<!doctype html><html><head><meta name='viewport' content='width=device-width'></head><body style='font:16px system-ui;padding:24px'><h1>Pricing memo</h1><p>We price per seat. Teams over 50 seats get volume pricing.</p><p>Annual plans take two months off.</p></body></html>",
      })
    ).short_id,
    handrolled: (
      await publish({
        title: "Hand-rolled deck",
        filename: "hand.html",
        content: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>section{min-height:100vh;display:flex;align-items:center;justify-content:center;font:700 56px system-ui}</style></head><body><div class="deck">${handRolled}</div></body></html>`,
      })
    ).short_id,
  }
  writeFileSync(seedPath, JSON.stringify(seed, null, 2))
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>Derive app host</title>
<style>
body{font:13px system-ui;margin:0;background:#f3f3f1;color:#1d1d1b}
header{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #ddd}
header .g{display:flex;gap:4px;align-items:center}header b{font-size:11px;color:#777;text-transform:uppercase;margin-right:2px}
button{font:inherit;border:1px solid #ccc;background:#fff;border-radius:6px;padding:3px 9px;cursor:pointer}button.on{background:#1d1d1b;color:#fff;border-color:#1d1d1b}
#wrap{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;padding:16px}
#card iframe{width:100%;border:1px solid #ccc;border-radius:10px;background:#fff;display:block}
pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px;font:11px ui-monospace,monospace;max-height:260px;overflow:auto;margin:4px 0 14px}
h4{margin:0;font-size:12px}
</style></head><body>
<header>
<span class="g"><b>Artifact</b><button data-a="deck">Deck</button><button data-a="memo">Memo</button><button data-a="handrolled">Hand-rolled deck</button></span>
<span class="g"><b>Mode</b><button data-m="inline">Inline</button><button data-m="fullscreen">Fullscreen</button></span>
<span class="g"><b>Theme</b><button data-t="light">Light</button><button data-t="dark">Dark</button></span>
<span class="g"><b>Host</b><button id="reject" title="ChatGPT delivers a refused tool call as a rejected request">Rejects tool errors</button><button id="reload">Reload card</button></span>
<span class="g"><b>Model</b><button id="m-edit">Publishes a change</button><button id="m-choices">Asks (choices)</button><button id="m-free">Asks (free text)</button><button id="m-v1">Shows v1</button></span>
</header>
<div id="wrap"><div id="card"></div><div>
<h4>Model context (next turn)</h4><pre id="ctx">(nothing yet)</pre>
<h4>Messages into the chat (ui/message)</h4><pre id="chat">(none)</pre>
<h4>Protocol</h4><pre id="log"></pre></div></div>
<script type="module">
const TOKEN=${JSON.stringify(TOKEN)}, SEED=${JSON.stringify(seed)}, VIEW_URI=${JSON.stringify(ARTIFACT_VIEW_URI)}
const q=new URLSearchParams(location.search)
const st={a:q.get("a")||"deck",m:q.get("m")||"inline",t:q.get("t")||"light",reject:q.get("reject")==="1",show:{}}
let id=100, view=null
const $=(s)=>document.querySelector(s)
const log=(s)=>{const l=$("#log");l.textContent=(new Date().toLocaleTimeString()+" "+s+"\\n"+l.textContent).slice(0,8000)}
const mcp=async(method,params)=>{const r=await fetch("/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+TOKEN},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})});const t=await r.text();const line=t.split("\\n").find(l=>l.startsWith("data:"));return JSON.parse(line?line.slice(5):t).result}
const tool=(name,args)=>mcp("tools/call",{name,arguments:args})
const post=(m)=>view&&view.contentWindow.postMessage(Object.assign({jsonrpc:"2.0"},m),"*")
const ctx=()=>({theme:st.t,displayMode:st.m,availableDisplayModes:["inline","fullscreen"],containerDimensions:{maxHeight:st.m==="fullscreen"?820:520}})
const sync=()=>{for(const b of document.querySelectorAll("[data-a]"))b.classList.toggle("on",b.dataset.a===st.a);for(const b of document.querySelectorAll("[data-m]"))b.classList.toggle("on",b.dataset.m===st.m);for(const b of document.querySelectorAll("[data-t]"))b.classList.toggle("on",b.dataset.t===st.t);$("#reject").classList.toggle("on",st.reject);document.body.style.background=st.t==="dark"?"#1b1b1a":"#f3f3f1";history.replaceState(null,"","?"+new URLSearchParams({a:st.a,m:st.m,t:st.t,reject:st.reject?"1":"0"}))}
// A fresh card: fetch the view again (what a reopened chat does) and run show as the model would.
// The view loads from /view, which reads the resource the way a host does: a real origin,
// so the view can offer editing (srcdoc would leave it with an opaque one).
const mount=async(showArgs)=>{st.show=showArgs||{short_id:SEED[st.a]};log("resources/read "+VIEW_URI);$("#card").textContent="";view=document.createElement("iframe");view.setAttribute("sandbox","allow-scripts allow-same-origin allow-forms");view.height=st.m==="fullscreen"?820:520;view.src="/view?"+Date.now();$("#card").appendChild(view)}
window.addEventListener("message",async(e)=>{if(!view||e.source!==view.contentWindow)return;const d=e.data;if(!d||d.jsonrpc!=="2.0")return
 if(d.method)log("view → "+d.method+(d.method==="tools/call"?" "+d.params.name+" "+JSON.stringify(d.params.arguments).slice(0,140):""))
 if(d.method==="ui/initialize")post({id:d.id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"derive-dev-host",version:"0"},hostCapabilities:{openLinks:{},serverTools:{},updateModelContext:{text:{}},message:{text:{}}},hostContext:ctx()}})
 else if(d.method==="ui/notifications/initialized"){post({method:"ui/notifications/tool-input",params:{arguments:st.show}});const r=await tool("show",st.show);log("show → "+(r.content?.[0]?.text||"").slice(0,160));post({method:"ui/notifications/tool-result",params:r})}
 else if(d.method==="tools/call"){const r=await tool(d.params.name,d.params.arguments);if(r.isError&&st.reject){log("host rejects the refused call");post({id:d.id,error:{code:-32000,message:r.content?.[0]?.text||"Tool error"}})}else post({id:d.id,result:r})}
 else if(d.method==="ui/update-model-context"){$("#ctx").textContent=d.params.content[0].text+"\\n\\n"+JSON.stringify(d.params.structuredContent,null,1);post({id:d.id,result:{}})}
 else if(d.method==="ui/message"){const c=$("#chat");c.textContent=(c.textContent==="(none)"?"":c.textContent+"\\n")+"person: "+(d.params?.content?.[0]?.text||JSON.stringify(d.params));post({id:d.id,result:{}})}
 else if(d.method==="ui/open-link"){log("open "+d.params.url);post({id:d.id,result:{}})}
 else if(d.method==="ui/request-display-mode"){st.m=d.params.mode;sync();view.height=st.m==="fullscreen"?820:520;post({id:d.id,result:{mode:st.m}});post({method:"ui/notifications/host-context-changed",params:ctx()})}
 else if(d.id!=null&&d.method)post({id:d.id,result:{}})
})
for(const b of document.querySelectorAll("[data-a]"))b.onclick=()=>{st.a=b.dataset.a;sync();mount()}
for(const b of document.querySelectorAll("[data-m]"))b.onclick=()=>{st.m=b.dataset.m;sync();if(view){view.height=st.m==="fullscreen"?820:520;post({method:"ui/notifications/host-context-changed",params:ctx()})}}
for(const b of document.querySelectorAll("[data-t]"))b.onclick=()=>{st.t=b.dataset.t;sync();post({method:"ui/notifications/host-context-changed",params:ctx()})}
$("#reject").onclick=()=>{st.reject=!st.reject;sync()}
$("#reload").onclick=()=>mount(st.show)
// The model acting between the person's moves: a new version, a question, an older version.
$("#m-edit").onclick=async()=>{const sid=SEED[st.a];const src=(await tool("read",{short_id:sid,format:"html"})).content[0].text;const m=/<h1[^>]*>([^<]+)<\\/h1>/.exec(src);if(!m)return log("no <h1> to change");const r=await tool("publish",{short_id:sid,edits:[{old_str:m[0],new_str:m[0].replace(m[1],m[1]+" (model)")}],message:"The model's edit"});log("model published: "+r.content[0].text.slice(0,120))}
const ask=async(options)=>{const sid=SEED[st.a];const r=JSON.parse((await tool("comment",{short_id:sid,body:options.length?"Who is this for?":"What should we call it?",options})).content[0].text);mount({short_id:sid,thread:r.thread})}
$("#m-choices").onclick=()=>ask(["Engineers","Designers","Executives"])
$("#m-free").onclick=()=>ask([])
$("#m-v1").onclick=()=>mount({short_id:SEED[st.a],version:1})
sync();mount()
</script></body></html>`

serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: async (req: Request) => {
    const path = new URL(req.url).pathname
    if (path === "/")
      return new Response(HOST, { headers: { "content-type": "text/html; charset=utf-8" } })
    if (path === "/view") {
      const res = await mcp("resources/read", { uri: ARTIFACT_VIEW_URI })
      return new Response(res.contents[0].text, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      })
    }
    return app.fetch(req)
  },
})
console.log(`Derive app host: ${BASE}/   (data in ${DIR}; delete it to reseed)`)
