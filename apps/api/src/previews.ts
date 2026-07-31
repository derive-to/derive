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

/** Maximum missing-preview versions the self-heal sweep enqueues per tick. */
export const SWEEP_LIMIT = 50

/** The agent-facing full-page variants render at HALF density. A fullPage shot of a long
 *  document ran past what MCP can return at all, leaving "open the url yourself" as the
 *  only answer to "did my page come out right?" — which a human can act on and an agent
 *  cannot. Measured on an 80-paragraph page: 489KB at full density, 106KB at half, a 78%
 *  cut. Re-encoding as JPEG instead was tried first and measured 15%, and at half density
 *  JPEG is actually LARGER than PNG (135KB vs 106KB) because it handles sharp text edges
 *  badly. So the lever is pixel count, not encoding, and these stay PNG. The 1200x630 OG
 *  crop keeps full density: it is the og:image other sites unfurl. */
export const FULL_PAGE_SCALE = 0.5

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ScreenshotOpts {
  width: number
  height: number
  fullPage?: boolean
  timeoutMs: number
  /** Device pixel density. Defaults to 1. Below 1 the same page renders to proportionally
   *  fewer pixels, which is what actually bounds a full-page shot — see FULL_PAGE_SCALE. */
  deviceScaleFactor?: number
}

export interface Renderer {
  screenshot(url: string, opts: ScreenshotOpts): Promise<Uint8Array>
}

/**
 * Refuse to screenshot an error page.
 *
 * A browser navigating to a 404 renders the 404 and the screenshot SUCCEEDS, so without
 * this the job stores a picture of the words "not found" and marks itself `ready`. That is
 * the worst possible outcome: the artifact's card is permanently wrong, nothing retries
 * (the render did not fail), the dead-render self-heal never fires (a render exists), and
 * the only cure is republishing, which nobody thinks to do. Seen twice in one afternoon on
 * two different artifacts, both times a 4.5KB image where a real one is 70-110KB.
 *
 * Throwing instead routes it into the caller's existing failure path: status `failed`, a
 * real error string, the retry/backoff, and the self-heal. It also makes the cause
 * DIAGNOSABLE, which it currently is not — three separate paths in the raw routes return
 * the identical bare "not found" (an unverifiable preview token falling through to
 * anonymous authorization, a claim/artifact mismatch, and a version row that reads back
 * missing), and a screenshot of the result cannot tell them apart. The status code in the
 * error is the first evidence anyone will have about which.
 *
 * `null` is not an error: a same-document navigation legitimately yields no response.
 *
 * The URL carries a short-lived `pv` capability token, and this message reaches both the
 * log and a stored DB column, so the token is redacted rather than persisted.
 */
