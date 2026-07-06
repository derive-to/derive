/**
 * Preview render worker — runtime-neutral (no node:* imports).
 *
 * Mirrors the webhook outbox in webhooks.ts: module-level constants, a
 * runRenderTick that claims + processes jobs sequentially, and a
 * startPreviewWorker that drives it on an interval with a poke for immediate
 * dispatch. Both Node (node.ts) and the Cloudflare Worker DO import this file,
 * so it must run on both runtimes without modification.
 */
import type { BlobStore, MetaStore } from "@derive/core"
import { signPreviewToken } from "./lib/preview-token"
import { log } from "./log"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OG_W = 1200
export const OG_H = 630

/** Maximum delivery attempts before the job is dead-lettered. */
export const MAX_ATTEMPTS = 4

/** Base backoff duration for failed render attempts (ms). */
export const BASE_BACKOFF_MS = 5_000

/** Cap on exponential backoff (30 minutes). */
export const MAX_BACKOFF_MS = 30 * 60_000

/**
 * A claimed render job is leased this long (ms): hidden from other workers
 * until the job finishes or the lease lapses (crash recovery). Must exceed
 * RENDER_TIMEOUT_MS so a job in flight is never re-claimed.
 */
export const CLAIM_LEASE_MS = 120_000

/** Maximum time to wait for a single screenshot (ms). */
export const RENDER_TIMEOUT_MS = 20_000

/** Maximum jobs to claim per tick (concurrency budget: jobs are sequential). */
export const RENDER_CLAIM_LIMIT = 3

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ScreenshotOpts {
  width: number
  height: number
  fullPage?: boolean
  timeoutMs: number
}

export interface Renderer {
  screenshot(url: string, opts: ScreenshotOpts): Promise<Uint8Array>
}

export interface RenderTickDeps {
  meta: MetaStore
  blobs: BlobStore
  renderer: Renderer
  baseUrl: string
  sandboxOrigin?: string
  secret: string
}

export interface PreviewWorker {
  stop(): void
  poke(): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const backoff = (attempts: number): number =>
  Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts)

/**
 * Race a promise against a timeout. Rejects with a TimeoutError when the
 * timeout fires first. This keeps a hung browser from wedging the render loop.
 */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`render timed out after ${ms}ms`)), ms),
    ),
  ])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a render job for artifact `artifactId` at version `n`.
 * Uses crypto.randomUUID() — available on Node 19+ and Cloudflare Workers
 * without any import.
 */
export const enqueueRender = async (
  meta: MetaStore,
  artifactId: string,
  n: number,
): Promise<void> => {
  await meta.enqueueRenderJob({
    id: `rj_${crypto.randomUUID().slice(0, 12)}`,
    artifact_id: artifactId,
    version_n: n,
  })
}

/**
 * One render pass: atomically claim due jobs, then process each SEQUENTIALLY
 * (one browser at a time). Returns the number of jobs claimed this pass.
 *
 * On success: stores the PNG blob, marks the version ready, marks the job done.
 * On failure: marks the version failed with a short error, then either retries
 * with exponential backoff or dead-letters after MAX_ATTEMPTS.
 */
export const runRenderTick = async (
  deps: RenderTickDeps,
  limit = RENDER_CLAIM_LIMIT,
): Promise<number> => {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()
  const due = await deps.meta.claimDueRenderJobs(now.toISOString(), limit, leaseUntil)

  for (const job of due) {
    // Load artifact + version to check staleness
    const artifact = await deps.meta.getArtifactById(job.artifact_id)

    // Skip if the artifact is gone or this version has been superseded
    if (
      artifact === null ||
      artifact.removed_at !== null ||
      job.version_n !== artifact.current_version
    ) {
      await deps.meta.updateRenderJob(job.id, {
        status: "done",
        attempts: job.attempts,
        last_error: null,
        next_attempt_at: job.next_attempt_at,
      })
      continue
    }

    try {
      // Mint a short-lived preview token so the renderer can load even private artifacts
      const pv = await signPreviewToken(
        deps.secret,
        artifact.id,
        job.version_n,
        Date.now() + CLAIM_LEASE_MS,
      )

      const origin = deps.sandboxOrigin ?? deps.baseUrl
      const url = `${origin}/raw/${artifact.short_id}/v/${job.version_n}/index.html?pv=${pv}`

      // Screenshot with a timeout guard so a hung browser can't wedge the loop
      const png = await withTimeout(
        deps.renderer.screenshot(url, { width: OG_W, height: OG_H, timeoutMs: RENDER_TIMEOUT_MS }),
        RENDER_TIMEOUT_MS + 1_000,
      )

      const key = await deps.blobs.put(png)

      await deps.meta.setVersionPreview(artifact.id, job.version_n, {
        preview_key: key,
        preview_status: "ready",
        preview_error: null,
      })
      await deps.meta.updateRenderJob(job.id, {
        status: "done",
        attempts: job.attempts,
        last_error: null,
        next_attempt_at: job.next_attempt_at,
      })
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200)

      await deps.meta.setVersionPreview(artifact.id, job.version_n, {
        preview_status: "failed",
        preview_error: msg,
      })

      if (job.attempts >= MAX_ATTEMPTS) {
        await deps.meta.updateRenderJob(job.id, {
          status: "dead",
          attempts: job.attempts,
          last_error: msg,
          next_attempt_at: job.next_attempt_at,
        })
      } else {
        const next = new Date(Date.now() + backoff(job.attempts)).toISOString()
        await deps.meta.updateRenderJob(job.id, {
          status: "pending",
          attempts: job.attempts,
          last_error: msg,
          next_attempt_at: next,
        })
      }
    }
  }

  return due.length
}

/**
 * Node/self-host render worker: an in-process interval that runs a render tick,
 * plus a `poke` that drains on demand (called right after a version is published).
 * The `running` flag coalesces concurrent triggers into one in-flight drain —
 * the leased claim already makes overlap safe, this just avoids redundant passes.
 * This is the self-host counterpart to the edge Render DO; both share the same
 * runRenderTick core so rendering behaves identically on both runtimes.
 */
export const startPreviewWorker = (deps: RenderTickDeps, intervalMs = 1500): PreviewWorker => {
  let stopped = false
  let running = false
  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      await runRenderTick(deps)
    } catch (err) {
      // A bad tick must not kill the loop, but it must not vanish either —
      // otherwise a persistently-failing render queue is invisible.
      log.error("preview render tick failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    poke: () => void tick(),
  }
}
