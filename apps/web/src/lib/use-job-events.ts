import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { useAuth } from "@/ctx"
import { usePageVisible } from "./use-page-visible"
import { subscribeUserEvent } from "./use-user-events"

// Live jobs: a job you asked, or one that needs you or finished for you, arrives as an event
// on your per-user stream (job.started when a machine takes it, job.progress as it reports,
// job.settled when it settles; job.needs_you and job.finished for what the server told you
// about). Any of them re-reads every job query on screen, so a page following jobs needs only
// a slow poll as a fallback for jobs nobody told you about (a teammate's).
//
// One subscription per tab, however many screens ask for it (the rail, a page, the margin):
// the first caller attaches, the last one to go detaches. A burst of events (a pass settling
// several jobs) is one re-read, a short moment after the last of them.

const TYPES = [
  "job.started",
  "job.progress",
  "job.settled",
  "job.needs_you",
  "job.finished",
] as const
const SETTLE_MS = 250

let holders = 0
let detach: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

const attach = (qc: QueryClient) => {
  const reread = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void qc.invalidateQueries({ queryKey: ["jobs"] })
    }, SETTLE_MS)
  }
  const offs = TYPES.map((t) => subscribeUserEvent(t, reread))
  return () => {
    for (const off of offs) off()
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** Keep every job query on screen current while this component is mounted. Gated on signed
 *  in and visible, so a hidden tab releases the stream like every other subscriber. */
export function useJobEvents(): void {
  const { me } = useAuth()
  const visible = usePageVisible()
  const qc = useQueryClient()
  const enabled = !!me && visible
  useEffect(() => {
    if (!enabled) return
    holders++
    if (!detach) detach = attach(qc)
    return () => {
      holders--
      if (holders === 0 && detach) {
        detach()
        detach = null
      }
    }
  }, [enabled, qc])
}