export const assertNavigationOk = (res: { status(): number } | null, url: string): void => {
  const status = res?.status()
  if (status === undefined || status < 400) return
  throw new Error(
    `navigation returned HTTP ${status}; refusing to screenshot an error page (${url.replace(/\/pv\/[^/]+\//, "/pv/<redacted>/")})`,
  )
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
  /**
   * Drain now. Returns the in-flight tick so a caller that needs the drain to have
   * *finished* can await it — production wiring ignores it (`pokePreviews` is typed
   * `() => void`, and `Promise<void>` is assignable to that), but a test awaiting a
   * real completion signal is the difference between deterministic and timing-based.
   * Resolves immediately when a tick is already running: the `running` flag coalesces,
   * so this promises "no drain is owed", not "a fresh drain ran".
   */
  poke(): Promise<void>
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
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`render timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

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
/**
 * Self-heal sweep: enqueue a render job for every live artifact whose current
 * version was never rendered (it predates the pipeline, or its publish path
 * missed the enqueue) and has no pending job. Versions that rendered and FAILED
 * keep their own job's retry/dead-letter state — the sweep never resurrects
 * them, so it converges instead of hammering a broken render. Runs ahead of the
 * claim in both workers (the Node interval and the edge DO alarm), so a swept
 * version renders on the same tick that found it. Returns the number enqueued.
 */
export const sweepMissingRenders = async (
  meta: MetaStore,
  limit = SWEEP_LIMIT,
): Promise<number> => {
  const missing = await meta.versionsMissingPreview(limit)
  for (const m of missing) await enqueueRender(meta, m.artifact_id, m.n)
  return missing.length
}

/**
 * Render one agent-facing preview variant (full-page or marked) and record the
 * result on ITS OWN status/error columns via `setVersionPreviewVariant` — never
 * throws, so a failure here can't fail the OG render or the job it rides on. That
 * contract covers the FAILURE-recording write too: if the store itself rejects the
 * "failed" write (a transient DB error, a raced-out artifact), the inner catch
 * swallows it rather than letting it propagate into the caller's try block, where
 * it would otherwise be mistaken for the OG render itself failing — overwriting an
 * already-successful, already-stored OG image back to "failed" and requeuing the
 * whole job for a needless retry. Logged, not silent: a status write that can't
 * even record its own failure is worth knowing about, just not worth escalating.
 */
const renderPreviewVariant = async (
  deps: RenderTickDeps,
  artifactId: string,
  n: number,
  variant: "full" | "marked",
  url: string,
  opts: ScreenshotOpts,
): Promise<void> => {
  try {
    const png = await withTimeout(deps.renderer.screenshot(url, opts), opts.timeoutMs + 1_000)
    const key = await deps.blobs.put(png)
    await deps.meta.setVersionPreviewVariant(artifactId, n, variant, {
      key,
      status: "ready",
      error: null,
    })
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200)
    try {
      await deps.meta.setVersionPreviewVariant(artifactId, n, variant, {
        status: "failed",
        error: msg,
      })
    } catch (writeErr) {
      log.error(`preview ${variant} render: failed AND couldn't record the failure`, {
        artifactId,
        n,
        variant,
        renderError: msg,
        writeError: writeErr instanceof Error ? writeErr.message : String(writeErr),
      })
    }
  }
}

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

      // The token rides as a path segment (not `?pv=`) so a bundle's relative asset
      // references inherit it — see the `/pv/:pv/` route in routes/raw.ts.
      const origin = deps.sandboxOrigin ?? deps.baseUrl
      const url = `${origin}/raw/${artifact.short_id}/v/${job.version_n}/pv/${pv}/index.html`

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

      // Mark the job done immediately after the OG write, BEFORE attempting the two
      // variant renders below — not after. The job's one hard deliverable is the OG
      // image; the variants are additive best-effort extras that already can't fail
      // the job (renderPreviewVariant never throws). Writing "done" here, close to
      // the OG write, keeps the window where a late failure could wrongly stomp an
      // already-successful OG status back to "failed" (and trigger a full re-render
      // of OG+full+marked on retry) near-zero, instead of spanning the ~40s the two
      // variant screenshots below can take.
      await deps.meta.updateRenderJob(job.id, {
        status: "done",
        attempts: job.attempts,
        last_error: null,
        next_attempt_at: job.next_attempt_at,
      })

      // The two agent-facing render variants: the whole page (fullPage:true, catches
      // below-the-fold breakage the 1200x630 OG crop above can't) and the same
      // full-page render with the region map's @N refs drawn on it (?marks=1, see
      // marks-script.ts). Best-effort and INDEPENDENT of the OG image, of each other,
      // and (per the reordering above) of this job's own completion — a failure here
      // never fails this job and is never retried via the job queue; a stale variant
      // just gets a fresh attempt on the next publish. Run SEQUENTIALLY, not in
      // parallel: each screenshot() launches its own browser, and the
      // single-consumer invariant (one browser at a time, no parallel rendering
      // billing) applies to every render this job makes, not just the OG one.
      // Half density for both, unlike the OG crop above: these are full-page shots of
      // documents that can run to any length, and at full density a long one exceeds what
      // the read tool can hand back at all. See FULL_PAGE_SCALE.
      await renderPreviewVariant(deps, artifact.id, job.version_n, "full", url, {
        width: OG_W,
        height: OG_H,
        fullPage: true,
        timeoutMs: RENDER_TIMEOUT_MS,
        deviceScaleFactor: FULL_PAGE_SCALE,
      })
      // FULL density, unlike `full` above. This variant exists so the @N badges drawn on
      // the page line up with the region map you READ, and those badges are 12px type —
      // at half density they rasterize to six physical pixels and stop being legible,
      // which makes the variant a worse copy of `full` rather than a different view.
      await renderPreviewVariant(deps, artifact.id, job.version_n, "marked", `${url}?marks=1`, {
        width: OG_W,
        height: OG_H,
        fullPage: true,
        timeoutMs: RENDER_TIMEOUT_MS,
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
      // Sweep first so a never-rendered version found now is claimed this tick.
      // Cheap when there's nothing missing (one bounded SELECT on a local DB).
      await sweepMissingRenders(deps.meta)
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
    poke: () => tick(),
  }
}
