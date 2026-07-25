import type { MetaStore, RunRecord } from "@derive/core"
import { log } from "../log"
import { RUN_TOKEN_TTL_MS, signRunToken } from "./run-token"
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
  /** Max runs started per pass (the burst valve). Default 10. */
  limit?: number
  /** A run `running` longer than this is presumed dead and requeued. Default 30 minutes. */
  leaseMs?: number
  now?: () => Date
}

export interface DispatchResult {
  materialized: number
  requeued: number
  lost: number
  started: number
  failed: number
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
  const out: DispatchResult = { materialized: 0, requeued: 0, lost: 0, started: 0, failed: 0 }

  // 1. Materialize due schedules.
  try {
    out.materialized = await materializeAllDueRuns(deps.meta, now)
  } catch (e) {
    log.warn("hosted dispatch: materialize failed", { error: (e as Error).message })
  }

  // 2. Reclaim runs whose executor died. Needed regardless of substrate: a container can be
  //    evicted, a child process killed. This is what makes at-least-once real.
  try {
    const lease = new Date(now.getTime() - (deps.leaseMs ?? 30 * 60_000)).toISOString()
    const swept = await deps.meta.reclaimStaleRuns(lease)
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
  const expMs = now.getTime() + RUN_TOKEN_TTL_MS
  for (const r of due) {
    try {
      await startOne(deps, r, expMs)
      out.started += 1
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
  if (out.started > 0 || out.materialized > 0 || out.requeued > 0)
    log.info("hosted dispatch", { ...out, substrate: deps.substrate.name })
  return out
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
