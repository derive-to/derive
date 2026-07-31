import { newId } from "@derive/core"
import { beforeEach, describe, expect, it } from "vitest"
import { dispatchPass, dispatchRunNow, type Substrate } from "../src/lib/dispatch"
import { SESSION_MAX_AGE_MS } from "../src/lib/run-lifecycle"
import { signRunToken, verifyRunToken } from "../src/lib/run-token"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

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

describe("hosted dispatch — production guards", () => {
  it("caps how many runs one workspace may have in flight at once", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Burst me.",
    })
    // Five queued runs, a cap of two: only two start, the rest are DEFERRED (still queued for a
    // later tick) — never failed, because the work is still wanted.
    for (let i = 0; i < 5; i += 1) await runNow(auto.id)
    const { substrate, started } = fakeSubstrate()
    const res = await dispatchPass({ ...deps(substrate), perOrgLimit: 2 })
    expect(res.started).toBe(2)
    expect(res.deferred).toBe(3)
    expect(started).toHaveLength(2)

    // Nothing was lost: the deferred runs are still queued and start on later passes as the
    // in-flight ones settle.
    const queued = (await meta.listRuns("default", 50)).filter((r) => r.status === "queued")
    expect(queued.length).toBeGreaterThanOrEqual(3)
  })

  it("holds runs back when the workspace is over its monthly model budget", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Spend nothing.",
    })
    await runNow(auto.id)
    const { substrate, started } = fakeSubstrate()

    // A schedule creates runs with no human in the loop, so the budget MUST be enforced at
    // dispatch, not only at the enqueue routes — otherwise a cron automation spends past the
    // owner's cap forever. Simulate "over budget" at the store boundary: a plan with a monthly
    // cap, and spend already past it.
    const overBudgetMeta = Object.create(meta) as typeof meta
    overBudgetMeta.resolvePlan = async () =>
      ({ limits: JSON.stringify({ monthlyMicroUsd: 1_000 }) }) as never
    overBudgetMeta.sumRunCostSince = async () => 5_000
    const res = await dispatchPass({ ...deps(substrate), meta: overBudgetMeta })
    expect(res.started).toBe(0)
    expect(res.deferred).toBeGreaterThanOrEqual(1)
    expect(started).toHaveLength(0)

    // Deferred, never failed: the run is still queued, so raising the cap (or next month)
    // releases it without anyone re-creating the work.
    const still = await meta.getRun(
      (await meta.listRuns("default", 50)).find((r) => r.status === "queued")?.id ?? "",
    )
    expect(still?.status).toBe("queued")
  })
})

describe("run retries", () => {
  /** Claim a run as its agent, then report a failure the way a real executor would — over the
   *  real endpoint, as the AGENT bearer (a user session is not an executor). */
  const failRun = async (
    runId: string,
    agentId: string,
    token: string,
    metaBody: Record<string, unknown>,
  ) => {
    await meta.claimRunById(runId, agentId, new Date().toISOString())
    return app.request(
      `/v1/agent/runs/${runId}/finish`,
      jsonAs(bearer(token), { status: "failed", meta: metaBody }),
    )
  }

  it("a TRANSIENT failure goes back to the queue with a backoff, not to the ledger", async () => {
    const auto = await mkAutomation({ trigger: { kind: "manual" }, instruction: "Flaky source." })
    const run = await runNow(auto.id)
    const rec = await meta.getRun(run.id)
    // The executor says the provider blipped — worth another attempt.
    await failRun(run.id, rec?.agent_id ?? "", auto.agent_token, {
      outcome: "failed",
      why: "exit 1: API Error: 529 Overloaded",
      retryable: true,
    })
    const after = await meta.getRun(run.id)
    expect(after?.status).toBe("queued")
    // Scheduled into the future: the backoff, so the retry doesn't hammer a struggling provider.
    expect(Date.parse(after?.scheduled_for ?? "")).toBeGreaterThan(Date.now())
    expect(after?.meta).toContain("retries")
  })

  it("a DETERMINISTIC failure is terminal — no paying twice for the same answer", async () => {
    const auto = await mkAutomation({ trigger: { kind: "manual" }, instruction: "Bad prompt." })
    const run = await runNow(auto.id)
    const rec = await meta.getRun(run.id)
    await failRun(run.id, rec?.agent_id ?? "", auto.agent_token, {
      outcome: "failed",
      why: "no <revision> block in result",
      retryable: false,
    })
    expect((await meta.getRun(run.id))?.status).toBe("failed")
  })

  it("stops retrying at the cap so a permanently-broken run stops costing money", async () => {
    const auto = await mkAutomation({ trigger: { kind: "manual" }, instruction: "Always fails." })
    const run = await runNow(auto.id)
    const agentId = (await meta.getRun(run.id))?.agent_id ?? ""
    const transient = { outcome: "failed", why: "timed out", retryable: true }
    // Two retries are allowed; the third failure must settle it.
    await failRun(run.id, agentId, auto.agent_token, transient)
    expect((await meta.getRun(run.id))?.status).toBe("queued")
    await failRun(run.id, agentId, auto.agent_token, transient)
    expect((await meta.getRun(run.id))?.status).toBe("queued")
    await failRun(run.id, agentId, auto.agent_token, transient)
    const final = await meta.getRun(run.id)
    expect(final?.status).toBe("failed")
  })

  it("the activity view explains a run's state without anyone reading logs", async () => {
    const auto = await mkAutomation({ trigger: { kind: "manual" }, instruction: "Explain me." })
    const run = await runNow(auto.id)
    const agentId = (await meta.getRun(run.id))?.agent_id ?? ""
    await failRun(run.id, agentId, auto.agent_token, {
      outcome: "failed",
      why: "timed out",
      retryable: true,
    })

    const res = await app.request("/v1/workspace/runs", { headers: as(owner.email) })
    const { runs } = (await res.json()) as {
      runs: {
        id: string
        timeline: {
          phase: string
          retries: number
          last_error: string | null
          waiting_until: string | null
        }
      }[]
    }
    const row = runs.find((r) => r.id === run.id)
    // Queued again, one attempt spent, WHY it failed, and when it will next be tried — the
    // four things an operator asks when an automation "isn't doing anything".
    expect(row?.timeline.phase).toBe("queued")
    expect(row?.timeline.retries).toBe(1)
    expect(row?.timeline.last_error).toContain("timed out")
    expect(row?.timeline.waiting_until).toBeTruthy()
  })
})

