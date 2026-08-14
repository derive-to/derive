import { describe, expect, it } from "vitest"
import {
  BUILT_INS_LIBRARY_ID,
  catalogResource,
  listTemplates,
  renderTemplate,
  TEMPLATE_CATALOG_URI,
  TEMPLATE_CATALOG_VERSION,
  templateResource,
} from "./index"

const artifactTemplates = listTemplates({ kind: "artifact" })
const contextTemplates = listTemplates({ kind: "context" })

describe("Derive built-in Templates catalog", () => {
  it("ships the planned artifact and Context starts with durable refs", () => {
    expect(artifactTemplates).toHaveLength(24)
    expect(contextTemplates).toHaveLength(6)
    const all = [...artifactTemplates, ...contextTemplates]
    expect(new Set(all.map((template) => template.id)).size).toBe(all.length)
    expect(all.every((template) => template.libraryId === BUILT_INS_LIBRARY_ID)).toBe(true)
    expect(all.every((template) => template.catalogVersion === TEMPLATE_CATALOG_VERSION)).toBe(true)
  })

  it("renders deterministic independent starter bytes", () => {
    const first = renderTemplate("narrative-pitch")
    const second = renderTemplate("narrative-pitch")
    expect(first).toEqual(second)
    expect(first?.source).toContain('data-derive-slide="0"')
    expect(first?.source).toContain('class="stage"')
    expect(first?.source).toContain('id="prev"')
    expect(first?.source).toContain('id="next"')
    expect(first?.source).toContain('source: "derive-deck"')
    expect(first?.source.match(/^\s*<section class="slide" data-derive-slide=/gm)).toHaveLength(
      first?.template.sections.length ?? 0,
    )
    expect(first?.origin).toEqual({
      libraryId: BUILT_INS_LIBRARY_ID,
      templateId: "narrative-pitch",
      catalogVersion: TEMPLATE_CATALOG_VERSION,
    })
    expect(first?.message).toBe("Created from derive/built-ins/narrative-pitch catalog v1")
  })

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
    expect(draft?.source).toContain("Template library: **derive/built-ins**")
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
