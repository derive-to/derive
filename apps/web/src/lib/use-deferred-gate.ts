import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

/** Opens once the content the person is actually waiting for has ARRIVED — the gate for
 *  AMBIENT reads: onboarding pills, activation nudges, the sync chip. Those surfaces
 *  render nothing until their data lands and nobody waits on them, but on a cold boot
 *  each was spending an authenticated Worker invocation and its Postgres round trips in
 *  the exact window the library list needs.
 *
 *  THREE SIGNALS THAT DID NOT WORK, each caught by measuring the preview rather than by
 *  reasoning. Recorded so nobody reaches for them again:
 *
 *  1. `requestIdleCallback` — means the CPU is idle. A cold boot here is NETWORK bound:
 *     the main thread goes quiet a few hundred ms in while every request is still in
 *     flight, so the ambient reads fired at ~360ms alongside the ones they should yield
 *     to.
 *
 *  2. A GLOBAL in-flight count hitting zero — it hits zero in the gap between
 *     `/api/auth/get-session` resolving and the data fan-out starting, opening the gate
 *     at ~350ms, before the boot batch had even been issued.
 *
 *  3. An in-flight count SCOPED to the list — still racy: on the library route the count
 *     dips through zero around mount/prefetch handoff, so the gate opened early there
 *     while (correctly) waiting out the timeout on routes with no list. A signal that is
 *     right on one route and wrong on another is not a signal.
 *
 *  What is not racy is DATA PRESENCE, because it is monotonic: once a list query under
 *  the ["artifacts"] key holds data, it never goes back to holding none. That is exactly
 *  "the content arrived". Routes without a list (settings, profile) fall through to the
 *  timeout, which is also the ceiling for a list that never resolves. */
export function useDeferredGate(timeout = 2500): boolean {
  const client = useQueryClient()
  const [timedOut, setTimedOut] = useState(false)

  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  )
  const hasListData = useSyncExternalStore(
    subscribe,
    () => client.getQueriesData({ queryKey: ["artifacts"] }).some(([, data]) => data !== undefined),
    // Server render: nothing is loaded, so the gate is shut.
    () => false,
  )

  useEffect(() => {
    if (hasListData) return
    const t = setTimeout(() => setTimedOut(true), timeout)
    return () => clearTimeout(t)
  }, [hasListData, timeout])

  return hasListData || timedOut
}
