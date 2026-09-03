import { describe, expect, it } from "vitest"
import { SKILL_DEFINITION_SCHEMA, skillCatalogEnabled, validateSkillDefinition } from "../src/skill"

const skill = (name = "weekly-brief") => `---
name: ${name}
description: Build a cited weekly brief.
compatibility: Requires the Derive MCP for graph execution.
---

# Weekly brief
`

describe("validateSkillDefinition", () => {
  it("accepts a portable skill without a Derive sidecar", () => {
    const checked = validateSkillDefinition(skill())
    expect(checked.errors).toEqual([])
    expect(checked.metadata).toEqual({
      name: "weekly-brief",
      description: "Build a cited weekly brief.",
      compatibility: "Requires the Derive MCP for graph execution.",
    })
    expect(skillCatalogEnabled(checked.sidecar)).toBe(true)
  })

  it("rejects names outside the Agent Skills portable subset", () => {
    expect(validateSkillDefinition(skill("Weekly Brief")).errors).toContain(
      "SKILL.md name must use lowercase letters, numbers, and single hyphens",
    )
    expect(validateSkillDefinition("# no frontmatter").errors).toEqual([
      "SKILL.md frontmatter requires name",
      "SKILL.md frontmatter requires description",
    ])
  })

  it("parses exact semantic relations and embedded catalog state", () => {
    const checked = validateSkillDefinition(
      skill(),
      JSON.stringify({
        schema: SKILL_DEFINITION_SCHEMA,
        catalog: false,
        origin: {
          kind: "workflow-launcher",
          workflow: { short_id: "brief123", version: 4 },
        },
        relations: {
          requires: [{ id: "research-core", version: 3 }],
          recommends: [
            { id: "tone-guide", version: 2 },
            { id: "tone-guide", version: 2 },
          ],
        },
        runtime: { kind: "single" },
      }),
    )
    expect(checked.errors).toEqual([])
    expect(checked.warnings).toEqual(["duplicate recommends relation tone-guide@2 was ignored"])
    expect(checked.sidecar).toMatchObject({
      catalog: false,
      origin: {
        kind: "workflow-launcher",
        workflow: { short_id: "brief123", version: 4 },
      },
      relations: {
        requires: [{ id: "research-core", version: 3 }],
        recommends: [{ id: "tone-guide", version: 2 }],
      },
      runtime: { kind: "single" },
    })
    expect(skillCatalogEnabled(checked.sidecar)).toBe(false)
  })

  it("requires loop runtimes to carry a bounded workflow loop", () => {
    const checked = validateSkillDefinition(
      skill(),
      JSON.stringify({
        schema: SKILL_DEFINITION_SCHEMA,
        runtime: {
          kind: "loop",
          definition: {
            schema: "derive.workflow/v1",
            purpose: "Publish once",
            diagrams: [
              {
                id: "once",
                entry: "done",
                nodes: [{ id: "done", kind: "terminal", result: "Done" }],
                routes: [],
                scenarios: [{ id: "expected", kind: "expected", path: ["done"], outcome: "Done" }],
              },
            ],
          },
        },
      }),
    )
    expect(checked.errors).toContain(
      "derive.skill.json loop runtime must declare at least one bounded loop",
    )
  })
})
