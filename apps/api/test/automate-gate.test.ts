import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// The automations BETA ALLOWLIST (DERIVE_AUTOMATE_ALLOWLIST): which workspaces may create or run
// automations on this deployment.
//
// One layer, not chat's two, and the asymmetry is deliberate: chat was a new surface, so a
// workspace opt-in defaulting to off cost nobody anything, while automations already ship and
// already run — a per-workspace flag defaulting to off would delete a working feature from every
// self-host on upgrade. So an UNSET allowlist means no restriction, and naming any workspace
// restricts to exactly those.
describe("automations beta allowlist", () => {
  const owner: TestUser = { id: "u_gate_own", email: "gateown@derive.test", name: "Owner" }

  type App = ReturnType<typeof makeAuthedApp>["app"]

  const create = (app: App) =>
    app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "Keep the roadmap current",
      }),
    )

  it("unset allowlist does not restrict anyone — self-host keeps working", async () => {
    const { app } = makeAuthedApp("gate-unset", [owner])
    expect((await create(app)).status).toBe(201)
  })

  it("a workspace ON the list still works", async () => {
    const { app } = makeAuthedApp("gate-allowed", [owner], undefined, {
      deps: { automateAllowlist: ["default"] },
    })
    expect((await create(app)).status).toBe(201)
  })

  it("a workspace OFF the list is refused, and told nothing", async () => {
    const { app } = makeAuthedApp("gate-blocked", [owner], undefined, {
      deps: { automateAllowlist: ["ws_someone_else"] },
    })
    const res = await create(app)
    // 404, not 403: a surface this workspace is not in the beta for should not confirm it exists.
    expect(res.status).toBe(404)
  })

  it("run now is gated too, not just creation", async () => {
    // Create while allowed, then re-open the SAME store with the workspace off the list. This is
    // the case a create-only gate misses: an automation that already exists, whose owner presses
    // Run now after the beta moved on without them.
    const { app } = makeAuthedApp("gate-runnow", [owner], undefined, {
      deps: { automateAllowlist: ["default"] },
    })
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
    const { app } = makeAuthedApp("gate-reads", [owner], undefined, {
      deps: { automateAllowlist: ["default"] },
    })
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
