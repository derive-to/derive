import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Dashed-border placeholder for an empty list/grid. Generic on purpose so every
// surface (library, collections, members, comments) shares one look. Pass a
// structured icon/title/description/action for a richer empty state, or children
// for a plain one-line message — both are supported.
export function EmptyState({
  children,
  icon,
  title,
  description,
  action,
  className,
}: {
  children?: ReactNode
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const structured = !!(icon || title || description || action)
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground",
        structured && "flex flex-col items-center gap-2",
        className,
      )}
    >
      {icon && (
        <span className="text-muted-foreground [&_svg:not([class*='size-'])]:size-8">{icon}</span>
      )}
      {title && <p className="text-base font-medium text-foreground">{title}</p>}
      {description && <p className="max-w-sm text-pretty text-muted-foreground">{description}</p>}
      {children}
      {action && <div>{action}</div>}
    </div>
  )
}
