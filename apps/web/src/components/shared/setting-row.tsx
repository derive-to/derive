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
      {/* flex-1, NOT auto-width: the text column has to shrink and wrap its own
          sentences instead of pushing the control onto a second line. Without it,
          a long description silently moved the control below the text — so a row's
          switch sat left-aligned under its paragraph while every short-description
          row beside it kept its switch on the right.
          A described row also takes basis-64, so a narrow pane wraps it deliberately
          rather than squeezing prose to a ribbon. A bare label keeps flex-1's own
          0 basis: reserving 256px for two words is what pushes a wide control
          (an arbitrary-length select) onto its own line — the same bug, moved. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5",
          description !== undefined && "basis-64",
        )}
      >
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
