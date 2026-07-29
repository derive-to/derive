import { describe, expect, it } from "vitest"
import { type DispatchDeps, dispatchPass, type Substrate } from "../src/lib/dispatch"
import { RUN_LEASE_MS, RUN_MAX_ATTEMPTS, RUN_TOKEN_TTL_MS } from "../src/lib/run-lifecycle"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

/**
 * DETERMINISTIC SIMULATION of the dispatch loop.
 *
 * The defects this branch shipped with were not found by unit tests. They were found by people
 * reading very carefully — a reclaim race that needed two sweeps interleaved at exactly the
 * wrong moment, a lease shorter than the token it was protecting. Those are not defects you
 * write a test for, because writing the test requires already knowing the interleaving. So the
 * correctness of an unattended executor rested on how hard a human stared at it, which does not
 * scale and does not survive the next change.
 *
 * This runs the loop against randomly interleaved operations on a virtual clock, asserting the
 * invariants after every step. It is not a model of the system: it drives the REAL dispatchPass,
 * the REAL store queries (claimRunById, reclaimStaleRuns, requeueRun, finishRun) and the REAL
 * finish endpoint, so a bug in any of them is a bug here. A failure prints its seed, and
 * re-running that seed reproduces it exactly.
 *
 * WHAT IT ACTUALLY CAUGHT, so the value is on the record rather than assumed: the finish route
 * REPLACING run.meta instead of merging it, which erased the reclaim sweep's `attempts` and a
 * webhook run's `payloads` at the moment the run settled. Nobody had noticed; it survived code
 * review; the simulation failed on it within minutes of first running.
 *
 * WHAT IT DOES NOT CATCH, equally on the record: the reclaim race. That needs two sweeps to
 * have SELECTed the same stale run, a claim to land between their UPDATEs, and all three to
 * concern the same row — a coincidence uniform exploration reaches too rarely to gate on. It
 * has an explicit test at the bottom of this file instead. Biasing the simulation toward that
 * shape was tried and abandoned: it amounted to writing that test while pretending the search
 * had found it.
 *
 * WHAT IT ASSERTS (the properties that make unattended execution safe):
 *   SAFETY  no run is ever held by two live executors at once — the double-write invariant,
 *           and the one that actually costs a user their document
 *   SAFETY  a workspace never exceeds its in-flight cap
 *   SAFETY  the attempt counter never exceeds its cap, and never goes backwards
 *   SAFETY  a run that has settled never comes back to life
 *   LIVENESS every run reaches a terminal state within a bounded number of ticks
 *
 * The virtual clock is the whole trick: leases, token TTLs and retry backoffs are minutes
 * apart, so real time cannot explore them. Here a tick can jump 30 minutes and the reclaim
 * path is exercised on every seed rather than never.
 */

/** The liveness sweep reads a wider window than the per-step invariant checks: it must see
 *  every run this seed created, not just the newest page of a store twelve seeds share. */
const LIVENESS_WINDOW = 5000

const SECRET = "sim-secret-at-least-16-chars"
const owner: TestUser = { id: "u_sim", email: "sim@derive.test", name: "Sim" }
const { app, meta } = makeAuthedApp("dispatch-sim", [owner], "commenter", {
  deps: { encryptionKey: SECRET },
})

/** A seeded PRNG (mulberry32) — same seed, same run, always. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** One simulated executor: what it holds, whether it is still alive, and — critically — when
 *  its capability token dies. An executor past its TTL cannot write no matter what it thinks it
 *  holds, which is the entire reason the lifecycle clock orders timeout < token < lease. */
type Executor = {
  runId: string
  token: string
  alive: boolean
  claimed: boolean
  expiresAtMs: number
  /** Virtual time this executor won its claim — the start of its lease. */
  claimedAtMs: number
}

/** The invariant checker. Runs after EVERY operation, against the real store.
 *
 *  Scoped to runs this seed created (`mine`, by automation): the store is shared by every seed
 *  in the file and dispatch is deployment-wide by design, so an unscoped assertion would fail
 *  on a previous seed's leftovers and report a bug that isn't there. */
