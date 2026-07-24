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
})
