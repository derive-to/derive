import { describe, expect, it } from "vitest"
import { ARTIFACT_TEMPLATES, CONTEXT_TEMPLATES } from "./catalog"
import { buildTemplateDraft } from "./template-content"

describe("built-in templates", () => {
  it("ships the planned catalog", () => {
    expect(ARTIFACT_TEMPLATES).toHaveLength(24)
    expect(CONTEXT_TEMPLATES).toHaveLength(6)
  })

  it("builds a Derive-aware deck with the selected theme", () => {
    const draft = buildTemplateDraft("narrative-pitch", "high-signal")
    expect(draft?.format).toBe("html")
    expect(draft?.theme?.id).toBe("high-signal")
    expect(draft?.source).toContain("source:'derive-deck'")
    expect(draft?.source).toContain('data-derive-slide="0"')
  })

  it("builds a safe context manifest without credentials", () => {
    const draft = buildTemplateDraft("weekly-research-context", undefined)
    expect(draft?.format).toBe("md")
    expect(draft?.source).toContain(
      "Bind a runner, sources, permissions, and credentials separately",
    )
    expect(draft?.source).not.toContain("API_KEY=")
  })

  it("ignores themes for fixed markdown templates", () => {
    const draft = buildTemplateDraft("decision-memo", "field-notes")
    expect(draft?.theme).toBeUndefined()
    expect(draft?.source).toContain("# Decision memo")
  })
})
