// THE DERIVE-MACHINE JOB CLOCK: three timings that must stay in a strict order, defined once.
//
//   deadline  <  token expiry  <  lease
//
// Why the ordering is load-bearing, and not merely tidy:
//
//   * A job on a Derive machine is STOPPED at its deadline (job-machine.ts), so no honest job
//     outlives it.
//   * Its job token stays valid past the deadline, or a legitimate long job loses the ability to
//     write its own result at the finish line.
//   * The reclaim sweep requeues a job still `running` after its lease. That must outlive the
//     token (not just the deadline) because requeueing starts a SECOND machine turn for the same
//     job. If the first turn's token were still live at that moment, two processes could write
//     the same artifact: the claim is status-guarded, but a write is an ordinary agent write and
//     the claim does not gate it. Waiting until the old token is provably dead is what makes
//     re-dispatch safe.
//
// The budget is the agent's own (`max_run_ms`), so a long coding task and a two-minute check
// each get a clock that fits; the margins keep the order whatever the budget.

/** A Derive-machine turn's budget when its agent sets none. */
export const RUN_TIMEOUT_MS = 15 * 60_000

const TOKEN_MARGIN_MS = 5 * 60_000
const LEASE_MARGIN_MS = 10 * 60_000
if (!(0 < TOKEN_MARGIN_MS && TOKEN_MARGIN_MS < LEASE_MARGIN_MS))
  throw new Error("machine clock: deadline < token expiry < lease must hold")

/** A machine turn's job token dies this long after its deadline (see the order above). */
export const tokenExpiryAfter = (deadline: number) => deadline + TOKEN_MARGIN_MS

/** One Derive-machine turn's clock, from its agent's run budget (clamped to
 *  MAX_RUN_CEILING_MS). Times are epoch milliseconds. */
export const machineClock = (maxRunMs: number | null, now: number) => {
  const deadline = now + Math.min(maxRunMs ?? RUN_TIMEOUT_MS, MAX_RUN_CEILING_MS)
  return { deadline, lease: deadline + LEASE_MARGIN_MS }
}

/** How many times a job may be reclaimed before it is given up as `lost`. */
export const RUN_MAX_ATTEMPTS = 3

/** The longest a single job may run or be leased for, whatever the agent's own cap says. */
export const MAX_RUN_CEILING_MS = 6 * 60 * 60_000

/** An owner-machine claim's lease: the agent's run budget (default 10 minutes, clamped to
 *  30 seconds .. MAX_RUN_CEILING_MS) plus a minute of margin. The lease must OUTLIVE the budget
 *  it is derived from: a job that never ticks and finishes right at its budget would otherwise
 *  land on an expired lease and be re-served, a double run. The margin covers the final write
 *  and clock skew between the runner and the API. */
export const leaseUntilFor = (maxRunMs: number | null, now = Date.now()): string => {
  const ms = Math.min(Math.max(maxRunMs ?? 600_000, 30_000), MAX_RUN_CEILING_MS)
  return new Date(now + ms + 60_000).toISOString()
}
