import { describe, expect, it } from "vitest"
import { type DispatchDeps, dispatchPass, type Substrate } from "../src/lib/dispatch"
import {
  RUN_LEASE_MS,
  RUN_MAX_ATTEMPTS,
  RUN_TIMEOUT_MS,
  RUN_TOKEN_TTL_MS,
} from "../src/lib/run-lifecycle"
import { signWorkToken } from "../src/lib/run-token"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// THE BUG the requeue-race fix stopped short of.
//
// The requeue-race test below ("a requeued run that is re-claimed is NOT settled") proved the
// RESURRECTION invariant was wrong to assert (a legitimate retry can put a run back in flight).
// The first block here is about the invariant right next to it in dispatch-sim -- "no run is
// ever held by two live executors at once" -- and it proves a genuine way to reach that state,
// not a false alarm.
//
// A per-run work token authorizes exactly one thing: (run.id, agent.id, org.id), signed with
// an expiry. It carries NOTHING about WHICH claim episode minted it -- no started_at, no
// attempt counter, no per-claim nonce. So once a run has been re-claimed, the token from the
// SUPERSEDED claim is still perfectly valid for anything about that run id, for the rest of
// its TTL. `finish` now accepts `claimed_started_at` -- the started_at the caller's OWN claim
// began with -- and fences requeueRun/finishRun on it. Optional, so an older client that
// never sends it gets EXACTLY today's behavior: this file pins both halves of that trade-off,
// not just the fixed one, so the exposure stays visible rather than looking closed for
// everyone the moment this merges.

const SECRET = "stale-claim-secret-at-least-16-chars"
const owner: TestUser = { id: "u_stale", email: "stale@derive.test", name: "Stale" }

/** One full retry-then-supersede setup, shared by both tests below: E1 claims, reports a
 *  transient failure (a legitimate, correctly-fenced requeue), E2 claims the same run with
 *  its own fresh token. Returns everything needed to then act as either executor. */
const setupSupersededClaim = async (name: string) => {
  const { app, meta } = makeAuthedApp(name, [owner], "commenter", {
    deps: { encryptionKey: SECRET },
  })
  const booted: { runId: string; token: string }[] = []
  const substrate: Substrate = {
    name: "stale",
    async start({ runId, token }) {
      booted.push({ runId, token })
    },
  }
  const now = new Date(Date.now() + 60_000)
  const deps: DispatchDeps = {
    meta,
    substrate,
    server: "https://stale.test",
    secret: SECRET,
    now: () => now,
  }

  const created = await app.request(
    "/v1/automations",
    jsonAs(as(owner.email), { trigger: { kind: "manual" }, instruction: "stale claim" }),
  )
  const automationId = ((await created.json()) as { id: string }).id
  await app.request(`/v1/automations/${automationId}/run`, {
    method: "POST",
    headers: as(owner.email),
  })

  // E1 claims with a real work token, minted the way production mints it.
  await dispatchPass(deps)
  const e1 = booted[0] as { runId: string; token: string }
  const run0 = await meta.getRun(e1.runId)
  if (!run0) throw new Error("run missing")
  const startedUnderE1 = now.toISOString()
  await meta.claimRunById(e1.runId, run0.agent_id, startedUnderE1)

  // E1 hits something transient and reports it, honestly, AS AN UPGRADED CALLER -- this
  // requeue is legitimate and correctly fenced on its own claim, the retry mechanism
  // working exactly as designed.
  await app.request(
    `/v1/agent/runs/${e1.runId}/finish`,
    jsonAs(bearer(e1.token), {
      status: "failed",
      meta: { retryable: true, why: "transient" },
      claimed_started_at: startedUnderE1,
    }),
  )
  expect((await meta.getRun(e1.runId))?.status).toBe("queued")

  // E2 is the retry cycle continuing: a later dispatch tick, once the real 60s backoff has
  // passed, mints its OWN fresh token and claims. `claimRunById` (what a claim ultimately
  // calls) has no opinion on `scheduled_for` -- that gate is upstream, in
  // `listDueQueuedRuns` -- so minting directly here is exactly what a real later tick does,
  // without a test waiting 60 real seconds for retryDelayMs's Date.now()-stamped value.
  const e2 = {
    runId: e1.runId,
    token: await signWorkToken(
      "run",
      SECRET,
      e1.runId,
      run0.agent_id,
      run0.org_id,
      now.getTime() + RUN_TOKEN_TTL_MS,
    ),
  }
  const startedUnderE2 = new Date(now.getTime() + 1000).toISOString()
  await meta.claimRunById(e2.runId, run0.agent_id, startedUnderE2)
  expect((await meta.getRun(e1.runId))?.status).toBe("running")

  return { app, meta, e1, e2, startedUnderE1, startedUnderE2 }
}

