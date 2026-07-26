import type { MetaStore, RunRecord } from "@derive/core"
import { log } from "../log"
import { overBudget } from "./budget"
import { RUN_LEASE_MS, RUN_MAX_ATTEMPTS, RUN_TOKEN_TTL_MS } from "./run-lifecycle"
import { signWorkToken } from "./run-token"
import { materializeAllDueRuns } from "./schedule"

// HOSTED DISPATCH — the tick that makes an automation run with no machine on.
//
// One pass does three things, in order, all idempotent:
//   1. MATERIALIZE — due cron automations become queued runs (deduped per cron window).
//   2. RECLAIM     — runs whose substrate died return to queued (lost past the attempt cap).
//   3. DISPATCH    — each due queued run gets a per-run capability token and is handed to the
//                    SUBSTRATE, which boots an executor for exactly that run.
//
// Everything here is platform-agnostic on purpose: the only thing that differs between
// derive.to (a Cloudflare Container), a Node self-host (a child process), and a test (a fake)
// is the Substrate implementation. That keeps the *correctness* of hosted execution testable
// with no container, no wrangler, and no network.
//
// Dispatch NEVER claims. It only mints a token and boots; the executor claims (queued→running,
// status-guarded), so a double-dispatch is harmless: the second booter loses the race, finds
// nothing to do, and exits. That is the whole concurrency story.

/** Where one run executes. `run` returns once the executor has been STARTED (not finished) —
 *  the run reports its own outcome through the API, so dispatch never waits on the work. */
export interface Substrate {
  /** Short name for logs ("node-child", "cf-container", "fake"). */
  readonly name: string
  start(input: {
    /** The run to execute. */
    runId: string
    /** Its per-run capability token — the executor's only credential. */
    token: string
    /** The API base URL the executor calls back on. */
    server: string
  }): Promise<void>
}

export interface DispatchDeps {
  meta: MetaStore
  substrate: Substrate
  /** The API base URL handed to each executor. */
  server: string
  /** DERIVE_AUTH_SECRET / encryptionKey — signs the capability tokens. */
  secret: string
  /** Max runs started per pass (the global burst valve). Default 10. */
  limit?: number
  /** Max runs one WORKSPACE may have in flight at once — fairness and cost containment, so a
   *  single workspace's burst can't consume the whole deployment's capacity. Default 3. */
  perOrgLimit?: number
  /** A run `running` longer than this is presumed dead and requeued. Defaults to the lifecycle
   *  clock's lease, which is deliberately longer than a token's TTL (see run-lifecycle.ts). */
  leaseMs?: number
  now?: () => Date
}

export interface DispatchResult {
  materialized: number
  requeued: number
  lost: number
  started: number
  failed: number
  /** Runs left queued this pass because their workspace was at its in-flight cap or over its
   *  monthly model budget. Not failures — they are simply picked up by a later tick. */
  deferred: number
  /** Sessions (somebody ASKED a context) dispatched this pass. Same executor, same substrate —
   *  an ask and a schedule are both (context, instruction), so both run with no machine on. */
  sessionsStarted: number
}

/** Mint the capability token for a work item and hand it to the substrate. Runs and sessions
 *  differ only in the token's kind and the id the executor is told to serve — the substrate
 *  boots the same image either way, which is the whole point of unifying the two lanes. */
const startOne = async (
  deps: DispatchDeps,
  kind: "run" | "session",
  item: { id: string; agentId: string; orgId: string },
  expMs: number,
): Promise<void> => {
  const token = await signWorkToken(kind, deps.secret, item.id, item.agentId, item.orgId, expMs)
  await deps.substrate.start({ runId: item.id, token, server: deps.server })
}

/**
 * Run one hosted-dispatch pass. Safe to call on a cron, on a poke, and concurrently with
 * itself: every step is idempotent and the executor's claim is the single source of exclusion.
 * Never throws — a pass that partially fails reports counts and the next tick retries, because
 * a scheduler that dies on one bad run is worse than one that limps.
 */
