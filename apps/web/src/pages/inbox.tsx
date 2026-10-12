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
import { NeedsRow, useCanSteer } from "./agents/agent-jobs"
import { firstLine, when } from "./agents/format"
import { Group, Meta, RowLine, rowClass, Time } from "./agents/rows"
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
  const agents = useQuery(agentsQuery())
  // Shared with the rail, which keeps it warm for 30s; the inbox always reads it fresh.
  const activity = useQuery({ ...workspaceActivityQuery(), refetchOnMount: "always" })
  const byId = new Map((agents.data ?? []).map((a) => [a.id, a]))
  const names = useMemberNames()

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
              <InboxNeedsRow
                key={job.id}
                job={job}
                agent={byId.get(job.agent_id)}
                names={names}
                defaultOpen={jobs.data.length === 1}
              />
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

function InboxNeedsRow({
  job,
  agent,
  names,
  defaultOpen,
}: {
  job: Job
  agent: Agent | undefined
  names: Map<string, string>
  defaultOpen: boolean
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
        defaultOpen={defaultOpen}
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
