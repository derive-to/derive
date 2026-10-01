import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { useAuth } from "@/ctx"
import { usePageVisible } from "./use-page-visible"
import { useUserEvent } from "./use-user-events"

// Live jobs: a job you asked, or one that needs you or finished for you, arrives as an event
// on your per-user stream (job.progress and job.settled for what you asked; job.needs_you and
// job.finished for what the server told you about). Any of them re-reads every job query on
// screen, so a page following jobs needs only a slow poll as a fallback for jobs nobody told
// you about (a teammate's, on an agent you merely look at). Gated on signed in and visible, so
// a hidden tab releases the stream like every other subscriber.
export function useJobEvents(): void {
  const { me } = useAuth()
  const visible = usePageVisible()
  const qc = useQueryClient()
  const on = useCallback(() => void qc.invalidateQueries({ queryKey: ["jobs"] }), [qc])
  const enabled = !!me && visible
  useUserEvent("job.progress", on, enabled)
  useUserEvent("job.settled", on, enabled)
  useUserEvent("job.needs_you", on, enabled)
  useUserEvent("job.finished", on, enabled)
}
