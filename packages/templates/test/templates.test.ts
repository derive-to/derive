import { describe, expect, it } from "vitest"
import { unsafeHtmlTemplateBindings } from "../src/html-bindings"
import {
  catalogResource,
  listTemplates,
  renderTemplate,
  TEMPLATE_CATALOG_URI,
  templateResource,
} from "../src/index"

const artifactTemplates = listTemplates({ kind: "artifact" })

describe("Derive built-in templates catalog", () => {
  it("renders every deck through the canonical supported slide slot", () => {
    for (const template of artifactTemplates.filter((item) => item.category === "Deck")) {
      const draft = renderTemplate(template.id)
      expect(draft?.source, template.id).toContain("<!-- derive:slides:start -->")
      expect(draft?.source, template.id).toContain("<!-- derive:slides:end -->")
      expect(
        draft?.source.match(/^\s*<section class="slide" data-derive-slide=/gm),
        template.id,
      ).toHaveLength(template.sections.length)
      expect(draft?.source, template.id).toContain('source: "derive-deck"')
    }
  })

  it("keeps Context manifests portable and secret-free", () => {
    const draft = renderTemplate("weekly-research-context")
    expect(draft?.mimeType).toBe("text/markdown")
    expect(draft?.source).toContain(
      "Bind a runner, sources, permissions, and credentials separately",
    )
    expect(draft?.source).toContain("library: derive/built-ins")
    expect(draft?.source).not.toMatch(/(?:api[_-]?key|client[_-]?secret|authorization\s*:)/i)
  })

  it("serializes one discoverable catalog plus a source-bearing resource per Template", () => {
    const catalog = catalogResource()
    expect(catalog.uri).toBe(TEMPLATE_CATALOG_URI)
    const body = JSON.parse(catalog.text) as {
      templates: { template_id: string }[]
      counts: unknown
    }
    expect(body.templates).toHaveLength(30)
    expect(body.counts).toEqual({ artifacts: 24, contexts: 6 })
    const entry = templateResource("decision-memo")
    expect(entry?.uri).toBe("derive://templates/decision-memo")
    expect(entry?.text).toContain("# Decision memo")
  })
})

describe("HTML template bindings", () => {
  const inputs = [
    { name: "Project name", description: "The project", required: true },
    { name: "Audience", description: "Who sees it" },
  ]

  it("rejects declared bindings in tags, scripts, or styles", () => {
    const source =
      '<h1 data-name="{{Project name}}">{{Project name}}</h1><script>"{{Audience}}"</script>'
    expect(unsafeHtmlTemplateBindings(source, inputs)).toEqual(["Project name", "Audience"])
  })

  it("scans malformed, whitespace-heavy bindings without regex backtracking", () => {
    const source = `{{{{${" ".repeat(20_000)}<div data-name="{{Project name}}">ok</div>`
    expect(unsafeHtmlTemplateBindings(source, inputs)).toEqual(["Project name"])
  })
})
