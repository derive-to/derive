import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { SectionTitle } from "./section-title"

// A titled group of settings rows: an optional quiet SectionTitle (with an
// optional trailing action) over a hairline-divided stack, laid directly on the
// page surface — no card (cards are for units that lift or navigate; a group of
// rows is neither). The divider is `border-soft`, the quietest hairline; the
// first/last rows drop their outer padding so the group's own bounds sit flush
// and the surrounding gap owns the rhythm between groups.
//
// Compose SettingRow (and FormField for stacked text inputs) as children.
export function SettingsGroup({
  title,
  action,
  description,
  children,
  className,
}: {
  title?: ReactNode
  /** Right-aligned action beside the title (e.g. an "Add" button). */
  action?: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {(title || description) && (
        <div className="flex flex-col gap-1">
          {title && <SectionTitle action={action}>{title}</SectionTitle>}
          {description && (
            <p className="text-sm text-pretty text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      <div className="flex flex-col divide-y divide-border-soft [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {children}
      </div>
    </section>
  )
}
