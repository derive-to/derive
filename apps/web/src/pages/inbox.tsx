import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { Agent, Job, WorkspaceActivity } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { useAuth } from "@/ctx"
import { agentsQuery, inboxJobsQuery, workspaceActivityQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useJobEvents } from "@/lib/use-job-events"
import { AnswerBox, useCanSteer } from "./agents/agent-jobs"
import { firstLine, when } from "./agents/format"
import { Group, Meta, RowLine, rowClass, Time } from "./agents/rows"
import { AgentRowsSkeleton } from "./agents/skeleton"

// Inbox (mock izfsuofr): what needs you, answered in place, then what agents published in
// the workspace today. "Needs you" is every needs_you job you asked or whose agent you
// manage; the answer goes through the same POST /v1/jobs/{id}/answer as the agent page.
export function Inbox() {
  useDocumentTitle("Inbox")
  // Job events keep this live; the slow poll is the fallback for what no event reaches.
  useJobEvents()
  const jobs = useQuery({ ...inboxJobsQuery(), refetchInterval: 60_000 })
  const agents = useQuery(agentsQuery())
  // Shared with the rail, which keeps it warm for 30s; the inbox always reads it fresh.
  const activity = useQuery({ ...workspaceActivityQuery(), refetchOnMount: "always" })
  const names = new Map((agents.data ?? []).map((a) => [a.id, a]))

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
        jobs.data.length > 0 && (
          <Group label="Needs you" testId="inbox-needs">
            {jobs.data.map((job) => (
              <NeedsRow key={job.id} job={job} agent={names.get(job.agent_id)} />
            ))}
          </Group>
        )
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
      {jobs.data?.length === 0 && activity.data && todayOf(activity.data).length === 0 && (
        <p data-testid="inbox-empty" className="text-base text-muted-foreground">
          Nothing needs you, and no agent has published anything today.
        </p>
      )}
    </PageShell>
  )
}

function NeedsRow({ job, agent }: { job: Job; agent: Agent | undefined }) {
  const { me } = useAuth()
  const canSteer = useCanSteer(job, me?.id)
  const subject =
    job.subject && typeof job.subject === "object" && "kind" in job.subject
      ? (job.subject as { kind: string; id?: string })
      : null
  const reviewPage =
    job.needs?.kind === "review" && subject?.kind === "artifact" ? subject.id : null
  return (
    <div
      data-testid={`inbox-job-${job.id}`}
      data-status={job.status}
      className="-mx-3 my-0.5 rounded-lg bg-warning/10 px-3"
    >
      <div className="flex h-13 items-center gap-3.5 text-base">
        <Link
          to="/agents/$id"
          params={{ id: job.agent_id }}
          search={{}}
          data-testid={`inbox-job-agent-${job.id}`}
          className="flex h-full min-w-0 flex-1 items-center gap-3.5"
        >
          <RowLine
            icon="job-needs-you"
            tone="warning"
            title={agent?.name ?? "Agent"}
            detail={job.needs?.question ?? firstLine(job.instruction)}
          />
        </Link>
        <Meta>
          {job.report_short_id && (
            <Link
              to="/artifacts/$ref"
              params={{ ref: job.report_short_id }}
              data-testid={`inbox-job-report-${job.id}`}
              className="font-medium text-foreground hover:underline"
            >
              Report
            </Link>
          )}
          <Time>{when(job.updated_at)}</Time>
        </Meta>
      </div>
      {reviewPage ? (
        <div className="pb-3 pl-8 text-sm">
          <Link
            to="/artifacts/$ref"
            params={{ ref: reviewPage }}
            data-testid={`inbox-job-review-${job.id}`}
            className="font-medium text-warning hover:underline"
          >
            Review the page
          </Link>
        </div>
      ) : (
        canSteer && <AnswerBox job={job} />
      )}
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
                v.n === 1 ? "new page" : `v${v.n}${v.message ? ` · ${firstLine(v.message)}` : ""}`
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
