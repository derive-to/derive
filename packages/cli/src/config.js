// derive.json + scaffold logic, kept pure so it's unit-testable without a server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CONFIG_FILE = "derive.json"

// Where `derive` talks to by default: the hosted cloud. `--local` targets a dev
// server on this machine; `--server <url>` or DERIVE_SERVER override either.
export const CLOUD_SERVER = "https://derive.to"
export const LOCAL_SERVER = "http://localhost:8080"

/** Resolve the target server: `--server` wins, then `--local`, then a project's
 *  derive.json server, then DERIVE_SERVER, else the hosted cloud. */
export function resolveServer(opts = {}, config = null) {
  if (opts.server) return String(opts.server).replace(/\/+$/, "")
  if (opts.local) return LOCAL_SERVER
  return (config?.server ?? process.env.DERIVE_SERVER ?? CLOUD_SERVER).replace(/\/+$/, "")
}

// ---- User-level credentials (`derive login`) --------------------------------
// Tokens are secrets, so they live in a user-level store (one entry per Derive
// origin), never in the project's derive.json. DERIVE_CONFIG_DIR overrides the dir.

const configDir = () => process.env.DERIVE_CONFIG_DIR ?? join(homedir(), ".config", "derive")
const credsPath = () => join(configDir(), "credentials.json")

/** Normalize a server URL to its origin so one entry covers every path under it. */
const originOf = (server) => {
  try {
    return new URL(server).origin
  } catch {
    return server
  }
}

/** All saved credentials, keyed by server origin. {} if none / unreadable. */
export function loadCredentials() {
  try {
    return JSON.parse(readFileSync(credsPath(), "utf8"))
  } catch {
    return {}
  }
}

/** Persist a grant for `server` (0600, owner-only). Stores the access token plus
 *  the refresh token + client id + expiry, so `freshToken` can renew silently and
 *  a one-time `derive login` never expires — the zero-click-after-connect default.
 *  Returns the store path. Back-compat: a bare string is treated as {token}. */