const checkInvariants = async (
  orgId: string,
  mine: (r: { automation_id: string | null }) => boolean,
  executors: Executor[],
  seenAttempts: Map<string, number>,
  settled: Set<string>,
  nowMs: number,
) => {
  const runs = (await meta.listRuns(orgId, 500)).filter((r) => mine(r))

  // SAFETY: never two DANGEROUS executors on one run. Dangerous means: alive, holding a claim,
  // and still inside its token TTL — because a token is what lets it write. This is precisely
  // the property RUN_TIMEOUT < RUN_TOKEN_TTL < RUN_LEASE exists to buy: by the time the lease
  // lapses and a replacement is dispatched, the previous executor is provably tokenless.
  //
  // So this assertion IS the test of that ordering. Shorten the lease below the token TTL —
  // which is exactly what the ask lane did before it was fixed — and two executors sit inside
  // their validity windows at once, and this fires.
  const live = executors.filter((e) => e.alive && e.claimed && e.expiresAtMs > nowMs)
  const byRun = new Map<string, number>()
  for (const e of live) byRun.set(e.runId, (byRun.get(e.runId) ?? 0) + 1)
  for (const [runId, n] of byRun) {
    expect(n, `run ${runId} held by ${n} live executors — double-write window`).toBeLessThanOrEqual(
      1,
    )
  }

  // SAFETY: a live claim is never stolen. If an executor holds a run and its LEASE has not
  // lapsed, nothing may move that run out from under it — not a sweep, not another dispatch.
  //
  // This is the direct form of the reclaim race. The emergent version (two sweeps, a claim
  // between their updates, a second executor booted after) needs a four-step coincidence that
  // random exploration hits rarely; this states the property itself, so a single bad update
  // fires it immediately. Removing the started_at fence from reclaimStaleRuns makes a sweep
  // requeue a run claimed seconds earlier, and this catches it on the next check.
  for (const e of executors) {
    if (!(e.alive && e.claimed && e.expiresAtMs > nowMs)) continue
    if (nowMs - e.claimedAtMs >= RUN_LEASE_MS) continue // lease genuinely lapsed; fair game
    const r = runs.find((x) => x.id === e.runId)
    if (!r) continue
    // The danger is specifically being handed BACK TO THE QUEUE, because only a queued run is
    // dispatched again — that is how a second executor appears beside a live one. A run that
    // reached a terminal state while its holder was still notionally alive is NOT a violation:
    // nothing will be booted for it, and every write endpoint is guarded on `running`.
    //
    // (Being precise here matters. Asserting `=== "running"` instead flagged legitimate
    // finishes, because the routes stamp isoNow() from the REAL clock while dispatch takes the
    // simulated one, so a settled run can look as though it finished before it started.)
    expect(
      r.status,
      `run ${e.runId} was requeued under a live holder (claimed ` +
        `${(nowMs - e.claimedAtMs) / 1000}s ago, lease ${RUN_LEASE_MS / 1000}s) — it can now be ` +
        `dispatched a second time while the first executor still holds a valid token`,
    ).not.toBe("queued")
  }

  // SAFETY: a settled run never returns to queued/running. Resurrection means a finished
  // automation silently runs again and republishes.
  for (const r of runs) {
    if (settled.has(r.id)) {
      expect(
        ["succeeded", "failed"].includes(r.status),
        `run ${r.id} settled earlier but is now ${r.status} — resurrected`,
      ).toBe(true)
    }
  }

  // SAFETY: the attempt counter is monotonic and capped. Going backwards is how a run escapes
  // its cap and retries forever (the retry path used to clobber it).
  for (const r of runs) {
    const attempts = Number(JSON.parse(r.meta ?? "{}").attempts ?? 0)
    const prior = seenAttempts.get(r.id) ?? 0
    expect(
      attempts,
      `run ${r.id} attempts went backwards ${prior} → ${attempts}`,
    ).toBeGreaterThanOrEqual(prior)
    expect(attempts, `run ${r.id} exceeded the attempt cap`).toBeLessThanOrEqual(RUN_MAX_ATTEMPTS)
    seenAttempts.set(r.id, attempts)
  }

  // NOTE: there is deliberately no assertion on total in-flight runs. dispatch honours
  // perOrgLimit, but the POLLING lane (claimDueRuns) does not — a standing runner claims a
  // batch with no per-workspace cap at all — so a global ceiling is not a property this system
  // actually guarantees. Asserting one produced failures that had nothing to do with the bug
  // under test and masked the real signal. If the polling lane ever gains a cap, assert it here.
}

