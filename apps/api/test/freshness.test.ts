import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WO7 — on-view freshness. Opening an artifact enqueues a refresh run for any stale "view"
// automation targeting it, debounced so concurrent opens don't pile up runs.
describe("on-view freshness (WO7)", () => {
  const owner: TestUser = { id: "u_fresh_own", email: "freshown@derive.test", name: "O" }
  const { app } = makeAuthedApp("freshness", [owner], "editor")
  let n = 0
  const mintAgent = async () => {
    n += 1
    return (await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: `R ${n}` }))
    ).json()) as { id: string }
  }
  const makeArtifact = async () => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# Doc")]), "doc.md")
    return (await (
      await app.request("/v1/artifacts", { method: "POST", body: form, headers: as(owner.email) })
    ).json()) as { short_id: string }
  }
  const viewAutomation = async (shortId: string, maxAgeMinutes: number, enabled = true) => {
    const agent = await mintAgent()
    return (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          trigger: { kind: "view", maxAgeMinutes },
          instruction: "refresh this",
          refs: [shortId],
          enabled,
        }),
      )
    ).json()) as { id: string }
  }
  const viewBeacon = (shortId: string) =>
    app.request(`/v1/artifacts/${shortId}/view`, { ...jsonAs(as(owner.email), {}), method: "POST" })
  const viewRuns = async (autoId: string) =>
    (
      (await (await app.request("/v1/workspace/runs", { headers: as(owner.email) })).json())
        .runs as { automation_id: string; reason: string }[]
    ).filter((r) => r.automation_id === autoId && r.reason === "view")

  it("a stale view-automation enqueues one refresh on open, debounced against repeats", async () => {
    const art = await makeArtifact()
    const auto = await viewAutomation(art.short_id, 0)
    expect((await viewBeacon(art.short_id)).status).toBe(204)
    expect(await viewRuns(auto.id)).toHaveLength(1)
    // A second, near-immediate open is debounced (the queued run already covers it).
    await viewBeacon(art.short_id)
    expect(await viewRuns(auto.id)).toHaveLength(1)
  })

  it("a fresh artifact (age below the budget) enqueues nothing", async () => {
    const art = await makeArtifact()
    const auto = await viewAutomation(art.short_id, 60)
    await viewBeacon(art.short_id)
    expect(await viewRuns(auto.id)).toHaveLength(0)
  })

  it("a disabled view-automation enqueues nothing", async () => {
    const art = await makeArtifact()
    const auto = await viewAutomation(art.short_id, 0, false)
    await viewBeacon(art.short_id)
    expect(await viewRuns(auto.id)).toHaveLength(0)
  })
})