export function saveToken(server, grant) {
  const g = typeof grant === "string" ? { token: grant } : grant
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const all = loadCredentials()
  all[originOf(server)] = {
    token: g.token,
    refresh_token: g.refresh_token ?? null,
    client_id: g.client_id ?? null,
    // Refresh a minute early so an in-flight publish never races the expiry.
    expires_at: g.expires_in
      ? new Date(Date.now() + (g.expires_in - 60) * 1000).toISOString()
      : null,
    saved_at: new Date().toISOString(),
  }
  writeFileSync(credsPath(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  return credsPath()
}

/** The saved access token for `server`, or null (no refresh). */
export function tokenFor(server) {
  return loadCredentials()[originOf(server)]?.token ?? null
}

/** A live access token for `server`: the saved one if still valid, else refreshed
 *  silently via the stored refresh token (rotating it). null if nothing is saved.
 *  This is what makes `derive publish` zero-click after a one-time `derive login`. */
export async function freshToken(server) {
  const entry = loadCredentials()[originOf(server)]
  if (!entry) return null
  const valid = !entry.expires_at || new Date(entry.expires_at).getTime() > Date.now()
  if (valid || !entry.refresh_token || !entry.client_id) return entry.token ?? null
  try {
    const res = await fetch(`${originOf(server)}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: entry.refresh_token,
        client_id: entry.client_id,
      }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j.access_token) return entry.token ?? null
    saveToken(server, {
      token: j.access_token,
      refresh_token: j.refresh_token ?? entry.refresh_token,
      client_id: entry.client_id,
      expires_in: j.expires_in,
    })
    return j.access_token
  } catch {
    return entry.token ?? null
  }
}

/** The derive.json a fresh project starts with (no id until first publish).
 *  Private visibility, like every other publish path — a scaffolded project
 *  opts into wider sharing by editing this field, not by accident. */
export const defaultConfig = (title = "My artifact", entry = "index.md") => ({
  $schema: "./derive.schema.json",
  title,
  entry,
  visibility: "private",
  spa: false,
  id: null,
})

export const TEMPLATES = ["md", "html", "slides", "site", "skill"]

/** Read derive.json from `dir`, or null if absent. Throws on malformed JSON. */
export function loadConfig(dir = ".") {
  const path = join(dir, CONFIG_FILE)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`)
  }
}

/**
 * Effective publish settings: CLI flags win over derive.json, which wins over
 * built-in defaults. Returns the values the publish command actually uses.
 */
export function resolvePublish(opts = {}, config = null) {
  const c = config ?? {}
  const spa = opts.spa != null ? opts.spa === "true" || opts.spa === true : !!c.spa
  const server = resolveServer(opts, c)
  return {
    id: opts.id ?? c.id ?? null,
    target: opts.target ?? c.entry ?? null,
    title: opts.title ?? c.title,
    slug: opts.slug ?? c.slug,
    visibility: opts.visibility ?? c.visibility,
    spa,
    message: opts.message,
    name: opts.name,
    server,
    // Explicit flag / env win; otherwise fall back to the `derive login` token.
    token: opts.token ?? process.env.DERIVE_TOKEN ?? tokenFor(server),
  }
}

/** Persist the server-assigned id back into derive.json (preserving other keys). */
export function writeId(dir, id) {
  const path = join(dir, CONFIG_FILE)
  const config = loadConfig(dir) ?? defaultConfig()
  config.id = id
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

// Each template's entry (what `derive publish` targets) + the starter file(s) it
// writes. `site` is a multi-file bundle (entry is a directory). derive.json,
// derive.schema.json, and AGENTS.md are added to every template.
const STARTERS = {
  md: { entry: "index.md", files: (t) => ({ "index.md": starterMd(t) }) },
  html: { entry: "index.html", files: (t) => ({ "index.html": starterHtml(t) }) },
  slides: { entry: "slides.html", files: (t) => ({ "slides.html": starterSlides(t) }) },
  site: {
    entry: "site",
    files: (t) => ({
      "site/index.html": starterSiteIndex(t),
      "site/about.html": starterSiteAbout(t),
      "site/style.css": SITE_CSS,
    }),
  },
  // A Claude Code skill: a SKILL.md (frontmatter + body) plus scripts/ + references/.
  // `derive publish skill/` zips the folder; Derive renders SKILL.md and recognizes it as
  // a skill (the project's derive.json/AGENTS.md stay outside the bundled `skill/` dir).
  skill: {
    entry: "skill",
    files: (t) => ({
      "skill/SKILL.md": starterSkill(t),
      "skill/scripts/example.sh": STARTER_SKILL_SCRIPT,
      "skill/references/example.md": STARTER_SKILL_REFERENCE,
    }),
  },
}

/**
 * Files a new project gets for a template. derive.json drives publishing; AGENTS.md
 * is the loop convention for agents; the starter is publishable immediately. The
 * agent on-ramp ships too: a Claude Code skill (.claude/skills/derive) and a project
 * MCP config (.mcp.json) so "let my agent ship the page and bring comments back"
 * is wired the moment the project exists.
 */
export function scaffoldFiles(title = "My artifact", template = "md") {
  const t = STARTERS[template] ?? STARTERS.md
  return {
    [CONFIG_FILE]: `${JSON.stringify(defaultConfig(title, t.entry), null, 2)}\n`,
    "derive.schema.json": `${JSON.stringify(DERIVE_SCHEMA, null, 2)}\n`,
    ...t.files(title),
    "AGENTS.md": AGENTS_MD,
    ".claude/skills/derive/SKILL.md": SKILL_MD,
    ".mcp.json": `${JSON.stringify(MCP_CONFIG, null, 2)}\n`,
  }
}

/** Project-scoped MCP config (Claude Code et al. read `.mcp.json`). Reads the
 *  server + token from the environment so no secret is written to disk; falls
 *  back to a local server. `npx -y @derive/mcp` needs no install. */
// Shell-style env expansion the agent harness resolves when it reads .mcp.json:
// `${VAR:-default}`. Assembled from parts so the source carries no literal
// template placeholder (which a plain JS string shouldn't).
const envRef = (name, fallback = "") => ["${", name, ":-", fallback, "}"].join("")

const MCP_CONFIG = {
  mcpServers: {
    derive: {
      command: "npx",
      args: ["-y", "@derive/mcp"],
      env: {
        DERIVE_SERVER: envRef("DERIVE_SERVER", "http://localhost:8080"),
        DERIVE_TOKEN: envRef("DERIVE_TOKEN"),
      },
    },
  },
}

/** JSON Schema for derive.json — gives editors autocomplete + validation. */
export const DERIVE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "derive.json",
  type: "object",
  properties: {
    title: { type: "string", description: "Artifact title." },
    entry: { type: "string", description: "File or directory `derive publish` targets." },
    visibility: { enum: ["public", "link", "org", "password", "private"], default: "private" },
    spa: {
      type: "boolean",
      description: "Serve a single-page-app fallback for unknown paths.",
      default: false,
    },
    id: {
      type: ["string", "null"],
      description: "Artifact short id; set automatically on first publish.",
    },
    server: { type: "string", description: "Derive server URL (overrides DERIVE_SERVER)." },
  },
}

/** Render comments as a readable thread list for `derive comments`. Pure. */
export function formatComments(comments) {
  if (!comments || comments.length === 0) return "No comments yet."
  const threads = new Map()
  for (const c of comments) {
    if (!threads.has(c.thread_id)) threads.set(c.thread_id, [])
    threads.get(c.thread_id).push(c)
  }
  const out = []
  for (const [tid, thread] of threads) {
    const root = thread[0]
    const quote = anchorQuote(root.anchor)
    out.push(`${root.state === "resolved" ? "✓" : "○"} thread ${tid}${quote ? `  “${quote}”` : ""}`)
    for (const c of thread) out.push(`    ${c.author}: ${c.body_md.replace(/\n/g, " ")}`)
  }
  return out.join("\n")
}

const anchorQuote = (anchor) => {
  if (!anchor) return null
  try {
    return JSON.parse(anchor).exact ?? null
  } catch {
    return null
  }
}

/**
 * Write the scaffold into `dir`. Never clobbers existing files. Returns
 * { created: [...], skipped: [...] }.
 */
export function scaffold(dir = ".", title = "My artifact", template = "md") {
  mkdirSync(dir, { recursive: true })
  const files = scaffoldFiles(title, template)
  const created = []
  const skipped = []
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name)
    if (existsSync(path)) {
      skipped.push(name)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    created.push(name)
  }
  return { created, skipped }
}

// A skill's `name` must be a kebab-case slug (it's how the skill is invoked); the
// title may have spaces, so derive one.
const skillName = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "my-skill"

const starterSkill = (title) => `---
name: ${skillName(title)}
description: ${title} — say, in a sentence or two, when an agent should reach for this skill (the triggers and the job it does).
---

# ${title}

Replace this with what the skill does and how to use it. A skill is a folder: this
SKILL.md plus optional \`scripts/\` (helpers it can run) and \`references/\` (context
loaded on demand). Publish the folder with \`derive publish skill/\`.

## Steps

1. Describe the first step, declaratively, with a worked example.
2. ...

## Files

- \`scripts/example.sh\` — a helper this skill can run.
- \`references/example.md\` — extra context, loaded when needed.
`

const STARTER_SKILL_SCRIPT = `#!/usr/bin/env bash
# A helper this skill can run. Keep scripts self-contained and relative-path only.
set -euo pipefail
echo "hello from the skill"
`

const STARTER_SKILL_REFERENCE = `# Reference

Extra detail the skill loads on demand — keep SKILL.md lean and push the long tail
(edge cases, tables, examples) into reference files like this one.
`

const starterMd = (title) => `# ${title}

Edit this, then run \`derive publish\`. Every publish becomes a new version at the
same URL, and reviewers can comment on the rendered page.

## Tips for durable comments

Comments anchor to the words they're attached to. They survive edits best when
surrounding text stays recognizable — keep headings stable and avoid rewording
a sentence end to end when you only meant to tweak it. See STANDARD.md.
`

const starterSiteIndex = (title) => `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="/style.css">
<nav><a href="/">Home</a> · <a href="/about.html">About</a></nav>
<h1>${title}</h1>
<p>A multi-page static site, published as one artifact. Build any generator into
a folder; <code>derive publish</code> zips it and serves it. Absolute asset paths
are rewritten so the bundle stays sandboxed.</p>
`

const starterSiteAbout = (title) => `<!doctype html>
<meta charset="utf-8">
<title>About · ${title}</title>
<link rel="stylesheet" href="/style.css">
<nav><a href="/">Home</a> · <a href="/about.html">About</a></nav>
<h1>About</h1>
<p>Page two. Internal links work; reviewers can comment on any page.</p>
`

const SITE_CSS = `body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#23203a;
  max-width:640px;margin:0 auto;padding:48px 24px}
nav{font-size:14px;color:#655999;margin-bottom:22px}
a{color:#655999}
h1{letter-spacing:-.02em}
code{background:#f1ead9;padding:1px 6px;border-radius:5px}
`

const starterHtml = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{font:17px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#23203a;
    max-width:680px;margin:0 auto;padding:56px 24px}
  h1{font-size:38px;letter-spacing:-.02em;margin:0 0 6px}
  .sub{color:#6b6680;margin:0 0 28px}
  code{background:#f1ead9;padding:1px 6px;border-radius:5px;font-size:.9em}
</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="sub">A standalone HTML artifact.</p>
  <p>Edit this file and run <code>derive publish</code>. Each publish is a new version
  at the same URL, and reviewers can select any text to comment on it.</p>
</body>
</html>
`

// Pure-HTML slides with a real presentation layer: on-screen prev/next +
// fullscreen, keyboard, and the derive-deck protocol so the Derive viewer can drive
// it too (postMessage). Self-contained, renders in the sandbox.
const starterSlides = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#15101f;--fg:#f6e9d6;--ac:#b9aef0;--mut:#a99cc4}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{background:var(--bg);color:var(--fg);font:20px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}
  .deck{height:100%}
  .slide{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;
    padding:8vh 10vw;animation:in .35s ease}
  .slide.on{display:flex}
  @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  h1{font-size:clamp(34px,6vw,68px);letter-spacing:-.025em;line-height:1.05;margin:0 0 .3em}
  h2{font-size:clamp(26px,4vw,44px);letter-spacing:-.02em;margin:0 0 .4em}
  p,li{font-size:clamp(18px,2.4vw,26px);color:var(--fg)}
  .lede{color:var(--mut)}
  ul{padding-left:1.1em} li{margin:.3em 0}
  .bar{position:fixed;bottom:0;left:0;right:0;height:3px;background:rgba(255,255,255,.08)}
  .bar i{display:block;height:100%;background:var(--ac);transition:width .3s}
  /* on-screen controls — fade in on hover/move, always reachable */
  .ctrl{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;
    background:rgba(20,16,31,.72);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 8px;
    backdrop-filter:blur(8px);opacity:0;transition:opacity .25s;z-index:5}
  body:hover .ctrl,.ctrl:focus-within{opacity:1}
  .ctrl button{width:34px;height:34px;border:0;border-radius:50%;background:transparent;color:var(--fg);
    font-size:16px;cursor:pointer;display:grid;place-items:center}
  .ctrl button:hover{background:rgba(255,255,255,.12)}
  .ctrl .pos{font-size:13px;color:var(--mut);padding:0 8px;font-variant-numeric:tabular-nums;min-width:54px;text-align:center}
  .edge{position:fixed;top:0;bottom:0;width:18vw;border:0;background:transparent;cursor:pointer;z-index:4}
  .edge.l{left:0} .edge.r{right:0}
  kbd{background:rgba(255,255,255,.1);border-radius:4px;padding:1px 6px;font-size:.8em}
</style>
</head>
<body>
<div class="deck">
  <section class="slide on" data-derive-slide="0">
    <h1>${title}</h1>
    <p class="lede">Pure-HTML slides. <kbd>→</kbd> / <kbd>Space</kbd> advance, <kbd>←</kbd> back, <kbd>F</kbd> fullscreen.</p>
  </section>
  <section class="slide" data-derive-slide="1">
    <h2>One idea per slide</h2>
    <ul>
      <li>Write each slide as a <code>&lt;section class="slide" data-derive-slide="N"&gt;</code>.</li>
      <li>Publish with <code>derive publish</code>; reviewers comment on any slide.</li>
      <li>Every publish is a new version at the same URL.</li>
    </ul>
  </section>
  <section class="slide" data-derive-slide="2">
    <h2>Make it yours</h2>
    <p class="lede">Edit the markup and styles. It's just HTML.</p>
  </section>
</div>
<button class="edge l" aria-label="Previous"></button>
<button class="edge r" aria-label="Next"></button>
<div class="bar"><i></i></div>
<div class="ctrl">
  <button data-act="prev" aria-label="Previous slide">‹</button>
  <span class="pos"></span>
  <button data-act="next" aria-label="Next slide">›</button>
  <button data-act="full" aria-label="Fullscreen" title="Fullscreen (F)">⛶</button>
</div>
<script>
  var slides=[].slice.call(document.querySelectorAll('.slide')),i=0;
  var bar=document.querySelector('.bar i'),pos=document.querySelector('.pos');
  function announce(){ // derive-deck protocol: report position to the Derive viewer
    try{parent.postMessage({source:'derive-deck',type:'state',i:i,total:slides.length},'*')}catch(e){}
  }
  function show(n){i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach(function(s,k){s.classList.toggle('on',k===i)});
    bar.style.width=((i+1)/slides.length*100)+'%';pos.textContent=(i+1)+' / '+slides.length;announce()}
  function full(){if(!document.fullscreenElement){(document.documentElement.requestFullscreen||function(){})()}else{document.exitFullscreen()}}
  addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){e.preventDefault();show(i+1)}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){show(i-1)}
    else if(e.key==='f'||e.key==='F'){full()}
    else if(e.key==='Home'){show(0)} else if(e.key==='End'){show(slides.length-1)}
  });
  document.querySelector('.ctrl').addEventListener('click',function(e){
    var b=e.target.closest('button'); if(!b)return;
    var a=b.getAttribute('data-act'); if(a==='prev')show(i-1); else if(a==='next')show(i+1); else if(a==='full')full()});
  document.querySelector('.edge.l').addEventListener('click',function(){show(i-1)});
  document.querySelector('.edge.r').addEventListener('click',function(){show(i+1)});
  // accept drive commands from the Derive viewer's presentation bar
  addEventListener('message',function(e){var d=e.data;
    if(!d||d.source!=='derive-host'||d.type!=='deck')return;
    if(d.action==='next')show(i+1);else if(d.action==='prev')show(i-1);else if(d.action==='goto')show(d.n)});
  show(0); announce();
</script>
</body>
</html>
`

// Scaffolded into every project: the publish -> review -> revise loop, written
// for an agent (or a human) to follow without prior knowledge of Derive.
const AGENTS_MD = `# Working with Derive

This project publishes to **Derive**: artifacts get a permanent URL, versions, and
inline comments. Config lives in \`derive.json\`; the artifact id is filled in there
after the first publish, so later publishes target the same artifact.

## Publish

\`\`\`bash
derive publish              # publishes derive.json "entry", or:
derive publish ./report.md  # a file, or a folder (a built site)
\`\`\`

Each publish is a new immutable version at the same URL. Name a checkpoint with
\`derive publish --name "Final draft"\`.

## The loop: publish -> review -> revise

The CLI has a verb for each step (all read the artifact id from derive.json):

\`\`\`bash
derive publish                      # 1. publish a draft, share the URL
derive comments                     # 2. read the comment threads (quote · author · state)
# 3. revise the source for the feedback, then:
derive publish --name "Rev 2"       #    publish again — same URL, highlights re-anchor
derive reply <thread_id> "Fixed in this version."   # 4a. discuss
derive resolve <comment_id>         # 4b. close a handled thread  (derive reopen to undo)
derive open                         # open the artifact in a browser
\`\`\`

Each is also a plain HTTP call if you'd rather not shell out — see the API under
\`/v1/artifacts/:id/comments\`. Republishing can resolve threads in one shot:
include \`resolves=<commentId,...>\` in the publish request.

## Keep comments anchorable

Anchors are text quotes with surrounding context. They survive edits when prose
stays recognizable. Prefer small, local edits over wholesale rewrites; keep
headings and distinctive phrases stable. Full guidance: STANDARD.md.

## Using an agent harness

A Claude Code skill ships in \`.claude/skills/derive\`, and \`.mcp.json\` wires the
Derive MCP server (five tools: \`list_artifacts\`, \`read\`, \`catch_up\`, \`comment\`,
\`publish\`). Set \`DERIVE_SERVER\` and \`DERIVE_TOKEN\` in your environment;
both the CLI and the MCP server read them.
`

// A Claude Code / agent skill: discoverable, trigger-tagged instructions for the
// publish -> review -> revise loop. Mirrors AGENTS.md in skill form so a harness
// surfaces it automatically when the user asks to publish, share, or get feedback.
const SKILL_MD = `---
name: derive-publish
description: Publish this project to Derive — a permanent versioned URL with inline comments — and run the review loop (share, read comments, revise, resolve). Use when the user asks to publish, share, or ship a page, doc, or site, or to read and act on Derive review comments.
---

# Publish to Derive and close the loop

This project is wired to Derive (see \`derive.json\`). Derive hosts an artifact — HTML,
Markdown, or a static site — at a permanent, versioned URL with inline comments,
so a human or another agent reviews on the rendered page and you revise.

## Publish

\`\`\`bash
derive publish              # publishes derive.json "entry" (a file or a built folder)
\`\`\`

Each publish is a new immutable version at the same URL. Name a checkpoint with
\`derive publish --name "Final draft"\`.

## The loop: publish -> review -> revise

\`\`\`bash
derive publish                    # 1. share the URL
derive comments                   # 2. read threads (quote · author · state)
# 3. revise the source for the feedback, then republish:
derive publish --name "Rev 2"     #    same URL, highlights re-anchor
derive reply <thread_id> "Fixed." # 4a. discuss
derive resolve <comment_id>       # 4b. close a handled thread
\`\`\`

If the Derive MCP server is connected (\`.mcp.json\`), prefer its five tools for the same
loop without shelling out: \`catch_up\` (what changed plus open feedback) ->
\`read\` (content) -> \`comment\` (reply/resolve) and/or \`publish\` (pass \`addresses\`
to resolve the threads a revision fixes; \`publish\` goes live or files a proposal based
on your role, or with \`for_review:true\`). \`list_artifacts\` finds an artifact by title.

## Keep comments anchorable

Anchors are text quotes with context; they survive edits when surrounding text
stays recognizable. Prefer small, local edits; keep headings and distinctive
phrases stable. Full guidance: STANDARD.md.
`
