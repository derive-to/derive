import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, type ListedAgent } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/ctx"
import { agentsQuery, openJobsQuery, recentJobsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useJobEvents } from "@/lib/use-job-events"
import { JobRow } from "./agent-jobs"
import {
  cronLabel,
  firstLine,
  groupAgents,
  type MachineGroup,
  machineDown,
  machineName,
  machineState,
  rosterOf,
  schedulesOf,
  when,
} from "./format"
import { Group, Meta, RowLine, rowClass, Segmented, Time, Verb } from "./rows"
import { AgentRowsSkeleton } from "./skeleton"
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
  // Whose work the Tasks view shows: yours, what schedules started, or the whole team's.
  const [scope, setScope] = useState("mine")
  const [search, setSearch] = useState("")
  const header = (
    <PageHeader
      title="Agents"
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
  const grouped = groupAgents(roster, open.data, recent.data ?? [], me?.id)
  const { needs, running, waiting, lastWorked } = grouped
  const allJobs = [
    ...new Map([...(recent.data ?? []), ...open.data].map((job) => [job.id, job])).values(),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const jobs = allJobs.filter((job) => roster.some((a) => a.id === job.agent_id))
  const filtered = jobs.filter(
    (job) =>
      (scope === "team" ||
        (scope === "scheduled" ? job.kind === "scheduled" : job.asked_by === me?.id)) &&
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
  // `groupOn`: the machine group's own state, so a row says its runner's state only when
  // that differs (each agent has its own runner process on the same machine).
  const agentRow = (agent: ListedAgent, groupOn?: boolean) => {
    const active = running.get(agent.id)?.[0]
    const own =
      agent.machine === "owner" && groupOn !== undefined ? machineState(agent.seen_at) : null
    const differs = own !== null && (own === "On") !== groupOn
    const queued = waiting.get(agent.id) ?? []
    const schedule = schedulesOf(agent.triggers)[0]
    const last = lastWorked.get(agent.id)
    const oldest = queued.map((j) => j.created_at).sort()[0]
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
                : queued.length
                  ? "job-queued"
                  : schedule
                    ? "agent-scheduled"
                    : "agent"
          }
          tone={queued.length && machineDown(agent) ? "warning" : undefined}
          title={agent.name}
          detail={
            active
              ? firstLine(active.instruction)
              : queued.length && oldest
                ? `${queued.length === 1 ? "1 task" : `${queued.length} tasks`} waiting since ${when(oldest)}`
                : (agent.description ?? undefined)
          }
        />
        <Meta>
          {agent.paused ? (
            <span>Paused</span>
          ) : active ? (
            <span>Running</span>
          ) : (
            schedule?.cron && <span>{cronLabel(schedule.cron)}</span>
          )}
          {differs && <span data-testid={`agent-runner-${agent.id}`}>{own}</span>}
          {last && <Time>{when(last)}</Time>}
        </Meta>
      </Link>
    )
  }
  const machineGroup = (m: MachineGroup<ListedAgent>) => {
    const state = machineState(m.seenAt)
    return (
      <Group
        key={m.owner ?? "nobody"}
        label={machineName(m.owner, names, me?.id)}
        aside={state}
        testId={`agents-group-machine-${m.owner ?? "nobody"}`}
      >
        {m.agents.map((agent) => agentRow(agent, state === "On"))}
      </Group>
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
            Agents
          </TabsTrigger>
          <TabsTrigger value="tasks" data-testid="agents-tab-tasks">
            Tasks
          </TabsTrigger>
          <TabsTrigger value="usage" data-testid="agents-tab-usage">
            Usage
          </TabsTrigger>
        </TabsList>
        <TabsContent value="agents" className="flex flex-col gap-8 pt-5">
          {needs.length > 0 && (
            <Group label="Needs you" testId="agents-group-needs">
              {needs.map(({ job, agent }) => (
                <Link
                  key={job.id}
                  to="/agents/$id"
                  params={{ id: agent.id }}
                  search={{}}
                  data-testid={`agents-needs-${job.id}`}
                  className={rowClass()}
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
          {grouped.derive.length > 0 && (
            <Group label="Derive" testId="agents-group-derive">
              {grouped.derive.map((agent) => agentRow(agent))}
            </Group>
          )}
          {grouped.machines.map(machineGroup)}
          {grouped.notSetUp.length > 0 && (
            <Group label="Not set up" testId="agents-group-not-set-up">
              {grouped.notSetUp.map((agent) => (
                <NotSetUpRow
                  key={agent.id}
                  agent={agent}
                  machine={machineName(agent.created_by, names, me?.id)}
                />
              ))}
            </Group>
          )}
          {roster.length === 0 && (
            <p data-testid="agents-empty" className="py-3 text-base text-muted-foreground">
              Your first agent starts with a skill. Tell it what you want to get done.
            </p>
          )}
        </TabsContent>
        <TabsContent value="tasks" className="flex flex-col gap-5 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              testId="tasks-scope"
              value={scope}
              onChange={setScope}
              options={[
                { value: "mine", label: "Mine" },
                { value: "scheduled", label: "Scheduled" },
                { value: "team", label: "Team" },
              ]}
            />
            <fieldset className="flex flex-wrap gap-1" aria-label="Filter tasks">
              {(
                [
                  ["all", "All tasks"],
                  ["running", "Open"],
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

/** An agent on a machine that has never connected. One with no skill and no tasks is a leftover
 *  anyone who manages it can remove from here. */
function NotSetUpRow({ agent, machine }: { agent: ListedAgent; machine: string }) {
  const [confirming, setConfirming] = useState(false)
  const remove = useApiMutation({
    mutationFn: () => api.deleteAgent(agent.id),
    invalidate: [["agents"], ["jobs"]],
  })
  const leftover = !agent.instructions_short_id && !agent.last_job_at
  return (
    <div data-testid={`agent-row-${agent.id}`} className={rowClass()}>
      <Link
        to="/agents/$id"
        params={{ id: agent.id }}
        search={{}}
        data-testid={`agent-open-${agent.id}`}
        className="flex min-w-0 flex-1 items-center gap-3.5"
      >
        <RowLine
          icon="agent"
          title={agent.name}
          detail={leftover ? "No skill. Never connected." : `${machine} has never connected.`}
        />
      </Link>
      <Meta>
        {leftover && agent.can_manage && (
          <Verb
            testId={`agent-remove-${agent.id}`}
            disabled={remove.isPending}
            onClick={() => setConfirming(true)}
          >
            Remove
          </Verb>
        )}
      </Meta>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${agent.name}?`}
        description="It has no skill and has never run. Nothing else refers to it."
        confirmLabel="Remove"
        confirmTestId={`agent-remove-confirm-${agent.id}`}
        onConfirm={() => remove.mutateAsync().then(() => undefined)}
      />
    </div>
  )
}
