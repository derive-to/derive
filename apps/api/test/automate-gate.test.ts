import { describe, expect, it } from "vitest"
import { materializeAllDueRuns } from "../src/lib/schedule"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// THE GATE IS A KILL SWITCH, OR IT IS DECORATION.
//
// A brake that stops the button but not the clock is not a brake. With `agentWrites` off, the
// cron tick must not materialize a due schedule: an owner who pauses agents has every reason to
// believe nothing is running, and the lane with nobody watching is the one that would be.
describe("the schedule tick obeys agentWrites", () => {
  const owner: TestUser = { id: "u_gate_cron", email: "gatecron@derive.test", name: "Owner" }

  /** A schedule that is ALWAYS due: every minute, so the previous occurrence is seconds ago. */
  const everyMinute = { kind: "schedule", cron: "* * * * *" }

  it("does NOT materialize a due schedule while agent writes are paused", async () => {
    const { app, meta } = makeAuthedApp("gate-cron-off", [owner])
    const made = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: everyMinute, instruction: "Refresh the roadmap" }),
    )
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }

    // Pause agents after the automation exists: exactly the state an owner is in when they
    // decide to stop it.
    const current = await meta.getOrgSettings("default")
    if (current) await meta.setOrgSettings("default", { ...current, agentWrites: false })

    const created = await materializeAllDueRuns(meta, new Date())
    expect(created).toBe(0)
    // Nothing queued, not merely "nothing counted" — the count and the ledger have to agree.
    const runs = (await meta.listRuns("default", 200)).filter((r) => r.automation_id === id)
    expect(runs).toEqual([])
  })

  it("materializes the same schedule while agent writes are on", async () => {
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
    // dispatch takes, for the same reason.
    const { app, meta } = makeAuthedApp("gate-cron-blip", [owner])
    const made = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: everyMinute, instruction: "Refresh the roadmap" }),
    )
    expect(made.status).toBe(201)

    // A DELEGATING WRAPPER, not an assignment onto `meta`.
    //
    // On the Postgres lane the store is itself a Proxy with only a `get` trap (helpers.ts
    // defers every call until connect+migrate finishes), so `meta.getOrgSettings = fn` writes
    // to an empty target that no read ever consults — the stub silently does nothing and the
    // tick sails through on the real settings. Wrapping and passing the wrapper is the shape
    // that behaves identically on both drivers, because it never mutates the store.
    const blipping = new Proxy(meta, {
      get: (t, prop, recv) =>
        prop === "getOrgSettings"
          ? () => Promise.reject(new Error("db blip"))
          : Reflect.get(t, prop, recv),
    })
    expect(await materializeAllDueRuns(blipping, new Date())).toBe(0)
  })
})
