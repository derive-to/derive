import { Link } from "@tanstack/react-router"
import type { AgentDetail, Job } from "@/api"
import { Icon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { cronLabel, firstLine, JOB_ICON, when } from "./format"
import { Segmented } from "./rows"
import { taskStatus } from "./task-status"

/** One task is one destination. Source is metadata, never the task's title. */
export function AgentTaskList({
  jobs,
  agent,
  source,
  onSource,
  needsOnly,
  onNeedsOnly,
}: {
  jobs: Job[]
  agent: AgentDetail
  source: string
  needsOnly: boolean
  onNeedsOnly: (value: boolean) => void
  onSource: (source: string) => void
}) {
  return (
    <section className="flex flex-col gap-4" data-testid="agent-jobs">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Tasks</h2>
        <select
          aria-label="Task source"
          data-testid="agent-task-source"
          value={source}
          onChange={(e) => onSource(e.target.value)}
          className="max-w-60 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
        >
          <option value="all">All sources</option>
          <option value="manual">Manual requests</option>
          {agent.triggers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.kind === "schedule" ? `${cronLabel(t.cron ?? "")} · ${t.tz ?? "UTC"}` : "Event"} ·{" "}
              {firstLine(t.instruction).slice(0, 60)}
              {!t.enabled ? " (paused)" : ""}
            </option>
          ))}
        </select>
      </div>
      <Segmented
        testId="agent-task-state"
        value={needsOnly ? "needs" : "all"}
        onChange={(value) => onNeedsOnly(value === "needs")}
        options={[
          { value: "all", label: "All tasks" },
          { value: "needs", label: "Needs attention" },
        ]}
      />
      <div className="divide-y divide-border border-y border-border">
        {!jobs.length && (
          <p data-testid="agent-jobs-empty" className="py-8 text-sm text-muted-foreground">
            {needsOnly
              ? "No tasks need your attention."
              : source === "all"
                ? "Ready for its first task. Start one above."
                : "No tasks from this source yet."}
          </p>
        )}
        {jobs.map((job) => {
          const trigger = agent.triggers.find((t) => t.id === job.trigger_id)
          const origin = trigger?.cron
            ? cronLabel(trigger.cron)
            : job.trigger_id
              ? trigger
                ? "Event"
                : "Removed trigger"
              : job.kind === "scheduled"
                ? "Schedule"
                : "Manual request"
          return (
            <Link
              key={job.id}
              to="/tasks/$id"
              params={{ id: job.id }}
              data-testid={`job-open-${job.id}`}
              className="group flex min-w-0 items-center gap-3 py-4 hover:bg-secondary/50"
            >
              <Icon
                name={JOB_ICON[job.status]}
                className={cn(
                  "size-4 shrink-0",
                  job.status === "succeeded"
                    ? "text-success"
                    : job.status === "needs_you"
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{firstLine(job.instruction)}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {origin} · {taskStatus(job, agent)}
                </p>
              </div>
              <time dateTime={job.created_at} className="shrink-0 text-xs text-muted-foreground">
                {when(job.created_at)}
              </time>
              <Icon name="chevron-right" className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          )
        })}
      </div>
    </section>
  )
}
