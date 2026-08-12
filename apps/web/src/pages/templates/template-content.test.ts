import { ARTIFACT_TEMPLATES, CONTEXT_TEMPLATES } from "@derive-to/templates"
import { describe, expect, it } from "vitest"
import { buildTemplateDraft } from "./template-content"

describe("built-in templates", () => {
  it("ships the planned catalog", () => {
    expect(ARTIFACT_TEMPLATES).toHaveLength(24)
    expect(CONTEXT_TEMPLATES).toHaveLength(6)
  })

  it("builds a deterministic Derive-aware deck", () => {
    const draft = buildTemplateDraft("narrative-pitch")
    expect(draft?.format).toBe("html")
    expect(draft?.source).toContain("source:'derive-deck'")
    expect(draft?.source).toContain('data-derive-slide="0"')
  })

  it("builds a safe context manifest without credentials", () => {
    const draft = buildTemplateDraft("weekly-research-context")
    expect(draft?.format).toBe("md")
    expect(draft?.source).toContain(
      "Bind a runner, sources, permissions, and credentials separately",
    )
    expect(draft?.source).not.toContain("API_KEY=")
  })

  it("builds a markdown template without a second visual-system contract", () => {
    const draft = buildTemplateDraft("decision-memo")
    expect(draft?.source).toContain("# Decision memo")
  })
})
