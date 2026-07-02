import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// A status callout for a transient or degraded condition — a failed load, a state
// worth surfacing. Deliberately distinct from EmptyState's "there's simply nothing
// here" dashed box, so an error never reads as an empty library. Neutral by default;
// tone="danger" reaches for the preset's one live signal hue (soft-destructive) so a
// genuine failure actually reads as one.
export function StatusPanel({
  tone = "neutral",
  title,
  description,
  action,
  className,
}: {
  tone?: "neutral" | "danger"
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border p-8 text-center",
        tone === "danger" ? "border-destructive/30 bg-destructive/10" : "border-border bg-muted",
        className,
      )}
    >
      <p className={cn("font-medium", tone === "danger" ? "text-destructive" : "text-foreground")}>
        {title}
      </p>
      {description && <p className="max-w-sm text-pretty text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
