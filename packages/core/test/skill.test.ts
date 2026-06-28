import { describe, expect, it } from "vitest"
import type { BundleManifest } from "../src/ports"
import { bundleDoc, isMarkdownBundle, isSkillBundle, parseFrontmatter } from "../src/skill"

const manifest = (entry: string, paths: string[]): BundleManifest => ({
  entry,
  spa: false,
  files: Object.fromEntries(paths.map((p) => [p, { key: `k${p}`, type: "text/plain" }])),
})

describe("parseFrontmatter", () => {
  it("reads flat key: value pairs and strips the block off the body", () => {
    const { attrs, body } = parseFrontmatter(
      "---\nname: my-skill\ndescription: does things\n---\n\n# Title\n\nbody",
    )
    expect(attrs.name).toBe("my-skill")
    expect(attrs.description).toBe("does things")
    expect(body).toBe("# Title\n\nbody")
  })

  it("trims surrounding quotes and skips nested/indented lines", () => {
    const { attrs } = parseFrontmatter(
      '---\nname: "Quoted Name"\nmeta:\n  nested: ignored\nversion: 1.2.3\n---\nbody',
    )
    expect(attrs.name).toBe("Quoted Name")
    expect(attrs.version).toBe("1.2.3")
    expect(attrs.nested).toBeUndefined()
    expect(attrs.meta).toBe("") // `meta:` has an empty value
  })

  it("returns the source unchanged when there's no frontmatter", () => {
    const src = "# Just markdown\n\nno block"
    expect(parseFrontmatter(src)).toEqual({ attrs: {}, body: src })
  })
})

describe("isSkillBundle", () => {
  it("is true only when the entry is a root SKILL.md", () => {
    expect(isSkillBundle(manifest("/SKILL.md", ["/SKILL.md"]))).toBe(true)
    expect(isSkillBundle(manifest("/skill.md", ["/skill.md"]))).toBe(true) // case-insensitive
    expect(isSkillBundle(manifest("/index.html", ["/index.html"]))).toBe(false)
    expect(isSkillBundle(manifest("/README.md", ["/README.md"]))).toBe(false)
    expect(isSkillBundle(manifest("/docs/SKILL.md", ["/docs/SKILL.md"]))).toBe(false)
  })
})

describe("isMarkdownBundle", () => {
  it("is true when the entry is markdown (skill OR docs), false for HTML", () => {
    expect(isMarkdownBundle(manifest("/SKILL.md", ["/SKILL.md"]))).toBe(true)
    expect(isMarkdownBundle(manifest("/README.md", ["/README.md"]))).toBe(true)
    expect(isMarkdownBundle(manifest("/docs/guide.markdown", ["/docs/guide.markdown"]))).toBe(true)
    expect(isMarkdownBundle(manifest("/index.html", ["/index.html"]))).toBe(false)
  })
})

describe("bundleDoc", () => {
  it("flags a skill, pulls its frontmatter, and lists files sans leading slash", () => {
    const info = bundleDoc(
      manifest("/SKILL.md", ["/SKILL.md", "/scripts/run.sh", "/references/notes.md"]),
      "---\nname: my-skill\ndescription: does things\n---\n# body",
    )
    expect(info).toEqual({
      isSkill: true,
      name: "my-skill",
      description: "does things",
      entry: "SKILL.md",
      // Code-point sort: uppercase "SKILL.md" sorts before the lowercase dirs.
      files: [
        { path: "SKILL.md", type: "text/plain" },
        { path: "references/notes.md", type: "text/plain" },
        { path: "scripts/run.sh", type: "text/plain" },
      ],
    })
  })

  it("treats a non-SKILL markdown bundle as docs: no skill flag, no identity", () => {
    const info = bundleDoc(
      manifest("/README.md", ["/README.md", "/guide.md"]),
      "# Readme\n\nwelcome",
    )
    expect(info.isSkill).toBe(false)
    expect(info.name).toBeNull()
    expect(info.description).toBeNull()
    expect(info.entry).toBe("README.md")
    expect(info.files.map((f) => f.path)).toEqual(["README.md", "guide.md"])
  })
})
