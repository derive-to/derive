import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// A section title in the display register — heads a block of settings/controls with
// an optional trailing action. Display-weight, semibold (never bold). The louder
// counterpart to SectionEyebrow's mono smallcaps.
export function SectionTitle({
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
      <h3 className="text-balance text-sm font-semibold text-foreground">{children}</h3>
      {action}
    </div>
  )
}
