import { useEffect, useState } from "react"

/** Opens once the browser goes idle after mount (or after `timeout`, whichever comes
 *  first). The gate for AMBIENT reads: onboarding pills, activation nudges, the sync
 *  chip — surfaces that render nothing until their data arrives, that nobody is
 *  waiting on, and that on a cold boot were competing for the same authenticated
 *  Worker invocations and Postgres round trips as the library list the person
 *  actually asked for.
 *
 *  Deferring rather than batching is deliberate for these four. They are not one
 *  read set (they span onboarding, agents, workspace and sync), two of them are
 *  optional-schema reads the boot batch deliberately excludes, and every one of them
 *  hides itself until it resolves — so arriving a second late costs nothing, while
 *  arriving during boot costs the library list contention.
 *
 *  requestIdleCallback is the right primitive: it fires after the browser has
 *  finished the work it already has, which on a cold boot is exactly "after the grid
 *  has painted". Safari lacks it, so a timer is the fallback; the `timeout` option
 *  bounds the wait on a page that never goes idle. */
export function useIdleGate(timeout = 2500): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (idle) return
    const ric = typeof window !== "undefined" ? window.requestIdleCallback : undefined
    if (!ric) {
      // Safari: a plain timer, deliberately shorter than the rIC timeout — without
      // the idle signal this is the only thing that opens the gate.
      const t = setTimeout(() => setIdle(true), 1200)
      return () => clearTimeout(t)
    }
    const handle = ric(() => setIdle(true), { timeout })
    return () => window.cancelIdleCallback?.(handle)
  }, [idle, timeout])
  return idle
}
