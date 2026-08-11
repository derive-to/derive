import { getTemplate } from "./catalog"
import type { BuiltInTemplate, TemplateDraft, TemplateVisualTheme } from "./types"

// The default is an authored, self-contained neutral visual recipe. It is not a
// user-selectable Theme; PR 2 will layer Theme catalog entries on top without
// changing template structure or provenance.
export const DEFAULT_TEMPLATE_VISUAL_THEME: TemplateVisualTheme = {
  id: "derive-default",
  css: '--bg:#f4f1e9;--fg:#1c1a17;--mut:#6e675e;--line:#cfc7ba;--accent:#aa3f2b;--display:Georgia,serif;--body:"Helvetica Neue",sans-serif;--radius:0px',
}
const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const promptFor = (section: string) => {
  const lower = section.toLowerCase()
  if (lower.includes("decision")) return "State the call plainly, then name who owns it."
  if (lower.includes("evidence") || lower.includes("proof"))
    return "Link the strongest evidence. Separate what is known from what is inferred."
  if (lower.includes("risk") || lower.includes("uncertainty"))
    return "Name the condition, its consequence, and the earliest signal that it is changing."
  if (lower.includes("measure") || lower.includes("score") || lower.includes("metric"))
    return "Use only the measures that change a decision. Include source and reporting window."
  if (lower.includes("owner") || lower.includes("commitment") || lower.includes("action"))
    return "Name one accountable owner and a concrete next check."
  if (lower.includes("source")) return "Add the artifacts or connected systems this work may use."
  return `Replace this note with the essential ${lower}. Keep it specific and reviewable.`
}

function markdownDraft(template: BuiltInTemplate): string {
  const contextNotice =
    template.kind === "context"
      ? "> This manifest defines an agent setup. Bind a runner, sources, permissions, and credentials separately after publishing.\n\n"
      : ""
  const inputs = template.inputs
    .map((item) => `- **${item.name}${item.required ? " · required" : ""}:** ${item.description}`)
    .join("\n")
  const sections = template.sections
    .map((section) => `## ${section}\n\n_${promptFor(section)}_\n`)
    .join("\n")
  const prompts = template.starterPrompts?.length
    ? `\n## Starter prompts\n\n${template.starterPrompts.map((item) => `- ${item}`).join("\n")}\n`
    : ""

  return `# ${template.defaultTitle}

> ${template.description}

${contextNotice}## Working inputs

${inputs}

---

${sections}${prompts}
## Provenance

- Template: **${template.title}**
- Template library: **${template.libraryId}**
- Template id: **${template.id}**
- Template catalog version: **${template.catalogVersion}**
- Created in: **Derive**
`
}

function deckDraft(template: BuiltInTemplate, theme: TemplateVisualTheme): string {
  const slides = template.sections
    .map(
      (
        section,
        index,
      ) => `<section class="slide${index === 0 ? " on" : ""}" data-derive-slide="${index}">
  <div class="number">${String(index + 1).padStart(2, "0")} / ${String(template.sections.length).padStart(2, "0")}</div>
  <p class="eyebrow">${esc(template.title)}</p>
  <h${index === 0 ? "1" : "2"}>${esc(section)}</h${index === 0 ? "1" : "2"}>
  <p class="lede">${esc(promptFor(section))}</p>
  <div class="rule"></div>
</section>`,
    )
    .join("\n")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(template.defaultTitle)}</title>
<style>
  :root{${theme.css}}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{overflow:hidden;background:var(--bg);color:var(--fg);font:18px/1.5 var(--body);letter-spacing:-.01em}
  .deck{height:100%}
  .slide{position:absolute;inset:0;display:none;grid-template-columns:minmax(0,1fr) minmax(12rem,.42fr);grid-template-rows:auto 1fr auto;gap:clamp(24px,4vw,64px);padding:clamp(40px,7vw,96px)}
  .slide.on{display:grid;animation:enter .28s cubic-bezier(.22,1,.36,1)}
  @keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .number{grid-column:2;font:12px/1.2 var(--body);letter-spacing:.12em;text-align:right;color:var(--mut)}
  .eyebrow{align-self:end;margin:0;color:var(--accent);font:600 12px/1.2 var(--body);letter-spacing:.12em;text-transform:uppercase}
  h1,h2{grid-column:1;align-self:start;max-width:12ch;margin:0;font-family:var(--display);font-weight:600;letter-spacing:-.045em;line-height:.96}
  h1{font-size:clamp(56px,8vw,110px)}
  h2{font-size:clamp(48px,7vw,92px)}
  .lede{grid-column:2;grid-row:2;align-self:end;margin:0;color:var(--mut);font-size:clamp(17px,2vw,24px);line-height:1.4}
  .rule{grid-column:1/-1;align-self:end;border-top:1px solid var(--line)}
  .progress{position:fixed;inset:auto 0 0;height:3px;background:var(--line)}
  .progress i{display:block;height:100%;background:var(--accent);transition:width .24s ease-out}
  .controls{position:fixed;right:18px;bottom:18px;display:flex;align-items:center;gap:4px;padding:5px;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);opacity:0;transition:opacity .18s}
  body:hover .controls,.controls:focus-within{opacity:1}
  button{width:34px;height:34px;border:0;background:transparent;color:var(--fg);font:20px var(--body)}
  button:hover{background:var(--line)}
  .pos{min-width:52px;text-align:center;color:var(--mut);font:12px var(--body)}
  @media(max-width:680px){.slide{grid-template-columns:1fr;grid-template-rows:auto auto 1fr auto}.number{grid-column:1}.lede{grid-column:1;grid-row:3;align-self:end}h1,h2{grid-column:1}.rule{grid-column:1}}
  @media(prefers-reduced-motion:reduce){.slide.on{animation:none}}