describe("a stale-but-unexpired claim acting on a run a NEWER claim holds", () => {
  it("WITHOUT claimed_started_at: still succeeds -- the documented exposure for an older client", async () => {
    const { app, meta, e1 } = await setupSupersededClaim("stale-claim-unprotected")

    // E1's token was never revoked and is not expired. Nothing about a request that omits
    // the new field says "my claim already ended" -- so an older, not-yet-upgraded caller
    // gets exactly what it got before this fix existed. Documented, not silently patched
    // over: the shipped CLI is the one caller upgraded to always send the field (below),
    // but the field being OPTIONAL means this path stays reachable.
    const stale = await app.request(
      `/v1/agent/runs/${e1.runId}/finish`,
      jsonAs(bearer(e1.token), {
        status: "failed",
        meta: { retryable: true, why: "old client" },
      }),
    )
    expect(stale.status).toBeLessThan(300)
    const after = await meta.getRun(e1.runId)
    expect(after?.status).toBe("queued")
    expect(after?.started_at).toBeNull()
  })

  it("WITH claimed_started_at: refused -- E2's claim survives", async () => {
    const { app, meta, e1, e2, startedUnderE1, startedUnderE2 } =
      await setupSupersededClaim("stale-claim-protected")

    // Same attack, but E1 is an upgraded caller: it sends the started_at ITS claim began
    // with. That value is stale the moment E2 claims, so the fence refuses it.
    const stale = await app.request(
      `/v1/agent/runs/${e1.runId}/finish`,
      jsonAs(bearer(e1.token), {
        status: "failed",
        meta: { retryable: true, why: "upgraded client" },
        claimed_started_at: startedUnderE1,
      }),
    )
    expect(stale.status).toBe(409)

    // E2's claim is untouched: still running, still under ITS OWN started_at.
    const after = await meta.getRun(e1.runId)
    expect(after?.status).toBe("running")
    expect(after?.started_at).toBe(startedUnderE2)

    // And E2 itself, the ACTUAL current holder, is unaffected: it can still finish cleanly.
    const settleByE2 = await app.request(
      `/v1/agent/runs/${e2.runId}/finish`,
      jsonAs(bearer(e2.token), { status: "succeeded", claimed_started_at: startedUnderE2 }),
    )
    expect(settleByE2.status).toBeLessThan(300)
    expect((await meta.getRun(e1.runId))?.status).toBe("succeeded")
  })
})

