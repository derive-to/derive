import { describe, expect, it } from "vitest"
import { NEW_SKILL_PROMPT } from "./new-skill-prompt"

describe("NEW_SKILL_PROMPT", () => {
  it("requires a catalog-visible multi-file Skill instead of a plain artifact", () => {
    expect(NEW_SKILL_PROMPT).toContain("exactly one concise question")
    expect(NEW_SKILL_PROMPT).toContain("Do not browse, search, or research")
    expect(NEW_SKILL_PROMPT).toContain("files payload")
    expect(NEW_SKILL_PROMPT).toContain("Never use the single-file content payload")
    expect(NEW_SKILL_PROMPT).toContain("SKILL.md")
    expect(NEW_SKILL_PROMPT).toContain("derive.skill.json")
    expect(NEW_SKILL_PROMPT).toContain('"schema":"derive.skill/v1"')
    expect(NEW_SKILL_PROMPT).toContain('"catalog":true')
    expect(NEW_SKILL_PROMPT).toContain("appears in the Skills catalog")
  })
})
