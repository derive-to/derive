import type { ReactNode } from "react"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

// The mono smallcaps micro-label register — the ONE compliant place uppercase is
// used (always with tracking-wide). Medium weight so 10px caps stay legible while
// muted keeps it quiet; this also matches the stock menu/select/command group
// labels, so the register reads identically everywhere. It is the lowest heading
// level: sub-groups, day labels, column headers, card step labels, popover section
// labels — always bare, never with a rule (headings are SectionHeading /
// SectionTitle in section-title.tsx).
export function Eyebrow({
  as: Tag = "span",
  className,
  children,
}: {
  as?: "span" | "div" | "p" | "h2" | "h3" | "h4" | "th" | "dt" | "footer"
  className?: string
  children: ReactNode
}) {
  return (
    <Tag
      className={cn(
        "font-mono text-2xs font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </Tag>
  )
}

// A label centered between two hairline rules — the two-sided divider (the login
// "or", a mid-page section break). Owns only the flanking-rule layout; pass the
// label in whatever register fits (a mono `Eyebrow`, a voice heading), so both
// stop hand-rolling `<Separator className="flex-1" />` on either side.
export function LabeledDivider({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Separator className="flex-1" />
      {children}
      <Separator className="flex-1" />
    </div>
  )
}

// The machine-register count that rides beside a label ("Members · 12") — mono,
// tabular, muted, led by an aria-hidden middle dot so screen readers read just the
// number. SectionHeading and SectionTitle bake this same treatment into their
// counts; use Count for standalone label + count rows.
export function Count({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-2xs tabular-nums text-muted-foreground", className)}>
      <span aria-hidden>· </span>
      {children}
    </span>
  )
}
