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

describe("Derive built-in templates catalog", () => {
  it("ships the planned artifact and context starts with durable refs", () => {
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
    expect(first?.template).toMatchObject({
      libraryId: BUILT_INS_LIBRARY_ID,
      id: "narrative-pitch",
      catalogVersion: TEMPLATE_CATALOG_VERSION,
    })
    expect(first?.message).toBe("Created from derive/built-ins/narrative-pitch catalog v1")
  })

  it("locks the built-in count by artifact category", () => {
    expect(
      Object.fromEntries(
        (["Deck", "Doc", "Report", "Site", "Agent"] as const).map((category) => [
          category,
          listTemplates({ kind: "artifact", category }).length,
        ]),
      ),
    ).toEqual({ Deck: 6, Doc: 8, Report: 3, Site: 2, Agent: 5 })
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
    expect(draft?.source).toContain("library: derive/built-ins")
    expect(draft?.source).not.toMatch(/(?:api[_-]?key|client[_-]?secret|authorization\s*:)/i)
  })

  it("keeps starter content quiet and editable", () => {
    const markdown = renderTemplate("decision-memo")?.source ?? ""
    const deck = renderTemplate("narrative-pitch")?.source ?? ""
    const site = renderTemplate("launch-page")?.source ?? ""

    expect(markdown).not.toContain("## Provenance")
    expect(deck).not.toContain("<b>Claim</b>")
    expect(deck).not.toContain("<b>Implication</b>")
    expect(site).not.toContain("Created in Derive")
    expect(site).toContain("<!-- Derive template:")
    expect(site).not.toContain(".brief")
    expect(site).not.toContain("footer{")
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
