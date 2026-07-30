// THE end-to-end: a live weather MCP server, through the real run path, into a real artifact.
//
// Run:  node apps/api/test/weather-mcp-server.mjs 8940 &
//       pnpm --filter @derive/api test:live
//
// What this proves that nothing else does: the whole rail carries LIVE, CHANGING data from an
// external server into a versioned document. Every other proof reads something static, where a
// stale cache and a working integration look identical.
//
// The model step is deliberately not here. A run's executor needs a model plan; what is under
// test is the SOURCES rail — connect, pin, claim, proxy, write — so the executor's one job
// (turn a tool result into prose) is done inline. Everything either side of it is the real path.
import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const WEATHER = process.env.WEATHER_MCP_URL ?? "http://localhost:8940/mcp"
const CITIES = ["London", "Tokyo", "Reykjavik"]

const owner: TestUser = { id: "u_wx", email: "wx@derive.test", name: "W" }
const { app } = makeAuthedApp("weather-artifact", [owner], "editor")

describe("LIVE: weather MCP -> claim -> tool proxy -> artifact", () => {
  it("writes a weather report built from live data", async () => {
    // 1. Connect the weather server. Pinned at approval like any other source.
    const conn = (await (
      await app.request(
        "/v1/connections",
        jsonAs(as(owner.email), { toolkit: "weather", mcp_url: WEATHER }),
      )
    ).json()) as Record<string, string>
    expect(conn.status, "weather server reachable — is it running on 8940?").toBe("active")
    expect(conn.kind).toBe("mcp")

    // 2. The document the automation keeps current.
    const art = (await (
      await publishAs(
        app,
        "<h1>Weather watch</h1><p>No readings yet.</p>",
        { title: "Weather watch" },
        as(owner.email),
      )
    ).json()) as { short_id: string }
    expect(art.short_id, "artifact created").toBeTruthy()

    // 3. An agent + automation bound to the source and pointed at the document.
    const agent = (await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "weather-runner" }))
    ).json()) as { id: string; token: string }
    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          instruction: "Update the weather table from the connected weather source.",
          trigger: { kind: "manual" },
          connectionIds: [conn.id],
          refs: [{ kind: "artifact", id: art.short_id }],
        }),
      )
    ).json()) as { id: string }

    // 4. Fire it and claim, exactly as a hosted executor does.
    await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const claimed = (await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()) as { runs: { id: string; tools?: { def: { name: string } }[] }[] }
    const run = claimed.runs.find((r) => r.tools?.length)
    expect(run, "a claimed run carrying the weather tool").toBeTruthy()
    const tool = run?.tools?.find((t) => t.def.name.endsWith(".get_current_weather"))?.def.name
    expect(tool, "the weather tool reached the run").toBeTruthy()

    // 5. Read live weather THROUGH THE PROXY — the run never holds a credential or a URL.
    const rows: string[] = []
    for (const city of CITIES) {
      const res = await app.request(
        `/v1/agent/runs/${run?.id}/tool`,
        jsonAs(bearer(agent.token), { tool, args: { city } }),
      )
      expect(res.status, `${city} lookup`).toBe(200)
      const body = (await res.json()) as {
        result?: { structuredContent?: Record<string, unknown> }
      }
      const w = body.result?.structuredContent as Record<string, string | number> | undefined
      expect(w?.place, `${city} resolved`).toBeTruthy()
      rows.push(
        `<tr><td>${w?.place}</td><td>${w?.temperature_c} °C</td><td>${w?.wind_kph} km/h</td>` +
          `<td>${w?.condition}</td><td>${w?.observed_at}</td></tr>`,
      )
    }

    // 6. The write. This is the executor's turn, done inline.
    const report =
      `<h1>Weather watch</h1>\n<table>\n` +
      `<tr><th>Place</th><th>Temp</th><th>Wind</th><th>Conditions</th><th>Observed</th></tr>\n` +
      `${rows.join("\n")}\n</table>\n` +
      `<p>Source: a connected MCP server, read through Derive's tool proxy. ` +
      `Every figure above came off the wire during this run.</p>\n`
    const put = await publishAs(
      app,
      report,
      { message: "Weather from the connected source" },
      as(owner.email),
      art.short_id,
    )
    expect(put.status, await put.clone().text()).toBe(201)

    // 7. SETTLE the run, exactly as an executor does on finish. Without this the automation is
    //    still in flight, and "the tool call worked" is not the same claim as "the run completed".
    const fin = await app.request(
      `/v1/agent/runs/${run?.id}/finish`,
      jsonAs(bearer(agent.token), {
        status: "succeeded",
        meta: { outcome: "published", artifact_short_id: art.short_id },
      }),
    )
    expect(fin.status, await fin.clone().text()).toBe(200)

    // 8. And it is really in the document.
    const back = await (
      await app.request(`/v1/artifacts/${art.short_id}/content`, { headers: as(owner.email) })
    ).text()
    for (const row of rows) {
      const place = row.split("<td>")[1]?.split("</td>")[0] ?? ""
      expect(back, `${place} is in the published document`).toContain(place)
    }

    // 9. The ledger: one accountable row for the whole thing, read from the workspace feed a
    //    human actually looks at.
    const feed = (await (
      await app.request("/v1/workspace/runs", { headers: as(owner.email) })
    ).json()) as { runs: { id: string; status: string; reason: string; automation_id?: string }[] }
    const settled = feed.runs.find((r) => r.id === run?.id)
    expect(settled, "the run appears in the workspace feed").toBeTruthy()
    expect(settled?.status, "the run settled").toBe("succeeded")

    process.stdout.write(
      `\n  AUTOMATION ${auto.id}\n  RUN ${settled?.id} status=${settled?.status} reason=${settled?.reason}\n` +
        `  ARTIFACT ${art.short_id} now reads:\n\n${report}\n`,
    )
  }, 90_000)
})
