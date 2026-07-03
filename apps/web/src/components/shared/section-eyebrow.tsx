import type { ReactNode } from "react"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

// The mono smallcaps micro-label register — the ONE compliant place uppercase is
// used (always with tracking-wide). Medium weight so 10px caps stay legible while
// muted keeps it quiet; this also matches the stock menu/select/command group
// labels, so the register reads identically everywhere. SectionEyebrow re-inks it
// for section-header presence; use Eyebrow directly where the rule doesn't fit
// (card step labels, popover section headers, inline dividers).
export function Eyebrow({
  as: Tag = "span",
  className,
  children,
}: {
  as?: "span" | "div" | "h2" | "h3" | "h4"
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

// A list-section heading in the mono eyebrow register: smallcaps label, an optional
// leading icon and tabular count, a hairline rule that runs to the edge, and an
// optional right-aligned action. Re-inks the Eyebrow to `text-foreground` — a
// section header should be seen — while the count stays muted (label ink, count
// quiet). The one compliant place uppercase is used (mono + wide tracking).
export function SectionEyebrow({
  children,
  count,
  action,
  icon,
  as: Tag = "h2",
  className,
}: {
  children: ReactNode
  count?: number
  action?: ReactNode
  icon?: ReactNode
  as?: "h2" | "h3"
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Eyebrow as={Tag} className="flex shrink-0 items-center gap-1.5 text-foreground">
        {icon}
        <span>{children}</span>
        {count !== undefined && (
          <span className="tabular-nums normal-case tracking-normal text-muted-foreground/80">
            {/* The dot is visual punctuation — don't let SRs announce "middle dot". */}
            <span aria-hidden>· </span>
            {count}
            <span className="sr-only"> items</span>
          </span>
        )}
      </Eyebrow>
      <Separator className="flex-1" />
      {action && <div className="shrink-0">{action}</div>}
    </div>
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
// number. SectionEyebrow bakes this same treatment into its own count; use Count
// for standalone label + count rows that aren't a full SectionEyebrow.
export function Count({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-2xs tabular-nums text-muted-foreground", className)}>
      <span aria-hidden>· </span>
      {children}
    </span>
  )
}