</style>
</head>
<body>
<main class="deck">${slides}</main>
<div class="progress"><i></i></div>
<div class="controls"><button data-act="prev" aria-label="Previous slide">‹</button><span class="pos"></span><button data-act="next" aria-label="Next slide">›</button></div>
<script>
  var slides=[].slice.call(document.querySelectorAll('.slide')),i=0,bar=document.querySelector('.progress i'),pos=document.querySelector('.pos');
  function announce(){try{parent.postMessage({source:'derive-deck',type:'state',i:i,total:slides.length},'*')}catch(e){}}
  function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach(function(s,k){s.classList.toggle('on',k===i)});bar.style.width=((i+1)/slides.length*100)+'%';pos.textContent=(i+1)+' / '+slides.length;announce()}
  addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){e.preventDefault();show(i+1)}else if(e.key==='ArrowLeft'||e.key==='PageUp'){show(i-1)}else if(e.key==='Home'){show(0)}else if(e.key==='End'){show(slides.length-1)}});
  document.querySelector('.controls').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;show(i+(b.getAttribute('data-act')==='next'?1:-1))});
  addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='derive-host'||d.type!=='deck')return;if(d.action==='next')show(i+1);else if(d.action==='prev')show(i-1);else if(d.action==='goto')show(d.n)});
  show(0);announce();
</script>
</body>
</html>`
}

function pageDraft(template: BuiltInTemplate, theme: TemplateVisualTheme): string {
  const sections = template.sections
    .map(
      (section, index) => `<section${index === 0 ? ' class="lead"' : ""}>
  <span>${String(index + 1).padStart(2, "0")}</span>
  <div><h2>${esc(section)}</h2><p>${esc(promptFor(section))}</p></div>
</section>`,
    )
    .join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(template.defaultTitle)}</title>
<style>
  :root{${theme.css}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 var(--body);letter-spacing:-.01em}main{width:min(1100px,calc(100% - 40px));margin:auto;padding:72px 0 100px}header{display:grid;grid-template-columns:1.4fr .6fr;gap:48px;padding-bottom:64px;border-bottom:1px solid var(--line)}.eyebrow{margin:0 0 14px;color:var(--accent);font:600 12px/1.2 var(--body);letter-spacing:.12em;text-transform:uppercase}h1{max-width:11ch;margin:0;font:600 clamp(48px,8vw,96px)/.95 var(--display);letter-spacing:-.05em}header>p{align-self:end;margin:0;color:var(--mut);font-size:20px}section{display:grid;grid-template-columns:72px 1fr;gap:24px;padding:34px 0;border-bottom:1px solid var(--line)}section span{color:var(--accent);font:12px var(--body)}section div{display:grid;grid-template-columns:minmax(180px,.6fr) 1fr;gap:32px}h2{margin:0;font:600 28px/1.05 var(--display);letter-spacing:-.03em}section p{max-width:52ch;margin:0;color:var(--mut)}footer{padding-top:48px;color:var(--mut);font-size:13px}@media(max-width:680px){main{padding-top:40px}header{grid-template-columns:1fr;gap:28px}section{grid-template-columns:36px 1fr}section div{grid-template-columns:1fr;gap:10px}}
</style></head><body><main><header><div><p class="eyebrow">Built from ${esc(template.title)}</p><h1>${esc(template.defaultTitle)}</h1></div><p>${esc(template.description)}</p></header>${sections}<footer>Created in Derive · Replace every prompt before publishing.</footer></main></body></html>`
}
export function renderTemplate(
  templateId: string | undefined,
  visualTheme: TemplateVisualTheme = DEFAULT_TEMPLATE_VISUAL_THEME,
): TemplateDraft | undefined {
  const template = getTemplate(templateId)
  if (!template) return undefined
  const source =
    template.format === "md"
      ? markdownDraft(template)
      : template.category === "Deck"
        ? deckDraft(template, visualTheme)
        : pageDraft(template, visualTheme)
  const extension = template.format === "md" ? "md" : "html"
  return {
    source,
    filename: `${template.id}.${extension}`,
    mimeType: template.format === "md" ? "text/markdown" : "text/html",
    title: template.defaultTitle,
    message: `Created from ${template.libraryId}/${template.id} catalog v${template.catalogVersion}`,
    format: template.format,
    template,
    origin: {
      libraryId: template.libraryId,
      templateId: template.id,
      catalogVersion: template.catalogVersion,
    },
  }
}