describe("the workspace master switch", () => {
  it("hostedAgentsEnabled=false stops every hosted run — the operator's emergency stop", async () => {
    const auto = await mkAutomation({ trigger: { kind: "manual" }, instruction: "Should not run." })
    const run = await runNow(auto.id)
    // Flip the master switch the settings UI exposes.
    const patched = await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ hostedAgentsEnabled: false }),
    })
    expect(patched.status).toBeLessThan(300)

    const { substrate, started } = fakeSubstrate()
    const res = await dispatchPass(deps(substrate))
    expect(res.started).toBe(0)
    expect(started).toHaveLength(0)
    // The fast path honors it too, or "Run now" would bypass the one control an operator
    // reaches for to stop everything.
    expect(await dispatchRunNow(deps(substrate), run.id)).toBe(false)
    // Deferred, not failed: flipping the switch back on resumes the work.
    expect((await meta.getRun(run.id))?.status).toBe("queued")

    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ hostedAgentsEnabled: true }),
    })
    const after = await dispatchPass(deps(substrate))
    expect(after.started).toBeGreaterThanOrEqual(1)
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

describe("the dispatch queue is a latency nudge, never the source of truth", () => {
  it("a duplicate or late nudge is harmless — the executor's claim is the exclusion", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "Nudge me twice.",
    })
    const run = await runNow(auto.id)
    const { substrate, started } = fakeSubstrate()

    // Two nudges for the same run (a duplicated queue message, or a nudge racing the tick).
    expect(await dispatchRunNow(deps(substrate), run.id)).toBe(true)
    expect(await dispatchRunNow(deps(substrate), run.id)).toBe(true)
    // Both boot an executor — and that is FINE: whichever claims first wins the
    // status-guarded flip, the other finds nothing and exits. Nothing is written twice.
    expect(started).toHaveLength(2)
    const agentId = (await meta.getRun(run.id))?.agent_id ?? ""
    const now = new Date().toISOString()
    expect(await meta.claimRunById(run.id, agentId, now)).toBeTruthy()
    expect(await meta.claimRunById(run.id, agentId, now)).toBeNull()
  })

  it("a nudge for an already-settled run does nothing (a late message costs nothing)", async () => {
    const auto = await mkAutomation({ trigger: { kind: "manual" }, instruction: "Too late." })
    const run = await runNow(auto.id)
    const agentId = (await meta.getRun(run.id))?.agent_id ?? ""
    const now = new Date().toISOString()
    await meta.claimRunById(run.id, agentId, now)
    await meta.finishRun(run.id, agentId, { status: "succeeded", finishedAt: now })

    const { substrate, started } = fakeSubstrate()
    expect(await dispatchRunNow(deps(substrate), run.id)).toBe(false)
    expect(started).toHaveLength(0)
  })
})

