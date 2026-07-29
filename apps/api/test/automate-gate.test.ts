import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// The automations BETA GATE: `automateBeta`, the workspace's own opt-in, OFF by default.
//
// makeAuthedApp opts the shared workspace IN (fifteen suites create automations and should not each
// have to remember), so the closed-by-default case is proved HERE by switching it back off.
describe("automations beta gate", () => {
  const owner: TestUser = { id: "u_gate_own", email: "gateown@derive.test", name: "Owner" }

  type App = ReturnType<typeof makeAuthedApp>["app"]
  type Meta = ReturnType<typeof makeAuthedApp>["meta"]

  const setBeta = async (meta: Meta, on: boolean) => {
    const current = await meta.getOrgSettings("default")
    if (current) await meta.setOrgSettings("default", { ...current, automateBeta: on })
  }

  const create = (app: App) =>
    app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "Keep the roadmap current",
      }),
    )

  it("is CLOSED by default — the workspace has to opt in", async () => {
    const { app, meta } = makeAuthedApp("gate-default-off", [owner])
    // One request first, so the harness' seed has run and this reverses it rather than racing it.
    await app.request("/v1/automations", { headers: as(owner.email) })
    await setBeta(meta, false)
    // 404, not 403: a surface this workspace has not enabled should not confirm it exists.
    expect((await create(app)).status).toBe(404)
  })

  it("opted in, it works", async () => {
    const { app } = makeAuthedApp("gate-optin", [owner])
    expect((await create(app)).status).toBe(201)
  })

  it("run now is gated too, not just creation", async () => {
    // The case a create-only gate misses: an automation that already exists, whose owner presses
    // Run now after the workspace was switched back off.
    const { app, meta } = makeAuthedApp("gate-runnow", [owner])
    const made = await create(app)
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }

    await setBeta(meta, false)
    const res = await app.request(`/v1/automations/${id}/run`, jsonAs(as(owner.email), {}))
    expect(res.status).toBe(404)
  })

  it("reads and deletes stay open, so nobody loses access to their own rows", async () => {
    const { app, meta } = makeAuthedApp("gate-reads", [owner])
    const made = await create(app)
    const { id } = (await made.json()) as { id: string }

    await setBeta(meta, false)
    expect((await app.request("/v1/automations", { headers: as(owner.email) })).status).toBe(200)
    const del = await app.request(`/v1/automations/${id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBeLessThan(300)
  })
})