describe("dispatch loop — deterministic simulation", () => {
  /** One seeded run of the world. Returns nothing; throws on the first violated invariant. */
  const simulate = async (seed: number, steps: number) => {
    const rand = rng(seed)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T
    const orgId = "default"

    // Virtual time, started just AHEAD of the real clock. It has to be: routes like Run now
    // and /fire stamp scheduled_for with the server's real `new Date()`, so a virtual clock
    // pinned to some tidy past date would leave every such run permanently "not yet due" and
    // the simulation would quietly test nothing. Starting ahead means real-stamped work is
    // immediately due, and from there the clock only moves forward under the sim's control.
    let nowMs = Date.now() + 60_000
    const now = () => new Date(nowMs)

    const executors: Executor[] = []
    const seenAttempts = new Map<string, number>()
    const settled = new Set<string>()

    // Everything already in the store belongs to an earlier seed. Dispatch is deployment-wide,
    // so it will legitimately act on those rows too — this seed just must not ASSERT on them.
    //
    // Scoped by AUTOMATION, not by a snapshot of run ids taken before the seed starts. The
    // snapshot was a listRuns(500), and listRuns is `order by created_at desc limit N`: twelve
    // seeds share this store, so once their runs pass 500 the snapshot silently stops covering
    // the older ones, and every run it missed then reads as "mine". A seed would assert its
    // liveness and attempt-cap invariants against another seed's leftovers — volume-dependent,
    // so it surfaces on a full CI suite and never on a single-file run. Every run a seed
    // creates hangs off one of its own automations (both `Run now` and schedule
    // materialization stamp automation_id), which makes this exact and unbounded.
    const mine = (r: { automation_id: string | null }) =>
      r.automation_id !== null && autoIds.includes(r.automation_id)

    // The substrate hands each boot to the simulation instead of starting anything: the sim
    // decides when (or whether) that executor claims, finishes, or simply dies.
    const substrate: Substrate = {
      name: "sim",
      async start({ runId, token }) {
        // dispatch mints at now + RUN_TOKEN_TTL_MS, and the sim owns `now`, so this is the
        // executor's real deadline rather than an approximation of one.
        executors.push({
          runId,
          token,
          alive: true,
          claimed: false,
          expiresAtMs: nowMs + RUN_TOKEN_TTL_MS,
          claimedAtMs: 0,
        })
      },
    }
    const deps = (): DispatchDeps => ({
      meta,
      substrate,
      server: "https://sim.test",
      secret: SECRET,
      now,
    })

    // A few automations to generate work, some on a schedule so the materialize path runs.
    const autoIds: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          trigger:
            i === 0 ? { kind: "schedule", cron: "* * * * *", tz: "UTC" } : { kind: "manual" },
          instruction: `sim automation ${seed}.${i}`,
        }),
      )
      autoIds.push(((await res.json()) as { id: string }).id)
    }

    // ---- The operations, as closures, so ANY of them can be run concurrently ----
    //
    // Concurrency is the whole point, and it has to be general. An earlier version only ever
    // ran two dispatch TICKS together, which never reproduced the reclaim race — that one needs
    // a CLAIM to land between two sweeps' updates, so ticks and claims must be able to overlap.
    // Every await inside these is a real interleaving point.

    const opTick = async () => {
      await dispatchPass(deps())
    }

    /** A polling runner's claim. It sweeps and ticks the schedule too, so in production it is a
     *  second concurrent sweeper — which is what makes the reclaim race reachable at all. */
    const opPollingClaim = async () => {
      const a = await meta.getAutomation(pick(autoIds))
      if (!a) return
      await meta.reclaimStaleRuns(new Date(nowMs - RUN_LEASE_MS).toISOString(), RUN_MAX_ATTEMPTS)
      await meta.claimDueRuns(a.agent_id, now().toISOString(), 5)
    }

    /** A booted executor claims. The status guard is the race safety: a loser gets null and must
     *  never consider itself the holder. */
    const opClaim = async () => {
      const pending = executors.filter((e) => e.alive && !e.claimed)
      if (!pending.length) return
      const e = pick(pending)
      const r = await meta.getRun(e.runId)
      const claimed = r ? await meta.claimRunById(e.runId, r.agent_id, now().toISOString()) : null
      if (claimed) {
        e.claimed = true
        e.claimedAtMs = nowMs
      } else e.alive = false
    }

    /** A claimed executor settles, through the REAL finish endpoint with its own capability
     *  token — the route is where the retry decision and the meta merge live. */
    const opFinish = async () => {
      const holders = executors.filter((e) => e.alive && e.claimed)
      if (!holders.length) return
      const e = pick(holders)
      const r = await meta.getRun(e.runId)
      if (r && r.status === "running") {
        const outcome = rand()
        const body =
          outcome < 0.2
            ? { status: "failed", meta: { retryable: true, why: "sim: transient" } }
            : { status: outcome < 0.6 ? "succeeded" : "failed", meta: { why: "sim" } }
        const res = await app.request(
          `/v1/agent/runs/${e.runId}/finish`,
          jsonAs(bearer(e.token), body),
        )
        const after = res.status < 300 ? await meta.getRun(e.runId) : null
        // TERMINAL, not merely "not queued". A retryable failure REQUEUES rather than settling,
        // and these operations run concurrently on purpose — so any other claimer (a dispatch
        // tick, a polling runner's claimDueRuns, another executor) may legally take the run
        // back to `running` in the window between that requeue committing and this re-read.
        // Reading "not queued" as settlement therefore records a run that is still in flight,
        // and the resurrection invariant below then fires against a run that never settled: a
        // false accusation that only shows up where the interleaving is slow enough to hit,
        // i.e. Postgres in CI and not SQLite on a laptop. dispatch-requeue-race.test.ts forces
        // that exact window deterministically.
        if (after && (after.status === "succeeded" || after.status === "failed"))
          settled.add(e.runId)
      }
      e.alive = false
      e.claimed = false
    }

    /** An executor dies holding its run — the case the reclaim sweep exists for. */
    const opCrash = async () => {
      const alive = executors.filter((e) => e.alive)
      if (!alive.length) return
      const e = pick(alive)
      e.alive = false
      e.claimed = false
    }

    /** Somebody clicks Run now, adding work mid-flight. */
    const opRunNow = async () => {
      await app.request(`/v1/automations/${pick(autoIds)}/run`, {
        method: "POST",
        headers: as(owner.email),
      })
    }

    const OPS = [opTick, opPollingClaim, opClaim, opClaim, opFinish, opCrash, opRunNow]

    for (let step = 0; step < steps; step += 1) {
      // One to three operations AT ONCE. This is what explores the interleavings a
      // hand-written test cannot: the scheduler decides who resumes at each await.
      const n = 1 + Math.floor(rand() * 3)
      await Promise.all(Array.from({ length: n }, () => pick(OPS)()))

      // Time moves in jumps, because the intervals that matter are minutes apart: a lease is
      // 25 minutes and a token 20, so a real-time simulation would never reach either.
      if (rand() < 0.6) {
        nowMs += pick([1_000, 30_000, 5 * 60_000, RUN_TOKEN_TTL_MS + 1_000, RUN_LEASE_MS + 60_000])
      }

      await checkInvariants(orgId, mine, executors, seenAttempts, settled, nowMs)
    }

    // LIVENESS. Stop new work first — the schedule automation is `* * * * *`, so every clock
    // jump legitimately materializes another occurrence and the queue would never drain. That
    // is correct behaviour, not a bug, so the property to test is the one that matters: given
    // no NEW work, does everything already in flight reach a terminal state?
    for (const id of autoIds) {
      await app.request(`/v1/automations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...as(owner.email) },
        body: JSON.stringify({ enabled: false }),
      })
    }

    // Now drain: dispatch, let each booted executor claim, and settle it. Bounded — if this
    // cannot empty the queue, something is genuinely stuck.
    for (let i = 0; i < 60; i += 1) {
      nowMs += RUN_LEASE_MS + 60_000
      await dispatchPass(deps())
      for (const e of executors.filter((x) => x.alive)) {
        const r = await meta.getRun(e.runId)
        if (!r) {
          e.alive = false
          continue
        }
        if (r.status === "queued") await meta.claimRunById(e.runId, r.agent_id, now().toISOString())
        const after = await meta.getRun(e.runId)
        if (after?.status === "running") {
          // Record settlement from what the WRITE returned, not from having asked for it:
          // finishRun is status-guarded, so it answers null when the run moved underneath
          // this read, and assuming success there marks an unsettled run as settled.
          const done = await meta.finishRun(e.runId, r.agent_id, {
            status: "succeeded",
            finishedAt: now().toISOString(),
          })
          if (done && (done.status === "succeeded" || done.status === "failed"))
            settled.add(e.runId)
        }
        e.alive = false
        e.claimed = false
      }
      // A WIDER window than the per-step checks use. listRuns is `order by created_at desc
      // limit N`, and twelve seeds share this store: measured, 1424 of 2400 per-step checks were
      // already reading a truncated 500. Truncation only weakens a per-step assertion, but here
      // it would decide "everything drained" while this seed still had runs in flight outside
      // the window — a false PASS on the one property this loop exists to establish.
      const left = (await meta.listRuns(orgId, LIVENESS_WINDOW)).filter(
        (r) => mine(r) && (r.status === "queued" || r.status === "running"),
      )
      if (left.length === 0) break
    }

    const stuck = (await meta.listRuns(orgId, LIVENESS_WINDOW)).filter(
      (r) => mine(r) && (r.status === "queued" || r.status === "running"),
    )
    expect(
      stuck.map((r) => `${r.id}:${r.status}`),
      "runs never reached a terminal state",
    ).toEqual([])
  }

  // A spread of seeds. Each explores a different interleaving; a failure names its seed so the
  // exact history can be replayed by running that one alone.
  // Twelve seeds, not forty. The bug this found (the finish route replacing run.meta) turned up
  // on the first handful, and forty cost 28s of every CI run for exploration that was mostly
  // re-treading the same shapes. If a regression ever slips through, widen this and re-run —
  // seeds are reproducible, so a wider search is a one-line change, not an investigation.
  // SLOW UNDER `test:pg`, and legitimately so: each seed drives 200 steps, and a step that is
  // a local write on SQLite is a network round trip against a real Postgres. Twelve seeds of
  // that overruns vitest's default per-test budget and shows up as a timeout rather than a
  // failure — which reads exactly like a flake and is not one. Hence the explicit timeout
  // below, sized for the pg lane rather than the sqlite one.
  //
  // (An earlier "resurrected" invariant failure here WAS real and is fixed on main by
  // a6cb8c25 — duplicate cron runs. Do not re-silence that invariant if it returns: a settled
  // run going back to `running` means a finished automation republishes.)
  const SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i * 7)
  it.each(SEEDS)("holds every invariant under interleaving (seed %i)", async (seed) => {
    await simulate(seed, 200)
  }, 60_000)
})