export const dispatchPass = async (deps: DispatchDeps): Promise<DispatchResult> => {
  const now = deps.now?.() ?? new Date()
  const out: DispatchResult = {
    materialized: 0,
    requeued: 0,
    lost: 0,
    started: 0,
    failed: 0,
    deferred: 0,
    sessionsStarted: 0,
  }

  // 1. Materialize due schedules.
  try {
    out.materialized = await materializeAllDueRuns(deps.meta, now)
  } catch (e) {
    log.warn("hosted dispatch: materialize failed", { error: (e as Error).message })
  }

  // 2. Reclaim runs whose executor died. Needed regardless of substrate: a container can be
  //    evicted, a child process killed. This is what makes at-least-once real. The lease is
  //    deliberately longer than a token's TTL, so the dead executor is already powerless
  //    before a replacement is dispatched (run-lifecycle.ts).
  try {
    const lease = new Date(now.getTime() - (deps.leaseMs ?? RUN_LEASE_MS)).toISOString()
    const swept = await deps.meta.reclaimStaleRuns(lease, RUN_MAX_ATTEMPTS)
    out.requeued = swept.requeued
    out.lost = swept.failed
  } catch (e) {
    log.warn("hosted dispatch: reclaim failed", { error: (e as Error).message })
  }

  // 3. Dispatch due queued runs. Sequential on purpose: the limit is the burst valve, and a
  //    substrate that throttles (container concurrency) should push back here, not queue up.
  let due: RunRecord[] = []
  try {
    due = await deps.meta.listDueQueuedRuns(now.toISOString(), deps.limit ?? 10)
  } catch (e) {
    log.warn("hosted dispatch: due scan failed", { error: (e as Error).message })
    return out
  }
  // NOT an early return: the ask lane must still be swept when no RUN is due — a quiet
  // automation queue is the common case for a workspace that mostly asks questions, and
  // skipping sessions there would mean asks only ever ran when a schedule happened to fire.
  if (due.length === 0) {
    out.sessionsStarted = await dispatchSessions(
      deps,
      now,
      now.getTime() + RUN_TOKEN_TTL_MS,
      new Map(),
    )
    if (out.sessionsStarted > 0 || out.materialized > 0 || out.requeued > 0)
      log.info("hosted dispatch", { ...out, substrate: deps.substrate.name })
    return out
  }

  // In-flight per workspace, counted ONCE for this pass and incremented as we start. Cost and
  // fairness: one workspace's burst must not consume the deployment's whole capacity, and a
  // runaway automation must not fan out unbounded model spend.
  const perOrg = deps.perOrgLimit ?? 3
  const inFlight = new Map<string, number>()
  for (const orgId of new Set(due.map((r) => r.org_id))) {
    inFlight.set(orgId, await countInFlight(deps.meta, orgId, now))
  }
  // Budget is per workspace too, so resolve it once per org rather than per run.
  const budgetBlocked = new Map<string, boolean>()
  // The workspace's MASTER SWITCH for hosted execution. An operator who turns hosted agents
  // off expects every hosted run to stop — that promise has to be kept where runs actually
  // start, which is here. Also the emergency stop: flip it off and the next tick dispatches
  // nothing for that workspace, without touching config or redeploying.
  const hostedOff = new Map<string, boolean>()

  const expMs = now.getTime() + RUN_TOKEN_TTL_MS
  for (const r of due) {
    if (!hostedOff.has(r.org_id))
      hostedOff.set(
        r.org_id,
        !(await deps.meta
          .getOrgSettings(r.org_id)
          .then((s) => s.hostedAgentsEnabled)
          // Fail CLOSED. This used to resolve `true` (hosted enabled) on a settings read
          // error, which meant a database blip could start hosted runs in a workspace that
          // had deliberately switched them off. An emergency stop that an error can defeat
          // is not an emergency stop. Deferring costs a tick; the alternative costs money
          // and writes to someone's documents.
          .catch(() => false)),
      )
    if (hostedOff.get(r.org_id)) {
      // Left queued, not failed: turning the switch back on resumes the work rather than
      // requiring anyone to recreate it.
      out.deferred += 1
      continue
    }
    if ((inFlight.get(r.org_id) ?? 0) >= perOrg) {
      out.deferred += 1
      continue
    }
    // The monthly model budget, enforced at DISPATCH — not only at enqueue. A schedule creates
    // runs with no human in the loop, so without this a cron automation would spend past the
    // owner's cap forever. Over budget = leave it queued (a later month, or a raised cap,
    // releases it) rather than fail it, because the work itself is still wanted.
    if (!budgetBlocked.has(r.org_id))
      budgetBlocked.set(
        r.org_id,
        await overBudget(deps.meta, r.org_id, r.initiated_by ?? null).catch(() => false),
      )
    if (budgetBlocked.get(r.org_id)) {
      out.deferred += 1
      continue
    }
    try {
      await startOne(deps, "run", { id: r.id, agentId: r.agent_id, orgId: r.org_id }, expMs)
      out.started += 1
      inFlight.set(r.org_id, (inFlight.get(r.org_id) ?? 0) + 1)
    } catch (e) {
      // The run stays queued: the next tick retries it. Nothing is lost by a failed boot.
      out.failed += 1
      log.warn("hosted dispatch: substrate start failed", {
        run: r.id,
        substrate: deps.substrate.name,
        error: (e as Error).message,
      })
    }
  }
  // 4. The ASK lane. A session is somebody asking a context — the same (context, instruction)
  //    call a schedule makes, so it earns the same hosted executor rather than needing a
  //    machine someone keeps on. Reuses everything above: same substrate, same master switch,
  //    same expiry. The session's own lease (not the run lease) is its concurrency guard, and
  //    like runs, dispatch never claims — the booted executor does.
  out.sessionsStarted = await dispatchSessions(deps, now, expMs, hostedOff)

  if (
    out.started > 0 ||
    out.materialized > 0 ||
    out.requeued > 0 ||
    out.deferred > 0 ||
    out.sessionsStarted > 0
  )
    log.info("hosted dispatch", { ...out, substrate: deps.substrate.name })
  return out
}

