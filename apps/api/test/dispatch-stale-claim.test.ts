import { describe, expect, it } from "vitest"
import { type DispatchDeps, dispatchPass, type Substrate } from "../src/lib/dispatch"
import { RUN_TOKEN_TTL_MS } from "../src/lib/run-lifecycle"
import { signWorkToken } from "../src/lib/run-token"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// THE BUG dispatch-requeue-race.test.ts's own fix stopped short of.
//
// That test proved the RESURRECTION invariant was wrong to assert (a legitimate retry can
// put a run back in flight). This one is about the invariant right next to it in
// dispatch-sim -- "no run is ever held by two live executors at once" -- and it proves a
// genuine way to reach that state, not a false alarm.
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

const SECRET = "stale-claim-secret-16-chars-ok"
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
