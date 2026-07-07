import { Link } from "@tanstack/react-router"
import { Icon } from "@/components/icons"
import { ago } from "@/lib/time"
import type { CoalescedActivity } from "../activity/lib"
import { describeActivity } from "../activity/lib"

// The home's quiet link to the Activity feed — the TriageBar counterpart for "what
// happened" rather than "what needs you". Shows the single most recent story as a
// one-line teaser; disappears entirely when the workspace has no activity yet
// (never an empty "nothing happened" line — see TriageBar's same restraint).
export function ActivityBar({ latest }: { latest: CoalescedActivity }) {
  const { action } = describeActivity(latest)
  return (
    <Link
      to="/activity"
      data-testid="library-activity-bar"
      className="group flex items-center gap-2.5 rounded-lg bg-secondary px-3.5 py-2.5 text-sm ring-1 ring-transparent ring-inset outline-none hover:ring-input focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon name="activity" size={16} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">
        <span className="font-medium">{latest.actor}</span> {action}{" "}
        <span className="font-medium">{latest.artifact_title ?? latest.artifact_short_id}</span>
        <span className="text-muted-foreground"> · {ago(latest.created_at)}</span>
      </span>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground group-hover:text-foreground">
        View
      </span>
    </Link>
  )
}
