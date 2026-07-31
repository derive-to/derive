import { useIsFetching } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

/** Opens once the content the person is actually waiting for has landed — the gate for
 *  AMBIENT reads: onboarding pills, activation nudges, the sync chip. Those surfaces
 *  render nothing until their data arrives and nobody waits on them, but on a cold boot
 *  each was spending an authenticated Worker invocation and its Postgres round trips in
 *  the exact window the library list needs.
 *
 *  TWO SIGNALS THAT DID NOT WORK, both caught by measuring the preview rather than by
 *  reasoning — worth recording so nobody reaches for them again:
 *
 *  1. `requestIdleCallback`. It means the CPU is idle, and a cold boot here is NETWORK
 *     bound: the main thread goes quiet a few hundred ms in while every boot request is
 *     still in flight. The ambient reads fired at ~360ms, alongside the requests they
 *     were meant to yield to.
 *
 *  2. A GLOBAL in-flight count (`useIsFetching()`) reaching zero. It hits zero in the
 *     gap between `/api/auth/get-session` resolving and the data fan-out starting, so
 *     the gate opened at ~350ms — before the boot batch had even been issued.
 *
 *  What actually expresses the intent is the artifact list itself: wait until a query
 *  under the ["artifacts"] key has both STARTED and finished. That is the content the
 *  library exists to show. Routes without one (settings, profile) fall through to the
 *  timeout, which is also the ceiling for a page whose list never settles. */
export function useDeferredGate(timeout = 2500): boolean {
  // Scoped to the list, not the whole client — see the note above on why global
  // quiescence is not the same thing as "the content arrived".
  const listInFlight = useIsFetching({ queryKey: ["artifacts"] })
  const [open, setOpen] = useState(false)
  const sawList = useRef(false)

  useEffect(() => {
    if (open) return
    if (listInFlight > 0) sawList.current = true
    else if (sawList.current) setOpen(true)
  }, [listInFlight, open])

  useEffect(() => {
    if (open) return
    const t = setTimeout(() => setOpen(true), timeout)
    return () => clearTimeout(t)
  }, [open, timeout])

  return open
}
