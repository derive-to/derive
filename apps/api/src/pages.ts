import { escapeHtml, type ArtifactRecord, type UserRecord } from "@dock/core"

const HEAD = (title: string) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · Dock</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--paper:#f6f0e3;--panel:#fdf8ec;--panel-2:#f1ead9;--ink:#2a2540;--soft:#46415c;--muted:#6b6680;
    --line:#e4dcc9;--line-2:#eee7d6;--accent:#655999;--accent-ink:#4f447e;--accent-soft:#e8e4f1;
    --sans:Inter,system-ui,sans-serif;--display:"Space Grotesk",var(--sans);--mono:ui-monospace,Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")}
  a{color:var(--accent-ink)}
  .mk{width:30px;height:30px}
  .brand{display:flex;align-items:center;gap:11px;font-family:var(--display);font-weight:600;font-size:20px;letter-spacing:-.02em}
  .btn{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:14px;padding:9px 15px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;text-decoration:none}
  .btn.pri{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn:hover{filter:brightness(1.03)}
  input{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 11px;font:14px var(--sans);color:var(--ink);background:var(--panel);margin-top:4px}
  label{font-size:12.5px;font-weight:600;color:var(--soft)}
  .err{background:#f1e1d6;color:#a04425;border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:12px}
</style></head><body>`

const LOGO = `<svg class="mk" viewBox="0 0 32 32" fill="none"><rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540"/>
<path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="#8a7dc0" stroke-width="1.7" stroke-linejoin="round"/>
<rect x="13.6" y="6.4" width="4.8" height="4.8" rx="1.2" fill="#655999"/></svg>`

export function renderLogin(opts: { error?: string; firstUser: boolean } = { firstUser: false }): string {
  const { error, firstUser } = opts
  return `${HEAD("Sign in")}
<div style="max-width:380px;margin:9vh auto;padding:0 22px">
  <div class="brand" style="justify-content:center;margin-bottom:6px">${LOGO} Dock</div>
  <p style="text-align:center;color:var(--muted);margin:0 0 26px">${firstUser ? "Create the first account to get started." : "Sign in to your workspace."}</p>
  <div style="background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 12px 28px -16px rgba(42,37,64,.25)">
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="${firstUser ? "/auth/signup" : "/auth/login"}">
      ${firstUser ? `<div style="margin-bottom:12px"><label>Name</label><input name="name" placeholder="Your name"></div>` : ""}
      <div style="margin-bottom:12px"><label>Email</label><input name="email" type="email" required placeholder="you@company.com"></div>
      <div style="margin-bottom:16px"><label>Password</label><input name="password" type="password" required minlength="8" placeholder="At least 8 characters"></div>
      <button class="btn pri" type="submit" style="width:100%;justify-content:center">${firstUser ? "Create account" : "Sign in"}</button>
    </form>
    ${
      firstUser
        ? ""
        : `<p style="text-align:center;font-size:13px;color:var(--muted);margin:14px 0 0">New here? <a href="/signup">Create an account</a></p>`
    }
  </div>
</div></body></html>`
}

export function renderSignup(error?: string): string {
  return renderLogin({ error, firstUser: true })
    .replace("/auth/signup", "/auth/signup")
    .replace("Create the first account to get started.", "Create your account.")
}

export function renderHome(user: UserRecord, artifacts: ArtifactRecord[], baseUrl: string): string {
  const cards =
    artifacts.length === 0
      ? `<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:40px;border:1px dashed var(--line);border-radius:14px">Nothing published yet. Use the box above, or <code>dock publish</code> from your terminal.</div>`
      : artifacts
          .map((a) => {
            const url = `${baseUrl}/a/${a.short_id}${a.slug ? `-${a.slug}` : ""}`
            return `<a href="${url}" style="display:flex;flex-direction:column;gap:7px;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:15px;text-decoration:none;color:var(--ink);box-shadow:0 1px 2px rgba(42,37,64,.04)">
      <div style="font-family:var(--display);font-weight:600;font-size:15px;letter-spacing:-.01em">${escapeHtml(a.title ?? a.short_id)}</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--muted);display:flex;gap:8px">
        <span style="background:var(--panel-2);border:1px solid var(--line-2);border-radius:5px;padding:1px 6px">${a.kind}</span>
        <span>v${a.current_version}</span><span>${a.visibility}</span></div></a>`
          })
          .join("")
  return `${HEAD("Library")}
<header style="display:flex;align-items:center;gap:12px;padding:13px 26px;background:var(--panel);border-bottom:1px solid var(--line)">
  <span class="brand" style="font-size:18px">${LOGO} Dock</span>
  <span style="margin-left:auto;font-size:13px;color:var(--muted)">${escapeHtml(user.name ?? user.email)}</span>
  <form method="post" action="/auth/logout"><button class="btn" style="padding:6px 12px;font-size:13px">Sign out</button></form>
</header>
<main style="max-width:1000px;margin:0 auto;padding:26px 22px 60px">
  <div style="background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:18px;margin-bottom:24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
    <div style="flex:1;min-width:220px"><div style="font-family:var(--display);font-weight:600;font-size:16px">Publish an artifact</div>
      <div style="font-size:13px;color:var(--muted)">Drop an HTML or Markdown file, or run <code>dock publish ./file</code>.</div></div>
    <input type="file" id="file" accept=".html,.htm,.md,.markdown,.zip" style="max-width:260px;margin:0">
    <button class="btn pri" id="pub">Publish</button>
  </div>
  <h2 style="font-family:var(--display);font-size:18px;letter-spacing:-.01em;margin:0 0 14px">Library <span style="color:var(--muted);font-weight:400;font-size:14px">· ${artifacts.length}</span></h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:13px">${cards}</div>
</main>
<script>
const f=document.getElementById("file"), b=document.getElementById("pub");
b.onclick=async()=>{ if(!f.files[0]){f.click();return;} const fd=new FormData(); fd.append("file",f.files[0]); fd.append("title",f.files[0].name.replace(/\\.[^.]+$/,""));
  b.textContent="Publishing…"; const r=await fetch("/v1/artifacts",{method:"POST",body:fd});
  if(r.ok){ const j=await r.json(); location.href="/a/"+j.short_id; } else { b.textContent="Publish"; alert("Publish failed"); } };
</script>
</body></html>`
}
