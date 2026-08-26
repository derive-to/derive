import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { anonApp, dir, meta } from "./helpers"

// Agent discovery (routes/agent-discovery.ts): the machine-readable front door for
// agents that have NOT connected the MCP. Public and read-only — these run against
// the no-auth app to prove an agent with nothing but a shell can fetch them.
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
    expect(m.capabilities.some((capability) => capability.includes("derive.shared"))).toBe(true)
  })

  it("teaches an artifact-building agent the native shared-state path", async () => {
    const r = await anonApp.request("https://example.test/skill.md")
    expect(r.status).toBe(200)
    const skill = await r.text()
    expect(skill).toContain('derive.shared("bugs", [])')
    expect(skill).toContain("commenters can add, apply atomic")
    expect(skill).toContain("reactions.setMine(id")
    expect(skill).toContain("reactions.mine(id)")
    expect(skill).toContain("set one durable value per actor and slot")
    expect(skill).toContain("`activity()` for attributed history")
    expect(skill).toContain("Arbitrary field replacement requires edit rights")
    expect(skill).toContain("general application backend")
  })

  // The examples page belongs to the public site (deps.site); a manifest that names
  // a URL this deployment answers with a 404 is worse than a shorter one. anonApp
  // has no site bound, which is exactly the self-host shape.
  it("advertises /examples only when the public site is bound", async () => {
    const url = "https://example.test/.well-known/agent.json"
    const bare = (await (await anonApp.request(url)).json()) as {
      endpoints: Record<string, string>
    }
    expect(bare.endpoints.examples).toBeUndefined()
    expect(bare.endpoints.llms_txt).toBe("https://example.test/llms.txt")

    const hosted = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-agent-discovery")),
      baseUrl: "http://derive.test",
      token: "tok",
      site: async () => new Response("SITE"),
    })
    const m = (await (await hosted.request(url)).json()) as { endpoints: Record<string, string> }
    expect(m.endpoints.examples).toBe("https://example.test/examples")
  })
})