describe("a requeued run that is re-claimed is NOT settled", () => {
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

// The run lifecycle clock is a SAFETY invariant, not a tuning preference. These assertions exist
// so a future "let's give runs more time" edit can't silently reopen a double-write window.
describe("run lifecycle clock", () => {
  it("orders timeout < token TTL < lease", () => {
    expect(RUN_TIMEOUT_MS).toBeLessThan(RUN_TOKEN_TTL_MS)
    expect(RUN_TOKEN_TTL_MS).toBeLessThan(RUN_LEASE_MS)
  })

  it("keeps a token alive past the executor's own deadline", () => {
    // If the token died first, a run that used its full budget could not write its own result:
    // it would do the work and then 401 at the finish line.
    expect(RUN_TOKEN_TTL_MS - RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it("only reclaims a run after its previous executor is provably powerless", () => {
    // The load-bearing one. Reclaiming mints a SECOND executor for the same run; the claim is
    // status-guarded but a WRITE is an ordinary agent write and the claim does not gate it. If
    // the first executor's token were still valid at reclaim time, two processes could write the
    // same artifact. The lease must therefore outlast the token, not merely the timeout.
    expect(RUN_LEASE_MS).toBeGreaterThan(RUN_TOKEN_TTL_MS)
  })

  it("bounds retries so a permanently-failing run is given up, not looped forever", () => {
    expect(RUN_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2)
    expect(RUN_MAX_ATTEMPTS).toBeLessThanOrEqual(5)
  })
})

describe("/tool refuses a run-scoped token once the run stops being running", () => {
  // A run-scoped work token authorizes (run, agent, org) for its whole TTL. `/tool` checked
  // only that -- never that the run was actually RUNNING -- so the same still-valid, never-
  // revoked token that a stale claim can misuse against /finish (see "a stale-but-unexpired
  // claim acting on a run a NEWER claim holds" above) could invoke bound-connection tools --
  // real third-party side effects -- against a run that is queued or REQUEUED (its claim
  // superseded). Unlike /finish, this needed no client change: a genuinely running executor's
  // tool calls always see status='running', so tightening this costs a well-behaved caller
  // nothing.
  //
  // A settled run is already refused, but by a DIFFERENT layer -- context.ts's `agentFor`
  // treats a work token as live only while its run is queued or running, so a token for a
  // finished run fails authentication entirely (global middleware, 403) before this route's
  // own code ever runs. Worth pinning as a fact about the system, not assumed: this block's
  // value is the QUEUED and REQUEUED cases, which that liveness check does NOT cover -- it
  // treats "queued" as live regardless of whether it is a fresh entry or a requeued one.

  const SECRET = "tool-gate-secret-16-chars-ok!"
  const owner: TestUser = { id: "u_gate", email: "gate@derive.test", name: "Gate" }

  const claimOneRun = async () => {
    const { app, meta } = makeAuthedApp("run-tool-gate", [owner], "commenter", {
      deps: { encryptionKey: SECRET },
    })
    const booted: { runId: string; token: string }[] = []
    const substrate: Substrate = {
      name: "gate",
      async start({ runId, token }) {
        booted.push({ runId, token })
      },
    }
    const now = new Date(Date.now() + 60_000)
    const deps: DispatchDeps = {
      meta,
      substrate,
      server: "https://gate.test",
      secret: SECRET,
      now: () => now,
    }
    const created = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: { kind: "manual" }, instruction: "tool gate" }),
    )
    const automationId = ((await created.json()) as { id: string }).id
    await app.request(`/v1/automations/${automationId}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    await dispatchPass(deps)
    const e = booted[0] as { runId: string; token: string }
    const run0 = await meta.getRun(e.runId)
    if (!run0) throw new Error("run missing")
    return { app, meta, e, run0 }
  }

  const callTool = (
    app: Awaited<ReturnType<typeof claimOneRun>>["app"],
    token: string,
    runId: string,
  ) =>
    app.request(`/v1/agent/runs/${runId}/tool`, jsonAs(bearer(token), { tool: "search", args: {} }))

  it("refuses before the run is ever claimed (queued)", async () => {
    const { app, e } = await claimOneRun()
    // The token exists (dispatch minted it), but nothing has claimed the run yet.
    const res = await callTool(app, e.token, e.runId)
    expect(res.status).toBe(409)
  })

  it("refuses on a REQUEUED run -- the case agentFor's liveness check does not cover", async () => {
    const { app, meta, e, run0 } = await claimOneRun()
    const claimedAt = new Date().toISOString()
    await meta.claimRunById(e.runId, run0.agent_id, claimedAt)
    // A legitimate retryable failure, correctly fenced -- the run goes back to queued.
    // agentFor's liveness check treats "queued" as live regardless of how it got there, so
    // the token that just requeued this run is STILL a valid principal. Only the status gate
    // this test is about stops it from being used to invoke tools while nobody currently
    // holds the claim.
    const requeue = await app.request(
      `/v1/agent/runs/${e.runId}/finish`,
      jsonAs(bearer(e.token), {
        status: "failed",
        meta: { retryable: true, why: "transient" },
        claimed_started_at: claimedAt,
      }),
    )
    expect(requeue.status).toBeLessThan(300)
    expect((await meta.getRun(e.runId))?.status).toBe("queued")

    const res = await callTool(app, e.token, e.runId)
    expect(res.status).toBe(409)
  })

  it("a SETTLED run's token is already refused, by agentFor's liveness check -- not this route's own code", async () => {
    const { app, meta, e, run0 } = await claimOneRun()
    const claimedAt = new Date().toISOString()
    await meta.claimRunById(e.runId, run0.agent_id, claimedAt)
    const finish = await app.request(
      `/v1/agent/runs/${e.runId}/finish`,
      jsonAs(bearer(e.token), { status: "succeeded", claimed_started_at: claimedAt }),
    )
    expect(finish.status).toBeLessThan(300)

    // 403 "forbidden" from the global /v1/* middleware's isPrincipal check, not this
    // route's 409 -- the token fails to authenticate at all once its run has settled.
    const res = await callTool(app, e.token, e.runId)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain("forbidden")
  })

  it("still works for the genuine case -- a claimed, running executor", async () => {
    const { app, meta, e, run0 } = await claimOneRun()
    await meta.claimRunById(e.runId, run0.agent_id, new Date().toISOString())
    const res = await callTool(app, e.token, e.runId)
    // Refused for an UNRELATED reason (no bound connections on this automation) -- proving
    // this reaches past the status gate rather than being blocked by it.
    expect(res.status).toBe(403)
    expect(await res.text()).toContain("no bound sources")
  })
})
