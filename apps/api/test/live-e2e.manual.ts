// MANUAL, NETWORK-DEPENDENT end-to-end proof. Not part of the suite (`.manual.ts`), because a
// green CI must not depend on someone else's server being up.
//
// Run: npx vitest run --config vitest.manual.config.ts
//
// Drives the REAL HTTP routes against a REAL public MCP server, through the whole chain a
// production run takes: connect -> bind to an automation -> run now -> claim -> tool proxy ->
// execute. Everything else we have is either the broker in isolation or a localhost fixture; this
// is the only thing that proves the parts fit together against a server nobody here controls.
import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const LIVE = "https://mcp.deepwiki.com/mcp"

const owner: TestUser = { id: "u_live", email: "live@derive.test", name: "L" }
const { app, meta } = makeAuthedApp("live-e2e", [owner], "editor")

describe("LIVE end-to-end: a real MCP server through the real run path", () => {
  it("connects, binds, claims, and calls the server", async () => {
    // 1. Connect a real server through the real route.
    const created = await app.request(
      "/v1/connections",
      jsonAs(as(owner.email), { toolkit: "deepwiki", mcp_url: LIVE }),
    )
    const conn = (await created.json()) as Record<string, string>
    expect(created.status).toBe(201)
    expect(conn.kind).toBe("mcp")
    expect(conn.status).toBe("active")
    const [row] = await meta.getConnectionsByIds([conn.id as string])
    expect(row?.broker_ref.startsWith("mcp:s256-")).toBe(true)
    process.stdout.write(`\n  CONNECTED ${conn.id} pin=${row?.broker_ref.slice(0, 30)}…\n`)

    // 2. Mint an agent and bind the connection to an automation.
    const agentRes = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), { name: "live-runner" }),
    )
    const agent = (await agentRes.json()) as { id: string; token: string }
    const autoRes = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        agentId: agent.id,
        instruction: "Read the MCP spec repo's wiki structure.",
        trigger: { kind: "manual" },
        connectionIds: [conn.id],
      }),
    )
    const auto = (await autoRes.json()) as { id: string }
    expect(autoRes.status).toBe(201)

    // 3. Run now, then claim as the executor would.
    await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const claimed = (await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()) as {
      runs: { id: string; tools?: { def: { name: string } }[]; sources_quiet?: unknown[] }[]
    }
    const run = claimed.runs.find((r) => r.tools?.length)
    expect(run, "a claimed run carrying the server's tools").toBeTruthy()
    const names = run?.tools?.map((t) => t.def.name) ?? []
    process.stdout.write(
      `  CLAIMED run ${run?.id} with ${names.length} live tools: ${names.join(", ")}\n`,
    )
    expect(names.some((n) => n.includes("read_wiki_structure"))).toBe(true)
    expect(run?.sources_quiet).toBeUndefined()

    // 4. Call the real server THROUGH THE TOOL PROXY — the path a run actually uses, where the
    //    credential stays server-side and the executor sends only a name.
    const toolName = names.find((n) => n.includes("read_wiki_structure")) as string
    const res = await app.request(
      `/v1/agent/runs/${run?.id}/tool`,
      jsonAs(bearer(agent.token), {
        tool: toolName,
        args: { repoName: "modelcontextprotocol/modelcontextprotocol" },
      }),
    )
    const body = (await res.json()) as { result?: unknown }
    expect(res.status).toBe(200)
    const text = JSON.stringify(body.result)
    process.stdout.write(
      `\n  TOOL PROXY RETURNED ${text.length} chars:\n  ${text.slice(0, 300)}\n\n`,
    )
    // Assert on content ONLY THE REAL SERVER PRODUCES. The obvious assertion — that the answer
    // mentions the repo — is worthless here, because the repo name is an ARGUMENT we sent, so an
    // echoing broker would satisfy it. This is the exact trap this whole rail is built around.
    expect(text).toMatch(/Overview|Protocol Specification|Transport/)
    expect(text.length).toBeGreaterThan(500)
    // And prove it is not our own arguments coming back.
    expect(text).not.toMatch(/"repoName"/)
  }, 60_000)
})
