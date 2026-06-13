import { useEffect, useState } from "react"
import type { ProposalState } from "@/api"
import { Badge, type BadgeProps } from "@/components/ui/badge"

export const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

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
  badge: BadgeProps["variant"]
  badgeCls?: string
  // banner = the tinted strip shown for a decided proposal's decision note.
  banner: string
  text: string
}

export const STATE_META: Record<ProposalState, StateMeta> = {
  open: { label: "Open", badge: "accent", banner: "bg-accent/10", text: "text-accent-foreground" },
  approved: {
    label: "Approved",
    badge: "success",
    banner: "bg-secondary",
    text: "text-success",
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
