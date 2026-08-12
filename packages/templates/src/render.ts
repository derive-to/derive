import { deckTemplate } from "@derive/core"
import { getTemplate } from "./catalog"
import type { BuiltInTemplate, TemplateDraft } from "./types"

type TemplateValues = Readonly<Record<string, string>>

// A deterministic, authored visual recipe. Templates own usable source now; a
// future Themes capability can transform a copied draft without changing this
// catalog's structure or provenance contract.
const DEFAULT_TEMPLATE_STYLE =
  '--bg:#f4f1e9;--fg:#1c1a17;--mut:#6e675e;--line:#cfc7ba;--accent:#aa3f2b;--display:Georgia,serif;--body:"Helvetica Neue",sans-serif;--radius:0px'
const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const providedValues = (template: BuiltInTemplate, values?: TemplateValues) =>
  template.inputs
    .map((input) => ({ input, value: values?.[input.name]?.trim() ?? "" }))
    .filter((item) => !!item.value)

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

function markdownDraft(template: BuiltInTemplate, values?: TemplateValues): string {
  const contextNotice =
    template.kind === "context"
      ? "> This manifest defines an agent setup. Bind a runner, sources, permissions, and credentials separately after publishing.\n\n"
      : ""
  const inputs = template.inputs
    .map((item) => {
      const value = values?.[item.name]?.trim()
      return `- **${item.name}${item.required ? " · required" : ""}:** ${value || item.description}`
    })
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

function deckDraft(template: BuiltInTemplate, values?: TemplateValues): string {
  const supplied = providedValues(template, values)
  const slides = template.sections
    .map((section, index) => {
      const briefCards = supplied
        .slice(0, 3)
        .map(
          ({ input, value }) =>
            `<div class="card"><b>${esc(input.name)}</b><span>${esc(value)}</span></div>`,
        )
        .join("\n      ")
      const cards =
        index === 0 && briefCards
          ? briefCards
          : `<div class="card"><b>Claim</b><span>Replace with the single idea this slide must make clear.</span></div>
      <div class="card"><b>Evidence</b><span>Add one visual or fact that carries the argument.</span></div>
      <div class="card"><b>Implication</b><span>Name what changes for the audience now.</span></div>`
      const lede = index === 0 && supplied[1]?.value ? supplied[1].value : promptFor(section)
      return `<section class="slide" data-derive-slide="${index}">
  <span class="eyebrow">${esc(template.title)} · ${String(index + 1).padStart(2, "0")}</span>
  <h${index === 0 ? "1" : "2"}>${esc(section)}</h${index === 0 ? "1" : "2"}>
  <p class="lede">${esc(lede)}</p>
  <div class="body">
    <div class="cards">
      ${cards}
    </div>
  </div>
</section>`
    })
    .join("\n")
  const canonical = deckTemplate(template.defaultTitle)
  const stageStart = canonical.indexOf('<div class="stage" id="stage">')
  const firstSlide = canonical.indexOf('<section class="slide"', stageStart)
  const stageClose = canonical.indexOf(
    '\n</div>\n\n<button type="button" class="zone l"',
    firstSlide,
  )
  if (firstSlide < 0 || stageClose < 0) return canonical
  return `${canonical.slice(0, firstSlide)}${slides}\n${canonical.slice(stageClose)}`
}

function pageDraft(template: BuiltInTemplate, values?: TemplateValues): string {
  const supplied = providedValues(template, values)
  const sections = template.sections
    .map(
      (section, index) => `<section${index === 0 ? ' class="lead"' : ""}>
  <span>${String(index + 1).padStart(2, "0")}</span>
  <div><h2>${esc(section)}</h2><p>${esc(promptFor(section))}</p></div>
</section>`,
    )
    .join("\n")
  const brief = supplied.length
    ? `<aside class="brief">${supplied
        .map(
          ({ input, value }) =>
            `<div><span>${esc(input.name)}</span><strong>${esc(value)}</strong></div>`,
        )
        .join("")}</aside>`
    : ""
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(template.defaultTitle)}</title>
<style>
  :root{${DEFAULT_TEMPLATE_STYLE}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 var(--body);letter-spacing:-.01em}main{width:min(1100px,calc(100% - 40px));margin:auto;padding:72px 0 100px}header{display:grid;grid-template-columns:1.4fr .6fr;gap:48px;padding-bottom:64px;border-bottom:1px solid var(--line)}.eyebrow{margin:0 0 14px;color:var(--accent);font:600 12px/1.2 var(--body);letter-spacing:.12em;text-transform:uppercase}h1{max-width:11ch;margin:0;font:600 clamp(48px,8vw,96px)/.95 var(--display);letter-spacing:-.05em}header>p{align-self:end;margin:0;color:var(--mut);font-size:20px}.brief{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:32px 0 0;background:var(--line);border:1px solid var(--line)}.brief div{display:grid;gap:8px;padding:20px;background:var(--bg)}.brief span{color:var(--accent);font-size:12px;text-transform:uppercase}.brief strong{font-size:16px}section{display:grid;grid-template-columns:72px 1fr;gap:24px;padding:34px 0;border-bottom:1px solid var(--line)}section span{color:var(--accent);font:12px var(--body)}section div{display:grid;grid-template-columns:minmax(180px,.6fr) 1fr;gap:32px}h2{margin:0;font:600 28px/1.05 var(--display);letter-spacing:-.03em}section p{max-width:52ch;margin:0;color:var(--mut)}footer{padding-top:48px;color:var(--mut);font-size:13px}@media(max-width:680px){main{padding-top:40px}header{grid-template-columns:1fr;gap:28px}.brief{grid-template-columns:1fr}section{grid-template-columns:36px 1fr}section div{grid-template-columns:1fr;gap:10px}}
</style></head><body><main><header><div><p class="eyebrow">Built from ${esc(template.title)}</p><h1>${esc(template.defaultTitle)}</h1></div><p>${esc(supplied[0]?.value || template.description)}</p></header>${brief}${sections}<footer>Created in Derive · Replace every prompt before publishing.</footer></main></body></html>`
}
export function renderTemplate(
  templateId: string | undefined,
  values?: TemplateValues,
): TemplateDraft | undefined {
  const template = getTemplate(templateId)
  if (!template) return undefined
  const source =
    template.format === "md"
      ? markdownDraft(template, values)
      : template.category === "Deck"
        ? deckDraft(template, values)
        : pageDraft(template, values)
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
