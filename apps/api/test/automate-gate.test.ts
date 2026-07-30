import { describe, expect, it } from "vitest"
import { materializeAllDueRuns } from "../src/lib/schedule"
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

// The gate is only useful if it can be OPENED. `automateBeta` shipped as a setting that no route
// accepted, and the settings PATCH strips unknown keys, so the flag was silently unflippable and
// the surface permanently closed on any real deployment.
describe("automateBeta is reachable over the API", () => {
  const admin: TestUser = { id: "u_gate_adm", email: "gateadm@derive.test", name: "Admin" }

  it("an admin can turn it on and off, and it round-trips", async () => {
    const { app } = makeAuthedApp("gate-patch", [admin])
    const patch = (on: boolean) =>
      app.request("/v1/workspace/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...as(admin.email) },
        body: JSON.stringify({ automateBeta: on }),
      })

    const off = await patch(false)
    expect(off.status).toBe(200)
    expect((await off.json()).automateBeta).toBe(false)
    // Refused while off, which proves the PATCH reached the gate and not just the response body.
    expect(
      (
        await app.request(
          "/v1/automations",
          jsonAs(as(admin.email), { trigger: { kind: "manual" }, instruction: "x" }),
        )
      ).status,
    ).toBe(404)

    const on = await patch(true)
    expect((await on.json()).automateBeta).toBe(true)
    expect(
      (
        await app.request(
          "/v1/automations",
          jsonAs(as(admin.email), { trigger: { kind: "manual" }, instruction: "x" }),
        )
      ).status,
    ).toBe(201)
  })
})

// THE GATE IS A KILL SWITCH, OR IT IS DECORATION.
//
// With `automateBeta` OFF, `POST /v1/automations/:id/run` correctly 404'd — and the deployment's
// cron tick went right on materializing the same automation's due schedule, dispatching it, and
// LIVE-PUBLISHING a document replacement. The flag stopped the button and not the clock, which is
// the worst possible shape: an owner who switches a beta off has every reason to believe nothing
// is running, and the lane with nobody watching was the one still running.
describe("the schedule tick obeys the gate", () => {
  const owner: TestUser = { id: "u_gate_cron", email: "gatecron@derive.test", name: "Owner" }

  /** A schedule that is ALWAYS due: every minute, so the previous occurrence is seconds ago. */
  const everyMinute = { kind: "schedule", cron: "* * * * *" }

  it("does NOT materialize a due schedule for a workspace that has not opted in", async () => {
    const { app, meta } = makeAuthedApp("gate-cron-off", [owner])
    const made = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: everyMinute, instruction: "Refresh the roadmap" }),
    )
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }

    // Switch the beta back off — the automation already exists, which is exactly the state an
    // owner is in when they decide to stop it.
    const current = await meta.getOrgSettings("default")
    if (current) await meta.setOrgSettings("default", { ...current, automateBeta: false })

    const created = await materializeAllDueRuns(meta, new Date())
    expect(created).toBe(0)
    // Nothing queued, not merely "nothing counted" — the count and the ledger have to agree.
    const runs = (await meta.listRuns("default", 200)).filter((r) => r.automation_id === id)
    expect(runs).toEqual([])
  })

  it("materializes the same schedule once the workspace opts in", async () => {
    // The positive control. Without it the test above passes just as well if the cron never
    // fires for an unrelated reason, which would prove nothing at all.
    const { app, meta } = makeAuthedApp("gate-cron-on", [owner])
    const made = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: everyMinute, instruction: "Refresh the roadmap" }),
    )
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }

    const created = await materializeAllDueRuns(meta, new Date())
    expect(created).toBeGreaterThan(0)
    const runs = (await meta.listRuns("default", 200)).filter((r) => r.automation_id === id)
    expect(runs.length).toBe(1)
    expect(runs[0]?.reason).toBe("schedule")
  })

  it("fails CLOSED when the settings read errors", async () => {
    // A database blip must not be able to start work a workspace switched off. Same stance
    // dispatch takes for hostedAgentsEnabled, for the same reason.
    const { app, meta } = makeAuthedApp("gate-cron-blip", [owner])
    const made = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: everyMinute, instruction: "Refresh the roadmap" }),
    )
    expect(made.status).toBe(201)

    const real = meta.getOrgSettings.bind(meta)
    meta.getOrgSettings = () => Promise.reject(new Error("db blip"))
    try {
      expect(await materializeAllDueRuns(meta, new Date())).toBe(0)
    } finally {
      meta.getOrgSettings = real
    }
  })
})
