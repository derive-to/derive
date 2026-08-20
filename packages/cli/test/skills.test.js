import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  conventionsBlock,
  fetchSkill,
  materializeNotes,
  materializeSkills,
  mergeSkillLayers,
  pinManifestSkills,
  skillNameFrom,
  skillSlug,
} from "../src/skills.js"

// A mock of the three-fetcher `api` contract, backed by an in-memory catalog of
// { [id]: { [version]: { entry, files: {path: bytes} } } } for bundles and
// { [id]: { [version]: "source" } } for single-file notes.
const mockApi = (bundles = {}, notes = {}) => ({
  outline: async (id, version) => {
    const v = bundles[id]?.[version]
    if (!v) throw new Error("no version")
    return {
      entry: v.entry,
      pages: Object.keys(v.files).map((path) => ({ path, type: "text/plain" })),
    }
  },
  file: async (id, path, version) => bundles[id][version].files[path],
  content: async (id, version) => {
    const s = notes[id]?.[version]
    if (s == null) throw new Error("no note")
    return s
  },
})

describe("skillNameFrom + skillSlug", () => {
  it("reads the frontmatter name; null when absent or nested", () => {
    expect(skillNameFrom("---\nname: chart-style\ndescription: x\n---\n# hi")).toBe("chart-style")
    expect(skillNameFrom('---\nname: "My Skill"\n---\n')).toBe("My Skill")
    expect(skillNameFrom("no frontmatter here")).toBeNull()
    expect(skillNameFrom("---\nmeta:\n  name: nested\n---\n")).toBeNull()
  })

  it("slugs to a filesystem-safe stem, null when nothing survives", () => {
    expect(skillSlug("Chart Style!")).toBe("Chart-Style")
    expect(skillSlug("a/../b")).toBe("a-..-b")
    expect(skillSlug("***")).toBeNull()
  })
})

describe("mergeSkillLayers", () => {
  it("dedupes a shared id once, with the manifest pin winning over the Brandprint", () => {
    const merged = mergeSkillLayers(
      [
        { id: "shared", version: 3 },
        { id: "bp-only", version: 1 },
      ],
      [
        { id: "shared", version: 5 }, // manifest pins a newer version
        { id: "manifest-only", version: 2 },
      ],
    )
    expect(merged).toEqual([
      { id: "shared", version: 5 }, // once, manifest's version
      { id: "bp-only", version: 1 },
      { id: "manifest-only", version: 2 },
    ])
  })
})

describe("materializeSkills", () => {
  it("writes each pinned skill's files under a name-derived dir and reports the catalog", async () => {
    const api = mockApi({
      sk1: {
        3: {
          entry: "SKILL.md",
          files: {
            "SKILL.md": "---\nname: chart-style\n---\n# Chart",
            "scripts/build.sh": "echo hi",
          },
        },
      },
    })
    const root = mkdtempSync(join(tmpdir(), "skills-"))
    const cat = await materializeSkills(api, [{ id: "sk1", version: 3 }], root)
    expect(cat).toEqual([
      { id: "sk1", version: 3, dir: "chart-style", name: "chart-style", ok: true },
    ])
    expect(readFileSync(join(root, "chart-style", "SKILL.md"), "utf8")).toContain("# Chart")
    expect(readFileSync(join(root, "chart-style", "scripts", "build.sh"), "utf8")).toBe("echo hi")
  })

  it("dedupes colliding names by short id", async () => {
    const skillFiles = (name) => ({
      entry: "SKILL.md",
      files: { "SKILL.md": `---\nname: ${name}\n---\n` },
    })
    const api = mockApi({ a1: { 1: skillFiles("dup") }, b2: { 1: skillFiles("dup") } })
    const root = mkdtempSync(join(tmpdir(), "skills-"))
    const cat = await materializeSkills(
      api,
      [
        { id: "a1", version: 1 },
        { id: "b2", version: 1 },
      ],
      root,
    )
    expect(cat.map((c) => c.dir)).toEqual(["dup", "dup-b2"])
  })

  it("a failed skill is non-fatal: ok:false, the rest still materialize", async () => {
    const api = mockApi({
      ok1: { 1: { entry: "SKILL.md", files: { "SKILL.md": "---\nname: good\n---\n" } } },
    })
    const root = mkdtempSync(join(tmpdir(), "skills-"))
    const cat = await materializeSkills(
      api,
      [
        { id: "missing", version: 9 },
        { id: "ok1", version: 1 },
      ],
      root,
    )
    expect(cat[0]).toMatchObject({ id: "missing", ok: false })
    expect(cat[1]).toMatchObject({ id: "ok1", dir: "good", ok: true })
  })
})

