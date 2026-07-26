import { type ComponentProps, useEffect, useState } from "react"
import type { ProposalState } from "@/api"
import type { StatusPanel } from "@/components/shared/status-panel"
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
  badge: "default" | "secondary" | "destructive" | "outline" | "brand" | "success" | "warning"
  // tone = the StatusPanel tone for a decided proposal's decision-note banner
  // (rendered in body.tsx) — the panel owns the fill + announce grammar; none of
  // these states is "danger", so they all announce politely.
  tone: NonNullable<ComponentProps<typeof StatusPanel>["tone"]>
}

// Review states map onto the status hues: approved = success, changes requested
// = warning (a request, not a failure); open/withdrawn stay neutral.
export const STATE_META: Record<ProposalState, StateMeta> = {
  open: {
    label: "Open",
    badge: "secondary",
    tone: "neutral",
  },
  approved: {
    label: "Approved",
    badge: "success",
    tone: "success",
  },
  changes_requested: {
    label: "Changes requested",
    badge: "warning",
    tone: "warning",
  },
  withdrawn: {
    label: "Withdrawn",
    badge: "outline",
    tone: "neutral",
  },
}

export function StateBadge({ state }: { state: ProposalState }) {
  const m = STATE_META[state]
  return <Badge variant={m.badge}>{m.label}</Badge>
}
