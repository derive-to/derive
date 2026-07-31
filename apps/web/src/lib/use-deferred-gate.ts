import { useIsFetching } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

/** Opens once the boot's real work has finished — the gate for AMBIENT reads:
 *  onboarding pills, activation nudges, the sync chip. Those surfaces render nothing
 *  until their data arrives and nobody is waiting on them, but on a cold boot each
 *  was spending an authenticated Worker invocation and its Postgres round trips in
 *  the exact window the library list needs.
 *
 *  WHY NOT requestIdleCallback. That was the first implementation and the preview
 *  measurement killed it: rIC means the CPU is idle, and a cold boot here is network
 *  bound, not CPU bound — the main thread goes quiet ~300ms in, while every boot
 *  request is still in flight. The four ambient reads fired at ~360ms, exactly
 *  alongside the requests they were supposed to yield to. "Idle" was the wrong
 *  signal for "the content has arrived".
 *
 *  So the gate watches React Query's in-flight count instead: it opens the first
 *  time the app goes from fetching-something to fetching-nothing, which IS the
 *  moment the boot's critical reads have landed. `timeout` is a ceiling so a page
 *  that never settles (a poll, a stuck request) still shows its ambient surfaces. */
export function useDeferredGate(timeout = 4000): boolean {
  const inFlight = useIsFetching()
  const [open, setOpen] = useState(false)
  // Guard against opening on the first frame, when nothing has STARTED fetching yet
  // and the count is legitimately 0.
  const sawWork = useRef(false)

  useEffect(() => {
    if (open) return
    if (inFlight > 0) sawWork.current = true
    else if (sawWork.current) setOpen(true)
  }, [inFlight, open])

  useEffect(() => {
    if (open) return
    const t = setTimeout(() => setOpen(true), timeout)
    return () => clearTimeout(t)
  }, [open, timeout])

  return open
}