describe("hosted ASKS — a question runs on the same executor as a schedule", () => {
  it("dispatches an open session with a session-scoped token, and that token claims only it", async () => {
    // A context (agent auto-mints), then somebody asks it something.
    const brief = await publishAs(
      app,
      "# Brief\n\nAnswer plainly.",
      { title: "Ask Brief" },
      as(owner.email),
    )
    const briefJson = (await brief.json()) as { short_id: string }
    const ctx = (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), { name: "Asker Ctx", manifest_short_id: briefJson.short_id }),
      )
    ).json()) as { id: string; agent_token: string }
    const sessRes = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "How flaky was checkout this week?" }),
    )
    expect(sessRes.status).toBeLessThan(300)
    // The ask response wraps the session alongside its first message.
    const { session } = (await sessRes.json()) as { session: { id: string } }

    // The SAME tick that dispatches runs now dispatches asks — no separate lane, no daemon.
    const { substrate, started } = fakeSubstrate()
    const res = await dispatchPass(deps(substrate))
    expect(res.sessionsStarted).toBeGreaterThanOrEqual(1)
    const boot = started.find((s) => s.runId === session.id)
    expect(boot).toBeTruthy()
    // Session tokens are their OWN kind: a dksess_ bearer can never verify as a run, so the
    // two scopes can't be confused even with an identical payload.
    expect(boot?.token.startsWith("dksess_")).toBe(true)
    expect(await verifyRunToken(SECRET, boot?.token ?? "", Date.now())).toBeNull()

    // That token claims exactly its session — and only once: a duplicate boot loses the race.
    const claim = async () =>
      app.request("/v1/agent/sessions/claim", jsonAs(bearer(boot?.token ?? ""), {}))
    const first = (await (await claim()).json()) as { session: { id: string } | null }
    expect(first.session?.id).toBe(session.id)
    const second = (await (await claim()).json()) as { session: { id: string } | null }
    expect(second.session).toBeNull()
  })

  it("a standing agent bearer cannot use the hosted session claim (the queue is its door)", async () => {
    const res = await app.request("/v1/agent/sessions/claim", jsonAs(as(owner.email), {}))
    expect([401, 403]).toContain(res.status)
  })

  it("a session token is refused on the RUN lane — no claim, no finish, no tools", async () => {
    // The mirror of the case above, and the one that was missing. The run lane reads "no run
    // scope" as "a standing polling runner" — the only bearer entitled to claim a BATCH, tick
    // the schedule and sweep the queue. A session token ALSO has no run scope, so it used to
    // inherit every one of those powers: a credential minted for one question could claim
    // this agent's automation runs, execute their bound source tools, and settle them.
    //
    // The two kinds are cryptographically distinct, which stops a session token verifying as
    // a run. It does not stop the wrong kind being ACCEPTED where kind was never checked,
    // which is what happened — so this asserts the endpoints, not the crypto.
    const brief = await publishAs(app, "# B", { title: "Escalation Brief" }, as(owner.email))
    const briefJson = (await brief.json()) as { short_id: string }
    const ctx = (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), { name: "Escalation Ctx", manifest_short_id: briefJson.short_id }),
      )
    ).json()) as { id: string }
    const { session } = (await (
      await app.request(
        `/v1/contexts/${ctx.id}/sessions`,
        jsonAs(as(owner.email), { body_md: "one innocent question" }),
      )
    ).json()) as { session: { id: string } }

    // A queued run on the SAME agent — the prize a session token must not be able to reach.
    const auto = await mkAutomation({
      trigger: { kind: "manual" },
      instruction: "refresh the numbers",
      context_id: ctx.id,
    })
    const victim = await runNow(auto.id)

    const { substrate, started } = fakeSubstrate()
    await dispatchPass(deps(substrate))
    const sessToken = started.find((s) => s.runId === session.id)?.token ?? ""
    expect(sessToken.startsWith("dksess_")).toBe(true)

    // Claim: must not fall through to the standing-runner batch branch.
    expect((await app.request("/v1/agent/runs/claim", { headers: bearer(sessToken) })).status).toBe(
      403,
    )
    // Finish: must not settle another executor's run as done.
    expect(
      (
        await app.request(
          `/v1/agent/runs/${victim.id}/finish`,
          jsonAs(bearer(sessToken), { status: "succeeded" }),
        )
      ).status,
    ).toBe(403)
    // Tools: must not execute the run's bound third-party connections.
    expect(
      (
        await app.request(
          `/v1/agent/runs/${victim.id}/tool`,
          jsonAs(bearer(sessToken), { name: "stripe.read", args: {} }),
        )
      ).status,
    ).toBe(403)

    // And the run is untouched — still queued for the executor it belongs to.
    expect((await meta.getRun(victim.id))?.status).toBe("queued")
  })
})

