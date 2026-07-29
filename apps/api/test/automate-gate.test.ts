import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// The automations BETA GATE, which is the same two layers chat uses:
//
//   1. `automateBeta`, the workspace's own opt-in, OFF by default.
//   2. DERIVE_AUTOMATE_ALLOWLIST, the operator's list, on top of it — because the setting is gated
//      on `manage`, so on a shared host a workspace owner could otherwise enable it for themselves
//      and spend the operator's model key. Unset = no restriction (right for single-tenant).
//
// makeAuthedApp opts the shared workspace IN (fifteen suites create automations and should not each
// have to remember), so the closed-by-default case is proved HERE by switching it back off — which
// is the honest place for it, since this is the file that claims the gate works.
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
    // Force one request through first, so the harness' seed has run and this genuinely reverses
    // it rather than racing it.
    await app.request("/v1/automations", { headers: as(owner.email) })
    await setBeta(meta, false)
    // 404, not 403: a surface this workspace has not enabled should not confirm it exists.
    expect((await create(app)).status).toBe(404)
  })

  it("opted in, with no allowlist configured, works", async () => {
    const { app } = makeAuthedApp("gate-optin", [owner])
    expect((await create(app)).status).toBe(201)
  })

  it("opted in AND on the allowlist works", async () => {
    const { app } = makeAuthedApp("gate-allowed", [owner], undefined, {
      deps: { automateAllowlist: ["default"] },
    })
    expect((await create(app)).status).toBe(201)
  })

  it("opted in but OFF the allowlist is still refused — the operator has the last word", async () => {
    const { app } = makeAuthedApp("gate-blocked", [owner], undefined, {
      deps: { automateAllowlist: ["ws_someone_else"] },
    })
    expect((await create(app)).status).toBe(404)
  })

  it("run now is gated too, not just creation", async () => {
    // The case a create-only gate misses: an automation that already exists, whose owner presses
    // Run now after the beta moved on without them.
    const { app } = makeAuthedApp("gate-runnow", [owner])
    const made = await create(app)
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }

    const { app: locked } = makeAuthedApp("gate-runnow", [owner], undefined, {
      deps: { automateAllowlist: ["ws_someone_else"] },
    })
    const res = await locked.request(`/v1/automations/${id}/run`, jsonAs(as(owner.email), {}))
    expect(res.status).toBe(404)
  })

  it("reads and deletes stay open, so nobody loses access to their own rows", async () => {
    const { app } = makeAuthedApp("gate-reads", [owner])
    const made = await create(app)
    const { id } = (await made.json()) as { id: string }

    const { app: locked } = makeAuthedApp("gate-reads", [owner], undefined, {
      deps: { automateAllowlist: ["ws_someone_else"] },
    })
    expect((await locked.request("/v1/automations", { headers: as(owner.email) })).status).toBe(200)
    const del = await locked.request(`/v1/automations/${id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBeLessThan(300)
  })
})
