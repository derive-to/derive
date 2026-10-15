import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type Agent, api, type Job, type WorkspaceActivity } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { useAuth } from "@/ctx"
import { agentsQuery, inboxJobsQuery, workspaceActivityQuery } from "@/lib/queries"
import { stuckRowCount, stuckRows } from "@/lib/stuck-jobs"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useJobEvents } from "@/lib/use-job-events"
import { NeedsRow, useCanSteer } from "./agents/agent-jobs"
import { firstLine, machineName, when } from "./agents/format"
import { Group, Meta, RowLine, rowClass, Time, Verb } from "./agents/rows"
import { AgentRowsSkeleton } from "./agents/skeleton"
import { useMemberNames } from "./agents/use-member-names"

// Inbox: what needs you, answered in place, then what agents published in the workspace
// today. "Needs you" is every waiting job you asked or whose agent you manage; the answer
// goes through the same POST /v1/jobs/{id}/answer as the agent page.
export function Inbox() {
  useDocumentTitle("Inbox")
  // Job events keep this live; the slow poll is the fallback for what no event reaches.
  useJobEvents()
  const jobs = useQuery({ ...inboxJobsQuery(), refetchInterval: 60_000 })
  // Read fresh: a stuck task is judged by its agent's machine, and a restored roster can be
  // minutes old.
  const agents = useQuery({ ...agentsQuery(), staleTime: 0 })
  // Shared with the rail, which keeps it warm for 30s; the inbox always reads it fresh.
  const activity = useQuery({ ...workspaceActivityQuery(), refetchOnMount: "always" })
  const byId = new Map((agents.data ?? []).map((a) => [a.id, a]))
  const names = useMemberNames()
  const { me } = useAuth()
  const needs = (jobs.data ?? []).filter((j) => j.status === "needs_you")
  // Queued tasks on a machine that is down, in the rows lib/stuck-jobs gives the rail too:
  // your own machine is one row with the way to start it; a task on someone else's machine
  // that you asked or manage is a row with Cancel.
  const stuck = stuckRows(jobs.data ?? [], agents.data ?? [], me?.id)
  const waiting = needs.length + stuckRowCount(stuck)
  const loaded = !!jobs.data && !!agents.data

  return (
    <PageShell width="wide" className="flex flex-col gap-9">
      <PageHeader title="Inbox" />
      {jobs.isError ? (
        <LoadError
          title="Couldn’t load what needs you."
          testId="inbox-retry"
          onRetry={() => void jobs.refetch()}
        />
      ) : jobs.isPending ? (
        <AgentRowsSkeleton rows={2} />
      ) : (
        waiting > 0 && (
          <Group label="Needs you" testId="inbox-needs">
            {needs.map((job) => (
              <InboxNeedsRow key={job.id} job={job} agent={byId.get(job.agent_id)} names={names} />
            ))}
            {[...stuck.mine].map(([owner, rows]) => (
              <StuckOnMyMachine key={owner} owner={owner} rows={rows} />
            ))}
            {stuck.others.map(({ job, agent }) => (
              <StuckElsewhere key={job.id} job={job} agent={agent} names={names} meId={me?.id} />
            ))}
          </Group>
        )
      )}
      {agents.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load agents, so tasks waiting on a machine are not shown."
          testId="inbox-agents-retry"
          onRetry={() => void agents.refetch()}
        />
      )}
      {activity.isError ? (
        <LoadError
          layout="inline"
          title="Couldn’t load today’s pages."
          testId="inbox-today-retry"
          onRetry={() => void activity.refetch()}
        />
      ) : (
        activity.data && <Today activity={activity.data} />
      )}
      {loaded && waiting === 0 && activity.data && todayOf(activity.data).length === 0 && (
        <p data-testid="inbox-empty" className="text-base text-muted-foreground">
          Nothing needs you, and no agent has published anything today.
        </p>
      )}
    </PageShell>
  )
}

function InboxNeedsRow({
  job,
  agent,
  names,
}: {
  job: Job
  agent: Agent | undefined
  names: Map<string, string>
}) {
  const { me } = useAuth()
  const canSteer = useCanSteer(job, me?.id)
  const subject =
    job.subject && typeof job.subject === "object" && "kind" in job.subject
      ? (job.subject as { kind: string; id?: string })
      : null
  const reviewPage =
    job.needs?.kind === "review" && subject?.kind === "artifact" ? subject.id : null
  return (
    <div data-testid={`inbox-job-${job.id}`} data-status={job.status}>
      <NeedsRow
        job={job}
        // A review is answered on the page itself, not here.
        canSteer={canSteer && !reviewPage}
        agentName={agent?.name ?? "Agent"}
        names={names}
        title={
          <Link
            to="/agents/$id"
            params={{ id: job.agent_id }}
            search={{}}
            data-testid={`inbox-job-agent-${job.id}`}
            className="hover:underline"
          >
            {agent?.name ?? "Agent"}
          </Link>
        }
        below={
          reviewPage ? (
            <div className="pl-8 text-sm">
              <Link
                to="/artifacts/$ref"
                params={{ ref: reviewPage }}
                data-testid={`inbox-job-review-${job.id}`}
                className="font-medium text-warning hover:underline"
              >
                Review the page
              </Link>
            </div>
          ) : undefined
        }
      />
    </div>
  )
}

