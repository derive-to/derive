import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { AgentDetail, Job } from "@/api"
import { Icon } from "@/components/icons"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { cn } from "@/lib/utils"
import {
  clockOf,
  dayLabel,
  detailOf,
  firstName,
  JOB_ICON,
  jobOutcome,
  jobSpend,
  jobSubject,
  runTitle,
  took,
  when,
} from "./format"
import { Group, Meta, Time } from "./rows"

// One task is one destination. Rows say what happened, not what was asked: an on-demand
// agent's list is grouped by state (what is running, then everything before it), a scheduled
// agent's by day with the scheduled time on the left, the way a log reads.

const OPEN = new Set<Job["status"]>(["queued", "running", "needs_you"])

export function AgentTaskList({
  jobs,
  agent,
  names,
  meId,
  scheduled,
}: {
  jobs: Job[]
  agent: AgentDetail
  names: Map<string, string>
  meId: string
  scheduled: boolean
}) {
  if (!jobs.length)
    return (
      <p data-testid="agent-jobs-empty" className="py-3 text-base text-muted-foreground">
        {scheduled ? "Its first run is still to come." : "Ready for its first task."}
      </p>
    )
  if (scheduled) {
    // Rows arrive newest-created first; a run belongs to its window, so order by that.
    const at = (job: Job) => job.scheduled_for ?? job.created_at
    const byDay = new Map<string, Job[]>()
    for (const job of [...jobs].sort((a, b) => at(b).localeCompare(at(a)))) {
      const key = dayLabel(at(job))
      byDay.set(key, [...(byDay.get(key) ?? []), job])
    }
    return (
      <div className="flex flex-col gap-6" data-testid="agent-jobs">
        {[...byDay].map(([day, rows]) => (
          <section key={day} className="flex flex-col">
            <Eyebrow as="h3" className="mb-1">
              {day}
            </Eyebrow>
            {rows.map((job) => (
              <Row key={job.id} job={job} agent={agent} names={names} meId={meId} scheduled />
            ))}
          </section>
        ))}
      </div>
    )
  }
  const running = jobs.filter((j) => OPEN.has(j.status))
  const earlier = jobs.filter((j) => !OPEN.has(j.status))
  return (
    <div className="flex flex-col gap-7" data-testid="agent-jobs">
      {running.length > 0 && (
        <Group label="Running" testId="agent-jobs-running">
          {running.map((job) => (
            <Row key={job.id} job={job} agent={agent} names={names} meId={meId} />
          ))}
        </Group>
      )}
      {earlier.length > 0 && (
        <Group label={running.length ? "Earlier" : undefined} testId="agent-jobs-earlier">
          {earlier.map((job) => (
            <Row key={job.id} job={job} agent={agent} names={names} meId={meId} />
          ))}
        </Group>
      )}
    </div>
  )
}

/** One line: the state glyph, what happened, then the quiet facts hard right. */
function Row({
  job,
  agent,
  names,
  meId,
  scheduled = false,
}: {
  job: Job
  agent: AgentDetail
  names: Map<string, string>
  meId: string
  scheduled?: boolean
}) {
  const needs = job.status === "needs_you"
  const failed = job.status === "failed" || job.status === "lost"
  const quiet = job.status === "cancelled"
  const live = OPEN.has(job.status) ? detailOf(job, agent, names, meId) : undefined
  const title = scheduled ? runTitle(job) : jobSubject(job)
  const outcome = scheduled
    ? needs
      ? job.needs?.question
      : job.status === "cancelled" && job.result.superseded_by
        ? "Superseded by a later run"
        : live
    : (live ?? jobOutcome(job))
  // The asker is said only when it is someone else: a page where every task is yours says
  // nothing about who asked.
  const asker =
    !scheduled && job.kind !== "scheduled" && job.asked_by && job.asked_by !== meId
      ? firstName(names.get(job.asked_by))
      : null
  const spend = scheduled ? jobSpend(job) : null
  // A task asked for in Slack or by a GitHub event says so: nothing else on the row explains
  // a task nobody typed here. (The generated type widens a nullable union to unknown.)
  const from = (job.origin as { kind?: string } | null)?.kind
  const origin = from === "slack" ? "From Slack" : from === "github" ? "From GitHub" : null
  return (
    <Link
      to="/tasks/$id"
      params={{ id: job.id }}
      data-testid={`job-open-${job.id}`}
      data-status={job.status}
      className="flex min-h-12 items-center gap-3.5 border-b border-border-soft py-2.5 text-base last:border-b-0 hover:bg-secondary/40"
    >
      {scheduled && (
        <Time>
          <span className="w-11 shrink-0 text-sm text-muted-foreground">
            {clockOf(job.scheduled_for ?? job.created_at)}
          </span>
        </Time>
      )}
      <Icon
        name={JOB_ICON[job.status]}
        size={16}
        strokeWidth={1.75}
        className={cn(
          "shrink-0 text-muted-foreground",
          job.status === "succeeded" && "text-success",
          needs && "text-warning",
          failed && "text-destructive",
          job.status === "running" && "motion-safe:animate-spin",
        )}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2.5 overflow-hidden">
        <span
          className={cn(
            "shrink-0 truncate font-medium text-foreground",
            quiet && "font-normal text-muted-foreground",
          )}
          style={{ maxWidth: outcome ? "55%" : "100%" }}
        >
          {title}
        </span>
        {outcome && <span className="truncate text-sm text-muted-foreground">{outcome}</span>}
      </span>
      <Meta>
        {origin && (
          <span className="max-sm:hidden" data-testid={`job-origin-${job.id}`}>
            {origin}
          </span>
        )}
        {asker && <span className="max-sm:hidden">{asker}</span>}
        {job.started_at && job.status === "running" ? (
          <Time>{took(job.started_at)}</Time>
        ) : job.started_at && job.finished_at ? (
          <Time>{took(job.started_at, job.finished_at)}</Time>
        ) : null}
        {spend && <Time>{spend}</Time>}
        {!scheduled && <Time>{when(job.finished_at ?? job.created_at)}</Time>}
      </Meta>
    </Link>
  )
}

/** A quiet line under a list: "Older tasks". */
export const MoreLine = ({ children }: { children: ReactNode }) => (
  <span className="text-sm text-muted-foreground">{children}</span>
)
