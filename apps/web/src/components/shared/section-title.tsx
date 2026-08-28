import type { ReactNode } from "react"
import { Count } from "@/components/shared/section-eyebrow"
import { cn } from "@/lib/utils"

// The page-level section heading in the chrome register (Geist, medium — never
// bold): one step below PageHeader, one above SectionTitle. It carries the
// machine-register count and an optional trailing action, and draws NO rule —
// at page width a section separates from the next by whitespace and by being
// the second-largest type on the page. Lines are for structure (a container's
// edge, a table's column row) and for positions (the unread marker), never for
// groups, and no label ever carries one.
export function SectionHeading({
  children,
  count,
  action,
  as: Tag = "h2",
  className,
}: {
  children: ReactNode
  count?: number
  action?: ReactNode
  as?: "h2" | "h3"
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <Tag className="flex min-w-0 items-baseline gap-2 text-balance text-base font-medium text-foreground">
        <span>{children}</span>
        {count !== undefined && (
          <Count className="shrink-0">
            {count}
            <span className="sr-only"> items</span>
          </Count>
        )}
      </Tag>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// A section title in the chrome register (Geist, medium — never bold) — heads a
// block inside a bounded container: a settings group, a dialog section, a panel
// or console column, a card. Same anatomy as SectionHeading one step down
// (`text-sm`): the machine-register count, an optional trailing action, and no
// rule — inside a panel the container's own edges are the only lines.
export function SectionTitle({
  children,
  count,
  action,
  as: Tag = "h3",
  className,
}: {
  children: ReactNode
  count?: number
  action?: ReactNode
  as?: "h2" | "h3" | "h4"
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <Tag className="flex min-w-0 items-baseline gap-2 text-balance text-sm font-medium text-foreground">
        <span>{children}</span>
        {count !== undefined && (
          <Count className="shrink-0">
            {count}
            <span className="sr-only"> items</span>
          </Count>
        )}
      </Tag>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
