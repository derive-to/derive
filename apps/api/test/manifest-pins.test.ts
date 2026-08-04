import { describe, expect, it } from "vitest"
import {
  manifestDescription,
  parseManifestRepos,
  parseManifestSkillPins,
} from "../src/lib/manifest-pins"

// Pure parsers over a manifest's frontmatter/body — no store, no HTTP. Mirrors the
// runner's own narrow grammar (packages/cli/src/runner.js parseManifest); these
// server-side copies exist so the console can show pin health and a description
// without a round trip through the CLI.
describe("parseManifestSkillPins", () => {
  it("reads id + version pairs out of the skills: list", () => {
    const md = ["---", "skills:", "  - id: ab12x", "    version: 3", "---", "# Body"].join("\n")
    expect(parseManifestSkillPins(md)).toEqual([{ id: "ab12x", version: 3 }])
  })

  it("an entry with no version is unpinned (null), not zero", () => {
    const md = ["---", "skills:", "  - id: ab12x", "---"].join("\n")
    expect(parseManifestSkillPins(md)).toEqual([{ id: "ab12x", version: null }])
  })

  it("a top-level key closes the list — a scalar after skills: doesn't leak in", () => {
    const md = ["---", "skills:", "  - id: ab12x", "brandprint: off", "---"].join("\n")
    expect(parseManifestSkillPins(md)).toEqual([{ id: "ab12x", version: null }])
  })

  it("no frontmatter, or none of it, is simply []", () => {
    expect(parseManifestSkillPins("# Just a body")).toEqual([])
    expect(parseManifestSkillPins("---\nbrandprint: off\n---\n# Body")).toEqual([])
  })
})

describe("parseManifestRepos", () => {
  it("reads url + ref, dropping description (the console doesn't need it)", () => {
    const md = [
      "---",
      "repos:",
      "  - url: https://github.com/acme/widget",
      "    ref: main",
      "    description: the e2e suite",
      "---",
    ].join("\n")
    expect(parseManifestRepos(md)).toEqual([{ url: "https://github.com/acme/widget", ref: "main" }])
  })

  it("ref is optional — null, not undefined, when absent", () => {
    const md = ["---", "repos:", "  - url: git@github.com:acme/widget.git", "---"].join("\n")
    expect(parseManifestRepos(md)).toEqual([{ url: "git@github.com:acme/widget.git", ref: null }])
  })

  it("a url with a scheme the runner doesn't allow is dropped, not passed through", () => {
    const md = ["---", "repos:", "  - url: ftp://acme/widget", "---"].join("\n")
    expect(parseManifestRepos(md)).toEqual([])
  })

  it("multiple repos, and a skills: list right below it doesn't bleed in", () => {
    const md = [
      "---",
      "repos:",
      "  - url: https://github.com/acme/one",
      "  - url: https://github.com/acme/two",
      "skills:",
      "  - id: ab12x",
      "---",
    ].join("\n")
    expect(parseManifestRepos(md)).toEqual([
      { url: "https://github.com/acme/one", ref: null },
      { url: "https://github.com/acme/two", ref: null },
    ])
  })

  it("no repos: key at all is []", () => {
    expect(parseManifestRepos("---\nskills:\n  - id: x\n---\n# Body")).toEqual([])
  })
})

describe("manifestDescription", () => {
  it("the first paragraph, frontmatter and a leading heading both stripped", () => {
    const md = [
      "---",
      "skills:",
      "  - id: x",
      "---",
      "# Staging QA",
      "",
      "Smoke-tests staging.",
    ].join("\n")
    expect(manifestDescription(md)).toBe("Smoke-tests staging.")
  })

  it("no leading heading — the first paragraph is read as-is", () => {
    expect(manifestDescription("Just a plain opening line.")).toBe("Just a plain opening line.")
  })

  it("a multi-line paragraph joins with spaces", () => {
    const md = "# Title\n\nLine one\nline two."
    expect(manifestDescription(md)).toBe("Line one line two.")
  })

  it("stops at the blank line — a second paragraph never leaks in", () => {
    const md = "# Title\n\nFirst paragraph.\n\nSecond paragraph never appears."
    expect(manifestDescription(md)).toBe("First paragraph.")
  })

  it("caps at maxChars with an ellipsis", () => {
    const long = "x".repeat(300)
    const out = manifestDescription(`# T\n\n${long}`, 220) as string
    expect(out.length).toBe(221) // 220 chars + the ellipsis glyph
    expect(out.endsWith("…")).toBe(true)
  })

  it("frontmatter with nothing after it is null, not an empty string", () => {
    expect(manifestDescription("---\nskills:\n  - id: x\n---\n")).toBeNull()
    expect(manifestDescription("")).toBeNull()
  })
})
