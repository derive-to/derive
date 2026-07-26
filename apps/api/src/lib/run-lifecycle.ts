// THE RUN LIFECYCLE CLOCK — three timings that must stay in a strict order, defined once.
//
//   RUN_TIMEOUT_MS  <  RUN_TOKEN_TTL_MS  <  RUN_LEASE_MS
//
// Why the ordering is load-bearing, and not merely tidy:
//
//   * A hosted executor is KILLED at RUN_TIMEOUT, so no honest run outlives it.
//   * Its capability token stays valid for RUN_TOKEN_TTL. That must EXCEED the timeout, or a
//     legitimate long run loses the ability to write its own result at the finish line.
//   * The reclaim sweep requeues a run still `running` after RUN_LEASE. That must exceed the
//     TOKEN TTL — not just the timeout — because requeueing mints a SECOND executor for the
//     same run. If the first executor's token were still live at that moment, two processes
//     could write the same artifact: the claim is status-guarded, but a write is an ordinary
//     agent write and the claim does not gate it. Waiting until the old token is provably dead
//     is what makes re-dispatch safe.
//
// Tightening any one of these without the others reopens that double-write window, so they
// live here together with the invariant asserted below.

/** Hard ceiling on one hosted run; the executor is killed past it. */
export const RUN_TIMEOUT_MS = 15 * 60_000

/** How long a dispatched run's capability token stays valid. Longer than the timeout so a run
 *  that uses its full budget can still finish; shorter than the lease so a requeued run's
 *  previous executor is already powerless. */
export const RUN_TOKEN_TTL_MS = 20 * 60_000

/** A run still `running` past this is presumed dead and returns to the queue. */
export const RUN_LEASE_MS = 25 * 60_000

// Fail at import time rather than let a future edit silently reopen the double-write window.
if (!(RUN_TIMEOUT_MS < RUN_TOKEN_TTL_MS && RUN_TOKEN_TTL_MS < RUN_LEASE_MS))
  throw new Error(
    "run lifecycle invariant broken: RUN_TIMEOUT_MS < RUN_TOKEN_TTL_MS < RUN_LEASE_MS",
  )

/** How many times a run may be reclaimed before it is given up as `lost`. */
export const RUN_MAX_ATTEMPTS = 3

/** How many times a run may be RETRIED after a transient failure before it stays failed.
 *  Deliberately small: every attempt spends the owner's model plan, so a run that keeps
 *  failing must stop costing money rather than grind forever. */
export const RUN_MAX_RETRIES = 2

/** Backoff before retry N (1-indexed): a minute, then five. Long enough for a provider blip
 *  or a rate limit to clear, short enough that a recovered run is still timely. */
export const retryDelayMs = (attempt: number): number => (attempt <= 1 ? 60_000 : 5 * 60_000)

/** How long an ASK may stay unsettled before dispatch gives up and marks it `failed`.
 *
 *  A session that wedges — its executor dying past the lease, every round — is otherwise
 *  re-dispatched on every lapse, forever, paying for a full agent run each time. Runs are
 *  bounded by RUN_MAX_ATTEMPTS because they carry an attempt counter in their meta blob.
 *  Sessions have no such column, and elapsed time bounds the spend just as well without
 *  adding one — which would mean a migration to keep in parity across three drivers to hold
 *  a number whose only job is to stop a loop.
 *
 *  Sized as the run cap is — attempts × lease — so an ask and a schedule give up after
 *  comparable effort rather than by coincidence. */
export const SESSION_MAX_AGE_MS = RUN_MAX_ATTEMPTS * RUN_LEASE_MS
