import type { MetaStore, RunRecord } from "@derive/core"
import { log } from "../log"
import { overBudget } from "./budget"
import { RUN_LEASE_MS, RUN_MAX_ATTEMPTS, RUN_TOKEN_TTL_MS } from "./run-lifecycle"
import { signRunToken } from "./run-token"
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
}

/** Mint the capability token for a run and hand it to the substrate. */
const startOne = async (deps: DispatchDeps, r: RunRecord, expMs: number): Promise<void> => {
  const token = await signRunToken(deps.secret, r.id, r.agent_id, r.org_id, expMs)
  await deps.substrate.start({ runId: r.id, token, server: deps.server })
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
  if (due.length === 0) return out

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

  const expMs = now.getTime() + RUN_TOKEN_TTL_MS
  for (const r of due) {
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
      await startOne(deps, r, expMs)
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
  if (out.started > 0 || out.materialized > 0 || out.requeued > 0 || out.deferred > 0)
    log.info("hosted dispatch", { ...out, substrate: deps.substrate.name })
  return out
}

/** How many of a workspace's runs are currently executing (claimed and not yet finished, within
 *  the lease — anything older is a corpse the reclaim sweep owns, not live work). */
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
    if (!r || r.status !== "queued") return false
    const now = deps.now?.() ?? new Date()
    await startOne(deps, r, now.getTime() + RUN_TOKEN_TTL_MS)
    return true
  } catch (e) {
    log.warn("hosted dispatch: nudge failed (the tick will retry)", {
      run: runId,
      error: (e as Error).message,
    })
    return false
  }
}
