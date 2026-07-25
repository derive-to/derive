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
