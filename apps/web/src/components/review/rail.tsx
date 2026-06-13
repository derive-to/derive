import type { Proposal } from "@/api"
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
      onClick={() => onSelect(p.id)}
      className={cn(
        "block w-full border-l-[3px] px-3 py-2.5 text-left transition-colors",
        active ? "border-l-primary bg-accent/10" : "border-l-transparent hover:bg-hover",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <StateBadge state={p.state} />
        <span className="ml-auto text-2xs text-muted-foreground">{ago(p.created_at)}</span>
      </div>
      <div className="truncate text-xs font-semibold text-foreground">
        {p.message ?? "Proposed change"}
      </div>
      <div className="truncate text-2xs text-muted-foreground">{p.author}</div>
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
    <div className="px-3 pb-1 pt-2.5 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  )
  return (
    <div className="w-[232px] flex-none overflow-y-auto border-r border-border bg-card">
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