/** Boot an executor for each session awaiting one. Best-effort per session and never throws:
 *  the ask lane must not be able to break the run lane's tick. */
const dispatchSessions = async (
  deps: DispatchDeps,
  now: Date,
  expMs: number,
  hostedOff: Map<string, boolean>,
): Promise<number> => {
  let started = 0
  // The ask lane spends the same money and writes the same artifacts as the run lane, so it
  // gets the same ceilings. It previously checked only the kill switch: no budget, no per-org
  // cap, and no regard for the context's own max_concurrency — which the polling queue does
  // enforce, and which the hosted claim endpoint refuses standing bearers precisely to
  // protect. Ten open sessions on a max_concurrency=1 context booted ten executors.
  const inFlight = new Map<string, number>()
  const budgetBlocked = new Map<string, boolean>()
  const perOrg = deps.perOrgLimit ?? 3
  const perContext = new Map<string, number>()
  try {
    const due = await deps.meta.listDueOpenSessions(now.toISOString(), deps.limit ?? 10)
    for (const s of due) {
      if (!hostedOff.has(s.org_id))
        hostedOff.set(
          s.org_id,
          !(await deps.meta
            .getOrgSettings(s.org_id)
            .then((x) => x.hostedAgentsEnabled)
            // Fail CLOSED: a settings read that throws must not be a way to run hosted work
            // in a workspace that may have switched it off. The kill switch is only a kill
            // switch if an error can't defeat it.
            .catch(() => false)),
        )
      if (hostedOff.get(s.org_id)) continue
      // A session's acting agent lives on its CONTEXT (sessions carry no agent column).
      const cx = await deps.meta.getContext(s.context_id)
      if (!cx) continue

      if (!budgetBlocked.has(s.org_id))
        budgetBlocked.set(s.org_id, await overBudget(deps.meta, s.org_id, s.asker_id ?? null))
      if (budgetBlocked.get(s.org_id)) continue

      if (!inFlight.has(s.org_id))
        inFlight.set(s.org_id, await countInFlight(deps.meta, s.org_id, now))
      if ((inFlight.get(s.org_id) ?? 0) >= perOrg) continue

      // The context's OWN concurrency ceiling, the same one the polling queue applies.
      const cap = Math.max(1, cx.max_concurrency ?? 1)
      const usedHere = perContext.get(cx.id) ?? 0
      if (usedHere >= cap) continue

      try {
        await startOne(deps, "session", { id: s.id, agentId: cx.agent_id, orgId: s.org_id }, expMs)
        started += 1
        inFlight.set(s.org_id, (inFlight.get(s.org_id) ?? 0) + 1)
        perContext.set(cx.id, usedHere + 1)
      } catch (e) {
        log.warn("hosted dispatch: session start failed", {
          session: s.id,
          error: (e as Error).message,
        })
      }
    }
  } catch (e) {
    log.warn("hosted dispatch: session scan failed", { error: (e as Error).message })
  }
  return started
}

