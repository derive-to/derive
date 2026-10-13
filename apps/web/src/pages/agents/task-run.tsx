import { type ReactNode, useEffect, useState } from "react"
import type { Agent, JobDetail } from "@/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { detailOf, taskStatus } from "./agent-jobs"
import { eventLine } from "./format"

const STEPS = ["Queued", "Machine", "Working", "Done"] as const

/** Where a task stands, as one of the steps every task walks. A task on its owner's machine has
 *  no machine step to show. */
function stepOf(job: JobDetail, onDerive: boolean): number {
  // Waiting on a person is part of working: the task picks up where it stopped.
  if (job.status === "needs_you") return 2
  if (job.status !== "queued" && job.status !== "running") return 3
  if (job.machine_phase === "running") return 2
  if (job.machine_phase || job.machine_waiting) return 1
  return job.status === "running" && !onDerive ? 2 : 0
}

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

/** The top of a task: where it stands, live; what it runs on; and what it is doing now. */
export function TaskRun({
  job,
  agent,
  canStop,
  stopping,
  onStop,
}: {
  job: JobDetail
  agent: Agent | undefined
  canStop: boolean
  stopping: boolean
  onStop: () => void
}) {
  const [allActivity, setAllActivity] = useState(false)
  const active = ["queued", "running", "needs_you"].includes(job.status)
  const onDerive = agent?.machine === "derive"
  const step = stepOf(job, onDerive)
  const steps = onDerive ? STEPS : STEPS.filter((s) => s !== "Machine")
  const at = onDerive ? step : step === 0 ? 0 : step - 1
  const elapsed = useElapsed(
    job.started_at,
    active ? null : job.finished_at,
    job.status === "running",
  )
  const detail = agent ? detailOf(job, agent) : undefined
  const turn = job.turns?.at(-1)
  const git = job.result.git
  const pr = job.result.effects?.find((e) => e.kind === "pr")
  const events = job.events ?? []
  const shown = allActivity ? events : events.slice(-6)
  // The current step carries the state: its words, and a colour only where it means something.
  const now = cn(
    job.status === "succeeded" && "text-success",
    job.status === "needs_you" && "text-warning",
    (job.status === "failed" || job.status === "lost") && "text-destructive",
  )
  const nowDot = cn(
    job.status === "succeeded"
      ? "bg-success"
      : job.status === "needs_you"
        ? "bg-warning"
        : job.status === "failed" || job.status === "lost"
          ? "bg-destructive"
          : active
            ? "animate-pulse bg-foreground motion-reduce:animate-none"
            : "bg-muted-foreground",
  )
  type Fact = { key: string; node: ReactNode }
  const facts = (
    [
      turn && {
        key: "harness",
        node: `${turn.execution.provider === "codex" ? "Codex" : "Claude Code"}${turn.execution.model ? ` · ${turn.execution.model}` : ""}`,
      },
      agent && { key: "machine", node: onDerive ? "Derive cloud" : "Its owner’s machine" },
      job.task.session && { key: "session", node: "Interactive session" },
      job.task.repo && { key: "repo", node: job.task.repo },
      git?.commit && {
        key: "git",
        node: (
          <a
            href={`https://github.com/${git.repo}/commit/${git.commit}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground hover:underline"
          >
            {git.branch ?? "detached"} @ {git.commit.slice(0, 7)}
          </a>
        ),
      },
      pr && {
        key: "pr",
        node: pr.url ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground hover:underline"
          >
            {pr.ref ?? "Pull request"}
          </a>
        ) : (
          pr.label
        ),
      },
    ] as (Fact | false | "" | null | undefined)[]
  ).filter((f): f is Fact => !!f)

  return (
    <section
      data-testid="task-run"
      aria-label="Where this task stands"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3" role="status">
        <div className="flex flex-wrap items-center gap-3">
          <ol
            aria-label="Progress"
            data-testid="task-status"
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            {steps.map((label, i) => (
              <li
                key={label}
                aria-current={i === at ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2",
                  i < at && "text-muted-foreground",
                  i === at && cn("font-medium text-foreground", now),
                  i > at && "text-muted-foreground/60",
                )}
              >
                {i > 0 && <span aria-hidden className="h-px w-4 bg-border" />}
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    i < at && "bg-muted-foreground",
                    i === at && nowDot,
                    i > at && "bg-border",
                  )}
                />
                {i === at && agent && (job.status === "needs_you" || !active)
                  ? taskStatus(job, agent)
                  : label}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {elapsed && (
            <span className="font-mono" data-testid="task-elapsed">
              {elapsed}
            </span>
          )}
          {canStop && active && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="task-stop"
              loading={stopping}
              onClick={onStop}
            >
              Stop
            </Button>
          )}
        </div>
      </div>
      {detail && (job.status === "queued" || job.status === "running") && (
        <p className="text-sm text-muted-foreground" data-testid="task-run-detail">
          {detail}
        </p>
      )}
      {facts.length > 0 && (
        <ul
          data-testid="task-facts"
          className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground"
        >
          {facts.map((f) => (
            <li key={f.key} data-testid={`task-fact-${f.key}`}>
              {f.node}
            </li>
          ))}
        </ul>
      )}
      {events.length > 0 && (
        <div
          className="flex flex-col gap-1 border-t border-border pt-3"
          data-testid="task-live"
          aria-live="polite"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              {job.status === "running" ? "Now" : `Activity · ${events.length}`}
            </p>
            {events.length > 6 && (
              <Button
                variant="ghost"
                size="xs"
                data-testid="task-activity-all"
                onClick={() => setAllActivity((v) => !v)}
              >
                {allActivity ? "Latest" : `All ${events.length}`}
              </Button>
            )}
          </div>
          <ol className={cn("flex flex-col gap-0.5", allActivity && "max-h-80 overflow-y-auto")}>
            {shown.map((event, i) => (
              <li
                key={`${event.turn_id}:${event.seq}`}
                className={cn(
                  "truncate font-mono text-xs",
                  i === shown.length - 1 && job.status === "running"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {eventLine(event)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
