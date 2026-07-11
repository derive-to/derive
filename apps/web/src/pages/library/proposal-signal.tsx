import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { cn } from "@/lib/utils"

type Signals = Pick<Artifact, "open_proposals" | "my_role">

/** Inline review indicator: how many proposals are open on an artifact — its review
 *  queue, the thing that makes a Derive artifact a *living* document and not just a
 *  file. Reads quietly as a muted count (like views) until the proposals are YOURS to
 *  decide (owner/editor), when it takes the sanctioned "this needs you" ink — the same
 *  tint CommentSignal uses for an @mention, one notch below a direct tag. Renders
 *  nothing when there are no open proposals.
 *
 *  A count-only sibling to CommentSignal, sized to the 12px mono meta row; the `review`
 *  glyph (a pull-request mark) reads as "a change is waiting on a decision". */
export function ProposalSignal({
  artifact: a,
  size = 12,
  className,
}: {
  artifact: Signals
  size?: number
  className?: string
}) {
  const open = a.open_proposals ?? 0
  if (open === 0) return null
  // Owner/editor can approve or request changes → the queue is waiting on YOU; a
  // viewer/commenter just sees that a review is in flight (a muted count).
  const yours = a.my_role === "owner" || a.my_role === "editor"
  return (
    <span
      data-testid="proposal-signal"
      data-featured={yours ? "awaiting" : undefined}
      title={
        yours
          ? `${open} proposal${open === 1 ? "" : "s"} to review`
          : `${open} open proposal${open === 1 ? "" : "s"}`
      }
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        // The ink here IS the signal — "this review is waiting on you".
        yours ? "text-primary" : "text-muted-foreground",
        className,
      )}
    >
      <Icon name="review" size={size} />
      <span className="font-mono">{open}</span>
    </span>
  )
}
