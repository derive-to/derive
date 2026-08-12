import { describe, expect, it } from "vitest"
import {
  ARTIFACT_TEMPLATES,
  BUILT_INS_LIBRARY_ID,
  CONTEXT_TEMPLATES,
  catalogResource,
  renderTemplate,
  TEMPLATE_CATALOG_URI,
  TEMPLATE_CATALOG_VERSION,
  templateResource,
  templateResources,
} from "./index"

describe("Derive built-in Templates catalog", () => {
  it("ships the planned artifact and Context starts with durable refs", () => {
    expect(ARTIFACT_TEMPLATES).toHaveLength(24)
    expect(CONTEXT_TEMPLATES).toHaveLength(6)
    const all = [...ARTIFACT_TEMPLATES, ...CONTEXT_TEMPLATES]
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

  it("renders a supplied brief into built-in artifacts without exposing source bindings", () => {
    const deck = renderTemplate("narrative-pitch", {
      Audience: "Product and GTM leaders",
      Objective: "Commit to the October launch plan",
      Evidence: "24 design partners and $2.4M qualified pipeline",
    })
    expect(deck?.source).toContain("Product and GTM leaders")
    expect(deck?.source).toContain("Commit to the October launch plan")
    expect(deck?.source).toContain("24 design partners and $2.4M qualified pipeline")
    expect(deck?.source).not.toContain("{{Audience}}")

    const page = renderTemplate("launch-page", {
      Offer: "Derive Templates",
      Audience: "Teams shipping repeatable work",
    })
    expect(page?.source).toContain("Derive Templates")
    expect(page?.source).toContain("Teams shipping repeatable work")

    const doc = renderTemplate("decision-memo", {
      Decision: "Ship the source-free adoption workbench",
    })
    expect(doc?.source).toContain(
      "**Decision · required:** Ship the source-free adoption workbench",
    )
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
    expect(templateResources()).toHaveLength(31)
  })
})
