// THE HOSTED PATH AGAINST A DEPLOYED DERIVE — the deployed twin of hosted-mcp-source.test.ts.
//
// That test proves the loop, the claim, the proxy and a real MCP server all work together in one
// process. This one runs the SAME substrate against a real deployment over the public internet:
// the claim, the least-privilege tool list, the tool proxy and the write are all the deployed
// code, and only the model is ours.
//
// It exists because a preview cannot start its own hosted runs. Dispatch pokes a Cloudflare
// queue, and a preview has no consumer of its own — so until that was fixed, a preview's runs
// were executed by PRODUCTION with main's code, and any fix under review looked broken no matter
// how correct it was. With the producer dropped, a preview's run simply stays queued, which is
// what lets this drive it deliberately.
//
//   node apps/api/test/weather-mcp-server.mjs 8940 &
//   cloudflared tunnel --url http://localhost:8940 --protocol http2
//   BASE=https://derive-pr-575.derive-to.workers.dev EMAIL=… PASSWORD=… \
//   WEATHER=https://<tunnel>/mcp pnpm --filter @derive/api test:live hosted-preview

import { isProviderLegalToolName } from "@derive/broker"
import { describe, expect, it } from "vitest"
import { loopSubstrate } from "../src/lib/substrate-loop"

const BASE = process.env.BASE ?? ""
const EMAIL = process.env.EMAIL ?? ""
const PASSWORD = process.env.PASSWORD ?? ""
const WEATHER = process.env.WEATHER ?? ""
// REAL_MODEL=1 drops the scripted model and lets the substrate resolve the deployment's own
// model plan — the only way to exercise the gateway adapter's tool-call translation end to end,
// which is the half that cannot be proven by scripting the model.
const REAL_MODEL = process.env.REAL_MODEL === "1"

describe("LIVE: a hosted run uses a bound MCP source on a deployment", () => {
  it("claims, calls the source through the proxy, and writes", async () => {
    expect(BASE && EMAIL && PASSWORD && WEATHER, "set BASE, EMAIL, PASSWORD, WEATHER").toBeTruthy()

    // A cookie jar of our own: the deployment's session cookie, kept by hand because this runs
    // outside a browser.
    let cookie = ""
    const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        // `origin` is not optional: Better Auth rejects a sign-in without one as cross-site,
        // and curl gets away with it only because it sends no origin at all.
        headers: { origin: BASE, ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
        redirect: "manual",
      })
      // getSetCookie(), not get(): a Set-Cookie header contains commas (Expires), so splitting
      // the joined value shreds the cookie and every later call arrives signed out.
      const set = res.headers.getSetCookie?.() ?? []
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ")
      return res
    }
    const json = async (path: string, body: unknown, method = "POST") =>
      (
        await api(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json() as Promise<Record<string, string>>

    await json("/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD })
    const me = (await (await api("/v1/me")).json()) as { user?: { email?: string } }
    expect(me.user?.email, "signed in to the deployment").toBe(EMAIL)

    const conn = await json("/v1/connections", { toolkit: "weather", mcp_url: WEATHER })
    expect(conn.status, "the deployment reached the MCP server").toBe("active")

    const fd = new FormData()
    fd.append(
      "file",
      new File(["<h1>Weather</h1><p>None yet.</p>"], "index.html", { type: "text/html" }),
    )
    fd.append("title", "Hosted preview proof")
    const art = (await (await api("/v1/artifacts", { method: "POST", body: fd })).json()) as {
      short_id: string
    }

    const agent = await json("/v1/agents", { name: `hosted-proof-${Date.now()}` })
    const auto = await json("/v1/automations", {
      agentId: agent.id,
      instruction: "Read London's weather from the connected source and rewrite the document.",
      trigger: { kind: "manual" },
      connectionIds: [conn.id],
      refs: [{ kind: "artifact", id: art.short_id }],
    })
    const run = await json(`/v1/automations/${auto.id}/run`, {})

    // DRIVE THE SUBSTRATE, exactly as dispatch would. Only `callModel` is ours: it calls the
    // first tool it is offered, then writes what came back.
    const offered: string[] = []
    let toolResult = ""
    let turn = 0
    const pending: Promise<unknown>[] = []
    await loopSubstrate({
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p)
      },
      ...(REAL_MODEL ? {} : { callModel: scripted }),
    } as Parameters<typeof loopSubstrate>[0] & Record<string, unknown>).start({
      runId: run.id ?? "",
      token: agent.token ?? "",
      server: BASE,
    })
    await Promise.all(pending)

    async function scripted({
      tools,
      messages,
    }: {
      tools: { name: string }[]
      messages: unknown[]
    }) {
      turn += 1
      if (turn === 1) {
        offered.push(...tools.map((t) => t.name))
        return {
          text: "",
          toolUses: [{ id: "t1", name: tools[0]?.name ?? "MISSING", input: { city: "London" } }],
          costUsd: null,
          done: false,
        }
      }
      toolResult = JSON.stringify(messages[messages.length - 1])
      return {
        text: `<revision>${JSON.stringify({
          content: `<h1>Weather</h1><p>Read live from a connected MCP server.</p><pre>${toolResult.slice(0, 400)}</pre>`,
          filename: "index.html",
          confidence: 0.95,
          message: "weather from the connected source",
        })}</revision>`,
        toolUses: [],
        costUsd: null,
        done: true,
      }
    }

    process.stdout.write(
      `\n  OFFERED ${JSON.stringify(offered)}\n  RESULT ${toolResult.slice(0, 200)}\n`,
    )
    if (!REAL_MODEL) {
      expect(offered, "the claim handed the run its source's tools").toHaveLength(1)
      expect(isProviderLegalToolName(offered[0] ?? "")).toBe(true)
      expect(offered[0]?.endsWith("get_current_weather")).toBe(true)
      expect(toolResult, "the model saw live data, not an error").toContain("temperature_c")
    }

    const settled = (await (await api(`/v1/workspace/runs`)).json()) as {
      runs: { id: string; status: string; meta?: string }[]
    }
    const mine = settled.runs.find((r) => r.id === run.id)
    process.stdout.write(`  RUN ${mine?.status} ${mine?.meta ?? ""}\n`)
    expect(mine?.status, "the run settled as a success").toBe("succeeded")

    for (const p of [
      `/v1/automations/${auto.id}`,
      `/v1/connections/${conn.id}`,
      `/v1/artifacts/${art.short_id}`,
      `/v1/agents/${agent.id}`,
    ])
      await api(p, { method: "DELETE" })
  }, 180_000)
})