describe("fetchSkill version resolution", () => {
  const skillFiles = { entry: "SKILL.md", files: { "SKILL.md": "---\nname: vprobe\n---\n" } }

  it("a pinned entry fetches its exact version; an unpinned one asks for approved", async () => {
    const api = mockApi({ sk: { 3: skillFiles, approved: skillFiles } })
    await fetchSkill(api, { id: "sk", version: 3 })
    const unpinned = await fetchSkill(api, { id: "sk", version: null })
    expect(unpinned.name).toBe("vprobe")
  })

  it("falls back to current only for the old-server 400, never on other failures", async () => {
    // An old self-host 400s v=approved; the skill must degrade to current, not drop.
    const oldServer = {
      ...mockApi({ sk: { null: skillFiles } }),
      outline: async (id, v) => {
        if (v === "approved")
          throw new Error(`/v1/artifacts/${id}/content?outline=1&v=approved → 400: bad version`)
        return mockApi({ sk: { null: skillFiles } }).outline(id, v)
      },
    }
    expect((await fetchSkill(oldServer, { id: "sk", version: null })).name).toBe("vprobe")

    // A transient failure must FAIL the skill, not silently serve the unapproved draft.
    const flaky = {
      ...mockApi({ sk: { null: skillFiles } }),
      outline: async (id, v) => {
        if (v === "approved")
          throw new Error(`/v1/artifacts/${id}/content?outline=1&v=approved → 503`)
        return mockApi({ sk: { null: skillFiles } }).outline(id, v)
      },
    }
    await expect(fetchSkill(flaky, { id: "sk", version: null })).rejects.toThrow("503")
  })
})

describe("materializeNotes", () => {
  it("writes a note to <slug>.md and catalogs it", async () => {
    const api = mockApi({}, { note1: { 2: "# Voice\n\nBe warm." } })
    const root = mkdtempSync(join(tmpdir(), "brandprint-"))
    const cat = await materializeNotes(
      api,
      [{ short_id: "note1", title: "Voice & Tone", version: 2 }],
      root,
    )
    expect(cat[0]).toMatchObject({ short_id: "note1", ok: true })
    expect(readFileSync(join(root, "Voice-Tone.md"), "utf8")).toContain("Be warm.")
  })
})

describe("conventionsBlock", () => {
  it("names skills + notes on disk, states an unavailable one, empty when nothing", () => {
    expect(conventionsBlock([], [])).toBe("")
    const block = conventionsBlock(
      [
        { ok: true, dir: "chart-style", name: "chart-style", version: 3 },
        { ok: false, id: "gone" },
      ],
      [{ ok: true, file: "brandprint/voice.md", title: "Voice" }],
    )
    expect(block).toContain('.claude/skills/chart-style — skill "chart-style" @v3')
    expect(block).toContain("skill gone — UNAVAILABLE")
    expect(block).toContain("brandprint/voice.md — Voice")
  })
})

describe("pinManifestSkills", () => {
  it("inserts a version line under each unpinned id, leaving pinned ones untouched", () => {
    const text = `---
skills:
  - id: aaaa1111
    version: 5
  - id: bbbb2222
---

# Body`
    const { text: out, pinned } = pinManifestSkills(text, new Map([["bbbb2222", 7]]))
    expect(pinned).toEqual([{ id: "bbbb2222", version: 7 }])
    expect(out).toContain("  - id: bbbb2222\n    version: 7")
    expect(out).toContain("  - id: aaaa1111\n    version: 5") // untouched
    expect(out).toContain("# Body") // body preserved
  })

  it("is a no-op with an empty pin set or no frontmatter", () => {
    expect(pinManifestSkills("# Plain", new Map([["x", 1]])).text).toBe("# Plain")
    expect(pinManifestSkills("---\nskills:\n  - id: x\n---\n", new Map()).pinned).toEqual([])
  })
})
