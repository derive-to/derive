import type { Proposal } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { cn } from "@/lib/utils"
import { ago, StateBadge } from "./shared"

function RailItem({
  p,
  active,
  onSelect,
}: {
  p: Proposal
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-testid={`review-proposal-${p.id}`}
      // The wash is visual; aria-current announces the selected proposal.
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(p.id)}
      className={cn(
        // Active is the neutral wash + re-inked text — no ink edge tick (the
        // nav rail dropped it; the review rail follows the same grammar).
        "block w-full px-3 py-2.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        active ? "bg-accent" : "hover:bg-secondary",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <StateBadge state={p.state} />
        <span className="ml-auto font-mono text-2xs text-muted-foreground tabular-nums">
          {ago(p.created_at)}
        </span>
      </div>
      <div className="truncate text-sm font-medium text-foreground">
        {p.message ?? "Proposed change"}
      </div>
      <div className="truncate font-mono text-2xs text-muted-foreground">{p.author}</div>
    </button>
  )
}

// The desktop queue: open proposals first ("Awaiting review"), then decided.
export function ReviewRail({
  proposals,
  activeId,
  onSelect,
}: {
  proposals: Proposal[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const open = proposals.filter((p) => p.state === "open")
  const decided = proposals.filter((p) => p.state !== "open")
  const Heading = ({ children }: { children: React.ReactNode }) => (
    <Eyebrow as="div" className="px-3 pb-1 pt-2.5">
      {children}
    </Eyebrow>
  )
  return (
    <div className="w-58 flex-none overflow-y-auto border-r border-border bg-card">
      {open.length > 0 && <Heading>Awaiting review ({open.length})</Heading>}
      {open.map((p) => (
        <RailItem key={p.id} p={p} active={p.id === activeId} onSelect={onSelect} />
      ))}
      {decided.length > 0 && <Heading>Decided ({decided.length})</Heading>}
      {decided.map((p) => (
        <RailItem key={p.id} p={p} active={p.id === activeId} onSelect={onSelect} />
      ))}
    </div>
  )
}