/** How many of a workspace's runs are currently executing (claimed and not yet finished, within
 *  the lease — anything older is a corpse the reclaim sweep owns, not live work).
 *
 *  Approximate by construction: it counts within the workspace's 100 most recent runs, so a
 *  workspace that creates more than 100 runs between a claim and its finish could under-count
 *  and briefly exceed the cap. That is the safe direction for a FAIRNESS control (it never
 *  wrongly starves a workspace), the budget guard is the real spend ceiling, and a dedicated
 *  COUNT query is the fix if this ever matters at volume — deliberately not added yet, since
 *  every store method has to be written and kept in parity twice. */
const countInFlight = async (meta: MetaStore, orgId: string, now: Date): Promise<number> => {
  const since = new Date(now.getTime() - RUN_LEASE_MS).toISOString()
  const recent = await meta.listRuns(orgId, 100).catch(() => [])
  return recent.filter((r) => r.status === "running" && (r.started_at ?? "") >= since).length
}

/**
 * Dispatch ONE known run immediately — the low-latency nudge on run creation ("Run now", a
 * fire-URL), so an interactive run starts in seconds instead of waiting for the next tick.
 * Best-effort by design: if this fails the run simply stays queued and the tick picks it up,
 * which is exactly why the tick exists. Never throws.
 */
export const dispatchRunNow = async (deps: DispatchDeps, runId: string): Promise<boolean> => {
  try {
    const r = await deps.meta.getRun(runId)
    if (r?.status !== "queued") return false
    // The master switch applies to the fast path too, or "Run now" would bypass the one
    // control an operator reaches for to stop everything. Fail CLOSED on a settings error —
    // the tick will pick the run up if the read was a blip, so refusing costs a minute while
    // proceeding could spend money a workspace had switched off.
    const settings = await deps.meta.getOrgSettings(r.org_id).catch(() => null)
    if (!settings || !settings.hostedAgentsEnabled) return false
    const now = deps.now?.() ?? new Date()
    // The SAME ceilings the tick applies. Without these the nudge was an unbounded spend
    // path: it is wired to every run creation (Run now, and every webhook fire), so a caller
    // firing every few seconds booted an executor per fire — past the per-org cap and past
    // the monthly budget, because the only checks that saw them were on the tick path this
    // one skips. Coalescing does not bound it either, since findCoalescibleRun only matches
    // runs that are still queued. Refusing here is not a loss: the run stays queued and the
    // tick dispatches it when there is room.
    if (await overBudget(deps.meta, r.org_id, r.initiated_by)) return false
    if ((await countInFlight(deps.meta, r.org_id, now)) >= (deps.perOrgLimit ?? 3)) return false
    await startOne(
      deps,
      "run",
      { id: r.id, agentId: r.agent_id, orgId: r.org_id },
      now.getTime() + RUN_TOKEN_TTL_MS,
    )
    return true
  } catch (e) {
    log.warn("hosted dispatch: nudge failed (the tick will retry)", {
      run: runId,
      error: (e as Error).message,
    })
    return false
  }
}
