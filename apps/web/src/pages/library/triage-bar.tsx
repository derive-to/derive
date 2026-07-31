import { Link } from "@tanstack/react-router"
import { Icon } from "@/components/icons"

// The home's ONE quiet triage entry — a single clickable well that replaces the old
// stacked "needs your feedback" card-strip. It links to the /feedback feed, so the home
// stays "your work," one job (the whole IA move). Shown only when something actually
// needs you. Its count is prefetched (not awaited) by the home loader; while it resolves,
// the library reserves this bar's height (h-10 — keep that slot in step with the py-2.5
// + text-sm geometry here) so the common case swaps in with zero shift. A well, not
// cards (the surfaces ladder: an interactive well before a card).
export function TriageBar({ count }: { count: number }) {
  return (
    <Link
      to="/feedback"
      data-testid="library-triage"
      className="group flex items-center gap-2.5 rounded-lg bg-secondary px-3.5 py-2.5 text-sm ring-1 ring-transparent ring-inset outline-none hover:ring-input focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Icon name="comments" size={16} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">
        <span className="font-medium tabular-nums">{count}</span>{" "}
        {count === 1 ? "artifact needs" : "artifacts need"} your feedback
      </span>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground group-hover:text-foreground">
        View
      </span>
    </Link>
  )
}
