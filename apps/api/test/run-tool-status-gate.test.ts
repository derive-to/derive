import { describe, expect, it } from "vitest"
import { type DispatchDeps, dispatchPass, type Substrate } from "../src/lib/dispatch"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// A run-scoped work token authorizes (run, agent, org) for its whole TTL. `/tool` checked
// only that -- never that the run was actually RUNNING -- so the same still-valid, never-
// revoked token that a stale claim can misuse against /finish (dispatch-stale-claim.test.ts)
// could invoke bound-connection tools -- real third-party side effects -- against a run that
// is queued or REQUEUED (its claim superseded). Unlike /finish, this needed no client
// change: a genuinely running executor's tool calls always see status='running', so
// tightening this costs a well-behaved caller nothing.
//
// A settled run is already refused, but by a DIFFERENT layer -- context.ts's `agentFor`
// treats a work token as live only while its run is queued or running, so a token for a
// finished run fails authentication entirely (global middleware, 403) before this route's
// own code ever runs. Worth pinning as a fact about the system, not assumed: this file's
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

describe("/tool refuses a run-scoped token once the run stops being running", () => {
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
    // A legitimate retryable failure, correctly fenced (see dispatch-stale-claim.test.ts) --
    // the run goes back to queued. agentFor's liveness check treats "queued" as live
    // regardless of how it got there, so the token that just requeued this run is STILL a
    // valid principal. Only the status gate this test is about stops it from being used to
    // invoke tools while nobody currently holds the claim.
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
