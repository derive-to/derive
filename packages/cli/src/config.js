// dock.json + scaffold logic, kept pure so it's unit-testable without a server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const CONFIG_FILE = "dock.json"

/** The dock.json a fresh project starts with (no id until first publish). */
export const defaultConfig = (title = "My artifact", entry = "index.md") => ({
  title,
  entry,
  visibility: "link",
  spa: false,
  id: null,
})

export const TEMPLATES = ["md", "html", "slides"]

/** Read dock.json from `dir`, or null if absent. Throws on malformed JSON. */
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
 * Effective publish settings: CLI flags win over dock.json, which wins over
 * built-in defaults. Returns the values the publish command actually uses.
 */
export function resolvePublish(opts = {}, config = null) {
  const c = config ?? {}
  const spa = opts.spa != null ? opts.spa === "true" || opts.spa === true : !!c.spa
  return {
    id: opts.id ?? c.id ?? null,
    target: opts.target ?? c.entry ?? null,
    title: opts.title ?? c.title,
    slug: opts.slug ?? c.slug,
    visibility: opts.visibility ?? c.visibility,
    spa,
    message: opts.message,
    name: opts.name,
    server: opts.server ?? c.server ?? process.env.DOCK_SERVER ?? "http://localhost:8080",
    token: opts.token ?? process.env.DOCK_TOKEN,
  }
}

/** Persist the server-assigned id back into dock.json (preserving other keys). */
export function writeId(dir, id) {
  const path = join(dir, CONFIG_FILE)
  const config = loadConfig(dir) ?? defaultConfig()
  config.id = id
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

// Each template's entry file + its starter content. AGENTS.md + dock.json are
// added to every template.
const STARTERS = {
  md: { entry: "index.md", content: () => STARTER_MD },
  html: { entry: "index.html", content: (t) => starterHtml(t) },
  slides: { entry: "slides.html", content: (t) => starterSlides(t) },
}

/**
 * Files a new project gets for a template. dock.json drives publishing; AGENTS.md
 * is the loop convention for agents; the entry file is a publishable starter so
 * `dock publish` works immediately.
 */
export function scaffoldFiles(title = "My artifact", template = "md") {
  const t = STARTERS[template] ?? STARTERS.md
  return {
    [CONFIG_FILE]: `${JSON.stringify(defaultConfig(title, t.entry), null, 2)}\n`,
    [t.entry]: t.content(title),
    "AGENTS.md": AGENTS_MD,
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

const STARTER_MD = `# My artifact

Edit this, then run \`dock publish\`. Every publish becomes a new version at the
same URL, and reviewers can comment on the rendered page.

## Tips for durable comments

Comments anchor to the words they're attached to. They survive edits best when
surrounding text stays recognizable — keep headings stable and avoid rewording
a sentence end to end when you only meant to tweak it. See STANDARD.md.
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
  <p>Edit this file and run <code>dock publish</code>. Each publish is a new version
  at the same URL, and reviewers can select any text to comment on it.</p>
</body>
</html>
`

// Pure-HTML slides with a small viewing + presentation layer (arrow / space to
// navigate, F for fullscreen). Self-contained so it renders in the sandbox.
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
  .num{position:fixed;bottom:14px;right:18px;font-size:13px;color:var(--mut);font-variant-numeric:tabular-nums}
  kbd{background:rgba(255,255,255,.1);border-radius:4px;padding:1px 6px;font-size:.8em}
</style>
</head>
<body>
<div class="deck">
  <section class="slide on">
    <h1>${title}</h1>
    <p class="lede">Pure-HTML slides. <kbd>→</kbd> / <kbd>Space</kbd> to advance, <kbd>←</kbd> back, <kbd>F</kbd> fullscreen.</p>
  </section>
  <section class="slide">
    <h2>One idea per slide</h2>
    <ul>
      <li>Write each slide as a <code>&lt;section class="slide"&gt;</code>.</li>
      <li>Publish with <code>dock publish</code>; reviewers comment on any slide.</li>
      <li>Every publish is a new version at the same URL.</li>
    </ul>
  </section>
  <section class="slide">
    <h2>Make it yours</h2>
    <p class="lede">Edit the markup and styles. It's just HTML.</p>
  </section>
</div>
<div class="bar"><i></i></div>
<div class="num"></div>
<script>
  var slides=[].slice.call(document.querySelectorAll('.slide')),i=0;
  var bar=document.querySelector('.bar i'),num=document.querySelector('.num');
  function show(n){i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach(function(s,k){s.classList.toggle('on',k===i)});
    bar.style.width=((i+1)/slides.length*100)+'%';num.textContent=(i+1)+' / '+slides.length}
  addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){e.preventDefault();show(i+1)}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){show(i-1)}
    else if(e.key==='f'||e.key==='F'){if(!document.fullscreenElement)document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();else document.exitFullscreen()}
  });
  addEventListener('click',function(e){if(e.target.closest('a'))return;show(i+1)});
  show(0);
</script>
</body>
</html>
`

// Scaffolded into every project: the publish -> review -> revise loop, written
// for an agent (or a human) to follow without prior knowledge of Dock.
const AGENTS_MD = `# Working with Dock

This project publishes to **Dock**: artifacts get a permanent URL, versions, and
inline comments. Config lives in \`dock.json\`; the artifact id is filled in there
after the first publish, so later publishes target the same artifact.

## Publish

\`\`\`bash
dock publish              # publishes dock.json "entry", or:
dock publish ./report.md  # a file, or a folder (a built site)
\`\`\`

Each publish is a new immutable version at the same URL. Name a checkpoint with
\`dock publish --name "Final draft"\`.

## The loop: publish -> review -> revise

1. **Publish** a draft. Share the URL.
2. **Read comments** — each has a quote (the anchored text), a thread, and a state:
   \`\`\`bash
   curl -s "$DOCK_SERVER/v1/artifacts/$ID/comments"
   \`\`\`
3. **Revise** the source to address the feedback, then **publish again** — same id,
   new version. The comment's highlight re-anchors to the moved text automatically.
4. **Reply in-thread** to discuss, or **resolve** a thread once handled:
   \`\`\`bash
   # reply (omit thread_id to start a new thread)
   curl -s -X POST "$DOCK_SERVER/v1/artifacts/$ID/comments" \\
     -H 'content-type: application/json' \\
     -d '{"thread_id":"<id>","body_md":"Addressed in the new version."}'

   # resolve the thread a comment belongs to
   curl -s -X POST "$DOCK_SERVER/v1/artifacts/$ID/comments/<commentId>/resolve" \\
     -H 'content-type: application/json' -d '{"state":"resolved"}'
   \`\`\`
   Republishing can also resolve threads in one call: add \`resolves=<commentId,...>\`
   to the publish request.

## Keep comments anchorable

Anchors are text quotes with surrounding context. They survive edits when prose
stays recognizable. Prefer small, local edits over wholesale rewrites; keep
headings and distinctive phrases stable. Full guidance: STANDARD.md.
`
