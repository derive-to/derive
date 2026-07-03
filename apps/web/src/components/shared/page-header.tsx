import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Eyebrow } from "./section-eyebrow"

// The one page-level header, shared across every screen so page titles stop
// diverging: People and Settings used a heavier `text-2xl font-semibold` sans
// while Library/Profile/Welcome used the house "voice" (Inter via the `font-serif`
// alias + `font-medium`). This is that voice, once. Heading-group grammar: an
// optional mono eyebrow, the title, an optional muted subtitle, and an optional
// right-aligned action cluster that drops below the title on narrow widths.
//
// Pure header band — the page owns whatever comes next (a search field, tabs, the
// results). Compose it as the first child of PageShell.
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  titleTestId,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  eyebrow?: ReactNode
  /** Right-aligned actions (buttons, a toggle); wrap below the title under `sm`. */
  actions?: ReactNode
  titleTestId?: string
  className?: string
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1
          data-testid={titleTestId}
          className="font-serif text-2xl font-medium tracking-tight text-balance text-foreground"
        >
          {title}
        </h1>
        {subtitle && <p className="text-sm text-pretty text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>
      )}
    </header>
  )
}
