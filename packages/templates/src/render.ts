import { deckTemplateWithSlides } from "@derive/core"
import { getTemplate } from "./catalog"
import type { BuiltInTemplate, TemplateDraft } from "./types"

// A deterministic authored visual recipe. Templates own usable source while
// preserving a stable catalog and provenance contract.
const DEFAULT_TEMPLATE_STYLE =
  '--bg:#f4f1e9;--fg:#1c1a17;--mut:#6e675e;--line:#cfc7ba;--accent:#aa3f2b;--display:Georgia,serif;--body:"Helvetica Neue",sans-serif;--radius:0px'
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
  return `Add the information a reader needs about ${lower}.`
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

  return `<!-- Derive template: ${template.title} | library: ${template.libraryId} | id: ${template.id} | catalog: ${template.catalogVersion} -->

# ${template.defaultTitle}

> ${template.description}

${contextNotice}## Working inputs

${inputs}

---

${sections}${prompts}`
}

function deckDraft(template: BuiltInTemplate): string {
  const slides = template.sections
    .map((section, index) => {
      return `<section class="slide" data-derive-slide="${index}">
  <span class="eyebrow">${esc(template.title)} · ${String(index + 1).padStart(2, "0")}</span>
  <h${index === 0 ? "1" : "2"}>${esc(section)}</h${index === 0 ? "1" : "2"}>
  <div class="body">
    <p>${esc(promptFor(section))}</p>
  </div>
</section>`
    })
    .join("\n")
  return deckTemplateWithSlides(template.defaultTitle, slides)
}

function pageDraft(template: BuiltInTemplate): string {
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
  :root{${DEFAULT_TEMPLATE_STYLE}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 var(--body);letter-spacing:-.01em}main{width:min(1100px,calc(100% - 40px));margin:auto;padding:72px 0 100px}header{display:grid;grid-template-columns:1.4fr .6fr;gap:48px;padding-bottom:64px;border-bottom:1px solid var(--line)}.eyebrow{margin:0 0 14px;color:var(--accent);font:600 12px/1.2 var(--body);letter-spacing:.12em;text-transform:uppercase}h1{max-width:11ch;margin:0;font:600 clamp(48px,8vw,96px)/.95 var(--display);letter-spacing:-.05em}header>p{align-self:end;margin:0;color:var(--mut);font-size:20px}section{display:grid;grid-template-columns:72px 1fr;gap:24px;padding:34px 0;border-bottom:1px solid var(--line)}section span{color:var(--accent);font:12px var(--body)}section div{display:grid;grid-template-columns:minmax(180px,.6fr) 1fr;gap:32px}h2{margin:0;font:600 28px/1.05 var(--display);letter-spacing:-.03em}section p{max-width:52ch;margin:0;color:var(--mut)}@media(max-width:680px){main{padding-top:40px}header{grid-template-columns:1fr;gap:28px}section{grid-template-columns:36px 1fr}section div{grid-template-columns:1fr;gap:10px}}
</style></head><body><!-- Derive template: ${esc(template.title)} | library: ${esc(template.libraryId)} | id: ${esc(template.id)} | catalog: ${esc(String(template.catalogVersion))} --><main><header><div><p class="eyebrow">${esc(template.title)}</p><h1>${esc(template.defaultTitle)}</h1></div><p>${esc(template.description)}</p></header>${sections}</main></body></html>`
}
export function renderTemplate(templateId: string | undefined): TemplateDraft | undefined {
  const template = getTemplate(templateId)
  if (!template) return undefined
  const source =
    template.format === "md"
      ? markdownDraft(template)
      : template.category === "Deck"
        ? deckDraft(template)
        : pageDraft(template)
  const extension = template.format === "md" ? "md" : "html"
  return {
    source,
    filename: `${template.id}.${extension}`,
    mimeType: template.format === "md" ? "text/markdown" : "text/html",
    title: template.defaultTitle,
    message: `Created from ${template.libraryId}/${template.id} catalog v${template.catalogVersion}`,
    template,
  }
}