/**
 * The reclaim race, as an EXPLICIT interleaving rather than a hope.
 *
 * The simulation above cannot reliably reach this: it needs two sweeps to have both SELECTed
 * the same stale run, a claim to land between their UPDATEs, and all three to concern the same
 * row. Uniform exploration hits that coincidence rarely enough to be useless as a regression
 * gate, and biasing the sim toward it turned out to be the same thing as writing this test
 * while pretending otherwise. So: written down, deliberately.
 *
 * The alignment is the subtle part. `reclaimStaleRuns` awaits its SELECT, then awaits each
 * UPDATE — two microtask ticks. A claim therefore lands in the window only if it also has
 * exactly one await before its own write. Promise.all resolution order is start order, so
 * [sweepA, claim, sweepB] gives: A.select, claim.read, B.select │ A.update, claim.write,
 * B.update — and B's update is the steal.
 */
describe("reclaim is fenced against a run re-claimed mid-sweep", () => {
  it("does not requeue a run that was claimed between a sweep's read and its write", async () => {
    const res = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), { trigger: { kind: "manual" }, instruction: "fence regression" }),
    )
    const auto = (await res.json()) as { id: string }
    const created = await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const run = (await created.json()) as { id: string }
    const row = await meta.getRun(run.id)
    if (!row) throw new Error("expected the run")

    // Claimed long ago and never finished: exactly what the sweep is meant to reclaim.
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    await meta.claimRunById(run.id, row.agent_id, longAgo)
    const cutoff = new Date(Date.now() - RUN_LEASE_MS).toISOString()

    // The replacement executor, claiming in the window between the two sweeps' writes. One
    // await before the claim, matching the sweep's SELECT, so the writes align as described.
    let reclaimedByReplacement = false
    const replacementClaims = async () => {
      await meta.getRun(run.id)
      const got = await meta.claimRunById(run.id, row.agent_id, new Date().toISOString())
      reclaimedByReplacement = !!got
    }

    await Promise.all([
      meta.reclaimStaleRuns(cutoff, RUN_MAX_ATTEMPTS),
      replacementClaims(),
      meta.reclaimStaleRuns(cutoff, RUN_MAX_ATTEMPTS),
    ])

    // The first sweep legitimately requeues the dead executor's run, and the replacement claims
    // it. The SECOND sweep must not then take it back: that run is now held by a live executor
    // with a fresh token, and requeueing it is what puts two of them on the same artifact.
    const after = await meta.getRun(run.id)
    if (reclaimedByReplacement) {
      expect(
        after?.status,
        "a second sweep requeued a run that had just been re-claimed — two live executors",
      ).toBe("running")
    }
  })
})
