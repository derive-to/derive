import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { JobStatus } from "@/api"
import { Icon } from "@/components/icons"
import { agentsQuery, reportJobQuery } from "@/lib/queries"
import { useJobEvents } from "@/lib/use-job-events"
import { cn } from "@/lib/utils"
import { firstName, JOB_ICON, took, when } from "@/pages/agents/format"
import { useMemberNames } from "@/pages/agents/use-member-names"

const STATUS_WORD: Record<JobStatus, string> = {
  queued: "Waiting",
  running: "Running",
  needs_you: "Needs you",
  succeeded: "Done",
  failed: "Failed",
  lost: "Lost",
  cancelled: "Cancelled",
}

// A report page's job, in one quiet line above the document: which agent, where the job is,
// who asked, when, and how long it took. Every other page reads nothing here. A failed read
// hides the line; the page underneath is the same page either way.
export function JobHeader({ shortId }: { shortId: string }) {
  // A follow-up from the margin reopens the job: its events keep this line current.
  useJobEvents()
  const job = useQuery(reportJobQuery(shortId))
  const agents = useQuery(agentsQuery())
  const names = useMemberNames()
  if (job.isError || !job.data) return null
  const j = job.data
  const agent = agents.data?.find((a) => a.id === j.agent_id)
  const asker = j.asked_by ? firstName(names.get(j.asked_by)) : null
  return (
    <div
      data-testid="job-header"
      data-status={j.status}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-sm text-muted-foreground"
    >
      <span className="flex items-center gap-1.5">
        <Icon
          name={JOB_ICON[j.status]}
          className={cn(
            j.status === "needs_you" && "text-warning",
            (j.status === "failed" || j.status === "lost") && "text-destructive",
          )}
        />
        <span className="text-foreground">{STATUS_WORD[j.status]}</span>
      </span>
      <Link
        to="/agents/$id"
        params={{ id: j.agent_id }}
        search={{}}
        data-testid="job-header-agent"
        className="font-medium text-foreground hover:underline"
      >
        {agent?.name ?? "Agent"}
      </Link>
      {j.kind === "scheduled" ? <span>On schedule</span> : asker && <span>Asked by {asker}</span>}
      <span className="font-mono">{when(j.created_at)}</span>
      {j.started_at && j.finished_at && (
        <span className="font-mono">{took(j.started_at, j.finished_at)}</span>
      )}
    </div>
  )
}
