import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useMemo, useState } from "react"
import type { Agent } from "@/api"
import type { IconName } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import { agentsQuery, openJobsQuery, recentJobsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import {
  cronLabel,
  firstLine,
  groupAgents,
  machineOf,
  rosterOf,
  schedulesOf,
  took,
  when,
} from "./format"
import { Group, Machine, Meta, RowLine, rowClass, Time } from "./rows"
import { AgentRowsSkeleton } from "./skeleton"
import { useMemberNames } from "./use-member-names"

// Agents home: every agent in the workspace, grouped by what state it is in. What needs a
// person comes first, then what is working now, then what runs on its own, then the rest.
export function AgentsHome() {
  useDocumentTitle("Agents")
  const agents = useQuery(agentsQuery())
  const open = useQuery({ ...openJobsQuery(), refetchInterval: 15_000 })
  const recent = useQuery(recentJobsQuery())
  const names = useMemberNames()
  const roster = useMemo(() => rosterOf(agents.data ?? []), [agents.data])
  // The list carries each agent's schedules, so grouping needs no read per agent.
  const triggers = new Map(roster.map((a) => [a.id, a.triggers]))
  const [showNever, setShowNever] = useState(false)

  const header = (
    <PageHeader
      title="Agents"
      actions={
        <Button asChild size="sm" data-testid="agents-new">
          <Link to="/agents/new">New agent</Link>
        </Button>
      }
    />
  )

  if (agents.isError || open.isError)
    return (
      <PageShell width="wide" className="flex flex-col gap-9">
        {header}
        <LoadError
          title="Couldn’t load agents."
          testId="agents-retry"
          onRetry={() => {
            void agents.refetch()
            void open.refetch()
          }}
        />
      </PageShell>
    )
  if (agents.isPending || open.isPending)
    return (
      <PageShell width="wide" className="flex flex-col gap-9">
        {header}
        <AgentRowsSkeleton />
      </PageShell>
    )

  const { needs, groups, lastWorked, running } = groupAgents(
    roster,
    open.data,
    recent.data ?? [],
    (id) => triggers.get(id),
  )

  const agentRow = (a: Agent, right: ReactNode, icon: IconName = "job-succeeded") => (
    <Link
      key={a.id}
      to="/agents/$id"
      params={{ id: a.id }}
      search={{}}
      data-testid={`agent-row-${a.id}`}
      className={rowClass()}
    >
      <RowLine
        icon={a.paused ? "agent-paused" : icon}
        title={a.name}
        detail={a.description ?? undefined}
      />
      <Meta>
        {a.paused && <span>Paused</span>}
        {right}
      </Meta>
    </Link>
  )

  return (
    <PageShell width="wide" className="flex flex-col gap-9">
      {header}
      {recent.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load recent jobs, so when each agent last worked is missing."
          testId="agents-recent-retry"
          onRetry={() => void recent.refetch()}
        />
      )}
      {roster.length === 0 ? (
        <p data-testid="agents-empty" className="text-base text-muted-foreground">
          No agents in this workspace yet.
        </p>
      ) : (
        <>
          {needs.length > 0 && (
            <Group label="Needs you" testId="agents-group-needs">
              {needs.map(({ job, agent }) => (
                <Link
                  key={job.id}
                  to="/agents/$id"
                  params={{ id: agent.id }}
                  search={{}}
                  data-testid={`agents-needs-${job.id}`}
                  className={rowClass("warning")}
                >
                  <RowLine
                    icon="job-needs-you"
                    tone="warning"
                    title={agent.name}
                    detail={job.needs?.question ?? firstLine(job.instruction)}
                  />
                  <Meta>
                    <span className="font-medium text-warning">Look</span>
                    <Time>{when(job.updated_at)}</Time>
                  </Meta>
                </Link>
              ))}
            </Group>
          )}
          {groups.running.length > 0 && (
            <Group label="Running" testId="agents-group-running">
              {groups.running.map((a) => {
                const jobs = running.get(a.id) ?? []
                const now = jobs.find((j) => j.status === "running")
                const job = now ?? jobs[0]
                return (
                  <Link
                    key={a.id}
                    to="/agents/$id"
                    params={{ id: a.id }}
                    search={{}}
                    data-testid={`agent-row-${a.id}`}
                    className={rowClass()}
                  >
                    <RowLine
                      icon={now ? "job-running" : "job-queued"}
                      title={a.name}
                      detail={job ? firstLine(job.instruction) : undefined}
                    />
                    <Meta>
                      {jobs.length > 1 && <span>{jobs.length} jobs</span>}
                      <Machine mark={machineOf(a, names)} />
                      {now?.started_at ? <Time>{took(now.started_at)}</Time> : <span>Waiting</span>}
                    </Meta>
                  </Link>
                )
              })}
            </Group>
          )}
          {groups.scheduled.length > 0 && (
            <Group label="Scheduled" testId="agents-group-scheduled">
              {groups.scheduled.map((a) => {
                const [first, ...more] = schedulesOf(triggers.get(a.id))
                const last = lastWorked.get(a.id)
                return agentRow(
                  a,
                  <>
                    {first?.cron && (
                      <span>
                        {cronLabel(first.cron)}
                        {more.length > 0 && ` +${more.length}`}
                      </span>
                    )}
                    <Machine mark={machineOf(a, names)} />
                    {last && <Time>{when(last)}</Time>}
                  </>,
                  "agent-scheduled",
                )
              })}
            </Group>
          )}
          {(groups.asked.length > 0 || groups.never.length > 0) && (
            <Group label="When asked" testId="agents-group-asked">
              {groups.asked.map((a) => {
                const last = lastWorked.get(a.id) ?? a.seen_at
                return agentRow(
                  a,
                  <>
                    <Machine mark={machineOf(a, names)} />
                    {last && <Time>{when(last)}</Time>}
                  </>,
                )
              })}
              {showNever &&
                groups.never.map((a) =>
                  agentRow(a, <Machine mark={machineOf(a, names)} />, "job-cancelled"),
                )}
              {groups.never.length > 0 && !showNever && (
                <button
                  type="button"
                  data-testid="agents-show-never"
                  onClick={() => setShowNever(true)}
                  className="self-start pt-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  {groups.never.length} never used
                </button>
              )}
            </Group>
          )}
        </>
      )}
    </PageShell>
  )
}