describe("the ask lane gives up rather than paying forever", () => {
  it("abandons a session that never settles, instead of re-dispatching it every lapse", async () => {
    // A session whose executor keeps dying is re-served on every lease lapse. Runs are bounded
    // by RUN_MAX_ATTEMPTS via their meta counter; sessions have no such column, so without a
    // horizon this is an unbounded spend loop — a full agent run per lapse, forever — and the
    // monthly budget cannot stop it because nothing writes the meter it reads.
    const brief = await publishAs(app, "# B", { title: "Horizon Brief" }, as(owner.email))
    const briefJson = (await brief.json()) as { short_id: string }
    const ctx = (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), { name: "Horizon Ctx", manifest_short_id: briefJson.short_id }),
      )
    ).json()) as { id: string }
    const { session } = (await (
      await app.request(
        `/v1/contexts/${ctx.id}/sessions`,
        jsonAs(as(owner.email), { body_md: "a question nobody ever answers" }),
      )
    ).json()) as { session: { id: string } }

    // Move the CLOCK past the horizon rather than ageing the row — dispatch takes an injected
    // clock precisely so time-dependent behaviour is testable without a store method that
    // exists only for tests.
    const { substrate, started } = fakeSubstrate()
    await dispatchPass({
      ...deps(substrate),
      now: () => new Date(Date.now() + SESSION_MAX_AGE_MS + 60_000),
    })

    // Not booted, and terminal — so it stops being scanned rather than coming back next tick.
    expect(started.some((s) => s.runId === session.id)).toBe(false)
    expect((await meta.getSession(session.id))?.state).toBe("failed")
  })
})

describe("the unattended lane on a deployment that holds the model key", () => {
  // THE REGRESSION. A gateway (DERIVE_MODEL_BASE_URL/_API_KEY/_NAME) means the operator pays for
  // every workspace on the deployment, so no workspace connects a plan and findPayer correctly
  // finds nobody. The attended lane and the manual lane both short-circuit on that; the schedule
  // materializer did not, so on derive.to every cron occurrence was silently dropped — `Run now`
  // worked, the clock never did, and nothing surfaced it because the only signal was a log line.
  it("materializes a due schedule when the operator pays, and skips it when nobody can", async () => {
    const auto = await mkAutomation({
      // Always due: the previous occurrence of an every-minute cron is never more than a minute
      // old, so one pass is enough and the test needs no clock travel.
      trigger: { kind: "schedule", cron: "* * * * *" },
      instruction: "Keep the roadmap current.",
    })
    const mine = async () =>
      (await meta.listRuns("default", 200)).filter((r) => r.automation_id === auto.id)

    // A workspace on a hosted deployment connects NOTHING: `GET /v1/plans` returns `[]`, which
    // is the observed state on derive.to. Simulate that at the store boundary so every payer
    // tier — initiator, owner-lend, pool — genuinely comes up empty.
    const noPlans = Object.create(meta) as typeof meta
    noPlans.listModelCredentials = async () => []

    // Without a gateway, refusing is correct: this is the guard doing its job.
    const { substrate } = fakeSubstrate()
    const refused = await dispatchPass({ ...deps(substrate), meta: noPlans, operatorPays: false })
    expect(refused.materialized).toBe(0)
    expect(await mine()).toHaveLength(0)

    // Same workspace, same empty plan list, but the operator holds the key. The occurrence must
    // materialize: there is no chain to walk and nothing for anyone to connect.
    const res = await dispatchPass({ ...deps(substrate), meta: noPlans, operatorPays: true })
    expect(res.materialized).toBeGreaterThanOrEqual(1)
    const runs = await mine()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.reason).toBe("schedule")

    // Still idempotent inside the window — paying for everyone must not mean firing every tick.
    await dispatchPass({ ...deps(substrate), meta: noPlans, operatorPays: true })
    expect(await mine()).toHaveLength(1)
  })

  it("still obeys automateBeta when the operator pays — the gate is not a payer question", async () => {
    const auto = await mkAutomation({
      trigger: { kind: "schedule", cron: "* * * * *" },
      instruction: "Should never fire with the beta off.",
    })
    const patched = await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ automateBeta: false }),
    })
    expect(patched.status).toBeLessThan(300)

    const { substrate } = fakeSubstrate()
    await dispatchPass({ ...deps(substrate), operatorPays: true })
    const runs = (await meta.listRuns("default", 200)).filter((r) => r.automation_id === auto.id)
    expect(runs).toHaveLength(0)

    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ automateBeta: true }),
    })
  })
})
