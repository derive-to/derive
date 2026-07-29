import { describe, expect, it } from "vitest"
import { type DispatchDeps, dispatchPass, type Substrate } from "../src/lib/dispatch"
import { RUN_TOKEN_TTL_MS } from "../src/lib/run-lifecycle"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// THE FLAKE THIS PINS DOWN.
//
// dispatch-sim runs its operations CONCURRENTLY (Promise.all) on purpose: the interleaving
// is the thing under test. A seeded PRNG picks WHICH operations run, but nothing pins how
// their awaits interleave, and on Postgres every await is a real network round trip. So the
// same seed explores different orderings on a loaded CI box than on a fast laptop.
//
// One of those orderings made the simulation accuse the product of a bug it does not have.
// A retryable failure REQUEUES a run rather than settling it, and the sim decided a run had
// settled by checking `status !== "queued"` after the call. Let any concurrent claimer take
// the run in the window between the requeue committing and that re-read, and the status is
// `running` again -- not queued, so recorded as settled. From then on the resurrection
// invariant ("a settled run never returns to queued/running") fires against a run that never
// settled at all.
//
// This test forces exactly that window, deterministically, and asserts what is actually true:
// the store is correct throughout (the requeue is a real requeue, the re-claim is a legal
// claim of a queued run), and the ONLY sound settlement signal is a terminal status. If the
// sim ever regresses to inferring settlement from "not queued", the reasoning it depends on
// is contradicted right here.

const SECRET = "race-secret-at-least-16-chars"
const owner: TestUser = { id: "u_race", email: "race@derive.test", name: "Race" }
const { app, meta } = makeAuthedApp("dispatch-requeue-race", [owner], "commenter", {
  deps: { encryptionKey: SECRET },
})

describe("a requeued run that is re-claimed is NOT settled", () => {
  it("goes queued then running again, and never reports a terminal status", async () => {
    const booted: { runId: string; token: string }[] = []
    const substrate: Substrate = {
      name: "race",
      async start({ runId, token }) {
        booted.push({ runId, token })
      },
    }
    // Just AHEAD of the real clock, for the reason dispatch-sim documents: the routes stamp
    // scheduled_for with the server's real clock, so a run is only due to a clock at or past it.
    const now = new Date(Date.now() + 60_000)
    const deps = (): DispatchDeps => ({
      meta,
      substrate,
      server: "https://race.test",
      secret: SECRET,
      now: () => now,
    })

    const created = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: { kind: "manual" }, instruction: "race" }),
    )
    const automationId = ((await created.json()) as { id: string }).id
    await app.request(`/v1/automations/${automationId}/run`, {
      method: "POST",
      headers: as(owner.email),
    })

    // Boot an executor and let it claim: the run is now genuinely running.
    await dispatchPass(deps())
    expect(booted).toHaveLength(1)
    const e = booted[0] as { runId: string; token: string }
    const run0 = await meta.getRun(e.runId)
    if (!run0) throw new Error("run missing")
    await meta.claimRunById(e.runId, run0.agent_id, now.toISOString())
    expect((await meta.getRun(e.runId))?.status).toBe("running")

    // A RETRYABLE failure. The route requeues instead of settling -- the run lives on.
    const res = await app.request(
      `/v1/agent/runs/${e.runId}/finish`,
      jsonAs(bearer(e.token), { status: "failed", meta: { retryable: true, why: "transient" } }),
    )
    expect(res.status).toBeLessThan(300)
    expect((await res.json()) as { status: string }).toMatchObject({ status: "queued" })
    expect((await meta.getRun(e.runId))?.status).toBe("queued")

    // THE WINDOW: any concurrent claimer (another dispatch tick, a polling runner's
    // claimDueRuns, a booted executor's claim) may legally take a queued run right here.
    const reclaimed = await meta.claimRunById(e.runId, run0.agent_id, now.toISOString())
    expect(reclaimed).not.toBeNull()

    // Now the re-read the simulation performs after finishing sees `running`.
    const after = await meta.getRun(e.runId)
    expect(after?.status).toBe("running")

    // The old signal ("not queued") calls this settled. It is not: the run is mid-flight,
    // and asserting it can never be queued/running again would be asserting a falsehood.
    expect(after?.status).not.toBe("queued")
    // The sound signal. This is what the simulation records settlement on now.
    expect(["succeeded", "failed"]).not.toContain(after?.status)
    expect(after?.finished_at).toBeNull()
  })
})
