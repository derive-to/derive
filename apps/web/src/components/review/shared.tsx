import { useEffect, useState } from "react"
import type { ProposalState } from "@/api"
import { Badge } from "@/components/ui/badge"

// Re-exported so the review modules keep their local import while there's one
// implementation (see lib/time).
export { ago } from "@/lib/time"

/** True while the viewport is phone-width; the rail collapses to a dropdown. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" ? window.matchMedia("(max-width: 820px)").matches : false,
  )
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)")
    const on = () => setNarrow(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return narrow
}

type StateMeta = {
  label: string
  badge: "default" | "secondary" | "destructive" | "outline"
  badgeCls?: string
  // banner = the tinted strip shown for a decided proposal's decision note.
  banner: string
  text: string
}

export const STATE_META: Record<ProposalState, StateMeta> = {
  open: {
    label: "Open",
    badge: "secondary",
    banner: "bg-accent/10",
    text: "text-accent-foreground",
  },
  approved: {
    label: "Approved",
    badge: "outline",
    badgeCls: "border-transparent bg-muted text-muted-foreground",
    banner: "bg-secondary",
    text: "text-muted-foreground",
  },
  changes_requested: {
    label: "Changes requested",
    badge: "outline",
    badgeCls: "border-destructive text-destructive",
    banner: "bg-destructive/10",
    text: "text-destructive",
  },
  withdrawn: {
    label: "Withdrawn",
    badge: "default",
    banner: "bg-secondary",
    text: "text-muted-foreground",
  },
}

export function StateBadge({ state }: { state: ProposalState }) {
  const m = STATE_META[state]
  return (
    <Badge variant={m.badge} className={m.badgeCls}>
      {m.label}
    </Badge>
  )
}
