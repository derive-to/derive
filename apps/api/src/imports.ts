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
// A run that is alive keeps its claim: it renews both leases as it goes, and every write it
// makes to the job carries the claim's token, so a run that was given up on and reclaimed
// can no longer write over the worker that took over.
//
// Node runs this on its own interval (startImportWorker), never inside the preview
// worker's tick: a ten-second import must not stall renders and exports. The Workers tier
// runs it from its own instance of the preview Durable Object (preview-do.ts), for the
// same reason.
import { IMPORT_MAX_ATTEMPTS, type ImportJobRecord } from "@derive/core"
import {
  ARXIV_REQUEST_INTERVAL_MS,
  ArxivClient,
  ImportCancelled,
  type ImportDeps,
  ImportFailure,
  ImportYield,
  importArxivPaper,
  writeFailedPaper,
} from "./lib/arxiv-import"
import { log } from "./log"

/** How long one claim (job and gate) stays valid; a lapse means the worker died. */
export const IMPORT_LEASE_MS = 4 * 60_000
/** How often a running import renews that claim: well inside the lease, so a run that is
 *  alive (a long download, a slow publish) never looks dead to the next tick. */
const HEARTBEAT_MS = 60_000
/** How long one pass may work. A Durable Object alarm is ended at 15 minutes, so downloads
 *  and shrinking stop in time for the pass to publish well inside that. */
const PASS_BUDGET_MS = 12 * 60_000
/** Transient failures retry with exponential backoff from here, capped below. */
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 30 * 60_000

export interface ImportTickDeps
  extends Omit<ImportDeps, "now" | "sleep" | "claimToken" | "heartbeat" | "passDeadline"> {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Names this worker in the lease row; defaults to a fresh id per tick. */
  holder?: string
}

