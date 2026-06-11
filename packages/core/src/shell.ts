import { escapeHtml } from "./md"
import type { ArtifactRecord, VersionRecord } from "./ports"

const LOGO = `<svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">
<rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540"/>
<path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="#8a7dc0" stroke-width="1.7" stroke-linejoin="round"/>
<rect x="13.6" y="6.4" width="4.8" height="4.8" rx="1.2" fill="#655999"/></svg>`

/** Viewer chrome around the sandboxed artifact iframe. */
export function renderShell(
  artifact: ArtifactRecord,
  versions: VersionRecord[],
  shownVersion: number,
  rawSrc: string,
): string {
  const title = escapeHtml(artifact.title ?? artifact.short_id)
  const current = artifact.current_version
  const version = versions.find((v) => v.n === shownVersion)
  const chips = versions
    .map(
      (v) =>
        `<a class="chip${v.n === shownVersion ? " on" : ""}" href="/a/${artifact.short_id}@v${v.n}" title="${escapeHtml(v.message ?? "")}">v${v.n}</a>`,
    )
    .join("")
  const isMd = version?.content_type === "text/markdown"
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Dock</title>
<style>
  :root{--paper:#f6f0e3;--panel:#fdf8ec;--ink:#2a2540;--muted:#6b6680;--line:#e4dcc9;
    --accent:#655999;--accent-ink:#4f447e}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--paper);
    font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}
  header{display:flex;align-items:center;gap:10px;padding:9px 16px;background:var(--panel);
    border-bottom:1px solid var(--line);flex:0 0 auto}
  .t{font-weight:600;font-size:14px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--muted);white-space:nowrap}
  .chips{display:flex;gap:5px;margin-left:auto}
  .chip{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--muted);text-decoration:none;
    border:1px solid var(--line);border-radius:6px;padding:3px 8px;background:var(--paper)}
  .chip.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
  .btn{font-size:11.5px;font-weight:600;border:1px solid var(--line);background:var(--paper);color:var(--ink);
    border-radius:7px;padding:5px 11px;cursor:pointer;text-decoration:none}
  .btn:hover{border-color:var(--accent);color:var(--accent-ink)}
  .old{background:#f4ead4;color:#7a531a;font-size:11.5px;padding:4px 16px;border-bottom:1px solid var(--line);flex:0 0 auto}
  .old a{color:#7a531a;font-weight:700}
  iframe{flex:1;border:0;width:100%;background:#fff}
</style>
</head>
<body>
<header>
  ${LOGO}
  <span class="t">${title}</span>
  <span class="meta">v${shownVersion} · ${escapeHtml(version?.author ?? "")}${artifact.kind === "bundle" ? " · bundle" : ""}</span>
  <div class="chips">${chips}</div>
  ${isMd ? `<a class="btn" href="${rawSrc.replace(/index\.html$/, "raw.md")}">.md</a>` : ""}
  <button class="btn" onclick="navigator.clipboard.writeText(location.href).then(()=>{this.textContent='Copied';setTimeout(()=>this.textContent='Copy link',1200)})">Copy link</button>
</header>
${shownVersion !== current ? `<div class="old">Viewing v${shownVersion} — <a href="/a/${artifact.short_id}">jump to current (v${current})</a></div>` : ""}
<iframe src="${rawSrc}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" title="${title}"></iframe>
</body>
</html>`
}
