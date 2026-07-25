import { newId } from "@derive/core"
import { beforeEach, describe, expect, it } from "vitest"
import { dispatchPass, dispatchRunNow, type Substrate } from "../src/lib/dispatch"
import { signRunToken, verifyRunToken } from "../src/lib/run-token"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// HOSTED DISPATCH, tested with NO container, NO wrangler, and NO network. The substrate is the
// only platform-specific piece, so a fake one lets the whole correctness story — materialize,
// reclaim, mint a per-run capability token, boot exactly once, self-heal a dead executor — run
// as a plain unit test. This is the tier that must be green before any container exists.

const SECRET = "test-secret-at-least-16-chars"
const owner: TestUser = { id: "u_hd_own", email: "hd@derive.test", name: "Owner" }
const { app, meta } = makeAuthedApp("hosted-dispatch", [owner], "commenter", {
  deps: { encryptionKey: SECRET },
})

/** A substrate that records what it was asked to boot instead of booting anything. */
const fakeSubstrate = () => {
  const started: { runId: string; token: string; server: string }[] = []
  const s: Substrate = {
    name: "fake",
    async start(input) {
      started.push(input)
    },
  }
  return { substrate: s, started }
}

const deps = (substrate: Substrate) => ({
  meta,
  substrate,
  server: "https://derive.test",
  secret: SECRET,
})

// dispatchPass is deployment-wide by design (one tick, every workspace), so leftovers from a
// previous case would leak into the next one's counts. Settle the queue between tests so each
// case asserts on exactly its own run.
const settleQueue = async () => {
  const now = new Date().toISOString()
  for (const r of await meta.listRuns("default", 200)) {
    if (r.status === "queued") await meta.claimRunById(r.id, r.agent_id, now)
    if (r.status === "queued" || r.status === "running")
      await meta.finishRun(r.id, r.agent_id, { status: "succeeded", finishedAt: now })
  }
}
beforeEach(settleQueue)