const backoff = (attempts: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
const iso = (ms: number): string => new Date(ms).toISOString()
// Minted per tick, never at module load: workerd forbids generating random values in
// global scope, and a deploy whose module body does it is rejected outright.
// Per TICK, not memoised per process, and that part is not incidental: the release and
// restamp paths match on `holder` alone, so two ticks sharing one id lets a tick whose
// lease already lapsed null out the row a live tick is holding, and a third worker then
// takes a gate someone is still talking to arXiv through.
const defaultHolder = (): string => `import_${crypto.randomUUID().slice(0, 12)}`

/** The copy an error code carries into the job row and the failed manifest. */
export const importFailureCopy = (code: string): string =>
  ({
    not_found: "arXiv has no paper with this id.",
    withdrawn: "This paper was withdrawn from arXiv.",
    no_source: "arXiv has only a PDF for this paper, no LaTeX source, so Derive can't read it.",
    no_tex: "The source has no main .tex file Derive can read.",
    too_large: "The source is larger than Derive can import.",
    rate_limited: "arXiv asked Derive to slow down.",
    unavailable: "arXiv didn't answer.",
    internal: "Something went wrong inside Derive, not at arXiv.",
  })[code] ?? "The import failed."

// Anything that escapes a phase is already an ImportFailure carrying its step (see
// `inStep`). This is the backstop for what fails outside every phase: claiming the job,
// reading the Context, renaming it. `internal` rather than `unavailable`, because
// reporting our own fault as "arXiv didn't answer" sends whoever is debugging to the
// wrong system, and the thrown message is the only record of what actually happened.
const classify = (error: unknown): ImportFailure =>
  error instanceof ImportFailure
    ? error
    : new ImportFailure(
        "internal",
        (error instanceof Error ? error.message : String(error)).slice(0, 200),
        false,
      )

/** Why a job that kept being cut off stopped. Nothing was thrown, so there is no reason to
 *  quote: the platform stopped the worker before it could say anything. */
const cutOff = (what: string): string =>
  `${what} was stopped before finishing ${IMPORT_MAX_ATTEMPTS} times; the worker was cut off by a memory, CPU or time limit`

/**
 * Record a job that kept being cut off, without running it again.
 *
 * Every failure records itself and gives up on the last attempt, so a claim past it can only
 * follow runs that never came back. Running it again would be stopped again, and on the
 * Workers tier each of those runs used to take whatever shared its isolate down with it.
 */
const giveUpCutOff = async (
  deps: ImportDeps,
  job: ImportJobRecord,
  claimToken: string,
): Promise<void> => {
  const at = iso(deps.now())
  log.warn("import cut off", { jobId: job.id, ref: job.ref, attempts: job.attempts })
  // The paper was already published, so what kept being stopped came after it: attaching
  // the implementation. The paper stands, and the implementation says what happened to it.
  if (job.paper_artifact_id) {
    await deps.meta.updateImportJob(
      job.id,
      {
        status: "ready",
        lease_until: null,
        error_code: null,
        error_detail: null,
        code_status: "failed",
        code_error: cutOff("attaching the repository"),
        code_ref: null,
        updated_at: at,
      },
      claimToken,
    )
    return
  }
  const recorded = await deps.meta.updateImportJob(
    job.id,
    {
      status: "dead",
      lease_until: null,
      error_code: "internal",
      error_detail: cutOff("the import"),
      next_attempt_at: at,
      updated_at: at,
    },
    claimToken,
  )
  if (recorded)
    await writeFailedPaper(deps, job, `${importFailureCopy("internal")} Derive tried three times.`)
}

/**
 * One pass: take the gate, claim a job, run it, record the outcome, give the gate back.
 * Returns how many jobs were claimed (0 or 1), so a loop knows whether to come straight
 * back for more.
 */
export const runImportTick = async (deps: ImportTickDeps): Promise<number> => {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const holder = deps.holder ?? defaultHolder()
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
  // Per claim, and random for the same reason the holder is (see defaultHolder): a token two
  // claims could share would let the older run keep writing after the newer one took over.
  const claimToken = `${holder}:${crypto.randomUUID()}`
  let job: ImportJobRecord | null = null
  try {
    job = await deps.meta.claimDueImportJob(
      iso(now()),
      iso(now() + IMPORT_LEASE_MS),
      scope,
      claimToken,
    )
    if (!job) return 0
    if (job.attempts > IMPORT_MAX_ATTEMPTS) {
      await giveUpCutOff({ ...deps, now, sleep }, job, claimToken)
      return 1
    }
    const claimed = job
    let lastBeat = now()
    const heartbeat = async (): Promise<void> => {
      if (now() - lastBeat < HEARTBEAT_MS) return
      lastBeat = now()
      const until = iso(now() + IMPORT_LEASE_MS)
      // A renewal that lands nowhere means the job is gone or another worker owns it now,
      // and this run stops rather than race it.
      if (!(await deps.meta.updateImportJob(claimed.id, { lease_until: until }, claimToken)))
        throw new ImportCancelled()
      // The gate as well, while this run still talks to arXiv. The store restamps it only
      // for its holder, so a gate someone else took is left alone.
      if (!released)
        await deps.meta
          .updateImportLease("arxiv", scope, holder, { lease_until: until })
          .catch(() => undefined)
    }
    await importArxivPaper(
      {
        ...deps,
        now,
        sleep,
        releaseGate,
        claimToken,
        heartbeat,
        passDeadline: startedAt + PASS_BUDGET_MS,
      },
      job,
      client,
    )
    log.info("import ready", { jobId: job.id, ref: job.ref, attempts: job.attempts })
  } catch (error) {
    if (!job || error instanceof ImportCancelled) return job ? 1 : 0
    if (error instanceof ImportYield) {
      // The paper is published and readable; its implementation follows in a pass of its
      // own. Handing over is not a failure, so the attempt goes back with the job.
      await deps.meta.updateImportJob(
        job.id,
        {
          status: "pending",
          lease_until: null,
          claim_token: null,
          attempts: Math.max(0, job.attempts - 1),
          next_attempt_at: iso(now()),
          updated_at: iso(now()),
        },
        claimToken,
      )
      log.info("import paper ready, implementation next", { jobId: job.id, ref: job.ref })
      return 1
    }
    const failure = classify(error)
    // A job whose row vanished while it ran was discarded; nothing to record.
    if (!(await deps.meta.getImportJob(job.id))) return 1
    const terminal = failure.terminal || job.attempts >= IMPORT_MAX_ATTEMPTS
    const recorded = await deps.meta.updateImportJob(
      job.id,
      {
        status: terminal ? "dead" : "failed",
        lease_until: null,
        error_code: failure.code,
        // `describe()` prefixes the phase: "metadata: arXiv answered 403" rather than
        // "arXiv answered 403". It is the difference between a clue and a diagnosis, and
        // it is the only place the reason survives.
        error_detail: failure.describe().slice(0, 200),
        next_attempt_at: iso(
          now() + (terminal ? 0 : Math.max(backoff(job.attempts), failure.retryAfterMs ?? 0)),
        ),
        updated_at: iso(now()),
      },
      claimToken,
    )
    // Nothing recorded: another worker took the job over after this run's lease lapsed, and
    // the outcome that stands is that worker's.
    if (!recorded) return 1
    if (terminal)
      await writeFailedPaper(
        { ...deps, now, sleep },
        job,
        `${importFailureCopy(failure.code)}${failure.terminal ? "" : " Derive tried three times."}`,
      )
    log.warn("import failed", {
      jobId: job.id,
      ref: job.ref,
      code: failure.code,
      detail: failure.describe(),
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
