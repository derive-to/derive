import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { NEW_SKILL_SOURCE, skillBundleBytes, skillPreviewSource } from "./skill-source"

describe("Skill source editing", () => {
  it("previews the instructions without rendering YAML frontmatter", () => {
    expect(skillPreviewSource(NEW_SKILL_SOURCE)).toBe(
      "# My skill\n\nWrite clear, focused instructions for Claude and Codex.\n",
    )
  })

  it("creates the portable two-file Skill bundle", () => {
    const files = unzipSync(skillBundleBytes(NEW_SKILL_SOURCE))
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "derive.skill.json"])
    expect(strFromU8(files["SKILL.md"] as Uint8Array)).toBe(NEW_SKILL_SOURCE)
    expect(JSON.parse(strFromU8(files["derive.skill.json"] as Uint8Array))).toMatchObject({
      schema: "derive.skill/v1",
      catalog: true,
      runtime: { kind: "single" },
    })
  })
})
