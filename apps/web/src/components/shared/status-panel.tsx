import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// A status callout for a transient or degraded condition — a failed load, a state
// worth surfacing. Deliberately distinct from EmptyState's boxless "there's simply
// nothing here", so an error never reads as an empty library. Tone grammar:
// bg-<tone>/10 fill + ring-1 ring-inset ring-<tone>/25 edge — a tint, never a loud
// fill. Neutral stays a quiet well; success/warning/danger are the status hues;
// brand is for brand moments (sync, upgrade nudges) — amber is not a status.
type Tone = "neutral" | "brand" | "success" | "warning" | "danger"

const TONES: Record<Tone, { panel: string; title: string }> = {
  neutral: { panel: "bg-muted ring-border", title: "text-foreground" },
  brand: { panel: "bg-primary/10 ring-primary/25", title: "text-primary" },
  success: { panel: "bg-success/10 ring-success/25", title: "text-success" },
  warning: { panel: "bg-warning/10 ring-warning/25", title: "text-warning" },
  danger: { panel: "bg-destructive/10 ring-destructive/25", title: "text-destructive" },
}

export function StatusPanel({
  tone = "neutral",
  title,
  description,
  action,
  className,
}: {
  tone?: Tone
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl p-8 text-center ring-1 ring-inset",
        TONES[tone].panel,
        className,
      )}
    >
      <div className="flex flex-col items-center gap-2">
        <p className={cn("font-medium", TONES[tone].title)}>{title}</p>
        {description && <p className="max-w-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}
