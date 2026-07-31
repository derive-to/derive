import { describe, expect, it } from "vitest"
import { McpBroker, parseMcpRef } from "../src/mcp"

/**
 * The broker against MCP servers that actually exist on the internet.
 *
 * OFF BY DEFAULT — `LIVE_MCP=1 pnpm vitest run test/live-servers.test.ts`. CI must not depend on
 * somebody else's uptime, and these make real requests to third parties.
 *
 * It is here anyway because every other test in this package drives a server written in this
 * repo, and a server written in this repo agrees with our assumptions by construction. Real ones
 * do not: they return SSE where the tests return JSON, tool names longer than the 64 characters a
 * provider will accept, `outputSchema` and `annotations` fields nothing here reads, and — for the
 * authorized ones — an authorization server on a DIFFERENT ORIGIN from the server itself
 * (`mcp.stripe.com` is guarded by `access.stripe.com`). Each of those was a real bug or a real
 * near-miss, and none of them would have surfaced against a stub.
 */

/** No key, no account, no sign-in. Anyone can run this file. */
const OPEN_SERVERS = [
  { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp" },
  { name: "GitMCP", url: "https://gitmcp.io/docs" },
  { name: "Cloudflare docs", url: "https://docs.mcp.cloudflare.com/mcp" },
  { name: "Hugging Face", url: "https://huggingface.co/mcp" },
]

/** Live, and 401 until you sign in. What their OAUTH metadata advertises is asserted in
 *  apps/api's live test, where the MCP SDK is actually a dependency. */
const OAUTH_SERVERS = [
  { name: "Stripe", url: "https://mcp.stripe.com" },
  { name: "Linear", url: "https://mcp.linear.app/mcp" },
  { name: "Notion", url: "https://mcp.notion.com/mcp" },
  { name: "Sentry", url: "https://mcp.sentry.dev/mcp" },
]

const live = process.env.LIVE_MCP === "1"

describe.skipIf(!live)("live MCP servers, no authorization", () => {
  for (const server of OPEN_SERVERS) {
    it(`${server.name}: connects, pins a tool list, and the names are usable`, async () => {
      const broker = new McpBroker()
      const link = await broker.connect({ orgId: "live", userId: "live", toolkit: server.url })
      expect(link.status, `${server.name} did not connect: ${link.reason ?? ""}`).toBe("active")

      // A pin, not just a connection. An unpinned ref is refused everywhere downstream.
      const parsed = parseMcpRef(link.ref)
      expect(parsed?.pin, `${server.name} produced no pin`).toMatch(/^s256-[0-9a-f]{16,}$/)

      const tools = await broker.toolsFor([link.ref])
      expect(tools.length).toBeGreaterThan(0)
      // THE CONSTRAINT THAT BIT US. Model providers reject a tool name with a dot in it or over
      // 64 characters, and real servers ship both. Whatever we hand back has to be legal already.
      for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(new Set(tools.map((t) => t.name)).size, "names collided").toBe(tools.length)
    }, 30_000)
  }

  it("DeepWiki actually answers a call, with content we did not write", async () => {
    // The point of the whole exercise: a tool call that reaches a third party and comes back with
    // data that exists in the world. LocalBroker's echo stub returns the caller's own arguments,
    // which reads exactly like success — so "it returned something" is not the assertion. "It
    // returned something we could not have produced" is.
    const broker = new McpBroker()
    const link = await broker.connect({
      orgId: "live",
      userId: "live",
      toolkit: "https://mcp.deepwiki.com/mcp",
    })
    const tools = await broker.toolsFor([link.ref])
    const ask = tools.find((t) => /ask|question/i.test(t.name))
    expect(ask, `no question tool among: ${tools.map((t) => t.name).join(", ")}`).toBeTruthy()

    const out = await broker.execute({
      ref: link.ref,
      tool: ask?.name ?? "",
      args: { repoName: "modelcontextprotocol/modelcontextprotocol", question: "What is a tool?" },
    })
    const text = JSON.stringify(out)
    expect(text.length).toBeGreaterThan(200)
    expect(text.toLowerCase()).toContain("tool")
    // Not our arguments handed back — that is the echo stub's signature, and it must never pass.
    expect(text).not.toContain("What is a tool?")
  }, 60_000)
})

describe.skipIf(!live)("live MCP servers, authorization required", () => {
  for (const server of OAUTH_SERVERS) {
    it(`${server.name}: 401 is reported as auth_required, not as broken`, async () => {
      // The distinction the UI depends on. "Unreachable" sends someone to check a URL that is
      // fine; "auth_required" offers the sign-in that actually fixes it.
      const broker = new McpBroker()
      const link = await broker.connect({ orgId: "live", userId: "live", toolkit: server.url })
      expect(link.status).not.toBe("active")
      expect(link.reason).toBe("auth_required")
    }, 30_000)
  }
})
