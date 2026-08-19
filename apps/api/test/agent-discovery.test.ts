import { describe, expect, it } from "vitest"
import { anonApp } from "./helpers"

// Agent discovery (routes/agent-discovery.ts): the machine-readable front door for
// agents that have NOT connected the MCP. Both endpoints are public and read-only —
// they run against the no-auth app to prove an agent with nothing but a shell can
// fetch them.
describe("GET /skill.md", () => {
  it("serves the self-contained skill as markdown to an anonymous caller", async () => {
    const r = await anonApp.request("/skill.md")
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("text/markdown")
    const body = await r.text()
    // The canonical skill's identity (frontmatter) survives into the served copy.
    expect(body).toContain("name: derive")
    // Self-contained: the reference files the body links to ride along as appendices
    // titled with the exact relative paths, so the links self-resolve by name.
    expect(body).toContain("# Appendix: references/connect.md")
    expect(body).toContain("# Appendix: references/compatibility.md")
    // The drift rule ships in the skill itself — the served copy tells readers the
    // live server outranks any cached text (including this response).
    expect(body).toContain("trust\n  the live server")
  })
})

describe("GET /.well-known/skills/*", () => {
  it("serves the Agent Skills Discovery index and the skill file", async () => {
    const idx = await anonApp.request("/.well-known/skills/index.json")
    expect(idx.status).toBe(200)
    const j = (await idx.json()) as {
      skills: { name: string; description: string; files: string[] }[]
    }
    expect(j.skills).toHaveLength(1)
    const skill = j.skills[0]
    if (!skill) throw new Error("no skill entry")
    // Spec name grammar: lowercase alphanumeric + hyphens.
    expect(skill.name).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(skill.name).toBe("derive")
    // The description is parsed from the generated skill's frontmatter — it must
    // carry the trigger words, not a fallback stub.
    expect(skill.description).toContain("Derive")
    expect(skill.description.length).toBeGreaterThan(100)
    expect(skill.files).toEqual(["SKILL.md"])

    const md = await anonApp.request("/.well-known/skills/derive/SKILL.md")
    expect(md.status).toBe(200)
    expect(md.headers.get("content-type")).toContain("text/markdown")
    expect(await md.text()).toContain("name: derive")
  })

  it("404s unknown paths under the prefix as JSON, never the SPA shell", async () => {
    const r = await anonApp.request("/.well-known/skills/nope/SKILL.md")
    expect(r.status).toBe(404)
  })
})

describe("GET /.well-known/agent.json", () => {
  it("serves an instance-relative capability manifest to an anonymous caller", async () => {
    const r = await anonApp.request("https://example.test/.well-known/agent.json")
    expect(r.status).toBe(200)
    const m = (await r.json()) as {
      name: string
      url: string
      capabilities: string[]
      protocols: { mcp: boolean }
      endpoints: Record<string, string>
    }
    expect(m.name).toBe("Derive")
    // Origins come from the live request (like the OAuth well-knowns), so the manifest
    // is correct on derive.to, a self-host, and workers.dev without configuration.
    expect(m.url).toBe("https://example.test")
    expect(m.endpoints.mcp).toBe("https://example.test/mcp")
    expect(m.endpoints.skill).toBe("https://example.test/skill.md")
    expect(m.protocols.mcp).toBe(true)
    expect(m.capabilities.length).toBeGreaterThan(0)
  })

  // The examples page and the llms files belong to derive.to's own public surface,
  // which only its build assembles. This app has none of it, exactly like a
  // self-host, so the manifest must not name URLs that would 404.
  it("omits the hosted-only endpoints when the build did not ship them", async () => {
    const r = await anonApp.request("https://example.test/.well-known/agent.json")
    const m = (await r.json()) as { endpoints: Record<string, string> }
    for (const key of ["examples", "llms_txt", "llms_full_txt"])
      expect(m.endpoints[key], `${key} must be absent without the hosted surface`).toBeUndefined()
    expect(m.endpoints.skill).toBe("https://example.test/skill.md")
  })
})
