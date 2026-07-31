import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { isProviderLegalToolName } from "@derive/broker"
import { afterAll, describe, expect, it } from "vitest"
import { RUN_TOKEN_TTL_MS, signWorkToken } from "../src/lib/run-token"
import { loopSubstrate } from "../src/lib/substrate-loop"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// THE HOSTED PATH, end to end, in one process: the real app, the real claim, the real substrate
// loop, and a real MCP server on a real port. Only the model is scripted.
//
// Every other substrate test drives a STUB api, so none of them can see whether a bound MCP
// source actually reaches a hosted run — which is exactly the thing that was failing in
// production while the whole suite stayed green.

const seen: string[] = []
const startServer = async () => {
  const server: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      const msg = JSON.parse(raw || "{}") as { id?: number; method?: string }
      seen.push(msg.method ?? "?")
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2025-11-25" }
          : msg.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "get_current_weather",
                    description: "Current weather for a place.",
                    inputSchema: { city: { type: "string" } },
                  },
                ],
              }
            : { content: [{ type: "text", text: '{"temperature_c":19.8}' }] }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { server, url: `http://localhost:${(server.address() as AddressInfo).port}/mcp` }
}

const owner: TestUser = { id: "u_hm", email: "hm@derive.test", name: "O" }
const SECRET = "zz-hosted-mcp-secret-at-least-16-chars"
const { app, meta } = makeAuthedApp("zz-hosted-mcp", [owner], "editor", {
  deps: { encryptionKey: SECRET },
})
const servers: Server[] = []
afterAll(() => {
  for (const s of servers) s.close()
})

describe("a hosted run can use a bound MCP source", () => {
  it("the loop is offered the server's tool, calls it, and the call reaches the server", async () => {
    const mcp = await startServer()
    servers.push(mcp.server)

    const conn = (await (
      await app.request(
        "/v1/connections",
        jsonAs(as(owner.email), { toolkit: "weather", mcp_url: mcp.url }),
      )
    ).json()) as { id: string; status: string }
    expect(conn.status).toBe("active")

    const art = (await (
      await publishAs(app, "<h1>Weather</h1><p>None yet.</p>", { title: "W" }, as(owner.email))
    ).json()) as { short_id: string }

    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          trigger: { kind: "manual" },
          instruction: "Read the weather and rewrite the document.",
          connectionIds: [conn.id],
          refs: [{ kind: "artifact", id: art.short_id }],
        }),
      )
    ).json()) as { id: string; agent_token: string }

    const run = (await (
      await app.request(`/v1/automations/${auto.id}/run`, {
        method: "POST",
        headers: as(owner.email),
      })
    ).json()) as { id: string }

    // What the model was OFFERED, and what came back from calling it. This is the pair that
    // production could not produce.
    const http: string[] = []
    const offered: string[][] = []
    const toolResults: string[] = []
    let turn = 0

    // THE TOKEN DISPATCH ACTUALLY USES: a run-scoped capability bearer, not a standing agent
    // token. The claim branches on it (claimRunById vs claimDueRuns), so a test that uses the
    // standing token exercises the branch hosted execution never takes.
    const rec = await meta.getRun(run.id)
    const runToken = await signWorkToken(
      "run",
      SECRET,
      run.id,
      rec?.agent_id ?? "",
      rec?.org_id ?? "",
      Date.now() + RUN_TOKEN_TTL_MS,
    )
    const pending: Promise<unknown>[] = []
    await loopSubstrate({
      // `start` is fire-and-forget (`void work`); waitUntil is how a caller gets the promise.
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p)
      },
      // The substrate is an HTTP client of its own deployment. In the Worker that is `handle`;
      // here it is the same app object, so route, bearer and middleware are all the real ones.
      fetchImpl: async (req: Request) => {
        const sent = req.method === "POST" ? await req.clone().text() : ""
        const res = await app.fetch(req)
        http.push(
          `${req.method} ${new URL(req.url).pathname} -> ${res.status}` +
            (sent ? ` SENT ${sent.slice(0, 260)}` : ""),
        )
        return res
      },
      callModel: async ({ tools, messages }) => {
        turn += 1
        offered.push(tools.map((t) => t.name))
        if (turn === 1)
          return {
            text: "",
            toolUses: [{ id: "t1", name: tools[0]?.name ?? "MISSING", input: { city: "London" } }],
            costUsd: null,
            done: false,
          }
        // Turn 2: the tool result is the last message the loop appended.
        toolResults.push(JSON.stringify(messages[messages.length - 1]))
        return {
          text: `<revision>${JSON.stringify({ content: "<h1>Weather</h1><p>19.8 C</p>", filename: "index.html", confidence: 0.95, message: "weather" })}</revision>`,
          toolUses: [],
          costUsd: null,
          done: true,
        }
      },
    }).start({ runId: run.id, token: runToken, server: "http://api.test" })
    await Promise.all(pending)

    // 1. The claim handed the run its bound server's tool — and named it legally.
    expect(offered[0]).toHaveLength(1)
    const name = offered[0]?.[0] ?? ""
    expect(name.endsWith("get_current_weather"), name).toBe(true)
    // The predicate, not a copy of the pattern: the contract lives in one place.
    expect(isProviderLegalToolName(name), `illegal tool name: ${name}`).toBe(true)

    // 2. The call went through the RUN'S OWN endpoint (least privilege is re-checked
    //    server-side), not straight out of the executor.
    expect(
      http.some((h) => h.includes(`/v1/agent/runs/${run.id}/tool`) && h.includes("-> 200")),
    ).toBe(true)

    // 3. And it reached the real server: connect, the claim's listing, the endpoint's
    //    allow-check, then the call itself.
    expect(seen).toContain("tools/call")

    // 4. The model saw the tool's RESULT, not an error string.
    expect(toolResults[0]).toContain("19.8")

    // 5. The run settled as a success, with the write filed.
    expect(
      http.some((h) => h.includes("/finish") && h.includes('"status":"succeeded"')),
      http.join("\n"),
    ).toBe(true)
  })
})
