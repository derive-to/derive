// The import worker: one tick claims one due import job for this deployment and runs it,
// holding the upstream's request gate the whole time.
//
// Two rows in the store keep this honest across processes. The job row is the queue (the
// export queue's shape: a claim with a lease, attempts, backoff, dead). The lease row is
// the gate in front of arXiv: whoever holds it is the only worker talking to arXiv, and
// its `next_allowed_at` says when the next request may go, whichever worker sends it.
// The tick takes the gate, then a job, runs the job through a client that paces its
// requests and stamps the gate after each one, and gives the gate back with the
// upstream's last word on timing (three seconds after the last request, or as long as a
// Retry-After asked). A worker that dies mid-job leaves both leases to lapse; the next
// tick reclaims the job and resumes from what it had recorded.
//
// Node runs this on its own interval (startImportWorker), never inside the preview
// worker's tick: a ten-second import must not stall renders and exports. The Workers tier
// runs it from the preview Durable Object's alarm (preview-do.ts).
import type { ImportJobRecord } from "@derive/core"
import {
  ARXIV_REQUEST_INTERVAL_MS,
  ArxivClient,
  ImportCancelled,
  type ImportDeps,
  ImportFailure,
  importArxivPaper,
  writeFailedManifest,
} from "./lib/arxiv-import"
import { log } from "./log"

/** How long one claim (job and gate) stays valid; a lapse means the worker died. */
export const IMPORT_LEASE_MS = 4 * 60_000
/** Transient failures retry with exponential backoff from here, capped below. */
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 30 * 60_000
export const IMPORT_MAX_ATTEMPTS = 3

export interface ImportTickDeps extends Omit<ImportDeps, "now" | "sleep"> {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Names this worker in the lease row; defaults to a per-process id. */
  holder?: string
}

const backoff = (attempts: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
const iso = (ms: number): string => new Date(ms).toISOString()
const defaultHolder = `import_${crypto.randomUUID().slice(0, 12)}`

/** The copy an error code carries into the job row and the failed manifest. */
export const importFailureCopy = (code: string): string =>
  ({
    not_found: "arXiv has no paper with this id.",
    withdrawn: "This paper was withdrawn from arXiv.",
    no_source: "arXiv has only a PDF for this paper, no LaTeX source, so Derive can't read it.",
    no_tex: "The source has no main .tex file Derive can read.",
    too_large: "The source is larger than Derive imports, even after shrinking its figures.",
    rate_limited: "arXiv asked Derive to slow down.",
    unavailable: "arXiv didn't answer.",
  })[code] ?? "The import failed."

const classify = (error: unknown): ImportFailure =>
  error instanceof ImportFailure
    ? error
    : new ImportFailure(
        "unavailable",
        (error instanceof Error ? error.message : String(error)).slice(0, 200),
        false,
      )

/**
 * One pass: take the gate, claim a job, run it, record the outcome, give the gate back.
 * Returns how many jobs were claimed (0 or 1), so a loop knows whether to come straight
 * back for more.
 */
export const runImportTick = async (deps: ImportTickDeps): Promise<number> => {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const holder = deps.holder ?? defaultHolder
  const scope = deps.baseUrl.replace(/\/$/, "")
  const startedAt = now()
  if (
    !(await deps.meta.acquireImportLease(
      "arxiv",
      scope,
      holder,
      iso(startedAt),
      iso(startedAt + IMPORT_LEASE_MS),
    ))
  )
    return 0
  const release = async (nextAllowedAt: number) => {
    await deps.meta
      .updateImportLease("arxiv", scope, holder, {
        holder: null,
        lease_until: null,
        next_allowed_at: iso(nextAllowedAt),
      })
      .catch(() => undefined)
  }
  const lease = await deps.meta.getImportLease("arxiv", scope)
  const client = new ArxivClient(
    { fetch: deps.fetch, now, sleep, baseUrl: deps.baseUrl },
    Math.max(now(), lease?.next_allowed_at ? Date.parse(lease.next_allowed_at) : 0),
    // Every request moves the gate, so a worker that dies between requests still leaves
    // the pace behind for whoever takes the gate next.
    (nextAllowedAt) =>
      deps.meta
        .updateImportLease("arxiv", scope, holder, { next_allowed_at: iso(nextAllowedAt) })
        .catch(() => undefined),
  )
  // The gate goes back once, the moment the job's last arXiv request is done (the job
  // itself asks, so shrinking and publishing never hold it) or, failing that, at the end.
  let released = false
  const releaseGate = async (): Promise<void> => {
    if (released) return
    released = true
    await release(
      Math.max(client.nextAllowedAt, client.penaltyUntil, now() + ARXIV_REQUEST_INTERVAL_MS),
    )
  }
  let job: ImportJobRecord | null = null
  try {
    job = await deps.meta.claimDueImportJob(iso(now()), iso(now() + IMPORT_LEASE_MS), scope)
    if (!job) return 0
    await importArxivPaper({ ...deps, now, sleep, releaseGate }, job, client)
    log.info("import ready", { jobId: job.id, ref: job.ref, attempts: job.attempts })
  } catch (error) {
    if (!job || error instanceof ImportCancelled) return job ? 1 : 0
    const failure = classify(error)
    // A job whose row vanished while it ran was discarded; nothing to record.
    if (!(await deps.meta.getImportJob(job.id))) return 1
    const terminal = failure.terminal || job.attempts >= IMPORT_MAX_ATTEMPTS
    await deps.meta.updateImportJob(job.id, {
      status: terminal ? "dead" : "failed",
      lease_until: null,
      error_code: failure.code,
      error_detail: failure.detail.slice(0, 200),
      next_attempt_at: iso(
        now() + (terminal ? 0 : Math.max(backoff(job.attempts), failure.retryAfterMs ?? 0)),
      ),
      updated_at: iso(now()),
    })
    if (terminal)
      await writeFailedManifest(
        { ...deps, now, sleep },
        job,
        `${importFailureCopy(failure.code)}${failure.terminal ? "" : " Derive tried three times."}`,
      )
    log.warn("import failed", {
      jobId: job.id,
      ref: job.ref,
      code: failure.code,
      detail: failure.detail,
      attempts: job.attempts,
      terminal,
    })
  } finally {
    await releaseGate()
  }
  return 1
}

export interface ImportWorker {
  stop: () => void
  /** Run a tick now (a fresh enqueue); overlapping calls coalesce into one pass. */
  poke: () => Promise<void>
}

/** The Node worker: an interval plus a poke, each tick one job. Overlap is prevented
 *  in-process here and across processes by the lease. */
export const startImportWorker = (deps: ImportTickDeps, intervalMs = 2_000): ImportWorker => {
  let stopped = false
  let running = false
  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      // Drain a burst: a tick that found work comes straight back for the next job.
      while (!stopped && (await runImportTick(deps)) > 0) {
        // The next claim waits for the gate anyway; nothing to do between jobs.
      }
    } catch (err) {
      log.error("import tick failed", { error: err instanceof Error ? err.message : String(err) })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    poke: () => tick(),
  }
}
