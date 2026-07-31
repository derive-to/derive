import { afterAll, describe, expect, it } from "vitest"
import { RUN_TOKEN_TTL_MS, signWorkToken } from "../src/lib/run-token"
import { loopSubstrate } from "../src/lib/substrate-loop"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * THE WHOLE SCENARIO, against a server on the real internet: connect a source, bind it to an
 * automation, run it, and have the run publish a document containing something only that server
 * could have told us.
 *
 * OFF BY DEFAULT — `LIVE_MCP=1 npx vitest run test/live-hosted-source.test.ts`.
 *
 * hosted-mcp-source.test.ts already drives this chain end to end, but against a server written in
 * this file, which agrees with our assumptions by construction. The live run is what catches the
 * things it cannot: DeepWiki answers over SSE and holds the stream open (that alone stalled every
 * call for 20 seconds until it was fixed), its tool names and schemas are its own, and its results
 * are prose rather than the tidy JSON a fixture returns.
 *
 * Only the MODEL is scripted, and deliberately so — it picks the tool and writes the document, but
 * every byte it reasons over came from DeepWiki.
 */

const live = process.env.LIVE_MCP === "1"
const DEEPWIKI = "https://mcp.deepwiki.com/mcp"

const owner: TestUser = { id: "u_live_h", email: "liveh@derive.test", name: "O" }
const SECRET = "zz-live-hosted-secret-at-least-16-chars"
const { app, meta } = makeAuthedApp("zz-live-hosted", [owner], "editor", {
  deps: { encryptionKey: SECRET },
})

afterAll(() => undefined)

describe.skipIf(!live)(
  "a hosted run reads from a LIVE MCP source and publishes what it read",
  () => {
    it("connect, bind, run, publish — with content only the server could supply", async () => {
      const conn = (await (
        await app.request(
          "/v1/connections",
          jsonAs(as(owner.email), { toolkit: "deepwiki", mcp_url: DEEPWIKI }),
        )
      ).json()) as { id: string; status: string }
      expect(conn.status, "DeepWiki did not connect").toBe("active")

      const art = (await (
        await publishAs(app, "<h1>MCP</h1><p>Nothing yet.</p>", { title: "MCP" }, as(owner.email))
      ).json()) as { short_id: string }

      const auto = (await (
        await app.request(
          "/v1/automations",
          jsonAs(as(owner.email), {
            trigger: { kind: "manual" },
            instruction: "Look up what an MCP tool is and rewrite the document with the answer.",
            connectionIds: [conn.id],
            // publish, so the run REVISES the document. Propose (the default) would file a
            // proposal instead, and the living-artifact claim is about the page changing.
            refs: [{ kind: "artifact", id: art.short_id, mode: "publish" }],
          }),
        )
      ).json()) as { id: string }

      const run = (await (
        await app.request(`/v1/automations/${auto.id}/run`, {
          method: "POST",
          headers: as(owner.email),
        })
      ).json()) as { id: string }

      const http: string[] = []
      const offered: string[][] = []
      let toolResult = ""
      let turn = 0

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
        waitUntil: (p: Promise<unknown>) => {
          pending.push(p)
        },
        fetchImpl: async (req: Request) => {
          const res = await app.fetch(req)
          http.push(`${req.method} ${new URL(req.url).pathname} -> ${res.status}`)
          return res
        },
        callModel: async ({ tools, messages }) => {
          turn += 1
          offered.push(tools.map((t) => t.name))
          if (turn === 1) {
            const ask = tools.find((t) => /ask|question/i.test(t.name))
            return {
              text: "",
              toolUses: [
                {
                  id: "t1",
                  name: ask?.name ?? tools[0]?.name ?? "MISSING",
                  input: {
                    repoName: "modelcontextprotocol/modelcontextprotocol",
                    question: "What is a tool in MCP?",
                  },
                },
              ],
              costUsd: null,
              done: false,
            }
          }
          toolResult = JSON.stringify(messages[messages.length - 1])
          return {
            text: `<revision>${JSON.stringify({
              content: `<h1>MCP</h1><p>${toolResult.replace(/[<>]/g, "").slice(0, 600)}</p>`,
              filename: "index.html",
              confidence: 0.95,
              message: "from deepwiki",
            })}</revision>`,
            toolUses: [],
            costUsd: null,
            done: true,
          }
        },
      }).start({ runId: run.id, token: runToken, server: "http://api.test" })
      await Promise.all(pending)

      // The live server's real tools were offered, already named legally for a model provider —
      // DeepWiki's are short, but nothing here got to assume that.
      expect(offered[0]?.length ?? 0).toBeGreaterThan(0)
      for (const n of offered[0] ?? []) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)

      // The call went through the RUN'S OWN endpoint, where least privilege is re-checked, rather
      // than straight out of the executor.
      expect(
        http.some((h) => h.includes(`/v1/agent/runs/${run.id}/tool`) && h.includes("-> 200")),
      ).toBe(true)

      // REAL CONTENT, not our own arguments handed back. The echo stub returns the caller's
      // arguments, which reads exactly like success, so this is the assertion that separates
      // "a run happened" from "a run learned something".
      expect(toolResult.length).toBeGreaterThan(200)
      expect(toolResult).not.toContain("What is a tool in MCP?")

      expect(
        http.some((h) => h.includes("/finish")),
        http.join("\n"),
      ).toBe(true)

      // THE WRITE LANDS AS A PROPOSAL, AND THAT IS CORRECT. The autonomy gate's third rung
      // files rather than publishes whenever a run had a spendable connection, above any
      // per-target `mode: "publish"` — a run that reads outside data acts on a human's say-so.
      // Asserting the document CHANGED would be asserting that safety rung away; asserting the
      // proposal exists and carries the live bytes is the same end-to-end claim without it.
      const proposals = await app.request(`/v1/artifacts/${art.short_id}/proposals`, {
        headers: as(owner.email),
      })
      expect(proposals.status).toBe(200)
      const listed = (await proposals.json()) as {
        proposals: { id: string; preview_url: string }[]
      }
      expect(listed.proposals, "the run filed nothing").toHaveLength(1)

      const content = await app.request(`/v1/artifacts/${art.short_id}/content`, {
        headers: as(owner.email),
      })
      const published = await content.text()
      expect(published, "a credentialed run must not live-publish").toContain("Nothing yet.")

      // A distinctive fragment of the ACTUAL tool result, in the ACTUAL filed bytes. A length
      // check here would have passed on an empty proposal list.
      const fragment = toolResult.replace(/[\\"<>]/g, "").slice(140, 190)
      expect(fragment.length, "no tool text to match on").toBeGreaterThan(30)
      // The list is metadata; the BYTES live behind the proposal's own preview URL, which is
      // also exactly what a reviewer opens.
      const preview = new URL(listed.proposals[0]?.preview_url ?? "")
      const filed = await (await app.request(preview.pathname, { headers: as(owner.email) })).text()
      expect(filed.replace(/[\\"<>]/g, "")).toContain(fragment)
    }, 120_000)
  },
)
