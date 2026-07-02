import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// A section title heading a block of controls (settings panels, the library
// sidebar groups). Small display-weight text with an optional trailing action.
// Callers add their own vertical margin via className.
export function SectionHeader({
  children,
  action,
  className,
}: {
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <h3 className="font-display text-sm font-semibold text-foreground">{children}</h3>
      {action}
    </div>
  )
}
