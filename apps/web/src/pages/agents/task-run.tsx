import { useEffect, useState } from "react"
import type { Agent, JobDetail } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { detailOf } from "./agent-jobs"
import { eventLine, JOB_ICON } from "./format"
import { taskStatus } from "./task-status"

/** Seconds since `from`, refreshed every second while `live`. */
function useElapsed(from: string | null | undefined, to: string | null | undefined, live: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(tick)
  }, [live])
  if (!from) return null
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000))
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** Status is compact; execution detail expands in the conversation's activity disclosure. */
export function TaskRun({
  job,
  agent,
  names,
  meId,
  canStop,
  stopping,
  onStop,
}: {
  job: JobDetail
  agent: Agent | undefined
  names: Map<string, string>
  meId: string | undefined
  canStop: boolean
  stopping: boolean
  onStop: () => void
}) {
  const active = ["queued", "running", "needs_you"].includes(job.status)
  const elapsed = useElapsed(job.started_at, active ? null : job.finished_at, active)
  const detail = agent ? detailOf(job, agent, names, meId) : undefined
  const latest = job.events?.at(-1)
  return (
    <section data-testid="task-run" aria-label="Task status" className="flex flex-col gap-2">
      <div
        className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
        role="status"
      >
        <span data-testid="task-status" className="flex items-center gap-1.5">
          <Icon
            name={JOB_ICON[job.status]}
            className={cn(
              "size-3.5",
              job.status === "succeeded" && "text-success",
              job.status === "needs_you" && "text-warning",
            )}
          />
          {agent ? taskStatus(job, agent) : job.status}
        </span>
        <span>
          {job.kind === "scheduled"
            ? "Scheduled task"
            : `Asked by ${names.get(job.asked_by ?? "") ?? "Teammate"}`}
        </span>
        {elapsed && (
          <span data-testid="task-elapsed" className="tabular-nums">
            {elapsed}
          </span>
        )}
        {canStop && active && (
          <Button
            variant="ghost"
            size="xs"
            data-testid="task-stop"
            loading={stopping}
            onClick={onStop}
          >
            Stop
          </Button>
        )}
      </div>
      {active && detail && (
        <p data-testid="task-run-detail" className="text-xs text-muted-foreground">
          {detail}
        </p>
      )}
      {job.status === "running" && latest && (
        <p
          data-testid="task-live"
          aria-live="polite"
          className="truncate text-xs text-muted-foreground"
        >
          {eventLine(latest)}
        </p>
      )}
    </section>
  )
}
