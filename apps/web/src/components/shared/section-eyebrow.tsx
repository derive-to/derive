import type { ReactNode } from "react"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

// A list-section heading in the mono eyebrow register: smallcaps label, an optional
// leading icon and tabular count, a hairline rule that runs to the edge, and an
// optional right-aligned action. The one compliant place uppercase is used (mono +
// wide tracking). Pairs with SectionTitle, which is the louder display register.
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
      <Tag className="flex shrink-0 items-center gap-1.5 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{children}</span>
        {count !== undefined && (
          <span className="tabular-nums normal-case tracking-normal text-muted-foreground/80">
            · {count}
            <span className="sr-only"> items</span>
          </span>
        )}
      </Tag>
      <Separator className="flex-1" />
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
