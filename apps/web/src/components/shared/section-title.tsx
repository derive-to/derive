import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// A section title in the chrome register (Geist, medium — never bold) — heads a
// block of settings/controls with an optional trailing action. The louder
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
      <h3 className="text-balance text-sm font-medium text-foreground">{children}</h3>
      {action}
    </div>
  )
}
