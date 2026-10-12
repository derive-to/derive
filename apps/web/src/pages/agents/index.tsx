import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import type { ListedAgent } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/ctx"
import { agentsQuery, openJobsQuery, recentJobsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useJobEvents } from "@/lib/use-job-events"
import { JobRow } from "./agent-jobs"
import { cronLabel, firstLine, groupAgents, rosterOf, schedulesOf, when } from "./format"
import { Group, Meta, RowLine, rowClass, Time } from "./rows"
import { AgentRowsSkeleton } from "./skeleton"
import { TaskComposer } from "./task-composer"
import { TaskUsage } from "./task-usage"
import { useMemberNames } from "./use-member-names"

const route = getRouteApi("/agents/")

export function AgentsHome() {
  useDocumentTitle("Agents")
  const { tab } = route.useSearch()
  const navigate = route.useNavigate()
  const { me } = useAuth()
  const agents = useQuery({ ...agentsQuery(), refetchInterval: 30_000 })
  useJobEvents()
  const open = useQuery({ ...openJobsQuery(), refetchInterval: 10_000 })
  const recent = useQuery({ ...recentJobsQuery(), refetchInterval: 10_000 })
  const names = useMemberNames()
  const roster = rosterOf(agents.data ?? [])
  const [filter, setFilter] = useState("all")
  const [search, setSearch] = useState("")
  const header = (
    <PageHeader
      title="Agents"
      subtitle="Give it the work. Keep the results here."
      actions={
        <Button asChild variant="outline" size="sm" data-testid="agents-new">
          <Link to="/agents/new">New agent</Link>
        </Button>
      }
    />
  )
  if (agents.isError || open.isError)
    return (
      <PageShell width="wide" className="flex flex-col gap-7">
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
      <PageShell width="wide" className="flex flex-col gap-7">
        {header}
        <AgentRowsSkeleton />
      </PageShell>
    )
  const { needs, running, lastWorked } = groupAgents(
    roster,
    open.data,
    recent.data ?? [],
    (id) => roster.find((a) => a.id === id)?.triggers,
  )
  const allJobs = [
    ...new Map([...(recent.data ?? []), ...open.data].map((job) => [job.id, job])).values(),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const jobs = allJobs.filter((job) => roster.some((a) => a.id === job.agent_id))
  const filtered = jobs.filter(
    (job) =>
      (filter === "all" ||
        (filter === "attention"
          ? ["needs_you", "failed", "lost"].includes(job.status)
          : filter === "running"
            ? ["running", "queued"].includes(job.status)
            : job.status === "succeeded")) &&
      `${job.instruction} ${roster.find((a) => a.id === job.agent_id)?.name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  const agentRow = (agent: ListedAgent) => {
    const active = running.get(agent.id)?.[0]
    const schedule = schedulesOf(agent.triggers)[0]
    const last = lastWorked.get(agent.id)
    return (
      <Link
        key={agent.id}
        to="/agents/$id"
        params={{ id: agent.id }}
        search={{}}
        data-testid={`agent-row-${agent.id}`}
        className={rowClass()}
      >
        <RowLine
          icon={
            agent.paused
              ? "agent-paused"
              : active
                ? "job-running"
                : schedule
                  ? "agent-scheduled"
                  : "agent"
          }
          title={agent.name}
          detail={agent.description ?? "Ready when you are"}
        />
        <Meta>
          <span>
            {agent.paused
              ? "Paused"
              : active
                ? "Running"
                : schedule?.cron
                  ? cronLabel(schedule.cron)
                  : "When asked"}
          </span>
          {last && <Time>{when(last)}</Time>}
        </Meta>
      </Link>
    )
  }
  return (
    <PageShell width="wide" className="flex flex-col gap-7">
      {header}
      <Tabs
        value={tab ?? "agents"}
        onValueChange={(value) =>
          void navigate({ search: value === "tasks" || value === "usage" ? { tab: value } : {} })
        }
      >
        <TabsList variant="line" aria-label="Agent home views">
          <TabsTrigger value="agents" data-testid="agents-tab-agents">
            Your agents
          </TabsTrigger>
          <TabsTrigger value="tasks" data-testid="agents-tab-tasks">
            Tasks
          </TabsTrigger>
          <TabsTrigger value="usage" data-testid="agents-tab-usage">
            Usage
          </TabsTrigger>
        </TabsList>
        <TabsContent value="agents" className="flex flex-col gap-8 pt-5">
          <TaskComposer agents={roster} />
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
                    <span className="text-warning">Answer</span>
                    <Time>{when(job.updated_at)}</Time>
                  </Meta>
                </Link>
              ))}
            </Group>
          )}
          <Group label="Your agents" testId="agents-roster">
            {roster.length ? (
              roster.map(agentRow)
            ) : (
              <p data-testid="agents-empty" className="py-3 text-base text-muted-foreground">
                Your first agent starts with a skill. Tell it what you want to get done.
              </p>
            )}
          </Group>
        </TabsContent>
        <TabsContent value="tasks" className="flex flex-col gap-5 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <fieldset className="flex flex-wrap gap-1" aria-label="Filter tasks">
              {(
                [
                  ["all", "All tasks"],
                  ["running", "Running"],
                  ["attention", "Needs you"],
                  ["done", "Completed"],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  variant={filter === id ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={filter === id}
                  data-testid={`tasks-filter-${id}`}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            <Input
              aria-label="Find a task"
              data-testid="tasks-search"
              placeholder="Find a task"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-56"
            />
          </div>
          {recent.isError ? (
            <LoadError
              title="Couldn’t load recent tasks."
              testId="agents-recent-retry"
              onRetry={() => void recent.refetch()}
            />
          ) : recent.isPending ? (
            <AgentRowsSkeleton />
          ) : (
            <Group testId="agents-tasks">
              {filtered.length ? (
                filtered.map((job) => {
                  const agent = roster.find((a) => a.id === job.agent_id)
                  return agent ? (
                    <div key={job.id}>
                      <Link
                        to="/agents/$id"
                        params={{ id: agent.id }}
                        search={{}}
                        data-testid={`task-agent-${job.id}`}
                        className="text-sm text-muted-foreground hover:underline"
                      >
                        {agent.name}
                      </Link>
                      <JobRow
                        job={job}
                        agent={agent}
                        names={names}
                        canAsk={agent.can_ask}
                        canSchedule={agent.can_manage}
                        triggers={agent.triggers}
                        canSteer={
                          !!(agent.can_manage || (job.asked_by === me?.id && agent.can_ask))
                        }
                      />
                    </div>
                  ) : null
                })
              ) : (
                <p className="py-5 text-base text-muted-foreground">
                  {jobs.length
                    ? "No tasks match. Try another search or filter."
                    : "All quiet here. Start a task when you’re ready."}
                </p>
              )}
            </Group>
          )}
          <p className="text-sm text-muted-foreground">
            Recent tasks · Failed and stopped tasks keep their reports and usage.
          </p>
        </TabsContent>
        <TabsContent value="usage" className="pt-5">
          {recent.isError ? (
            <LoadError
              title="Couldn’t load usage."
              testId="usage-retry"
              onRetry={() => void recent.refetch()}
            />
          ) : (
            <TaskUsage jobs={recent.data ?? []} agents={roster} />
          )}
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