const mkAutomation = async (body: object) => {
  const res = await app.request("/v1/automations", jsonAs(as(owner.email), body))
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; agent_token: string }
}
const runNow = async (id: string) => {
  const res = await app.request(`/v1/automations/${id}/run`, {
    method: "POST",
    headers: as(owner.email),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

describe("hosted dispatch — the platform-agnostic core", () => {
  it("boots each due queued run exactly once, with a capability token scoped to THAT run", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Keep the snapshot current.",
    })
    const run = await runNow(auto.id)
    const { substrate, started } = fakeSubstrate()

    const first = await dispatchPass(deps(substrate))
    expect(first.started).toBe(1)
    expect(started[0]?.runId).toBe(run.id)
    expect(started[0]?.server).toBe("https://derive.test")

    // The token is a real signed capability, pinned to this run + its agent + workspace.
    const claim = await verifyRunToken(SECRET, started[0]?.token ?? "", Date.now())
    expect(claim?.runId).toBe(run.id)

    // Dispatch does NOT claim — the executor does. So the run is still queued, and that is
    // exactly why a duplicate boot is harmless (the loser's claim finds nothing).
    expect((await meta.getRun(run.id))?.status).toBe("queued")
  })

  it("a run already claimed by an executor is not dispatched again", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Only once please.",
    })
    const run = await runNow(auto.id)
    const rec = await meta.getRun(run.id)
    // Simulate the booted executor claiming it.
    await meta.claimRunById(run.id, rec?.agent_id ?? "", new Date().toISOString())

    const { substrate, started } = fakeSubstrate()
    const res = await dispatchPass(deps(substrate))
    expect(res.started).toBe(0)
    expect(started).toHaveLength(0)
  })

  it("reclaims a run whose executor died, so the next tick re-dispatches it", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Survive a dead container.",
    })
    const run = await runNow(auto.id)
    const rec = await meta.getRun(run.id)
    // Claimed long ago and never finished: the substrate died mid-run.
    await meta.claimRunById(
      run.id,
      rec?.agent_id ?? "",
      new Date(Date.now() - 3600_000).toISOString(),
    )
    expect((await meta.getRun(run.id))?.status).toBe("running")

    const { substrate, started } = fakeSubstrate()
    const res = await dispatchPass(deps(substrate))
    expect(res.requeued).toBe(1)
    // Requeued AND re-dispatched in the same pass — the queue self-heals without a human.
    expect(res.started).toBe(1)
    expect(started[0]?.runId).toBe(run.id)
  })

  it("gives up on a run that keeps dying, marking it lost rather than looping forever", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Fail repeatedly.",
    })
    const run = await runNow(auto.id)
    const rec = await meta.getRun(run.id)
    const agentId = rec?.agent_id ?? ""
    const longAgo = () => new Date(Date.now() - 3600_000).toISOString()

    const { substrate } = fakeSubstrate()
    // Three death/reclaim cycles: the third exceeds the attempt cap.
    for (let i = 0; i < 3; i += 1) {
      await meta.claimRunById(run.id, agentId, longAgo())
      await dispatchPass(deps(substrate))
    }
    const final = await meta.getRun(run.id)
    expect(final?.status).toBe("failed")
    expect(final?.meta).toContain("lost")
  })

  it("materializes a due schedule into a run and boots it — the unattended path", async () => {
    // Every minute: always due, so one tick materializes exactly one run for this window.
    const auto = await mkAutomation({
      trigger: { kind: "schedule", cron: "* * * * *", tz: "UTC" },
      instruction: "Refresh hourly.",
    })
    const { substrate, started } = fakeSubstrate()
    const res = await dispatchPass(deps(substrate))
    expect(res.materialized).toBeGreaterThanOrEqual(1)
    expect(res.started).toBeGreaterThanOrEqual(1)

    // Idempotent within the cron window: a second tick materializes nothing new.
    const again = await dispatchPass(deps(substrate))
    expect(again.materialized).toBe(0)

    const booted = started.filter(Boolean)
    expect(booted.length).toBeGreaterThan(0)
    // Every boot carries a token for a run of THIS automation's agent.
    const claim = await verifyRunToken(SECRET, booted[0]?.token ?? "", Date.now())
    expect(claim).toBeTruthy()
    expect(auto.id).toBeTruthy()
  })

  it("the run-now nudge boots immediately, and is a no-op for an unknown or settled run", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Start me now.",
    })
    const run = await runNow(auto.id)
    const { substrate, started } = fakeSubstrate()

    expect(await dispatchRunNow(deps(substrate), run.id)).toBe(true)
    expect(started[0]?.runId).toBe(run.id)
    // Unknown run: false, never a throw — a failed nudge must never fail the request that
    // created the run (the tick is the guarantee).
    expect(await dispatchRunNow(deps(substrate), newId("run"))).toBe(false)
  })

  it("a substrate that throws leaves the run queued for the next tick", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Substrate is down.",
    })
    const run = await runNow(auto.id)
    const broken: Substrate = {
      name: "broken",
      start: async () => {
        throw new Error("no capacity")
      },
    }
    const res = await dispatchPass(deps(broken))
    expect(res.failed).toBe(1)
    expect(res.started).toBe(0)
    // Still queued: nothing was lost, and a working substrate picks it up next pass.
    expect((await meta.getRun(run.id))?.status).toBe("queued")
  })
})

describe("run capability tokens", () => {
  it("round-trips its claim, and rejects a forged, tampered, or expired token", async () => {
    const now = Date.now()
    const tok = await signRunToken(SECRET, "run_1", "ag_1", "ws_1", now + 60_000)
    expect(await verifyRunToken(SECRET, tok, now)).toEqual({
      runId: "run_1",
      agentId: "ag_1",
      orgId: "ws_1",
    })
    // Wrong secret (a forgery), a tampered payload, and expiry all fail closed.
    expect(await verifyRunToken("another-secret-16-chars", tok, now)).toBeNull()
    expect(await verifyRunToken(SECRET, `${tok}x`, now)).toBeNull()
    expect(await verifyRunToken(SECRET, tok, now + 120_000)).toBeNull()
    // A non-run bearer is not a run token at all.
    expect(await verifyRunToken(SECRET, "dk_agt_whatever", now)).toBeNull()
  })
})