/** Tasks waiting for the viewer's own machine, which is down. One row per machine. */
function StuckOnMyMachine({
  owner,
  rows,
}: {
  owner: string
  rows: { agent: Agent; jobs: Job[] }[]
}) {
  const jobs = rows.flatMap((r) => r.jobs)
  const seen = rows.reduce<string | null>(
    (best, r) => (r.agent.seen_at && (!best || r.agent.seen_at > best) ? r.agent.seen_at : best),
    null,
  )
  const cancelAll = useApiMutation({
    // Every cancel is tried; the first failure is reported after the rest have settled.
    mutationFn: async () => {
      const results = await Promise.allSettled(jobs.map((j) => api.cancelJob(j.id)))
      const failed = results.find((r) => r.status === "rejected")
      if (failed) throw failed.reason
    },
    invalidate: [["jobs"]],
  })
  const oldest = jobs.map((j) => j.created_at).sort()[0]
  return (
    <div data-testid={`inbox-stuck-${owner}`} className={rowClass()}>
      <RowLine
        icon="job-queued"
        tone="warning"
        title={`${jobs.length === 1 ? "1 task is" : `${jobs.length} tasks are`} waiting for your machine. Its runner has ${seen ? `been off since ${when(seen)}` : "never connected"}.`}
        detail={rows.map((r) => `${r.agent.name}: ${r.jobs.length}`).join(" · ")}
      />
      <Meta>
        <Link
          to="/settings/$section"
          params={{ section: "machines" }}
          data-testid={`inbox-stuck-start-${owner}`}
          className="font-medium text-foreground hover:underline"
        >
          Start command
        </Link>
        <Verb
          testId={`inbox-stuck-cancel-${owner}`}
          disabled={cancelAll.isPending}
          onClick={() => cancelAll.mutate()}
        >
          Cancel all
        </Verb>
        {oldest && <Time>{when(oldest)}</Time>}
      </Meta>
    </div>
  )
}

/** A task on someone else's machine, which is down: one the viewer asked, or on an agent
 *  they manage. */
function StuckElsewhere({
  job,
  agent,
  names,
  meId,
}: {
  job: Job
  agent: Agent
  names: Map<string, string>
  meId: string | undefined
}) {
  const cancel = useApiMutation({
    mutationFn: () => api.cancelJob(job.id),
    invalidate: [["jobs"]],
  })
  const machine = machineName(agent.created_by, names, meId)
  const whose = job.asked_by === meId ? "your task" : "a task"
  return (
    <div data-testid={`inbox-stuck-job-${job.id}`} className={rowClass()}>
      <RowLine
        icon="job-queued"
        tone="warning"
        title={`${agent.name} has not started ${whose}. ${machine} has ${agent.seen_at ? `been off since ${when(agent.seen_at)}` : "never connected"}.`}
        detail={firstLine(job.instruction)}
      />
      <Meta>
        <Link
          to="/tasks/$id"
          params={{ id: job.id }}
          data-testid={`inbox-stuck-open-${job.id}`}
          className="text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          Open task
        </Link>
        <Verb
          testId={`inbox-stuck-cancel-${job.id}`}
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          Cancel
        </Verb>
        <Time>{when(job.created_at)}</Time>
      </Meta>
    </div>
  )
}

/** Today's versions an agent published, one row per page (its latest version today). */
const todayOf = (activity: WorkspaceActivity) => {
  const today = new Date().toDateString()
  const latest = new Map<string, WorkspaceActivity["versions"][number]>()
  for (const v of activity.versions) {
    if (!v.agent || new Date(v.created_at).toDateString() !== today) continue
    const prev = latest.get(v.artifact_id)
    if (!prev || v.created_at > prev.created_at) latest.set(v.artifact_id, v)
  }
  return [...latest.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

function Today({ activity }: { activity: WorkspaceActivity }) {
  const rows = todayOf(activity)
  const pages = new Map(activity.artifacts.map((a) => [a.id, a]))
  if (rows.length === 0) return null
  return (
    <Group label="Today" testId="inbox-today">
      {rows.map((v) => {
        const page = pages.get(v.artifact_id)
        if (!page) return null
        return (
          <Link
            key={v.artifact_id}
            to="/artifacts/$ref"
            params={{ ref: page.short_id }}
            data-testid={`inbox-page-${page.short_id}`}
            className={rowClass()}
          >
            <RowLine
              icon="page"
              title={page.title}
              detail={
                v.n === 1 ? "New page" : `v${v.n}${v.message ? ` · ${firstLine(v.message)}` : ""}`
              }
            />
            <Meta>
              <span>{v.agent?.name}</span>
              <Time>{when(v.created_at)}</Time>
            </Meta>
          </Link>
        )
      })}
    </Group>
  )
}
