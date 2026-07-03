import type { ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

// The one settings row: a label (and an only-if-helpful description) on the left,
// its control on the right — the inline master-detail grammar every section shares
// instead of each hand-rolling a label+control flex (Integrations' local Toggle,
// Profile's bare checkbox row, …). Rows are meant to stack inside a hairline-
// divided SettingsGroup on the page surface, never one card each (the surfaces
// rule: whitespace → dividers → wells → cards, in that order).
//
// For a labelable control, pass `htmlFor` matching its id so the whole label
// targets it (Radix Switch/Select render a labelable button); otherwise the label
// renders as plain text. Stacked text inputs use FormField, not this.
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  /** id of the row's control — associates the label and widens its hit target. */
  htmlFor?: string
  /** The control(s) on the right. */
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-foreground">
            {label}
          </Label>
        ) : (
          <div className="text-sm font-medium text-foreground">{label}</div>
        )}
        {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}
